import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions';
import { admin, getDb } from './admin.js';
import { calculateSubscriptionQuote } from './subscriptionPricing.js';
import { normalizeSupportedSubject } from './subjects.js';
import { buildSubjectLessonQuota, releaseCancelledLessonQuota } from './lessonEntitlements.js';
import { isSavedSubscriptionPaymentConsistent } from './paystackPricingCore.js';

const ACCESS_ROLES = ['co-owner', 'marker', 'viewer'];
const requireUid = (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in before changing subject access.');
  return uid;
};
const normalizeSubject = (value) => {
  const subject = normalizeSupportedSubject(value);
  if (!subject) throw new HttpsError('invalid-argument', 'Choose a supported CAPS subject.');
  return subject;
};
const isTutor = (profile = {}) => ['tutor', 'teacher'].includes(profile.role)
  || profile.isTeacher === true || profile.isTeacher === 'true';
const approvedSubjects = (profile = {}) => [...new Set([
  ...(Array.isArray(profile.subjects) ? profile.subjects : []),
  ...(profile.subject ? [profile.subject] : []),
  ...(Array.isArray(profile.tutorSubjectMarks)
    ? profile.tutorSubjectMarks.filter((item) => Number(item.mark) >= 60).map((item) => item.subject)
    : []),
  ].filter(Boolean).map(normalizeSupportedSubject).filter(Boolean))];
const ensureTutorForSubject = (profile, subject) => {
  if (!profile || !isTutor(profile) || !approvedSubjects(profile).includes(subject)) {
    throw new HttpsError('failed-precondition', `Choose a tutor or teacher approved for ${subject}.`);
  }
};
const studentSubscriptionRef = (db, studentId) => db.collection('users').doc(studentId).collection('subscriptions').doc('current');
const studentPaymentRef = (db, studentId, reference) => db.collection('users').doc(studentId).collection('payments').doc(reference);
const subjectCollection = (db, studentId) => db.collection('users').doc(studentId).collection('subjects');
const dateThreeMonthsBefore = (date) => {
  const original = new Date(date);
  const result = new Date(date);
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() - 3);
  const daysInTargetMonth = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(original.getUTCDate(), daysInTargetMonth));
  return result;
};
const membership = ({ uid, role, grantedAt, endedAt = null, grantedBy, endedBy = null }) => ({
  uid, role, grantedAt, endedAt, grantedBy, endedBy,
});

const authorizeStudentChange = async ({ db, uid, studentId, student }) => {
  const actorSnapshot = await db.collection('users').doc(uid).get();
  const actor = actorSnapshot.exists ? actorSnapshot.data() : null;
  if ((uid === studentId && actor?.role === 'student')
    || (actor?.role === 'parent' && student.parentId === uid)
    || actor?.role === 'admin') return actor;
  throw new HttpsError('permission-denied', 'Only the student, linked parent, or an admin can change subjects.');
};

const assertPaidSubjectCapacity = async ({ db, studentId, existingCount, additions, transaction = null }) => {
  const subscriptionRef = studentSubscriptionRef(db, studentId);
  const subscriptionSnapshot = transaction ? await transaction.get(subscriptionRef) : await subscriptionRef.get();
  const subscription = subscriptionSnapshot.exists ? subscriptionSnapshot.data() : null;
  const renewalDate = subscription?.renewalDate?.toDate?.();
  const graceEndsAt = subscription?.graceEndsAt?.toDate?.();
  const now = new Date();
  const paid = subscription?.status === 'active' && renewalDate > now;
  const grace = subscription?.status === 'past_due' && renewalDate <= now && graceEndsAt > now;
  if (!['circle', 'personalized'].includes(subscription?.planId) || (!paid && !grace)) {
    throw new HttpsError('failed-precondition', 'An active paid subscription is required to manage subjects.');
  }
  const quote = calculateSubscriptionQuote(subscription);
  const paymentRef = subscription.latestReference ? studentPaymentRef(db, studentId, subscription.latestReference) : null;
  const paymentSnapshot = paymentRef
    ? (transaction ? await transaction.get(paymentRef) : await paymentRef.get())
    : null;
  const payment = paymentSnapshot?.exists ? paymentSnapshot.data() : null;
  if (!payment || payment.status !== 'success' || payment.studentId !== studentId
    || payment.reference !== subscription.latestReference
    || !isSavedSubscriptionPaymentConsistent({ quote, subscription, payment })
    || payment.currency !== quote.currency || payment.planId !== quote.planId
    || payment.billingPeriod !== quote.billingPeriod || Number(payment.subjectCount) !== quote.subjectCount) {
    throw new HttpsError('failed-precondition', 'A matching successful student payment is required.');
  }
  if (existingCount + additions > quote.subjectCount) {
    throw new HttpsError('failed-precondition', `Your subscription includes ${quote.subjectCount} subject(s).`);
  }
  return { subscription, quote };
};

