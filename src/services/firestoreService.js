Warning: truncated output (original token count: 50395)
Total output lines: 4238

import {
  addDoc,
  collection,
  collectionGroup,
  deleteField,
  doc,
  getDoc as firebaseGetDoc,
  getDocs as firebaseGetDocs,
  limit,
  onSnapshot as firebaseOnSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
} from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { addDays, formatISO } from 'date-fns';
import { db, functions, isFirebaseConfigured } from '../firebase/config';
import { collections, paths, subcollections } from '../firebase/schema';

export { paths, subcollections };
import { getGlobalTopicCatalogSeed, getHardcodedTopics, normalizeTopicKey as normalizeCatalogTopicKey } from '../data/topicCatalog';
import {
  getCurrentGenerationNumber,
  getEligibleExerciseTopics,
  getExerciseGenerationMode,
  getGenerationWeekForTrigger,
  getRegenerationState,
  hasExerciseGeneration,
  isExerciseSubmitted,
} from './exerciseGenerationPlan';
import { buildRuleBasedExercisePlan, createExerciseDateWindow, getExerciseGenerationDayCount } from './ruleBasedExerciseGenerator';
import { questionMatchesTopics } from './exerciseTopicMatching';
import {
  mockCompletedLessons,
  mockDashboardData,
  mockQuestionPapers,
  mockStudentAssignments,
  mockTutorReports,
  mockUsers,
  mockGuideQuizResults,
} from '../data/mockData';
import { DEFAULT_SUBJECT, MAX_EXERCISES_PER_DATE, MAX_QUESTIONS_PER_EXERCISE, WEEKLY_EXERCISE_DAYS } from '../lib/constants';
import { getApprovedTutorSubjects, getUserSubjects, mergeBestTutorSubjectMarks, normalizeEligibleSubject } from '../utils/tutorSubjects';
import { calculateSubscriptionQuote, getEffectiveSubscriptionState, isSubscriptionPaymentConsistent } from '../utils/subscriptionPlans';
import { normalizeWhatsAppLessonLink } from '../utils/whatsapp';
import { buildLessonTopicScores } from './lessonPersistence';
import { trackDataRequest, trackFirestoreListener, trackFirestoreRead } from './performanceTelemetry';
import { queryClient } from '../lib/queryClient';

const getDoc = (...args) => trackFirestoreRead('getDoc', () => firebaseGetDoc(...args));
const getDocs = (...args) => trackFirestoreRead('getDocs', () => firebaseGetDocs(...args));
const onSnapshot = (reference, ...args) => {
  const callbackIndex = args.findIndex((item) => typeof item === 'function' || typeof item?.next === 'function');
  if (callbackIndex === -1) return firebaseOnSnapshot(reference, ...args);
  const callback = args[callbackIndex];
  const startedAt = performance.now();
  const route = typeof window === 'undefined' ? '' : window.location.pathname;
  let recorded = false;
  const onNext = (snapshot) => {
    if (!recorded) {
      recorded = true;
      trackFirestoreListener(snapshot, performance.now() - startedAt, route);
    }
    return typeof callback === 'function' ? callback(snapshot) : callback.next(snapshot);
  };
  args[callbackIndex] = typeof callback === 'function' ? onNext : { ...callback, next: onNext };
  return firebaseOnSnapshot(reference, ...args);
};

const emptyDashboardData = {
  student: {
    stats: [],
    todayExercise: null,
    exerciseHistory: [],
    peerReviewAssignment: null,
    progress: [],
    feedback: [],
    paymentCompleted: false,
    generationStatus: null,
  },
  tutor: {
    stats: [],
    students: [],
    unassignedStudents: [],
    completedTopics: [],
    reports: [],
    questionPapers: [],
  },
  admin: {
    stats: [],
    payments: [],
    tutors: [],
  },
};

const ensureDb = () => {
  if (!db) throw new Error('Firebase is not configured. Add VITE_FIREBASE_* variables to use live data.');
};
const getAdminWorkspaceData = async (scope, payload = {}) => {
  ensureDb();
  if (!functions) throw new Error('Firebase Functions are not configured. Admin workspace data is unavailable.');
  return trackDataRequest(`Admin workspace: ${scope}`, async () => (
    await httpsCallable(functions, 'getAdminWorkspaceData')({ scope, ...payload })
  ).data);
};

const demoUsers = Object.values(mockUsers);
const demoGuideQuizResults = [...mockGuideQuizResults];
const upsertMockLessonRows = (rows = []) => rows.forEach((row) => {
  const index = mockCompletedLessons.findIndex((lesson) => lesson.id === row.id);
  if (index === -1) mockCompletedLessons.push(row);
  else mockCompletedLessons[index] = { ...mockCompletedLessons[index], ...row };
});
const removeMockLessonRows = (ids = []) => {
  const removedIds = new Set(ids);
  for (let index = mockCompletedLessons.length - 1; index >= 0; index -= 1) {
    if (removedIds.has(mockCompletedLessons[index].id)) mockCompletedLessons.splice(index, 1);
  }
};
const lessonRefFor = (lesson) => {
  if (lesson.documentPath) return doc(db, lesson.documentPath);
  if (!lesson.studentId || !lesson.subjectInstanceId || !lesson.id) throw new Error('Lesson is missing its subject episode path.');
  return doc(db, 'users', lesson.studentId, 'subjects', lesson.subjectInstanceId, 'lessons', lesson.id);
};

