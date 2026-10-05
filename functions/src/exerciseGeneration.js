import { createHash } from 'node:crypto';
import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { onTaskDispatched } from 'firebase-functions/v2/tasks';
import { logger } from 'firebase-functions';
import { getDb, taskQueue } from './admin.js';
import {
  buildRuleBasedExercisePlan,
  createExerciseDateWindow,
  getExerciseGenerationDayCount,
  MAX_EXERCISE_GENERATION_DAYS,
  MAX_EXERCISES_PER_DATE as MAX_DAILY_EXERCISES,
  MAX_QUESTIONS_PER_EXERCISE,
  MARKED_TOPIC_MIN_GENERATION_SCORE,
  WEEKLY_EXERCISE_DAYS,
} from './exerciseGenerationRules.js';

const TIME_ZONE = 'Africa/Johannesburg';
const HISTORY_LIMIT = 40;
const LOCK_TIMEOUT_MS = 20 * 60 * 1000;
const TASK_OPTIONS = {
  retryConfig: { maxAttempts: 5, minBackoffSeconds: 15, maxBackoffSeconds: 300, maxDoublings: 4 },
  rateLimits: { maxConcurrentDispatches: 3, maxDispatchesPerSecond: 2 },
  timeoutSeconds: 240,
  memory: '512MiB',
};

const localDateKey = (date = new Date()) => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
};

const dateOnly = (value) => {
  if (!value) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  const date = value?.toDate ? value.toDate() : value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : localDateKey(date);
};

const addDays = (dateKey, count) => {
  const [year, month, day] = dateKey.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + count));
  return date.toISOString().slice(0, 10);
};

const normalizeTopic = (value = '') => String(value ?? '')
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLocaleLowerCase()
  .replace(/[^a-z0-9]+/g, ' ')
  .trim();

const topicParts = (value = '') => {
  const parts = String(value ?? '').split('|').map(normalizeTopic).filter(Boolean);
  return parts.length === 2 ? parts : [normalizeTopic(value)].filter(Boolean);
};

const topicLabelsMatch = (left, right) => {
  const leftParts = topicParts(left);
  const rightParts = topicParts(right);
  if (!leftParts.length || !rightParts.length) return false;
  if (leftParts.length === 2 && rightParts.length === 2) {
    return leftParts[0] === rightParts[0] && leftParts[1] === rightParts[1];
  }
  if (leftParts.length === 2) return rightParts[0] === leftParts[0];
  if (rightParts.length === 2) return leftParts[0] === rightParts[0];
  return leftParts[0] === rightParts[0];
};

const questionMatchesTopics = (question, topics = []) => {
  const questionTopics = [question?.topic, ...(Array.isArray(question?.topics) ? question.topics : [])]
    .map((item) => String(item ?? '').trim()).filter(Boolean);
  return questionTopics.some((questionTopic) => topics.some((topic) => topicLabelsMatch(questionTopic, topic)));
};

const isSubmitted = (exercise) => Boolean(
  exercise?.submittedImageUrl || exercise?.submitted === 'Yes' || exercise?.submissionStatus === 'submitted',
);

const isCompletedLessonRecord = (lesson) => {
  if (!lesson || lesson.status !== 'completed' || lesson.attended === false || lesson.attendanceStatus === 'missed') return false;
  return Boolean(String(lesson.topicReport ?? lesson.note ?? '').trim());
};

const isReadyCompletedLesson = (lesson) => {
  if (!isCompletedLessonRecord(lesson)) return false;
  if (Array.isArray(lesson.topicUnderstandingScores) && lesson.topicUnderstandingScores.length) {
    return lesson.topicScoreCountMatches !== false
      && lesson.topicUnderstandingScores.every((entry) => Number.isFinite(Number(entry?.understandingLevel)));
  }
  if (lesson.topicScoreCountMatches === false) return false;
  return Number.isFinite(Number(lesson.understandingLevel));
};

const normalizeTopicKey = (value = '') => String(value)
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/['’]s\b/g, '')
  .replace(/&/g, ' and ')
  .replace(/[^a-z0-9]+/g, ' ')
  .trim()
  .replace(/\s+/g, ' ');

const hydrateLessonScores = async (episodeRef, lesson) => {
  if (!isCompletedLessonRecord(lesson)) return lesson;
  const topics = [...new Set((Array.isArray(lesson.topics) && lesson.topics.length ? lesson.topics : [lesson.topic])
    .filter(Boolean).map((topic) => String(topic).trim()))];
  const snapshots = await Promise.all(topics.map((topic) => episodeRef.collection('topics')
    .doc(normalizeTopicKey(topic)).collection('understandingScores').doc(`Lesson-${lesson.id}`).get()));
  const topicUnderstandingScores = snapshots.flatMap((snapshot, index) => {
    if (!snapshot.exists) return [];
    const data = snapshot.data();
    const score = Number(data.score);
    const ratio = data.scoreScale === 'ratio-0-to-1' ? score : score <= 10 ? score / 10 : NaN;
    if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) return [];
    return [{ topic: topics[index], understandingLevel: ratio, topicReport: data.notes ?? '' }];
  });
  if (!topicUnderstandingScores.length || topicUnderstandingScores.length !== topics.length) {
    return { ...lesson, topicUnderstandingScores, topicScoreCountMatches: topicUnderstandingScores.length === topics.length };
  }
  const understandingLevel = Math.round((topicUnderstandingScores.reduce((sum, item) => sum + item.understandingLevel, 0)
    / topicUnderstandingScores.length) * 10000) / 10000;
  return { ...lesson, topicUnderstandingScores, topicScoreCountMatches: true, understandingLevel };
};

const triggerSignature = (lesson) => JSON.stringify({
  status: lesson?.status,
  attended: lesson?.attended,
  attendanceStatus: lesson?.attendanceStatus,
  completedOn: lesson?.completedOn,
  topics: lesson?.topics ?? [],
  scores: (lesson?.topicUnderstandingScores ?? []).map((entry) => ({
    topic: String(entry?.topic ?? '').trim(),
    understandingLevel: Number(entry?.understandingLevel),
  })),
  report: lesson?.topicReport ?? lesson?.note ?? '',
  understandingLevel: lesson?.understandingLevel ?? null,
});