const copyTopicHistory = async ({ db, previousRef, nextRef }) => {
  const topics = await previousRef.collection('topics').get();
  let batch = db.batch();
  let writes = 0;
  const commitIfFull = async () => {
    if (writes < 450) return;
    await batch.commit();
    batch = db.batch();
    writes = 0;
  };
  for (const topic of topics.docs) {
    const targetTopic = nextRef.collection('topics').doc(topic.id);
    batch.set(targetTopic, { ...topic.data(), restoredAt: admin.firestore.FieldValue.serverTimestamp() });
    writes += 1;
    await commitIfFull();
    const scores = await topic.ref.collection('understandingScores').get();
    for (const score of scores.docs) {
      batch.set(targetTopic.collection('understandingScores').doc(score.id), score.data());
      writes += 1;
      await commitIfFull();
    }
  }
  if (writes) await batch.commit();
  return topics.size;
};

const getVerifiedSubjectCapacity = async ({ db, studentId }) => {
  const subscriptionSnapshot = await studentSubscriptionRef(db, studentId).get();
  if (!subscriptionSnapshot.exists) return 0;
  const subscription = subscriptionSnapshot.data();
  const renewalDate = subscription.renewalDate?.toDate?.();
  if (subscription.status !== 'active' || !renewalDate || renewalDate <= new Date()
    || !['circle', 'personalized'].includes(subscription.planId) || !subscription.latestReference) return 0;
  let quote;
  try {
    quote = calculateSubscriptionQuote(subscription);
  } catch {
    return 0;
  }
  const paymentSnapshot = await studentPaymentRef(db, studentId, subscription.latestReference).get();
  const payment = paymentSnapshot.exists ? paymentSnapshot.data() : null;
  return payment?.status === 'success' && payment.studentId === studentId
    && payment.reference === subscription.latestReference && isSavedSubscriptionPaymentConsistent({ quote, subscription, payment })
    && payment.planId === quote.planId && payment.billingPeriod === quote.billingPeriod
    && Number(payment.subjectCount) === quote.subjectCount ? quote.subjectCount : 0;
};

const getRestorableSubjectEpisodes = async ({ db, studentId, grade, now = new Date() }) => {
  const snapshot = await subjectCollection(db, studentId).get();
  const cutoff = dateThreeMonthsBefore(now);
  const latestBySubject = new Map();
  snapshot.docs.forEach((episode) => {
    const data = episode.data();
    const cancelledAt = data.cancelledAt?.toDate?.();
    const subject = normalizeSupportedSubject(data.subjectKey);
    if (data.status !== 'cancelled' || data.grade !== grade || !cancelledAt || cancelledAt < cutoff || !subject) return;
    const previous = latestBySubject.get(subject);
    if (!previous || cancelledAt > previous.cancelledAt) {
      latestBySubject.set(subject, { episodeId: episode.id, subject, grade, cancelledAt });
    }
  });
  return [...latestBySubject.values()]
    .sort((left, right) => left.subject.localeCompare(right.subject))
    .map((candidate) => ({ ...candidate, cancelledAt: candidate.cancelledAt.toISOString() }));
};

export const getStudentSubjectHistoryOptions = onCall({ cpu: 'gcf_gen1' }, async (request) => {
  const uid = requireUid(request);
  const studentId = String(request.data?.studentId ?? '').trim();
  const grade = String(request.data?.grade ?? '').trim();
  if (!studentId || !/^Grade (?:[4-9]|1[0-2])$/.test(grade)) {
    throw new HttpsError('invalid-argument', 'Choose a student and a valid destination grade.');
  }
  const db = getDb();
  const studentSnapshot = await db.collection('users').doc(studentId).get();
  if (!studentSnapshot.exists || studentSnapshot.data().role !== 'student') throw new HttpsError('not-found', 'Student profile not found.');
  await authorizeStudentChange({ db, uid, studentId, student: studentSnapshot.data() });
  const [candidates, subjectCapacity] = await Promise.all([
    getRestorableSubjectEpisodes({ db, studentId, grade }),
    getVerifiedSubjectCapacity({ db, studentId }),
  ]);
  return { studentId, grade, subjectCapacity, candidates };
});