const GENERATION_HISTORY_LIMIT = 40;
const EXERCISE_REGENERATION_LOCK_TIMEOUT_MS = 20 * 60 * 1000;
const localDateKey = (date = new Date()) => [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
const exerciseAccessWindow = (assignmentDate) => ({
  assignmentOpensAt: new Date(`${assignmentDate}T00:00:00+02:00`),
  locksAt: new Date(`${assignmentDate}T23:59:59.999+02:00`),
});
const completedLessonGenerationSignature = (lesson = {}) => JSON.stringify({
  status: lesson.status,
  attended: lesson.attended,
  attendanceStatus: lesson.attendanceStatus,
  completedOn: lesson.completedOn,
  topics: lesson.topics ?? [],
  scores: (lesson.topicUnderstandingScores ?? []).map((entry) => ({
    topic: String(entry?.topic ?? '').trim(),
    understandingLevel: Number(entry?.understandingLevel),
  })),
  report: lesson.topicReport ?? lesson.note ?? '',
  understandingLevel: lesson.understandingLevel ?? null,
});
const meanUnderstandingScore = (entries = []) => entries.length
  ? Math.round((entries.reduce((sum, entry) => sum + Number(entry.understandingLevel), 0) / entries.length) * 10000) / 10000
  : null;
const lessonScoreToRatio = (value) => {
  const score = Number(value);
  if (!Number.isFinite(score) || score < 0) return null;
  if (score <= 1) return score;
  return score <= 10 ? Math.round((score / 10) * 10000) / 10000 : null;
};
const storedLessonScoreToRatio = (scoreRecord) => {
  const score = Number(scoreRecord?.score);
  if (!Number.isFinite(score) || score < 0) return null;
  if (scoreRecord?.scoreScale === 'ratio-0-to-1') return score <= 1 ? score : null;
  return score <= 10 ? Math.round((score / 10) * 10000) / 10000 : null;
};

const STAFF_ACCESS_ROLES = ['co-owner', 'marker', 'viewer'];
const isTeacherProfile = (profile) => profile?.isTeacher === true || profile?.isTeacher === 'true' || profile?.role === 'teacher';
const getApprovedTutorOrTeacherProfiles = (profiles, subject = null) => {
  const approved = (profile) => {
    const subjects = getApprovedTutorSubjects(profile);
    return subject ? subjects.includes(subject) : subjects.length > 0;
  };
  const tutors = profiles.filter((profile) => profile.role === 'tutor' && approved(profile));
  const teachers = profiles.filter((profile) => isTeacherProfile(profile) && approved(profile));
  return [...new Map([...tutors, ...teachers].map((profile) => [profile.uid, profile])).values()];
};

export const getActiveSubjectEpisode = async (studentId, subject = DEFAULT_SUBJECT, subjectInstanceId = null) => {
  if (!studentId || !isFirebaseConfigured) return null;
  ensureDb();
  const normalizedTarget = normalizeEligibleSubject(subject) ?? subject;
  if (subjectInstanceId) {
    const episodeSnapshot = await getDoc(doc(db, 'users', studentId, 'subjects', subjectInstanceId));
    if (!episodeSnapshot.exists()) return null;
    const episode = episodeSnapshot.data();
    const normalizedEpisodeSubject = normalizeEligibleSubject(episode.subjectKey) ?? episode.subjectKey;
    return episode.status === 'active' && normalizedEpisodeSubject === normalizedTarget
      ? { id: episodeSnapshot.id, ...episode }
      : null;
  }
  const subjectsQuery = query(
    collection(db, 'users', studentId, 'subjects'),
    where('subjectKey', '==', normalizedTarget),
    where('status', '==', 'active'),
    limit(10),
  );
  const snapshot = await getDocs(subjectsQuery);
  const matchingDoc = snapshot.docs.find((docSnap) => docSnap.data().status === 'active');
  return matchingDoc ? { id: matchingDoc.id, ...matchingDoc.data() } : null;
};

export const ensureActiveSubjectEpisode = async (studentId, subject = DEFAULT_SUBJECT, context = {}) => {
  if (!studentId) return null;
  if (!isFirebaseConfigured) {
    return {
      id: `mock-episode-${studentId}-${subject}`,
      studentId,
      subjectKey: subject,
      subjectName: subject,
      status: 'active',
      completedTopicCount: 0,
      dailyExerciseTarget: 1,
    };
  }
  ensureDb();
  const existing = await getActiveSubjectEpisode(studentId, subject, context.subjectInstanceId);
  if (existing) return existing;
  throw new Error(`No active ${subject} episode exists. Add the subject before continuing.`);
};

const refreshTopicUnderstandingAverages = async (episodes = []) => {
  const normalizedEpisodes = episodes.flatMap((item) => {
    const topicIds = [...new Set((item.topicIds ?? []).map((topicId) => String(topicId || '')).filter(Boolean))];
    const chunks = [];
    for (let index = 0; index < topicIds.length; index += 30) {
      chunks.push({ ...item, topicIds: topicIds.slice(index, index + 30) });
    }
    return chunks;
  }).filter((item) => item.topicIds.length);
  if (!normalizedEpisodes.length) return;
  const callable = httpsCallable(functions, 'refreshTopicUnderstandingAverages');
  await callable({ episodes: normalizedEpisodes });
};

const persistLessonOutcome = async ({
  lessonRef,
  lessonData,
  createLesson = false,
  studentId,
  subjectInstanceId,
  tutorId,
  topicScores = [],
  tutorReport = '',
  refreshRollups = true,
}) => {
  const validScores = topicScores.map((entry) => ({
    topic: String(entry.topic || '').trim(),
    score: Number(entry.understandingLevel),
  })).filter((entry) => entry.topic && Number.isFinite(entry.score) && entry.score >= 0 && entry.score <= 1);
  const subjectRef = doc(db, 'users', studentId, 'subjects', subjectInstanceId);
  const scoreEntries = [...new Map(validScores.map((entry) => {
    const canonicalTopicKey = normalizeCatalogTopicKey(entry.topic);
    const topicRef = doc(subjectRef, 'topics', canonicalTopicKey);
    return [canonicalTopicKey, {
      ...entry,
      canonicalTopicKey,
      topicRef,
      scoreRef: doc(topicRef, 'understandingScores', `Lesson-${lessonRef.id}`),
    }];
  })).values()];

  const lessonOutcomeFields = new Set([
    'lessonId', 'topics', 'topic', 'topicReport', 'note', 'topicUnderstandingScores',
    'understandingLevel', 'status', 'attendanceStatus', 'attended', 'completedOn',
    'lessonType', 'whatsappLessonLink', 'locationDetails', 'assignmentPeriodId', 'updatedAt',
  ]);

  await runTransaction(db, async (transaction) => {
    const [subjectSnapshot, lessonSnapshot, ...topicAndScoreSnapshots] = await Promise.all([
      transaction.get(subjectRef),
      transaction.get(lessonRef),
      ...scoreEntries.flatMap((entry) => [transaction.get(entry.topicRef), transaction.get(entry.scoreRef)]),
    ]);
    if (!subjectSnapshot.exists()) throw new Error('Active subject episode not found.');
    if (createLesson && lessonSnapshot.exists()) throw new Error('This lesson already exists.');
    if (!createLesson && !lessonSnapshot.exists()) throw new Error('The lesson no longer exists.');

    const persistedLessonData = createLesson
      ? { ...lessonData }
      : Object.fromEntries(Object.entries(lessonData).filter(([field]) => lessonOutcomeFields.has(field)));
    delete persistedLessonData.topicUnderstandingScores;
    delete persistedLessonData.understandingLevel;
    const lessonWrite = {
      ...persistedLessonData,
      lessonId: lessonRef.id,
      ...(createLesson ? { createdAt: serverTimestamp() } : {}),
      updatedAt: serverTimestamp(),
    };
    if (createLesson) transaction.set(lessonRef, lessonWrite);
    else transaction.update(lessonRef, {
      ...lessonWrite,
      topicUnderstandingScores: deleteField(),
      understandingLevel: deleteField(),
    });

    scoreEntries.forEach((entry, index) => {
      const topicSnapshot = topicAndScoreSnapshots[index * 2];
      const scoreSnapshot = topicAndScoreSnapshots[index * 2 + 1];
      if (scoreSnapshot.exists()) {
        if (Number(scoreSnapshot.data().score) !== entry.score) {
          throw new Error('Completed lesson scores are immutable. Add a new score event instead of replacing the original tutor score.');
        }
      } else {
        transaction.set(entry.scoreRef, {
          sourceType: 'Lesson', sourceId: lessonRef.id, score: entry.score, scoreScale: 'ratio-0-to-1',
          tutorId, notes: tutorReport, createdAt: serverTimestamp(),
        });
      }
      if (!topicSnapshot.exists()) {
        transaction.set(entry.topicRef, {
          canonicalTopicKey: entry.canonicalTopicKey,
          topicName: entry.topic,
          topicStatus: 'done',
          attendanceStatus: 'attended',
          firstCompletedAt: serverTimestamp(),
          lastCoveredAt: serverTimestamp(),
          understandingLevel: entry.score,
          understandingScale: 'ratio-0-to-1',
          scoreCount: 1,
        latestScore: entry.score,
          tutorReport,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
        return;
      }
      transaction.update(entry.topicRef, {
        topicStatus: 'done',
        attendanceStatus: 'attended',
        ...(!topicSnapshot.data().firstCompletedAt ? { firstCompletedAt: serverTimestamp() } : {}),
        lastCoveredAt: serverTimestamp(),
        ...(tutorReport ? { tutorReport } : {}),
        updatedAt: serverTimestamp(),
      });
    });
  });
  if (refreshRollups && scoreEntries.length) {
    await refreshTopicUnderstandingAverages([{
      studentId,
      subjectInstanceId,
      topicIds: scoreEntries.map((entry) => entry.canonicalTopicKey),
    }]);
  }
  return scoreEntries.map((entry) => entry.canonicalTopicKey);
};

const getTutorAccessContext = async ({ tutorId, studentId, subject = DEFAULT_SUBJECT }) => {
  const contexts = await getTutorAssignedStudentContexts(tutorId);
  return contexts.find((context) => context.studentId === studentId && context.subject === subject) ?? null;
};

const requireTutorAccess = async ({ tutorId, studentId, subject = DEFAULT_SUBJECT, allowedRoles = ['co-owner', 'marker'] }) => {
  const context = await getTutorAccessContext({ tutorId, studentId, subject });
  if (!context) throw new Error('You do not have access to this student for the selected subject.');
  if (!allowedRoles.includes(context.accessRole)) throw new Error('Your access role does not allow this action.');
  return context;
};

const requireCoOwnerAccess = (params) => requireTutorAccess({ ...params, allowedRoles: ['co-owner'] });

const normalizeQuestionReferenceTitle = (references = []) =>
  references
    .map((reference) => String(reference || '').trim())
    .filter(Boolean)
    .join(' | ');

const toDateOnly = (value) => {
  if (!value) return null;
  return String(value).slice(0, 10);
};

const buildStudentGenerationStatus = ({
  availablePapers = [],
  paidSubscriptionActive,
  subscriptionPlanId = 'free',
  subscriptionPlanName = 'Free',
  subscriptionId = null,
  subscriptionPaymentReference = null,
  completedLessons = [],
  hasInitialGeneration = false,
}) => {
  const initialReady = Boolean(paidSubscriptionActive && availablePapers.length >= 2 && completedLessons.length > 0);
  const weeklyReady = Boolean(hasInitialGeneration && paidSubscriptionActive && completedLessons.length > 0 && availablePapers.length >= 2);

  return {
    paidSubscriptionActive,
    subscriptionPlanId,
    subscriptionPlanName,
    subscriptionId,
    subscriptionPaymentReference,
    initial: {
      ready: initialReady,
      checks: {
        paidSubscriptionActive,
        minimumQuestionPaperCountMet: availablePapers.length >= 2,
        lessonCompleted: completedLessons.length > 0,
      },
    },
    weekly: {
      ready: weeklyReady,
      checks: {
        initialGenerationExists: hasInitialGeneration,
        paidSubscriptionActive,
        lessonCompleted: completedLessons.length > 0,
        minimumQuestionPaperCountMet: availablePapers.length >= 2,
      },
    },
  };
};

const filterQuestionPapers = (papers, { grade, region, subject = DEFAULT_SUBJECT, allowNational = true }) =>
  papers.filter((paper) => {
    const subjectMatches = paper.subject === subject;
    const gradeMatches = !paper.grade || !grade || paper.grade === grade;
    const regionMatches = paper.region === region || (allowNational && paper.region === 'National');
    return subjectMatches && gradeMatches && regionMatches;
  });

const getLatestTutorReportFromList = (studentId, reports = []) =>
  [...reports]
    .filter((report) => report.studentId === studentId && report.reportType !== 'initial')
    .sort((left, right) => new Date(right.updatedAt ?? right.createdAt ?? 0) - new Date(left.updatedAt ?? left.createdAt ?? 0))[0] ?? null;

const hasLessonReport = (lesson = {}) => Boolean(String(lesson.topicReport ?? lesson.note ?? '').trim());

const hasLessonUnderstandingScore = (lesson = {}) => {
  if (Array.isArray(lesson.topicUnderstandingScores) && lesson.topicUnderstandingScores.length) {
    return lesson.topicUnderstandingScores.every((entry) => Number.isFinite(Number(entry?.understandingLevel)));
  }
  return Number.isFinite(Number(lesson.understandingLevel));
};

const isCompletedLessonReadyForGeneration = (lesson = {}) =>
  lesson.status !== 'planned' &&
  Boolean(lesson.completedOn || lesson.status === 'completed') &&
  hasLessonReport(lesson) &&
  hasLessonUnderstandingScore(lesson);

const getLessonTopicEntries = (lesson = {}, lessonIndex = 0) => {
  if (lesson.status === 'missed' || lesson.attendanceStatus === 'missed' || lesson.attended === false) return [];
  if (Array.isArray(lesson.topicUnderstandingScores) && lesson.topicUnderstandingScores.length) {
    return lesson.topicUnderstandingScores
      .map((entry) => ({
        topic: String(entry?.topic || '').trim(),
        understandingLevel: lessonScoreToRatio(entry?.understandingLevel ?? lesson?.understandingLevel ?? 0.5) ?? 0.5,
        exerciseScores: Array.isArray(entry?.exerciseScores) ? entry.exerciseScores : [],
        reportSnippet: entry?.topicReport ?? lesson?.topicReport ?? lesson?.note ?? '',
        completedOn: lesson?.completedOn ?? lesson?.createdAt ?? '',
        firstSeenIndex: lessonIndex,
      }))
      .filter((entry) => entry.topic);
  }

  const topics = Array.isArray(lesson?.topics) && lesson.topics.length
    ? lesson.topics
    : [lesson?.topic];
  return topics
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .map((topic) => ({
      topic,
      understandingLevel: lessonScoreToRatio(lesson?.understandingLevel ?? 0.5) ?? 0.5,
      reportSnippet: lesson?.topicReport ?? lesson?.note ?? '',
      completedOn: lesson?.completedOn ?? lesson?.createdAt ?? '',
      firstSeenIndex: lessonIndex,
    }));
};

const hydrateEpisodeLessonScores = async (lessons = [], studentId, subjectInstanceId) => {
  if (!isFirebaseConfigured || !studentId || !subjectInstanceId || !lessons.length) return lessons;
  return Promise.all(lessons.map(async (lesson) => {
    if (lesson.status !== 'completed' && !lesson.completedOn) return lesson;
    const topics = [...new Set((Array.isArray(lesson.topics) && lesson.topics.length ? lesson.topics : [lesson.topic])
      .filter(Boolean).map((topic) => String(topic).trim()))];
    const scoreSnapshots = await Promise.all(topics.map((topic) => getDoc(doc(
      db, 'users', studentId, 'subjects', subjectInstanceId, 'topics', normalizeCatalogTopicKey(topic),
      'understandingScores', `Lesson-${lesson.id}`,
    ))));
    const topicUnderstandingScores = scoreSnapshots.flatMap((snapshot, index) => {
      if (!snapshot.exists()) return [];
      const understandingLevel = storedLessonScoreToRatio(snapshot.data());
      return understandingLevel === null ? [] : [{ topic: topics[index], understandingLevel, topicReport: snapshot.data().notes || '' }];
    });
    const understandingLevel = meanUnderstandingScore(topicUnderstandingScores);
    return { ...lesson, topicUnderstandingScores, understandingLevel };
  }));
};

const getTopicSummary = (completedLessons = []) => {
  const topicMap = new Map();

  completedLessons.forEach((lesson, lessonIndex) => {
    getLessonTopicEntries(lesson, lessonIndex).forEach((entry) => {
      const current = topicMap.get(entry.topic) ?? {
        topic: entry.topic,
        topicStatus: 'done',
        attendanceStatus: 'attended',
        understandingLevel: entry.understandingLevel,
        reportSnippet: entry.reportSnippet,
        completedOn: entry.completedOn,
        lessonCount: 0,
        firstSeenIndex: entry.firstSeenIndex,
      };

      topicMap.set(entry.topic, {
        ...current,
        understandingLevel: entry.understandingLevel,
        reportSnippet: entry.reportSnippet || current.reportSnippet,
        completedOn: entry.completedOn || current.completedOn,
        lessonCount: current.lessonCount + 1,
      });
    });
  });

  return [...topicMap.values()]
    .sort((left, right) => {
      const dateDifference = new Date(left.completedOn || 0) - new Date(right.completedOn || 0);
      if (dateDifference !== 0) return dateDifference;
      return left.firstSeenIndex - right.firstSeenIndex;
    });
};

const dateValueForSummary = (value) => {
  if (value?.toDate) return value.toDate();
  if (value instanceof Date) return value;
  return value ? new Date(value) : null;
};

const getTopicSummariesFromDocuments = (topicDocuments = []) => topicDocuments
  .map((item, index) => {
    const topic = String(item.topicName || item.canonicalTopicKey || item.id || '').trim();
    if (['planned', 'pending', 'missed', 'cancelled', 'removed'].includes(item.topicStatus)
      || ['pending', 'missed', 'cancelled', 'removed'].includes(item.attendanceStatus)) return null;
    const topicStatus = item.topicStatus === 'marked' || item.attendanceStatus === 'not-attended'
      ? 'marked'
      : item.topicStatus === 'done' || item.attendanceStatus === 'attended' || item.firstCompletedAt || item.lastCoveredAt
        ? 'done'
        : null;
    if (!topicStatus) return null;
    const attendanceStatus = topicStatus === 'marked' ? 'not-attended' : 'attended';
    const completedAt = topicStatus === 'marked'
      ? item.firstMarkedAt ?? item.scoreUpdatedAt ?? item.createdAt ?? null
      : item.lastCoveredAt ?? item.firstCompletedAt ?? item.createdAt ?? null;
    const completedDate = dateValueForSummary(completedAt);
    return {
      topic,
      topicStatus,
      attendanceStatus,
      understandingLevel: item.understandingScale === 'ratio-0-to-1'
        && item.understandingLevel !== null && item.understandingLevel !== undefined
        && Number.isFinite(Number(item.understandingLevel)) && Number(item.understandingLevel) >= 0 && Number(item.understandingLevel) <= 1
        ? Number(item.understandingLevel) : null,
      reportSnippet: String(item.tutorReport || item.latestReport || '').trim(),
      completedOn: completedDate && !Number.isNaN(completedDate.getTime()) ? completedDate.toISOString() : '',
      scoreCount: Math.max(0, Number(item.scoreCount) || 0),
      firstSeenIndex: index,
    };
  })
  .filter((item) => item?.topic)
  .sort((left, right) => {
    const dateDifference = new Date(left.completedOn || 0) - new Date(right.completedOn || 0);
    return dateDifference || left.firstSeenIndex - right.firstSeenIndex;
  });

const getEpisodeTopicSummaries = async (studentId, subjectInstanceId) => {
  if (!studentId || !subjectInstanceId) return [];
  const snapshot = await getDocs(collection(db, 'users', studentId, 'subjects', subjectInstanceId, 'topics'));
  return getTopicSummariesFromDocuments(snapshot.docs.map((item) => ({ id: item.id, ...item.data() })));
};

const buildSubjectUnderstandingSummary = (subject, topicSummaries = []) => {
  const scoredTopics = topicSummaries.filter((topic) => Number.isFinite(topic.understandingLevel)
    && topic.understandingLevel >= 0 && topic.understandingLevel <= 1);
  return {
    subject,
    understandingLevel: scoredTopics.length
      ? Math.round((scoredTopics.reduce((total, topic) => total + topic.understandingLevel, 0) / scoredTopics.length) * 10000) / 10000
      : null,
    scoredTopicCount: scoredTopics.length,
    completedTopicCount: topicSummaries.filter((topic) => topic.topicStatus !== 'marked').length,
    markedTopicCount: topicSummaries.filter((topic) => topic.topicStatus === 'marked').length,
  };
};


const buildTutorDashboard = ({ tutorId = 'mock-tutor-1', subject = DEFAULT_SUBJECT } = {}) => {
  const assignedStudentIds = new Set(
    (mockStudentAssignments ?? [])
      .filter((assignment) => assignment.tutorId === tutorId && assignment.active !== false && (assignment.subject ?? DEFAULT_SUBJECT) === subject)
      .map((assignment) => assignment.studentId),
  );
  const subjectAssignedStudentIds = new Set(
    (mockStudentAssignments ?? [])
      .filter((assignment) => assignment.active !== false && (assignment.subject ?? DEFAULT_SUBJECT) === subject)
      .map((assignment) => assignment.studentId),
  );
  const assignedStudents = demoUsers.filter((user) => user.role === 'student' && assignedStudentIds.has(user.uid));
  const unassignedStudents = demoUsers.filter((user) => user.role === 'student' && !subjectAssignedStudentIds.has(user.uid));

  return {
    ...mockDashboardData.tutor,
    students: assignedStudents.map((student) => ({
      id: student.uid,
      name: student.displayName,
      grade: student.grade,
      latestMark: student.latestMark,
      province: student.province,
      paymentCompleted: student.paymentCompleted,
    })),
    unassignedStudents: unassignedStudents.map((student) => ({
      id: student.uid,
      name: student.displayName,
      grade: student.grade,
      latestMark: student.latestMark,
      province: student.province,
      paymentCompleted: student.paymentCompleted,
    })),
    reports: mockTutorReports.filter((report) => (report.subject ?? DEFAULT_SUBJECT) === subject),
    completedTopics: mockCompletedLessons.filter((lesson) => (lesson.subject ?? DEFAULT_SUBJECT) === subject),
    questionPapers: mockQuestionPapers.filter((paper) => paper.subject === subject),
    stats: [
      { label: 'Assigned students', value: String(assignedStudents.length), detail: subject },
      { label: 'Unassigned students', value: String(unassignedStudents.length), detail: 'Ready to add' },
      { label: 'Question papers', value: String(mockQuestionPapers.length), detail: 'Published' },
      { label: 'Reports', value: String(mockTutorReports.length), detail: 'Latest editable notes' },
    ],
  };
};

const buildStudentDashboard = (studentId, subject = DEFAULT_SUBJECT) => {
  const student = demoUsers.find((user) => user.uid === studentId) ?? demoUsers.find((user) => user.role === 'student');
  const assignmentHistory = (mockDashboardData.student.exerciseHistory ?? [])
    .filter((assignment) => (assignment.subject ?? DEFAULT_SUBJECT) === subject);
  const availablePapers = filterQuestionPapers(mockQuestionPapers, {
    grade: student?.grade,
    region: student?.province,
    subject,
  });
  const subscriptionState = getEffectiveSubscriptionState({
    subscription: {
      planId: student?.subscriptionPlanId,
      status: student?.subscriptionStatus,
      billingPeriod: student?.subscriptionBillingPeriod,
      subjectCount: student?.subscriptionSubjectCount,
      renewalDate: student?.subscriptionRenewalDate,
    },
  });
  const paidSubscriptionActive = subscriptionState.paymentCompleted &&
    getUserSubjects(student).slice(0, subscriptionState.subscriptionSubjectCount).includes(subject);
  const subscriptionPaymentReference = student?.latestPaymentReference || (paidSubscriptionActive ? 'demo-payment-reference' : null);
  const generationStatus = buildStudentGenerationStatus({
    availablePapers,
    paidSubscriptionActive,
    subscriptionPlanId: subscriptionState.subscriptionPlanId,
    subscriptionPlanName: subscriptionState.subscriptionPlanName,
    subscriptionId: student?.uid ?? null,
    subscriptionPaymentReference,
    completedLessons: mockCompletedLessons.filter((lesson) => lesson.studentId === student?.uid && (lesson.subject ?? DEFAULT_SUBJECT) === subject),
    hasInitialGeneration: hasExerciseGeneration(assignmentHistory),
  });

  return {
    ...mockDashboardData.student,
    paymentCompleted: paidSubscriptionActive,
    paidSubscriptionActive,
    generationStatus,
    stats: [
      { label: 'Average mark', value: `${student?.latestMark ?? 0}%`, detail: 'Current learning signal' },
      { label: 'Previous year mark', value: `${student?.previousYearMark ?? 0}%`, detail: 'Entered by student' },
      { label: 'Completed topics', value: String(mockCompletedLessons.filter((lesson) => lesson.studentId === student?.uid && (lesson.subject ?? DEFAULT_SUBJECT) === subject).length), detail: subject },
      { label: 'Subscription', value: paidSubscriptionActive ? 'Active' : 'Pending', detail: paidSubscriptionActive ? 'Paid plan verified' : 'Paid subscription required' },
    ],
  };
};

export const getRoleDashboardData = async (role, options = {}) => {
  if (!isFirebaseConfigured) {
    if (role === 'student') return buildStudentDashboard(options.studentId ?? 'mock-student-1', options.subject ?? DEFAULT_SUBJECT);
    if (role === 'tutor') return buildTutorDashboard({ tutorId: options.tutorId, subject: options.subject ?? DEFAULT_SUBJECT });
    return mockDashboardData[role];
  }
  if (role === 'admin') return getAdminWorkspaceData('dashboard');
  return emptyDashboardData[role] ?? { stats: [] };
};

export const getRecentExerciseGenerationWarningsForAdmin = async () => {
  if (!isFirebaseConfigured) return [];
  ensureDb();
  const snapshot = await getDocs(query(
    collectionGroup(db, 'generationRuns'),
    orderBy('updatedAt', 'desc'),
    limit(100),
  ));
  return snapshot.docs
    .map((item) => ({ id: item.id, ...item.data() }))
    .filter((item) => item.needsMorePaperAnalysis === true)
    .sort((left, right) => {
      const timestampMs = (entry) => {
        if (typeof entry.updatedAt?.toMillis === 'function') return entry.updatedAt.toMillis();
        if (Number.isFinite(Number(entry.updatedAt?.seconds))) return Number(entry.updatedAt.seconds) * 1000;
        return Number(entry.finishedAtMs) || 0;
      };
      return timestampMs(right) - timestampMs(left);
    });
};

const episodeExercises = async (studentId, subject, constraints = [], subjectInstanceId = null, knownEpisode = null) => {
  const episode = knownEpisode ?? await getActiveSubjectEpisode(studentId, subject, subjectInstanceId);
  if (!episode?.id) return [];
  const snapshot = await getDocs(query(
    collection(db, 'users', studentId, 'subjects', episode.id, 'exercises'),
    ...constraints,
  ));
  return snapshot.docs.map((item) => ({ id: item.id, ...item.data(), studentId, subjectInstanceId: episode.id, documentPath: item.ref.path }));
};

export const getTodayExercises = async (studentId, subject = DEFAULT_SUBJECT, knownEpisode = null) => {
  if (!isFirebaseConfigured) {
    const single = buildStudentDashboard(studentId, subject).todayExercise;
    return single ? [single] : [];
  }
  ensureDb();
  return episodeExercises(studentId, subject, [where('assignmentDate', '==', localDateKey()), limit(MAX_EXERCISES_PER_DATE)], null, knownEpisode);
};

export const subscribeToTodayExercisesForStudent = (studentId, subjectEpisodes = [], callback = () => {}, onError = () => {}) => {
  if (!studentId) {
    callback([]);
    return () => {};
  }
  if (!subjectEpisodes.length) {
    callback([]);
    return () => {};
  }
  if (!isFirebaseConfigured) {
    let cancelled = false;
    Promise.all(subjectEpisodes.map((episode) => getTodayExercises(studentId, episode.subjectKey ?? DEFAULT_SUBJECT, episode)))
      .then((rows) => {
        if (!cancelled) callback(rows.flat());
      })
      .catch((error) => {
        if (!cancelled) onError(error);
      });
    return () => { cancelled = true; };
  }

  ensureDb();
  let cancelled = false;
  const snapshotsByEpisode = new Map();
  const receivedEpisodes = new Set();
  const episodes = subjectEpisodes.filter((episode) => episode?.id);
  const publish = () => {
    if (cancelled || receivedEpisodes.size < episodes.length) return;
    callback([...snapshotsByEpisode.values()].flat().sort((left, right) => (
      String(left.subject ?? '').localeCompare(String(right.subject ?? ''))
      || String(left.assignmentDate ?? '').localeCompare(String(right.assignmentDate ?? ''))
    )));
  };
  const unsubscribes = episodes.map((episode) => onSnapshot(query(
    collection(db, 'users', studentId, 'subjects', episode.id, 'exercises'),
    where('assignmentDate', '==', localDateKey()),
    limit(MAX_EXERCISES_PER_DATE),
  ), (snapshot) => {
    receivedEpisodes.add(episode.id);
    snapshotsByEpisode.set(episode.id, snapshot.docs.map((item) => ({
      id: item.id,
      ...item.data(),
      studentId,
      subject: item.data().subject ?? episode.subjectKey ?? DEFAULT_SUBJECT,
      subjectInstanceId: episode.id,
      documentPath: item.ref.path,
    })));
    publish();
  }, (error) => {
    if (!cancelled) onError(error);
  }));

  if (!episodes.length) callback([]);
  return () => {
    cancelled = true;
    unsubscribes.forEach((unsubscribe) => unsubscribe());
  };
};

const normalizeAssignmentDate = (value) => String(value ?? '').slice(0, 10);

export const getStudentExerciseCalendarBounds = async (studentId, subjectEpisodes = []) => {
  if (!studentId || !subjectEpisodes.length) return { earliestDate: '', latestDate: '', subjectBounds: {} };
  if (!isFirebaseConfigured) return { earliestDate: '', latestDate: '', subjectBounds: {} };
  ensureDb();

  const episodeBounds = await Promise.all(subjectEpisodes.filter((episode) => episode?.id).map(async (episode) => {
    const exercisesRef = collection(db, 'users', studentId, 'subjects', episode.id, 'exercises');
    const [firstSnapshot, lastSnapshot] = await Promise.all([
      getDocs(query(exercisesRef, orderBy('assignmentDate', 'asc'), limit(1))),
      getDocs(query(exercisesRef, orderBy('assignmentDate', 'desc'), limit(1))),
    ]);
    return {
      subjectInstanceId: episode.id,
      earliestDate: normalizeAssignmentDate(firstSnapshot.docs[0]?.data()?.assignmentDate),
      latestDate: normalizeAssignmentDate(lastSnapshot.docs[0]?.data()?.assignmentDate),
    };
  }));

  const dates = episodeBounds.flatMap((item) => [item.earliestDate, item.latestDate]).filter(Boolean).sort();
  return {
    earliestDate: dates[0] ?? '',
    latestDate: dates.at(-1) ?? '',
    subjectBounds: Object.fromEntries(episodeBounds.map((item) => [item.subjectInstanceId, item])),
  };
};

export const getStudentExerciseCalendarWindow = async ({ studentId, subjectEpisodes = [], startDate, endDate }) => {
  if (!studentId || !startDate || !endDate || !subjectEpisodes.length) return [];
  if (!isFirebaseConfigured) {
    const today = localDateKey();
    if (today < startDate || today > endDate) return [];
    const demoRows = await Promise.all(subjectEpisodes.map(async (episode) => {
      const rows = await getTodayExercises(studentId, episode.subjectKey ?? DEFAULT_SUBJECT, episode);
      return rows.map((item) => ({
        ...item,
        subject: item.subject ?? episode.subjectKey ?? DEFAULT_SUBJECT,
        subjectInstanceId: item.subjectInstanceId ?? episode.id,
      }));
    }));
    return demoRows.flat();
  }
  ensureDb();

  const exerciseRows = await Promise.all(subjectEpisodes.filter((episode) => episode?.id).map(async (episode) => {
    const snapshot = await getDocs(query(
      collection(db, 'users', studentId, 'subjects', episode.id, 'exercises'),
      where('assignmentDate', '>=', startDate),
      where('assignmentDate', '<=', endDate),
      orderBy('assignmentDate', 'asc'),
    ));
    return snapshot.docs.map((item) => ({
      id: item.id,
      ...item.data(),
      studentId,
      subject: item.data().subject ?? episode.subjectKey ?? DEFAULT_SUBJECT,
      subjectInstanceId: episode.id,
      documentPath: item.ref.path,
    }));
  }));

  return exerciseRows.flat().sort((left, right) => String(left.assignmentDate).localeCompare(String(right.assignmentDate)));
};

export const getCompletedPeerMarkingAssignmentsForCalendar = async ({ reviewerId, startDate, endDate, subjectInstanceIds = [] }) => {
  if (!reviewerId || !startDate || !endDate || !isFirebaseConfigured) return [];
  ensureDb();
  const snapshot = await getDocs(query(
    collectionGroup(db, 'peerMarkingAssignments'),
    where('reviewerId', '==', reviewerId),
    where('status', '==', 'completed'),
    where('assignmentDate', '>=', startDate),
    where('assignmentDate', '<=', endDate),
    orderBy('assignmentDate', 'desc'),
  ));
  const activeSubjectIds = new Set(subjectInstanceIds);
  return snapshot.docs
    .map((item) => ({ id: item.id, ...item.data(), assignmentPath: item.ref.path }))
    .filter((item) => !activeSubjectIds.size || activeSubjectIds.has(item.reviewerSubjectInstanceId));
};

export const getTodayExercise = async (studentId, subject = DEFAULT_SUBJECT, knownEpisode = null) => {
  const exercises = await getTodayExercises(studentId, subject, knownEpisode);
  return exercises.find((exercise) => !isExerciseSubmitted(exercise)) ?? exercises[0] ?? null;
};

export const getExerciseHistory = async (studentId, subject = DEFAULT_SUBJECT, knownEpisode = null) => {
  if (!isFirebaseConfigured) return buildStudentDashboard(studentId, subject).exerciseHistory;
  ensureDb();
  return episodeExercises(studentId, subject, [where('assignmentDate', '<', localDateKey()), orderBy('assignmentDate', 'desc'), limit(20)], null, knownEpisode);
};

export const getCurrentWeekExercises = async (studentId, subject = DEFAULT_SUBJECT) => {
  if (!isFirebaseConfigured) return [];
  ensureDb();
  const today = localDateKey();
  const end = formatISO(addDays(new Date(`${today}T12:00:00`), 6), { representation: 'date' });
  return episodeExercises(studentId, subject, [where('assignmentDate', '>=', today), where('assignmentDate', '<=', end), orderBy('assignmentDate', 'asc'), limit(35)]);
};

export const getFutureExercises = async (studentId, subject = DEFAULT_SUBJECT) => {
  if (!isFirebaseConfigured) return [];
  ensureDb();
  const weekFromToday = formatISO(addDays(new Date(`${localDateKey()}T12:00:00`), 7), { representation: 'date' });
  return episodeExercises(studentId, subject, [where('assignmentDate', '>', weekFromToday), orderBy('assignmentDate', 'asc'), limit(20)]);
};

const getAssignmentHistory = async (studentId, subject = DEFAULT_SUBJECT, maxRecords = GENERATION_HISTORY_LIMIT, subjectInstanceId = null, knownEpisode = null) => {
  if (!studentId) return [];
  if (!isFirebaseConfigured) return buildStudentDashboard(studentId, subject).exerciseHistory ?? [];
  ensureDb();
  return episodeExercises(studentId, subject, [orderBy('assignmentDate', 'desc'), limit(maxRecords)], subjectInstanceId, knownEpisode);
};

const getLastAssignmentDate = (history = []) =>
  [...history]
    .map((assignment) => toDateOnly(assignment?.assignmentDate))
    .filter(Boolean)
    .sort()
    .at(-1) ?? null;

const isAnalyzedQuestionPaper = (paper = {}) =>
  paper.analysisStatus === 'Analyzed' && paper.availableForGeneration !== false && Array.isArray(paper.questions) && paper.questions.length > 0;

const normalizeQuestionDifficulty = (value) => {
  const difficulty = String(value ?? '').trim().toLowerCase();
  if (['easy', 'basic'].includes(difficulty)) return 'easy';
  if (['medium', 'moderate', 'average'].includes(difficulty)) return 'medium';
  if (['hard', 'difficult', 'challenging'].includes(difficulty)) return 'hard';
  return '';
};

const preferredQuestionDifficulty = (values = []) => {
  const counts = new Map();
  values.map(normalizeQuestionDifficulty).filter(Boolean).forEach((difficulty) => {
    counts.set(difficulty, (counts.get(difficulty) ?? 0) + 1);
  });
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || (left[0] === 'medium' ? -1 : right[0] === 'medium' ? 1 : left[0].localeCompare(right[0])))[0]?.[0] || '';
};

const summarizePaperQuestions = (paper = {}, completedTopics = []) =>
  (Array.isArray(paper.questions) ? paper.questions : [])
    .filter((question) => questionMatchesTopics(question, completedTopics))
    .map((question) => ({
      paperId: question.paperId ?? paper.id,
      questionReference: question.questionReference ?? question.reference,
      subject: question.subject ?? paper.subject,
      topic: question.topic,
      topics: Array.isArray(question.topics) ? question.topics : [],
      pageNumber: question.pageNumber ?? question.page,
      marks: question.marks ?? 0,
      difficulty: String(question.difficulty ?? '').trim().toLowerCase(),
      section: question.section ?? '',
    }))
    .filter((question) => question.questionReference && question.pageNumber);

const selectTopicPaperMetadata = ({ papers = [], completedTopics = [], topicSummaries = [] }) => {
  const analyzedPapers = papers.filter(isAnalyzedQuestionPaper);
  const selectedPaperMap = new Map();

  const topics = topicSummaries.length ? topicSummaries : completedTopics.map((topic) => ({ topic, topicStatus: 'done' }));
  const topicPaperMetadata = topics.map((topicSummary) => {
    const topic = topicSummary.topic;
    const paperMatches = analyzedPapers
      .map((paper) => ({
        paper,
        questions: summarizePaperQuestions(paper, [topic]),
      }))
      .filter((item) => item.questions.length > 0);
    paperMatches.forEach(({ paper }) => selectedPaperMap.set(paper.id, paper));

    return {
      topic,
      topicStatus: topicSummary.topicStatus === 'marked' ? 'marked' : 'done',
      understandingLevel: topicSummary.understandingLevel ?? null,
      paperCount: paperMatches.length,
      papers: paperMatches.map(({ paper, questions }) => ({
        id: paper.id,
        year: paper.year,
        month: paper.month,
        region: paper.region,
        subject: paper.subject,
        grade: paper.grade,
        paperNumber: paper.paperNumber ?? 'Paper 1',
        copySuffix: paper.copySuffix ?? '',
        displayName: paper.displayName ?? '',
        questions,
      })),
    };
  });
  const selectedPapers = [...selectedPaperMap.values()];
  const topicsWithSources = topicPaperMetadata.filter((item) => item.papers.length > 0);
  return {
    selectedPapers,
    topicPaperMetadata,
    topicsWithSources,
    topicsWithoutSources: topicPaperMetadata.filter((item) => item.papers.length === 0).map((item) => item.topic),
    analyzedPaperCount: analyzedPapers.length,
    matchingAnalyzedPaperCount: selectedPapers.length,
  };
};

const buildAssignmentDates = ({ assignmentHistory = [], dayCount = WEEKLY_EXERCISE_DAYS }) => {
  const lastAssignmentDate = getLastAssignmentDate(assignmentHistory);
  const baseDate = lastAssignmentDate ? addDays(new Date(lastAssignmentDate), 1) : new Date();
  const daysToCreate = Math.max(WEEKLY_EXERCISE_DAYS, Math.min(30, Number(dayCount) || WEEKLY_EXERCISE_DAYS));

  return Array.from({ length: daysToCreate }, (_, dayIndex) =>
    formatISO(addDays(baseDate, dayIndex), { representation: 'date' }),
  );
};

const buildAssignmentsFromRuleBasedRecommendations = ({
  recommendations = [],
  student,
  subscriptionTrace = {},
  selectedPapers = [],
  generationBatchId,
  mode,
  subject = DEFAULT_SUBJECT,
  topicSummaries = [],
  maxExercisesPerDay = MAX_EXERCISES_PER_DATE,
  dailyExerciseCaps = {},
  allowedAssignmentDates = [],
  grade,
  generationWeek = 1,
}) => {
  const allowedDates = new Set(allowedAssignmentDates);
  const dailyExerciseCounts = new Map();
  const cappedRecommendations = recommendations.filter((recommendation) => {
    const assignmentDate = String(recommendation?.assignmentDate ?? '');
    if (!assignmentDate || (allowedDates.size && !allowedDates.has(assignmentDate))) return false;
    const count = dailyExerciseCounts.get(assignmentDate) ?? 0;
    if (count >= (dailyExerciseCaps[assignmentDate] ?? maxExercisesPerDay)) return false;
    dailyExerciseCounts.set(assignmentDate, count + 1);
    return true;
  });

  return cappedRecommendations.map((recommendation, index) => {
    const questions = (Array.isArray(recommendation?.questions) ? recommendation.questions : [])
      .map((entry) => ({
        topic: String(entry?.topic || 'Subject topic').trim(),
        questionReference: String(entry?.questionReference || entry?.reference || '').trim(),
        paperId: String(entry?.paperId || '').trim(),
        pageNumber: Number(entry?.pageNumber ?? entry?.page) || 1,
        marks: Number(entry?.marks) || 0,
        difficulty: String(entry?.difficulty ?? '').trim().toLowerCase(),
      }))
      .filter((entry) => entry.questionReference);
    const topicBreakdown = questions.map(({ topic, questionReference, difficulty }) => ({ topic, questionReference, difficulty }));
    const questionReferences = questions.map((entry) => entry.questionReference);
    const questionLinks = questions.map(({ paperId, pageNumber, questionReference, topic, marks, difficulty }) => ({
      paperId,
      pageNumber,
      questionReference,
      topic,
      marks,
      difficulty,
    }));
    const sourcePapers = [...new Set(questions.map((question) => question.paperId))]
      .map((paperId) => selectedPapers.find((paper) => paper.id === paperId))
      .filter(Boolean);
    const paperIds = [...new Set(questions.map((question) => question.paperId).filter(Boolean))];

    return {
      studentId: student.uid,
      assignmentDate: recommendation.assignmentDate,
      questionCount: questions.length,
      title: normalizeQuestionReferenceTitle(questionReferences) || `Question set ${index + 1}`,
      topic: topicBreakdown.map((entry) => entry.topic).filter(Boolean).join(' | ') || recommendation.topic || 'Subject topic',
      sourceLabel: sourcePapers.map((paper) => paper.displayName || [paper.year, paper.region, paper.month, paper.paperNumber ?? 'paper'].filter(Boolean).join(' ')).join('; ')
        || recommendation.sourceLabel
        || selectedPapers.map((paper) => `${paper.year} ${paper.region} ${paper.month} paper`).join('; '),
      instruction: recommendation.instruction || recommendation.reason || 'Answer the referenced question number(s) only.',
      subject,
      grade: grade ?? null,
      generatedBy: 'local-question-index-planner',
      generationMode: mode,
      generationBatchId,
      generationWeek,
      paidSubscriptionActive: true,
      subscriptionId: subscriptionTrace.subscriptionId ?? null,
      subscriptionPlanId: subscriptionTrace.subscriptionPlanId ?? 'free',
      subscriptionPlanName: subscriptionTrace.subscriptionPlanName ?? 'Free',
      subscriptionPaymentReference: subscriptionTrace.subscriptionPaymentReference ?? null,
      paperIds,
      understandingLevel: null,
      reportSnippet: topicBreakdown.map((entry) => {
        const match = topicSummaries.find((topicSummary) => topicSummary.topic === entry.topic);
        return match ? `${entry.topic}: ${match.reportSnippet}` : entry.topic;
      }).filter(Boolean).join('\n'),
      questionReferences,
      questionLinks,
      questions,
      topicBreakdown,
      submittedImageUrl: "",
      submittedFileName: "",
      peerReviewed: "No",
      peerReviewStatus: "pending",
      peerReviewDate: null,
      submittedReviewImageUrl: "",
      submittedReviewFileName: "",
    };
  });
};

const getSubscriptionLifecycleFields = (subscription) => ({
  autoRenew: subscription?.autoRenew === true,
  cancelAtPeriodEnd: subscription?.cancelAtPeriodEnd === true,
  pendingPlan: subscription?.pendingPlan ?? null,
  pendingPlanReference: subscription?.pendingPlanReference ?? null,
  graceEndsAt: subscription?.graceEndsAt ?? null,
  renewalAttemptCount: Number(subscription?.renewalAttemptCount) || 0,
  renewalVerificationPending: ['processing', 'unknown'].includes(subscription?.renewalAttempt?.status),
  nextRenewalAttemptAt: subscription?.nextRenewalAttemptAt ?? null,
  manualPaymentRequired: subscription?.manualPaymentRequired === true,
  lastChargeStatus: subscription?.lastChargeStatus ?? null,
  discountPercent: Number(subscription?.discountPercent) || 0,
  discountCode: subscription?.discountCode ?? null,
  discountBillingDuration: subscription?.discountBillingDuration ?? null,
  discountDurationMonths: Number(subscription?.discountDurationMonths) || null,
  discountEndsAt: subscription?.discountEndsAt ?? null,
  amount: Number(subscription?.amount) || 0,
});

const resolveVerifiedSubscriptionState = async ({ studentId, subscription }) => {
  const state = getEffectiveSubscriptionState({ subscription });
  const subscriptionPaymentReference = subscription?.latestReference ?? null;
  const base = {
    ...state,
    ...getSubscriptionLifecycleFields(subscription),
    paidSubscriptionActive: false,
    subscriptionId: studentId,
    subscriptionPaymentReference,
    subscriptionPaymentVerified: false,
  };
  if (!state.paymentCompleted) return base;

  if (!subscriptionPaymentReference) {
    return {
      ...getEffectiveSubscriptionState(),
      ...getSubscriptionLifecycleFields(subscription),
      paidSubscriptionActive: false,
      subscriptionId: studentId,
      subscriptionPaymentReference: null,
  …25395 tokens truncated…}
    createdAssignments.push({ id: ref.id, ...assignment });
  }

  if (!replacesExerciseWindow && createdAssignments.length) {
    await writeBatchForGeneration.commit();
  }

  if (replacesExerciseWindow) {
    const replacementsByDate = new Map();
    assignments.forEach((assignment) => {
      const replacements = replacementsByDate.get(assignment.assignmentDate) ?? [];
      replacements.push(assignment);
      replacementsByDate.set(assignment.assignmentDate, replacements);
    });
    const replacementRows = await runTransaction(db, async (transaction) => {
      const safeDates = [];
      for (const assignmentDate of assignmentDates) {
        const oldIds = effectiveOverrideExerciseIdsByDate[assignmentDate] ?? [];
        const replacements = replacementsByDate.get(assignmentDate) ?? [];
        const cap = effectiveDailyExerciseCaps[assignmentDate] ?? MAX_EXERCISES_PER_DATE;
        if (replacements.length !== cap) continue;
        const currentSnapshots = await Promise.all(oldIds.map((id) => transaction.get(doc(db, 'users', student.uid, 'subjects', episode.id, 'exercises', id))));
        const currentExercises = currentSnapshots.filter((item) => item.exists()).map((item) => ({ id: item.id, ...item.data() }));
        if (currentExercises.length !== oldIds.length || currentExercises.some(isExerciseSubmitted)) continue;
        safeDates.push({ assignmentDate, currentExercises, replacements });
      }

      const rows = [];
      safeDates.forEach(({ assignmentDate, currentExercises, replacements }) => {
        const sourceGeneration = currentExercises[0];
        currentExercises.forEach((item) => transaction.delete(doc(db, 'users', student.uid, 'subjects', episode.id, 'exercises', item.id)));
        replacements.forEach((item) => {
          const ref = doc(collection(db, 'users', student.uid, 'subjects', episode.id, 'exercises'));
          const replacement = {
            ...item,
            generationMode: readyCompletedLesson ? generationMode : sourceGeneration?.generationMode || item.generationMode,
            generationBatchId: readyCompletedLesson ? generationBatchId : sourceGeneration?.generationBatchId || item.generationBatchId || generationBatchId,
            generationWeek: generationNumber,
          };
          transaction.set(ref, { ...replacement, exerciseId: ref.id, subjectInstanceId: episode.id,
            ...exerciseAccessWindow(replacement.assignmentDate), createdAt: serverTimestamp() });
          rows.push({ id: ref.id, ...replacement });
        });
        transaction.set(doc(db, 'users', student.uid, 'subjects', episode.id, 'generationRuns', assignmentDate), {
          studentId: student.uid,
          subjectInstanceId: episode.id,
          subject,
          dateKey: assignmentDate,
          targetCount: MAX_EXERCISES_PER_DATE,
          generatedAt: serverTimestamp(),
          mode: generationMode,
          lastTrigger: overrideFutureUnsubmitted ? 'manual' : readyCompletedLesson ? 'lesson' : generationMode,
          status: 'completed',
          needsMorePaperAnalysis: Boolean(localPlan.needsMorePaperAnalysis),
          topicsWithoutSources: localPlan.topicsWithoutSources,
          indexedQuestionCount: localPlan.indexedQuestionCount,
          targetQuestionCount: localPlan.targetQuestionsPerExercise,
          questionCount: replacements[0]?.questionCount ?? 0,
          questionShortageCount: localPlan.perDayTopics.find((day) => day.assignmentDate === assignmentDate)?.shortageCount ?? 0,
          generationWindowDays: assignmentDates.length,
        }, { merge: true });
      });
      return rows;
    });
    if (!replacementRows.length) {
      return { generated: false, reason: 'No replacement exercises could be built from analyzed question indexes. Existing exercises were kept. Analyze more past papers and try again.', assignments: [], criteria: { needsMorePaperAnalysis: true, topicsWithoutSources: localPlan.topicsWithoutSources } };
    }
    const shortageMessage = localPlan.totalQuestionShortage > 0
      ? ` ${localPlan.totalQuestionShortage} question slot(s) could not be filled with distinct indexed questions; upload and analyze more past papers to fill them.`
      : localPlan.topicsWithoutSources.length
        ? ` No analyzed questions were found for: ${localPlan.topicsWithoutSources.join(', ')}. Upload and analyze more past papers for those topics.`
        : '';
    return {
      generated: true,
      reason: `Regenerated ${replacementRows.length} uncompleted exercises in the ${assignmentDates.length}-day window.${shortageMessage}`,
      assignments: replacementRows,
      criteria: {
        ...studentState.generationStatus,
        ...subscriptionTrace,
        selectedPaperIds: selectedPapers.map((paper) => paper.id),
        needsMorePaperAnalysis: Boolean(localPlan.needsMorePaperAnalysis),
        topicsWithoutSources: localPlan.topicsWithoutSources,
        indexedQuestionCount: localPlan.indexedQuestionCount,
        repeatedRecentQuestionCount: localPlan.repeatedRecentQuestionCount,
        uniqueQuestionCount: localPlan.uniqueQuestionCount,
        targetQuestionsPerExercise: localPlan.targetQuestionsPerExercise,
        generatedWindowDays: assignmentDates.length,
        totalQuestionShortage: localPlan.totalQuestionShortage,
      },
    };
  }

  const shortageMessage = localPlan.totalQuestionShortage > 0
    ? ` ${localPlan.totalQuestionShortage} question slot(s) could not be filled with distinct indexed questions; upload and analyze more past papers to fill them.`
    : localPlan.topicsWithoutSources.length
      ? ` No analyzed questions were found for: ${localPlan.topicsWithoutSources.join(', ')}. Upload and analyze more past papers for those topics.`
      : '';
  return {
    generated: createdAssignments.length > 0,
    reason: `${generationMode} generation complete.${shortageMessage}`,
    assignments: createdAssignments,
    criteria: {
      ...studentState.generationStatus,
      ...subscriptionTrace,
      selectedPaperIds: selectedPapers.map((paper) => paper.id),
      topicsWithoutSources: localPlan.topicsWithoutSources,
      needsMorePaperAnalysis: Boolean(localPlan.needsMorePaperAnalysis),
      indexedQuestionCount: localPlan.indexedQuestionCount,
      repeatedRecentQuestionCount: localPlan.repeatedRecentQuestionCount,
      uniqueQuestionCount: localPlan.uniqueQuestionCount,
      targetQuestionsPerExercise: localPlan.targetQuestionsPerExercise,
      generatedWindowDays: assignmentDates.length,
      totalQuestionShortage: localPlan.totalQuestionShortage,
    },
  };
};

export const generateExercisePlanIfEligible = async (options = {}) => {
  const { student, subject = DEFAULT_SUBJECT, mode, overrideFutureUnsubmitted = false, completedLesson, onProgress } = options;
  if (overrideFutureUnsubmitted || !isFirebaseConfigured || !student?.uid) {
    return generateExercisePlanUnlocked(options);
  }

  ensureDb();
  const episode = await getActiveSubjectEpisode(student.uid, subject, student.subjectInstanceId ?? null);
  if (!episode?.id) throw new Error('Active subject episode not found.');
  const statusRef = doc(db, 'users', student.uid, 'subjects', episode.id, 'generationRuns', localDateKey());
  const startedAtMs = Date.now();
  const lastTrigger = completedLesson ? 'lesson' : mode === 'initial' ? 'initial' : 'weekly';
  const sourceLessonId = completedLesson?.id ?? null;
  const sourceLessonSignature = completedLesson ? completedLessonGenerationSignature(completedLesson) : null;
  const generationHistory = await getAssignmentHistory(student.uid, subject, GENERATION_HISTORY_LIMIT, episode.id);
  const plannedGenerationMode = getExerciseGenerationMode({
    mode,
    lessonCompleted: Boolean(completedLesson),
    history: generationHistory,
  });
  if (plannedGenerationMode === 'initial' && hasExerciseGeneration(generationHistory)) {
    return { generated: false, reason: 'Initial exercises have already been generated for this subject.', assignments: [] };
  }
  const historyWeek = getCurrentGenerationNumber(generationHistory);
  const acquiredGenerationWeek = await runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(statusRef);
    const current = snapshot.exists() ? snapshot.data() : null;
    const lockIsFresh = startedAtMs - Number(current?.startedAtMs ?? 0) < EXERCISE_REGENERATION_LOCK_TIMEOUT_MS;
    if (current?.status === 'processing' && lockIsFresh) return null;
    const currentWeek = Math.max(historyWeek, Number(current?.generationWeek) || 1);
    const generationWeek = getGenerationWeekForTrigger(currentWeek, {
      initial: plannedGenerationMode === 'initial',
      lessonCompleted: Boolean(completedLesson) && plannedGenerationMode !== 'initial',
    });
    transaction.set(statusRef, {
      studentId: student.uid,
      subjectInstanceId: episode.id,
      dateKey: localDateKey(),
      subject,
      mode: plannedGenerationMode,
      lastTrigger,
      ...(sourceLessonId ? { sourceLessonId } : {}),
      ...(sourceLessonSignature ? { sourceLessonSignature } : {}),
      generationWeek,
      status: 'processing',
      message: lastTrigger === 'lesson' ? 'Preparing exercises for the newly completed lesson.' : 'Preparing exercise generation.',
      startedAtMs,
      expiresAtMs: startedAtMs + EXERCISE_REGENERATION_LOCK_TIMEOUT_MS,
      finishedAtMs: null,
      updatedAt: serverTimestamp(),
    }, { merge: true });
    return generationWeek;
  });
  if (!acquiredGenerationWeek) return { generated: false, reason: 'Exercise generation is already running for this student and subject.', assignments: [] };

  const reportProgress = (message) => {
    onProgress?.(message);
    setDoc(statusRef, { message, updatedAt: serverTimestamp() }, { merge: true }).catch((error) => {
      console.warn('[Examifying][Firestore] generation progress update skipped:', error?.message);
    });
  };

  try {
    const result = await generateExercisePlanUnlocked({
      ...options,
      plannedGenerationWeek: acquiredGenerationWeek,
      plannedGenerationMode,
      onProgress: reportProgress,
    });
    await setDoc(statusRef, {
      status: result.generated ? 'completed' : 'failed',
      message: result.reason || (result.generated ? 'Exercise generation completed.' : 'Exercise generation did not produce assignments.'),
      ...(sourceLessonId ? { sourceLessonId } : {}),
      ...(sourceLessonSignature ? { sourceLessonSignature } : {}),
      grade: student?.grade ?? null,
      region: student?.province ?? null,
      paidSubscriptionActive: Boolean(result.criteria?.paidSubscriptionActive),
      subscriptionId: result.criteria?.subscriptionId ?? null,
      subscriptionPlanId: result.criteria?.subscriptionPlanId ?? 'free',
      subscriptionPlanName: result.criteria?.subscriptionPlanName ?? 'Free',
      subscriptionPaymentReference: result.criteria?.subscriptionPaymentReference ?? null,
      needsMorePaperAnalysis: result.criteria?.needsMorePaperAnalysis === true,
      topicsWithoutSources: result.criteria?.topicsWithoutSources ?? [],
      indexedQuestionCount: result.criteria?.indexedQuestionCount ?? null,
      targetQuestionCount: result.criteria?.targetQuestionsPerExercise ?? null,
      questionShortageCount: result.criteria?.totalQuestionShortage ?? 0,
      generationWindowDays: result.criteria?.generatedWindowDays ?? null,
      generationRunId: result.generated ? `${student.uid}-${startedAtMs}` : null,
      generatedExerciseIds: result.generated
        ? (result.assignments ?? []).map((assignment) => assignment.id).filter(Boolean)
        : [],
      finishedAtMs: Date.now(),
      expiresAtMs: Date.now(),
      updatedAt: serverTimestamp(),
    }, { merge: true });
    return result;
  } catch (error) {
    await setDoc(statusRef, {
      status: 'failed',
      message: error.message || 'Exercise generation failed.',
      finishedAtMs: Date.now(),
      expiresAtMs: Date.now(),
      updatedAt: serverTimestamp(),
    }, { merge: true });
    throw error;
  }
};