const timestampMillis = (value) => value?.toMillis?.() ?? value?.toDate?.().getTime()
  ?? (value ? new Date(value).getTime() : 0);

const scoreAsRatio = (topic) => topic?.understandingScale === 'ratio-0-to-1'
  && topic.understandingLevel !== null
  && topic.understandingLevel !== undefined
  && Number.isFinite(Number(topic.understandingLevel))
  && Number(topic.understandingLevel) >= 0
  && Number(topic.understandingLevel) <= 1
  ? Number(topic.understandingLevel)
  : null;

const topicSummaryFromDoc = (doc) => {
  const data = doc.data();
  if (['planned', 'pending', 'missed', 'cancelled', 'removed'].includes(data.topicStatus)
    || ['pending', 'missed', 'cancelled', 'removed'].includes(data.attendanceStatus)) return null;
  const topicStatus = data.topicStatus === 'marked' || data.attendanceStatus === 'not-attended'
    ? 'marked'
    : data.topicStatus === 'done' || data.attendanceStatus === 'attended' || data.firstCompletedAt || data.lastCoveredAt
      ? 'done'
      : null;
  if (!topicStatus) return null;
  const scoreDate = topicStatus === 'marked'
    ? data.firstMarkedAt ?? data.scoreUpdatedAt ?? data.createdAt
    : data.lastCoveredAt ?? data.firstCompletedAt ?? data.createdAt;
  return {
    topic: String(data.topicName || data.canonicalTopicKey || doc.id).trim(),
    topicStatus,
    understandingLevel: scoreAsRatio(data),
    reportSnippet: String(data.tutorReport || data.latestReport || '').trim(),
    completedOn: dateOnly(scoreDate) ?? '',
  };
};

const eligibleTopics = (topics) => topics.filter((topic) => topic.topicStatus === 'done'
  || (topic.topicStatus === 'marked' && Number(topic.understandingLevel) >= MARKED_TOPIC_MIN_GENERATION_SCORE));

const isAnalyzedPaper = (paper) => paper.analysisStatus === 'Analyzed'
  && paper.availableForGeneration !== false
  && Array.isArray(paper.questions)
  && paper.questions.length > 0;

const paperMatchesStudent = (paper, { grade, region, subject }) => paper.subject === subject
  && (!paper.grade || !grade || paper.grade === grade)
  && (paper.region === region || paper.region === 'National');

const getSubscriptionQuote = (subscription) => {
  const planId = subscription?.planId;
  const subjectCount = Number(subscription?.subjectCount);
  const billingPeriod = subscription?.billingPeriod ?? 'monthly';
  if (!['circle', 'personalized'].includes(planId)
    || !Number.isInteger(subjectCount) || subjectCount < 1 || subjectCount > 20
    || !['monthly', 'yearly'].includes(billingPeriod)) return null;
  const base = planId === 'circle' ? 199 : 999;
  const additional = planId === 'circle' ? 49 : 599;
  const monthlyAmount = base + Math.max(0, subjectCount - 1) * additional;
  return {
    amount: billingPeriod === 'yearly' ? monthlyAmount * 10 : monthlyAmount,
    currency: 'ZAR',
    planId,
    subjectCount,
    billingPeriod,
  };
};

const hasVerifiedPaidAccess = async ({ db, studentId, subscription, now = new Date() }) => {
  const quote = getSubscriptionQuote(subscription);
  if (!quote || !['active', 'past_due'].includes(subscription?.status)) return false;
  const renewalDate = subscription.renewalDate?.toDate?.() ?? new Date(subscription.renewalDate ?? 0);
  const graceEndsAt = subscription.graceEndsAt?.toDate?.() ?? new Date(subscription.graceEndsAt ?? 0);
  const active = subscription.status === 'active' && Number.isFinite(renewalDate.getTime()) && renewalDate > now;
  const inGrace = subscription.status === 'past_due' && Number.isFinite(graceEndsAt.getTime()) && graceEndsAt > now;
  if (!active && !inGrace) return false;
  const reference = String(subscription.latestReference ?? '').trim();
  if (!reference) return false;
  const paymentSnapshot = await db.doc(`users/${studentId}/payments/${reference}`).get();
  if (!paymentSnapshot.exists) return false;
  const payment = paymentSnapshot.data();
  if (payment.status !== 'success' || payment.reference !== reference || payment.studentId !== studentId
    || payment.planId !== quote.planId || payment.billingPeriod !== quote.billingPeriod
    || Number(payment.subjectCount) !== quote.subjectCount || payment.currency !== quote.currency) return false;

  const percent = Number(payment.discountPercent);
  const discounted = Number.isInteger(percent) && percent >= 1 && percent <= 100;
  if (discounted && (!payment.discountCode || payment.discountCode !== subscription.discountCode
    || Number(subscription.discountPercent) !== percent
    || payment.discountBillingDuration !== subscription.discountBillingDuration)) return false;
  if (!discounted && Number(subscription.discountPercent) > 0) return false;
  const expectedAmount = discounted ? Math.round((quote.amount * (100 - percent)) * 100 / 100) / 100 : quote.amount;
  if (payment.subscriptionAmountDue !== null && payment.subscriptionAmountDue !== undefined
    && Number(payment.subscriptionAmountDue) !== expectedAmount) return false;
  if (payment.authorizationOnly === true) {
    return expectedAmount === 0 && Number(payment.amount) === Number(payment.authorizationChargeAmount)
      && Number(payment.authorizationChargeAmount) > 0;
  }
  return Number(payment.amount) === expectedAmount;
};

const buildAssignmentDates = ({ history, dayCount }) => {
  const latest = history.map((item) => dateOnly(item.assignmentDate)).filter(Boolean).sort().at(-1);
  const first = latest ? addDays(latest, 1) : localDateKey();
  const count = Math.max(WEEKLY_EXERCISE_DAYS, Math.min(MAX_EXERCISE_GENERATION_DAYS, Number(dayCount) || WEEKLY_EXERCISE_DAYS));
  return Array.from({ length: count }, (_, index) => addDays(first, index));
};

