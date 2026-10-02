import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { admin, getDb } from './admin.js';
import { calculateSubscriptionQuote } from './subscriptionPricing.js';
import { normalizeSupportedSubject } from './subjects.js';

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
    || payment.reference !== subscription.latestReference || Number(payment.amount) !== quote.amount) {
    throw new HttpsError('failed-precondition', 'A matching successful student payment is required.');
  }
  if (existingCount + additions > quote.subjectCount) {
    throw new HttpsError('failed-precondition', `Your subscription includes ${quote.subjectCount} subject(s).`);
  }
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

export const updateStudentSubjects = onCall({ cpu: 'gcf_gen1', timeoutSeconds: 300 }, async (request) => {
  const uid = requireUid(request);
  const { studentId, action } = request.data ?? {};
  if (!studentId || !['add', 'remove'].includes(action)) throw new HttpsError('invalid-argument', 'A student and action are required.');
  const requested = action === 'add' ? request.data?.subjects : [request.data?.subject];
  const subjects = [...new Set((Array.isArray(requested) ? requested : []).filter(Boolean).map(normalizeSubject))];
  if (!subjects.length) throw new HttpsError('invalid-argument', 'Choose at least one supported subject.');
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
    if (additions.length) {
      await assertPaidSubjectCapacity({ db, studentId, existingCount: currentBySubject.size, additions: additions.length, transaction });
    }
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
      const previous = episodes
        .filter((document) => document.data().status === 'cancelled' && normalizeSubject(document.data().subjectKey) === subject)
        .sort((left, right) => (right.data().cancelledAt?.toMillis?.() ?? 0) - (left.data().cancelledAt?.toMillis?.() ?? 0))[0];
      const cancelledAt = previous?.data().cancelledAt?.toDate?.();
      const restore = Boolean(previous && previous.data().grade === current.grade && cancelledAt >= dateThreeMonthsBefore(now));
      const episodeRef = subjectCollection(db, studentId).doc();
      transaction.set(episodeRef, {
        studentId, subjectKey: subject, subjectName: subject, grade: current.grade ?? '', curriculum: 'CAPS',
        status: restore ? 'restoring' : 'active', startedAt: timestamp, cancelledAt: null,
        previousSubjectInstanceId: restore ? previous.id : null,
        restoredAt: restore ? timestamp : null,
        completedTopicCount: restore ? Number(previous.data().completedTopicCount) || 0 : 0,
        dailyExerciseTarget: restore ? Math.min(5, Math.max(1, Number(previous.data().completedTopicCount) || 1)) : 1,
        primaryTutorId: '', staffByUid: {}, activeStaffIds: [], historicalStaffIds: [], staffMemberships: [],
        initialReport: restore ? previous.data().initialReport ?? '' : '',
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
  const [actor, tutor, episodeSnapshot] = await Promise.all([
    db.collection('users').doc(actorId).get(), db.collection('users').doc(tutorId).get(),
    subjectCollection(db, studentId).where('subjectKey', '==', subject).where('status', '==', 'active').limit(1).get(),
  ]);
  if (actor.data()?.role !== 'admin') throw new HttpsError('permission-denied', 'Only an admin can assign the primary tutor.');
  ensureTutorForSubject(tutor.exists ? tutor.data() : null, subject);
  if (episodeSnapshot.empty) throw new HttpsError('not-found', 'Active subject episode not found.');
  const episode = episodeSnapshot.docs[0];
  const now = admin.firestore.Timestamp.now();
  await db.runTransaction(async (transaction) => {
    const currentEpisode = await transaction.get(episode.ref);
    if (!currentEpisode.exists || currentEpisode.data().status !== 'active') {
      throw new HttpsError('not-found', 'Active subject episode not found.');
    }
    const current = currentEpisode.data();
    if (current.primaryTutorId) throw new HttpsError('already-exists', `This student already has a primary tutor for ${subject}.`);
    transaction.update(episode.ref, {
      primaryTutorId: tutorId,
      activeStaffIds: admin.firestore.FieldValue.arrayUnion(tutorId),
      historicalStaffIds: admin.firestore.FieldValue.arrayUnion(tutorId),
      [`staffByUid.${tutorId}`]: 'co-owner',
      staffMemberships: [...(current.staffMemberships ?? []), membership({ uid: tutorId, role: 'co-owner', grantedAt: now, grantedBy: actorId })],
      updatedAt: now,
    });
  });
  return { id: episode.id, studentId, tutorId, subject };
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
  if (!studentId || !newGrade) throw new HttpsError('invalid-argument', 'Student and new grade are required.');
  const db = getDb();
  const studentRef = db.collection('users').doc(studentId);
  const studentSnapshot = await studentRef.get();
  if (!studentSnapshot.exists || studentSnapshot.data().role !== 'student') throw new HttpsError('not-found', 'Student profile not found.');
  const student = studentSnapshot.data();
  await authorizeStudentChange({ db, uid, studentId, student });
  if (student.grade === newGrade) return { studentId, grade: newGrade, unchanged: true };
  const active = await subjectCollection(db, studentId).where('status', '==', 'active').get();
  const now = admin.firestore.Timestamp.now();
  const batch = db.batch();
  active.docs.forEach((episode) => {
    batch.update(episode.ref, { status: 'cancelled', cancelledAt: now, cancelledBy: uid, endReason: 'grade_changed', activeStaffIds: [], primaryTutorId: '', updatedAt: now });
    const subject = normalizeSubject(episode.data().subjectKey);
    batch.set(subjectCollection(db, studentId).doc(), {
      studentId, subjectKey: subject, subjectName: subject, grade: newGrade, curriculum: 'CAPS', status: 'active',
      startedAt: now, cancelledAt: null, completedTopicCount: 0, dailyExerciseTarget: 1,
      primaryTutorId: '', staffByUid: {}, activeStaffIds: [], historicalStaffIds: [], staffMemberships: [],
      initialReport: '', studentName: student.displayName || student.email || 'Student', createdAt: now, updatedAt: now,
    });
  });
  batch.update(studentRef, { grade: newGrade, updatedAt: now });
  await batch.commit();
  return { studentId, previousGrade: student.grade, newGrade, resetEpisodesCount: active.size };
});