const getLocalDate = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
};

export const regenerateFutureUnsubmittedExercisesForTutor = async ({ tutorId, student, subject = DEFAULT_SUBJECT, onProgress }) => {
  if (!tutorId || !student?.uid) throw new Error('Tutor and student are required to regenerate exercises.');
  const assignedContext = await requireCoOwnerAccess({ tutorId, studentId: student.uid, subject });

  if (!isFirebaseConfigured) {
    return generateExercisePlanIfEligible({ student, subject, mode: 'weekly', overrideFutureUnsubmitted: true, onProgress });
  }

  ensureDb();
  const subjectInstanceId = assignedContext.subjectInstanceId;
  if (!subjectInstanceId) throw new Error('The active subject assignment could not be found. Reload the student and try again.');
  const dateKey = localDateKey();
  const statusRef = doc(db, 'users', student.uid, 'subjects', subjectInstanceId, 'generationRuns', dateKey);
  const startedAtMs = Date.now();
  const acquired = await runTransaction(db, async (transaction) => {
    const currentStatus = await transaction.get(statusRef);
    const currentData = currentStatus.exists() ? currentStatus.data() : null;
    const lockIsFresh = startedAtMs - Number(currentData?.startedAtMs ?? 0) < EXERCISE_REGENERATION_LOCK_TIMEOUT_MS;
    if (currentData?.status === 'processing' && lockIsFresh) return false;
    transaction.set(statusRef, {
      studentId: student.uid,
      tutorId,
      subjectInstanceId,
      subject,
      dateKey,
      status: 'processing',
      message: 'Preparing analyzed paper metadata for exercise regeneration.',
      startedAtMs,
      expiresAtMs: startedAtMs + EXERCISE_REGENERATION_LOCK_TIMEOUT_MS,
      finishedAtMs: null,
      updatedAt: serverTimestamp(),
    }, { merge: true });
    return true;
  });
  if (!acquired) return { generated: false, reason: 'Exercise regeneration is already in progress for this student and subject.', assignments: [] };

  const saveStatus = (status, message, result = null) => setDoc(statusRef, {
    studentId: student.uid,
    tutorId,
    subjectInstanceId,
    subject,
    dateKey,
    mode: 'weekly',
    lastTrigger: 'manual',
    grade: student?.grade ?? null,
    region: student?.province ?? null,
    status,
    message,
    updatedAt: serverTimestamp(),
    ...(result ? {
      needsMorePaperAnalysis: result.criteria?.needsMorePaperAnalysis === true,
      topicsWithoutSources: result.criteria?.topicsWithoutSources ?? [],
      indexedQuestionCount: result.criteria?.indexedQuestionCount ?? null,
      targetQuestionCount: result.criteria?.targetQuestionsPerExercise ?? null,
      questionShortageCount: result.criteria?.totalQuestionShortage ?? 0,
      generationWindowDays: result.criteria?.generatedWindowDays ?? null,
    } : {}),
    ...(status === 'completed' ? {
      generationRunId: `manual-${student.uid}-${startedAtMs}`,
      generatedExerciseIds: (result?.assignments ?? []).map((assignment) => assignment.id).filter(Boolean),
    } : {}),
    ...(status === 'processing' ? { finishedAtMs: null } : { finishedAtMs: Date.now() }),
  }, { merge: true });

  try {
    const result = await generateExercisePlanIfEligible({
      student: { ...assignedContext, ...student, uid: student.uid },
      subject,
      mode: 'weekly',
      overrideFutureUnsubmitted: true,
      onProgress: async (message) => {
        onProgress?.(message);
        await saveStatus('processing', message);
      },
    });
    const status = result.generated ? 'completed' : 'failed';
    await saveStatus(status, result.reason || (result.generated ? 'Exercises regenerated.' : 'No exercises were regenerated.'), result);
    return result;
  } catch (error) {
    await saveStatus('failed', error.message || 'Exercise regeneration failed.');
    throw error;
  }
};