export const updateStudentSubjects = onCall({ cpu: 'gcf_gen1', timeoutSeconds: 300 }, async (request) => {
  const uid = requireUid(request);
  const { studentId, action } = request.data ?? {};
  if (!studentId || !['add', 'remove'].includes(action)) throw new HttpsError('invalid-argument', 'A student and action are required.');
  const requested = action === 'add' ? request.data?.subjects : [request.data?.subject];
  const subjects = [...new Set((Array.isArray(requested) ? requested : []).filter(Boolean).map(normalizeSubject))];
  const restoreSubjectInstanceIds = [...new Set((Array.isArray(request.data?.restoreSubjectInstanceIds)
    ? request.data.restoreSubjectInstanceIds : []).map((value) => String(value ?? '').trim()).filter(Boolean))];
  if (!subjects.length) throw new HttpsError('invalid-argument', 'Choose at least one supported subject.');
  if (action !== 'add' && restoreSubjectInstanceIds.length) throw new HttpsError('invalid-argument', 'History can only be restored while adding subjects.');
  const db = getDb();
  const studentRef = db.collection('users').doc(studentId);
  const studentSnapshot = await studentRef.get();
  if (!studentSnapshot.exists || studentSnapshot.data().role !== 'student') throw new HttpsError('not-found', 'Student profile not found.');
  const student = studentSnapshot.data();
  await authorizeStudentChange({ db, uid, studentId, student });
  const now = new Date();
  const timestamp = admin.firestore.Timestamp.fromDate(now);

  if (action === 'remove') {
    const removed = await db.runTransaction(async (transaction) => {
      const [currentStudent, episodeSnapshot] = await Promise.all([
        transaction.get(studentRef), transaction.get(subjectCollection(db, studentId)),
      ]);
      if (!currentStudent.exists || currentStudent.data().role !== 'student') throw new HttpsError('not-found', 'Student profile not found.');
      const activeBySubject = new Map(episodeSnapshot.docs
        .filter((document) => document.data().status === 'active')
        .map((document) => [normalizeSubject(document.data().subjectKey), document]));
      const removedSubjects = [];
      for (const subject of subjects) {
        const episode = activeBySubject.get(subject);
        if (!episode) continue;
        transaction.update(episode.ref, {
          status: 'cancelled', cancelledAt: timestamp, cancelledBy: uid, updatedAt: timestamp,
          activeStaffIds: [], primaryTutorId: '',
          staffMemberships: (episode.data().staffMemberships ?? []).map((item) => item.endedAt ? item : { ...item, endedAt: timestamp, endedBy: uid }),
        });
        removedSubjects.push(subject);
      }
      return removedSubjects;
    });
    return { studentId, removedSubjects: removed };
  }

  const result = await db.runTransaction(async (transaction) => {
    const [currentStudent, episodeSnapshot] = await Promise.all([
      transaction.get(studentRef), transaction.get(subjectCollection(db, studentId)),
    ]);
    if (!currentStudent.exists || currentStudent.data().role !== 'student') throw new HttpsError('not-found', 'Student profile not found.');
    const current = currentStudent.data();
    const episodes = episodeSnapshot.docs;
    const currentBySubject = new Map(episodes
      .filter((document) => ['active', 'restoring'].includes(document.data().status))
      .map((document) => [normalizeSubject(document.data().subjectKey), document]));
    const additions = subjects.filter((subject) => !currentBySubject.has(subject));
    const selectedHistory = restoreSubjectInstanceIds.map((episodeId) => episodes.find((document) => document.id === episodeId));
    if (selectedHistory.some((episode) => !episode)) throw new HttpsError('failed-precondition', 'A selected history episode is no longer available. Reload and choose again.');
    const cutoff = dateThreeMonthsBefore(now);
    const selectedHistoryBySubject = new Map();
    selectedHistory.forEach((episode) => {
      const data = episode.data();
      const previousSubject = normalizeSubject(data.subjectKey);
      const cancelledAt = data.cancelledAt?.toDate?.();
      if (data.status !== 'cancelled' || data.grade !== current.grade || !cancelledAt || cancelledAt < cutoff
        || !additions.includes(previousSubject) || selectedHistoryBySubject.has(previousSubject)) {
        throw new HttpsError('failed-precondition', 'Selected topic history must be a recent cancelled episode for a subject being added at the same grade.');
      }
      selectedHistoryBySubject.set(previousSubject, episode);
    });
    const capacity = additions.length
      ? await assertPaidSubjectCapacity({ db, studentId, existingCount: currentBySubject.size, additions: additions.length, transaction })
      : null;
    const createdSubjects = [];
    const restoreTasks = [];
    for (const subject of subjects) {
      const existing = currentBySubject.get(subject);
      if (existing) {
        if (existing.data().status === 'restoring' && existing.data().previousSubjectInstanceId) {
          restoreTasks.push({ subject, episodeRef: existing.ref, previousEpisodeId: existing.data().previousSubjectInstanceId });
        }
        continue;
      }
      const previous = selectedHistoryBySubject.get(subject) ?? null;
      const restore = Boolean(previous);
      const episodeRef = subjectCollection(db, studentId).doc();
      const lessonQuota = buildSubjectLessonQuota({
        subscription: capacity.subscription,
        quote: capacity.quote,
        windowStartAt: capacity.subscription.entitlementWindowStartAt || capacity.subscription.renewedAt || capacity.subscription.activatedAt,
        renewalDate: capacity.subscription.renewalDate,
        carryForward: false,
        cycleId: capacity.subscription.latestReference,
        updatedAt: timestamp,
      });
      transaction.set(episodeRef, {
        studentId, subjectKey: subject, subjectName: subject, grade: current.grade ?? '', curriculum: 'CAPS',
        status: restore ? 'restoring' : 'active', startedAt: timestamp, cancelledAt: null,
        previousSubjectInstanceId: restore ? previous.id : null,
        restoredAt: restore ? timestamp : null,
        completedTopicCount: restore ? Number(previous.data().completedTopicCount) || 0 : 0,
        dailyExerciseTarget: restore ? Math.min(5, Math.max(1, Number(previous.data().completedTopicCount) || 1)) : 1,
        lessonQuota,
        primaryTutorId: '', staffByUid: {}, activeStaffIds: [], historicalStaffIds: [], staffMemberships: [],
        studentName: current.displayName || current.email || 'Student', createdAt: timestamp, updatedAt: timestamp,
      });
      if (restore) restoreTasks.push({ subject, episodeRef, previousEpisodeId: previous.id });
      createdSubjects.push(subject);
    }
    return { createdSubjects, restoreTasks };
  });

  for (const task of result.restoreTasks) {
    const previousRef = subjectCollection(db, studentId).doc(task.previousEpisodeId);
    const restoredTopicCount = await copyTopicHistory({ db, previousRef, nextRef: task.episodeRef });
    await task.episodeRef.update({ status: 'active', completedTopicCount: restoredTopicCount,
      dailyExerciseTarget: Math.min(5, Math.max(1, restoredTopicCount)), updatedAt: admin.firestore.FieldValue.serverTimestamp() });
  }
  return { studentId, subjects: result.createdSubjects };
});

