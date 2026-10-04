import { createHash, randomUUID } from 'node:crypto';
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { admin, getDb } from './admin.js';
import { calculateSubscriptionQuote } from './subscriptionPricing.js';
import { normalizeSupportedSubject } from './subjects.js';

const USERS = 'users';
const MODES = {
  group: 'group',
  'one-on-one': 'oneOnOne',
};
const MODE_ALLOWANCES = {
  circle: { group: 4, oneOnOne: 0 },
  personalized: { group: 2, oneOnOne: 4 },
  free: { group: 0, oneOnOne: 0 },
};
const MAX_GROUP_SIZE = 250;
const MAX_SESSION_MUTATIONS = 100;

const userRef = (db, uid) => db.collection(USERS).doc(uid);
const subjectRef = (db, studentId, subjectInstanceId) => userRef(db, studentId).collection('subjects').doc(subjectInstanceId);
const subscriptionRef = (db, studentId) => userRef(db, studentId).collection('subscriptions').doc('current');
const paymentRef = (db, studentId, reference) => userRef(db, studentId).collection('payments').doc(reference);
const requireUid = (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in before managing lessons.');
  return uid;
};
const normalizeSubject = (value) => {
  const subject = normalizeSupportedSubject(value);
  if (!subject) throw new HttpsError('invalid-argument', 'Choose a supported Maths subject.');
  return subject;
};
const timestampToDate = (value) => value?.toDate?.() ?? (value instanceof Date ? value : typeof value === 'string' ? new Date(value) : null);
const jhbDateKey = (value) => {
  const date = timestampToDate(value) ?? new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: 'Africa/Johannesburg', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
};
const validDateKey = (value) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};
const makeCycleId = (subscription) => subscription.latestReference
  || `renewal-${timestampToDate(subscription.renewalDate)?.getTime?.() ?? 'unknown'}`;
const resolveWindowStart = (subscription, quote, paidAt = null) => {
  const known = timestampToDate(subscription.entitlementWindowStartAt)
    || timestampToDate(subscription.renewedAt)
    || timestampToDate(subscription.activatedAt)
    || timestampToDate(paidAt);
  if (known) return admin.firestore.Timestamp.fromDate(known);
  const renewalDate = timestampToDate(subscription.renewalDate);
  return renewalDate
    ? admin.firestore.Timestamp.fromDate(new Date(renewalDate.getTime() - quote.billingCycleDays * 86400000))
    : null;
};
const usedAllowance = (bucket = {}) => Math.max(0, Number(bucket.granted) + Number(bucket.carriedIn) - Number(bucket.remaining));
const remainingAllowance = (bucket = {}) => {
  const explicit = Number(bucket.remaining);
  if (Number.isFinite(explicit)) return Math.max(0, explicit);
  return Math.max(0, Number(bucket.granted) + Number(bucket.carriedIn) - Number(bucket.used));
};
const makeBucket = ({ granted = 0, carriedIn = 0, used = 0 } = {}) => {
  const cleanGranted = Math.max(0, Number(granted) || 0);
  const cleanCarry = Math.max(0, Number(carriedIn) || 0);
  const cleanUsed = Math.max(0, Number(used) || 0);
  return {
    granted: cleanGranted,
    carriedIn: cleanCarry,
    used: cleanUsed,
    remaining: Math.max(0, cleanGranted + cleanCarry - cleanUsed),
  };
};

export const buildSubjectLessonQuota = ({
  subscription,
  quote = calculateSubscriptionQuote(subscription),
  windowStartAt = resolveWindowStart(subscription, quote),
  renewalDate = subscription.renewalDate,
  previousLedger = null,
  carryForward = false,
  cycleId = makeCycleId(subscription),
  updatedAt = admin.firestore.Timestamp.now(),
} = {}) => {
  const allowances = MODE_ALLOWANCES[quote.planId] ?? MODE_ALLOWANCES.free;
  const bucket = (mode) => makeBucket({
    granted: allowances[mode],
    carriedIn: carryForward ? remainingAllowance(previousLedger?.[mode]) : 0,
  });
  return {
    version: 1,
    cycleId,
    planId: quote.planId,
    windowStartAt,
    renewalDate,
    group: bucket('group'),
    oneOnOne: bucket('oneOnOne'),
    updatedAt,
  };
};

export const getActiveSubjectLessonQuotaUpdates = async ({
  db = getDb(), studentId, subscription, carryForward = false, windowStartAt = null, renewalDate = null,
  cycleId = null, updatedAt = admin.firestore.Timestamp.now(),
} = {}) => {
  const snapshot = await userRef(db, studentId).collection('subjects').where('status', '==', 'active').get();
  if (!snapshot.size) return [];
  const quote = calculateSubscriptionQuote(subscription);
  const nextWindowStart = windowStartAt || resolveWindowStart(subscription, quote);
  const nextRenewal = renewalDate || subscription.renewalDate;
  const nextCycleId = cycleId || makeCycleId(subscription);
  return snapshot.docs.map((episode) => ({
    ref: episode.ref,
    lessonQuota: buildSubjectLessonQuota({
      subscription, quote, windowStartAt: nextWindowStart, renewalDate: nextRenewal,
      previousLedger: episode.data().lessonQuota, carryForward, cycleId: nextCycleId, updatedAt,
    }),
  }));
};