const normalizeQuestionTitle = (references) => references.map((item) => String(item ?? '').trim()).filter(Boolean).join(' | ');

const buildAssignments = ({ recommendations, studentId, subject, grade, subscription, selectedPapers, topicSummaries, mode, generationWeek, generationBatchId }) => recommendations.map((recommendation, index) => {
  const questions = recommendation.questions.map((entry) => ({
    topic: String(entry.topic || 'Subject topic').trim(),
    questionReference: String(entry.questionReference || entry.reference || '').trim(),
    paperId: String(entry.paperId || '').trim(),
    pageNumber: Number(entry.pageNumber ?? entry.page) || 1,
    marks: Number(entry.marks) || 0,
  })).filter((entry) => entry.questionReference);
  const topicBreakdown = questions.map(({ topic, questionReference }) => ({ topic, questionReference }));
  const questionReferences = questions.map((entry) => entry.questionReference);
  const questionLinks = questions.map(({ paperId, pageNumber, questionReference, topic, marks }) => ({
    paperId, pageNumber, questionReference, topic, marks,
  }));
  const paperIds = [...new Set(questions.map((item) => item.paperId).filter(Boolean))];
  const sourcePapers = paperIds.map((paperId) => selectedPapers.find((paper) => paper.id === paperId)).filter(Boolean);
  return {
    studentId,
    assignmentDate: recommendation.assignmentDate,
    questionCount: questions.length,
    title: normalizeQuestionTitle(questionReferences) || `Question set ${index + 1}`,
    topic: topicBreakdown.map((item) => item.topic).filter(Boolean).join(' | ') || 'Subject topic',
    sourceLabel: sourcePapers.map((paper) => paper.displayName || [paper.year, paper.region, paper.month, paper.paperNumber ?? 'paper'].filter(Boolean).join(' ')).join('; ')
      || selectedPapers.map((paper) => `${paper.year ?? ''} ${paper.region ?? ''} ${paper.month ?? ''} paper`.trim()).join('; '),
    instruction: 'Answer the referenced question number(s) only.',
    subject,
    grade: grade ?? null,
    generatedBy: 'local-question-index-planner',
    generationMode: mode,
    generationBatchId,
    generationWeek,
    paidSubscriptionActive: true,
    subscriptionId: studentId,
    subscriptionPlanId: subscription.planId,
    subscriptionPlanName: subscription.planId === 'circle' ? 'Circle' : 'Personalized',
    subscriptionPaymentReference: subscription.latestReference ?? null,
    paperIds,
    understandingLevel: null,
    reportSnippet: topicBreakdown.map(({ topic }) => {
      const match = topicSummaries.find((item) => item.topic === topic);
      return match?.reportSnippet ? `${topic}: ${match.reportSnippet}` : topic;
    }).filter(Boolean).join('\n'),
    questionReferences,
    questionLinks,
    questions,
    topicBreakdown,
    submittedImageUrl: '',
    submittedFileName: '',
    peerReviewed: 'No',
    peerReviewStatus: 'pending',
    peerReviewDate: null,
    submittedReviewImageUrl: '',
    submittedReviewFileName: '',
  };
});

const eventRequestId = (value) => createHash('sha256').update(String(value)).digest('hex').slice(0, 40);

const enqueueGeneration = async (payload) => {
  const { studentId, subjectInstanceId, triggerKey } = payload;
  if (!studentId || !subjectInstanceId || !triggerKey) return;
  await taskQueue('runAutomaticExerciseGeneration').enqueue({
    ...payload,
    requestId: eventRequestId(triggerKey),
  }, { scheduleDelaySeconds: 5 });
};

export const queueExerciseGenerationAfterLesson = onDocumentWritten(
  {
    document: 'users/{studentId}/subjects/{subjectInstanceId}/lessons/{lessonId}',
    retry: true,
    memory: '256MiB',
    maxInstances: 10,
  },
  async (event) => {
    const after = event.data?.after?.exists ? event.data.after.data() : null;
    const before = event.data?.before?.exists ? event.data.before.data() : null;
    if (!isCompletedLessonRecord(after)) return;
    if (isCompletedLessonRecord(before) && triggerSignature(before) === triggerSignature(after)) return;
    const episodeRef = getDb().doc(`users/${event.params.studentId}/subjects/${event.params.subjectInstanceId}`);
    const hydratedLesson = await hydrateLessonScores(episodeRef, { id: event.params.lessonId, ...after });
    if (!isReadyCompletedLesson(hydratedLesson)) return;
    await enqueueGeneration({
      studentId: event.params.studentId,
      subjectInstanceId: event.params.subjectInstanceId,
      subject: String(after.subject ?? '').trim(),
      reason: 'lesson',
      sourceLessonId: event.params.lessonId,
      sourceLessonSignature: triggerSignature(hydratedLesson),
      triggerKey: `lesson:${event.id}`,
    });
  },
);

export const queueInitialExerciseGenerationAfterSubscription = onDocumentWritten(
  {
    document: 'users/{studentId}/subscriptions/current',
    retry: true,
    memory: '256MiB',
    maxInstances: 10,
  },
  async (event) => {
    const after = event.data?.after?.exists ? event.data.after.data() : null;
    const before = event.data?.before?.exists ? event.data.before.data() : null;
    if (!after) return;
    const relevantFields = ['planId', 'status', 'renewalDate', 'graceEndsAt', 'subjectCount', 'latestReference'];
    if (before && relevantFields.every((field) => String(before[field] ?? '') === String(after[field] ?? ''))) return;
    const db = getDb();
    const subjectSnapshot = await db.collection('users').doc(event.params.studentId).collection('subjects')
      .where('status', '==', 'active').limit(25).get();
    for (const episodeDoc of subjectSnapshot.docs) {
      const episode = episodeDoc.data();
      await enqueueGeneration({
        studentId: event.params.studentId,
        subjectInstanceId: episodeDoc.id,
        subject: String(episode.subjectKey ?? episode.subjectName ?? '').trim(),
        reason: 'subscription',
        triggerKey: `subscription:${event.id}:${episodeDoc.id}`,
      });
    }
  },
);