export const subscribeToExerciseGenerationStatus = (studentId, subject, callback, subjectInstanceId = null) => {
  if (!studentId || !subject || !isFirebaseConfigured) return () => {};
  ensureDb();
  let cancelled = false;
  let unsubscribe = () => {};
  const episodePromise = subjectInstanceId
    ? Promise.resolve({ id: subjectInstanceId })
    : getActiveSubjectEpisode(studentId, subject);
  episodePromise.then((episode) => {
    if (cancelled) return;
    if (!episode?.id) {
      callback(null);
      return;
    }
    const statusRef = doc(db, 'users', studentId, 'subjects', episode.id, 'generationRuns', localDateKey());
    unsubscribe = onSnapshot(
      statusRef,
      (snapshot) => callback(snapshot.exists() ? snapshot.data() : null),
      (error) => console.error('[Examifying][Firestore] exercise generation status subscription failed', error),
    );
  }).catch((error) => {
    if (!cancelled) console.error('[Examifying][Firestore] exercise generation status subscription failed', error);
  });
  return () => {
    cancelled = true;
    unsubscribe();
  };
};

export const subscribeToSubjectUnderstandingSummary = (studentId, subject, callback) => {
  if (!studentId || !subject) return () => {};
  if (!isFirebaseConfigured) {
    const completedLessons = mockCompletedLessons.filter((lesson) => lesson.studentId === studentId
      && (lesson.subject ?? DEFAULT_SUBJECT) === subject);
    callback(buildSubjectUnderstandingSummary(subject, getTopicSummary(completedLessons)));
    return () => {};
  }

  let cancelled = false;
  let unsubscribeTopics = null;
  const reportError = (error) => {
    if (!cancelled) callback(null, error);
  };
  getActiveSubjectEpisode(studentId, subject).then((episode) => {
    if (cancelled) return;
    if (!episode?.id) {
      callback(buildSubjectUnderstandingSummary(subject));
      return;
    }
    try {
      unsubscribeTopics = onSnapshot(collection(db, 'users', studentId, 'subjects', episode.id, 'topics'), (snapshot) => {
        const topicSummaries = getTopicSummariesFromDocuments(snapshot.docs.map((item) => ({ id: item.id, ...item.data() })));
        callback(buildSubjectUnderstandingSummary(subject, topicSummaries));
      }, reportError);
    } catch (error) {
      reportError(error);
    }
  }).catch(reportError);
  return () => {
    cancelled = true;
    unsubscribeTopics?.();
  };
};