const assertVerifiedActiveSubscription = ({ subscription, payment, studentId, now = new Date() }) => {
  if (!subscription || subscription.status !== 'active' || !['circle', 'personalized'].includes(subscription.planId)) {
    throw new HttpsError('failed-precondition', 'An active paid subscription is required to schedule this lesson.');
  }
  const renewalDate = timestampToDate(subscription.renewalDate);
  if (!renewalDate || renewalDate <= now) {
    throw new HttpsError('failed-precondition', 'This subscription window has ended. Renew the plan before scheduling another lesson.');
  }
  if (!subscription.latestReference) throw new HttpsError('failed-precondition', 'A verified subscription payment is required to schedule lessons.');
  let quote;
  try {
    quote = calculateSubscriptionQuote(subscription);
  } catch {
    throw new HttpsError('failed-precondition', 'The active subscription selection is invalid.');
  }
  if (!payment || payment.status !== 'success' || payment.studentId !== studentId
    || payment.reference !== subscription.latestReference || payment.planId !== quote.planId
    || payment.billingPeriod !== quote.billingPeriod || Number(payment.subjectCount) !== quote.subjectCount
    || Number(payment.amount) !== quote.amount || payment.currency !== quote.currency) {
    throw new HttpsError('failed-precondition', 'A matching successful subscription payment is required to schedule lessons.');
  }
  return { quote, windowStartAt: resolveWindowStart(subscription, quote, payment.paidAt), renewalDate };
};

const assertDateWithinWindow = ({ lessonDate, windowStartAt, renewalDate, now = new Date(), allowPast = false }) => {
  if (!validDateKey(lessonDate)) throw new HttpsError('invalid-argument', 'Choose a valid lesson date.');
  const dateKey = lessonDate;
  if (!allowPast && dateKey < jhbDateKey(now)) throw new HttpsError('failed-precondition', 'A lesson cannot be scheduled in the past.');
  const startKey = jhbDateKey(windowStartAt);
  const renewalKey = jhbDateKey(renewalDate);
  if (!startKey || !renewalKey || dateKey < startKey || dateKey >= renewalKey) {
    throw new HttpsError('failed-precondition', 'The lesson date must fall inside the student’s current paid subscription window.');
  }
};

const assertTutorEpisodeAccess = ({ actorId, actor, student, episode, subject }) => {
  const tutorRole = ['tutor', 'teacher'].includes(actor?.role) || actor?.isTeacher === true || actor?.isTeacher === 'true';
  if (!tutorRole) throw new HttpsError('permission-denied', 'Only a tutor or teacher can schedule a lesson.');
  if (!student || student.role !== 'student' || !episode || episode.status !== 'active'
    || episode.studentId !== student.uid || normalizeSupportedSubject(episode.subjectKey) !== subject) {
    throw new HttpsError('failed-precondition', 'An active subject episode is required for every selected student.');
  }
  const assignedAsCoOwner = episode.primaryTutorId === actorId
    || (actorId in (episode.staffByUid ?? {}) && episode.staffByUid[actorId] === 'co-owner');
  if (!assignedAsCoOwner) throw new HttpsError('permission-denied', 'You need co-owner access to every student in this lesson.');
};

const reconcileQuotaLedger = async ({ transaction, episodeRef, episode, subscriptionContext, now }) => {
  const { subscription, quote, windowStartAt, renewalDate } = subscriptionContext;
  const cycleId = makeCycleId(subscription);
  const existing = episode.lessonQuota;
  if (existing?.version === 1 && existing.cycleId === cycleId) return { lessonQuota: existing, needsWrite: false };

  const lessonSnapshot = await transaction.get(episodeRef.collection('lessons'));
  const startKey = jhbDateKey(windowStartAt);
  const renewalKey = jhbDateKey(renewalDate);
  const used = { group: 0, oneOnOne: 0 };
  lessonSnapshot.docs.forEach((lessonDoc) => {
    const lesson = lessonDoc.data();
    if (!['planned', 'incomplete', 'lesson_log_pending', 'completed', 'missed'].includes(lesson.status)) return;
    const dateKey = String(lesson.lessonDate || lesson.completedOn || '').slice(0, 10);
    if (!dateKey || dateKey < startKey || dateKey >= renewalKey) return;
    if (lesson.quotaCycleId && lesson.quotaCycleId !== cycleId) return;
    const mode = lesson.sessionMode === 'group' ? 'group' : 'oneOnOne';
    used[mode] += 1;
  });
  const lessonQuota = buildSubjectLessonQuota({
    subscription, quote, windowStartAt, renewalDate, cycleId, updatedAt: now,
  });
  lessonQuota.group = makeBucket({ granted: lessonQuota.group.granted, used: used.group });
  lessonQuota.oneOnOne = makeBucket({ granted: lessonQuota.oneOnOne.granted, used: used.oneOnOne });
  return { lessonQuota, needsWrite: true };
};

const reserveQuota = (lessonQuota, sessionMode, now) => {
  const mode = MODES[sessionMode];
  if (!mode) throw new HttpsError('invalid-argument', 'Choose group or one-on-one lesson format.');
  const bucket = lessonQuota[mode];
  if (remainingAllowance(bucket) < 1) {
    const modeLabel = sessionMode === 'group' ? 'group' : 'one-on-one';
    throw new HttpsError('resource-exhausted', `No ${modeLabel} lesson quota remains for this subject in the current subscription window.`);
  }
  const used = usedAllowance(bucket) + 1;
  lessonQuota[mode] = { ...bucket, used, remaining: Math.max(0, remainingAllowance(bucket) - 1) };
  lessonQuota.updatedAt = now;
};