export const assignStudentToParent = onCall({ cpu: 'gcf_gen1' }, async (request) => {
  const parentId = requireUid(request);
  const studentIdentifier = String(request.data?.studentIdentifier ?? '').trim();
  if (!studentIdentifier) throw new HttpsError('invalid-argument', 'Enter the student email or account ID.');
  const db = getDb();
  const parentRef = db.collection('users').doc(parentId);
  const parentSnapshot = await parentRef.get();
  if (!parentSnapshot.exists || parentSnapshot.data().role !== 'parent') {
    throw new HttpsError('permission-denied', 'Only a parent account can link a student.');
  }

  let authUser;
  try {
    authUser = studentIdentifier.includes('@')
      ? await admin.auth().getUserByEmail(studentIdentifier.toLowerCase())
      : await admin.auth().getUser(studentIdentifier);
  } catch (error) {
    if (error?.code === 'auth/user-not-found' || error?.code === 'auth/invalid-uid') {
      throw new HttpsError('not-found', 'Student not found. Check the email or account ID.');
    }
    throw error;
  }
  const studentRef = db.collection('users').doc(authUser.uid);
  const student = await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(studentRef);
    if (!snapshot.exists || snapshot.data().role !== 'student') throw new HttpsError('not-found', 'Student profile not found.');
    const data = snapshot.data();
    if (data.parentId && data.parentId !== parentId) {
      throw new HttpsError('already-exists', 'This student is already linked to another parent.');
    }
    transaction.update(studentRef, { parentId, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    return data;
  });
  return { success: true, studentId: authUser.uid, parentId, studentName: student.displayName || student.email || 'Student' };
});