export const subscribeToAssignedStudentsForTutor = (tutorId, callback, subject = DEFAULT_SUBJECT, onError = () => {}) => {
  if (!isFirebaseConfigured) {
    getAssignedStudentsForTutor(tutorId, subject).then(callback).catch(onError);
    return () => {};
  }
  const refresh = () => getAssignedStudentsForTutor(tutorId, subject).then(callback).catch(onError);
  const subjectsUnsubscribe = onSnapshot(query(
      collectionGroup(db, 'subjects'),
      where('activeStaffIds', 'array-contains', tutorId),
      where('status', '==', 'active'),
    ), refresh, onError);
  return () => {
    subjectsUnsubscribe();
  };
};

export const subscribeToUnassignedStudents = (callback, subject = DEFAULT_SUBJECT) => {
  if (!isFirebaseConfigured) { getUnassignedStudents(subject).then(callback); return () => {}; }
  const subjectsQuery = query(collectionGroup(db, 'subjects'), where('subjectKey', '==', subject), where('status', '==', 'active'));
  return onSnapshot(subjectsQuery, () => getUnassignedStudents(subject).then(callback));
};

export const getAssignedSubjectsForStudent = async (studentId) => {
  if (!studentId) return [];
  if (!isFirebaseConfigured) return [];
  const snapshot = await getDocs(query(collection(db, 'users', studentId, 'subjects'), where('status', '==', 'active')));
  return snapshot.docs.filter((item) => Boolean(item.data().primaryTutorId)).map((item) => item.data().subjectKey);
};