const releaseQuota = (lessonQuota, lesson, now) => {
  const mode = MODES[lesson.sessionMode === 'group' ? 'group' : 'one-on-one'];
  const bucket = lessonQuota[mode];
  if (!bucket) return;
  const lessonDate = String(lesson.lessonDate || lesson.completedOn || '').slice(0, 10);
  const currentCycle = lesson.quotaCycleId
    ? lesson.quotaCycleId === lessonQuota.cycleId
    : Boolean(lessonDate && lessonDate >= jhbDateKey(lessonQuota.windowStartAt) && lessonDate < jhbDateKey(lessonQuota.renewalDate));
  if (currentCycle) {
    lessonQuota[mode] = {
      ...bucket,
      used: Math.max(0, usedAllowance(bucket) - 1),
      remaining: remainingAllowance(bucket) + 1,
    };
  } else {
    lessonQuota[mode] = {
      ...bucket,
      carriedIn: Math.max(0, Number(bucket.carriedIn) || 0) + 1,
      remaining: remainingAllowance(bucket) + 1,
      lateCancelledLessonCredits: (Number(bucket.lateCancelledLessonCredits) || 0) + 1,
    };
  }
  lessonQuota.updatedAt = now;
};

export const releaseCancelledLessonQuota = ({ lessonQuota, lesson, now = admin.firestore.Timestamp.now() }) => {
  if (!lessonQuota || lessonQuota.version !== 1) return null;
  const updated = { ...lessonQuota, group: { ...lessonQuota.group }, oneOnOne: { ...lessonQuota.oneOnOne } };
  releaseQuota(updated, lesson, now);
  return updated;
};

const documentIdForOperation = (operationId, studentId) => createHash('sha256')
  .update(`${operationId}:${studentId}`)
  .digest('hex')
  .slice(0, 40);

const cleanLessonInput = ({ requestData, actorId, subject, students, sessionMode, operationId, sessionStatus }) => {
  const lessonDate = String(requestData.lessonDate ?? '').trim();
  if (!validDateKey(lessonDate)) throw new HttpsError('invalid-argument', 'Choose a valid lesson date.');
  const topics = [...new Set((Array.isArray(requestData.topics) ? requestData.topics : [])
    .map((topic) => String(topic ?? '').trim()).filter(Boolean))];
  if (!topics.length || topics.length > 50) throw new HttpsError('invalid-argument', 'Choose between 1 and 50 lesson topics.');
  if (!['online', 'inPerson'].includes(requestData.lessonType || 'online')) throw new HttpsError('invalid-argument', 'Choose online or in-person for this lesson.');
  if (!['group', 'one-on-one'].includes(sessionMode)) throw new HttpsError('invalid-argument', 'Choose group or one-on-one lesson format.');
  if (sessionMode === 'group' && (students.length < 2 || students.length > MAX_GROUP_SIZE)) {
    throw new HttpsError('invalid-argument', `A group lesson must include 2 to ${MAX_GROUP_SIZE} students.`);
  }
  if (sessionMode === 'one-on-one' && students.length !== 1) throw new HttpsError('invalid-argument', 'A one-on-one lesson needs exactly one student.');
  if (typeof operationId !== 'string' || operationId.length < 8 || operationId.length > 160) {
    throw new HttpsError('invalid-argument', 'A lesson request ID is required. Refresh the page and try again.');
  }
  const groupSessionId = sessionMode === 'group' ? String(requestData.groupSessionId ?? '').trim() : '';
  if (sessionMode === 'group' && !groupSessionId) throw new HttpsError('invalid-argument', 'A group lesson needs a session reference.');
  return {
    subject, topics, lessonDate, sessionMode, operationId, sessionStatus,
    groupSessionId,
    lessonType: requestData.lessonType || 'online',
    whatsappLessonLink: String(requestData.whatsappLessonLink ?? '').trim().slice(0, 2000),
    locationDetails: String(requestData.locationDetails ?? '').trim().slice(0, 2000),
    tutorId: actorId,
  };
};