export const assignStudentToTutor = onCall({ cpu: 'gcf_gen1' }, async (request) => {
  const actorId = requireUid(request);
  const { studentId, tutorId } = request.data ?? {};
  const subject = normalizeSubject(request.data?.subject);
  if (typeof studentId !== 'string' || !studentId || typeof tutorId !== 'string' || !tutorId) {
    throw new HttpsError('invalid-argument', 'A student and tutor or teacher are required.');
  }
  const db = getDb();
  const actorRef = db.collection('users').doc(actorId);
  const tutorRef = db.collection('users').doc(tutorId);
  const studentRef = db.collection('users').doc(studentId);
  const subscriptionRef = studentSubscriptionRef(db, studentId);
  const now = admin.firestore.Timestamp.now();
  let episode;
  try {
    episode = await db.runTransaction(async (transaction) => {
      const [actorSnapshot, tutorSnapshot, studentSnapshot, subscriptionSnapshot, activeEpisodes] = await Promise.all([
        transaction.get(actorRef), transaction.get(tutorRef), transaction.get(studentRef), transaction.get(subscriptionRef),
        transaction.get(subjectCollection(db, studentId).where('status', '==', 'active')),
      ]);
      if (!actorSnapshot.exists || actorSnapshot.data().role !== 'admin') throw new HttpsError('permission-denied', 'Only an admin can assign the primary tutor.');
      if (!studentSnapshot.exists || studentSnapshot.data().role !== 'student') throw new HttpsError('not-found', 'Student profile not found.');
      ensureTutorForSubject(tutorSnapshot.exists ? tutorSnapshot.data() : null, subject);
      const subscription = subscriptionSnapshot.exists ? subscriptionSnapshot.data() : null;
      const renewalDate = subscription?.renewalDate?.toDate?.();
      if (!subscription || subscription.status !== 'active' || !['circle', 'personalized'].includes(subscription.planId)
        || !renewalDate || renewalDate <= now.toDate() || !subscription.latestReference) {
        throw new HttpsError('failed-precondition', 'A student needs an active paid subscription before a tutor can be assigned.');
      }
      let quote;
      try { quote = calculateSubscriptionQuote(subscription); } catch {
        throw new HttpsError('failed-precondition', 'The student’s active subscription selection is invalid.');
      }
      const paymentRef = studentPaymentRef(db, studentId, subscription.latestReference);
      const paymentSnapshot = await transaction.get(paymentRef);
      const payment = paymentSnapshot.exists ? paymentSnapshot.data() : null;
      if (!payment || payment.status !== 'success' || payment.studentId !== studentId
        || payment.reference !== subscription.latestReference
        || !isSavedSubscriptionPaymentConsistent({ quote, subscription, payment })
        || payment.currency !== quote.currency || payment.planId !== quote.planId
        || payment.billingPeriod !== quote.billingPeriod || Number(payment.subjectCount) !== quote.subjectCount) {
        throw new HttpsError('failed-precondition', 'A matching successful subscription payment is required before assigning a tutor.');
      }
      if (activeEpisodes.size > quote.subjectCount) {
        throw new HttpsError('failed-precondition', 'The student has more active subjects than their subscription allows.');
      }
      const matchingEpisode = activeEpisodes.docs.find((document) => normalizeSubject(document.data().subjectKey) === subject);
      if (!matchingEpisode) throw new HttpsError('not-found', 'Active subject episode not found.');
      const currentEpisode = await transaction.get(matchingEpisode.ref);
      if (!currentEpisode.exists || currentEpisode.data().status !== 'active') {
        throw new HttpsError('not-found', 'Active subject episode not found.');
      }
      const current = currentEpisode.data();
      if (current.primaryTutorId) throw new HttpsError('already-exists', `This student already has a primary tutor for ${subject}.`);
      transaction.update(currentEpisode.ref, {
        primaryTutorId: tutorId,
        activeStaffIds: admin.firestore.FieldValue.arrayUnion(tutorId),
        historicalStaffIds: admin.firestore.FieldValue.arrayUnion(tutorId),
        [`staffByUid.${tutorId}`]: 'co-owner',
        staffMemberships: [...(current.staffMemberships ?? []), membership({ uid: tutorId, role: 'co-owner', grantedAt: now, grantedBy: actorId })],
        updatedAt: now,
      });
      return { id: currentEpisode.id, studentId, tutorId, subject };
    });
  } catch (error) {
    if (error instanceof HttpsError) throw error;
    logger.error('Could not assign the primary tutor to the student subject', {
      actorId, studentId, tutorId, subject, error: error?.message ?? String(error),
    });
    throw new HttpsError('internal', 'The tutor could not be assigned because an internal error occurred. Please retry.');
  }
  return episode;
});

export const manageStaffStudentAccess = onCall({ cpu: 'gcf_gen1' }, async (request) => {
  const actorId = requireUid(request);
  const { action, studentId, tutorId, accessRole } = request.data ?? {};
  const subject = normalizeSubject(request.data?.subject);
  if (!['grant', 'revoke'].includes(action) || !studentId) throw new HttpsError('invalid-argument', 'A valid access action is required.');
  if (!tutorId || (action === 'grant' && !ACCESS_ROLES.includes(accessRole))) throw new HttpsError('invalid-argument', 'Tutor and valid role are required.');
  const db = getDb();
  const episodeSnapshot = await subjectCollection(db, studentId).where('subjectKey', '==', subject).where('status', '==', 'active').limit(1).get();
  if (episodeSnapshot.empty) throw new HttpsError('not-found', 'Active subject episode not found.');
  const episode = episodeSnapshot.docs[0];
  const episodeData = episode.data();
  if (episodeData.primaryTutorId !== actorId && episodeData.staffByUid?.[actorId] !== 'co-owner') {
    throw new HttpsError('permission-denied', 'Only the primary tutor or a co-owner can manage staff.');
  }
  if (action === 'revoke' && episodeData.primaryTutorId === tutorId) {
    throw new HttpsError('failed-precondition', 'The primary tutor must be replaced by an admin, not revoked as shared staff.');
  }
  const target = await db.collection('users').doc(tutorId).get();
  if (action === 'grant') ensureTutorForSubject(target.exists ? target.data() : null, subject);
  const now = admin.firestore.Timestamp.now();
  const memberships = (episodeData.staffMemberships ?? []).map((item) =>
    item.uid === tutorId && !item.endedAt ? { ...item, endedAt: now, endedBy: actorId } : item);
  if (action === 'grant') memberships.push(membership({ uid: tutorId, role: accessRole, grantedAt: now, grantedBy: actorId }));
  const activeIds = new Set(episodeData.activeStaffIds ?? []);
  if (action === 'grant') activeIds.add(tutorId); else activeIds.delete(tutorId);
  await episode.ref.update({
    activeStaffIds: [...activeIds], historicalStaffIds: admin.firestore.FieldValue.arrayUnion(tutorId),
    [`staffByUid.${tutorId}`]: action === 'grant' ? accessRole : admin.firestore.FieldValue.delete(),
    staffMemberships: memberships, updatedAt: now,
  });
  return { id: `${episode.id}:${tutorId}`, studentId, tutorId, subject, accessRole, active: action === 'grant' };
});

