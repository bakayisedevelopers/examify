import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  limit,
  onSnapshot,
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
import { collections } from '../firebase/schema';
import { getHardcodedTopics, normalizeTopicKey as normalizeCatalogTopicKey } from '../data/topicCatalog';
import { recommendExercises } from './aiService';
import { getCurrentGenerationNumber, getGenerationWeekForTrigger, getRegenerationState, getSevenDayWindow, isExerciseSubmitted } from './exerciseGenerationPlan';
import {
  mockCompletedLessons,
  mockDashboardData,
  mockQuestionPapers,
  mockStudentAssignments,
  mockTutorReports,
  mockUsers,
  mockGuideQuizResults,
} from '../data/mockData';
import { DEFAULT_SUBJECT, MAX_AI_SOURCE_PAPERS, MAX_DAILY_EXERCISES, MIN_AI_SOURCE_PAPERS, WEEKLY_EXERCISE_DAYS } from '../lib/constants';
import { getApprovedTutorSubjects, getUserSubjects, normalizeEligibleSubject } from '../utils/tutorSubjects';
import { calculateSubscriptionQuote, getEffectiveSubscriptionState } from '../utils/subscriptionPlans';
import { normalizeWhatsAppLessonLink } from '../utils/whatsapp';

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

const GENERATION_HISTORY_LIMIT = 40;
const EXERCISE_REGENERATION_LOCK_TIMEOUT_MS = 20 * 60 * 1000;

const STAFF_ACCESS_ROLES = ['co-owner', 'marker', 'viewer'];
const isTeacherProfile = (profile) => profile?.isTeacher === true || profile?.isTeacher === 'true' || profile?.role === 'teacher';
const getApprovedTutorOrTeacherProfiles = (profiles, subject) => {
  const approved = (profile) => getApprovedTutorSubjects(profile).includes(subject);
  const tutors = profiles.filter((profile) => profile.role === 'tutor' && approved(profile));
  const teachers = profiles.filter((profile) => isTeacherProfile(profile) && approved(profile));
  return [...new Map([...tutors, ...teachers].map((profile) => [profile.uid, profile])).values()];
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
  latestReport,
  availablePapers,
  paidSubscriptionActive,
  subscriptionPlanId = 'free',
  subscriptionPlanName = 'Free',
  subscriptionId = null,
  subscriptionPaymentReference = null,
  completedLessons = [],
  hasInitialGeneration = false,
}) => {
  const initialReady = Boolean(paidSubscriptionActive && latestReport && availablePapers.length >= 2 && completedLessons.length > 0);
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
        latestTutorReportExists: Boolean(latestReport),
        minimumQuestionPaperCountMet: availablePapers.length >= 2,
        lessonCompleted: completedLessons.length > 0,
      },
    },
    weekly: {
      ready: weeklyReady,
      checks: {
        paidSubscriptionActive,
        initialGenerationExists: hasInitialGeneration,
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

const getLatestTutorReportFromList = (studentId, reports) =>
  [...reports]
    .filter((report) => report.studentId === studentId)
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
        understandingLevel: Number(entry?.understandingLevel ?? lesson?.understandingLevel ?? 5),
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
      understandingLevel: Number(lesson?.understandingLevel ?? 5),
      reportSnippet: lesson?.topicReport ?? lesson?.note ?? '',
      completedOn: lesson?.completedOn ?? lesson?.createdAt ?? '',
      firstSeenIndex: lessonIndex,
    }));
};