const scheduleLessons = async ({ request, sessionStatus }) => {
  const actorId = requireUid(request);
  const data = request.data ?? {};
  const subject = normalizeSubject(data.subject);
  const sessionMode = sessionStatus === 'lesson_log_pending' ? 'one-on-one' : String(data.sessionMode ?? '');
  const rawStudents = Array.isArray(data.students) ? data.students : [];
  const students = [...new Map(rawStudents.map((row) => [String(row?.studentId ?? ''), row])).values()]
    .filter((row) => String(row?.studentId ?? '').trim());
  if (!students.length || students.length !== rawStudents.length) throw new HttpsError('invalid-argument', 'Choose a valid student list without duplicates.');
  const operationId = String(data.operationId ?? data.groupSessionId ?? '').trim();
  const input = cleanLessonInput({
    requestData: data, actorId, subject, students, sessionMode, operationId, sessionStatus,
  });
  const groupSessionId = sessionStatus === 'planned' ? input.groupSessionId : '';
  const db = getDb();
  const now = admin.firestore.Timestamp.now();
  const todayKey = jhbDateKey(now);
  if (sessionStatus === 'planned' && input.lessonDate < todayKey) throw new HttpsError('failed-precondition', 'A lesson cannot be scheduled in the past.');
  const actorRef = userRef(db, actorId);
  const contexts = students.map((student) => {
    const studentId = String(student.studentId).trim();
    const subjectInstanceId = String(student.subjectInstanceId ?? '').trim();
    if (!subjectInstanceId) throw new HttpsError('invalid-argument', 'Reload assigned students and choose again.');
    return {
      studentId,
      subjectInstanceId,
      studentRef: userRef(db, studentId),
      episodeRef: subjectRef(db, studentId, subjectInstanceId),
      subscriptionRef: subscriptionRef(db, studentId),
      lessonRef: subjectRef(db, studentId, subjectInstanceId).collection('lessons').doc(documentIdForOperation(operationId, studentId)),
    };
  });
  if (sessionMode === 'group' && new Set(students.map((student) => String(student.grade ?? ''))).size !== 1) {
    throw new HttpsError('failed-precondition', 'All students in a group lesson must be in the same grade.');
  }

  const rows = await db.runTransaction(async (transaction) => {
    const initialRefs = [actorRef, ...contexts.flatMap((context) => [context.studentRef, context.episodeRef, context.subscriptionRef, context.lessonRef])];
    const initialSnapshots = await Promise.all(initialRefs.map((ref) => transaction.get(ref)));
    const snapshotByPath = new Map(initialRefs.map((ref, index) => [ref.path, initialSnapshots[index]]));
    const actorSnapshot = snapshotByPath.get(actorRef.path);
    const actor = actorSnapshot.exists ? actorSnapshot.data() : null;
    const idempotentRows = [];
    const payments = new Map();
    const subs = new Map();
    const episodeData = new Map();
    const studentData = new Map();
    for (const context of contexts) {
      const studentSnapshot = snapshotByPath.get(context.studentRef.path);
      const episodeSnapshot = snapshotByPath.get(context.episodeRef.path);
      const subscriptionSnapshot = snapshotByPath.get(context.subscriptionRef.path);
      const existingLesson = snapshotByPath.get(context.lessonRef.path);
      if (!studentSnapshot.exists || !episodeSnapshot.exists || !subscriptionSnapshot.exists) {
        throw new HttpsError('failed-precondition', 'The student’s active subject or subscription could not be found.');
      }
      const student = { uid: context.studentId, ...studentSnapshot.data() };
      const episode = episodeSnapshot.data();
      assertTutorEpisodeAccess({ actorId, actor, student, episode, subject });
      if (normalizeSupportedSubject(episode.subjectKey) !== subject) throw new HttpsError('failed-precondition', 'The selected active subject does not match the lesson.');
      if (sessionStatus === 'planned' && String(episode.grade ?? '') !== String(students.find((row) => row.studentId === context.studentId)?.grade ?? '')) {
        throw new HttpsError('failed-precondition', 'A student’s grade changed. Reload the lesson form and try again.');
      }
      studentData.set(context.studentId, student);
      episodeData.set(context.studentId, { ref: context.episodeRef, snapshot: episodeSnapshot, data: episode });
      const subscription = subscriptionSnapshot.data();
      subs.set(context.studentId, subscription);
      if (subscription.latestReference) payments.set(context.studentId, paymentRef(db, context.studentId, subscription.latestReference));
      if (existingLesson.exists) {
        const existing = existingLesson.data();
        const statusMatches = sessionStatus === 'lesson_log_pending'
          ? ['lesson_log_pending', 'completed', 'missed'].includes(existing.status)
          : existing.status === sessionStatus;
        if (existing.scheduleOperationId !== operationId || existing.tutorId !== actorId
          || existing.subject !== input.subject || existing.lessonDate !== input.lessonDate
          || existing.sessionMode !== input.sessionMode || existing.groupSessionId !== input.groupSessionId
          || !statusMatches
          || JSON.stringify(existing.topics ?? []) !== JSON.stringify(input.topics)) {
          throw new HttpsError('already-exists', 'This lesson request ID has already been used. Refresh the page and try again.');
        }
        idempotentRows.push({
          id: existingLesson.id, ...existing, documentPath: context.lessonRef.path,
          subjectInstanceId: context.subjectInstanceId,
        });
      }
    }
    if (idempotentRows.length) {
      if (idempotentRows.length !== contexts.length) throw new HttpsError('aborted', 'The lesson request is partially recorded. Retry once the previous save finishes.');
      return idempotentRows;
    }

    const paymentRefs = [...payments.values()];
    const paymentSnapshots = paymentRefs.length ? await Promise.all(paymentRefs.map((ref) => transaction.get(ref))) : [];
    const paymentByPath = new Map(paymentRefs.map((ref, index) => [ref.path, paymentSnapshots[index]]));
    const quotaByStudent = new Map();
    const subscriptionContextByStudent = new Map();
    for (const context of contexts) {
      const subscription = subs.get(context.studentId);
      const reference = subscription.latestReference;
      const paymentSnapshot = reference ? paymentByPath.get(paymentRef(db, context.studentId, reference).path) : null;
      const payment = paymentSnapshot?.exists ? paymentSnapshot.data() : null;
      const verified = assertVerifiedActiveSubscription({ subscription, payment, studentId: context.studentId, now: now.toDate() });
      if (!verified.quote.allowedSessionModes.includes(sessionMode)) {
        throw new HttpsError('failed-precondition', `${verified.quote.planName} does not allow ${sessionMode === 'group' ? 'group' : 'one-on-one'} lessons.`);
      }
      assertDateWithinWindow({
        lessonDate: input.lessonDate, windowStartAt: verified.windowStartAt,
        renewalDate: verified.renewalDate, now: now.toDate(), allowPast: sessionStatus === 'lesson_log_pending',
      });
      const reconciled = await reconcileQuotaLedger({
        transaction,
        episodeRef: episodeData.get(context.studentId).ref,
        episode: episodeData.get(context.studentId).data,
        subscriptionContext: verified,
        now,
      });
      reserveQuota(reconciled.lessonQuota, sessionMode, now);
      quotaByStudent.set(context.studentId, reconciled.lessonQuota);
      subscriptionContextByStudent.set(context.studentId, verified);
    }

    if (sessionMode === 'group' && new Set(contexts.map((context) => episodeData.get(context.studentId).data.grade || '')).size !== 1) {
      throw new HttpsError('failed-precondition', 'All students in a group lesson must be in the same grade.');
    }
    const transactionRows = [];
    contexts.forEach((context, index) => {
      const episode = episodeData.get(context.studentId).data;
      const verified = subscriptionContextByStudent.get(context.studentId);
      const lesson = {
        studentId: context.studentId,
        tutorId: actorId,
        subject,
        subjectInstanceId: context.subjectInstanceId,
        grade: episode.grade || '',
        topic: input.topics[0],
        topics: input.topics,
        topicReport: '',
        studentName: studentData.get(context.studentId).displayName || studentData.get(context.studentId).name || studentData.get(context.studentId).email || 'Student',
        lessonDate: input.lessonDate,
        lessonType: input.lessonType,
        whatsappLessonLink: input.whatsappLessonLink,
        locationDetails: input.locationDetails,
        sessionMode,
        groupSessionId,
        groupStudentCount: sessionMode === 'group' ? contexts.length : 1,
        attendanceStatus: 'pending',
        attended: null,
        status: sessionStatus,
        completedOn: '',
        scheduleOperationId: operationId,
        quotaCycleId: makeCycleId(subs.get(context.studentId)),
        assignmentPeriodId: context.subjectInstanceId,
        createdAt: now,
        updatedAt: now,
      };
      transaction.set(context.lessonRef, lesson);
      transaction.update(context.episodeRef, { lessonQuota: quotaByStudent.get(context.studentId), updatedAt: now });
      transactionRows[index] = { id: context.lessonRef.id, ...lesson, documentPath: context.lessonRef.path };
      if (verified.quote.subjectCount < 1) throw new HttpsError('failed-precondition', 'This subscription does not include registered subjects.');
    });
    return transactionRows;
  });
  return rows;
};

