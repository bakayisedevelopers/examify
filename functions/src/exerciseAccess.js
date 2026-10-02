import { HttpsError } from 'firebase-functions/v2/https';
import { getDb } from './admin.js';
import { calculateSubscriptionQuote } from './subscriptionPricing.js';

const normalizeSubject = (value = '') => {
  const normalized = String(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (['math', 'maths'].includes(normalized)) return 'mathematics';
  if (['math lit', 'maths literacy'].includes(normalized)) return 'mathematical literacy';
  return normalized;
};

const getRegisteredSubjects = (student = {}) => [...new Set([
  student.subject,
  ...(Array.isArray(student.subjects) ? student.subjects : []),
].filter(Boolean).map(normalizeSubject))];

const assertGeneratorAccess = async ({ authUid, caller, studentId, episode }) => {
  if (authUid === studentId && caller.role === 'student') return;
  if (caller.role === 'admin') return;

  const isTutorOrTeacher = caller.role === 'tutor' || caller.isTeacher === true || caller.isTeacher === 'true';
  if (!isTutorOrTeacher) {
    throw new HttpsError('permission-denied', 'You cannot generate exercises for this student.');
  }

  const isPrimaryTutor = episode.primaryTutorId === authUid;
  const isCoOwner = episode.staffByUid?.[authUid] === 'co-owner';
  if (!isPrimaryTutor && !isCoOwner) {
    throw new HttpsError('permission-denied', 'Co-owner access to this student and subject is required to generate exercises.');
  }
};

export const assertPaidExerciseGenerationAccess = async ({ authUid, studentId, subject, subjectInstanceId }) => {
  if (!authUid) throw new HttpsError('unauthenticated', 'Sign in before generating exercises.');
  if (!studentId || !subject) throw new HttpsError('invalid-argument', 'A student and subject are required for exercise generation.');

  const db = getDb();
  const episodeRef = subjectInstanceId
    ? db.collection('users').doc(studentId).collection('subjects').doc(subjectInstanceId)
    : null;
  const [callerSnapshot, studentSnapshot, subscriptionSnapshot, explicitEpisodeSnapshot] = await Promise.all([
    db.collection('users').doc(authUid).get(),
    db.collection('users').doc(studentId).get(),
    db.collection('users').doc(studentId).collection('subscriptions').doc('current').get(),
    episodeRef ? episodeRef.get() : Promise.resolve(null),
  ]);
  if (!callerSnapshot.exists) throw new HttpsError('permission-denied', 'The signed-in account was not found.');
  if (!studentSnapshot.exists || studentSnapshot.data().role !== 'student') {
    throw new HttpsError('not-found', 'The student account was not found.');
  }

  const caller = callerSnapshot.data();
  const student = studentSnapshot.data();
  let episodeSnapshot = explicitEpisodeSnapshot;
  if (!episodeSnapshot) {
    const episodes = await db.collection('users').doc(studentId).collection('subjects')
      .where('status', '==', 'active').where('subjectKey', '==', subject).limit(1).get();
    episodeSnapshot = episodes.docs[0] ?? null;
  }
  if (!episodeSnapshot?.exists || episodeSnapshot.data().status !== 'active'
    || normalizeSubject(episodeSnapshot.data().subjectKey) !== normalizeSubject(subject)) {
    throw new HttpsError('failed-precondition', 'An active matching subject episode is required.');
  }
  const episode = episodeSnapshot.data();
  await assertGeneratorAccess({ authUid, caller, studentId, episode });

  if (!subscriptionSnapshot.exists) {
    throw new HttpsError('failed-precondition', 'An active paid subscription is required for exercise generation.');
  }

  const subscription = subscriptionSnapshot.data();
  const renewalDate = subscription.renewalDate?.toDate?.() ?? null;
  const graceEndsAt = subscription.graceEndsAt?.toDate?.() ?? null;
  const now = new Date();
  const withinPaidPeriod = subscription.status === 'active'
    && renewalDate instanceof Date
    && renewalDate > now;
  const withinRenewalGrace = subscription.status === 'past_due'
    && renewalDate instanceof Date
    && renewalDate <= now
    && graceEndsAt instanceof Date
    && graceEndsAt > now;
  if (!['circle', 'personalized'].includes(subscription.planId)
    || (!withinPaidPeriod && !withinRenewalGrace)) {
    throw new HttpsError('failed-precondition', 'An active paid subscription is required for exercise generation.');
  }

  let expectedQuote;
  try {
    expectedQuote = calculateSubscriptionQuote({
      planId: subscription.planId,
      billingPeriod: subscription.billingPeriod,
      subjectCount: subscription.subjectCount,
    });
  } catch {
    throw new HttpsError('failed-precondition', 'The active subscription details are invalid.');
  }

  const includedSubjects = getRegisteredSubjects(student).slice(0, expectedQuote.subjectCount);
  if (!includedSubjects.includes(normalizeSubject(subject))) {
    throw new HttpsError('failed-precondition', "This subject is not included in the student's registered paid-subscription subjects.");
  }

  const paymentReference = subscription.latestReference;
  if (!paymentReference) {
    throw new HttpsError('failed-precondition', 'A confirmed payment is required for this subscription.');
  }
  const paymentSnapshot = await db.collection('users').doc(studentId).collection('payments').doc(paymentReference).get();
  const payment = paymentSnapshot.exists ? paymentSnapshot.data() : null;
  const paymentMatchesSubscription = Boolean(payment
    && payment.status === 'success'
    && payment.reference === paymentReference
    && payment.studentId === studentId
    && payment.planId === subscription.planId
    && payment.billingPeriod === subscription.billingPeriod
    && Number(payment.subjectCount) === expectedQuote.subjectCount
    && Number(payment.amount) === expectedQuote.amount
    && payment.currency === expectedQuote.currency);
  if (!paymentMatchesSubscription) {
    throw new HttpsError('failed-precondition', 'The active subscription does not have a matching successful payment.');
  }

  return {
    subscriptionId: studentId,
    subscriptionPlanId: subscription.planId,
    subscriptionPlanName: expectedQuote.planName,
    subscriptionPaymentReference: paymentReference,
    subjectInstanceId: episodeSnapshot.id,
  };
};
