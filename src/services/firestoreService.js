import {
  addDoc,
  arrayRemove,
  arrayUnion,
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
} from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { addDays, formatISO } from 'date-fns';
import { db, functions, isFirebaseConfigured } from '../firebase/config';
import { collections } from '../firebase/schema';
import { recommendExercises } from './aiService';
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
import { getApprovedTutorSubjects, getUserSubjects } from '../utils/tutorSubjects';

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

const GENERATION_HISTORY_LIMIT = 40;

const buildTutorAssignmentId = ({ studentId, tutorId, subject }) => `${studentId}_${tutorId}_${subject}`;

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
  paymentCompleted,
  completedLessons = [],
  hasInitialGeneration = false,
}) => {
  const initialReady = Boolean(paymentCompleted && latestReport && availablePapers.length >= 2 && completedLessons.length > 0);
  const weeklyReady = Boolean(hasInitialGeneration && paymentCompleted && completedLessons.length > 0 && availablePapers.length >= 2);

  return {
    paymentCompleted,
    initial: {
      ready: initialReady,
      checks: {
        paymentCompleted,
        latestTutorReportExists: Boolean(latestReport),
        minimumQuestionPaperCountMet: availablePapers.length >= 2,
        lessonCompleted: completedLessons.length > 0,
      },
    },
    weekly: {
      ready: weeklyReady,
      checks: {
        paymentCompleted,
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
  if (Array.isArray(lesson.topicUnderstandingScores) && lesson.topicUnderstandingScores.length) {
    return lesson.topicUnderstandingScores
      .map((entry) => ({
        topic: String(entry?.topic || '').trim(),
        understandingLevel: Number(entry?.understandingLevel ?? lesson?.understandingLevel ?? 5),
        reportSnippet: entry?.topicReport ?? lesson?.topicReport ?? lesson?.note ?? '',
        completedOn: lesson?.completedOn ?? lesson?.createdAt ?? '',
        firstSeenIndex: lessonIndex,
      }))
      .filter((entry) => entry.topic);
  }

  const topic = String(lesson?.topic || '').trim();
  return topic ? [{
    topic,
    understandingLevel: Number(lesson?.understandingLevel ?? 5),
    reportSnippet: lesson?.topicReport ?? lesson?.note ?? '',
    completedOn: lesson?.completedOn ?? lesson?.createdAt ?? '',
    firstSeenIndex: lessonIndex,
  }] : [];
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

const getGenerationNumber = (history = [], mode) => {
  const batches = new Set(
    history
      .filter((assignment) => assignment?.generationMode === mode)
      .map((assignment) => assignment?.generationBatchId)
      .filter(Boolean),
  );

  return batches.size + 1;
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
  const generationStatus = buildStudentGenerationStatus({
    student,
    latestReport,
    availablePapers,
    paymentCompleted: Boolean(student?.paymentCompleted),
    completedLessons: mockCompletedLessons.filter((lesson) => lesson.studentId === student?.uid && (lesson.subject ?? DEFAULT_SUBJECT) === subject),
    hasInitialGeneration: assignmentHistory.some((assignment) => assignment?.generationMode === 'initial'),
  });

  return {
    ...mockDashboardData.student,
    paymentCompleted: Boolean(student?.paymentCompleted),
    generationStatus,
    stats: [
      { label: 'Average mark', value: `${student?.latestMark ?? 0}%`, detail: 'Current learning signal' },
      { label: 'Previous year mark', value: `${student?.previousYearMark ?? 0}%`, detail: 'Entered by student' },
      { label: 'Completed topics', value: String(mockCompletedLessons.filter((lesson) => lesson.studentId === student?.uid && (lesson.subject ?? DEFAULT_SUBJECT) === subject).length), detail: subject },
      { label: 'Subscription', value: student?.paymentCompleted ? 'Active' : 'Pending', detail: student?.paymentCompleted ? 'Paid and unlocked' : 'Payment required' },
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
  selectedPapers = [],
  generationBatchId,
  mode,
  subject = DEFAULT_SUBJECT,
  topicSummaries = [],
  maxExercisesPerDay = MAX_DAILY_EXERCISES,
  dailyExerciseCaps = {},
  allowedAssignmentDates = [],
  grade,
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

export const getStudentAccessState = async (student, subject = DEFAULT_SUBJECT) => {
  if (!student) {
    return {
      paymentCompleted: false,
      paymentRequired: true,
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
    const matchingQuestionPapers = filterQuestionPapers(mockQuestionPapers, { grade: student.grade, region: student.province, subject });
    const subjectReports = mockTutorReports.filter((report) => (!student.uid || report.studentId === student.uid) && (report.subject ?? DEFAULT_SUBJECT) === subject);
    const latestTutorReport = student.latestReportsBySubject?.[subject] || getLatestTutorReportFromList(student.uid, subjectReports)?.note || (subject === DEFAULT_SUBJECT ? student.latestReport : '') || '';
    const completedLessons = mockCompletedLessons.filter((lesson) => lesson.studentId === student.uid && (lesson.subject ?? DEFAULT_SUBJECT) === subject);
    const assignmentHistory = await getAssignmentHistory(student.uid, subject);
    const generationStatus = buildStudentGenerationStatus({
      student,
      latestReport: latestTutorReport,
      availablePapers: matchingQuestionPapers,
      paymentCompleted: Boolean(student.paymentCompleted),
      completedLessons,
      hasInitialGeneration: assignmentHistory.some((assignment) => assignment?.generationMode === 'initial'),
    });

    return {
      paymentCompleted: Boolean(student.paymentCompleted),
      paymentRequired: !student.paymentCompleted,
      initialGenerationReady: generationStatus.initial.ready,
      weeklyGenerationReady: generationStatus.weekly.ready,
      generationStatus,
      matchingQuestionPapers: matchingQuestionPapers.slice(0, MAX_AI_SOURCE_PAPERS),
      latestTutorReport,
      completedLessons,
      tutorReports: subjectReports,
      latestGeneratedAssignments: assignmentHistory,
      hasInitialGeneration: assignmentHistory.some((assignment) => assignment?.generationMode === 'initial'),
    };
  }

  ensureDb();
  const studentSnapshot = await getDoc(doc(db, collections.users, student.uid));
  const subscriptionSnapshot = await getDoc(doc(db, collections.subscriptions, student.uid));
  const paymentCompleted = subscriptionSnapshot.exists() ? subscriptionSnapshot.data().status === 'active' : Boolean(student.paymentCompleted);
  const papers = await getQuestionPapers({ grade: student.grade, region: student.province, subject });
  const reports = await getTutorReports(student.uid, subject);
  const lessons = await getCompletedLessons(student.uid, subject);
  const assignmentHistory = await getAssignmentHistory(student.uid, subject);
  const studentData = studentSnapshot.exists() ? studentSnapshot.data() : student;
  const latestTutorReport = studentData?.latestReportsBySubject?.[subject] || reports[0]?.note || (subject === DEFAULT_SUBJECT ? (studentData?.latestReport || '') : '');
  const generationStatus = buildStudentGenerationStatus({
    student,
    latestReport: latestTutorReport,
    availablePapers: papers,
    paymentCompleted,
    completedLessons: lessons,
    hasInitialGeneration: assignmentHistory.some((assignment) => assignment?.generationMode === 'initial'),
  });

  return {
    paymentCompleted,
    paymentRequired: !paymentCompleted,
    initialGenerationReady: generationStatus.initial.ready,
    weeklyGenerationReady: generationStatus.weekly.ready,
    generationStatus,
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
  if (!isFirebaseConfigured) {
    const assignedIds = new Set(
      mockStudentAssignments
        .filter((assignment) => assignment.tutorId === tutorId && assignment.active !== false && (assignment.subject ?? DEFAULT_SUBJECT) === subject)
        .map((assignment) => assignment.studentId),
    );
    return demoUsers.filter((user) => user.role === 'student' && assignedIds.has(user.uid));
  }

  ensureDb();
  const assignmentsSnapshot = await getDocs(query(
    collection(db, collections.tutorStudentAssignments),
    where('tutorId', '==', tutorId),
    where('subject', '==', subject),
    where('active', '==', true),
  ));
  const studentIds = assignmentsSnapshot.docs.map((item) => item.data().studentId).filter(Boolean);
  const students = await Promise.all(studentIds.map((studentId) => getDoc(doc(db, collections.users, studentId))));
  return students.filter((snapshot) => snapshot.exists()).map((snapshot) => snapshot.data());
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
  status = 'completed',
}) => {
  const completedOn = status === 'completed' ? (lessonDate || new Date().toISOString().slice(0, 10)) : '';
  const scheduledFor = lessonDate || new Date().toISOString().slice(0, 10);
  if (!isFirebaseConfigured) {
    return {
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
      status,
      completedOn,
    };
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
    status,
    completedOn,
    createdAt: serverTimestamp(),
  });
  return { id: ref.id, studentId, tutorId, subject, topic, topics: topics ?? (topic ? [topic] : []), topicUnderstandingScores, topicReport, understandingLevel, studentName, lessonDate: scheduledFor, lessonType, status, completedOn };
};

export const assignStudentToTutor = async ({ studentId, tutorId, subject = DEFAULT_SUBJECT }) => {
  if (!isFirebaseConfigured) {
    return { id: 'mock-assignment', studentId, tutorId, subject };
  }
  ensureDb();

  const existing = await getDocs(
    query(
      collection(db, collections.tutorStudentAssignments),
      where('studentId', '==', studentId),
      where('subject', '==', subject),
      where('active', '==', true),
      limit(1),
    ),
  );

  if (!existing.empty) {
    throw new Error(`This student already has an active ${subject} tutor assignment.`);
  }

  const assignmentId = buildTutorAssignmentId({ studentId, tutorId, subject });
  const ref = doc(db, collections.tutorStudentAssignments, assignmentId);
  await setDoc(ref, {
    studentId,
    tutorId,
    subject,
    active: true,
    assignedAt: serverTimestamp(),
  });

  await updateDoc(doc(db, collections.users, studentId), {
    assignedTutorIds: arrayUnion(tutorId),
    assignedSubjects: arrayUnion(subject),
    updatedAt: serverTimestamp(),
  });

  return { id: ref.id, studentId, tutorId, subject };
};

export const getAdminSubjectAssignmentData = async (subject = DEFAULT_SUBJECT) => {
  if (!isFirebaseConfigured) {
    const students = demoUsers.filter((user) => user.role === 'student' && getUserSubjects(user).includes(subject));
    const tutors = demoUsers.filter((user) => user.role === 'tutor' && getApprovedTutorSubjects(user).includes(subject));
    const assignments = mockStudentAssignments
      .filter((assignment) => assignment.active !== false && (assignment.subject ?? DEFAULT_SUBJECT) === subject)
      .map((assignment) => {
        const student = students.find((item) => item.uid === assignment.studentId);
        const tutor = tutors.find((item) => item.uid === assignment.tutorId);
        return {
          ...assignment,
          id: `${assignment.studentId}-${assignment.tutorId}-${subject}`,
          studentName: student?.displayName ?? student?.email ?? 'Student',
          tutorName: tutor?.displayName ?? tutor?.email ?? 'Tutor',
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
  const tutors = users.filter((user) => user.role === 'tutor' && getApprovedTutorSubjects(user).includes(subject));
  const studentMap = new Map(students.map((student) => [student.uid, student]));
  const tutorMap = new Map(tutors.map((tutor) => [tutor.uid, tutor]));
  const assignments = assignmentsSnapshot.docs.map((item) => {
    const assignment = { id: item.id, ...item.data() };
    const student = studentMap.get(assignment.studentId);
    const tutor = tutorMap.get(assignment.tutorId);
    return {
      ...assignment,
      studentName: student?.displayName ?? student?.email ?? 'Student',
      tutorName: tutor?.displayName ?? tutor?.email ?? 'Tutor',
    };
  });
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
  return onSnapshot(query(collection(db, collections.questionPapers), orderBy('year', 'desc')), (snapshot) => {
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
    ...(paper.analysisStatus === 'Analyzing' ? { analysisRequestedAt: serverTimestamp() } : {}),
  };

  const ref = await addDoc(collection(db, collections.questionPapers), payload);
  return { id: ref.id, ...payload };
};



export const updateQuestionPaper = async (paperId, patch) => {
  if (!paperId) throw new Error('Question paper id is required.');
  if (!isFirebaseConfigured) return { id: paperId, ...patch };
  ensureDb();
  const paperRef = doc(db, collections.questionPapers, paperId);
  const payload = {
    ...patch,
    ...(patch.analysisStatus === 'Analyzing' ? { analysisRequestedAt: serverTimestamp() } : {}),
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

export const completePeerMarkingAssignment = async ({ assignmentId, reviewImageUrl, reviewFileName }) => {
  if (!assignmentId) throw new Error('Peer marking assignment id is required.');
  if (!isFirebaseConfigured) return { id: assignmentId, reviewImageUrl, reviewFileName, status: 'completed' };
  ensureDb();
  const assignmentRef = doc(db, collections.peerMarkingAssignments, assignmentId);
  const assignmentSnap = await getDoc(assignmentRef);
  if (!assignmentSnap.exists()) throw new Error('Peer marking assignment not found.');
  const assignment = assignmentSnap.data();
  await updateDoc(assignmentRef, {
    reviewImageUrl,
    reviewFileName,
    status: 'completed',
    completedAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  if (assignment.exerciseId) {
    await updateDoc(doc(db, collections.dailyExerciseAssignments, assignment.exerciseId), {
      peerReviewed: 'Yes',
      peerReviewStatus: 'completed',
      peerReviewDate: serverTimestamp(),
      submittedReviewImageUrl: reviewImageUrl,
      submittedReviewFileName: reviewFileName,
      peerReviewerId: assignment.reviewerId,
    });
  }
  return { id: assignmentId, reviewImageUrl, reviewFileName, status: 'completed' };
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
  const snapshot = await getDoc(doc(db, collections.dailyExerciseAssignments, exerciseId));
  return snapshot.exists() ? { id: snapshot.id, ...snapshot.data() } : null;
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

export const generateExercisePlanIfEligible = async ({ student, mode, subject = DEFAULT_SUBJECT, latestTutorReport, completedLesson, understandingLevel, availablePapers, onProgress, overrideFutureUnsubmitted = false, targetAssignmentDates = null, dailyExerciseCaps = {}, overrideExerciseIdsByDate = {} }) => {
  const studentState = await getStudentAccessState(student, subject);
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
  const assignmentHistory = await getAssignmentHistory(student?.uid, subject);
  const recentExerciseHistory = getRecentExerciseHistoryForAi(assignmentHistory, 28);
  const ready = overrideFutureUnsubmitted || (mode === 'initial'
    ? Boolean(studentState.initialGenerationReady && !studentState.hasInitialGeneration)
    : Boolean(studentState.weeklyGenerationReady && studentState.hasInitialGeneration));

  if (!ready) {
    return {
      generated: false,
      reason: `Criteria not met for ${mode} generation`,
      criteria: studentState.generationStatus,
      assignments: [],
    };
  }

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

  const generationNumber = mode === 'weekly' ? getGenerationNumber(assignmentHistory, 'weekly') : 1;
  const assignmentDates = targetAssignmentDates ?? buildAssignmentDates({ mode, assignmentHistory });
  const aiPlan = buildAiQuestionPlan({
    mode,
    topicSummaries,
    assignmentDates,
    generationNumber,
    dailyExerciseCaps,
  });
  const generationBatchId = `${mode}-${student.uid}-${Date.now()}`;
  const aiResponse = await recommendExercises({
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
    dailyExerciseCaps,
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
    selectedPapers,
    generationBatchId,
    mode,
    subject,
    topicSummaries,
    maxExercisesPerDay: aiPlan.maxExercisesPerDay,
    dailyExerciseCaps,
    allowedAssignmentDates: assignmentDates,
    grade: student?.grade,
  }).filter((assignment) => Boolean(assignment.assignmentDate));

  if (!isFirebaseConfigured) {
    return {
      generated: assignments.length > 0,
      reason: 'Demo generation complete',
      assignments,
      criteria: {
        ...studentState.generationStatus,
        selectedPaperIds: selectedPapers.map((paper) => paper.id),
        excludedRecentPaperIds: recentPaperIds,
        reusedRecentPapers,
        topicsWithoutSources,
      },
    };
  }

  ensureDb();
  const createdAssignments = [];
  const existingCounts = new Map();
  for (const assignment of assignments) {
    const assignmentDate = assignment.assignmentDate;
    if (overrideFutureUnsubmitted) continue;
    if (!existingCounts.has(assignmentDate)) {
      const snapshot = await getDocs(query(
        collection(db, collections.dailyExerciseAssignments),
        where('studentId', '==', assignment.studentId),
        where('subject', '==', subject),
        where('assignmentDate', '==', assignmentDate),
      ));
      existingCounts.set(assignmentDate, snapshot.size);
    }

    const cap = dailyExerciseCaps[assignmentDate] ?? aiPlan.maxExercisesPerDay;
    if (existingCounts.get(assignmentDate) >= cap) continue;
    const ref = await addDoc(collection(db, collections.dailyExerciseAssignments), { ...assignment, createdAt: serverTimestamp() });
    existingCounts.set(assignmentDate, existingCounts.get(assignmentDate) + 1);
    createdAssignments.push({ id: ref.id, ...assignment });
  }

  if (overrideFutureUnsubmitted) {
    const replacementsByDate = new Map();
    assignments.forEach((assignment) => {
      const replacements = replacementsByDate.get(assignment.assignmentDate) ?? [];
      replacements.push(assignment);
      replacementsByDate.set(assignment.assignmentDate, replacements);
    });
    const replacementRows = await runTransaction(db, async (transaction) => {
      const safeDates = [];
      for (const assignmentDate of assignmentDates) {
        const oldIds = overrideExerciseIdsByDate[assignmentDate] ?? [];
        const replacements = replacementsByDate.get(assignmentDate) ?? [];
        if (!oldIds.length || replacements.length !== dailyExerciseCaps[assignmentDate]) continue;
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
            generationMode: sourceGeneration.generationMode || item.generationMode,
            generationBatchId: sourceGeneration.generationBatchId || item.generationBatchId || generationBatchId,
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
      reason: `Regenerated ${replacementRows.length} future unsubmitted exercises.`,
      assignments: replacementRows,
      criteria: { ...studentState.generationStatus, selectedPaperIds: selectedPapers.map((paper) => paper.id) },
    };
  }

  return {
    generated: createdAssignments.length > 0,
    reason: `${mode} generation complete`,
    assignments: createdAssignments,
    criteria: {
      ...studentState.generationStatus,
      selectedPaperIds: selectedPapers.map((paper) => paper.id),
      excludedRecentPaperIds: recentPaperIds,
      reusedRecentPapers,
      topicsWithoutSources,
    },
  };
};

const isExerciseSubmitted = (exercise) => Boolean(
  exercise?.submittedImageUrl || exercise?.submitted === 'Yes' || exercise?.submissionStatus === 'submitted'
);

const getLocalDate = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
};

export const regenerateFutureUnsubmittedExercisesForTutor = async ({ tutorId, student, subject = DEFAULT_SUBJECT, onProgress }) => {
  if (!tutorId || !student?.uid) throw new Error('Tutor and student are required to regenerate exercises.');
  const contexts = await getTutorAssignedStudentContexts(tutorId);
  const assignedContext = contexts.find((context) => context.studentId === student.uid && context.subject === subject);
  if (!assignedContext) throw new Error('This student is not assigned to this tutor for the selected subject.');

  if (!isFirebaseConfigured) {
    return generateExercisePlanIfEligible({ student, subject, mode: 'weekly', overrideFutureUnsubmitted: true, onProgress });
  }

  ensureDb();
  const today = getLocalDate();
  const snapshot = await getDocs(query(
    collection(db, collections.dailyExerciseAssignments),
    where('studentId', '==', student.uid),
    where('subject', '==', subject),
    where('assignmentDate', '>=', today),
    orderBy('assignmentDate', 'asc'),
  ));
  const eligible = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
  const unsubmitted = eligible.filter((item) => !isExerciseSubmitted(item));
  if (!unsubmitted.length) return { generated: false, reason: 'There are no future unsubmitted exercises to regenerate.', assignments: [] };

  const statusRef = doc(db, collections.exerciseGenerationStatus, `${student.uid}_${subject}`);
  const saveStatus = (status, message) => setDoc(statusRef, {
    studentId: student.uid,
    tutorId,
    subject,
    status,
    message,
    updatedAt: serverTimestamp(),
    ...(status === 'processing' ? { finishedAtMs: null } : { finishedAtMs: Date.now() }),
  }, { merge: true });

  const idsByDate = new Map();
  unsubmitted.forEach((item) => {
    const ids = idsByDate.get(item.assignmentDate) ?? [];
    ids.push(item.id);
    idsByDate.set(item.assignmentDate, ids);
  });
  const targetAssignmentDates = [...idsByDate.keys()].sort();
  const dailyExerciseCaps = Object.fromEntries([...idsByDate.entries()].map(([date, ids]) => [date, Math.min(ids.length, MAX_DAILY_EXERCISES)]));
  const overrideExerciseIdsByDate = Object.fromEntries(idsByDate);
  await saveStatus('processing', 'Preparing analyzed paper metadata for exercise regeneration.');
  try {
    const result = await generateExercisePlanIfEligible({
      student: { ...assignedContext, ...student, uid: student.uid },
      subject,
      mode: 'weekly',
      overrideFutureUnsubmitted: true,
      targetAssignmentDates,
      dailyExerciseCaps,
      overrideExerciseIdsByDate,
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
    const assignedIds = new Set(
      mockStudentAssignments
        .filter((assignment) => assignment.tutorId === tutorId && assignment.active !== false && (assignment.subject ?? DEFAULT_SUBJECT) === subject)
        .map((assignment) => assignment.studentId),
    );
    const demoStudents = demoUsers.filter((user) => user.role === 'student' && assignedIds.has(user.uid));
    callback(demoStudents);
    return () => {};
  }
  const q = query(
    collection(db, collections.tutorStudentAssignments),
    where('tutorId', '==', tutorId),
    where('subject', '==', subject),
    where('active', '==', true),
  );
  return onSnapshot(q, async (snapshot) => {
    const studentSnapshots = await Promise.all(
      snapshot.docs
        .map((item) => item.data().studentId)
        .filter(Boolean)
        .map((studentId) => getDoc(doc(db, collections.users, studentId))),
    );
    callback(studentSnapshots.filter((item) => item.exists()).map((item) => item.data()));
  }, (error) => console.error('[Examifying][Firestore] subscribeToAssignedStudents error', error));
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
  const snapshot = await getDocs(query(
    collection(db, collections.tutorStudentAssignments),
    where('studentId', '==', studentId),
    where('active', '==', true),
  ));
  return [...new Set(snapshot.docs.map((item) => item.data().subject ?? DEFAULT_SUBJECT).filter(Boolean))];
};

export const getTutorAssignedStudentContexts = async (tutorId) => {
  if (!tutorId) return [];
  if (!isFirebaseConfigured) {
    return mockStudentAssignments
      .filter((assignment) => assignment.tutorId === tutorId && assignment.active !== false)
      .map((assignment) => {
        const student = demoUsers.find((user) => user.uid === assignment.studentId) ?? {};
        return { ...student, studentId: assignment.studentId, subject: assignment.subject ?? DEFAULT_SUBJECT, assignmentId: assignment.id };
      });
  }

  ensureDb();
  const assignmentsSnapshot = await getDocs(query(
    collection(db, collections.tutorStudentAssignments),
    where('tutorId', '==', tutorId),
    where('active', '==', true),
  ));
  const assignments = assignmentsSnapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
  const studentSnapshots = await Promise.all(assignments.map((assignment) => getDoc(doc(db, collections.users, assignment.studentId))));
  return assignments.map((assignment, index) => ({
    ...(studentSnapshots[index].exists() ? studentSnapshots[index].data() : {}),
    studentId: assignment.studentId,
    uid: assignment.studentId,
    subject: assignment.subject ?? DEFAULT_SUBJECT,
    assignmentId: assignment.id,
  }));
};

export const getTutorReportsForAssignedStudents = async (tutorId) => {
  if (!tutorId) return [];
  if (!isFirebaseConfigured) return mockTutorReports.filter((report) => report.tutorId === tutorId);
  ensureDb();
  const snapshot = await getDocs(query(collection(db, collections.tutorReports), where('tutorId', '==', tutorId)));
  return snapshot.docs
    .map((item) => ({ id: item.id, ...item.data() }))
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
  if (!isFirebaseConfigured) return mockCompletedLessons.filter((lesson) => lesson.tutorId === tutorId);
  ensureDb();
  const snapshot = await getDocs(query(collection(db, collections.coveredTopics), where('tutorId', '==', tutorId)));
  return snapshot.docs.map((item) => ({ id: item.id, ...item.data() })).sort((left, right) => String(right.completedOn || right.lessonDate || '').localeCompare(String(left.completedOn || left.lessonDate || '')));
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

export const updateCompletedLesson = async ({ lessonId, topicReport = '', topicUnderstandingScores = [], topics = [], understandingLevel = null, lessonDate, lessonType, status }) => {
  if (!lessonId) throw new Error('Lesson id is required.');
  const isCompleted = status === 'completed';
  if (!isFirebaseConfigured) return { id: lessonId, topicReport, topicUnderstandingScores, topics, understandingLevel, lessonDate, lessonType, status };
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
    ...(status ? { status } : {}),
    ...(isCompleted ? { completedOn: lessonDate || new Date().toISOString().slice(0, 10) } : {}),
    updatedAt: serverTimestamp(),
  };
  await updateDoc(doc(db, collections.coveredTopics, lessonId), payload);
  return { id: lessonId, ...payload };
};

export const deleteLesson = async (lessonId) => {
  if (!lessonId) throw new Error('Lesson id is required.');
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
  await updateDoc(doc(db, collections.users, studentId), {
    subjects: arrayUnion(...cleanSubjects),
    subject: DEFAULT_SUBJECT,
    updatedAt: serverTimestamp(),
  });
  return { studentId, subjects: cleanSubjects };
};

export const addStudentSubject = async ({ studentId, subject }) => addStudentSubjects({ studentId, subjects: [subject] });



export const removeUserSubject = async ({ uid, subject }) => {
  if (!subject) throw new Error('Choose a subject to remove.');

  if (!isFirebaseConfigured) {
    return { uid, subject };
  }

  ensureDb();
  const userRef = doc(db, collections.users, uid);
  const snapshot = await getDoc(userRef);
  const profile = snapshot.exists() ? snapshot.data() : {};
  const remainingSubjects = (Array.isArray(profile.subjects) ? profile.subjects : []).filter((item) => item !== subject);
  const remainingMarks = (Array.isArray(profile.tutorSubjectMarks) ? profile.tutorSubjectMarks : []).filter((item) => item.subject !== subject);

  await updateDoc(userRef, {
    subjects: arrayRemove(subject),
    tutorSubjectMarks: remainingMarks,
    subject: profile.subject === subject ? (remainingSubjects[0] ?? null) : (profile.subject ?? null),
    updatedAt: serverTimestamp(),
  });

  return { uid, subject };
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