export const createPlannedLessonSession = onCall({ cpu: 'gcf_gen1' }, async (request) => {
  return { lessons: await scheduleLessons({ request, sessionStatus: 'planned' }) };
});

export const reserveCompletedLessonLog = onCall({ cpu: 'gcf_gen1' }, async (request) => {
  return { lesson: (await scheduleLessons({ request, sessionStatus: 'lesson_log_pending' }))[0] };
});

const assertActorCanTeach = ({ actorId, actor, episode, lesson }) => {
  const tutorRole = ['tutor', 'teacher'].includes(actor?.role) || actor?.isTeacher === true || actor?.isTeacher === 'true';
  if (!tutorRole || !episode || episode.status !== 'active'
    || episode.studentId !== lesson.studentId || episode.subjectKey !== lesson.subject) {
    throw new HttpsError('failed-precondition', 'An active tutor assignment is required for this lesson.');
  }
  if (episode.primaryTutorId !== actorId && episode.staffByUid?.[actorId] !== 'co-owner') {
    throw new HttpsError('permission-denied', 'You need co-owner access to every student in this lesson.');
  }
};

const updateCancelledLessonQuota = ({ episodeRef, episodeSnapshot, lesson, now, quotaByEpisode }) => {
  const episode = episodeSnapshot.data();
  const ledger = quotaByEpisode.get(episodeRef.path) ?? episode.lessonQuota;
  if (!ledger || ledger.version !== 1) return;
  const next = { ...ledger, group: { ...ledger.group }, oneOnOne: { ...ledger.oneOnOne } };
  releaseQuota(next, lesson, now);
  quotaByEpisode.set(episodeRef.path, next);
};