const getTopicSummary = (completedLessons = []) => {
  const topicMap = new Map();

  completedLessons.forEach((lesson, lessonIndex) => {
    getLessonTopicEntries(lesson, lessonIndex).forEach((entry) => {
      const current = topicMap.get(entry.topic) ?? {
        topic: entry.topic,
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


const getInitialTopicsForDay = (topicSummaries = [], dayIndex = 0) => {
  if (!topicSummaries.length) return [];
  return [topicSummaries[dayIndex % topicSummaries.length].topic];
};

const pickWeeklyTopicsForDay = ({ topicSummaries = [], maxQuestionsPerDay, dayIndex = 0, generationNumber = 1 }) => {
  if (!topicSummaries.length) return [];

  const sortedByStrength = [...topicSummaries].sort((left, right) => {
    const understandingDifference = (right.understandingLevel ?? 0) - (left.understandingLevel ?? 0);
    if (understandingDifference !== 0) return understandingDifference;
    return new Date(left.completedOn || 0) - new Date(right.completedOn || 0);
  });

  if (generationNumber <= 2) {
    return topicSummaries.slice(0, maxQuestionsPerDay).map((item) => item.topic);
  }

  const selected = [];
  const offsetPool = dayIndex % Math.max(sortedByStrength.length, 1);
  const rotated = [...sortedByStrength.slice(offsetPool), ...sortedByStrength.slice(0, offsetPool)];

  rotated.forEach((topicSummary) => {
    if (selected.length < maxQuestionsPerDay && !selected.includes(topicSummary.topic)) {
      selected.push(topicSummary.topic);
    }
  });

  if (selected.length < maxQuestionsPerDay) {
    topicSummaries.forEach((topicSummary) => {
      if (selected.length < maxQuestionsPerDay && !selected.includes(topicSummary.topic)) {
        selected.push(topicSummary.topic);
      }
    });
  }

  return selected;
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
  const availablePapers = filterQuestionPapers(mockQuestionPapers, { grade: student?.grade, region: student?.province, subject });
  const latestReport = student?.latestReport || getLatestTutorReportFromList(student?.uid, mockTutorReports.filter((report) => (report.subject ?? DEFAULT_SUBJECT) === subject))?.note || '';
  const assignmentHistory = (mockDashboardData.student.exerciseHistory ?? []).filter((assignment) => (assignment.subject ?? DEFAULT_SUBJECT) === subject);
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
    latestReport,
    availablePapers,
    paidSubscriptionActive,
    subscriptionPlanId: subscriptionState.subscriptionPlanId,
    subscriptionPlanName: subscriptionState.subscriptionPlanName,
    subscriptionId: student?.uid ?? null,
    subscriptionPaymentReference,
    completedLessons: mockCompletedLessons.filter((lesson) => lesson.studentId === student?.uid && (lesson.subject ?? DEFAULT_SUBJECT) === subject),
    hasInitialGeneration: assignmentHistory.some((assignment) => assignment?.generationMode === 'initial'),
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
  return emptyDashboardData[role] ?? { stats: [] };
};

export const getTodayExercise = async (studentId, subject = DEFAULT_SUBJECT) => {
  if (!isFirebaseConfigured) return buildStudentDashboard(studentId, subject).todayExercise;
  ensureDb();
  const today = new Date().toISOString().slice(0, 10);
  const q = query(
    collection(db, collections.dailyExerciseAssignments),
    where('studentId', '==', studentId),
    where('subject', '==', subject),
    where('assignmentDate', '==', today),
    limit(1),
  );
  const snapshot = await getDocs(q);
  return snapshot.docs[0] ? { id: snapshot.docs[0].id, ...snapshot.docs[0].data() } : null;
};

export const getExerciseHistory = async (studentId, subject = DEFAULT_SUBJECT) => {
  if (!isFirebaseConfigured) return buildStudentDashboard(studentId, subject).exerciseHistory;
  
  ensureDb();

  // Create a string for 'today' in the user's local timezone (YYYY-MM-DD)
  // This ensures "today" is relative to the person using the app.
  const now = new Date();
  const todayLocal = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0')
  ].join('-');

  const q = query(
    collection(db, "dailyExerciseAssignments"),
    where('studentId', '==', studentId),
    where('subject', '==', subject),
    where('assignmentDate', '<', todayLocal), // Strictly less than TODAY
    orderBy('assignmentDate', 'desc'),        // Changed to 'desc' so newest history is first
    limit(20)
  );

  const snapshot = await getDocs(q);
  return snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
};

export const getCurrentWeekExercises = async (studentId, subject = DEFAULT_SUBJECT) => {
  if (!isFirebaseConfigured) {
    const all = buildStudentDashboard(studentId, subject).exerciseHistory ?? [];
    const today = new Date().toISOString().slice(0, 10);
    return all.filter((ex) => ex.assignmentDate >= today).slice(0, 7);
  }
  ensureDb();
  const today = new Date().toISOString().slice(0, 10);
  const q = query(
    collection(db, collections.dailyExerciseAssignments),
    where('studentId', '==', studentId),
    where('subject', '==', subject),
    where('assignmentDate', '>=', today),
    orderBy('assignmentDate', 'asc'),
    limit(7),
  );
  const snapshot = await getDocs(q);
  return snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
};

export const getFutureExercises = async (studentId, subject = DEFAULT_SUBJECT) => {
  if (!isFirebaseConfigured) {
    const all = buildStudentDashboard(studentId, subject).exerciseHistory ?? [];
    const weekFromToday = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    return all.filter((ex) => ex.assignmentDate > weekFromToday);
  }
  ensureDb();
  const weekFromToday = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const q = query(
    collection(db, collections.dailyExerciseAssignments),
    where('studentId', '==', studentId),
    where('subject', '==', subject),
    where('assignmentDate', '>', weekFromToday),
    orderBy('assignmentDate', 'asc'),
    limit(20),
  );
  const snapshot = await getDocs(q);
  return snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
};

const getAssignmentHistory = async (studentId, subject = DEFAULT_SUBJECT, maxRecords = GENERATION_HISTORY_LIMIT) => {
  if (!studentId) return [];
  if (!isFirebaseConfigured) return buildStudentDashboard(studentId, subject).exerciseHistory ?? [];

  ensureDb();
  const q = query(
    collection(db, collections.dailyExerciseAssignments),
    where('studentId', '==', studentId),
    where('subject', '==', subject),
    orderBy('assignmentDate', 'desc'),
    limit(maxRecords),
  );
  const snapshot = await getDocs(q);
  return snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
};

const getLastAssignmentDate = (history = []) =>
  [...history]
    .map((assignment) => toDateOnly(assignment?.assignmentDate))
    .filter(Boolean)
    .sort()
    .at(-1) ?? null;

const groupAssignmentsByBatch = (history = []) => {
  const sortedHistory = [...history].sort((left, right) => {
    const leftDate = new Date(left?.createdAt?.toDate?.() ?? left?.createdAt ?? left?.assignmentDate ?? 0).getTime();
    const rightDate = new Date(right?.createdAt?.toDate?.() ?? right?.createdAt ?? right?.assignmentDate ?? 0).getTime();
    return rightDate - leftDate;
  });

  const groups = [];
  const fallbackMap = new Map();

  sortedHistory.forEach((assignment) => {
    const createdAtValue = assignment?.createdAt?.toDate?.() ?? assignment?.createdAt ?? assignment?.assignmentDate ?? null;
    const createdAt = createdAtValue ? new Date(createdAtValue) : null;
    const explicitBatchId = assignment?.generationBatchId;

    if (explicitBatchId) {
      const existing = groups.find((group) => group.batchId === explicitBatchId);
      if (existing) {
        existing.assignments.push(assignment);
        return;
      }

      groups.push({
        batchId: explicitBatchId,
        createdAt,
        assignments: [assignment],
      });
      return;
    }

    const fallbackKey = `${assignment?.generationMode || 'legacy'}-${toDateOnly(assignment?.assignmentDate)}`;
    const existingFallback = fallbackMap.get(fallbackKey);

    if (existingFallback) {
      existingFallback.assignments.push(assignment);
      return;
    }

    const group = {
      batchId: fallbackKey,
      createdAt,
      assignments: [assignment],
    };
    fallbackMap.set(fallbackKey, group);
    groups.push(group);
  });

  return groups.sort((left, right) => new Date(right.createdAt || 0) - new Date(left.createdAt || 0));
};

const getRecentGenerationSummaries = (history = [], count = 2) =>
  groupAssignmentsByBatch(history)
    .slice(0, count)
    .map((group) => ({
      batchId: group.batchId,
      generationMode: group.assignments[0]?.generationMode ?? 'unknown',
      paperIds: [...new Set(group.assignments.flatMap((assignment) => assignment?.paperIds ?? []))],
      assignmentDates: group.assignments.map((assignment) => assignment?.assignmentDate).filter(Boolean),
    }));

const getRecentExerciseHistoryForAi = (history = [], days = 14) => {
  const today = new Date();
  const cutoff = formatISO(addDays(today, -days), { representation: 'date' });
  return history
    .filter((assignment) => {
      const assignmentDate = toDateOnly(assignment?.assignmentDate);
      return assignmentDate && assignmentDate >= cutoff;
    })
    .sort((left, right) => String(right.assignmentDate ?? '').localeCompare(String(left.assignmentDate ?? '')))
    .map((assignment) => ({
      assignmentDate: assignment.assignmentDate,
      title: assignment.title ?? '',
      topic: assignment.topic ?? '',
      topicBreakdown: Array.isArray(assignment.topicBreakdown) ? assignment.topicBreakdown : [],
      questionReferences: Array.isArray(assignment.questionReferences) ? assignment.questionReferences : [],
      paperIds: Array.isArray(assignment.paperIds) ? assignment.paperIds : [],
      questionLinks: Array.isArray(assignment.questionLinks)
        ? assignment.questionLinks.map((link) => ({
          paperId: link?.paperId ?? '',
          pageNumber: Number(link?.pageNumber ?? 1) || 1,
          questionReference: link?.questionReference ?? '',
          topic: link?.topic ?? '',
        })).filter((link) => link.paperId && link.questionReference)
        : [],
      generationMode: assignment.generationMode ?? '',
      generationBatchId: assignment.generationBatchId ?? '',
    }))
    .slice(0, 21);
};

const isAnalyzedQuestionPaper = (paper = {}) =>
  paper.analysisStatus === 'Analyzed' && paper.availableForGeneration !== false && Array.isArray(paper.questions) && paper.questions.length > 0;

const normalizeTopicKey = (value = '') => String(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const topicStopWords = new Set(['and', 'or', 'of', 'the', 'a', 'an', 'to', 'in', 'on', 'with', 'for']);
const topicTokens = (value = '') => normalizeTopicKey(value)
  .split(' ')
  .map((token) => token.trim())
  .filter((token) => token.length >= 3 && !topicStopWords.has(token));

const topicKeysMatch = (left = '', right = '') => {
  const leftKey = normalizeTopicKey(left);
  const rightKey = normalizeTopicKey(right);
  if (!leftKey || !rightKey) return false;
  if (leftKey.includes(rightKey) || rightKey.includes(leftKey)) return true;
  const leftTokens = topicTokens(leftKey);
  const rightTokens = topicTokens(rightKey);
  return leftTokens.some((leftToken) =>
    rightTokens.some((rightToken) => leftToken === rightToken || leftToken.includes(rightToken) || rightToken.includes(leftToken)),
  );
};

const questionMatchesTopics = (question = {}, completedTopics = []) => {
  if (!completedTopics.length) return true;
  const completed = completedTopics.map((topic) => String(topic ?? '').trim()).filter(Boolean);
  const questionTopics = [
    question.topic,
    ...(Array.isArray(question.topics) ? question.topics : []),
  ].map((topic) => String(topic ?? '').trim()).filter(Boolean);
  return questionTopics.some((topic) =>
    completed.some((completedTopic) => topicKeysMatch(topic, completedTopic)),
  );
};

const summarizePaperQuestions = (paper = {}, completedTopics = []) =>
  (Array.isArray(paper.questions) ? paper.questions : [])
    .filter((question) => questionMatchesTopics(question, completedTopics))
    .slice(0, 80)
    .map((question) => ({
      paperId: question.paperId ?? paper.id,
      questionReference: question.questionReference,
      subject: question.subject ?? paper.subject,
      topic: question.topic,
      topics: Array.isArray(question.topics) ? question.topics : [],
      pageNumber: question.pageNumber,
      marks: question.marks ?? 0,
      section: question.section ?? '',
    }))
    .filter((question) => question.questionReference && question.pageNumber);

const paperMetadataForAi = (paper = {}) => ({
  id: paper.id,
  year: paper.year,
  month: paper.month,
  region: paper.region,
  subject: paper.subject,
  grade: paper.grade,
  paperNumber: paper.paperNumber ?? 'Paper 1',
  copySuffix: paper.copySuffix ?? '',
  displayName: paper.displayName ?? '',
  paperDocumentAnalysisPageCount: paper.paperDocumentAnalysisPageCount ?? 0,
  questionCount: paper.questionCount ?? paper.questions?.length ?? 0,
  topics: paper.topics ?? [],
});

const selectTopicPaperMetadata = ({ papers = [], assignmentHistory = [], completedTopics = [] }) => {
  const recentPaperIds = new Set(getRecentGenerationSummaries(assignmentHistory, 2).flatMap((group) => group.paperIds));
  const analyzedPapers = papers.filter(isAnalyzedQuestionPaper);
  const selectedPaperMap = new Map();

  const topicPaperMetadata = completedTopics.map((topic) => {
    const paperMatches = analyzedPapers
      .map((paper) => ({
        paper,
        questions: summarizePaperQuestions(paper, [topic]),
      }))
      .filter((item) => item.questions.length > 0);
    const unrepeated = paperMatches.filter((item) => !recentPaperIds.has(item.paper.id));
    const reusableTopUps = paperMatches.filter((item) => !unrepeated.some((match) => match.paper.id === item.paper.id));
    const selected = (unrepeated.length >= MIN_AI_SOURCE_PAPERS ? unrepeated : [...unrepeated, ...reusableTopUps])
      .slice(0, MAX_AI_SOURCE_PAPERS);

    selected.forEach(({ paper }) => selectedPaperMap.set(paper.id, paper));

    return {
      topic,
      paperCount: selected.length,
      reusedRecentPapers: selected.some(({ paper }) => recentPaperIds.has(paper.id)),
      papers: selected.map(({ paper, questions }) => ({
        ...paperMetadataForAi(paper),
        topics: (paper.topics ?? []).filter((paperTopic) => questionMatchesTopics({ topic: paperTopic }, [topic])),
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
    recentPaperIds: [...recentPaperIds],
    reusedRecentPapers: topicPaperMetadata.some((item) => item.reusedRecentPapers),
    analyzedPaperCount: analyzedPapers.length,
    matchingAnalyzedPaperCount: selectedPapers.length,
  };
};

const buildAssignmentDates = ({ mode, assignmentHistory = [] }) => {
  const lastAssignmentDate = getLastAssignmentDate(assignmentHistory);
  const baseDate = lastAssignmentDate ? addDays(new Date(lastAssignmentDate), 1) : new Date();
  const daysToCreate = mode === 'weekly' ? WEEKLY_EXERCISE_DAYS : 7;

  return Array.from({ length: daysToCreate }, (_, dayIndex) =>
    formatISO(addDays(baseDate, dayIndex), { representation: 'date' }),
  );
};

const buildAiQuestionPlan = ({ mode, topicSummaries = [], assignmentDates = [], generationNumber = 1, dailyExerciseCaps = {} }) => {
  const maxExercisesPerDay = mode === 'initial'
    ? 1
    : Math.min(MAX_DAILY_EXERCISES, Math.max(1, generationNumber));
  const highestDailyCap = Math.max(maxExercisesPerDay, ...Object.values(dailyExerciseCaps).map(Number).filter(Number.isFinite));
  return {
    maxExercisesPerDay: highestDailyCap,
    maxQuestionsPerDay: 1,
    perDayTopics: assignmentDates.map((assignmentDate, dayIndex) => ({
      assignmentDate,
      topics: mode === 'initial' && !dailyExerciseCaps[assignmentDate]
        ? getInitialTopicsForDay(topicSummaries, dayIndex)
        : pickWeeklyTopicsForDay({
          topicSummaries,
          maxQuestionsPerDay: Math.min(dailyExerciseCaps[assignmentDate] ?? maxExercisesPerDay, topicSummaries.length || 1),
          dayIndex,
          generationNumber,
        }),
    })),
    rules: {
      titleFormat: 'question-references-only',
      distinctTopicsPerDay: true,
      oneQuestionPerExercise: true,
      maxExercisesPerDay: highestDailyCap,
      weightedTowardHigherUnderstandingFromFourthTopic: topicSummaries.length > 3,
    },
  };
};

const buildAssignmentsFromAiRecommendations = ({
  recommendations = [],
  student,
  subscriptionTrace = {},
  selectedPapers = [],
  generationBatchId,
  mode,
  subject = DEFAULT_SUBJECT,
  topicSummaries = [],
  maxExercisesPerDay = MAX_DAILY_EXERCISES,
  dailyExerciseCaps = {},
  allowedAssignmentDates = [],
  grade,
  generationWeek = 1,
}) => {
  const allowedDates = new Set(allowedAssignmentDates);
  const dailyExerciseCounts = new Map();
  const dailyTopics = new Map();
  const cappedRecommendations = recommendations.filter((recommendation) => {
    const assignmentDate = String(recommendation?.assignmentDate ?? '');
    if (!assignmentDate || (allowedDates.size && !allowedDates.has(assignmentDate))) return false;
    const count = dailyExerciseCounts.get(assignmentDate) ?? 0;
    if (count >= (dailyExerciseCaps[assignmentDate] ?? maxExercisesPerDay)) return false;

    const topic = String(recommendation?.topicBreakdown?.[0]?.topic || recommendation?.topic || '').trim();
    const usedTopics = dailyTopics.get(assignmentDate) ?? new Set();
    if (topic && usedTopics.has(topic)) return false;
    if (topic) usedTopics.add(topic);
    dailyTopics.set(assignmentDate, usedTopics);
    dailyExerciseCounts.set(assignmentDate, count + 1);
    return true;
  });

  return cappedRecommendations.map((recommendation, index) => {
    let topicBreakdown = Array.isArray(recommendation?.topicBreakdown) && recommendation.topicBreakdown.length
      ? recommendation.topicBreakdown
      : (Array.isArray(recommendation?.questionReferences) ? recommendation.questionReferences : [])
          .map((reference, referenceIndex) => ({
            topic: recommendation?.topic || topicSummaries[referenceIndex]?.topic || 'Subject topic',
            questionReference: reference,
          }));

    const seenTopics = new Set();
    topicBreakdown = topicBreakdown
      .map((entry) => ({
        topic: String(entry?.topic || 'Subject topic').trim(),
        questionReference: String(entry?.questionReference || entry?.reference || '').trim(),
      }))
      .filter((entry) => entry.questionReference)
      .filter((entry) => {
        if (mode === 'initial') {
          if (seenTopics.has(entry.topic)) return false;
          seenTopics.add(entry.topic);
          return true;
        }

        if (seenTopics.has(entry.topic)) return false;
        seenTopics.add(entry.topic);
        return true;
      })
      .slice(0, 1);

    const questionReferences = topicBreakdown.map((entry) => entry.questionReference).filter(Boolean);
    const questionLinks = Array.isArray(recommendation?.questionLinks)
      ? recommendation.questionLinks
          .map((link) => ({
            paperId: String(link?.paperId || link?.id || '').trim(),
            pageNumber: Number(link?.pageNumber ?? link?.page ?? 1) || 1,
            questionReference: String(link?.questionReference || link?.reference || '').trim(),
            topic: String(link?.topic || '').trim(),
          }))
          .filter((link) => link.paperId && link.pageNumber && questionReferences.includes(link.questionReference))
      : [];

    return {
      studentId: student.uid,
      assignmentDate: recommendation.assignmentDate,
      title: normalizeQuestionReferenceTitle(questionReferences) || `Question set ${index + 1}`,
      topic: topicBreakdown.map((entry) => entry.topic).filter(Boolean).join(' | ') || recommendation.topic || 'Subject topic',
      sourceLabel: recommendation.sourceLabel || selectedPapers.map((paper) => `${paper.year} ${paper.region} ${paper.month} paper`).join('; '),
      instruction: recommendation.instruction || recommendation.reason || 'Answer the referenced question number(s) only.',
      subject,
      grade,
      generatedBy: 'frontend-ai-service',
      generationMode: mode,
      generationBatchId,
      generationWeek,
      paidSubscriptionActive: true,
      subscriptionId: subscriptionTrace.subscriptionId ?? null,
      subscriptionPlanId: subscriptionTrace.subscriptionPlanId ?? 'free',
      subscriptionPlanName: subscriptionTrace.subscriptionPlanName ?? 'Free',
      subscriptionPaymentReference: subscriptionTrace.subscriptionPaymentReference ?? null,
      paperIds: Array.isArray(recommendation?.paperIdsUsed) && recommendation.paperIdsUsed.length
        ? recommendation.paperIdsUsed.filter(Boolean)
        : selectedPapers.map((paper) => paper.id),
      understandingLevel: null,
      reportSnippet: topicBreakdown.map((entry) => {
        const match = topicSummaries.find((topicSummary) => topicSummary.topic === entry.topic);
        return match ? `${entry.topic}: ${match.reportSnippet}` : entry.topic;
      }).filter(Boolean).join('\n'),
      questionReferences,
      questionLinks,
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
      subscriptionPaymentVerified: false,
      paymentVerificationFailed: true,
    };
  }

  const paymentSnapshot = await getDoc(doc(db, collections.payments, subscriptionPaymentReference));
  const payment = paymentSnapshot.exists() ? paymentSnapshot.data() : null;
  let expectedQuote;
  try {
    expectedQuote = calculateSubscriptionQuote({
      planId: subscription.planId,
      billingPeriod: subscription.billingPeriod,
      subjectCount: subscription.subjectCount,
    });
  } catch {
    expectedQuote = null;
  }
  const paymentMatchesSubscription = Boolean(expectedQuote && payment
    && payment.status === 'success'
    && payment.reference === subscriptionPaymentReference
    && payment.studentId === studentId
    && payment.planId === subscription.planId
    && payment.billingPeriod === subscription.billingPeriod
    && Number(payment.subjectCount) === Number(subscription.subjectCount)
    && Number(payment.amount) === expectedQuote.amount
    && payment.currency === expectedQuote.currency);

  if (!paymentMatchesSubscription) {
    return {
      ...getEffectiveSubscriptionState(),
      ...getSubscriptionLifecycleFields(subscription),
      paidSubscriptionActive: false,
      subscriptionId: studentId,
      subscriptionPaymentReference,
      subscriptionPaymentVerified: false,
      paymentVerificationFailed: true,
    };
  }

  return { ...base, paymentCompleted: true, paidSubscriptionActive: true, subscriptionPaymentVerified: true };
};

export const getStudentSubscriptionState = async (student) => {
  if (!student?.uid) return getEffectiveSubscriptionState();

  if (!isFirebaseConfigured) {
    const state = getEffectiveSubscriptionState({
      subscription: {
        planId: student.subscriptionPlanId,
        status: student.subscriptionStatus,
        billingPeriod: student.subscriptionBillingPeriod,
        subjectCount: student.subscriptionSubjectCount,
        renewalDate: student.subscriptionRenewalDate,
        graceEndsAt: student.graceEndsAt,
      },
    });
    return {
      ...state,
      ...getSubscriptionLifecycleFields({
        autoRenew: student.autoRenew,
        cancelAtPeriodEnd: student.cancelAtPeriodEnd,
        pendingPlan: student.pendingPlan,
        graceEndsAt: student.graceEndsAt,
        renewalAttemptCount: student.renewalAttemptCount,
        nextRenewalAttemptAt: student.nextRenewalAttemptAt,
        manualPaymentRequired: student.manualPaymentRequired,
      }),
      paidSubscriptionActive: state.paymentCompleted,
      subscriptionId: student.uid,
      subscriptionPaymentReference: student.latestPaymentReference || (state.paymentCompleted ? 'demo-payment-reference' : null),
      subscriptionPaymentVerified: state.paymentCompleted,
    };
  }

  ensureDb();
  const snapshot = await getDoc(doc(db, collections.subscriptions, student.uid));
  return resolveVerifiedSubscriptionState({
    studentId: student.uid,
    subscription: snapshot.exists() ? snapshot.data() : null,
  });
};

export const getStudentAccessState = async (student, subject = DEFAULT_SUBJECT) => {
  if (!student) {
    return {
      paymentCompleted: false,
      paidSubscriptionActive: false,
      paymentRequired: true,
      subscriptionPlanId: 'free',
      subscriptionPlanName: 'Free',
      subscriptionId: null,
      subscriptionPaymentReference: null,
      subscriptionPaymentVerified: false,
      subscriptionStatus: 'plan_required',
      requiresSubscriptionSelection: true,
      initialGenerationReady: false,
      weeklyGenerationReady: false,
      matchingQuestionPapers: [],
      latestTutorReport: null,
      completedLessons: [],
      tutorReports: [],
      latestGeneratedAssignments: [],
      hasInitialGeneration: false,
    };
  }

  if (!isFirebaseConfigured) {
    const rawSubscriptionState = getEffectiveSubscriptionState({
      subscription: {
        planId: student.subscriptionPlanId,
        status: student.subscriptionStatus,
        billingPeriod: student.subscriptionBillingPeriod,
        subjectCount: student.subscriptionSubjectCount,
        renewalDate: student.subscriptionRenewalDate,
        graceEndsAt: student.graceEndsAt,
      },
    });
    const subscriptionState = {
      ...rawSubscriptionState,
      ...getSubscriptionLifecycleFields({
        autoRenew: student.autoRenew,
        cancelAtPeriodEnd: student.cancelAtPeriodEnd,
        pendingPlan: student.pendingPlan,
        graceEndsAt: student.graceEndsAt,
        renewalAttemptCount: student.renewalAttemptCount,
        nextRenewalAttemptAt: student.nextRenewalAttemptAt,
        manualPaymentRequired: student.manualPaymentRequired,
      }),
      paidSubscriptionActive: rawSubscriptionState.paymentCompleted,
      subscriptionId: student.uid,
      subscriptionPaymentReference: student.latestPaymentReference || (rawSubscriptionState.paymentCompleted ? 'demo-payment-reference' : null),
      subscriptionPaymentVerified: rawSubscriptionState.paymentCompleted,
    };
    const matchingQuestionPapers = filterQuestionPapers(mockQuestionPapers, { grade: student.grade, region: student.province, subject });
    const normalizedSubject = normalizeEligibleSubject(subject) ?? subject;
    const coveredSubjects = getUserSubjects(student).slice(0, subscriptionState.subscriptionSubjectCount).map((item) => normalizeEligibleSubject(item) ?? item);
    const paidSubscriptionActive = subscriptionState.paidSubscriptionActive && coveredSubjects.includes(normalizedSubject);
    const subjectReports = mockTutorReports.filter((report) => (!student.uid || report.studentId === student.uid) && (report.subject ?? DEFAULT_SUBJECT) === subject);
    const latestTutorReport = student.latestReportsBySubject?.[subject] || getLatestTutorReportFromList(student.uid, subjectReports)?.note || (subject === DEFAULT_SUBJECT ? student.latestReport : '') || '';
    const completedLessons = mockCompletedLessons.filter((lesson) => lesson.studentId === student.uid && (lesson.subject ?? DEFAULT_SUBJECT) === subject);
    const assignmentHistory = await getAssignmentHistory(student.uid, subject);
    const generationStatus = buildStudentGenerationStatus({
      latestReport: latestTutorReport,
      availablePapers: matchingQuestionPapers,
      paidSubscriptionActive,
      subscriptionPlanId: subscriptionState.subscriptionPlanId,
      subscriptionPlanName: subscriptionState.subscriptionPlanName,
      subscriptionId: subscriptionState.subscriptionId,
      subscriptionPaymentReference: subscriptionState.subscriptionPaymentReference,
      completedLessons,
      hasInitialGeneration: assignmentHistory.some((assignment) => assignment?.generationMode === 'initial'),
    });

    return {
      ...subscriptionState,
      paymentCompleted: paidSubscriptionActive,
      paidSubscriptionActive,
      paymentRequired: !paidSubscriptionActive,
      subjectNotIncluded: subscriptionState.paidSubscriptionActive && !coveredSubjects.includes(normalizedSubject),
      initialGenerationReady: generationStatus.initial.ready,
      weeklyGenerationReady: generationStatus.weekly.ready,
      generationStatus,
      generationRunStatus: null,
      matchingQuestionPapers: matchingQuestionPapers.slice(0, MAX_AI_SOURCE_PAPERS),
      latestTutorReport,
      completedLessons,
      tutorReports: subjectReports,
      latestGeneratedAssignments: assignmentHistory,
      hasInitialGeneration: assignmentHistory.some((assignment) => assignment?.generationMode === 'initial'),
    };
  }

  ensureDb();
  const [studentSnapshot, subscriptionSnapshot, papers, reports, lessons, assignmentHistory, generationRunSnapshot] = await Promise.all([
    getDoc(doc(db, collections.users, student.uid)),
    getDoc(doc(db, collections.subscriptions, student.uid)),
    getQuestionPapers({ grade: student.grade, region: student.province, subject }),
    getTutorReports(student.uid, subject),
    getCompletedLessons(student.uid, subject),
    getAssignmentHistory(student.uid, subject),
    getDoc(doc(db, collections.exerciseGenerationStatus, `${student.uid}_${subject}`)),
  ]);
  const studentData = studentSnapshot.exists() ? studentSnapshot.data() : student;
  const subscriptionState = await resolveVerifiedSubscriptionState({
    studentId: student.uid,
    subscription: subscriptionSnapshot.exists() ? subscriptionSnapshot.data() : null,
  });
  const normalizedSubject = normalizeEligibleSubject(subject) ?? subject;
  const coveredSubjects = getUserSubjects(studentData).slice(0, subscriptionState.subscriptionSubjectCount).map((item) => normalizeEligibleSubject(item) ?? item);
  const paidSubscriptionActive = subscriptionState.paidSubscriptionActive && coveredSubjects.includes(normalizedSubject);
  const latestTutorReport = studentData?.latestReportsBySubject?.[subject] || reports[0]?.note || (subject === DEFAULT_SUBJECT ? (studentData?.latestReport || '') : '');
  const generationStatus = buildStudentGenerationStatus({
    latestReport: latestTutorReport,
    availablePapers: papers,
    paidSubscriptionActive,
    subscriptionPlanId: subscriptionState.subscriptionPlanId,
    subscriptionPlanName: subscriptionState.subscriptionPlanName,
    subscriptionId: subscriptionState.subscriptionId,
    subscriptionPaymentReference: subscriptionState.subscriptionPaymentReference,
    completedLessons: lessons,
    hasInitialGeneration: assignmentHistory.some((assignment) => assignment?.generationMode === 'initial'),
  });

  return {
    ...subscriptionState,
    paymentCompleted: paidSubscriptionActive,
    paidSubscriptionActive,
    paymentRequired: !paidSubscriptionActive,
    subjectNotIncluded: subscriptionState.paidSubscriptionActive && !coveredSubjects.includes(normalizedSubject),
    initialGenerationReady: generationStatus.initial.ready,
    weeklyGenerationReady: generationStatus.weekly.ready,
    generationStatus,
    generationRunStatus: generationRunSnapshot.exists() ? generationRunSnapshot.data() : null,
    matchingQuestionPapers: papers.slice(0, MAX_AI_SOURCE_PAPERS),
    latestTutorReport,
    completedLessons: lessons,
    tutorReports: reports,
    latestGeneratedAssignments: assignmentHistory,
    hasInitialGeneration: assignmentHistory.some((assignment) => assignment?.generationMode === 'initial'),
  };
};

export const getUnassignedStudents = async (subject = DEFAULT_SUBJECT) => {
  if (!isFirebaseConfigured) {
    const assignedIds = new Set(
      mockStudentAssignments
        .filter((assignment) => assignment.active !== false && (assignment.subject ?? DEFAULT_SUBJECT) === subject)
        .map((assignment) => assignment.studentId),
    );
    return demoUsers.filter((user) => user.role === 'student' && !assignedIds.has(user.uid));
  }

  ensureDb();
  const [usersSnapshot, assignmentsSnapshot] = await Promise.all([
    getDocs(query(collection(db, collections.users), where('role', '==', 'student'))),
    getDocs(query(
      collection(db, collections.tutorStudentAssignments),
      where('subject', '==', subject),
      where('active', '==', true),
    )),
  ]);
  const assignedIds = new Set(assignmentsSnapshot.docs.map((item) => item.data().studentId));
  return usersSnapshot.docs
    .map((item) => item.data())
    .filter((student) => !assignedIds.has(student.uid));
};

export const getAssignedStudentsForTutor = async (tutorId, subject = DEFAULT_SUBJECT) => {
  const contexts = await getTutorAssignedStudentContexts(tutorId);
  return contexts.filter((context) => context.subject === subject);
};

export const getTutorReports = async (studentId, subject = DEFAULT_SUBJECT) => {
  if (!isFirebaseConfigured) {
    return mockTutorReports
      .filter((report) => (!studentId || report.studentId === studentId) && (report.subject ?? DEFAULT_SUBJECT) === subject)
      .sort((left, right) => new Date(right.updatedAt ?? 0) - new Date(left.updatedAt ?? 0));
  }

  ensureDb();
  const q = studentId
    ? query(collection(db, collections.tutorReports), where('studentId', '==', studentId), where('subject', '==', subject), orderBy('updatedAt', 'desc'))
    : query(collection(db, collections.tutorReports), where('subject', '==', subject), orderBy('updatedAt', 'desc'));
  const snapshot = await getDocs(q);
  return snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
};

export const saveTutorReport = async ({ reportId, studentId, tutorId, note, studentName, subject = DEFAULT_SUBJECT, reportType = 'general' }) => {
  const accessContext = await requireCoOwnerAccess({ tutorId, studentId, subject });
  if (!isFirebaseConfigured) {
    return {
      id: reportId ?? `mock-report-${Date.now()}`,
      studentId,
      tutorId,
      subject,
      note,
      studentName,
      reportType,
      updatedAt: new Date().toISOString(),
    };
  }

  ensureDb();
  const payload = {
    studentId,
    tutorId,
    subject,
    note,
    studentName,
    reportType,
    assignmentPeriodId: accessContext.assignmentPeriodId,
    updatedAt: serverTimestamp(),
    createdAt: serverTimestamp(),
  };

  const studentReportUpdate = {
    [`latestReportsBySubject.${subject}`]: note,
    updatedAt: serverTimestamp(),
  };
  if (subject === DEFAULT_SUBJECT) {
    studentReportUpdate.latestReport = note;
  }

  if (reportId) {
    await updateDoc(doc(db, collections.tutorReports, reportId), payload);
    await updateDoc(doc(db, collections.users, studentId), studentReportUpdate);
    return { id: reportId, ...payload };
  }

  const ref = await addDoc(collection(db, collections.tutorReports), payload);
  await updateDoc(doc(db, collections.users, studentId), studentReportUpdate);
  return { id: ref.id, ...payload };
};

export const getCompletedLessons = async (studentId, subject = DEFAULT_SUBJECT) => {
  if (!isFirebaseConfigured) {
    return mockCompletedLessons.filter((lesson) => (!studentId || lesson.studentId === studentId) && (lesson.subject ?? DEFAULT_SUBJECT) === subject && isCompletedLessonReadyForGeneration(lesson));
  }

  ensureDb();
  const q = studentId
    ? query(collection(db, collections.coveredTopics), where('studentId', '==', studentId), where('subject', '==', subject), orderBy('completedOn', 'desc'))
    : query(collection(db, collections.coveredTopics), where('subject', '==', subject), orderBy('completedOn', 'desc'));
  const snapshot = await getDocs(q);
  return snapshot.docs
    .map((item) => ({ id: item.id, ...item.data() }))
    .filter(isCompletedLessonReadyForGeneration);
};

export const getStudentTopicScoresForTutor = async ({ tutorId, studentId, subject = DEFAULT_SUBJECT }) => {
  if (!tutorId || !studentId) throw new Error('Tutor and student are required.');
  await requireTutorAccess({ tutorId, studentId, subject, allowedRoles: ['co-owner', 'marker'] });
  const lessons = await getCompletedLessons(studentId, subject);
  const scores = {};
  lessons.forEach((lesson) => {
    getLessonTopicEntries(lesson).forEach((entry) => {
      if (!(entry.topic in scores)) scores[entry.topic] = entry.understandingLevel;
    });
  });
  return scores;
};

export const updateStudentTopicScoreForTutor = async ({ tutorId, studentId, subject = DEFAULT_SUBJECT, topic, exerciseId, peerAssignmentId, understandingLevel }) => {
  const topicName = String(topic || '').trim();
  const score = Number(understandingLevel);
  if (!tutorId || !studentId || !topicName || !exerciseId) throw new Error('Tutor, student, topic, and exercise are required.');
  if (!Number.isFinite(score) || score < 0 || score > 10) throw new Error('Enter a topic score from 0 to 10.');
  const contexts = await getTutorAssignedStudentContexts(tutorId);
  if (!contexts.some((context) => context.studentId === studentId && context.subject === subject)) {
    throw new Error('This student is not assigned to you for this subject.');
  }

  const lessons = await getCompletedLessons(studentId, subject);
  const matchingLessons = lessons.filter((lesson) => getLessonTopicEntries(lesson).some((entry) => entry.topic.toLocaleLowerCase() === topicName.toLocaleLowerCase()));
  if (!matchingLessons.length) throw new Error('No completed lesson was found for this topic.');

  const exercise = await getExerciseAssignmentById(exerciseId);
  if (!exercise || exercise.studentId !== studentId || (exercise.subject ?? DEFAULT_SUBJECT) !== subject) {
    throw new Error('The selected exercise does not belong to this student and subject.');
  }
  if (peerAssignmentId && isFirebaseConfigured) {
    const peerSnapshot = await getDoc(doc(db, collections.peerMarkingAssignments, peerAssignmentId));
    if (!peerSnapshot.exists() || peerSnapshot.data().exerciseId !== exerciseId || peerSnapshot.data().reviewerId !== studentId) {
      throw new Error('The peer-marking record does not match this exercise.');
    }
  }

  const exerciseScore = {
    exerciseId,
    exerciseTitle: exercise.title ?? 'Exercise',
    assignmentDate: exercise.assignmentDate ?? '',
    understandingLevel: score,
    updatedAt: new Date().toISOString(),
  };
  const scoreHistoryByExercise = new Map();
  matchingLessons.forEach((lesson) => getLessonTopicEntries(lesson).forEach((entry) => {
    if (entry.topic.toLocaleLowerCase() !== topicName.toLocaleLowerCase()) return;
    (entry.exerciseScores ?? []).forEach((record) => {
      if (record?.exerciseId) scoreHistoryByExercise.set(record.exerciseId, record);
    });
  }));
  scoreHistoryByExercise.set(exerciseId, exerciseScore);
  const recentExerciseScores = [...scoreHistoryByExercise.values()]
    .sort((left, right) => String(right.assignmentDate ?? '').localeCompare(String(left.assignmentDate ?? ''))
      || String(right.updatedAt ?? '').localeCompare(String(left.updatedAt ?? '')))
    .slice(0, 7);
  const topicAverage = Math.round(recentExerciseScores.reduce((sum, record) => sum + Number(record.understandingLevel), 0) / recentExerciseScores.length);

  const updatedLessons = matchingLessons.map((lesson, lessonIndex) => {
    const originalEntries = Array.isArray(lesson.topicUnderstandingScores) && lesson.topicUnderstandingScores.length
      ? lesson.topicUnderstandingScores
      : (lesson.topics?.length ? lesson.topics : [lesson.topic]).filter(Boolean).map((entryTopic) => ({ topic: entryTopic, understandingLevel: lesson.understandingLevel }));
    const entries = originalEntries.map((entry) => ({
      ...entry,
      understandingLevel: String(entry.topic).trim().toLocaleLowerCase() === topicName.toLocaleLowerCase()
        ? topicAverage
        : Number(entry.understandingLevel ?? lesson.understandingLevel ?? 5),
      ...(lessonIndex === 0 && String(entry.topic).trim().toLocaleLowerCase() === topicName.toLocaleLowerCase()
        ? { exerciseScores: recentExerciseScores }
        : {}),
    }));
    const average = Math.round(entries.reduce((sum, entry) => sum + entry.understandingLevel, 0) / entries.length);
    return { lesson, entries, average };
  });

  const originalExerciseScores = Array.isArray(exercise.topicUnderstandingScores) ? exercise.topicUnderstandingScores : [];
  const exerciseTopicScores = [...originalExerciseScores.filter((entry) => String(entry.topic).trim().toLocaleLowerCase() !== topicName.toLocaleLowerCase()), {
    topic: topicName,
    understandingLevel: score,
    exerciseId,
    exerciseTitle: exercise.title ?? 'Exercise',
    assignmentDate: exercise.assignmentDate ?? '',
  }];

  if (!isFirebaseConfigured) {
    updatedLessons.forEach(({ lesson, entries, average }) => {
      const target = mockCompletedLessons.find((item) => item.id === lesson.id);
      if (target) {
        target.topicUnderstandingScores = entries;
        target.understandingLevel = average;
      }
    });
    exercise.topicUnderstandingScores = exerciseTopicScores;
    return { topic: topicName, understandingLevel: topicAverage, exerciseId };
  }

  ensureDb();
  const batch = writeBatch(db);
  updatedLessons.forEach(({ lesson, entries, average }) => {
    batch.update(doc(db, collections.coveredTopics, lesson.id), {
      topicUnderstandingScores: entries,
      understandingLevel: average,
      updatedAt: serverTimestamp(),
    });
  });
  const exercisePatch = { topicUnderstandingScores: exerciseTopicScores, updatedAt: serverTimestamp() };
  batch.update(doc(db, collections.dailyExerciseAssignments, exerciseId), exercisePatch);
  batch.set(doc(db, collections.submissions, exerciseId), { ...exercisePatch, exerciseId }, { merge: true });
  if (peerAssignmentId) {
    batch.update(doc(db, collections.peerMarkingAssignments, peerAssignmentId), {
      topicUnderstandingScores: exerciseTopicScores,
      updatedAt: serverTimestamp(),
    });
  }
  await batch.commit();
  return { topic: topicName, understandingLevel: topicAverage, exerciseId };
};

export const saveCompletedLesson = async ({
  studentId,
  tutorId,
  topic,
  topics,
  topicReport = '',
  understandingLevel = null,
  topicUnderstandingScores = [],
  studentName,
  subject = DEFAULT_SUBJECT,
  lessonDate,
  lessonType = 'online',
  whatsappLessonLink = '',
  locationDetails = '',
  status = 'completed',
}) => {
  const lessonAccessDetails = {
    whatsappLessonLink: normalizeWhatsAppLessonLink(whatsappLessonLink),
    locationDetails: String(locationDetails || '').trim(),
  };
  const accessContext = await requireCoOwnerAccess({ tutorId, studentId, subject });
  const completedOn = status === 'completed' ? (lessonDate || new Date().toISOString().slice(0, 10)) : '';
  const scheduledFor = lessonDate || new Date().toISOString().slice(0, 10);
  if (!isFirebaseConfigured) {
    const row = {
      id: `mock-lesson-${Date.now()}`,
      studentId,
      tutorId,
      subject,
      topic,
      topics: topics ?? (topic ? [topic] : []),
      topicUnderstandingScores,
      topicReport,
      understandingLevel,
      studentName,
      lessonDate: scheduledFor,
      lessonType,
      ...lessonAccessDetails,
      status,
      completedOn,
    };
    upsertMockLessonRows([row]);
    return row;
  }

  ensureDb();
  const ref = await addDoc(collection(db, collections.coveredTopics), {
    studentId,
    tutorId,
    subject,
    topic,
    topics: topics ?? (topic ? [topic] : []),
    topicUnderstandingScores,
    note: topicReport,
    topicReport,
    understandingLevel,
    studentName,
    lessonDate: scheduledFor,
    lessonType,
    ...lessonAccessDetails,
      status,
      completedOn,
      assignmentPeriodId: accessContext.assignmentPeriodId,
      createdAt: serverTimestamp(),
  });
  return { id: ref.id, studentId, tutorId, subject, topic, topics: topics ?? (topic ? [topic] : []), topicUnderstandingScores, topicReport, understandingLevel, studentName, lessonDate: scheduledFor, lessonType, ...lessonAccessDetails, status, completedOn };
};

export const savePlannedLessonSession = async ({
  tutorId,
  subject = DEFAULT_SUBJECT,
  students = [],
  topics = [],
  lessonDate,
  lessonType = 'online',
  whatsappLessonLink = '',
  locationDetails = '',
  sessionMode = 'one-on-one',
  groupSessionId = '',
}) => {
  const uniqueStudents = [...new Map(students.map((student) => [`${student.studentId}:${subject}`, student])).values()];
  if (!tutorId || !subject || !lessonDate || !uniqueStudents.length) throw new Error('Choose a subject, date, and at least one student.');
  if (!topics.length) throw new Error('Choose at least one planned topic.');
  if (sessionMode === 'group' && uniqueStudents.length < 2) throw new Error('A group lesson needs at least two students.');
  if (sessionMode === 'one-on-one' && uniqueStudents.length !== 1) throw new Error('Choose exactly one student for a one-on-one lesson.');
  if (sessionMode === 'group' && !groupSessionId) throw new Error('A group lesson needs a session reference.');
  if (sessionMode === 'group' && new Set(uniqueStudents.map((student) => student.grade || '')).size !== 1) throw new Error('All students in a group lesson must be in the same grade.');
  if (uniqueStudents.length > 500) throw new Error('A lesson session can include up to 500 students.');
  if (!['online', 'inPerson'].includes(lessonType)) throw new Error('Choose online or in-person for this lesson.');
  const lessonAccessDetails = {
    whatsappLessonLink: normalizeWhatsAppLessonLink(whatsappLessonLink),
    locationDetails: String(locationDetails || '').trim(),
  };

  const accessContexts = await Promise.all(uniqueStudents.map((student) =>
    requireCoOwnerAccess({ tutorId, studentId: student.studentId, subject }),
  ));
  const plannedRows = uniqueStudents.map((student, index) => ({
    id: `planned-${groupSessionId || Date.now()}-${index}`,
    studentId: student.studentId,
    tutorId,
    subject,
    topic: topics[0],
    topics,
    topicUnderstandingScores: [],
    topicReport: '',
    understandingLevel: null,
    studentName: student.displayName || student.name || student.email || 'Student',
    grade: student.grade || '',
    lessonDate,
    lessonType,
    ...lessonAccessDetails,
    sessionMode,
    groupSessionId: sessionMode === 'group' ? groupSessionId : '',
    groupStudentCount: sessionMode === 'group' ? uniqueStudents.length : 1,
    attendanceStatus: 'pending',
    status: 'planned',
    completedOn: '',
    assignmentPeriodId: accessContexts[index].assignmentPeriodId,
  }));

  if (!isFirebaseConfigured) {
    upsertMockLessonRows(plannedRows);
    return plannedRows;
  }
  ensureDb();
  const batch = writeBatch(db);
  plannedRows.forEach((row) => {
    const ref = doc(collection(db, collections.coveredTopics));
    row.id = ref.id;
    batch.set(ref, {
      ...row,
      topicReport: '',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  });
  await batch.commit();
  return plannedRows;
};

export const getLessonsByGroupSessionId = async (groupSessionId) => {
  if (!groupSessionId) return [];
  if (!isFirebaseConfigured) return mockCompletedLessons
    .filter((lesson) => lesson.groupSessionId === groupSessionId)
    .sort((left, right) => String(left.studentName || '').localeCompare(String(right.studentName || '')));
  ensureDb();
  const snapshot = await getDocs(query(
    collection(db, collections.coveredTopics),
    where('groupSessionId', '==', groupSessionId),
  ));
  return snapshot.docs.map((item) => ({ id: item.id, ...item.data() }))
    .sort((left, right) => String(left.studentName || '').localeCompare(String(right.studentName || '')));
};

export const updatePlannedLessonDetails = async ({ tutorId, lessonRows = [], lessonType, whatsappLessonLink = '', locationDetails = '' }) => {
  if (!tutorId || !lessonRows.length || lessonRows.some((lesson) => lesson.status !== 'planned')) {
    throw new Error('Only a scheduled lesson can be changed before it is logged.');
  }
  if (lessonRows.length > 500) throw new Error('A lesson session can include up to 500 students.');
  if (!['online', 'inPerson'].includes(lessonType)) throw new Error('Choose online or in-person for this lesson.');
  const lessonAccessDetails = {
    whatsappLessonLink: normalizeWhatsAppLessonLink(whatsappLessonLink),
    locationDetails: String(locationDetails || '').trim(),
  };
  const first = lessonRows[0];
  if (lessonRows.some((lesson) => lesson.groupSessionId !== first.groupSessionId || lesson.sessionMode !== first.sessionMode)) {
    throw new Error('The selected lesson records do not belong to the same session.');
  }
  if ((!first.groupSessionId && lessonRows.length !== 1) || (first.sessionMode === 'group' && !first.groupSessionId)) {
    throw new Error('A group lesson update must include its complete group session.');
  }
  await Promise.all(lessonRows.map((lesson) =>
    requireCoOwnerAccess({ tutorId, studentId: lesson.studentId, subject: lesson.subject ?? DEFAULT_SUBJECT }),
  ));
  const updatedRows = lessonRows.map((lesson) => ({ ...lesson, lessonType, ...lessonAccessDetails }));
  if (!isFirebaseConfigured) {
    upsertMockLessonRows(updatedRows);
    return updatedRows;
  }
  ensureDb();
  const batch = writeBatch(db);
  lessonRows.forEach((lesson) => batch.update(doc(db, collections.coveredTopics, lesson.id), {
    lessonType,
    ...lessonAccessDetails,
    updatedAt: serverTimestamp(),
  }));
  await batch.commit();
  return updatedRows;
};

export const updatePlannedLessonRoster = async ({ tutorId, lessonRows = [], addStudents = [], removeLessonIds = [] }) => {
  if (!tutorId || !lessonRows.length || lessonRows.some((lesson) => lesson.sessionMode !== 'group' || !lesson.groupSessionId || lesson.status !== 'planned')) {
    throw new Error('Only a planned group lesson roster can be changed.');
  }
  const groupSessionId = lessonRows[0].groupSessionId;
  const subject = lessonRows[0].subject ?? DEFAULT_SUBJECT;
  const grade = lessonRows[0].grade ?? '';
  if (lessonRows.some((lesson) => lesson.groupSessionId !== groupSessionId || (lesson.subject ?? DEFAULT_SUBJECT) !== subject || (lesson.grade ?? '') !== grade)) {
    throw new Error('The selected lesson records do not belong to the same subject, grade, and group.');
  }
  const removeIds = new Set(removeLessonIds);
  if ([...removeIds].some((id) => !lessonRows.some((lesson) => lesson.id === id))) throw new Error('A selected student is not part of this group.');
  const remaining = lessonRows.filter((lesson) => !removeIds.has(lesson.id));
  const existingStudentIds = new Set(remaining.map((lesson) => lesson.studentId));
  const additions = [...new Map(addStudents
    .filter((student) => student?.studentId && !existingStudentIds.has(student.studentId))
    .map((student) => [student.studentId, student])).values()];
  if (additions.some((student) => (student.subject ?? subject) !== subject || (student.grade ?? '') !== grade)) {
    throw new Error('Added students must match this group’s subject and grade.');
  }
  const nextCount = remaining.length + additions.length;
  if (nextCount < 2) throw new Error('A group lesson must keep at least two students.');
  if (nextCount > 500) throw new Error('A group lesson can include up to 500 students.');
  if (!removeIds.size && !additions.length) return lessonRows;

  const accessContexts = await Promise.all(additions.map((student) =>
    requireCoOwnerAccess({ tutorId, studentId: student.studentId, subject }),
  ));
  await Promise.all(lessonRows.map((lesson) =>
    requireCoOwnerAccess({ tutorId, studentId: lesson.studentId, subject }),
  ));
  const addedRows = additions.map((student, index) => ({
    id: `planned-${groupSessionId}-${student.studentId}`,
    studentId: student.studentId,
    tutorId,
    subject,
    grade,
    topic: lessonRows[0].topic || lessonRows[0].topics?.[0] || '',
    topics: lessonRows[0].topics ?? [],
    topicUnderstandingScores: [],
    topicReport: '',
    understandingLevel: null,
    studentName: student.displayName || student.name || student.email || 'Student',
    lessonDate: lessonRows[0].lessonDate,
    lessonType: lessonRows[0].lessonType || 'online',
    whatsappLessonLink: lessonRows[0].whatsappLessonLink || '',
    locationDetails: lessonRows[0].locationDetails || '',
    sessionMode: 'group',
    groupSessionId,
    groupStudentCount: nextCount,
    attendanceStatus: 'pending',
    attended: null,
    status: 'planned',
    completedOn: '',
    assignmentPeriodId: accessContexts[index].assignmentPeriodId,
  }));
  const nextRows = [
    ...remaining.map((lesson) => ({ ...lesson, groupStudentCount: nextCount })),
    ...addedRows,
  ];
  if (!isFirebaseConfigured) {
    removeMockLessonRows([...removeIds]);
    upsertMockLessonRows(nextRows);
    return nextRows;
  }

  const writeCount = removeIds.size + remaining.length + additions.length;
  if (writeCount > 500) throw new Error('This roster change is too large to save atomically. Add or remove students in separate steps.');
  ensureDb();
  const batch = writeBatch(db);
  lessonRows.filter((lesson) => removeIds.has(lesson.id)).forEach((lesson) => batch.delete(doc(db, collections.coveredTopics, lesson.id)));
  remaining.forEach((lesson) => batch.update(doc(db, collections.coveredTopics, lesson.id), {
    groupStudentCount: nextCount,
    updatedAt: serverTimestamp(),
  }));
  addedRows.forEach((row) => {
    const ref = doc(collection(db, collections.coveredTopics));
    row.id = ref.id;
    batch.set(ref, { ...row, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
  });
  await batch.commit();
  return nextRows;
};

export const completeLessonSession = async ({
  tutorId,
  lessonRows = [],
  topics = [],
  lessonDate,
  lessonType,
  whatsappLessonLink = '',
  locationDetails = '',
  participants = [],
}) => {
  if (!tutorId || !lessonRows.length || !lessonDate || !topics.length) throw new Error('The lesson, date, and at least one topic are required.');
  if (lessonRows.length > 500) throw new Error('A lesson session can include up to 500 students.');
  if (!['online', 'inPerson'].includes(lessonType)) throw new Error('Choose online or in-person for this lesson.');
  const lessonAccessDetails = {
    whatsappLessonLink: normalizeWhatsAppLessonLink(whatsappLessonLink),
    locationDetails: String(locationDetails || '').trim(),
  };
  const participantByLessonId = new Map(participants.map((participant) => [participant.lessonId, participant]));
  if (lessonRows.some((lesson) => !participantByLessonId.has(lesson.id))) throw new Error('Attendance details are missing for one or more students.');

  const contexts = await Promise.all(lessonRows.map((lesson) =>
    requireCoOwnerAccess({ tutorId, studentId: lesson.studentId, subject: lesson.subject ?? DEFAULT_SUBJECT }),
  ));
  const updates = lessonRows.map((lesson, index) => {
    const participant = participantByLessonId.get(lesson.id);
    const attended = participant.attended === true;
    const report = String(participant.topicReport || '').trim();
    const scoreByTopic = participant.scores || {};
    if (attended && !report) throw new Error(`Add a report for ${lesson.studentName || 'each attending student'}.`);
    const scores = attended ? topics.map((topic) => ({ topic, understandingLevel: Number(scoreByTopic[topic]), topicReport: report })) : [];
    if (attended && scores.some((entry) => !Number.isFinite(entry.understandingLevel) || entry.understandingLevel < 0 || entry.understandingLevel > 10)) {
      throw new Error(`Enter a score from 0 to 10 for every topic for ${lesson.studentName || 'each attending student'}.`);
    }
    const understandingLevel = scores.length
      ? Math.round(scores.reduce((sum, entry) => sum + entry.understandingLevel, 0) / scores.length)
      : null;
    return {
      lesson,
      accessContext: contexts[index],
      patch: {
        topics,
        topic: topics[0],
        topicUnderstandingScores: scores,
        topicReport: attended ? report : '',
        note: attended ? report : '',
        understandingLevel,
        lessonDate,
        lessonType,
        ...lessonAccessDetails,
        attendanceStatus: attended ? 'attended' : 'missed',
        attended,
        status: attended ? 'completed' : 'missed',
        completedOn: attended ? lessonDate : '',
      },
    };
  });

  if (!isFirebaseConfigured) {
    const updatedRows = updates.map(({ lesson, patch }) => ({ ...lesson, ...patch }));
    upsertMockLessonRows(updatedRows);
    return updatedRows;
  }
  ensureDb();
  const batch = writeBatch(db);
  updates.forEach(({ lesson, accessContext, patch }) => {
    batch.update(doc(db, collections.coveredTopics, lesson.id), {
      ...patch,
      assignmentPeriodId: accessContext.assignmentPeriodId ?? lesson.assignmentPeriodId ?? null,
      updatedAt: serverTimestamp(),
    });
  });
  await batch.commit();
  return updates.map(({ lesson, patch }) => ({ ...lesson, ...patch }));
};

export const deleteLessonSession = async ({ tutorId, lessonRows = [] }) => {
  if (!tutorId || !lessonRows.length) throw new Error('Choose a lesson session to delete.');
  if (lessonRows.length > 500) throw new Error('A lesson session can include up to 500 students.');
  await Promise.all(lessonRows.map((lesson) =>
    requireCoOwnerAccess({ tutorId, studentId: lesson.studentId, subject: lesson.subject ?? DEFAULT_SUBJECT }),
  ));
  if (!isFirebaseConfigured) {
    removeMockLessonRows(lessonRows.map((lesson) => lesson.id));
    return { deleted: true, count: lessonRows.length };
  }
  ensureDb();
  const batch = writeBatch(db);
  lessonRows.forEach((lesson) => batch.delete(doc(db, collections.coveredTopics, lesson.id)));
  await batch.commit();
  return { deleted: true, count: lessonRows.length };
};

export const getTopicResolverSourceRecords = async ({ subject, grade } = {}) => {
  if (!subject || !grade || grade === 'Select Grade') throw new Error('Choose a subject and grade before searching.');
  if (!isFirebaseConfigured) {
    const records = [];
    mockQuestionPapers.forEach((paper) => (paper.topics ?? []).forEach((topic) => records.push({
      subject: paper.subject,
      grade: paper.grade,
      topic,
      sourceType: 'paper',
      sourceLabel: paper.displayName || paper.title || paper.id,
    })));
    mockCompletedLessons.forEach((lesson) => {
      const topics = [lesson.topic, ...(lesson.topics ?? []), ...(lesson.topicUnderstandingScores ?? []).map((item) => item.topic)].filter(Boolean);
      topics.forEach((topic) => records.push({
        subject: lesson.subject ?? DEFAULT_SUBJECT,
        grade: lesson.grade ?? '',
        topic,
        sourceType: 'lesson',
        sourceLabel: lesson.studentName || lesson.studentId || lesson.id,
      }));
    });
    return records.filter((record) => record.subject === subject && record.grade === grade);
  }

  ensureDb();
  const [paperSnapshot, lessonSnapshot, userSnapshot] = await Promise.all([
    getDocs(query(collection(db, collections.questionPapers), where('subject', '==', subject))),
    getDocs(query(collection(db, collections.coveredTopics), where('subject', '==', subject))),
    getDocs(query(collection(db, collections.users), where('grade', '==', grade))),
  ]);
  const gradeStudentIds = new Set(userSnapshot.docs.map((item) => item.id));
  const records = [];
  const addTopics = ({ rawTopics, subject, grade, sourceType, sourceLabel }) => {
    (rawTopics ?? []).forEach((value) => {
      const topic = typeof value === 'string' ? value.trim() : String(value?.topic || value?.name || value?.label || '').trim();
      if (!topic) return;
      records.push({ subject: subject || DEFAULT_SUBJECT, grade: grade || '', topic, sourceType, sourceLabel: sourceLabel || '' });
    });
  };

  paperSnapshot.docs
    .map((item) => ({ id: item.id, ...item.data() }))
    .filter((paper) => paper.grade === grade)
    .forEach((paper) => addTopics({
      rawTopics: paper.topics,
      subject: paper.subject,
      grade: paper.grade,
      sourceType: 'paper',
      sourceLabel: paper.displayName || paper.title || paper.paperFileName || paper.id,
    }));
  lessonSnapshot.docs.forEach((item) => {
    const lesson = item.data();
    if (['planned', 'missed', 'cancelled'].includes(lesson.status) || lesson.attendanceStatus === 'missed' || lesson.attended === false) return;
    if (lesson.grade ? lesson.grade !== grade : !gradeStudentIds.has(lesson.studentId)) return;
    addTopics({
      rawTopics: [lesson.topic, ...(lesson.topics ?? []), ...(lesson.topicUnderstandingScores ?? []).map((entry) => entry?.topic)],
      subject: lesson.subject,
      grade: lesson.grade || grade,
      sourceType: 'lesson',
      sourceLabel: lesson.studentName || lesson.studentId || item.id,
    });
  });
  return records.filter((record) => record.subject === subject && record.grade === grade);
};

const topicResolverMappingId = ({ subject, grade, sourceTopic }) => [subject, grade, normalizeCatalogTopicKey(sourceTopic)]
  .map((part) => String(part).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''))
  .join('__');

export const getTopicResolverMappings = async ({ subject, grade } = {}) => {
  if (!subject || !grade) throw new Error('Choose a subject and grade before loading saved mappings.');
  if (!isFirebaseConfigured) return [];
  ensureDb();
  const snapshot = await getDocs(query(
    collection(db, collections.topicResolverMappings),
    where('subject', '==', subject),
    where('grade', '==', grade),
  ));
  return snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
};

export const saveTopicResolverMappings = async ({ subject, grade, rows = [], adminId } = {}) => {
  if (!subject || !grade || !Array.isArray(rows) || !rows.length) throw new Error('There are no topic mappings to save.');
  if (!adminId) throw new Error('The signed-in admin could not be verified.');
  const allowedTopics = new Set(getHardcodedTopics({ subject, grade }));
  const uniqueRows = new Map();
  rows.forEach((row) => {
    const sourceTopic = String(row?.sourceTopic ?? '').trim();
    const canonicalTopic = String(row?.canonicalTopic ?? '').trim();
    if (!sourceTopic || !allowedTopics.has(canonicalTopic)) {
      throw new Error(`Choose a valid ${subject}, ${grade} topic for every source topic before saving.`);
    }
    uniqueRows.set(normalizeCatalogTopicKey(sourceTopic), { sourceTopic, canonicalTopic });
  });
  if (!isFirebaseConfigured) return { savedCount: uniqueRows.size };

  ensureDb();
  const entries = [...uniqueRows.values()];
  let savedCount = 0;
  for (let offset = 0; offset < entries.length; offset += 400) {
    const batch = writeBatch(db);
    entries.slice(offset, offset + 400).forEach(({ sourceTopic, canonicalTopic }) => {
      const id = topicResolverMappingId({ subject, grade, sourceTopic });
      batch.set(doc(db, collections.topicResolverMappings, id), {
        subject,
        grade,
        sourceTopic,
        canonicalTopic,
        savedBy: adminId,
        savedAt: serverTimestamp(),
      }, { merge: true });
      savedCount += 1;
    });
    await batch.commit();
  }
  return { savedCount };
};

export const resolveTopicsWithGemini = async ({ subject, grade, topics = [], allowedTopics = [] } = {}) => {
  if (!isFirebaseConfigured) throw new Error('Connect to Firebase to resolve topics with Gemini.');
  if (!Array.isArray(topics) || !topics.length || !Array.isArray(allowedTopics) || !allowedTopics.length) {
    throw new Error('Provide unresolved topics and the local topic catalog.');
  }
  const callable = httpsCallable(functions, 'resolveTopicsWithGemini');
  const response = await callable({ subject, grade, topics, allowedTopics });
  return response.data;
};

export const assignStudentToTutor = async ({ studentId, tutorId, subject = DEFAULT_SUBJECT }) => {
  if (!isFirebaseConfigured) {
    return { id: 'mock-assignment', studentId, tutorId, subject };
  }
  ensureDb();

  const callable = httpsCallable(functions, 'assignStudentToTutor');
  return (await callable({ studentId, tutorId, subject })).data;
};

export const getAdminSubjectAssignmentData = async (subject = DEFAULT_SUBJECT) => {
  if (!isFirebaseConfigured) {
    const students = demoUsers.filter((user) => user.role === 'student' && getUserSubjects(user).includes(subject));
    const tutors = getApprovedTutorOrTeacherProfiles(demoUsers, subject);
    const assignments = mockStudentAssignments
      .filter((assignment) => assignment.active !== false && (assignment.subject ?? DEFAULT_SUBJECT) === subject)
      .map((assignment) => {
        const student = students.find((item) => item.uid === assignment.studentId);
        const tutor = tutors.find((item) => item.uid === assignment.tutorId);
        const isTeacher = isTeacherProfile(tutor);
        return {
          ...assignment,
          id: `${assignment.studentId}-${assignment.tutorId}-${subject}`,
          studentName: student?.displayName ?? student?.email ?? 'Student',
          tutorName: tutor?.displayName ?? tutor?.email ?? 'Tutor',
          tutorRoleLabel: isTeacher ? 'Teacher' : 'Tutor',
        };
      });
    const assignedStudentIds = new Set(assignments.map((assignment) => assignment.studentId));

    return {
      students,
      tutors,
      assignments,
      unassignedStudents: students.filter((student) => !assignedStudentIds.has(student.uid)),
    };
  }

  ensureDb();
  const [usersSnapshot, assignmentsSnapshot] = await Promise.all([
    getDocs(collection(db, collections.users)),
    getDocs(query(
      collection(db, collections.tutorStudentAssignments),
      where('subject', '==', subject),
      where('active', '==', true),
    )),
  ]);

  const users = usersSnapshot.docs.map((item) => item.data());
  const students = users.filter((user) => user.role === 'student' && getUserSubjects(user).includes(subject));
  const tutors = getApprovedTutorOrTeacherProfiles(users, subject);
  const studentMap = new Map(students.map((student) => [student.uid, student]));
  const tutorMap = new Map(tutors.map((tutor) => [tutor.uid, tutor]));
  const assignments = assignmentsSnapshot.docs.map((item) => {
    const assignment = { id: item.id, ...item.data() };
    const student = studentMap.get(assignment.studentId);
    const tutor = tutorMap.get(assignment.tutorId);
    const isTeacher = isTeacherProfile(tutor);
    return {
      ...assignment,
      studentName: student?.displayName ?? student?.email ?? 'Student',
      tutorName: tutor?.displayName ?? tutor?.email ?? 'Tutor',
      tutorRoleLabel: isTeacher ? 'Teacher' : 'Tutor',
    };
  }).filter((assignment) => studentMap.has(assignment.studentId));
  const assignedStudentIds = new Set(assignments.map((assignment) => assignment.studentId));

  return {
    students,
    tutors,
    assignments,
    unassignedStudents: students.filter((student) => !assignedStudentIds.has(student.uid)),
  };
};

export const getQuestionPapers = async ({ grade, region, subject = DEFAULT_SUBJECT } = {}) => {
  if (!isFirebaseConfigured) {
    return filterQuestionPapers(mockQuestionPapers, { grade, region, subject, allowNational: true });
  }

  ensureDb();
  const snapshot = await getDocs(query(collection(db, collections.questionPapers), where('subject', '==', subject)));
  return filterQuestionPapers(
    snapshot.docs.map((item) => ({ id: item.id, ...item.data() })).filter(isAnalyzedQuestionPaper),
    { grade, region, subject, allowNational: true },
  );
};

export const getAllQuestionPapers = async () => {
  if (!isFirebaseConfigured) {
    return mockQuestionPapers;
  }

  ensureDb();
  const snapshot = await getDocs(query(collection(db, collections.questionPapers), orderBy('year', 'desc')));
  return snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
};

export const getQuestionPapersByIds = async (ids) => {
  if (!isFirebaseConfigured) {
    return mockQuestionPapers.filter((paper) => ids.includes(paper.id));
  }

  ensureDb();
  const promises = ids.map((id) => getDoc(doc(db, collections.questionPapers, id)));
  const snapshots = await Promise.all(promises);
  return snapshots.filter((snap) => snap.exists()).map((snap) => ({ id: snap.id, ...snap.data() }));
};

export const getQuestionPaperById = async (id) => {
  if (!id) return null;
  if (!isFirebaseConfigured) return mockQuestionPapers.find((paper) => paper.id === id) ?? null;
  ensureDb();
  const snapshot = await getDoc(doc(db, collections.questionPapers, id));
  return snapshot.exists() ? { id: snapshot.id, ...snapshot.data() } : null;
};

export const subscribeQuestionPaperAnalysisActivity = (paperId, callback) => {
  if (!paperId || !isFirebaseConfigured) {
    callback([]);
    return () => {};
  }
  ensureDb();
  const runsRef = collection(db, collections.questionPapers, paperId, 'analysisRuns');
  const runUnsubscribers = new Map();
  const runData = new Map();
  let stopped = false;

  const publish = () => {
    const activity = [...runData.entries()].flatMap(([runId, run]) =>
      (run.batches ?? []).map((batch) => ({ ...batch, runId, runStatus: run.status }))
    );
    callback(activity);
  };

  const unsubscribeRuns = onSnapshot(runsRef, (snapshot) => {
    const existingIds = new Set(snapshot.docs.map((item) => item.id));
    for (const [runId, unsubscribe] of runUnsubscribers) {
      if (!existingIds.has(runId)) {
        unsubscribe();
        runUnsubscribers.delete(runId);
        runData.delete(runId);
      }
    }
    snapshot.docs.forEach((runSnapshot) => {
      const runId = runSnapshot.id;
      const run = { ...runSnapshot.data(), batches: runData.get(runId)?.batches ?? [] };
      runData.set(runId, run);
      if (!runUnsubscribers.has(runId)) {
        const batchesRef = collection(db, collections.questionPapers, paperId, 'analysisRuns', runId, 'batches');
        const unsubscribe = onSnapshot(batchesRef, (batchesSnapshot) => {
          if (stopped) return;
          const currentRun = runData.get(runId) ?? run;
          currentRun.batches = batchesSnapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
          runData.set(runId, currentRun);
          publish();
        });
        runUnsubscribers.set(runId, unsubscribe);
      }
    });
    publish();
  });

  return () => {
    stopped = true;
    unsubscribeRuns();
    runUnsubscribers.forEach((unsubscribe) => unsubscribe());
    runUnsubscribers.clear();
  };
};

export const subscribeQuestionPapers = (callback) => {
  if (!isFirebaseConfigured) {
    callback(mockQuestionPapers);
    return () => {};
  }
  ensureDb();
  return onSnapshot(collection(db, collections.questionPapers), (snapshot) => {
    callback(snapshot.docs.map((item) => ({ id: item.id, ...item.data() })));
  });
};

const getQuestionPaperDuplicateFields = (paper = {}) => ({
  grade: paper.grade ?? '',
  region: paper.region ?? '',
  subject: paper.subject ?? DEFAULT_SUBJECT,
  year: Number(paper.year),
  month: paper.month ?? '',
  paperNumber: paper.paperNumber ?? 'Paper 1',
});

const getQuestionPaperDisplayName = ({ subject, grade, region, month, year, paperNumber, copyNumber }) => {
  const base = [subject, grade, region, month, year, paperNumber].filter(Boolean).join(' • ');
  return copyNumber > 0 ? `${base} (${copyNumber})` : base;
};

export const saveQuestionPaper = async (paper) => {
  const duplicateFields = getQuestionPaperDuplicateFields(paper);
  const demoMatches = mockQuestionPapers.filter((item) => {
    const itemFields = getQuestionPaperDuplicateFields(item);
    return itemFields.region === duplicateFields.region &&
      itemFields.subject === duplicateFields.subject &&
      itemFields.grade === duplicateFields.grade &&
      itemFields.year === duplicateFields.year &&
      itemFields.month === duplicateFields.month &&
      itemFields.paperNumber === duplicateFields.paperNumber;
  });

  if (!isFirebaseConfigured) {
    const copyNumber = demoMatches.length;
    const payload = {
      ...paper,
      ...duplicateFields,
      copyNumber,
      copySuffix: copyNumber > 0 ? `(${copyNumber})` : '',
      displayName: getQuestionPaperDisplayName({ ...duplicateFields, copyNumber }),
    };
    return { id: `mock-paper-${Date.now()}`, ...payload };
  }

  ensureDb();
  const duplicateSnapshot = await getDocs(
    query(
      collection(db, collections.questionPapers),
      where('region', '==', duplicateFields.region),
      where('subject', '==', duplicateFields.subject),
      where('grade', '==', duplicateFields.grade),
      where('year', '==', duplicateFields.year),
      where('month', '==', duplicateFields.month),
      where('paperNumber', '==', duplicateFields.paperNumber),
    ),
  );
  const copyNumber = duplicateSnapshot.size;
  const payload = {
    ...paper,
    ...duplicateFields,
    copyNumber,
    copySuffix: copyNumber > 0 ? `(${copyNumber})` : '',
    displayName: getQuestionPaperDisplayName({ ...duplicateFields, copyNumber }),
    createdAt: serverTimestamp(),
    ...(paper.analysisStatus === 'Analyzing' ? {
      analysisRequestedAt: serverTimestamp(),
      analysisTopicOptions: getHardcodedTopics({ subject: duplicateFields.subject, grade: duplicateFields.grade }),
    } : {}),
  };

  const ref = await addDoc(collection(db, collections.questionPapers), payload);
  return { id: ref.id, ...payload };
};



export const updateQuestionPaper = async (paperId, patch) => {
  if (!paperId) throw new Error('Question paper id is required.');
  if (!isFirebaseConfigured) return { id: paperId, ...patch };
  ensureDb();
  const paperRef = doc(db, collections.questionPapers, paperId);
  const currentPaper = patch.analysisStatus === 'Analyzing' ? await getDoc(paperRef) : null;
  const currentData = currentPaper?.exists() ? currentPaper.data() : {};
  const subject = patch.subject ?? currentData.subject;
  const grade = patch.grade ?? currentData.grade;
  const payload = {
    ...patch,
    ...(patch.analysisStatus === 'Analyzing' ? {
      analysisRequestedAt: serverTimestamp(),
      analysisTopicOptions: getHardcodedTopics({ subject, grade }),
    } : {}),
    updatedAt: serverTimestamp(),
  };
  await updateDoc(paperRef, payload);
  return { id: paperId, ...payload };
};

export const cancelQuestionPaperAnalysis = async (paperId) => {
  if (!paperId) throw new Error('Question paper id is required.');
  if (!isFirebaseConfigured) return { paperId, status: 'Cancelled' };
  if (!functions) throw new Error('Firebase Functions are not configured.');
  const callable = httpsCallable(functions, 'cancelQuestionPaperAnalysis');
  const response = await callable({ paperId });
  return response.data;
};

export const getPeerMarkingAssignmentsForStudent = async (reviewerId) => {
  if (!reviewerId) return [];
  if (!isFirebaseConfigured) return [];
  ensureDb();
  const snapshot = await getDocs(query(
    collection(db, collections.peerMarkingAssignments),
    where('reviewerId', '==', reviewerId),
  ));
  return snapshot.docs
    .map((item) => ({ id: item.id, ...item.data() }))
    .filter((item) => item.status !== 'completed')
    .sort((left, right) => String(right.assignmentDate ?? '').localeCompare(String(left.assignmentDate ?? '')));
};


export const subscribePeerMarkingAssignmentsForStudent = (reviewerId, onChange) => {
  if (!reviewerId || !isFirebaseConfigured) {
    onChange([]);
    return () => {};
  }
  ensureDb();
  const peerQuery = query(
    collection(db, collections.peerMarkingAssignments),
    where('reviewerId', '==', reviewerId),
  );
  return onSnapshot(peerQuery, (snapshot) => {
    const rows = snapshot.docs
      .map((item) => ({ id: item.id, ...item.data() }))
      .filter((item) => item.status !== 'completed')
      .sort((left, right) => String(right.assignmentDate ?? '').localeCompare(String(left.assignmentDate ?? '')));
    onChange(rows);
  });
};

export const completePeerMarkingAssignment = async ({ assignmentId, reviewerId, reviewImages = [], reviewImageUrl, reviewFileName }) => {
  const pages = reviewImages.length ? reviewImages : reviewImageUrl ? [{ url: reviewImageUrl, fileName: reviewFileName }] : [];
  if (!assignmentId || !reviewerId || !pages.length) throw new Error('Reviewer, peer-marking assignment, and marked images are required.');
  const primaryPage = pages[0];
  if (!isFirebaseConfigured) return { id: assignmentId, reviewImageUrl: primaryPage.url, reviewFileName: primaryPage.fileName, reviewImages: pages, status: 'completed' };
  ensureDb();
  const assignmentRef = doc(db, collections.peerMarkingAssignments, assignmentId);
  const assignmentSnap = await getDoc(assignmentRef);
  if (!assignmentSnap.exists()) throw new Error('Peer marking assignment not found.');
  const assignment = assignmentSnap.data();
  if (assignment.reviewerId !== reviewerId || assignment.status === 'completed') throw new Error('This peer-marking assignment is not available to you.');
  if (!assignment.exerciseId || !assignment.reviewerExerciseId || !assignment.reviewerId || !assignment.revieweeId) {
    throw new Error('This peer-marking assignment is missing its exercise links.');
  }
  const [targetExerciseSnap, reviewerExerciseSnap] = await Promise.all([
    getDoc(doc(db, collections.dailyExerciseAssignments, assignment.exerciseId)),
    getDoc(doc(db, collections.dailyExerciseAssignments, assignment.reviewerExerciseId)),
  ]);
  if (!targetExerciseSnap.exists() || !reviewerExerciseSnap.exists()) throw new Error('The linked peer-marking exercise could not be found.');
  if (assignment.exerciseId === assignment.reviewerExerciseId || targetExerciseSnap.data().studentId !== assignment.revieweeId || reviewerExerciseSnap.data().studentId !== assignment.reviewerId) {
    throw new Error('The peer-marking exercise links do not match the assigned learners.');
  }
  const targetExerciseRef = targetExerciseSnap.ref;
  const targetSubmissionRef = doc(db, collections.submissions, assignment.exerciseId);
  const completion = {
    reviewImageUrl: primaryPage.url,
    reviewFileName: primaryPage.fileName,
    reviewImages: pages,
    markedExerciseId: assignment.exerciseId,
    reviewerExerciseId: assignment.reviewerExerciseId,
    status: 'completed',
    completedAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
  const batch = writeBatch(db);
  batch.update(assignmentRef, completion);
  const peerMarkFields = {
    peerReviewed: 'Yes',
    peerReviewStatus: 'completed',
    peerReviewDate: serverTimestamp(),
    peerMarkedImageUrl: primaryPage.url,
    peerMarkedFileName: primaryPage.fileName,
    peerMarkedImages: pages,
    submittedReviewImageUrl: primaryPage.url,
    submittedReviewFileName: primaryPage.fileName,
    submittedReviewImages: pages,
    peerReviewerId: assignment.reviewerId,
    peerReviewerExerciseId: assignment.reviewerExerciseId,
    peerMarkingAssignmentId: assignmentId,
    markedExerciseId: assignment.exerciseId,
  };
  batch.update(targetExerciseRef, { ...peerMarkFields, updatedAt: serverTimestamp() });
  batch.update(reviewerExerciseSnap.ref, {
    peerMarkingImageUrl: primaryPage.url,
    peerMarkingFileName: primaryPage.fileName,
    peerMarkingImages: pages,
    markedPeerExerciseId: assignment.exerciseId,
    peerMarkingAssignmentId: assignmentId,
    peerMarkingRevieweeId: assignment.revieweeId,
    peerMarkingStatus: 'completed',
    updatedAt: serverTimestamp(),
  });
  batch.set(targetSubmissionRef, {
    ...completion,
    ...peerMarkFields,
    exerciseId: assignment.exerciseId,
    updatedAt: serverTimestamp(),
  }, { merge: true });
  await batch.commit();
  return { id: assignmentId, reviewImageUrl, reviewFileName, status: 'completed' };
};

export const saveTutorPeerMarkingReview = async ({ tutorId, peerAssignmentId, understandingLevel }) => {
  const score = Number(understandingLevel);
  if (!tutorId || !peerAssignmentId) throw new Error('Tutor and peer-marking assignment are required.');
  if (understandingLevel === '' || understandingLevel === null || understandingLevel === undefined) throw new Error('Enter an understanding score from 0 to 10.');
  if (understandingLevel === '' || understandingLevel === null || understandingLevel === undefined) throw new Error('Enter an understanding score from 0 to 10.');
  if (!Number.isFinite(score) || score < 0 || score > 10) throw new Error('Enter an understanding score from 0 to 10.');
  if (!isFirebaseConfigured) return { peerAssignmentId, understandingLevel: score, reviewed: true };

  ensureDb();
  const assignmentRef = doc(db, collections.peerMarkingAssignments, peerAssignmentId);
  const assignmentSnap = await getDoc(assignmentRef);
  if (!assignmentSnap.exists()) throw new Error('Peer-marking assignment not found.');
  const assignment = assignmentSnap.data();
  if (assignment.status !== 'completed' || !assignment.reviewImageUrl || !assignment.reviewerId || !assignment.exerciseId) {
    throw new Error('Only completed peer-marking work can be reviewed.');
  }
  const subject = assignment.subject ?? DEFAULT_SUBJECT;
  const reviewerContext = await requireTutorAccess({ tutorId, studentId: assignment.reviewerId, subject, allowedRoles: ['co-owner', 'marker'] });

  const [targetExercise, reviewerExerciseSnap, topicSnapshot] = await Promise.all([
    getExerciseAssignmentById(assignment.exerciseId),
    assignment.reviewerExerciseId
      ? getDoc(doc(db, collections.dailyExerciseAssignments, assignment.reviewerExerciseId))
      : Promise.resolve(null),
    getDocs(query(
      collection(db, collections.coveredTopics),
      where('studentId', '==', assignment.reviewerId),
      where('subject', '==', subject),
    )),
  ]);
  if (!targetExercise || targetExercise.studentId !== assignment.revieweeId) throw new Error('The marked exercise does not match this peer assignment.');
  if (assignment.reviewerExerciseId && (!reviewerExerciseSnap?.exists() || reviewerExerciseSnap.data().studentId !== assignment.reviewerId)) {
    throw new Error('The reviewer exercise does not match this peer assignment.');
  }

  const topic = String(assignment.topic || targetExercise.topic || '').trim();
  if (!topic) throw new Error('No topic is attached to the marked exercise.');
  const topicDocs = topicSnapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
  const matchingTopics = topicDocs.filter((lesson) => getLessonTopicEntries(lesson).some((entry) => entry.topic.toLocaleLowerCase() === topic.toLocaleLowerCase()));
  const reviewRecord = {
    peerAssignmentId,
    exerciseId: assignment.exerciseId,
    markedExerciseId: assignment.exerciseId,
    reviewerExerciseId: assignment.reviewerExerciseId ?? '',
    exerciseTitle: assignment.title ?? targetExercise.title ?? 'Peer-marked exercise',
    assignmentDate: assignment.assignmentDate ?? targetExercise.assignmentDate ?? '',
    understandingLevel: score,
    updatedAt: new Date().toISOString(),
  };
  const recordsByAssignment = new Map();
  matchingTopics.forEach((lesson) => getLessonTopicEntries(lesson).forEach((entry) => {
    if (entry.topic.toLocaleLowerCase() !== topic.toLocaleLowerCase()) return;
    (entry.exerciseScores ?? []).forEach((record) => {
      if (record?.peerAssignmentId) recordsByAssignment.set(record.peerAssignmentId, record);
    });
  }));
  recordsByAssignment.set(peerAssignmentId, reviewRecord);
  const recentRecords = [...recordsByAssignment.values()]
    .sort((left, right) => String(right.assignmentDate ?? '').localeCompare(String(left.assignmentDate ?? ''))
      || String(right.updatedAt ?? '').localeCompare(String(left.updatedAt ?? '')))
    .slice(0, 7);
  const average = Math.round(recentRecords.reduce((sum, record) => sum + Number(record.understandingLevel), 0) / recentRecords.length);
  const reviewedAt = serverTimestamp();
  const tutorReviewPatch = {
    tutorReviewStatus: 'reviewed',
    tutorReviewed: true,
    tutorReviewedBy: tutorId,
    tutorReviewedAt: reviewedAt,
    tutorUnderstandingLevel: score,
    tutorReviewTopic: topic,
    updatedAt: serverTimestamp(),
  };
  const batch = writeBatch(db);
  batch.update(assignmentRef, tutorReviewPatch);
  if (assignment.reviewerExerciseId && reviewerExerciseSnap?.exists()) {
    batch.update(reviewerExerciseSnap.ref, {
      peerMarkingTutorReviewStatus: 'reviewed',
      peerMarkingTutorReviewedBy: tutorId,
      peerMarkingTutorReviewedAt: reviewedAt,
      peerMarkingTutorUnderstandingLevel: score,
      peerMarkingTutorReviewTopic: topic,
      updatedAt: serverTimestamp(),
    });
  }

  if (matchingTopics.length) {
    matchingTopics.forEach((lesson, lessonIndex) => {
      const originalEntries = Array.isArray(lesson.topicUnderstandingScores) && lesson.topicUnderstandingScores.length
        ? lesson.topicUnderstandingScores
        : (lesson.topics?.length ? lesson.topics : [lesson.topic]).filter(Boolean).map((entryTopic) => ({ topic: entryTopic, understandingLevel: lesson.understandingLevel }));
      const entries = originalEntries.map((entry) => {
        if (String(entry.topic).trim().toLocaleLowerCase() !== topic.toLocaleLowerCase()) return entry;
        return {
          ...entry,
          understandingLevel: average,
          ...(lessonIndex === 0 ? { exerciseScores: recentRecords } : {}),
        };
      });
      const lessonAverage = Math.round(entries.reduce((sum, entry) => sum + Number(entry.understandingLevel ?? lesson.understandingLevel ?? 5), 0) / entries.length);
      batch.update(doc(db, collections.coveredTopics, lesson.id), {
        topicUnderstandingScores: entries,
        understandingLevel: lessonAverage,
        updatedAt: serverTimestamp(),
      });
    });
  } else {
    const topicEntry = { topic, understandingLevel: average, exerciseScores: recentRecords };
    batch.set(doc(collection(db, collections.coveredTopics)), {
      studentId: assignment.reviewerId,
      tutorId,
      subject,
      topic,
      topics: [topic],
      topicUnderstandingScores: [topicEntry],
      topicReport: 'Topic captured from tutor-reviewed peer marking; lesson not completed.',
      note: 'Topic captured from tutor-reviewed peer marking; lesson not completed.',
      understandingLevel: average,
      studentName: assignment.reviewerName ?? reviewerContext.displayName ?? reviewerContext.name ?? '',
      lessonDate: assignment.assignmentDate ?? new Date().toISOString().slice(0, 10),
      lessonType: 'online',
      status: 'planned',
      completedOn: '',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      source: 'peer-marking-review',
    });
  }
  await batch.commit();
  return { peerAssignmentId, topic, understandingLevel: score, averageUnderstandingLevel: average, reviewed: true };
};

export const savePeerReview = async (payload) => {
  if (!isFirebaseConfigured) return { id: 'mock-peer-review', ...payload };
  ensureDb();
  const ref = await addDoc(collection(db, collections.peerReviews), { ...payload, createdAt: serverTimestamp() });
  return { id: ref.id, ...payload };
};

export const getSubmissionById = async (submissionId) => {
  if (!isFirebaseConfigured) {
    return {
      id: submissionId,
      studentName: 'Ayanda Molefe',
      imageUrl: 'https://images.unsplash.com/photo-1455390582262-044cdead277a?auto=format&fit=crop&w=900&q=80',
      exerciseTitle: 'Quadratic factorisation',
    };
  }
  ensureDb();
  const snapshot = await getDoc(doc(db, collections.submissions, submissionId));
  return snapshot.exists() ? { id: snapshot.id, ...snapshot.data() } : null;
};

export const getExerciseAssignmentById = async (exerciseId) => {
  if (!exerciseId) return null;
  if (!isFirebaseConfigured) {
    const all = Object.values(mockDashboardData.student.exerciseHistory ?? {});
    return all.find((exercise) => exercise.id === exerciseId) ?? null;
  }
  ensureDb();
  const [snapshot, submissionSnapshot] = await Promise.all([
    getDoc(doc(db, collections.dailyExerciseAssignments, exerciseId)),
    getDoc(doc(db, collections.submissions, exerciseId)),
  ]);
  if (!snapshot.exists()) return null;
  return {
    ...(submissionSnapshot.exists() ? submissionSnapshot.data() : {}),
    ...snapshot.data(),
    id: snapshot.id,
  };
};

export const saveTutorMarkedExercise = async ({ tutorId, exerciseId, markedImages = [], markedImageUrl, markedFileName }) => {
  const pages = markedImages.length ? markedImages : markedImageUrl ? [{ url: markedImageUrl, fileName: markedFileName }] : [];
  if (!tutorId || !exerciseId || !pages.length) throw new Error('Tutor, exercise, and marked work are required.');
  const firstPage = pages[0];
  const exercise = await getExerciseAssignmentById(exerciseId);
  if (!exercise) throw new Error('Exercise assignment not found.');
  if (!exercise.submittedImageUrl) throw new Error('The student has not submitted work for this exercise yet.');
  await requireTutorAccess({ tutorId, studentId: exercise.studentId, subject: exercise.subject ?? DEFAULT_SUBJECT, allowedRoles: ['co-owner', 'marker'] });
  if (!isFirebaseConfigured) return { exerciseId, markedImageUrl: firstPage.url, markedImages: pages, markedFileName: firstPage.fileName, tutorMarkingStatus: 'completed' };
  ensureDb();
  const exerciseRef = doc(db, collections.dailyExerciseAssignments, exerciseId);

  const markedAt = serverTimestamp();
  const patch = {
    tutorMarkedImageUrl: firstPage.url,
    tutorMarkedFileName: firstPage.fileName,
    tutorMarkedImages: pages,
    tutorMarkedBy: tutorId,
    tutorMarkedAt: markedAt,
    tutorMarkingStatus: 'completed',
    markingStatus: 'completed',
    updatedAt: serverTimestamp(),
  };
  const batch = writeBatch(db);
  batch.update(exerciseRef, patch);
  batch.set(doc(db, collections.submissions, exerciseId), { ...patch, exerciseId }, { merge: true });
  await batch.commit();
  return { exerciseId, ...patch };
};

export const getCompletedPeerMarkingWorkForTutor = async ({ tutorId, studentId, subject = DEFAULT_SUBJECT }) => {
  if (!tutorId || !studentId) return [];
  const contexts = await getTutorAssignedStudentContexts(tutorId);
  if (!contexts.some((item) => item.studentId === studentId && item.subject === subject)) {
    throw new Error('This student is not assigned to you for the selected subject.');
  }
  if (!isFirebaseConfigured) return [];
  ensureDb();
  const snapshot = await getDocs(query(
    collection(db, collections.peerMarkingAssignments),
    where('reviewerId', '==', studentId),
  ));
  const assignments = snapshot.docs
    .map((item) => ({ id: item.id, ...item.data() }))
    .filter((item) => item.subject === subject && item.status === 'completed' && item.reviewImageUrl)
    .sort((left, right) => String(right.assignmentDate ?? '').localeCompare(String(left.assignmentDate ?? '')));
  return Promise.all(assignments.map(async (assignment) => ({
    ...assignment,
    targetExercise: assignment.exerciseId ? await getExerciseAssignmentById(assignment.exerciseId) : null,
  })));
};

export const deleteExerciseAssignmentForTutor = async ({ tutorId, exerciseId }) => {
  if (!tutorId || !exerciseId) throw new Error('Tutor and exercise are required to delete an assignment.');
  const exercise = await getExerciseAssignmentById(exerciseId);
  if (!exercise) throw new Error('Exercise assignment not found.');
  const now = new Date();
  const today = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');
  if (String(exercise.assignmentDate ?? '').slice(0, 10) <= today || isExerciseSubmitted(exercise)) {
    throw new Error('Only unsubmitted future exercises can be deleted.');
  }
  await requireCoOwnerAccess({ tutorId, studentId: exercise.studentId, subject: exercise.subject ?? DEFAULT_SUBJECT });
  if (!isFirebaseConfigured) return { deleted: true, storageUrls: [] };

  ensureDb();
  const [submissionSnapshot, peerAssignmentsSnapshot, peerReviewsSnapshot] = await Promise.all([
    getDoc(doc(db, collections.submissions, exerciseId)),
    getDocs(query(collection(db, collections.peerMarkingAssignments), where('exerciseId', '==', exerciseId))),
    getDocs(query(collection(db, collections.peerReviews), where('submissionId', '==', exerciseId))),
  ]);
  const submission = submissionSnapshot.exists() ? submissionSnapshot.data() : {};
  const storageUrls = [
    exercise.submittedImageUrl,
    exercise.submittedReviewImageUrl,
    exercise.tutorMarkedImageUrl,
    submission.imageUrl,
    submission.submittedImageUrl,
    submission.reviewImageUrl,
    submission.submittedReviewImageUrl,
    submission.tutorMarkedImageUrl,
    ...peerAssignmentsSnapshot.docs.map((item) => item.data()?.reviewImageUrl),
    ...peerReviewsSnapshot.docs.map((item) => item.data()?.reviewImageUrl),
  ].filter((url) => typeof url === 'string' && url.startsWith('https://'));
  const batch = writeBatch(db);
  batch.delete(doc(db, collections.dailyExerciseAssignments, exerciseId));
  if (submissionSnapshot.exists()) batch.delete(submissionSnapshot.ref);
  peerAssignmentsSnapshot.docs.forEach((item) => batch.delete(item.ref));
  peerReviewsSnapshot.docs.forEach((item) => batch.delete(item.ref));
  await batch.commit();
  return { deleted: true, storageUrls };
};

export const getSubmissionForExercise = async (exerciseId) => {
  if (!isFirebaseConfigured) {
    // Mock: assume no submission for demo
    return null;
  }
  ensureDb();
  const snapshot = await getDoc(doc(db, collections.submissions, exerciseId));
  return snapshot.exists() ? { id: snapshot.id, ...snapshot.data() } : null;
};

const generateExercisePlanUnlocked = async ({ student, mode, subject = DEFAULT_SUBJECT, latestTutorReport, completedLesson, understandingLevel, availablePapers, onProgress, overrideFutureUnsubmitted = false, targetAssignmentDates = null, dailyExerciseCaps = {}, overrideExerciseIdsByDate = {}, plannedGenerationWeek = null }) => {
  const studentState = await getStudentAccessState(student, subject);
  const subscriptionTrace = {
    paidSubscriptionActive: Boolean(studentState.paidSubscriptionActive && studentState.subscriptionPaymentVerified),
    subscriptionId: studentState.subscriptionId ?? student?.uid ?? null,
    subscriptionPlanId: studentState.subscriptionPlanId ?? 'free',
    subscriptionPlanName: studentState.subscriptionPlanName ?? 'Free',
    subscriptionPaymentReference: studentState.subscriptionPaymentReference ?? null,
  };
  if (!subscriptionTrace.paidSubscriptionActive) {
    return {
      generated: false,
      reason: `An active paid subscription covering ${subject} is required for exercise generation.`,
      criteria: { ...studentState.generationStatus, ...subscriptionTrace },
      assignments: [],
    };
  }

  const papers = availablePapers ?? studentState.matchingQuestionPapers;
  const readyCompletedLesson = completedLesson && isCompletedLessonReadyForGeneration(completedLesson) ? completedLesson : null;
  const completedLessons = readyCompletedLesson
    ? [
      ...studentState.completedLessons.filter((lesson) => !readyCompletedLesson.id || lesson.id !== readyCompletedLesson.id),
      {
        ...readyCompletedLesson,
        subject,
        topicReport: readyCompletedLesson.topicReport ?? latestTutorReport ?? studentState.latestTutorReport,
        understandingLevel: readyCompletedLesson.understandingLevel ?? understandingLevel ?? 5,
      },
    ]
    : studentState.completedLessons;
  const subjectTutorReports = [
    ...(Array.isArray(studentState.tutorReports) ? studentState.tutorReports.map((report) => report?.note).filter(Boolean) : []),
    latestTutorReport ?? studentState.latestTutorReport ?? '',
  ].filter(Boolean);
  const replacesExerciseWindow = overrideFutureUnsubmitted || Boolean(readyCompletedLesson);
  const ready = overrideFutureUnsubmitted || (mode === 'initial'
    ? Boolean(studentState.initialGenerationReady && !studentState.hasInitialGeneration)
    : Boolean(studentState.weeklyGenerationReady && studentState.hasInitialGeneration));

  if (!ready) {
    return {
      generated: false,
      reason: `Criteria not met for ${mode} generation`,
      criteria: { ...studentState.generationStatus, ...subscriptionTrace },
      assignments: [],
    };
  }

  let assignmentHistory = await getAssignmentHistory(student?.uid, subject);
  const assignmentDates = targetAssignmentDates ?? (replacesExerciseWindow
    ? getSevenDayWindow(getLocalDate())
    : buildAssignmentDates({ mode, assignmentHistory }));
  if (replacesExerciseWindow && isFirebaseConfigured && student?.uid) {
    const windowSnapshot = await getDocs(query(
      collection(db, collections.dailyExerciseAssignments),
      where('studentId', '==', student.uid),
      where('subject', '==', subject),
      where('assignmentDate', '>=', assignmentDates[0]),
      where('assignmentDate', '<=', assignmentDates.at(-1)),
      orderBy('assignmentDate', 'asc'),
    ));
    const historyById = new Map(assignmentHistory.map((assignment) => [assignment.id, assignment]));
    windowSnapshot.docs.forEach((item) => historyById.set(item.id, { id: item.id, ...item.data() }));
    assignmentHistory = [...historyById.values()];
  }
  const recentExerciseHistory = getRecentExerciseHistoryForAi(assignmentHistory, 28);

  const topicSummaries = getTopicSummary(completedLessons);
  const completedTopics = topicSummaries.map((item) => item.topic);
  const {
    selectedPapers,
    topicPaperMetadata,
    topicsWithSources,
    topicsWithoutSources,
    recentPaperIds,
    reusedRecentPapers,
    analyzedPaperCount,
    matchingAnalyzedPaperCount,
  } = selectTopicPaperMetadata({
    papers,
    assignmentHistory,
    completedTopics,
  });
  if (!topicsWithSources.length) {
    return {
      generated: false,
      reason: 'No analyzed question metadata matched the completed topics.',
      criteria: {
        ...studentState.generationStatus,
        ...subscriptionTrace,
        excludedRecentPaperIds: recentPaperIds,
        reusedRecentPapers,
        analyzedPaperCount,
        matchingAnalyzedPaperCount,
        topicsWithoutSources,
      },
      assignments: [],
    };
  }

  onProgress?.(`Using topic metadata from ${selectedPapers.length} analyzed question papers [Generating exercises]`);

  const currentGenerationNumber = mode === 'weekly'
    ? getCurrentGenerationNumber(assignmentHistory, studentState.generationRunStatus?.generationWeek)
    : 1;
  const generationNumber = mode === 'initial'
    ? 1
    : Number(plannedGenerationWeek) || (readyCompletedLesson ? currentGenerationNumber + 1 : currentGenerationNumber);
  const regenerationState = replacesExerciseWindow
    ? getRegenerationState({ history: assignmentHistory, assignmentDates, generationNumber })
    : { dailyExerciseCaps: {}, overrideExerciseIdsByDate: {} };
  const effectiveDailyExerciseCaps = { ...regenerationState.dailyExerciseCaps, ...dailyExerciseCaps };
  const effectiveOverrideExerciseIdsByDate = { ...regenerationState.overrideExerciseIdsByDate, ...overrideExerciseIdsByDate };
  const aiPlan = buildAiQuestionPlan({
    mode,
    topicSummaries,
    assignmentDates,
    generationNumber,
    dailyExerciseCaps: effectiveDailyExerciseCaps,
  });
  const generationBatchId = `${mode}-${student.uid}-${Date.now()}`;
  const aiResponse = await recommendExercises({
    studentId: student.uid,
    grade: student?.grade,
    region: student?.province,
    subject,
    mode,
    assignmentDates,
    completedTopics,
    tutorReports: [...new Set([
      ...subjectTutorReports,
      ...completedLessons.map((lesson) => lesson.topicReport ?? lesson.note).filter(Boolean),
    ])],
    tutorNotes: latestTutorReport ?? studentState.latestTutorReport ?? '',
    pastMarks: [student?.latestMark, student?.previousYearMark].filter((value) => value !== undefined && value !== null),
    questionPaperMetadata: selectedPapers.map((paper) => ({
      ...paperMetadataForAi(paper),
      topics: (paper.topics ?? []).filter((topic) => questionMatchesTopics({ topic }, completedTopics)),
    })),
    topicPaperMetadata,
    selectedPapers: selectedPapers.map((paper) => ({
      id: paper.id,
      year: paper.year,
      month: paper.month,
      region: paper.region,
      grade: paper.grade,
      paperNumber: paper.paperNumber ?? 'Paper 1',
      copySuffix: paper.copySuffix ?? '',
      displayName: paper.displayName ?? '',
      paperMetadata: paper.paperMetadata ?? {},
      topics: (paper.topics ?? []).filter((topic) => questionMatchesTopics({ topic }, completedTopics)),
      questions: summarizePaperQuestions(paper, completedTopics),
    })),
    selectedPaperIds: selectedPapers.map((paper) => paper.id),
    maxExercisesPerDay: aiPlan.maxExercisesPerDay,
    dailyExerciseCaps: effectiveDailyExerciseCaps,
    maxQuestionsPerDay: aiPlan.maxQuestionsPerDay,
    questionPlanRules: aiPlan,
    lessonHistory: completedLessons.map((lesson) => ({
      topic: lesson.topic,
      topicReport: lesson.topicReport ?? lesson.note ?? '',
      understandingLevel: Number(lesson.understandingLevel ?? understandingLevel ?? 5),
      topicUnderstandingScores: lesson.topicUnderstandingScores ?? [],
      completedOn: lesson.completedOn ?? lesson.createdAt ?? '',
    })),
    understandingByTopic: topicSummaries.map((summary) => ({
      topic: summary.topic,
      understandingLevel: summary.understandingLevel,
      completedOn: summary.completedOn,
    })),
    recentExerciseHistory,
    previousGenerationSummaries: getRecentGenerationSummaries(assignmentHistory, 2),
    reusedRecentPapers,
    topicsWithoutSources,
  });

  const assignments = buildAssignmentsFromAiRecommendations({
    recommendations: aiResponse?.recommendations ?? [],
    student,
    subscriptionTrace,
    selectedPapers,
    generationBatchId,
    mode,
    subject,
    topicSummaries,
    maxExercisesPerDay: aiPlan.maxExercisesPerDay,
    dailyExerciseCaps: effectiveDailyExerciseCaps,
    allowedAssignmentDates: assignmentDates,
    grade: student?.grade,
    generationWeek: generationNumber,
  }).filter((assignment) => Boolean(assignment.assignmentDate));

  if (!isFirebaseConfigured) {
    return {
      generated: assignments.length > 0,
      reason: 'Demo generation complete',
      assignments,
      criteria: {
        ...studentState.generationStatus,
        ...subscriptionTrace,
        selectedPaperIds: selectedPapers.map((paper) => paper.id),
        excludedRecentPaperIds: recentPaperIds,
        reusedRecentPapers,
        topicsWithoutSources,
      },
    };
  }

  ensureDb();
  const currentAssignmentSnapshot = await getDocs(query(
    collection(db, collections.tutorStudentAssignments),
    where('studentId', '==', student.uid),
    where('subject', '==', subject),
    where('active', '==', true),
  ));
  const assignmentPeriodId = currentAssignmentSnapshot.docs[0]?.data().currentPeriodId ?? null;
  assignments.forEach((assignment) => {
    if (assignmentPeriodId) assignment.assignmentPeriodId = assignmentPeriodId;
  });
  const createdAssignments = [];
  const existingCounts = new Map();
  for (const assignment of assignments) {
    const assignmentDate = assignment.assignmentDate;
    if (replacesExerciseWindow) continue;
    if (!existingCounts.has(assignmentDate)) {
      const snapshot = await getDocs(query(
        collection(db, collections.dailyExerciseAssignments),
        where('studentId', '==', assignment.studentId),
        where('subject', '==', subject),
        where('assignmentDate', '==', assignmentDate),
      ));
      existingCounts.set(assignmentDate, snapshot.size);
    }

    const cap = effectiveDailyExerciseCaps[assignmentDate] ?? aiPlan.maxExercisesPerDay;
    if (existingCounts.get(assignmentDate) >= cap) continue;
    const ref = await addDoc(collection(db, collections.dailyExerciseAssignments), { ...assignment, createdAt: serverTimestamp() });
    existingCounts.set(assignmentDate, existingCounts.get(assignmentDate) + 1);
    createdAssignments.push({ id: ref.id, ...assignment });
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
        const cap = effectiveDailyExerciseCaps[assignmentDate] ?? aiPlan.maxExercisesPerDay;
        if (replacements.length !== cap) continue;
        const currentSnapshots = await Promise.all(oldIds.map((id) => transaction.get(doc(db, collections.dailyExerciseAssignments, id))));
        const currentExercises = currentSnapshots.filter((item) => item.exists()).map((item) => ({ id: item.id, ...item.data() }));
        if (currentExercises.length !== oldIds.length || currentExercises.some(isExerciseSubmitted)) continue;
        safeDates.push({ assignmentDate, currentExercises, replacements });
      }

      const rows = [];
      safeDates.forEach(({ currentExercises, replacements }) => {
        const sourceGeneration = currentExercises[0];
        currentExercises.forEach((item) => transaction.delete(doc(db, collections.dailyExerciseAssignments, item.id)));
        replacements.forEach((item) => {
          const ref = doc(collection(db, collections.dailyExerciseAssignments));
          const replacement = {
            ...item,
            generationMode: readyCompletedLesson ? mode : sourceGeneration?.generationMode || item.generationMode,
            generationBatchId: readyCompletedLesson ? generationBatchId : sourceGeneration?.generationBatchId || item.generationBatchId || generationBatchId,
            generationWeek: generationNumber,
          };
          transaction.set(ref, { ...replacement, createdAt: serverTimestamp() });
          rows.push({ id: ref.id, ...replacement });
        });
      });
      return rows;
    });
    if (!replacementRows.length) {
      return { generated: false, reason: 'The model did not return a complete replacement set. Existing exercises were kept.', assignments: [] };
    }
    return {
      generated: true,
      reason: `Regenerated ${replacementRows.length} uncompleted exercises within the next 7 days.`,
      assignments: replacementRows,
      criteria: { ...studentState.generationStatus, ...subscriptionTrace, selectedPaperIds: selectedPapers.map((paper) => paper.id) },
    };
  }

  return {
    generated: createdAssignments.length > 0,
    reason: `${mode} generation complete`,
    assignments: createdAssignments,
    criteria: {
      ...studentState.generationStatus,
      ...subscriptionTrace,
      selectedPaperIds: selectedPapers.map((paper) => paper.id),
      excludedRecentPaperIds: recentPaperIds,
      reusedRecentPapers,
      topicsWithoutSources,
    },
  };
};

export const generateExercisePlanIfEligible = async (options = {}) => {
  const { student, subject = DEFAULT_SUBJECT, mode, overrideFutureUnsubmitted = false, completedLesson, onProgress } = options;
  if (overrideFutureUnsubmitted || !isFirebaseConfigured || !student?.uid) {
    return generateExercisePlanUnlocked(options);
  }

  ensureDb();
  const statusRef = doc(db, collections.exerciseGenerationStatus, `${student.uid}_${subject}`);
  const startedAtMs = Date.now();
  const lastTrigger = completedLesson ? 'lesson' : mode === 'initial' ? 'initial' : 'weekly';
  const historyWeek = getCurrentGenerationNumber(await getAssignmentHistory(student.uid, subject));
  const acquiredGenerationWeek = await runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(statusRef);
    const current = snapshot.exists() ? snapshot.data() : null;
    const lockIsFresh = startedAtMs - Number(current?.startedAtMs ?? 0) < EXERCISE_REGENERATION_LOCK_TIMEOUT_MS;
    if (current?.status === 'processing' && lockIsFresh) return null;
    const currentWeek = Math.max(historyWeek, Number(current?.generationWeek) || 1);
    const generationWeek = getGenerationWeekForTrigger(currentWeek, { initial: mode === 'initial', lessonCompleted: Boolean(completedLesson) });
    transaction.set(statusRef, {
      studentId: student.uid,
      subject,
      mode,
      lastTrigger,
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
    const result = await generateExercisePlanUnlocked({ ...options, plannedGenerationWeek: acquiredGenerationWeek, onProgress: reportProgress });
    await setDoc(statusRef, {
      status: result.generated ? 'completed' : 'failed',
      message: result.reason || (result.generated ? 'Exercise generation completed.' : 'Exercise generation did not produce assignments.'),
      paidSubscriptionActive: Boolean(result.criteria?.paidSubscriptionActive),
      subscriptionId: result.criteria?.subscriptionId ?? null,
      subscriptionPlanId: result.criteria?.subscriptionPlanId ?? 'free',
      subscriptionPlanName: result.criteria?.subscriptionPlanName ?? 'Free',
      subscriptionPaymentReference: result.criteria?.subscriptionPaymentReference ?? null,
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
  const statusRef = doc(db, collections.exerciseGenerationStatus, `${student.uid}_${subject}`);
  const startedAtMs = Date.now();
  const acquired = await runTransaction(db, async (transaction) => {
    const currentStatus = await transaction.get(statusRef);
    const currentData = currentStatus.exists() ? currentStatus.data() : null;
    const lockIsFresh = startedAtMs - Number(currentData?.startedAtMs ?? 0) < EXERCISE_REGENERATION_LOCK_TIMEOUT_MS;
    if (currentData?.status === 'processing' && lockIsFresh) return false;
    transaction.set(statusRef, {
      studentId: student.uid,
      tutorId,
      subject,
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

  const saveStatus = (status, message) => setDoc(statusRef, {
    studentId: student.uid,
    tutorId,
    subject,
    mode: 'weekly',
    lastTrigger: 'manual',
    status,
    message,
    updatedAt: serverTimestamp(),
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
    await saveStatus(status, result.reason || (result.generated ? 'Exercises regenerated.' : 'No exercises were regenerated.'));
    return result;
  } catch (error) {
    await saveStatus('failed', error.message || 'Exercise regeneration failed.');
    throw error;
  }
};

export const subscribeToExerciseGenerationStatus = (studentId, subject, callback) => {
  if (!studentId || !subject || !isFirebaseConfigured) return () => {};
  ensureDb();
  return onSnapshot(
    doc(db, collections.exerciseGenerationStatus, `${studentId}_${subject}`),
    (snapshot) => callback(snapshot.exists() ? snapshot.data() : null),
    (error) => console.error('[Examifying][Firestore] exercise generation status subscription failed', error),
  );
};

export const subscribeToAssignedStudentsForTutor = (tutorId, callback, subject = DEFAULT_SUBJECT) => {
  if (!isFirebaseConfigured) {
    getAssignedStudentsForTutor(tutorId, subject).then(callback);
    return () => {};
  }
  const refresh = () => getAssignedStudentsForTutor(tutorId, subject).then(callback).catch((error) => console.error('[Examifying][Firestore] subscribeToAssignedStudents error', error));
  const ownerUnsubscribe = onSnapshot(query(collection(db, collections.tutorStudentAssignments), where('tutorId', '==', tutorId), where('active', '==', true)), refresh);
  const sharedUnsubscribe = onSnapshot(query(collection(db, collections.staffStudentAccess), where('tutorId', '==', tutorId), where('active', '==', true)), refresh);
  return () => { ownerUnsubscribe(); sharedUnsubscribe(); };
};

export const subscribeToUnassignedStudents = (callback, subject = DEFAULT_SUBJECT) => {
  if (!isFirebaseConfigured) {
    const assignedIds = new Set(
      mockStudentAssignments
        .filter((assignment) => assignment.active !== false && (assignment.subject ?? DEFAULT_SUBJECT) === subject)
        .map((assignment) => assignment.studentId),
    );
    const demoStudents = demoUsers.filter((user) => user.role === 'student' && !assignedIds.has(user.uid));
    callback(demoStudents);
    return () => {};
  }
  const usersQuery = query(collection(db, collections.users), where('role', '==', 'student'));
  return onSnapshot(usersQuery, async (snapshot) => {
    const assignmentsSnapshot = await getDocs(query(
      collection(db, collections.tutorStudentAssignments),
      where('subject', '==', subject),
      where('active', '==', true),
    ));
    const assignedIds = new Set(assignmentsSnapshot.docs.map((item) => item.data().studentId));
    callback(snapshot.docs.map(item => item.data()).filter(student => !assignedIds.has(student.uid)));
  }, (error) => console.error('[Examifying][Firestore] subscribeToUnassignedStudents error', error));
};



export const getAssignedSubjectsForStudent = async (studentId) => {
  if (!studentId) return [];
  if (!isFirebaseConfigured) {
    return [...new Set(mockStudentAssignments
      .filter((assignment) => assignment.studentId === studentId && assignment.active !== false)
      .map((assignment) => assignment.subject ?? DEFAULT_SUBJECT))];
  }
  ensureDb();
  const [snapshot, studentSnapshot] = await Promise.all([
    getDocs(query(
      collection(db, collections.tutorStudentAssignments),
      where('studentId', '==', studentId),
      where('active', '==', true),
    )),
    getDoc(doc(db, collections.users, studentId)),
  ]);
  const subjects = new Set(studentSnapshot.exists() ? getUserSubjects(studentSnapshot.data()) : []);
  return [...new Set(snapshot.docs.map((item) => item.data().subject ?? DEFAULT_SUBJECT).filter((subject) => subjects.has(subject)))];
};

export const getTutorAssignedStudentContexts = async (tutorId) => {
  if (!tutorId) return [];
  if (!isFirebaseConfigured) {
    return mockStudentAssignments
      .filter((assignment) => assignment.tutorId === tutorId && assignment.active !== false)
      .map((assignment) => {
        const student = demoUsers.find((user) => user.uid === assignment.studentId) ?? {};
        return { ...student, studentId: assignment.studentId, subject: assignment.subject ?? DEFAULT_SUBJECT, assignmentId: assignment.id, accessRole: 'co-owner', isPrimaryTutor: true };
      });
  }

  ensureDb();
  const [primarySnapshot, sharedSnapshot] = await Promise.all([
    getDocs(query(collection(db, collections.tutorStudentAssignments), where('tutorId', '==', tutorId), where('active', '==', true))),
    getDocs(query(collection(db, collections.staffStudentAccess), where('tutorId', '==', tutorId), where('active', '==', true))),
  ]);
  const primary = primarySnapshot.docs.map((item) => ({ id: item.id, ...item.data(), accessRole: 'co-owner', isPrimaryTutor: true }));
  const shared = sharedSnapshot.docs.map((item) => ({ id: item.id, ...item.data(), isPrimaryTutor: false }));
  const records = [...primary, ...shared];
  const studentSnapshots = await Promise.all(records.map((assignment) => getDoc(doc(db, collections.users, assignment.studentId))));
  const contexts = records.map((assignment, index) => {
    const student = studentSnapshots[index].exists() ? studentSnapshots[index].data() : {};
    return {
    ...student,
    studentId: assignment.studentId,
    uid: assignment.studentId,
    subject: assignment.subject ?? DEFAULT_SUBJECT,
    assignmentId: assignment.id,
    assignmentPeriodId: assignment.currentPeriodId ?? null,
    accessRole: assignment.accessRole,
    isPrimaryTutor: assignment.isPrimaryTutor,
    accessGrantedBy: assignment.createdBy ?? null,
  };
  }).filter((context) => getUserSubjects(context).includes(context.subject));
  const unique = new Map();
  contexts.forEach((context) => {
    const key = `${context.studentId}:${context.subject}`;
    const current = unique.get(key);
    if (!current || context.isPrimaryTutor) unique.set(key, context);
  });
  return [...unique.values()];
};

const toAssignmentDateKey = (value) => {
  if (!value) return '';
  const date = value?.toDate ? value.toDate() : (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? null : new Date(value));
  if (!date) return value;
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10);
};

const recordFallsWithinPeriod = (record, period) => {
  if (period.periodId && record.assignmentPeriodId === period.periodId) return true;
  const recordDate = toAssignmentDateKey(record.assignmentDate || record.completedOn || record.lessonDate || record.updatedAt || record.createdAt);
  if (!recordDate) return true;
  const startDate = toAssignmentDateKey(period.startedAt || period.assignedAt);
  const endDate = toAssignmentDateKey(period.endedAt);
  return (!startDate || recordDate >= startDate) && (!endDate || recordDate <= endDate);
};

export const getTutorAssignmentHistoryContexts = async (tutorId, studentId = null) => {
  if (!tutorId || !isFirebaseConfigured) return [];
  ensureDb();
  const [primaryHistory, sharedHistory, primaryPointers, sharedPointers] = await Promise.all([
    getDocs(query(collection(db, collections.tutorStudentAssignmentPeriods), where('tutorId', '==', tutorId))),
    getDocs(query(collection(db, collections.staffStudentAccessPeriods), where('tutorId', '==', tutorId))),
    getDocs(query(collection(db, collections.tutorStudentAssignments), where('tutorId', '==', tutorId), where('active', '==', true))),
    getDocs(query(collection(db, collections.staffStudentAccess), where('tutorId', '==', tutorId), where('active', '==', true))),
  ]);
  const periods = [
    ...primaryHistory.docs.map((item) => ({ id: item.id, ...item.data(), isPrimaryTutor: true })),
    ...sharedHistory.docs.map((item) => ({ id: item.id, ...item.data(), isPrimaryTutor: false })),
  ].filter((period) => period.active === false && period.endedAt && (!studentId || period.studentId === studentId));
  const legacyPointers = [...primaryPointers.docs, ...sharedPointers.docs]
    .map((item) => ({ id: item.id, ...item.data(), isPrimaryTutor: item.ref.parent.id === collections.tutorStudentAssignments }))
    .filter((pointer) => !studentId || pointer.studentId === studentId);
  const studentIds = [...new Set([...periods, ...legacyPointers].map((item) => item.studentId).filter(Boolean))];
  const studentSnapshots = await Promise.all(studentIds.map((id) => getDoc(doc(db, collections.users, id))));
  const studentMap = new Map(studentSnapshots.map((snapshot) => [snapshot.id, snapshot.exists() ? snapshot.data() : {}]));
  const legacyPeriods = legacyPointers.flatMap((pointer) => {
    const student = studentMap.get(pointer.studentId) ?? {};
    if (getUserSubjects(student).includes(pointer.subject)) return [];
    const estimatedEnd = student.updatedAt || pointer.updatedAt || pointer.assignedAt || null;
    return [{
      ...pointer,
      id: `legacy-${pointer.id}`,
      periodId: `legacy-${pointer.id}`,
      assignmentType: pointer.isPrimaryTutor ? 'primary' : 'shared',
      accessRole: pointer.isPrimaryTutor ? 'co-owner' : pointer.accessRole,
      startedAt: pointer.assignedAt || pointer.createdAt || null,
      endedAt: estimatedEnd,
      endReason: 'subject_removed_before_history_tracking',
      active: false,
      legacyArchive: true,
      endDateEstimated: true,
    }];
  });
  const rows = [...periods, ...legacyPeriods].map((period) => ({
    ...studentMap.get(period.studentId),
    studentId: period.studentId,
    uid: period.studentId,
    subject: period.subject ?? DEFAULT_SUBJECT,
    assignmentId: period.pointerId || period.id,
    assignmentPeriodId: period.periodId || period.id,
    accessRole: period.accessRole || (period.isPrimaryTutor ? 'co-owner' : 'viewer'),
    isPrimaryTutor: period.isPrimaryTutor || period.assignmentType === 'primary',
    assignmentStartedAt: period.startedAt || null,
    assignmentEndedAt: period.endedAt || null,
    assignmentEndReason: period.endReason || 'access_ended',
    legacyArchive: Boolean(period.legacyArchive || period.migratedFromLegacy),
    endDateEstimated: Boolean(period.endDateEstimated),
  }));
  return rows.sort((left, right) => new Date(right.assignmentEndedAt?.toDate?.() ?? right.assignmentEndedAt ?? 0) - new Date(left.assignmentEndedAt?.toDate?.() ?? left.assignmentEndedAt ?? 0));
};

export const getTutorAssignmentHistoryData = async ({ tutorId, studentId, periodId }) => {
  const period = (await getTutorAssignmentHistoryContexts(tutorId, studentId))
    .find((item) => item.assignmentPeriodId === periodId);
  if (!period) throw new Error('This assignment history is not available to your account.');
  const [exerciseSnapshot, reportSnapshot, lessonSnapshot, peerMarkingSnapshot] = await Promise.all([
    getDocs(query(collection(db, collections.dailyExerciseAssignments), where('studentId', '==', studentId), where('subject', '==', period.subject))),
    getDocs(query(collection(db, collections.tutorReports), where('studentId', '==', studentId), where('subject', '==', period.subject))),
    getDocs(query(collection(db, collections.coveredTopics), where('studentId', '==', studentId), where('subject', '==', period.subject))),
    getDocs(query(collection(db, collections.peerMarkingAssignments), where('reviewerId', '==', studentId))),
  ]);
  const inPeriod = (snapshot) => snapshot.docs
    .map((item) => ({ id: item.id, ...item.data() }))
    .filter((item) => recordFallsWithinPeriod(item, {
      startedAt: period.assignmentStartedAt,
      endedAt: period.assignmentEndedAt,
      periodId: period.assignmentPeriodId,
    }));
  return {
    period,
    exercises: inPeriod(exerciseSnapshot).sort((left, right) => String(left.assignmentDate || '').localeCompare(String(right.assignmentDate || ''))),
    reports: inPeriod(reportSnapshot).sort((left, right) => new Date(right.updatedAt?.toDate?.() ?? right.updatedAt ?? 0) - new Date(left.updatedAt?.toDate?.() ?? left.updatedAt ?? 0)),
    lessons: inPeriod(lessonSnapshot).sort((left, right) => String(right.completedOn || right.lessonDate || '').localeCompare(String(left.completedOn || left.lessonDate || ''))),
    peerMarkedWork: await Promise.all(peerMarkingSnapshot.docs
      .map((item) => ({ id: item.id, ...item.data() }))
      .filter((item) => item.subject === period.subject && item.status === 'completed' && item.reviewImageUrl)
      .filter((item) => recordFallsWithinPeriod(item, {
        startedAt: period.assignmentStartedAt,
        endedAt: period.assignmentEndedAt,
        periodId: period.assignmentPeriodId,
      }))
      .map(async (item) => ({ ...item, targetExercise: item.exerciseId ? await getExerciseAssignmentById(item.exerciseId) : null }))),
  };
};

export const getStaffMembersForAccess = async ({ tutorId, subject = DEFAULT_SUBJECT }) => {
  if (!tutorId) return [];
  if (!isFirebaseConfigured) return getApprovedTutorOrTeacherProfiles(demoUsers, subject).filter((user) => user.uid !== tutorId);
  ensureDb();
  const snapshot = await getDocs(collection(db, collections.users));
  return getApprovedTutorOrTeacherProfiles(snapshot.docs.map((item) => item.data()), subject).filter((user) => user.uid !== tutorId);
};

export const setStaffStudentAccess = async ({ actorId, studentId, tutorId, subject = DEFAULT_SUBJECT, accessRole }) => {
  if (!STAFF_ACCESS_ROLES.includes(accessRole)) throw new Error('Choose co-owner, marker, or viewer access.');
  const actor = await requireCoOwnerAccess({ tutorId: actorId, studentId, subject });
  if (!actor.isPrimaryTutor && actor.accessRole !== 'co-owner') throw new Error('Only a co-owner can manage staff access.');
  if (!isFirebaseConfigured) throw new Error('Staff access management requires a connected Firebase project.');
  ensureDb();
  const callable = httpsCallable(functions, 'manageStaffStudentAccess');
  return (await callable({ action: 'grant', actorId, studentId, tutorId, subject, accessRole })).data;
};

export const getStaffStudentAccess = async ({ studentId, subject = DEFAULT_SUBJECT, tutorId }) => {
  if (!isFirebaseConfigured) return [];
  ensureDb();
  const snapshot = await getDocs(query(collection(db, collections.staffStudentAccess), where('studentId', '==', studentId), where('subject', '==', subject), where('active', '==', true)));
  const records = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
  const people = await Promise.all(records.map((record) => getDoc(doc(db, collections.users, record.tutorId))));
  return records.map((record, index) => ({ ...record, displayName: people[index].exists() ? (people[index].data().displayName || people[index].data().email) : record.tutorId, isCurrentUser: record.tutorId === tutorId }));
};

export const revokeStaffStudentAccess = async ({ actorId, studentId, subject = DEFAULT_SUBJECT, accessId }) => {
  await requireCoOwnerAccess({ tutorId: actorId, studentId, subject });
  if (!isFirebaseConfigured) throw new Error('Staff access management requires a connected Firebase project.');
  ensureDb();
  const callable = httpsCallable(functions, 'manageStaffStudentAccess');
  await callable({ action: 'revoke', actorId, studentId, subject, accessId });
};

export const getTutorReportsForAssignedStudents = async (tutorId) => {
  if (!tutorId) return [];
  const contexts = await getTutorAssignedStudentContexts(tutorId);
  if (!isFirebaseConfigured) {
    const keys = new Set(contexts.map((context) => `${context.studentId}:${context.subject}`));
    return mockTutorReports.filter((report) => keys.has(`${report.studentId}:${report.subject ?? DEFAULT_SUBJECT}`));
  }
  ensureDb();
  const snapshots = await Promise.all(contexts.map((context) => getDocs(query(collection(db, collections.tutorReports), where('studentId', '==', context.studentId), where('subject', '==', context.subject)))));
  return snapshots.flatMap((snapshot) => snapshot.docs.map((item) => ({ id: item.id, ...item.data() })))
    .sort((left, right) => new Date(right.updatedAt?.toDate?.() ?? right.updatedAt ?? right.createdAt?.toDate?.() ?? right.createdAt ?? 0) - new Date(left.updatedAt?.toDate?.() ?? left.updatedAt ?? left.createdAt?.toDate?.() ?? left.createdAt ?? 0));
};

export const getTutorExercisesForAssignedStudents = async (tutorId) => {
  const contexts = await getTutorAssignedStudentContexts(tutorId);
  if (!contexts.length) return [];
  if (!isFirebaseConfigured) {
    const keys = new Set(contexts.map((item) => `${item.studentId}-${item.subject}`));
    return (mockDashboardData.student.exerciseHistory ?? []).filter((exercise) => keys.has(`${exercise.studentId}-${exercise.subject ?? DEFAULT_SUBJECT}`));
  }
  ensureDb();
  const results = await Promise.all(contexts.map(async (context) => {
    const snapshot = await getDocs(query(
      collection(db, collections.dailyExerciseAssignments),
      where('studentId', '==', context.studentId),
      where('subject', '==', context.subject),
      limit(40),
    ));
    return snapshot.docs.map((item) => ({ id: item.id, ...item.data(), studentName: context.displayName || context.name || 'Student' }));
  }));
  return results.flat().sort((left, right) => String(right.assignmentDate).localeCompare(String(left.assignmentDate)));
};

export const getTutorLessonsForAssignedStudents = async (tutorId) => {
  if (!tutorId) return [];
  const contexts = await getTutorAssignedStudentContexts(tutorId);
  if (!isFirebaseConfigured) {
    const keys = new Set(contexts.map((context) => `${context.studentId}:${context.subject}`));
    return mockCompletedLessons.filter((lesson) => keys.has(`${lesson.studentId}:${lesson.subject ?? DEFAULT_SUBJECT}`));
  }
  ensureDb();
  const snapshots = await Promise.all(contexts.map((context) => getDocs(query(collection(db, collections.coveredTopics), where('studentId', '==', context.studentId), where('subject', '==', context.subject)))));
  return snapshots.flatMap((snapshot) => snapshot.docs.map((item) => ({ id: item.id, ...item.data() }))).sort((left, right) => String(right.completedOn || right.lessonDate || '').localeCompare(String(left.completedOn || left.lessonDate || '')));
};

export const getLessonsForStudent = async (studentId) => {
  if (!studentId) return [];
  if (!isFirebaseConfigured) return mockCompletedLessons.filter((lesson) => lesson.studentId === studentId);
  ensureDb();
  const snapshot = await getDocs(query(collection(db, collections.coveredTopics), where('studentId', '==', studentId)));
  return snapshot.docs.map((item) => ({ id: item.id, ...item.data() })).sort((left, right) => String(right.completedOn || right.lessonDate || '').localeCompare(String(left.completedOn || left.lessonDate || '')));
};

export const getLessonById = async (lessonId) => {
  if (!lessonId) return null;
  if (!isFirebaseConfigured) return mockCompletedLessons.find((lesson) => lesson.id === lessonId) ?? null;
  ensureDb();
  const snapshot = await getDoc(doc(db, collections.coveredTopics, lessonId));
  return snapshot.exists() ? { id: snapshot.id, ...snapshot.data() } : null;
};

export const updateCompletedLesson = async ({ lessonId, tutorId, topicReport = '', topicUnderstandingScores = [], topics = [], understandingLevel = null, lessonDate, lessonType, whatsappLessonLink, locationDetails, status }) => {
  if (!lessonId) throw new Error('Lesson id is required.');
  const isCompleted = status === 'completed';
  const lesson = await getLessonById(lessonId);
  if (!lesson) throw new Error('Lesson not found.');
  await requireCoOwnerAccess({ tutorId, studentId: lesson.studentId, subject: lesson.subject ?? DEFAULT_SUBJECT });
  const lessonAccessDetails = {
    ...(whatsappLessonLink !== undefined ? { whatsappLessonLink: normalizeWhatsAppLessonLink(whatsappLessonLink) } : {}),
    ...(locationDetails !== undefined ? { locationDetails: String(locationDetails || '').trim() } : {}),
  };
  if (!isFirebaseConfigured) {
    const updated = { ...lesson, id: lessonId, topicReport, topicUnderstandingScores, topics, understandingLevel, lessonDate, lessonType, status, ...lessonAccessDetails };
    upsertMockLessonRows([updated]);
    return updated;
  }
  ensureDb();
  const payload = {
    topicReport,
    note: topicReport,
    topicUnderstandingScores,
    topics,
    topic: topics[0] ?? '',
    understandingLevel,
    ...(lessonDate ? { lessonDate } : {}),
    ...(lessonType ? { lessonType } : {}),
    ...lessonAccessDetails,
    ...(status ? { status } : {}),
    ...(isCompleted ? { completedOn: lessonDate || new Date().toISOString().slice(0, 10) } : {}),
    updatedAt: serverTimestamp(),
  };
  await updateDoc(doc(db, collections.coveredTopics, lessonId), payload);
  return { id: lessonId, ...payload };
};

export const deleteLesson = async (lessonId, tutorId) => {
  if (!lessonId) throw new Error('Lesson id is required.');
  const lesson = await getLessonById(lessonId);
  if (!lesson) throw new Error('Lesson not found.');
  await requireCoOwnerAccess({ tutorId, studentId: lesson.studentId, subject: lesson.subject ?? DEFAULT_SUBJECT });
  if (!isFirebaseConfigured) return { id: lessonId, deleted: true };
  ensureDb();
  await deleteDoc(doc(db, collections.coveredTopics, lessonId));
  return { id: lessonId, deleted: true };
};

export const subscribeToAssignedTutorForStudent = (studentId, callback, subject = DEFAULT_SUBJECT) => {
  if (!studentId) {
    callback(null);
    return () => {};
  }

  if (!isFirebaseConfigured) {
    const assignment = mockStudentAssignments.find((item) =>
      item.studentId === studentId &&
      item.active !== false &&
      (item.subject ?? DEFAULT_SUBJECT) === subject
    );
    const tutor = assignment ? demoUsers.find((user) => user.uid === assignment.tutorId) : null;
    callback(tutor ?? null);
    return () => {};
  }

  const q = query(
    collection(db, collections.tutorStudentAssignments),
    where('studentId', '==', studentId),
    where('subject', '==', subject),
    where('active', '==', true),
    limit(1),
  );

  return onSnapshot(q, async (snapshot) => {
    const assignment = snapshot.docs[0]?.data();
    if (!assignment?.tutorId) {
      callback(null);
      return;
    }

    const tutorSnapshot = await getDoc(doc(db, collections.users, assignment.tutorId));
    callback(tutorSnapshot.exists() ? tutorSnapshot.data() : null);
  }, (error) => console.error('[Examifying][Firestore] subscribeToAssignedTutorForStudent error', error));
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
  const ref = await addDoc(collection(db, collections.guideQuizResults), {
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
    collection(db, collections.guideQuizResults),
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
    const users = demoUsers.filter((user) => user.role === 'student' || user.role === 'tutor');
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
          };
        }),
      tutors: users
        .filter((user) => user.role === 'tutor')
        .map((user) => {
          const latest = [...demoGuideQuizResults]
            .filter((item) => item.userId === user.uid && item.role === 'tutor')
            .sort((left, right) => new Date(right.submittedAt ?? 0) - new Date(left.submittedAt ?? 0))[0] ?? null;
          return {
            id: user.uid,
            name: user.displayName || user.email || 'Tutor',
            percentage: latest?.percentage ?? null,
          };
        }),
    };
  }

  ensureDb();
  const usersSnapshot = await getDocs(collection(db, collections.users));
  const resultsSnapshot = await getDocs(query(collection(db, collections.guideQuizResults), orderBy('submittedAt', 'desc')));
  const resultsByUser = new Map();

  resultsSnapshot.docs.forEach((item) => {
    const data = { id: item.id, ...item.data() };
    if (!resultsByUser.has(data.userId)) {
      resultsByUser.set(data.userId, data);
    }
  });

  const users = usersSnapshot.docs.map((item) => item.data()).filter((user) => user.role === 'student' || user.role === 'tutor');
  const buildRow = (user) => ({
    id: user.uid,
    name: user.displayName || user.email || (user.role === 'student' ? 'Student' : 'Tutor'),
    percentage: resultsByUser.get(user.uid)?.percentage ?? null,
  });

  return {
    students: users.filter((user) => user.role === 'student').map(buildRow),
    tutors: users.filter((user) => user.role === 'tutor').map(buildRow),
  };
};

export const assignStudentToParent = async ({ parentId, studentIdentifier }) => {
  if (!isFirebaseConfigured) {
    return { success: true, studentId: 'demo-student', parentId };
  }
  ensureDb();
  
  let q;
  if (studentIdentifier.includes('@')) {
    q = query(collection(db, collections.users), where('email', '==', studentIdentifier), where('role', '==', 'student'), limit(1));
  } else {
    q = query(collection(db, collections.users), where('uid', '==', studentIdentifier), where('role', '==', 'student'), limit(1));
  }
  
  const snapshot = await getDocs(q);
  if (snapshot.empty) {
    throw new Error('Student not found. Please check the email or student ID.');
  }
  
  const studentDoc = snapshot.docs[0];
  const student = studentDoc.data();
  
  if (student.parentId && student.parentId !== parentId) {
    throw new Error('This student is already assigned to another parent.');
  }
  
  await updateDoc(doc(db, collections.users, student.uid), {
    parentId,
    updatedAt: serverTimestamp(),
  });
  
  return { success: true, studentId: student.uid, parentId, studentName: student.displayName || student.email };
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


export const addStudentSubjects = async ({ studentId, subjects }) => {
  const cleanSubjects = [...new Set((subjects ?? []).filter(Boolean))];
  if (!cleanSubjects.length) throw new Error('Choose at least one subject to add.');

  if (!isFirebaseConfigured) {
    return { studentId, subjects: cleanSubjects };
  }

  ensureDb();
  const callable = httpsCallable(functions, 'updateStudentSubjects');
  return (await callable({ studentId, action: 'add', subjects: cleanSubjects })).data;
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

  ensureDb();
  const snapshot = await getDocs(query(collection(db, collections.coveredTopics), where('tutorId', '==', tutorId)));
  const lessons = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
  return {
    totalLessons: lessons.length,
    studentsTutored: new Set(lessons.map((lesson) => lesson.studentId).filter(Boolean)).size,
    subjectsTutored: [...new Set(lessons.map((lesson) => lesson.subject ?? DEFAULT_SUBJECT).filter(Boolean))],
    recentLessons: lessons
      .sort((left, right) => String(right.completedOn ?? '').localeCompare(String(left.completedOn ?? '')))
      .slice(0, 10),
  };
};

export const updateUserSettings = async ({ uid, settings }) => {
  if (!isFirebaseConfigured) return { uid, settings };

  ensureDb();
  await updateDoc(doc(db, collections.users, uid), {
    settings,
    updatedAt: serverTimestamp(),
  });
  return { uid, settings };
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
  const snapshot = await getDocs(query(collection(db, collections.tutorMarksDocuments), where('tutorId', '==', tutorId)));
  return snapshot.docs
    .map((item) => ({ id: item.id, ...item.data() }))
    .sort((left, right) => {
      const leftValue = left.createdAt?.toMillis?.() ?? new Date(left.createdAt ?? 0).getTime();
      const rightValue = right.createdAt?.toMillis?.() ?? new Date(right.createdAt ?? 0).getTime();
      return rightValue - leftValue;
    });
};