export const getActiveSubjectEpisodesForStudent = async (studentId) => {
  if (!studentId) return [];
  if (!isFirebaseConfigured) {
    const student = demoUsers.find((user) => user.uid === studentId);
    return getUserSubjects(student).map((subjectKey, index) => ({
      id: `demo-subject-${index}`,
      studentId,
      subjectKey,
      status: 'active',
    }));
  }
  const snapshot = await getDocs(query(
    collection(db, 'users', studentId, 'subjects'),
    where('status', '==', 'active'),
  ));
  return snapshot.docs.map((item) => ({ id: item.id, studentId, ...item.data() }));
};

export const getActiveSubjectsForStudent = async (studentId) => {
  const episodes = await getActiveSubjectEpisodesForStudent(studentId);
  return [...new Set(episodes.map((item) => item.subjectKey).filter(Boolean))].sort();
};

export const getTutorAssignedStudentContexts = async (tutorId, studentId = null) => {
  if (!tutorId) return [];
  if (!isFirebaseConfigured) return mockStudentAssignments
    .filter((item) => item.tutorId === tutorId && (!studentId || item.studentId === studentId))
    .map((item) => ({ ...item, subject: item.subject ?? DEFAULT_SUBJECT }));
  let candidateSnapshots;
  if (studentId) {
    const studentSubjects = collection(db, 'users', studentId, 'subjects');
    const [staffSnapshot, primaryTutorSnapshot] = await Promise.all([
      getDocs(query(studentSubjects, where('activeStaffIds', 'array-contains', tutorId))),
      getDocs(query(studentSubjects, where('primaryTutorId', '==', tutorId))),
    ]);
    candidateSnapshots = [...staffSnapshot.docs, ...primaryTutorSnapshot.docs];
  } else {
    const [staffSnapshot, primaryTutorSnapshot] = await Promise.all([
      getDocs(query(collectionGroup(db, 'subjects'), where('activeStaffIds', 'array-contains', tutorId), where('status', '==', 'active'))),
      getDocs(query(collectionGroup(db, 'subjects'), where('primaryTutorId', '==', tutorId))),
    ]);
    candidateSnapshots = [...staffSnapshot.docs, ...primaryTutorSnapshot.docs];
  }
  const episodes = new Map();
  candidateSnapshots
    .filter((item) => item.data().status === 'active')
    .forEach((item) => episodes.set(item.ref.path, item));
  const rows = [...episodes.values()].map((item) => {
    const episode = item.data();
    const isPrimaryTutor = episode.primaryTutorId === tutorId;
    return {
      studentId: episode.studentId, subject: episode.subjectKey, subjectInstanceId: item.id,
      assignmentId: item.id, assignmentPeriodId: item.id,
      accessRole: isPrimaryTutor ? 'co-owner' : episode.staffByUid?.[tutorId] ?? 'viewer',
      isPrimaryTutor,
      activeSubjectPlanId: episode.lessonQuota?.planId || episode.planId || episode.subscriptionPlanId || null,
      activeSubjectRenewalDate: episode.lessonQuota?.renewalDate || episode.renewalDate || episode.subscriptionRenewalDate || null,
      activeSubjectWindowStartAt: episode.lessonQuota?.windowStartAt || episode.entitlementWindowStartAt || episode.subscriptionStartAt || null,
      lessonQuota: episode.lessonQuota ?? null,
    };
  });
  const studentIds = [...new Set(rows.map((row) => row.studentId).filter(Boolean))];
  const students = await Promise.all(studentIds.map((id) => getDoc(doc(db, collections.users, id))));
  const profilesByStudentId = new Map(studentIds.map((id, index) => [id, students[index].exists() ? students[index].data() : {}]));
  return rows.map((row) => ({ ...(profilesByStudentId.get(row.studentId) ?? {}), ...row, uid: row.studentId }));
};

export const getTutorAssignmentHistoryContexts = async (tutorId, studentId = null) => {
  if (!tutorId || !isFirebaseConfigured) return [];
  const snapshot = studentId
    ? await getDocs(query(collection(db, 'users', studentId, 'subjects'), where('historicalStaffIds', 'array-contains', tutorId)))
    : await getDocs(query(collectionGroup(db, 'subjects'), where('historicalStaffIds', 'array-contains', tutorId)));
  const rows = snapshot.docs.flatMap((episode) => (episode.data().staffMemberships ?? [])
    .filter((entry) => entry.uid === tutorId && entry.endedAt && (!studentId || episode.data().studentId === studentId)
      && (!studentId || episode.data().historicalStaffIds?.includes(tutorId)))
    .map((entry, index) => ({
      studentId: episode.data().studentId, uid: episode.data().studentId, subject: episode.data().subjectKey,
      subjectInstanceId: episode.id, assignmentId: episode.id, assignmentPeriodId: `${episode.id}:${index}`,
      accessRole: entry.role, isPrimaryTutor: entry.role === 'co-owner' && episode.data().primaryTutorId === tutorId,
      assignmentStartedAt: entry.grantedAt, assignmentEndedAt: entry.endedAt, assignmentEndReason: episode.data().endReason ?? 'access_ended',
    })));
  const studentIds = [...new Set(rows.map((row) => row.studentId).filter(Boolean))];
  const profiles = await Promise.all(studentIds.map((id) => getDoc(doc(db, collections.users, id))));
  const profilesByStudentId = new Map(studentIds.map((id, index) => [id, profiles[index].exists() ? profiles[index].data() : {}]));
  return rows.map((row) => ({ ...(profilesByStudentId.get(row.studentId) ?? {}), ...row }));
};