const cancelRequestedLessonRows = async ({ request }) => {
  const actorId = requireUid(request);
  const data = request.data ?? {};
  const rawRows = Array.isArray(data.lessonRows) ? data.lessonRows : [];
  if (!rawRows.length || rawRows.length > MAX_GROUP_SIZE) throw new HttpsError('invalid-argument', 'Choose a lesson session to cancel.');
  const uniqueRows = [...new Map(rawRows.map((row) => [`${row?.studentId}:${row?.subjectInstanceId}:${row?.id}`, row])).values()];
  if (uniqueRows.length !== rawRows.length) throw new HttpsError('invalid-argument', 'The lesson selection contains duplicates.');
  const db = getDb();
  const actorRef = userRef(db, actorId);
  const contexts = uniqueRows.map((row) => {
    const studentId = String(row?.studentId ?? '').trim();
    const subjectInstanceId = String(row?.subjectInstanceId ?? '').trim();
    const lessonId = String(row?.id ?? '').trim();
    if (!studentId || !subjectInstanceId || !lessonId) throw new HttpsError('invalid-argument', 'Reload the lesson list and choose again.');
    const episodeRef = subjectRef(db, studentId, subjectInstanceId);
    return { studentId, subjectInstanceId, episodeRef, lessonRef: episodeRef.collection('lessons').doc(lessonId) };
  });
  const now = admin.firestore.Timestamp.now();
  return db.runTransaction(async (transaction) => {
    const initialRefs = [actorRef, ...contexts.flatMap((context) => [context.episodeRef, context.lessonRef])];
    const initialSnapshots = await Promise.all(initialRefs.map((ref) => transaction.get(ref)));
    const snapshotByPath = new Map(initialRefs.map((ref, index) => [ref.path, initialSnapshots[index]]));
    const actorSnapshot = snapshotByPath.get(actorRef.path);
    const actor = actorSnapshot.exists ? actorSnapshot.data() : null;
    const selected = contexts.map((context) => {
      const lessonSnapshot = snapshotByPath.get(context.lessonRef.path);
      const episodeSnapshot = snapshotByPath.get(context.episodeRef.path);
      if (!lessonSnapshot.exists || !episodeSnapshot.exists) throw new HttpsError('not-found', 'A selected lesson no longer exists.');
      const lesson = { id: lessonSnapshot.id, ...lessonSnapshot.data(), studentId: context.studentId, subjectInstanceId: context.subjectInstanceId };
      if (lesson.status === 'cancelled') return { ...context, lesson, lessonSnapshot, episodeSnapshot, alreadyCancelled: true };
      if (!['planned', 'incomplete'].includes(lesson.status)) throw new HttpsError('failed-precondition', 'Only planned lessons can be cancelled.');
      assertActorCanTeach({ actorId, actor, episode: episodeSnapshot.data(), lesson });
      return { ...context, lesson, lessonSnapshot, episodeSnapshot, alreadyCancelled: false };
    });
    const groupIds = [...new Set(selected.map((row) => row.lesson.groupSessionId).filter(Boolean))];
    const groupSnapshots = await Promise.all(groupIds.map((groupSessionId) => transaction.get(
      db.collectionGroup('lessons').where('groupSessionId', '==', groupSessionId).where('status', 'in', ['planned', 'incomplete']),
    )));
    const groupRows = new Map(groupSnapshots.flatMap((snapshot) => snapshot.docs).map((lesson) => [lesson.ref.path, lesson]));
    const rowsToCancel = new Map(selected.filter((row) => !row.alreadyCancelled).map((row) => [row.lessonRef.path, row]));
    const remainingRowsToUpdate = new Map();
    groupIds.forEach((groupId) => {
      const rows = [...groupRows.values()].filter((row) => row.data().groupSessionId === groupId);
      const selectedPaths = new Set(selected.filter((row) => row.lesson.groupSessionId === groupId).map((row) => row.lessonRef.path));
      const stillScheduled = rows.filter((row) => !selectedPaths.has(row.ref.path));
      if (stillScheduled.length < 2) {
        rows.forEach((row) => {
          const context = selected.find((candidate) => candidate.lessonRef.path === row.ref.path);
          if (context) rowsToCancel.set(row.ref.path, context);
          else rowsToCancel.set(row.ref.path, { lessonRef: row.ref, lesson: { id: row.id, ...row.data() }, episodeRef: subjectRef(db, row.data().studentId, row.data().subjectInstanceId), episodeSnapshot: null });
        });
      } else {
        stillScheduled.forEach((row) => remainingRowsToUpdate.set(row.ref.path, row));
      }
    });

    const additionalEpisodeRefs = [...new Map([...rowsToCancel.values()].map((row) => [row.episodeRef.path, row.episodeRef])).values()];
    const missingEpisodeRefs = additionalEpisodeRefs.filter((ref) => !snapshotByPath.has(ref.path));
    const missingEpisodeSnapshots = missingEpisodeRefs.length ? await Promise.all(missingEpisodeRefs.map((ref) => transaction.get(ref))) : [];
    missingEpisodeRefs.forEach((ref, index) => snapshotByPath.set(ref.path, missingEpisodeSnapshots[index]));
    const quotaByEpisode = new Map();
    for (const row of rowsToCancel.values()) {
      if (!['planned', 'incomplete'].includes(row.lesson.status)) continue;
      const episodeSnapshot = row.episodeSnapshot ?? snapshotByPath.get(row.episodeRef.path);
      if (!episodeSnapshot?.exists) throw new HttpsError('failed-precondition', 'A student’s active subject episode no longer exists.');
      assertActorCanTeach({ actorId, actor, episode: episodeSnapshot.data(), lesson: row.lesson });
      updateCancelledLessonQuota({ episodeRef: row.episodeRef, episodeSnapshot, lesson: row.lesson, now, quotaByEpisode });
    }
    if (rowsToCancel.size + remainingRowsToUpdate.size + quotaByEpisode.size > 500) {
      throw new HttpsError('resource-exhausted', 'This group is too large to cancel in one operation.');
    }
    rowsToCancel.forEach((row) => transaction.update(row.lessonRef, {
      status: 'cancelled', attendanceStatus: 'cancelled', attended: false,
      cancelledAt: now, cancellationReason: 'tutor_cancelled', updatedAt: now,
    }));
    remainingRowsToUpdate.forEach((row) => transaction.update(row.ref, {
      groupStudentCount: [...groupRows.values()].filter((item) => item.data().groupSessionId === row.data().groupSessionId)
        .length - [...rowsToCancel.values()].filter((item) => item.lesson.groupSessionId === row.data().groupSessionId).length,
      updatedAt: now,
    }));
    quotaByEpisode.forEach((lessonQuota, path) => transaction.update(db.doc(path), { lessonQuota, updatedAt: now }));
    return { cancelled: true, count: rowsToCancel.size };
  });
};