export const queuePendingInitialGenerationAfterPaperAnalysis = onDocumentWritten(
  {
    document: 'questionPapers/{paperId}',
    retry: true,
    memory: '256MiB',
    maxInstances: 5,
  },
  async (event) => {
    const paper = event.data?.after?.exists ? event.data.after.data() : null;
    const before = event.data?.before?.exists ? event.data.before.data() : null;
    if (paper?.analysisStatus !== 'Analyzed' || before?.analysisStatus === 'Analyzed'
      || !String(paper.subject ?? '').trim()) return;
    const db = getDb();
    const pendingEpisodes = await db.collectionGroup('subjects').where('exerciseGenerationPending', '==', true).get();
    const candidateDocs = pendingEpisodes.docs.filter((episodeDoc) => {
      const path = episodeDoc.ref.path.split('/');
      if (path.length !== 4 || path[0] !== 'users' || path[2] !== 'subjects') return false;
      const episode = episodeDoc.data();
      const episodeGrade = String(episode.grade ?? '').trim();
      const pendingReason = episode.exerciseGenerationPendingTrigger;
      return episode.status === 'active'
        && String(episode.subjectKey ?? episode.subjectName ?? '').trim() === String(paper.subject).trim()
        && (!String(paper.grade ?? '').trim() || episodeGrade === String(paper.grade).trim())
        && ['initial', 'lesson'].includes(pendingReason);
    });
    for (const episodeDoc of candidateDocs) {
      const parts = episodeDoc.ref.path.split('/');
      const studentId = parts[1];
      const episode = episodeDoc.data();
      const [studentSnapshot, generationSnapshot] = await Promise.all([
        db.doc(`users/${studentId}`).get(),
        episodeDoc.ref.collection('generationRuns').where('status', '==', 'completed').limit(1).get(),
      ]);
      const student = studentSnapshot.data() ?? {};
      if (paper.region !== 'National' && String(student.province ?? '').trim() !== String(paper.region ?? '').trim()) continue;
      await enqueueGeneration({
        studentId,
        subjectInstanceId: episodeDoc.id,
        subject: String(episode.subjectKey ?? episode.subjectName ?? paper.subject).trim(),
        reason: episode.exerciseGenerationPendingTrigger,
        sourceLessonId: episode.exerciseGenerationPendingLessonId ?? null,
        sourceLessonSignature: episode.exerciseGenerationPendingLessonSignature ?? null,
        initialOnly: generationSnapshot.empty && episode.exerciseGenerationPendingTrigger === 'initial',
        triggerKey: `paper:${event.id}:${episodeDoc.id}`,
      });
    }
  },
);

const getMatchingPapers = async ({ db, subject, grade, region }) => {
  const snapshot = await db.collection('questionPapers').where('subject', '==', subject).get();
  return snapshot.docs
    .map((doc) => ({ id: doc.id, ...doc.data() }))
    .filter(isAnalyzedPaper)
    .filter((paper) => paperMatchesStudent(paper, { grade, region, subject }));
};

const getTopicSummaries = async (episodeRef) => {
  const snapshot = await episodeRef.collection('topics').get();
  return snapshot.docs.map(topicSummaryFromDoc).filter((item) => item?.topic);
};

const getHistory = async (episodeRef) => {
  const snapshot = await episodeRef.collection('exercises').orderBy('assignmentDate', 'desc').limit(HISTORY_LIMIT).get();
  return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
};

const getCompletedLessons = async (episodeRef) => {
  const snapshot = await episodeRef.collection('lessons').where('status', '==', 'completed').limit(HISTORY_LIMIT).get();
  return (await Promise.all(snapshot.docs.map((doc) => hydrateLessonScores(episodeRef, { id: doc.id, ...doc.data() }))))
    .filter(isReadyCompletedLesson);
};

const accessTimes = (dateKey) => ({
  assignmentOpensAt: new Date(`${dateKey}T00:00:00+02:00`),
  locksAt: new Date(`${dateKey}T23:59:59.999+02:00`),
});