export const changeStudentGrade = onCall({ cpu: 'gcf_gen1' }, async (request) => {
  const uid = requireUid(request);
  const { studentId, newGrade } = request.data ?? {};
  const grade = String(newGrade ?? '').trim();
  const restoreSubjectInstanceIds = [...new Set((Array.isArray(request.data?.restoreSubjectInstanceIds)
    ? request.data.restoreSubjectInstanceIds : []).map((value) => String(value ?? '').trim()).filter(Boolean))];
  if (!studentId || !/^Grade (?:[4-9]|1[0-2])$/.test(grade)) throw new HttpsError('invalid-argument', 'Student and a valid new grade are required.');
  if (restoreSubjectInstanceIds.length > 20) throw new HttpsError('invalid-argument', 'Choose no more than 20 subject histories to restore.');
  const db = getDb();
  const studentRef = db.collection('users').doc(studentId);
  const studentSnapshot = await studentRef.get();
  if (!studentSnapshot.exists || studentSnapshot.data().role !== 'student') throw new HttpsError('not-found', 'Student profile not found.');
  const student = studentSnapshot.data();
  await authorizeStudentChange({ db, uid, studentId, student });
  const now = admin.firestore.Timestamp.now();
  const subscriptionRef = studentSubscriptionRef(db, studentId);
  const result = await db.runTransaction(async (transaction) => {
    const [currentStudent, subscriptionSnapshot, episodeSnapshot] = await Promise.all([
      transaction.get(studentRef), transaction.get(subscriptionRef), transaction.get(subjectCollection(db, studentId)),
    ]);
    if (!currentStudent.exists || currentStudent.data().role !== 'student') throw new HttpsError('not-found', 'Student profile not found.');
    const current = currentStudent.data();
    const episodes = episodeSnapshot.docs;
    const active = episodes.filter((episode) => episode.data().status === 'active');
    const sameGrade = current.grade === grade;
    const activeToCancel = sameGrade ? [] : active;
    const restoring = episodes.filter((episode) => episode.data().status === 'restoring'
      && episode.data().grade === grade && (!restoreSubjectInstanceIds.length || restoreSubjectInstanceIds.includes(episode.data().previousSubjectInstanceId)));
    if (sameGrade && !restoring.length && !restoreSubjectInstanceIds.length) return { unchanged: true, previousGrade: current.grade, restoredTasks: [], resetEpisodesCount: 0, cancelledLessonRefs: [] };

    const selected = sameGrade
      ? restoring.map((episode) => episodes.find((candidate) => candidate.id === episode.data().previousSubjectInstanceId)).filter(Boolean)
      : restoreSubjectInstanceIds.map((id) => episodes.find((episode) => episode.id === id));
    if (selected.some((episode) => !episode)) throw new HttpsError('failed-precondition', 'A selected history episode is no longer available. Reload and choose again.');
    if (!sameGrade && active.some((episode) => episode.data().grade === grade)) {
      throw new HttpsError('failed-precondition', 'An active subject already exists for the destination grade. Reload before changing grades.');
    }

    const cutoff = dateThreeMonthsBefore(new Date());
    const selectedBySubject = new Map();
    selected.forEach((episode) => {
      const data = episode.data();
      const subject = normalizeSubject(data.subjectKey);
      const cancelledAt = data.cancelledAt?.toDate?.();
      if ((!sameGrade && data.status !== 'cancelled') || data.grade !== grade || !cancelledAt || cancelledAt < cutoff
        || selectedBySubject.has(subject)) {
        throw new HttpsError('failed-precondition', 'Selected topic history must be a recent cancelled episode in the destination grade.');
      }
      selectedBySubject.set(subject, episode);
    });

    const subscription = subscriptionSnapshot.exists ? subscriptionSnapshot.data() : null;
    let restoreQuotaContext = null;
    if (selected.length) {
      const renewalDate = subscription?.renewalDate?.toDate?.();
      if (subscription?.status !== 'active' || !renewalDate || renewalDate <= new Date()
        || !['circle', 'personalized'].includes(subscription?.planId) || !subscription?.latestReference) {
        throw new HttpsError('failed-precondition', 'An active paid subscription is required to restore subject history.');
      }
      const quote = calculateSubscriptionQuote(subscription);
      const paymentRef = studentPaymentRef(db, studentId, subscription.latestReference);
      const paymentSnapshot = await transaction.get(paymentRef);
      const payment = paymentSnapshot.exists ? paymentSnapshot.data() : null;
      if (!payment || payment.status !== 'success' || payment.studentId !== studentId
        || payment.reference !== subscription.latestReference || Number(payment.amount) !== quote.amount
        || payment.currency !== quote.currency || payment.planId !== quote.planId
        || payment.billingPeriod !== quote.billingPeriod || Number(payment.subjectCount) !== quote.subjectCount) {
        throw new HttpsError('failed-precondition', 'A matching successful payment is required to restore subject history.');
      }
      if (selected.length > quote.subjectCount) throw new HttpsError('failed-precondition', `Your active subscription allows up to ${quote.subjectCount} subject(s).`);
      restoreQuotaContext = { subscription, quote };
    }

    const plannedQueries = activeToCancel.map((episode) => transaction.get(episode.ref.collection('lessons').where('status', 'in', ['planned', 'incomplete'])));
    const plannedSnapshots = plannedQueries.length ? await Promise.all(plannedQueries) : [];
    const affectedLessons = plannedSnapshots.flatMap((snapshot) => snapshot.docs);
    const groupIds = [...new Set(affectedLessons.map((lesson) => lesson.data().groupSessionId).filter(Boolean))];
    const groupSnapshots = await Promise.all(groupIds.map((groupSessionId) => transaction.get(
      db.collectionGroup('lessons').where('groupSessionId', '==', groupSessionId).where('status', 'in', ['planned', 'incomplete']),
    )));
    const allGroupRows = new Map(groupSnapshots.flatMap((snapshot) => snapshot.docs).map((lesson) => [lesson.ref.path, lesson]));
    const affectedPaths = new Set(affectedLessons.map((lesson) => lesson.ref.path));
    const groupActions = [];
    for (const groupId of groupIds) {
      const rows = [...allGroupRows.values()].filter((lesson) => lesson.data().groupSessionId === groupId);
      const affectedGroupRows = rows.filter((lesson) => affectedPaths.has(lesson.ref.path));
      const nextCount = rows.length - affectedGroupRows.length;
      groupActions.push({ rows, cancelAll: nextCount < 2, nextCount });
    }
    const cancelledLessonRefs = new Set();
    const groupCountUpdates = new Map();
    groupActions.forEach(({ rows, cancelAll, nextCount }) => rows.forEach((lesson) => {
      if (cancelAll || affectedPaths.has(lesson.ref.path)) cancelledLessonRefs.add(lesson.ref.path);
      else {
        groupCountUpdates.set(lesson.ref.path, { ref: lesson.ref, nextCount });
      }
    }));
    affectedLessons.filter((lesson) => !lesson.data().groupSessionId).forEach((lesson) => cancelledLessonRefs.add(lesson.ref.path));

    const lessonDocsByPath = new Map([...allGroupRows, ...affectedLessons.map((lesson) => [lesson.ref.path, lesson])]);
    const rowsToCancel = [...cancelledLessonRefs].map((path) => lessonDocsByPath.get(path)).filter(Boolean);
    const episodeSnapshotByPath = new Map(episodes.map((episode) => [episode.ref.path, episode]));
    const quotaEpisodeRefs = [...new Map(rowsToCancel
      .filter((lessonDoc) => ['planned', 'incomplete'].includes(lessonDoc.data().status))
      .map((lessonDoc) => {
        const episodeRef = lessonDoc.ref.parent.parent;
        return [episodeRef.path, episodeRef];
      })).values()];
    const missingQuotaEpisodeRefs = quotaEpisodeRefs.filter((episodeRef) => !episodeSnapshotByPath.has(episodeRef.path));
    const missingQuotaEpisodeSnapshots = missingQuotaEpisodeRefs.length
      ? await Promise.all(missingQuotaEpisodeRefs.map((episodeRef) => transaction.get(episodeRef)))
      : [];
    missingQuotaEpisodeRefs.forEach((episodeRef, index) => episodeSnapshotByPath.set(episodeRef.path, missingQuotaEpisodeSnapshots[index]));
    const quotaUpdates = new Map();
    rowsToCancel.forEach((lessonDoc) => {
      const lesson = lessonDoc.data();
      if (!['planned', 'incomplete'].includes(lesson.status)) return;
      const episodeRef = lessonDoc.ref.parent.parent;
      const episodeSnapshot = episodeSnapshotByPath.get(episodeRef.path);
      if (!episodeSnapshot?.exists) return;
      const lessonQuota = releaseCancelledLessonQuota({
        lessonQuota: quotaUpdates.get(episodeRef.path) ?? episodeSnapshot.data().lessonQuota,
        lesson, now,
      });
      if (lessonQuota) quotaUpdates.set(episodeRef.path, lessonQuota);
    });
    const episodeWritePaths = new Set([
      ...activeToCancel.map((episode) => episode.ref.path),
      ...quotaUpdates.keys(),
    ]);
    const createdRestorationCount = sameGrade ? 0 : selected.length;
    if (episodeWritePaths.size + cancelledLessonRefs.size + groupCountUpdates.size + createdRestorationCount + (sameGrade ? 0 : 1) > 500) {
      throw new HttpsError('resource-exhausted', 'There are too many scheduled lessons to change this grade in one operation. Cancel some future lessons and retry.');
    }

    if (!sameGrade) {
      activeToCancel.forEach((episode) => transaction.update(episode.ref, {
        status: 'cancelled', cancelledAt: now, cancelledBy: uid, endReason: 'grade_changed',
        activeStaffIds: [], primaryTutorId: '',
        staffMemberships: (episode.data().staffMemberships ?? []).map((item) => item.endedAt ? item : { ...item, endedAt: now, endedBy: uid }),
        ...(quotaUpdates.has(episode.ref.path) ? { lessonQuota: quotaUpdates.get(episode.ref.path) } : {}),
        updatedAt: now,
      }));
      transaction.update(studentRef, { grade, updatedAt: now });
    }
    quotaUpdates.forEach((lessonQuota, episodePath) => {
      if (activeToCancel.some((episode) => episode.ref.path === episodePath)) return;
      transaction.update(db.doc(episodePath), { lessonQuota, updatedAt: now });
    });
    groupCountUpdates.forEach(({ ref, nextCount }) => transaction.update(ref, { groupStudentCount: nextCount, updatedAt: now }));
    cancelledLessonRefs.forEach((path) => {
      const lessonDoc = lessonDocsByPath.get(path);
      if (lessonDoc) transaction.update(lessonDoc.ref, {
        status: 'cancelled', attendanceStatus: 'cancelled', attended: false,
        cancelledAt: now, cancellationReason: 'grade_changed', updatedAt: now,
      });
    });

    const restoredTasks = [];
    selected.forEach((previous) => {
      if (sameGrade) {
        const currentRestoring = episodes.find((episode) => episode.data().status === 'restoring'
          && episode.data().previousSubjectInstanceId === previous.data().previousSubjectInstanceId);
        if (currentRestoring) restoredTasks.push({ subject: normalizeSubject(currentRestoring.data().subjectKey), episodeId: currentRestoring.id, previousEpisodeId: previous.data().previousSubjectInstanceId });
        return;
      }
      const subject = normalizeSubject(previous.data().subjectKey);
      const episodeRef = subjectCollection(db, studentId).doc();
      const lessonQuota = buildSubjectLessonQuota({
        subscription: restoreQuotaContext.subscription,
        quote: restoreQuotaContext.quote,
        windowStartAt: restoreQuotaContext.subscription.entitlementWindowStartAt
          || restoreQuotaContext.subscription.renewedAt
          || restoreQuotaContext.subscription.activatedAt,
        renewalDate: restoreQuotaContext.subscription.renewalDate,
        carryForward: false,
        cycleId: restoreQuotaContext.subscription.latestReference,
        updatedAt: now,
      });
      transaction.create(episodeRef, {
        studentId, subjectKey: subject, subjectName: subject, grade, curriculum: 'CAPS',
        status: 'restoring', startedAt: now, cancelledAt: null,
        previousSubjectInstanceId: previous.id, restoredAt: now,
        completedTopicCount: 0, dailyExerciseTarget: 1,
        lessonQuota,
        primaryTutorId: '', staffByUid: {}, activeStaffIds: [], historicalStaffIds: [], staffMemberships: [],
        studentName: current.displayName || current.email || 'Student', createdAt: now, updatedAt: now,
      });
      restoredTasks.push({ subject, episodeId: episodeRef.id, previousEpisodeId: previous.id });
    });
    return {
      unchanged: sameGrade,
      previousGrade: current.grade,
      resetEpisodesCount: sameGrade ? 0 : activeToCancel.length,
      restoredTasks,
      cancelledLessonRefs: [...cancelledLessonRefs],
    };
  });

  for (const task of result.restoredTasks) {
    const nextRef = subjectCollection(db, studentId).doc(task.episodeId);
    const previousRef = subjectCollection(db, studentId).doc(task.previousEpisodeId);
    const restoredTopicCount = await copyTopicHistory({ db, previousRef, nextRef });
    await nextRef.update({ status: 'active', completedTopicCount: restoredTopicCount,
      dailyExerciseTarget: Math.min(5, Math.max(1, restoredTopicCount)), restoredAt: now, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
  }
  return {
    studentId, previousGrade: result.previousGrade, grade,
    unchanged: result.unchanged, resetEpisodesCount: result.resetEpisodesCount,
    cancelledPlannedLessons: result.cancelledLessonRefs.length,
    restoredSubjects: result.restoredTasks.map((task) => task.subject),
  };
});