export const getTutorAssignmentHistoryData = async ({ tutorId, studentId, periodId, historyContexts = null }) => {
  const period = (historyContexts ?? await getTutorAssignmentHistoryContexts(tutorId, studentId))
    .find((item) => item.assignmentPeriodId === periodId);
  if (!period) throw new Error('Assignment history is not available.');
  const base = doc(db, 'users', studentId, 'subjects', period.subjectInstanceId);
  const [exercises, reports, lessons] = await Promise.all([
    getDocs(collection(base, 'exercises')), getDocs(collection(base, 'reports')), getDocs(collection(base, 'lessons')),
  ]);
  const map = (snapshot) => snapshot.docs.map((item) => ({ id: item.id, ...item.data(), studentId, subjectInstanceId: period.subjectInstanceId, documentPath: item.ref.path }));
  const reportRows = map(reports).filter((report) => report.reportType !== 'initial');
  return { period, exercises: map(exercises), reports: reportRows, lessons: await hydrateEpisodeLessonScores(map(lessons), studentId, period.subjectInstanceId), peerMarkedWork: [] };
};

export const getStaffMembersForAccess = async ({ tutorId, subject = DEFAULT_SUBJECT }) => {
  if (!tutorId) return [];
  if (!isFirebaseConfigured) return getApprovedTutorOrTeacherProfiles(demoUsers, subject).filter((user) => user.uid !== tutorId);
  const snapshot = await getDocs(collection(db, collections.users));
  return getApprovedTutorOrTeacherProfiles(snapshot.docs.map((item) => item.data()), subject).filter((user) => user.uid !== tutorId);
};

export const setStaffStudentAccess = async ({ actorId, studentId, tutorId, subject = DEFAULT_SUBJECT, accessRole }) => {
  if (!STAFF_ACCESS_ROLES.includes(accessRole)) throw new Error('Choose co-owner, marker, or viewer access.');
  await requireCoOwnerAccess({ tutorId: actorId, studentId, subject });
  const callable = httpsCallable(functions, 'manageStaffStudentAccess');
  return (await callable({ action: 'grant', studentId, tutorId, subject, accessRole })).data;
};

export const getStaffStudentAccess = async ({ studentId, subject = DEFAULT_SUBJECT, tutorId, subjectInstanceId }) => {
  if (!isFirebaseConfigured) return [];
  const episodeSnapshot = subjectInstanceId
    ? await getDoc(doc(db, 'users', studentId, 'subjects', subjectInstanceId))
    : null;
  const episode = episodeSnapshot
    ? (episodeSnapshot.exists() ? { id: episodeSnapshot.id, ...episodeSnapshot.data() } : null)
    : await getActiveSubjectEpisode(studentId, subject);
  if (!episode) return [];
  const records = Object.entries(episode.staffByUid ?? {}).filter(([uid]) => uid !== episode.primaryTutorId);
  const people = await Promise.all(records.map(([uid]) => getDoc(doc(db, collections.users, uid))));
  return records.map(([uid, accessRole], index) => ({ id: uid, tutorId: uid, accessRole, studentId, subject,
    displayName: people[index].exists() ? people[index].data().displayName || people[index].data().email : uid, isCurrentUser: uid === tutorId }));
};

export const revokeStaffStudentAccess = async ({ actorId, studentId, subject = DEFAULT_SUBJECT, accessId }) => {
  await requireCoOwnerAccess({ tutorId: actorId, studentId, subject });
  const callable = httpsCallable(functions, 'manageStaffStudentAccess');
  await callable({ action: 'revoke', studentId, tutorId: accessId, subject });
};

export const getTutorReportsForAssignedStudents = async (tutorId, knownContexts = null) => {
  const contexts = knownContexts ?? await getTutorAssignedStudentContexts(tutorId);
  const rows = isFirebaseConfigured
    ? await Promise.all(contexts.map(async (context) => {
      if (!context.subjectInstanceId) return [];
      const snapshot = await getDocs(query(
        collection(db, 'users', context.studentId, 'subjects', context.subjectInstanceId, 'reports'),
        orderBy('updatedAt', 'desc'),
      ));
      return snapshot.docs.map((item) => ({ id: item.id, ...item.data(), subjectInstanceId: context.subjectInstanceId }))
        .filter((report) => report.reportType !== 'initial');
    }))
    : await Promise.all(contexts.map((context) => getTutorReports(context.studentId, context.subject)));
  return rows.flat().sort((left, right) => new Date(right.updatedAt?.toDate?.() ?? 0) - new Date(left.updatedAt?.toDate?.() ?? 0));
};

export const getTutorExercisesForAssignedStudents = async (tutorId, knownContexts = null) => {
  const contexts = knownContexts ?? await getTutorAssignedStudentContexts(tutorId);
  const snapshots = await Promise.all(contexts.map((context) => getDocs(query(
    collection(db, 'users', context.studentId, 'subjects', context.subjectInstanceId, 'exercises'), orderBy('assignmentDate', 'desc'), limit(40)))));
  return snapshots.flatMap((snapshot, index) => snapshot.docs.map((item) => ({ id: item.id, ...item.data(),
    documentPath: item.ref.path, subjectInstanceId: contexts[index].subjectInstanceId,
    studentName: contexts[index].displayName || 'Student' }))).sort((a, b) => String(b.assignmentDate).localeCompare(String(a.assignmentDate)));
};

export const getTutorLessonsForAssignedStudents = async (tutorId, knownContexts = null) => {
  const contexts = knownContexts ?? await getTutorAssignedStudentContexts(tutorId);
  const snapshots = await Promise.all(contexts.map((context) => getDocs(collection(db, 'users', context.studentId, 'subjects', context.subjectInstanceId, 'lessons'))));
  const lessonsByContext = await Promise.all(snapshots.map((snapshot, index) => hydrateEpisodeLessonScores(
    snapshot.docs.map((item) => ({ id: item.id, ...item.data(),
      studentId: contexts[index].studentId, subjectInstanceId: contexts[index].subjectInstanceId,
      studentName: contexts[index].displayName || contexts[index].name || contexts[index].email || 'Student', documentPath: item.ref.path })),
    contexts[index].studentId,
    contexts[index].subjectInstanceId,
  )));
  return lessonsByContext.flat();
};

export const getTutorLessonRowsForAssignedStudents = async (tutorId, knownContexts = null) => {
  const contexts = knownContexts ?? await getTutorAssignedStudentContexts(tutorId);
  if (!isFirebaseConfigured) return contexts.flatMap((context) => mockCompletedLessons
    .filter((lesson) => lesson.studentId === context.studentId && (lesson.subject ?? DEFAULT_SUBJECT) === context.subject)
    .map((lesson) => ({
      ...lesson,
      subjectInstanceId: context.subjectInstanceId,
      studentName: context.displayName || context.name || context.email || 'Student',
    })));
  const snapshots = await Promise.all(contexts.filter((context) => context.subjectInstanceId).map((context) => getDocs(
    collection(db, 'users', context.studentId, 'subjects', context.subjectInstanceId, 'lessons'),
  )));
  const validContexts = contexts.filter((context) => context.subjectInstanceId);
  return snapshots.flatMap((snapshot, index) => snapshot.docs.map((item) => ({
    id: item.id,
    ...item.data(),
    studentId: validContexts[index].studentId,
    subjectInstanceId: validContexts[index].subjectInstanceId,
    studentName: validContexts[index].displayName || validContexts[index].name || validContexts[index].email || 'Student',
    documentPath: item.ref.path,
  })));
};

export const getTutorLessonPresenceForContexts = async (contexts = []) => {
  if (!isFirebaseConfigured) {
    return contexts.filter((context) => mockCompletedLessons.some((lesson) => lesson.studentId === context.studentId
      && (lesson.subject ?? DEFAULT_SUBJECT) === context.subject));
  }
  const results = await Promise.all(contexts.filter((context) => context.subjectInstanceId).map(async (context) => {
    const snapshot = await getDocs(query(
      collection(db, 'users', context.studentId, 'subjects', context.subjectInstanceId, 'lessons'),
      limit(1),
    ));
    const matchingLesson = snapshot.docs.some((item) => (item.data().subject ?? DEFAULT_SUBJECT) === context.subject);
    return matchingLesson ? { studentId: context.studentId, subject: context.subject } : null;
  }));
  return results.filter(Boolean);
};

export const getLessonsForStudent = async (studentId) => {
  if (!studentId || !isFirebaseConfigured) return [];
  const episodes = await getDocs(query(collection(db, 'users', studentId, 'subjects'), where('status', '==', 'active')));
  const snapshots = await Promise.all(episodes.docs.map((episode) => getDocs(collection(episode.ref, 'lessons'))));
  const lessonsByEpisode = await Promise.all(snapshots.map((snapshot, index) => hydrateEpisodeLessonScores(
    snapshot.docs.map((item) => ({ id: item.id, ...item.data(),
      studentId, subjectInstanceId: episodes.docs[index].id, documentPath: item.ref.path })),
    studentId,
    episodes.docs[index].id,
  )));
  return lessonsByEpisode.flat();
};

export const getLessonById = async (lessonId, { studentId, subjectInstanceId, tutorId, periodId } = {}) => {
  if (!lessonId) return null;
  if (!isFirebaseConfigured) return mockCompletedLessons.find((lesson) => lesson.id === lessonId) ?? null;
  ensureDb();
  const readEpisodeLesson = async (targetStudentId, targetSubjectInstanceId) => {
    if (!targetStudentId || !targetSubjectInstanceId) return null;
    const lessonRef = doc(db, 'users', targetStudentId, 'subjects', targetSubjectInstanceId, 'lessons', lessonId);
    const snapshot = await getDoc(lessonRef);
    if (!snapshot.exists()) return null;
    const lesson = { id: snapshot.id, ...snapshot.data(), studentId: targetStudentId,
      subjectInstanceId: targetSubjectInstanceId, documentPath: lessonRef.path };
    return (await hydrateEpisodeLessonScores([lesson], targetStudentId, targetSubjectInstanceId))[0];
  };
  if (studentId && subjectInstanceId) return readEpisodeLesson(studentId, subjectInstanceId);
  if (tutorId && periodId && studentId) {
    const period = (await getTutorAssignmentHistoryContexts(tutorId, studentId))
      .find((item) => item.assignmentPeriodId === periodId);
    return period ? readEpisodeLesson(studentId, period.subjectInstanceId) : null;
  }
  if (tutorId) {
    const contexts = await getTutorAssignedStudentContexts(tutorId);
    const scopedContexts = studentId ? contexts.filter((item) => item.studentId === studentId) : contexts;
    for (const context of scopedContexts) {
      const lesson = await readEpisodeLesson(context.studentId, context.subjectInstanceId);
      if (lesson) return { ...lesson, studentName: context.displayName || context.name || context.email || 'Student' };
    }
    return null;
  }
  if (studentId) {
    const episodes = await getDocs(query(collection(db, 'users', studentId, 'subjects'), where('status', '==', 'active')));
    for (const episode of episodes.docs) {
      const lesson = await readEpisodeLesson(studentId, episode.id);
      if (lesson) return lesson;
    }
    return null;
  }
  const snapshot = await getDocs(query(collectionGroup(db, 'lessons'), where('lessonId', '==', lessonId), limit(1)));
  if (!snapshot.empty) return { id: snapshot.docs[0].id, ...snapshot.docs[0].data(), documentPath: snapshot.docs[0].ref.path };
  const all = await getDocs(collectionGroup(db, 'lessons'));
  const lesson = all.docs.find((item) => item.id === lessonId);
  return lesson ? { id: lesson.id, ...lesson.data(), documentPath: lesson.ref.path } : null;
};

export const updateCompletedLesson = async ({ lessonId, tutorId, topicReport = '', topicUnderstandingScores = [], topics = [], understandingLevel = null, lessonDate, lessonType, whatsappLessonLink, locationDetails, status }) => {
  const lesson = await getLessonById(lessonId, { tutorId });
  if (!lesson) throw new Error('Lesson not found.');
  await requireCoOwnerAccess({ tutorId, studentId: lesson.studentId, subject: lesson.subject });
  const lessonTopics = topics.length ? topics : (lesson.topics ?? [lesson.topic]).filter(Boolean);
  const scores = buildLessonTopicScores({
    topics: lessonTopics,
    topicUnderstandingScores,
    understandingLevel,
    completed: status === 'completed',
  });
  const payload = { topicReport, note: topicReport,
    topicUnderstandingScores: status === 'completed' ? scores : status === 'missed' ? [] : topicUnderstandingScores,
    topics: lessonTopics, topic: lessonTopics[0] ?? '', understandingLevel: status === 'missed' ? null : status === 'completed' ? meanUnderstandingScore(scores) : understandingLevel,
    ...(lessonDate ? { lessonDate } : {}), ...(lessonType ? { lessonType } : {}),
    ...(whatsappLessonLink !== undefined ? { whatsappLessonLink: normalizeWhatsAppLessonLink(whatsappLessonLink) } : {}),
    ...(locationDetails !== undefined ? { locationDetails: String(locationDetails || '').trim() } : {}),
    ...(status ? { status } : {}),
    ...(status === 'completed' ? { completedOn: lessonDate || localDateKey(), attendanceStatus: 'attended', attended: true }
      : status === 'missed' ? { completedOn: '', attendanceStatus: 'missed', attended: false } : {}),
    updatedAt: serverTimestamp() };
  if (!isFirebaseConfigured) {
    const updated = { id: lessonId, ...lesson, ...payload };
    upsertMockLessonRows([updated]);
    return updated;
  }
  await persistLessonOutcome({
    lessonRef: doc(db, lesson.documentPath),
    lessonData: payload,
    studentId: lesson.studentId,
    subjectInstanceId: lesson.subjectInstanceId,
    tutorId,
    topicScores: scores,
    tutorReport: topicReport,
  });
  return { id: lessonId, ...lesson, ...payload };
};