const runAutomaticGeneration = async (requestData) => {
  const {
    studentId,
    subjectInstanceId,
    subject: requestedSubject,
    requestId,
    reason: requestedReason,
    sourceLessonId: requestedLessonId,
    sourceLessonSignature: requestedLessonSignature,
    initialOnly = false,
  } = requestData;
  if (!studentId || !subjectInstanceId || !requestId) throw new Error('Student, subject episode, and request ID are required.');
  const db = getDb();
  const studentRef = db.doc(`users/${studentId}`);
  const episodeRef = studentRef.collection('subjects').doc(subjectInstanceId);
  const requestRef = episodeRef.collection('generationRequests').doc(requestId);
  const today = localDateKey();
  const statusRef = episodeRef.collection('generationRuns').doc(today);
  const startedAtMs = Date.now();

  const lock = await db.runTransaction(async (transaction) => {
    const [requestSnapshot, statusSnapshot] = await Promise.all([
      transaction.get(requestRef),
      transaction.get(statusRef),
    ]);
    const previousRequest = requestSnapshot.exists ? requestSnapshot.data() : null;
    if (['completed', 'skipped'].includes(previousRequest?.status)) return { acquired: false, result: { generated: false, reason: 'This generation event has already been processed.' } };
    if (previousRequest?.status === 'processing' && startedAtMs - Number(previousRequest.startedAtMs ?? 0) < LOCK_TIMEOUT_MS) {
      return { acquired: false, result: { generated: false, busy: true, reason: 'This generation event is already running.' } };
    }
    const status = statusSnapshot.exists ? statusSnapshot.data() : null;
    if (status?.status === 'processing' && startedAtMs - Number(status.startedAtMs ?? 0) < LOCK_TIMEOUT_MS) {
      return { acquired: false, result: { generated: false, busy: true, reason: 'Exercise generation is already running for this student and subject.' } };
    }
    if (status?.status === 'completed' && requestedLessonId && requestedLessonSignature
      && status.sourceLessonId === requestedLessonId
      && status.sourceLessonSignature === requestedLessonSignature
      && (status.mode === 'initial' || status.lastTrigger === 'lesson')) {
      transaction.set(requestRef, { status: 'completed', reason: 'The lesson was already processed.', updatedAt: new Date() }, { merge: true });
      return { acquired: false, result: { generated: false, reason: 'The lesson was already processed.' } };
    }
    transaction.set(requestRef, { status: 'processing', startedAtMs, trigger: requestedReason, updatedAt: new Date() }, { merge: true });
    transaction.set(statusRef, {
      studentId,
      subjectInstanceId,
      dateKey: today,
      subject: requestedSubject ?? '',
      status: 'processing',
      lastTrigger: requestedReason,
      ...(requestedLessonId ? { sourceLessonId: requestedLessonId } : {}),
      ...(requestedLessonSignature ? { sourceLessonSignature: requestedLessonSignature } : {}),
      message: requestedReason === 'lesson' ? 'Preparing exercises for the newly completed lesson.' : 'Preparing exercise generation.',
      startedAtMs,
      expiresAtMs: startedAtMs + LOCK_TIMEOUT_MS,
      finishedAtMs: null,
      updatedAt: new Date(),
    }, { merge: true });
    return { acquired: true };
  });
  if (!lock.acquired) {
    if (lock.result?.busy) throw new Error(lock.result.reason);
    return lock.result;
  }

  let episode;
  let statusWritten = false;
  try {
    const [studentSnapshot, episodeSnapshot, subscriptionSnapshot, history, topics, completedLessons] = await Promise.all([
      studentRef.get(),
      episodeRef.get(),
      studentRef.collection('subscriptions').doc('current').get(),
      getHistory(episodeRef),
      getTopicSummaries(episodeRef),
      getCompletedLessons(episodeRef),
    ]);
    if (!studentSnapshot.exists || !episodeSnapshot.exists) throw new Error('Student or active subject episode no longer exists.');
    episode = episodeSnapshot.data();
    if (episode.status !== 'active') throw new Error('The subject is not active for this student.');
    const student = studentSnapshot.data();
    const subject = String(episode.subjectKey ?? episode.subjectName ?? requestedSubject ?? '').trim();
    if (!subject || (requestedSubject && requestedSubject !== subject)) throw new Error('The requested subject does not match the active subject episode.');
    const subscription = subscriptionSnapshot.exists ? subscriptionSnapshot.data() : null;
    const paid = await hasVerifiedPaidAccess({ db, studentId, subscription });

    const pendingTrigger = ['initial', 'lesson'].includes(episode.exerciseGenerationPendingTrigger)
      ? episode.exerciseGenerationPendingTrigger
      : null;
    const trigger = requestedReason === 'lesson' || pendingTrigger === 'lesson' ? 'lesson' : requestedReason;
    const generationHistory = history;
    const hasHistory = generationHistory.length > 0;
    const generationMode = hasHistory ? 'weekly' : 'initial';
    const latestCompletedLesson = [...completedLessons].sort((left, right) =>
      timestampMillis(right.updatedAt) - timestampMillis(left.updatedAt)
      || String(right.completedOn ?? '').localeCompare(String(left.completedOn ?? '')))[0] ?? null;
    const sourceLessonId = requestedLessonId || episode.exerciseGenerationPendingLessonId
      || (generationMode === 'initial' ? latestCompletedLesson?.id : null) || null;
    const lesson = sourceLessonId ? completedLessons.find((item) => item.id === sourceLessonId) : null;
    const sourceLessonSignature = requestedLessonSignature || episode.exerciseGenerationPendingLessonSignature
      || (lesson ? triggerSignature(lesson) : null);
    if (initialOnly && hasHistory && !(pendingTrigger === 'lesson' && sourceLessonId)) {
      await episodeRef.set({ exerciseGenerationPending: false, updatedAt: new Date() }, { merge: true });
      await requestRef.set({ status: 'skipped', reason: 'Initial generation already exists.', updatedAt: new Date() }, { merge: true });
      await statusRef.set({ status: 'completed', message: 'Initial exercises already exist.', finishedAtMs: Date.now(), expiresAtMs: Date.now(), updatedAt: new Date() }, { merge: true });
      statusWritten = true;
      return { generated: false, reason: 'Initial generation already exists.' };
    }
    if (trigger !== 'lesson' && hasHistory) {
      await requestRef.set({ status: 'skipped', reason: 'No initial generation is needed for this subject.', updatedAt: new Date() }, { merge: true });
      await statusRef.set({ status: 'completed', message: 'No new initial generation was needed.', finishedAtMs: Date.now(), expiresAtMs: Date.now(), updatedAt: new Date() }, { merge: true });
      statusWritten = true;
      return { generated: false, reason: 'No new initial generation was needed.' };
    }
    const eligibleCompletedLessons = lesson ? [...completedLessons.filter((item) => item.id !== lesson.id), lesson] : completedLessons;
    if (!eligibleCompletedLessons.length || (trigger === 'lesson' && !lesson)) {
      await episodeRef.set({ exerciseGenerationPending: false, updatedAt: new Date() }, { merge: true });
      await requestRef.set({ status: 'skipped', reason: 'A completed attended lesson with scores and a report is required.', updatedAt: new Date() }, { merge: true });
      await statusRef.set({ status: 'failed', message: 'A completed attended lesson with scores and a report is required.', finishedAtMs: Date.now(), expiresAtMs: Date.now(), updatedAt: new Date() }, { merge: true });
      statusWritten = true;
      return { generated: false, reason: 'A completed attended lesson with scores and a report is required.' };
    }
    if (!paid) {
      await episodeRef.set({
        exerciseGenerationPending: false,
        exerciseGenerationPendingTrigger: null,
        exerciseGenerationPendingLessonId: null,
        updatedAt: new Date(),
      }, { merge: true });
      await requestRef.set({ status: 'skipped', reason: 'A verified active paid subscription is required.', updatedAt: new Date() }, { merge: true });
      await statusRef.set({ status: 'failed', message: 'A verified active paid subscription is required.', finishedAtMs: Date.now(), expiresAtMs: Date.now(), updatedAt: new Date() }, { merge: true });
      statusWritten = true;
      return { generated: false, reason: 'A verified active paid subscription is required.' };
    }

    const grade = String(episode.grade ?? student.grade ?? '').trim();
    const region = String(student.province ?? episode.province ?? '').trim();
    const papers = await getMatchingPapers({ db, subject, grade, region });
    if (papers.length < 2) {
      await episodeRef.set({
        exerciseGenerationPending: true,
        exerciseGenerationPendingTrigger: trigger === 'lesson' ? 'lesson' : 'initial',
        ...(lesson ? { exerciseGenerationPendingLessonId: lesson.id, exerciseGenerationPendingLessonSignature: sourceLessonSignature } : {}),
        updatedAt: new Date(),
      }, { merge: true });
      const message = 'At least two analyzed question papers are required for exercise generation.';
      await requestRef.set({ status: 'skipped', reason: message, updatedAt: new Date() }, { merge: true });
      await statusRef.set({ status: 'failed', message, finishedAtMs: Date.now(), expiresAtMs: Date.now(), updatedAt: new Date() }, { merge: true });
      statusWritten = true;
      return { generated: false, reason: message };
    }

    const topicByKey = new Map(topics.map((item) => [normalizeTopic(item.topic), item]));
    eligibleCompletedLessons.forEach((completedLesson) => {
      const scores = Array.isArray(completedLesson.topicUnderstandingScores) ? completedLesson.topicUnderstandingScores : [];
      const lessonTopics = scores.length ? scores.map((item) => String(item.topic ?? '').trim()).filter(Boolean)
        : [...(completedLesson.topics ?? []), completedLesson.topic].map((item) => String(item ?? '').trim()).filter(Boolean);
      lessonTopics.forEach((topic) => {
        const key = normalizeTopic(topic);
        const previous = topicByKey.get(key);
        if (!previous) topicByKey.set(key, { topic, topicStatus: 'done', attendanceStatus: 'attended', understandingLevel: null, reportSnippet: '' });
        else topicByKey.set(key, { ...previous, topicStatus: 'done', attendanceStatus: 'attended' });
      });
    });
    const topicSummaries = eligibleTopics([...topicByKey.values()].filter((item) => ['done', 'marked'].includes(item.topicStatus)));
    if (!topicSummaries.length) {
      const message = 'No completed or qualifying marked topics are available.';
      await episodeRef.set({
        exerciseGenerationPending: true,
        exerciseGenerationPendingTrigger: trigger === 'lesson' ? 'lesson' : 'initial',
        ...(lesson ? { exerciseGenerationPendingLessonId: lesson.id, exerciseGenerationPendingLessonSignature: sourceLessonSignature } : {}),
        updatedAt: new Date(),
      }, { merge: true });
      await requestRef.set({ status: 'skipped', reason: message, updatedAt: new Date() }, { merge: true });
      await statusRef.set({ status: 'failed', message, finishedAtMs: Date.now(), expiresAtMs: Date.now(), updatedAt: new Date() }, { merge: true });
      statusWritten = true;
      return { generated: false, reason: message };
    }

    const targetDayCount = getExerciseGenerationDayCount(topicSummaries.filter((item) => item.topicStatus === 'done').length);
    const replacesWindow = trigger === 'lesson';
    const assignmentDates = replacesWindow
      ? createExerciseDateWindow(today, targetDayCount)
      : buildAssignmentDates({ history, dayCount: targetDayCount });
    const dateRangeSnapshot = await episodeRef.collection('exercises')
      .where('assignmentDate', '>=', assignmentDates[0])
      .where('assignmentDate', '<=', assignmentDates.at(-1)).get();
    const rangeHistory = dateRangeSnapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    const dailyCaps = {};
    const overrideIdsByDate = {};
    const dateCounts = new Map();
    rangeHistory.forEach((item) => {
      const date = dateOnly(item.assignmentDate);
      if (date) dateCounts.set(date, (dateCounts.get(date) ?? 0) + 1);
    });
    assignmentDates.forEach((date) => {
      const exercises = rangeHistory.filter((item) => dateOnly(item.assignmentDate) === date);
      const submittedCount = exercises.filter(isSubmitted).length;
      dailyCaps[date] = replacesWindow
        ? Math.max(0, 1 - submittedCount)
        : Math.max(0, MAX_DAILY_EXERCISES - (dateCounts.get(date) ?? 0));
      overrideIdsByDate[date] = replacesWindow ? exercises.filter((item) => !isSubmitted(item)).map((item) => item.id) : [];
    });

    const selectedPaperMap = new Map();
    const indexedQuestions = [];
    const topicsWithoutSources = [];
    for (const topic of topicSummaries) {
      let count = 0;
      for (const paper of papers) {
        const questions = (paper.questions ?? []).filter((question) => questionMatchesTopics(question, [topic.topic]));
        if (!questions.length) continue;
        selectedPaperMap.set(paper.id, paper);
        count += questions.length;
        questions.forEach((question) => indexedQuestions.push({
          paperId: question.paperId ?? paper.id,
          questionReference: question.questionReference ?? question.reference,
          subject: question.subject ?? paper.subject,
          topic: question.topic,
          topics: Array.isArray(question.topics) ? question.topics : [],
          pageNumber: question.pageNumber ?? question.page,
          marks: question.marks ?? 0,
        }));
      }
      if (!count) topicsWithoutSources.push(topic.topic);
    }
    const selectedPapers = [...selectedPaperMap.values()];
    if (!indexedQuestions.length || !selectedPapers.length) {
      const message = 'No analyzed question metadata matched the eligible topics. Analyze more past papers to make exercises available.';
      await episodeRef.set({
        exerciseGenerationPending: true,
        exerciseGenerationPendingTrigger: trigger === 'lesson' ? 'lesson' : 'initial',
        ...(lesson ? { exerciseGenerationPendingLessonId: lesson.id, exerciseGenerationPendingLessonSignature: sourceLessonSignature } : {}),
        updatedAt: new Date(),
      }, { merge: true });
      await requestRef.set({ status: 'skipped', reason: message, updatedAt: new Date() }, { merge: true });
      await statusRef.set({ status: 'failed', message, needsMorePaperAnalysis: true, topicsWithoutSources, finishedAtMs: Date.now(), expiresAtMs: Date.now(), updatedAt: new Date() }, { merge: true });
      statusWritten = true;
      return { generated: false, reason: message };
    }

    const topicSummariesForQuestions = topicSummaries;
    const targetQuestions = Math.min(MAX_QUESTIONS_PER_EXERCISE, topicSummaries.length);
    const recentlyUsed = history.flatMap((item) => [
      ...(item.questionLinks ?? []),
      ...(item.questions ?? []),
      ...(item.questionReferences ?? []).map((questionReference, index) => ({ questionReference, paperId: item.paperIds?.[index] || item.paperIds?.[0] })),
    ]);
    const localPlan = buildRuleBasedExercisePlan({
      topicSummaries: topicSummariesForQuestions,
      indexedQuestions,
      assignmentDates,
      dailyExerciseCaps: dailyCaps,
      targetQuestionsPerExercise: targetQuestions,
      recentlyUsedQuestionKeys: recentlyUsed,
      matchesTopic: (question, topic) => questionMatchesTopics(question, [topic]),
    });
    if (!localPlan.recommendations.length) {
      const message = 'No indexed question references are available for the selected generation dates.';
      await episodeRef.set({
        exerciseGenerationPending: true,
        exerciseGenerationPendingTrigger: trigger === 'lesson' ? 'lesson' : 'initial',
        ...(lesson ? { exerciseGenerationPendingLessonId: lesson.id, exerciseGenerationPendingLessonSignature: sourceLessonSignature } : {}),
        updatedAt: new Date(),
      }, { merge: true });
      await requestRef.set({ status: 'skipped', reason: message, updatedAt: new Date() }, { merge: true });
      await statusRef.set({ status: 'failed', message, needsMorePaperAnalysis: true, topicsWithoutSources: localPlan.topicsWithoutSources, finishedAtMs: Date.now(), expiresAtMs: Date.now(), updatedAt: new Date() }, { merge: true });
      statusWritten = true;
      return { generated: false, reason: message };
    }

    const currentWeek = Math.max(1, ...history.map((item) => Number(item.generationWeek) || 1));
    const generationWeek = generationMode === 'initial' ? 1 : trigger === 'lesson' ? currentWeek + 1 : currentWeek;
    const generationBatchId = `${generationMode}-${studentId}-${startedAtMs}`;
    const assignments = buildAssignments({
      recommendations: localPlan.recommendations,
      studentId,
      subject,
      grade,
      subscription,
      selectedPapers,
      topicSummaries,
      mode: generationMode,
      generationWeek,
      generationBatchId,
    }).map((assignment) => ({
      ...assignment,
      subjectInstanceId,
      targetQuestionCount: localPlan.targetQuestionsPerExercise,
      generationWindowDays: assignmentDates.length,
      needsMorePaperAnalysis: Boolean(localPlan.needsMorePaperAnalysis),
      questionShortageCount: localPlan.perDayTopics.find((item) => item.assignmentDate === assignment.assignmentDate)?.shortageCount ?? 0,
      topicsWithoutAnalyzedQuestions: localPlan.topicsWithoutSources,
    }));
    const assignmentsByDate = new Map();
    assignments.forEach((item) => {
      const current = assignmentsByDate.get(item.assignmentDate) ?? [];
      current.push(item);
      assignmentsByDate.set(item.assignmentDate, current);
    });
    const exactCounts = localPlan.perDayTopics.every((day) => {
      const dayAssignments = assignmentsByDate.get(day.assignmentDate) ?? [];
      return dayAssignments.length === day.exerciseCount
        && dayAssignments.every((item) => item.questionCount === day.requiredCount);
    });
    if (!exactCounts) throw new Error('The local exercise planner produced inconsistent question references.');

    const now = new Date();
    const shortageMessage = localPlan.totalQuestionShortage > 0
      ? ` ${localPlan.totalQuestionShortage} question slot(s) could not be filled; analyze more past papers to fill them.`
      : localPlan.topicsWithoutSources.length
        ? ` No analyzed questions were found for: ${localPlan.topicsWithoutSources.join(', ')}.`
        : '';
    const message = `${replacesWindow ? 'Regenerated' : 'Generated'} ${assignments.length} exercises across ${assignmentDates.length} days.${shortageMessage}`;
    const generatedExerciseIds = [];
    const completionFields = {
      studentId, subjectInstanceId, dateKey: today, subject,
      mode: generationMode, lastTrigger: trigger, sourceLessonId: sourceLessonId ?? null,
      sourceLessonSignature: sourceLessonSignature ?? null,
      status: 'completed', message, grade, region,
      paidSubscriptionActive: true,
      subscriptionId: studentId,
      subscriptionPlanId: subscription.planId,
      subscriptionPlanName: subscription.planId === 'circle' ? 'Circle' : 'Personalized',
      subscriptionPaymentReference: subscription.latestReference ?? null,
      needsMorePaperAnalysis: Boolean(localPlan.needsMorePaperAnalysis),
      topicsWithoutSources: localPlan.topicsWithoutSources,
      indexedQuestionCount: localPlan.indexedQuestionCount,
      targetQuestionCount: localPlan.targetQuestionsPerExercise,
      questionShortageCount: localPlan.totalQuestionShortage,
      generationWindowDays: assignmentDates.length,
      generationRunId: requestId,
      finishedAtMs: Date.now(), expiresAtMs: Date.now(), updatedAt: now,
    };
    const episodeCompletionFields = {
      exerciseGenerationPending: false,
      exerciseGenerationPendingTrigger: null,
      exerciseGenerationPendingLessonId: null,
      exerciseGenerationPendingLessonSignature: null,
      exerciseGenerationLastCompletedAt: now,
      exerciseGenerationLastRunId: requestId,
      updatedAt: now,
    };
    if (replacesWindow) {
      const replacementRows = await db.runTransaction(async (transaction) => {
        const safeDays = [];
        for (const assignmentDate of assignmentDates) {
          const oldIds = overrideIdsByDate[assignmentDate] ?? [];
          const replacements = assignmentsByDate.get(assignmentDate) ?? [];
          const cap = dailyCaps[assignmentDate] ?? MAX_DAILY_EXERCISES;
          if (replacements.length !== cap) continue;
          const refs = oldIds.map((id) => episodeRef.collection('exercises').doc(id));
          const snapshots = refs.length ? await Promise.all(refs.map((ref) => transaction.get(ref))) : [];
          const oldExercises = snapshots.filter((item) => item.exists).map((item) => ({ id: item.id, ...item.data() }));
          if (oldExercises.length !== oldIds.length || oldExercises.some(isSubmitted)) continue;
          safeDays.push({ assignmentDate, refs, oldExercises, replacements });
        }
        const rows = [];
        const ids = [];
        const runPayloadByDate = new Map();
        for (const day of safeDays) {
          day.refs.forEach((ref) => transaction.delete(ref));
          for (const assignment of day.replacements) {
            const ref = episodeRef.collection('exercises').doc();
            const payload = {
              ...assignment,
              generationMode: generationMode,
              generationBatchId,
              generationWeek,
              exerciseId: ref.id,
              subjectInstanceId,
              ...accessTimes(assignment.assignmentDate),
              createdAt: now,
            };
            transaction.set(ref, payload);
            rows.push({ id: ref.id, ...assignment });
            ids.push(ref.id);
          }
          runPayloadByDate.set(day.assignmentDate, {
            studentId, subjectInstanceId, subject, dateKey: day.assignmentDate,
            targetCount: MAX_DAILY_EXERCISES, generatedAt: now, mode: generationMode,
            lastTrigger: trigger, sourceLessonId: sourceLessonId ?? null,
            sourceLessonSignature: sourceLessonSignature ?? null,
            generationRequestId: requestId,
            status: 'completed', needsMorePaperAnalysis: Boolean(localPlan.needsMorePaperAnalysis),
            topicsWithoutSources: localPlan.topicsWithoutSources,
            indexedQuestionCount: localPlan.indexedQuestionCount,
            targetQuestionCount: localPlan.targetQuestionsPerExercise,
            questionCount: day.replacements[0]?.questionCount ?? 0,
            questionShortageCount: localPlan.perDayTopics.find((item) => item.assignmentDate === day.assignmentDate)?.shortageCount ?? 0,
            generationWindowDays: assignmentDates.length,
            updatedAt: now,
          });
        }
        if (rows.length) {
          runPayloadByDate.set(today, {
            ...(runPayloadByDate.get(today) ?? {}),
            ...completionFields,
            generatedExerciseIds: ids,
          });
          runPayloadByDate.forEach((payload, dateKey) => transaction.set(
            episodeRef.collection('generationRuns').doc(dateKey), payload, { merge: true },
          ));
          transaction.set(episodeRef, episodeCompletionFields, { merge: true });
          transaction.set(requestRef, { status: 'completed', reason: message, finishedAtMs: Date.now(), updatedAt: now }, { merge: true });
        }
        return { rows, ids };
      });
      if (!replacementRows.rows.length) throw new Error('No unsubmitted exercises could be safely replaced. Existing exercises were kept.');
      generatedExerciseIds.push(...replacementRows.ids);
    } else {
      const batch = db.batch();
      const runPayloadByDate = new Map();
      for (const assignment of assignments) {
        const ref = episodeRef.collection('exercises').doc();
        generatedExerciseIds.push(ref.id);
        batch.set(ref, {
          ...assignment,
          exerciseId: ref.id,
          subjectInstanceId,
          ...accessTimes(assignment.assignmentDate),
          createdAt: now,
        });
        runPayloadByDate.set(assignment.assignmentDate, {
          studentId, subjectInstanceId, subject, dateKey: assignment.assignmentDate,
          targetCount: MAX_DAILY_EXERCISES, generatedAt: now, mode: generationMode,
          lastTrigger: trigger, sourceLessonId: sourceLessonId ?? null,
          sourceLessonSignature: sourceLessonSignature ?? null,
          generationRequestId: requestId, status: 'completed',
          needsMorePaperAnalysis: Boolean(localPlan.needsMorePaperAnalysis),
          topicsWithoutSources: localPlan.topicsWithoutSources,
          indexedQuestionCount: localPlan.indexedQuestionCount,
          targetQuestionCount: localPlan.targetQuestionsPerExercise,
          questionCount: assignment.questionCount,
          questionShortageCount: localPlan.perDayTopics.find((item) => item.assignmentDate === assignment.assignmentDate)?.shortageCount ?? 0,
          generationWindowDays: assignmentDates.length,
          updatedAt: now,
        });
      }
      runPayloadByDate.set(today, {
        ...(runPayloadByDate.get(today) ?? {}),
        ...completionFields,
        generatedExerciseIds,
      });
      runPayloadByDate.forEach((payload, dateKey) => batch.set(
        episodeRef.collection('generationRuns').doc(dateKey), payload, { merge: true },
      ));
      batch.set(episodeRef, episodeCompletionFields, { merge: true });
      batch.set(requestRef, { status: 'completed', reason: message, finishedAtMs: Date.now(), updatedAt: now }, { merge: true });
      await batch.commit();
    }
    statusWritten = true;
    logger.info('Automatic rule-based exercise generation completed', {
      studentId, subjectInstanceId, subject, trigger, mode: generationMode,
      exerciseCount: assignments.length,
      generatedDays: assignmentDates.length,
      questionShortageCount: localPlan.totalQuestionShortage,
    });
    return { generated: true, message, count: assignments.length };
  } catch (error) {
    logger.error('Automatic exercise generation failed', {
      studentId, subjectInstanceId, requestId, reason: requestedReason,
      message: error?.message ?? String(error),
    });
    await Promise.all([
      requestRef.set({ status: 'failed', reason: error?.message ?? 'Exercise generation failed.', updatedAt: new Date() }, { merge: true }).catch(() => {}),
      ...(statusWritten ? [] : [statusRef.set({ status: 'failed', message: error?.message ?? 'Exercise generation failed.', finishedAtMs: Date.now(), expiresAtMs: Date.now(), updatedAt: new Date() }, { merge: true }).catch(() => {})]),
    ]);
    throw error;
  }
};

export const runAutomaticExerciseGeneration = onTaskDispatched(TASK_OPTIONS, async (request) => {
  await runAutomaticGeneration(request.data ?? {});
});