const updatePlannedGroupRoster = async ({ request }) => {
  const actorId = requireUid(request);
  const data = request.data ?? {};
  const groupSessionId = String(data.groupSessionId ?? '').trim();
  const removeLessonIds = [...new Set((Array.isArray(data.removeLessonIds) ? data.removeLessonIds : []).map(String))];
  const addStudents = [...new Map((Array.isArray(data.addStudents) ? data.addStudents : [])
    .filter((student) => student?.studentId && student?.subjectInstanceId)
    .map((student) => [String(student.studentId), student])).values()];
  if (!groupSessionId || (removeLessonIds.length + addStudents.length) === 0) throw new HttpsError('invalid-argument', 'Choose students to add or remove from this group.');
  if (removeLessonIds.length + addStudents.length > MAX_SESSION_MUTATIONS) throw new HttpsError('resource-exhausted', `Change at most ${MAX_SESSION_MUTATIONS} students per roster update.`);
  const db = getDb();
  const actorRef = userRef(db, actorId);
  const newContexts = addStudents.map((student) => {
    const studentId = String(student.studentId);
    const subjectInstanceId = String(student.subjectInstanceId);
    const episodeRef = subjectRef(db, studentId, subjectInstanceId);
    return { studentId, subjectInstanceId, studentRef: userRef(db, studentId), episodeRef, subscriptionRef: subscriptionRef(db, studentId), lessonRef: episodeRef.collection('lessons').doc() };
  });
  const now = admin.firestore.Timestamp.now();
  return db.runTransaction(async (transaction) => {
    const actorSnapshot = await transaction.get(actorRef);
    const groupSnapshot = await transaction.get(db.collectionGroup('lessons').where('groupSessionId', '==', groupSessionId).where('status', '==', 'planned'));
    const currentRows = groupSnapshot.docs;
    if (!currentRows.length) throw new HttpsError('not-found', 'This planned group lesson no longer exists.');
    const first = currentRows[0].data();
    if (first.sessionMode !== 'group' || first.groupSessionId !== groupSessionId) throw new HttpsError('failed-precondition', 'This is not an editable group session.');
    const subject = normalizeSubject(first.subject);
    const grade = String(first.grade ?? '');
    if (currentRows.some((item) => item.data().tutorId !== actorId || item.data().subject !== subject || String(item.data().grade ?? '') !== grade)) {
      throw new HttpsError('permission-denied', 'You cannot change every student in this group lesson.');
    }
    const currentById = new Map(currentRows.map((item) => [item.id, item]));
    if (removeLessonIds.some((id) => !currentById.has(id))) throw new HttpsError('failed-precondition', 'A selected student is no longer in this group. Reload and try again.');
    const removedRows = removeLessonIds.map((id) => currentById.get(id));
    const currentStudentIds = new Set(currentRows.filter((row) => !removeLessonIds.includes(row.id)).map((row) => row.data().studentId));
    if (addStudents.some((student) => currentStudentIds.has(String(student.studentId)))) throw new HttpsError('already-exists', 'A selected student is already in this group.');
    const nextCount = currentStudentIds.size + newContexts.length;
    if (nextCount < 2 || nextCount > MAX_GROUP_SIZE) throw new HttpsError('failed-precondition', `The group must contain 2 to ${MAX_GROUP_SIZE} students.`);

    const episodeRefs = [...new Map([
      ...currentRows.map((row) => {
        const item = row.data();
        return [item.subjectInstanceId, subjectRef(db, item.studentId, item.subjectInstanceId)];
      }),
      ...newContexts.map((context) => [context.episodeRef.id, context.episodeRef]),
    ]).values()];
    const newStudentRefs = newContexts.flatMap((context) => [context.studentRef, context.subscriptionRef, context.lessonRef]);
    const readRefs = [...new Map([...episodeRefs, ...newStudentRefs].map((ref) => [ref.path, ref])).values()];
    const readSnapshots = readRefs.length ? await Promise.all(readRefs.map((ref) => transaction.get(ref))) : [];
    const snapshotByPath = new Map(readRefs.map((ref, index) => [ref.path, readSnapshots[index]]));
    const episodeSnapshotByPath = new Map(episodeRefs.map((ref) => [ref.path, snapshotByPath.get(ref.path)]));
    const actor = actorSnapshot.exists ? actorSnapshot.data() : null;
    const unchangedRows = currentRows.filter((row) => !removeLessonIds.includes(row.id));
    for (const row of currentRows) {
      const lesson = { id: row.id, ...row.data() };
      const episodeRef = subjectRef(db, lesson.studentId, lesson.subjectInstanceId);
      const episodeSnapshot = episodeSnapshotByPath.get(episodeRef.path);
      if (!episodeSnapshot?.exists) throw new HttpsError('failed-precondition', 'A student’s active subject episode no longer exists.');
      assertActorCanTeach({ actorId, actor, episode: episodeSnapshot.data(), lesson });
    }

    const paymentRefs = [];
    const subscriptionByStudent = new Map();
    for (const context of newContexts) {
      const studentSnapshot = snapshotByPath.get(context.studentRef.path);
      const episodeSnapshot = snapshotByPath.get(context.episodeRef.path);
      const subscriptionSnapshot = snapshotByPath.get(context.subscriptionRef.path);
      if (!studentSnapshot?.exists || !episodeSnapshot?.exists || !subscriptionSnapshot?.exists) throw new HttpsError('failed-precondition', 'A selected student does not have an active subject and subscription.');
      const student = { uid: context.studentId, ...studentSnapshot.data() };
      const episode = episodeSnapshot.data();
      assertTutorEpisodeAccess({ actorId, actor, student, episode, subject });
      if (episode.subjectKey !== subject || String(episode.grade ?? '') !== grade) throw new HttpsError('failed-precondition', 'Added students must match the group’s active subject and grade.');
      const subscription = subscriptionSnapshot.data();
      subscriptionByStudent.set(context.studentId, subscription);
      if (subscription.latestReference) paymentRefs.push(paymentRef(db, context.studentId, subscription.latestReference));
    }
    const paymentSnapshots = paymentRefs.length ? await Promise.all(paymentRefs.map((ref) => transaction.get(ref))) : [];
    const paymentByPath = new Map(paymentRefs.map((ref, index) => [ref.path, paymentSnapshots[index]]));
    const quotaByStudent = new Map();
    for (const context of newContexts) {
      const subscription = subscriptionByStudent.get(context.studentId);
      const paymentSnapshot = subscription.latestReference
        ? paymentByPath.get(paymentRef(db, context.studentId, subscription.latestReference).path) : null;
      const payment = paymentSnapshot?.exists ? paymentSnapshot.data() : null;
      const verified = assertVerifiedActiveSubscription({ subscription, payment, studentId: context.studentId, now: now.toDate() });
      if (!verified.quote.allowedSessionModes.includes('group')) throw new HttpsError('failed-precondition', `${verified.quote.planName} does not allow group lessons.`);
      assertDateWithinWindow({ lessonDate: first.lessonDate, windowStartAt: verified.windowStartAt, renewalDate: verified.renewalDate, now: now.toDate() });
      const reconciled = await reconcileQuotaLedger({
        transaction, episodeRef: context.episodeRef, episode: snapshotByPath.get(context.episodeRef.path).data(),
        subscriptionContext: verified, now,
      });
      reserveQuota(reconciled.lessonQuota, 'group', now);
      quotaByStudent.set(context.studentId, reconciled.lessonQuota);
    }

    const writeCount = unchangedRows.length + removedRows.length + newContexts.length + quotaByStudent.size;
    if (writeCount > 500) throw new HttpsError('resource-exhausted', 'This roster update is too large to save atomically. Add or remove fewer students.');
    removedRows.forEach((row) => {
      const lesson = row.data();
      const ref = subjectRef(db, lesson.studentId, lesson.subjectInstanceId);
      const episodeSnapshot = episodeSnapshotByPath.get(ref.path);
      const quota = quotaByStudent.get(lesson.studentId) ?? episodeSnapshot.data().lessonQuota;
      if (quota && quota.version === 1) {
        const next = { ...quota, group: { ...quota.group }, oneOnOne: { ...quota.oneOnOne } };
        releaseQuota(next, lesson, now);
        quotaByStudent.set(lesson.studentId, next);
      }
      transaction.update(row.ref, { status: 'cancelled', attendanceStatus: 'cancelled', attended: false, cancelledAt: now, cancellationReason: 'removed_from_group', updatedAt: now });
    });
    unchangedRows.forEach((row) => transaction.update(row.ref, { groupStudentCount: nextCount, updatedAt: now }));
    newContexts.forEach((context) => {
      const episode = snapshotByPath.get(context.episodeRef.path).data();
      const lesson = {
        studentId: context.studentId, tutorId: actorId, subject, subjectInstanceId: context.subjectInstanceId,
        grade, topic: first.topic || first.topics?.[0] || '', topics: first.topics ?? [], topicReport: '',
        studentName: episode.studentName || 'Student', lessonDate: first.lessonDate,
        lessonType: first.lessonType || 'online', whatsappLessonLink: first.whatsappLessonLink || '', locationDetails: first.locationDetails || '',
        sessionMode: 'group', groupSessionId, groupStudentCount: nextCount, attendanceStatus: 'pending', attended: null,
        status: 'planned', completedOn: '', scheduleOperationId: randomUUID(), quotaCycleId: makeCycleId(subscriptionByStudent.get(context.studentId)),
        assignmentPeriodId: context.subjectInstanceId, createdAt: now, updatedAt: now,
      };
      transaction.create(context.lessonRef, lesson);
      context.lesson = { id: context.lessonRef.id, ...lesson, documentPath: context.lessonRef.path };
    });
    const episodeRefByStudent = new Map();
    newContexts.forEach((context) => episodeRefByStudent.set(context.studentId, context.episodeRef));
    removedRows.forEach((row) => {
      const lesson = row.data();
      episodeRefByStudent.set(lesson.studentId, subjectRef(db, lesson.studentId, lesson.subjectInstanceId));
    });
    quotaByStudent.forEach((lessonQuota, studentId) => {
      const episodeRef = episodeRefByStudent.get(studentId);
      if (episodeRef) transaction.update(episodeRef, { lessonQuota, updatedAt: now });
    });
    return {
      groupSessionId,
      lessons: [...unchangedRows.map((row) => ({ id: row.id, ...row.data(), groupStudentCount: nextCount })), ...newContexts.map((context) => context.lesson)],
      cancelledCount: removedRows.length,
    };
  });
};

export const mutatePlannedLessonSession = onCall({ cpu: 'gcf_gen1' }, async (request) => {
  const action = String(request.data?.action ?? '');
  if (action === 'cancel') return cancelRequestedLessonRows({ request });
  if (action === 'update-roster') return updatePlannedGroupRoster({ request });
  throw new HttpsError('invalid-argument', 'Choose a valid planned lesson change.');
});