export const deleteLesson = async (lessonId, tutorId) => {
  const lesson = await getLessonById(lessonId, { tutorId });
  if (!lesson) throw new Error('Lesson not found.');
  await requireCoOwnerAccess({ tutorId, studentId: lesson.studentId, subject: lesson.subject });
  if (!isFirebaseConfigured) {
    removeMockLessonRows([lessonId]);
    return { id: lessonId, deleted: true };
  }
  if (!functions) throw new Error('Firebase Functions are not configured to update lesson quota.');
  const mutateLesson = httpsCallable(functions, 'mutatePlannedLessonSession');
  const result = await mutateLesson({ action: 'cancel', lessonRows: [lesson] });
  return { id: lessonId, ...result.data };
};

export const subscribeToAssignedTutorForStudent = (studentId, callback, subject = DEFAULT_SUBJECT) => {
  if (!studentId || !isFirebaseConfigured) { callback(null); return () => {}; }
  const q = query(collection(db, 'users', studentId, 'subjects'), where('subjectKey', '==', subject), where('status', '==', 'active'), limit(1));
  return onSnapshot(q, async (snapshot) => {
    const tutorId = snapshot.docs[0]?.data().primaryTutorId;
    if (!tutorId) { callback(null); return; }
    const tutor = await getDoc(doc(db, collections.users, tutorId)); callback(tutor.exists() ? tutor.data() : null);
  });
};

export const subscribeToUserProfile = (uid, callback) => {
  if (!isFirebaseConfigured) {
    const mockUser = Object.values(mockUsers).find((u) => u.uid === uid);
    callback(mockUser || null);
    return () => {};
  }
  return onSnapshot(doc(db, collections.users, uid), (snapshot) => {
    callback(snapshot.exists() ? snapshot.data() : null);
  }, (error) => console.error('[Examifying][Firestore] subscribeToUserProfile error', error));
};


export const saveGuideQuizResult = async ({ userId, role, userName, answers, score, totalQuestions, percentage }) => {
  const payload = {
    userId,
    role,
    userName,
    answers,
    score,
    totalQuestions,
    percentage,
    submittedAt: new Date().toISOString(),
  };

  if (!isFirebaseConfigured) {
    const result = { id: `mock-guide-result-${Date.now()}`, ...payload };
    demoGuideQuizResults.push(result);
    return result;
  }

  ensureDb();
  const ref = await addDoc(collection(db, 'users', userId, 'guideQuizResults'), {
    ...payload,
    submittedAt: serverTimestamp(),
    createdAt: serverTimestamp(),
  });
  return { id: ref.id, ...payload };
};

export const getLatestGuideQuizResult = async ({ userId, role }) => {
  if (!userId) return null;

  if (!isFirebaseConfigured) {
    return [...demoGuideQuizResults]
      .filter((item) => item.userId === userId && (!role || item.role === role))
      .sort((left, right) => new Date(right.submittedAt ?? 0) - new Date(left.submittedAt ?? 0))[0] ?? null;
  }

  ensureDb();
  const q = query(
    collection(db, 'users', userId, 'guideQuizResults'),
    where('userId', '==', userId),
    ...(role ? [where('role', '==', role)] : []),
    orderBy('submittedAt', 'desc'),
    limit(1),
  );
  const snapshot = await getDocs(q);
  return snapshot.docs[0] ? { id: snapshot.docs[0].id, ...snapshot.docs[0].data() } : null;
};

export const getGuideQuizResultsSummary = async () => {
  if (!isFirebaseConfigured) {
    const users = demoUsers.filter((user) => user.role === 'student' || user.role === 'tutor' || isTeacherProfile(user));
    return {
      students: users
        .filter((user) => user.role === 'student')
        .map((user) => {
          const latest = [...demoGuideQuizResults]
            .filter((item) => item.userId === user.uid && item.role === 'student')
            .sort((left, right) => new Date(right.submittedAt ?? 0) - new Date(left.submittedAt ?? 0))[0] ?? null;
          return {
            id: user.uid,
            name: user.displayName || user.email || 'Student',
            percentage: latest?.percentage ?? null,
            subjects: getUserSubjects(user),
            subscriptionPlanName: user.subscriptionPlanName || getEffectiveSubscriptionState({
              subscription: {
                planId: user.subscriptionPlanId,
                status: user.subscriptionStatus,
                renewalDate: user.subscriptionRenewalDate,
                graceEndsAt: user.graceEndsAt,
                subjectCount: user.subscriptionSubjectCount,
              },
            }).subscriptionPlanName,
          };
        }),
      tutors: users
        .filter((user) => user.role === 'tutor' || isTeacherProfile(user))
        .map((user) => {
          const latest = [...demoGuideQuizResults]
            .filter((item) => item.userId === user.uid && item.role === 'tutor')
            .sort((left, right) => new Date(right.submittedAt ?? 0) - new Date(left.submittedAt ?? 0))[0] ?? null;
          return {
            id: user.uid,
            name: user.displayName || user.email || 'Tutor',
            percentage: latest?.percentage ?? null,
            subjects: getApprovedTutorSubjects(user),
            studentCount: new Set(mockStudentAssignments
              .filter((assignment) => assignment.active !== false && assignment.tutorId === user.uid)
              .map((assignment) => assignment.studentId)).size,
          };
        }),
    };
  }

  return getAdminWorkspaceData('guide-results');
};

export const assignStudentToParent = async ({ parentId, studentIdentifier }) => {
  if (!isFirebaseConfigured) {
    return { success: true, studentId: 'demo-student', parentId };
  }
  ensureDb();
  
  const callable = httpsCallable(functions, 'assignStudentToParent');
  return (await callable({ studentIdentifier })).data;
};

export const getStudentsForParent = async (parentId) => {
  if (!isFirebaseConfigured) {
    return []; // Empty for demo initially unless pushed to a mock array
  }
  ensureDb();
  const q = query(collection(db, collections.users), where('parentId', '==', parentId), where('role', '==', 'student'));
  const snapshot = await getDocs(q);
  return snapshot.docs.map(docSnap => docSnap.data());
};

export const updateStudentProfileByParent = async ({ parentId, studentId, updates }) => {
  if (!isFirebaseConfigured) {
    return { success: true, studentId, ...updates };
  }
  ensureDb();

  const studentRef = doc(db, collections.users, studentId);
  const snapshot = await getDoc(studentRef);
  
  if (!snapshot.exists()) {
    throw new Error('Student not found');
  }

  const studentData = snapshot.data();
  if (studentData.parentId !== parentId) {
    throw new Error('Unauthorized: You are not assigned to this student.');
  }

  const payload = {
    ...updates,
    updatedAt: serverTimestamp()
  };

  // Convert previousYearMark back to number if provided
  if (payload.previousYearMark !== undefined) {
    payload.previousYearMark = Number(payload.previousYearMark);
  }

  await updateDoc(studentRef, payload);
  return { success: true, studentId, ...payload };
};


export const getStudentSubjectHistoryOptions = async ({ studentId, grade }) => {
  if (!studentId || !grade) throw new Error('Choose the student and grade to check for recent subject history.');
  if (!isFirebaseConfigured) return { studentId, grade, subjectCapacity: 0, candidates: [] };
  ensureDb();
  const callable = httpsCallable(functions, 'getStudentSubjectHistoryOptions');
  return (await callable({ studentId, grade })).data;
};

export const addStudentSubjects = async ({ studentId, subjects, restoreSubjectInstanceIds = [] }) => {
  const cleanSubjects = [...new Set((subjects ?? []).filter(Boolean))];
  if (!cleanSubjects.length) throw new Error('Choose at least one subject to add.');

  if (!isFirebaseConfigured) {
    return { studentId, subjects: cleanSubjects };
  }

  ensureDb();
  const callable = httpsCallable(functions, 'updateStudentSubjects');
  return (await callable({ studentId, action: 'add', subjects: cleanSubjects, restoreSubjectInstanceIds })).data;
};

export const addStudentSubject = async ({ studentId, subject }) => addStudentSubjects({ studentId, subjects: [subject] });



export const removeUserSubject = async ({ uid, subject }) => {
  if (!subject) throw new Error('Choose a subject to remove.');

  if (!isFirebaseConfigured) {
    return { uid, subject };
  }

  ensureDb();
  const callable = httpsCallable(functions, 'updateStudentSubjects');
  return (await callable({ studentId: uid, action: 'remove', subject })).data;
};



export const updateUserSubjectAvailability = async ({ uid, subject, available }) => {
  if (!subject) throw new Error('Choose a subject to update.');

  if (!isFirebaseConfigured) {
    return { uid, subject, available };
  }

  ensureDb();
  const userRef = doc(db, collections.users, uid);
  const snapshot = await getDoc(userRef);
  const profile = snapshot.exists() ? snapshot.data() : {};
  const subjectAvailability = {
    ...(profile.subjectAvailability ?? {}),
    [subject]: Boolean(available),
  };

  await updateDoc(userRef, {
    subjectAvailability,
    updatedAt: serverTimestamp(),
  });

  return { uid, subject, available };
};

export const getTutorBillingSummary = async (tutorId) => {
  if (!isFirebaseConfigured) {
    const lessons = mockCompletedLessons.filter((lesson) => lesson.tutorId === tutorId);
    return {
      totalLessons: lessons.length,
      studentsTutored: new Set(lessons.map((lesson) => lesson.studentId)).size,
      subjectsTutored: [...new Set(lessons.map((lesson) => lesson.subject ?? DEFAULT_SUBJECT))],
      recentLessons: lessons.slice(0, 10),
    };
  }

  const lessons = await getTutorLessonsForAssignedStudents(tutorId);
  return {
    totalLessons: lessons.length,
    studentsTutored: new Set(lessons.map((lesson) => lesson.studentId).filter(Boolean)).size,
    subjectsTutored: [...new Set(lessons.map((lesson) => lesson.subject ?? DEFAULT_SUBJECT).filter(Boolean))],
    recentLessons: lessons
      .sort((left, right) => String(right.completedOn ?? '').localeCompare(String(left.completedOn ?? '')))
      .slice(0, 10),
  };
};

export const updateUserSettings = async ({ uid, settings, marketingEmailOptIn }) => {
  if (!isFirebaseConfigured) return { uid, settings, marketingEmailOptIn };

  ensureDb();
  const payload = {
    'settings.notificationPreferences': settings.notificationPreferences,
    updatedAt: serverTimestamp(),
  };
  if (typeof marketingEmailOptIn === 'boolean') payload.marketingEmailOptIn = marketingEmailOptIn;
  await updateDoc(doc(db, collections.users, uid), payload);
  return { uid, settings, marketingEmailOptIn };
};

export const signTutorAgreement = async ({ tutorId, legalName, accepted }) => {
  if (!accepted) throw new Error('Please accept the tutor agreement before signing.');
  if (!legalName?.trim()) throw new Error('Please enter your full legal name.');

  const agreement = {
    legalName: legalName.trim(),
    accepted: true,
    signedAt: new Date().toISOString(),
    version: '2026-09-29',
  };

  if (!isFirebaseConfigured) return agreement;

  ensureDb();
  await updateDoc(doc(db, collections.users, tutorId), {
    tutorAgreement: agreement,
    updatedAt: serverTimestamp(),
  });
  return agreement;
};


export const getTutorMarksDocuments = async (tutorId) => {
  if (!isFirebaseConfigured) {
    return [];
  }

  ensureDb();
  const snapshot = await getDocs(query(collection(db, 'users', tutorId, 'tutorMarksDocuments'), where('tutorId', '==', tutorId)));
  return snapshot.docs
    .map((item) => ({ id: item.id, ...item.data() }))
    .sort((left, right) => {
      const leftValue = left.createdAt?.toMillis?.() ?? new Date(left.createdAt ?? 0).getTime();
      const rightValue = right.createdAt?.toMillis?.() ?? new Date(right.createdAt ?? 0).getTime();
      return rightValue - leftValue;
    });
};
