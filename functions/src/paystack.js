import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions';
import { randomUUID } from 'node:crypto';
import { getDb, admin } from './admin.js';
import { getPaystackConfig } from './config.js';
import { calculateSubscriptionQuote } from './subscriptionPricing.js';

const paystackRequest = async ({ path, method = 'POST', payload }) => {
  const { paystackSecretKey, paystackBaseUrl } = getPaystackConfig();

  if (!paystackSecretKey) {
    throw new HttpsError('failed-precondition', 'Missing PAYSTACK_SECRET_KEY environment variable.');
  }

  const response = await fetch(`${paystackBaseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${paystackSecretKey}`,
      'Content-Type': 'application/json',
    },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
  });

  const data = await response.json();

  if (!response.ok || data.status === false) {
    throw new HttpsError('internal', data.message ?? 'Paystack request failed.');
  }

  return data.data;
};

const makeReference = (prefix, studentId) => `${prefix}-${studentId}-${randomUUID()}`;

const isReusableAuthorization = (authorization) => authorization?.reusable === true
  && Boolean(authorization.authorizationCode)
  && Boolean(authorization.email);

export const applyFreeSubscription = async ({ studentId, pendingReference = null, pendingStatus = 'applied', reason = null }) => {
  const db = getDb();
  const now = admin.firestore.Timestamp.now();
  const quote = calculateSubscriptionQuote({ planId: 'free', billingPeriod: 'monthly', subjectCount: 0 });
  const batch = db.batch();
  const subscriptionPatch = {
    studentId,
    status: 'active',
    ...quote,
    amount: 0,
    currency: 'ZAR',
    latestReference: null,
    renewalDate: null,
    autoRenew: false,
    cancelAtPeriodEnd: false,
    pendingPlan: admin.firestore.FieldValue.delete(),
    pendingPlanReference: admin.firestore.FieldValue.delete(),
    graceEndsAt: admin.firestore.FieldValue.delete(),
    renewalVerificationHoldUntil: admin.firestore.FieldValue.delete(),
    nextRenewalAttemptAt: admin.firestore.FieldValue.delete(),
    renewalAttempt: admin.firestore.FieldValue.delete(),
    renewalAttemptCount: 0,
    renewalChargeLock: admin.firestore.FieldValue.delete(),
    manualPaymentRequired: false,
    lastChargeStatus: admin.firestore.FieldValue.delete(),
    updatedAt: now,
    ...(reason ? { lastSubscriptionChangeReason: reason } : {}),
  };
  batch.set(db.collection('subscriptions').doc(studentId), subscriptionPatch, { merge: true });
  batch.set(db.collection('users').doc(studentId), {
    paymentCompleted: false,
    subscriptionStatus: 'active',
    subscriptionPlanId: 'free',
    subscriptionPlanName: 'Free',
    subscriptionBillingPeriod: 'monthly',
    subscriptionSubjectCount: 0,
    latestPaymentReference: null,
    subscriptionRenewalDate: null,
    pendingSubscriptionPlan: admin.firestore.FieldValue.delete(),
    updatedAt: now,
  }, { merge: true });
  if (pendingReference) {
    batch.set(db.collection('payments').doc(pendingReference), {
      status: pendingStatus,
      appliedAt: pendingStatus === 'applied' ? now : admin.firestore.FieldValue.delete(),
      updatedAt: now,
    }, { merge: true });
  }
  await batch.commit();
  return quote;
};

const assertCanManageStudentSubscription = async ({ db, payerId, studentId }) => {
  const [payerSnapshot, studentSnapshot] = await Promise.all([
    db.collection('users').doc(payerId).get(),
    db.collection('users').doc(studentId).get(),
  ]);
  if (!payerSnapshot.exists || !studentSnapshot.exists || studentSnapshot.data().role !== 'student') {
    throw new HttpsError('not-found', 'The student account was not found.');
  }
  const payer = payerSnapshot.data();
  const student = studentSnapshot.data();
  const isStudent = payerId === studentId && payer.role === 'student';
  const isParent = payer.role === 'parent' && student.parentId === payerId;
  if (!isStudent && !isParent) {
    throw new HttpsError('permission-denied', 'Only the student or their linked parent can manage this subscription.');
  }
  return { isParent };
};

export const initializePaystackTransaction = onCall({ cpu: 'gcf_gen1' }, async (request) => {
  try {
    const { studentId, planId, billingPeriod, subjectCount, callbackUrl } = request.data ?? {};
    const payerId = request.auth?.uid;
    if (!payerId) throw new HttpsError('unauthenticated', 'Sign in before selecting a subscription.');
    if (!studentId) throw new HttpsError('invalid-argument', 'A student account is required.');

    let quote;
    try {
      quote = calculateSubscriptionQuote({ planId, billingPeriod, subjectCount });
    } catch (error) {
      throw new HttpsError('invalid-argument', error.message);
    }

    const db = getDb();
    const { isParent } = await assertCanManageStudentSubscription({ db, payerId, studentId });
    const payerSnapshot = await db.collection('users').doc(payerId).get();
    const payer = payerSnapshot.data();
    const email = request.auth.token?.email || payer.email;
    if (!email) throw new HttpsError('failed-precondition', 'A billing email is required.');

    const { paystackCallbackUrl: fallbackCallbackUrl } = getPaystackConfig();
    const paystackCallbackUrl = typeof callbackUrl === 'string' && callbackUrl.trim()
      ? callbackUrl.trim()
      : fallbackCallbackUrl;

    if (!paystackCallbackUrl) {
      throw new HttpsError('invalid-argument', 'callbackUrl is required when initializing payment.');
    }

    try {
      const parsedCallbackUrl = new URL(paystackCallbackUrl);
      if (!['http:', 'https:'].includes(parsedCallbackUrl.protocol)) {
        throw new Error('Unsupported callback URL protocol.');
      }
    } catch {
      throw new HttpsError('invalid-argument', 'callbackUrl must be a valid http or https URL.');
    }

    const subscriptionRef = db.collection('subscriptions').doc(studentId);
    const [currentSubscriptionSnapshot, authorizationSnapshot] = await Promise.all([
      subscriptionRef.get(),
      db.collection('subscriptionAuthorizations').doc(studentId).get(),
    ]);
    const currentSubscription = currentSubscriptionSnapshot.exists ? currentSubscriptionSnapshot.data() : null;
    const renewalDate = currentSubscription?.renewalDate?.toDate?.() ?? null;
    const renewalAttemptDate = currentSubscription?.renewalAttempt?.renewalDate?.toDate?.() ?? null;
    if (renewalDate && renewalDate <= new Date()
      && renewalAttemptDate?.getTime() === renewalDate.getTime()
      && ['processing', 'unknown'].includes(currentSubscription?.renewalAttempt?.status)) {
      throw new HttpsError('aborted', 'A renewal payment is still being verified. Please try changing plans again shortly.');
    }
    const subscriptionIsCurrent = ['circle', 'personalized'].includes(currentSubscription?.planId)
      && currentSubscription?.status === 'active'
      && renewalDate
      && renewalDate > new Date();
    const samePlan = subscriptionIsCurrent
      && currentSubscription.planId === quote.planId
      && currentSubscription.billingPeriod === quote.billingPeriod
      && Number(currentSubscription.subjectCount) === quote.subjectCount;

    const currentPendingPlan = currentSubscription?.pendingPlan ?? null;
    const pendingPlanMatches = subscriptionIsCurrent
      && currentPendingPlan?.planId === quote.planId
      && currentPendingPlan?.billingPeriod === quote.billingPeriod
      && Number(currentPendingPlan?.subjectCount) === quote.subjectCount;
    if (pendingPlanMatches) {
      return {
        scheduledChange: true,
        alreadyScheduled: true,
        quote,
        effectiveAt: renewalDate.toISOString(),
        manualPaymentRequired: currentSubscription.autoRenew !== true,
      };
    }

    if (samePlan) {
      if (currentSubscription.pendingPlanReference) {
        const batch = db.batch();
        batch.set(db.collection('payments').doc(currentSubscription.pendingPlanReference), {
          status: 'cancelled',
          cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
          cancellationReason: 'returned_to_current_plan',
        }, { merge: true });
        batch.set(subscriptionRef, {
          pendingPlan: admin.firestore.FieldValue.delete(),
          pendingPlanReference: admin.firestore.FieldValue.delete(),
          pendingPlanSetAt: admin.firestore.FieldValue.delete(),
          cancelAtPeriodEnd: false,
          autoRenew: isReusableAuthorization(authorizationSnapshot.data()),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
        batch.set(db.collection('users').doc(studentId), {
          pendingSubscriptionPlan: admin.firestore.FieldValue.delete(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
        await batch.commit();
        return { pendingChangeCancelled: true, quote, renewalDate: renewalDate.toISOString() };
      }
      if (currentSubscription.cancelAtPeriodEnd) {
        return { alreadyActive: true, renewalCancelled: true, quote, renewalDate: renewalDate.toISOString() };
      }
      return { alreadyActive: true, quote, renewalDate: renewalDate.toISOString() };
    }

    if (subscriptionIsCurrent) {
      const reference = makeReference('change', studentId);
      const pendingPlan = { ...quote, effectiveAt: renewalDate };
      const reusableAuthorization = isReusableAuthorization(authorizationSnapshot.data());
      const batch = db.batch();
      if (currentSubscription.pendingPlanReference) {
        batch.set(db.collection('payments').doc(currentSubscription.pendingPlanReference), {
          status: 'superseded',
          supersededAt: admin.firestore.FieldValue.serverTimestamp(),
          supersededBy: reference,
        }, { merge: true });
      }
      batch.set(subscriptionRef, {
        pendingPlan,
        pendingPlanReference: reference,
        pendingPlanSetAt: admin.firestore.FieldValue.serverTimestamp(),
        autoRenew: quote.planId === 'free' ? currentSubscription.autoRenew === true : reusableAuthorization,
        cancelAtPeriodEnd: quote.planId === 'free',
        manualPaymentRequired: quote.planId !== 'free' && !reusableAuthorization,
        renewalAttemptCount: 0,
        graceEndsAt: admin.firestore.FieldValue.delete(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      batch.set(db.collection('users').doc(studentId), {
        pendingSubscriptionPlan: pendingPlan,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      batch.set(db.collection('payments').doc(reference), {
        reference,
        studentId,
        payerId,
        parentId: isParent ? payerId : null,
        status: 'scheduled_change',
        amount: quote.amount,
        currency: quote.currency,
        ...quote,
        effectiveAt: renewalDate,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      await batch.commit();
      return {
        scheduledChange: true,
        quote,
        effectiveAt: renewalDate.toISOString(),
        manualPaymentRequired: quote.planId !== 'free' && !reusableAuthorization,
      };
    }

    const reference = makeReference('examifying', studentId);

    if (planId === 'free') {
      const activeFree = {
        studentId,
        status: 'active',
        ...quote,
        amount: 0,
        latestReference: reference,
        renewalDate: null,
        autoRenew: false,
        cancelAtPeriodEnd: false,
        manualPaymentRequired: false,
        renewalAttemptCount: 0,
        graceEndsAt: admin.firestore.FieldValue.delete(),
        renewalVerificationHoldUntil: admin.firestore.FieldValue.delete(),
        nextRenewalAttemptAt: admin.firestore.FieldValue.delete(),
        renewalAttempt: admin.firestore.FieldValue.delete(),
        renewalChargeLock: admin.firestore.FieldValue.delete(),
        cancellation: admin.firestore.FieldValue.delete(),
        lastChargeStatus: admin.firestore.FieldValue.delete(),
        activatedAt: admin.firestore.FieldValue.serverTimestamp(),
        pendingPlan: admin.firestore.FieldValue.delete(),
        pendingPlanReference: admin.firestore.FieldValue.delete(),
        pendingPlanSetAt: admin.firestore.FieldValue.delete(),
      };
      const batch = db.batch();
      if (currentSubscription?.pendingPlanReference) {
        batch.set(db.collection('payments').doc(currentSubscription.pendingPlanReference), {
          status: 'cancelled',
          cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
          cancellationReason: 'activated_free_plan',
        }, { merge: true });
      }
      batch.set(db.collection('payments').doc(reference), {
        reference,
        studentId,
        payerId,
        parentId: isParent ? payerId : null,
        email,
        status: 'active',
        amount: 0,
        currency: 'ZAR',
        ...quote,
        product: 'Examifying subscription',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      batch.set(subscriptionRef, activeFree, { merge: true });
      batch.set(db.collection('users').doc(studentId), {
        paymentCompleted: false,
        subscriptionStatus: 'active',
        subscriptionPlanId: 'free',
        subscriptionPlanName: 'Free',
        subscriptionBillingPeriod: quote.billingPeriod,
        subscriptionSubjectCount: 0,
        pendingSubscriptionPlan: admin.firestore.FieldValue.delete(),
        latestPaymentReference: reference,
        subscriptionRenewalDate: null,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      await batch.commit();
      return { free: true, reference, quote };
    }

    logger.info('Initializing Paystack transaction', {
      email,
      studentId,
      payerId,
      quote,
      reference,
      callbackUrl: paystackCallbackUrl,
    });

    const transaction = await paystackRequest({
      path: '/transaction/initialize',
      method: 'POST',
      payload: {
        email,
        amount: Math.round(quote.amount * 100),
        currency: 'ZAR',
        reference,
        callback_url: paystackCallbackUrl,
        metadata: {
          studentId,
          payerId,
          planId: quote.planId,
          billingPeriod: quote.billingPeriod,
          subjectCount: quote.subjectCount,
          product: 'Examifying subscription',
        },
      },
    });

    await db.collection('payments').doc(reference).set({
      reference,
      studentId,
      payerId,
      parentId: isParent ? payerId : null,
      email,
      status: 'initialized',
      amount: quote.amount,
      currency: 'ZAR',
      ...quote,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return {
      authorizationUrl: transaction.authorization_url,
      accessCode: transaction.access_code,
      reference,
      quote,
    };
  } catch (error) {
    logger.error('initializePaystackTransaction failed', error);

    if (error instanceof HttpsError) {
      throw error;
    }

    throw new HttpsError('internal', error?.message || 'Failed to initialize Paystack transaction.');
  }
});

export const manageStudentSubscription = onCall({ cpu: 'gcf_gen1' }, async (request) => {
  const payerId = request.auth?.uid;
  const { studentId, action } = request.data ?? {};
  if (!payerId) throw new HttpsError('unauthenticated', 'Sign in to manage this subscription.');
  if (!studentId || !['cancel', 'resume', 'cancel_pending_change'].includes(action)) {
    throw new HttpsError('invalid-argument', 'A student account and valid subscription action are required.');
  }

  const db = getDb();
  await assertCanManageStudentSubscription({ db, payerId, studentId });
  const subscriptionRef = db.collection('subscriptions').doc(studentId);
  const userRef = db.collection('users').doc(studentId);
  const authorizationSnapshot = await db.collection('subscriptionAuthorizations').doc(studentId).get();
  const reusableAuthorization = isReusableAuthorization(authorizationSnapshot.data());
  const now = new Date();

  const result = await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(subscriptionRef);
    if (!snapshot.exists) throw new HttpsError('failed-precondition', 'No subscription is available to manage.');
    const subscription = snapshot.data();
    const renewalDate = subscription.renewalDate?.toDate?.() ?? null;
    const graceEndsAt = subscription.graceEndsAt?.toDate?.() ?? null;
    const lockStartedAt = subscription.renewalChargeLock?.startedAt?.toDate?.() ?? null;
    if (lockStartedAt && now.getTime() - lockStartedAt.getTime() < 10 * 60 * 1000) {
      throw new HttpsError('aborted', 'A renewal charge is being processed. Please try again shortly.');
    }
    const attemptDate = subscription.renewalAttempt?.renewalDate?.toDate?.() ?? null;
    if (renewalDate && renewalDate <= now
      && attemptDate?.getTime() === renewalDate.getTime()
      && ['processing', 'unknown'].includes(subscription.renewalAttempt?.status)) {
      throw new HttpsError('aborted', 'A renewal payment is still being verified. Please try again shortly.');
    }

    const pendingReference = subscription.pendingPlanReference ?? null;
    const pendingPaymentRef = pendingReference ? db.collection('payments').doc(pendingReference) : null;
    const pendingPaymentSnapshot = pendingPaymentRef ? await transaction.get(pendingPaymentRef) : null;
    const cancelPendingPayment = () => {
      if (pendingPaymentRef && pendingPaymentSnapshot?.exists) {
        transaction.set(pendingPaymentRef, {
          status: 'cancelled',
          cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
          cancellationReason: action,
        }, { merge: true });
      }
    };

    if (action === 'cancel_pending_change') {
      if (!subscription.pendingPlan) return { action, unchanged: true };
      cancelPendingPayment();
      transaction.set(subscriptionRef, {
        pendingPlan: admin.firestore.FieldValue.delete(),
        pendingPlanReference: admin.firestore.FieldValue.delete(),
        pendingPlanSetAt: admin.firestore.FieldValue.delete(),
        cancelAtPeriodEnd: false,
        autoRenew: reusableAuthorization && ['circle', 'personalized'].includes(subscription.planId) && renewalDate > now,
        manualPaymentRequired: !reusableAuthorization && ['circle', 'personalized'].includes(subscription.planId),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      transaction.set(userRef, {
        pendingSubscriptionPlan: admin.firestore.FieldValue.delete(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      return { action, cancelled: true, renewalDate: renewalDate?.toISOString?.() ?? null };
    }

    if (action === 'resume') {
      if (!['circle', 'personalized'].includes(subscription.planId)
        || subscription.status !== 'active'
        || !renewalDate
        || renewalDate <= now) {
        throw new HttpsError('failed-precondition', 'Only a current paid subscription can be resumed.');
      }
      if (!reusableAuthorization) {
        throw new HttpsError('failed-precondition', 'A reusable payment authorization is required to resume automatic renewal.');
      }
      if (subscription.autoRenew === true && subscription.cancelAtPeriodEnd !== true) {
        return { action, unchanged: true, renewalDate: renewalDate.toISOString() };
      }
      transaction.set(subscriptionRef, {
        status: 'active',
        autoRenew: true,
        cancelAtPeriodEnd: false,
        cancellation: admin.firestore.FieldValue.delete(),
        manualPaymentRequired: false,
        graceEndsAt: admin.firestore.FieldValue.delete(),
        nextRenewalAttemptAt: admin.firestore.FieldValue.delete(),
        renewalAttempt: admin.firestore.FieldValue.delete(),
        renewalAttemptCount: 0,
        renewalChargeLock: admin.firestore.FieldValue.delete(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      transaction.set(userRef, {
        subscriptionStatus: 'active',
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      return { action, resumed: true, renewalDate: renewalDate.toISOString() };
    }

    if (subscription.cancelAtPeriodEnd === true) {
      return { action, unchanged: true, renewalDate: renewalDate?.toISOString?.() ?? null };
    }

    const activePaidPeriod = ['circle', 'personalized'].includes(subscription.planId)
      && subscription.status === 'active'
      && renewalDate
      && renewalDate > now;
    const activeGracePeriod = ['circle', 'personalized'].includes(subscription.planId)
      && subscription.status === 'past_due'
      && graceEndsAt
      && graceEndsAt > now;
    if (!activePaidPeriod && !activeGracePeriod) {
      return { action, alreadyFree: true };
    }

    cancelPendingPayment();
    if (activeGracePeriod) {
      return { action, graceEnded: true, pendingReference };
    }

    transaction.set(subscriptionRef, {
      status: 'active',
      autoRenew: false,
      cancelAtPeriodEnd: true,
      cancellation: {
        requestedAt: admin.firestore.FieldValue.serverTimestamp(),
        requestedBy: payerId,
        effectiveAt: admin.firestore.Timestamp.fromDate(renewalDate),
      },
      pendingPlan: admin.firestore.FieldValue.delete(),
      pendingPlanReference: admin.firestore.FieldValue.delete(),
      pendingPlanSetAt: admin.firestore.FieldValue.delete(),
      graceEndsAt: admin.firestore.FieldValue.delete(),
      renewalVerificationHoldUntil: admin.firestore.FieldValue.delete(),
      nextRenewalAttemptAt: admin.firestore.FieldValue.delete(),
      renewalAttempt: admin.firestore.FieldValue.delete(),
      manualPaymentRequired: false,
      renewalChargeLock: admin.firestore.FieldValue.delete(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    transaction.set(userRef, {
      subscriptionStatus: 'cancel_at_period_end',
      pendingSubscriptionPlan: admin.firestore.FieldValue.delete(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    return { action, cancelled: true, renewalDate: renewalDate.toISOString() };
  });

  if (result.graceEnded) {
    await applyFreeSubscription({
      studentId,
      pendingReference: result.pendingReference,
      pendingStatus: 'cancelled',
      reason: 'cancelled_during_renewal_grace',
    });
    return { action, cancelled: true, freeImmediately: true };
  }
  return result;
});

export const verifyPaystackTransaction = onCall({ cpu: 'gcf_gen1' }, async (request) => {
  const { reference } = request.data ?? {};
  const payerId = request.auth?.uid;
  if (!payerId) throw new HttpsError('unauthenticated', 'Sign in to verify your payment.');
  if (!reference) {
    throw new HttpsError('invalid-argument', 'reference is required.');
  }

  const db = getDb();
  const paymentRef = db.collection('payments').doc(reference);
  const paymentSnapshot = await paymentRef.get();
  if (!paymentSnapshot.exists) throw new HttpsError('not-found', 'Payment record not found.');
  const payment = paymentSnapshot.data();
  if (payment.payerId !== payerId) throw new HttpsError('permission-denied', 'This payment belongs to another account.');
  if (payment.status === 'success') return { status: 'success', reference, authorizationStored: false };
  if (!['initialized', 'pending', 'processing'].includes(payment.status) || !payment.planId || !payment.studentId) {
    throw new HttpsError('failed-precondition', 'This payment cannot be verified. Please start a new subscription checkout.');
  }

  let quote;
  try {
    quote = calculateSubscriptionQuote({
      planId: payment.planId,
      billingPeriod: payment.billingPeriod,
      subjectCount: payment.subjectCount,
    });
  } catch {
    throw new HttpsError('failed-precondition', 'The saved subscription selection is invalid.');
  }

  const transaction = await paystackRequest({
    path: `/transaction/verify/${reference}`,
    method: 'GET',
  });

  if (transaction.status === 'success' && (Number(transaction.amount) !== Math.round(quote.amount * 100) || transaction.currency !== quote.currency)) {
    await paymentRef.set({ status: 'amount_mismatch', updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    throw new HttpsError('failed-precondition', 'The verified payment does not match this subscription price.');
  }

  const authorization = transaction.authorization ?? null;
  const succeeded = transaction.status === 'success';
  const reusableAuthorization = Boolean(authorization?.authorization_code && authorization.reusable);
  const nextRenewalDate = succeeded
    ? admin.firestore.Timestamp.fromDate(new Date(Date.now() + quote.billingCycleDays * 24 * 60 * 60 * 1000))
    : null;
  const batch = db.batch();
  batch.set(paymentRef, {
    reference,
    amount: Number(transaction.amount ?? 0) / 100,
    currency: transaction.currency ?? quote.currency,
    status: transaction.status,
    gatewayResponse: transaction.gateway_response,
    paidAt: transaction.paid_at ?? null,
    channel: transaction.channel ?? null,
    studentId: payment.studentId,
    payerId,
    email: transaction.customer?.email ?? payment.email,
    ...quote,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });

  if (succeeded) {
    const subscriptionRef = db.collection('subscriptions').doc(payment.studentId);
    const currentSubscriptionSnapshot = await subscriptionRef.get();
    const currentSubscription = currentSubscriptionSnapshot.exists ? currentSubscriptionSnapshot.data() : null;
    const oldPendingReference = currentSubscription?.pendingPlanReference;
    if (oldPendingReference && oldPendingReference !== reference) {
      const oldPendingPlan = currentSubscription?.pendingPlan;
      const pendingWasApplied = oldPendingPlan?.planId === quote.planId
        && oldPendingPlan?.billingPeriod === quote.billingPeriod
        && Number(oldPendingPlan?.subjectCount) === Number(quote.subjectCount);
      batch.set(db.collection('payments').doc(oldPendingReference), {
        status: pendingWasApplied ? 'applied' : 'cancelled',
        ...(pendingWasApplied ? { appliedAt: admin.firestore.FieldValue.serverTimestamp() } : { cancelledAt: admin.firestore.FieldValue.serverTimestamp() }),
      }, { merge: true });
    }
    if (reusableAuthorization) {
      batch.set(db.collection('subscriptionAuthorizations').doc(payment.studentId), {
        studentId: payment.studentId,
        payerId,
        email: transaction.customer?.email ?? payment.email,
        authorizationCode: authorization.authorization_code,
        bin: authorization.bin ?? null,
        last4: authorization.last4 ?? null,
        expMonth: authorization.exp_month ?? null,
        expYear: authorization.exp_year ?? null,
        cardType: authorization.card_type ?? null,
        bank: authorization.bank ?? null,
        reusable: authorization.reusable,
        signature: authorization.signature ?? null,
        storedAt: admin.firestore.FieldValue.serverTimestamp(),
        reference,
      }, { merge: true });
    } else {
      batch.delete(db.collection('subscriptionAuthorizations').doc(payment.studentId));
    }

    batch.set(subscriptionRef, {
      studentId: payment.studentId,
      status: 'active',
      ...quote,
      amount: quote.amount,
      latestReference: reference,
      renewedAt: admin.firestore.FieldValue.serverTimestamp(),
      renewalDate: nextRenewalDate,
      autoRenew: reusableAuthorization,
      cancelAtPeriodEnd: false,
      manualPaymentRequired: !reusableAuthorization,
      renewalAttemptCount: 0,
      graceEndsAt: admin.firestore.FieldValue.delete(),
      renewalVerificationHoldUntil: admin.firestore.FieldValue.delete(),
      nextRenewalAttemptAt: admin.firestore.FieldValue.delete(),
      renewalAttempt: admin.firestore.FieldValue.delete(),
      renewalChargeLock: admin.firestore.FieldValue.delete(),
      pendingPlan: admin.firestore.FieldValue.delete(),
      pendingPlanReference: admin.firestore.FieldValue.delete(),
      pendingPlanSetAt: admin.firestore.FieldValue.delete(),
      cancellation: admin.firestore.FieldValue.delete(),
    }, { merge: true });

    batch.set(db.collection('users').doc(payment.studentId), {
      paymentCompleted: true,
      subscriptionStatus: 'active',
      subscriptionPlanId: quote.planId,
      subscriptionPlanName: quote.planName,
      subscriptionBillingPeriod: quote.billingPeriod,
      subscriptionSubjectCount: quote.subjectCount,
      latestPaymentReference: reference,
      subscriptionRenewalDate: nextRenewalDate,
      pendingSubscriptionPlan: admin.firestore.FieldValue.delete(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
  }

  await batch.commit();

  return {
    status: transaction.status,
    reference,
    authorizationStored: reusableAuthorization,
  };
});

export const chargeAuthorizationForSubscription = async ({
  studentId,
  email,
  amount,
  authorizationCode,
  subscriptionQuote,
  renewalDate,
  payerId = null,
  pendingPlanReference = null,
  attemptNumber = null,
  reference: requestedReference = null,
}) => {
  const db = getDb();
  const subscriptionRef = db.collection('subscriptions').doc(studentId);
  const dueDate = renewalDate?.toDate?.() ?? (renewalDate instanceof Date ? renewalDate : null);
  if (!dueDate || !subscriptionQuote || !payerId) {
    throw new HttpsError('failed-precondition', 'The subscription renewal data is incomplete.');
  }

  const claim = await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(subscriptionRef);
    if (!snapshot.exists) return { claimed: false, reason: 'subscription_missing' };

    const current = snapshot.data();
    const currentDueDate = current.renewalDate?.toDate?.();
    const existingAttempt = current.renewalAttempt;
    const existingAttemptDate = existingAttempt?.renewalDate?.toDate?.();
    const canResumeAttempt = existingAttemptDate?.getTime() === dueDate.getTime()
      && ['processing', 'unknown'].includes(existingAttempt?.status);
    if (!['active', 'past_due'].includes(current.status) || (current.autoRenew !== true && !canResumeAttempt) || !currentDueDate
      || currentDueDate.getTime() !== dueDate.getTime() || currentDueDate > new Date()) {
      return { claimed: false, reason: 'not_due' };
    }

    if (canResumeAttempt) {
      if (existingAttempt.planId && (existingAttempt.planId !== subscriptionQuote.planId
        || existingAttempt.billingPeriod !== subscriptionQuote.billingPeriod
        || Number(existingAttempt.subjectCount) !== Number(subscriptionQuote.subjectCount))) {
        return { claimed: false, reason: 'attempt_selection_changed' };
      }
    } else {
      const currentSelection = current.pendingPlan?.planId ? current.pendingPlan : current;
      if (current.pendingPlan?.planId === 'free'
        || current.cancelAtPeriodEnd === true
        || currentSelection.planId !== subscriptionQuote.planId
        || currentSelection.billingPeriod !== subscriptionQuote.billingPeriod
        || Number(currentSelection.subjectCount) !== Number(subscriptionQuote.subjectCount)
        || (current.pendingPlanReference ?? null) !== (pendingPlanReference ?? null)) {
        return { claimed: false, reason: 'subscription_selection_changed' };
      }
      if (!email || !authorizationCode) return { claimed: false, reason: 'authorization_missing' };
    }

    const nextAttemptAt = current.nextRenewalAttemptAt?.toDate?.();
    if (current.status === 'past_due' && !canResumeAttempt && nextAttemptAt && nextAttemptAt > new Date()) {
      return { claimed: false, reason: 'retry_not_due' };
    }
    const effectiveAttemptNumber = canResumeAttempt
      ? Number(existingAttempt.attemptNumber)
      : (Number(attemptNumber) || Number(current.renewalAttemptCount) + 1);
    if (effectiveAttemptNumber > 3) return { claimed: false, reason: 'attempts_exhausted' };
    const reference = canResumeAttempt
      ? existingAttempt.reference
      : (requestedReference || `renewal-${studentId}-${dueDate.getTime()}-${effectiveAttemptNumber}-${randomUUID().slice(0, 8)}`);

    const existingLock = current.renewalChargeLock;
    const lockDate = existingLock?.renewalDate?.toDate?.();
    const lockStartedAt = existingLock?.startedAt?.toDate?.();
    const lockIsFresh = lockDate?.getTime() === dueDate.getTime()
      && lockStartedAt
      && Date.now() - lockStartedAt.getTime() < 10 * 60 * 1000;
    if (lockIsFresh) return { claimed: false, reason: 'in_progress' };

    const startedAt = existingAttempt?.startedAt ?? admin.firestore.Timestamp.now();
    transaction.set(subscriptionRef, {
      renewalChargeLock: {
        renewalDate: current.renewalDate,
        startedAt: admin.firestore.Timestamp.now(),
      },
      renewalAttempt: {
        reference,
        attemptNumber: effectiveAttemptNumber,
        renewalDate: current.renewalDate,
        status: 'processing',
        startedAt,
        payerId: canResumeAttempt ? existingAttempt.payerId || payerId : payerId,
        email: canResumeAttempt ? existingAttempt.email || email : email,
        planId: subscriptionQuote.planId,
        planName: subscriptionQuote.planName,
        billingPeriod: subscriptionQuote.billingPeriod,
        subjectCount: subscriptionQuote.subjectCount,
        amount: subscriptionQuote.amount,
        currency: subscriptionQuote.currency,
        pendingPlanReference: canResumeAttempt
          ? (existingAttempt.pendingPlanReference ?? null)
          : (pendingPlanReference ?? null),
      },
      renewalAttemptCount: Math.max(Number(current.renewalAttemptCount) || 0, effectiveAttemptNumber),
    }, { merge: true });
    return {
      claimed: true,
      reference,
      attemptNumber: effectiveAttemptNumber,
      resumeAttempt: canResumeAttempt,
      startedAt,
      payerId: canResumeAttempt ? existingAttempt.payerId || payerId : payerId,
      email: canResumeAttempt ? existingAttempt.email || email : email,
      pendingPlanReference: canResumeAttempt
        ? (existingAttempt.pendingPlanReference ?? null)
        : (pendingPlanReference ?? null),
    };
  });

  if (!claim.claimed) return { succeeded: false, skipped: true, reason: claim.reason };

  try {
    let charge = null;
    if (claim.resumeAttempt) {
      try {
        charge = await paystackRequest({ path: `/transaction/verify/${claim.reference}`, method: 'GET' });
      } catch (error) {
        logger.info('Renewal verification is not conclusive yet', {
          studentId,
          reference: claim.reference,
          error: error?.message ?? String(error),
        });
        charge = { reference: claim.reference, status: 'processing', gateway_response: 'Awaiting charge verification' };
      }
    } else {
      try {
        charge = await paystackRequest({
          path: '/transaction/charge_authorization',
          method: 'POST',
          payload: {
            email: claim.email,
            amount: Math.round(amount * 100),
            authorization_code: authorizationCode,
            reference: claim.reference,
            currency: subscriptionQuote.currency,
            metadata: {
              planId: subscriptionQuote.planId,
              planName: subscriptionQuote.planName,
              billingPeriod: subscriptionQuote.billingPeriod,
              subjectCount: subscriptionQuote.subjectCount,
              sessionsPerMonth: subscriptionQuote.sessionsPerMonth,
              studentId,
              product: 'Examifying subscription',
              recurring: true,
              attemptNumber: claim.attemptNumber,
            },
          },
        });
      } catch (chargeError) {
        try {
          charge = await paystackRequest({ path: `/transaction/verify/${claim.reference}`, method: 'GET' });
        } catch {
          logger.warn('Could not confirm subscription renewal charge outcome', {
            studentId,
            reference: claim.reference,
            error: chargeError?.message ?? String(chargeError),
          });
          charge = { reference: claim.reference, status: 'processing', gateway_response: 'Awaiting charge verification' };
        }
      }
    }

    const chargeSucceeded = charge.status === 'success';
    const amountMismatch = chargeSucceeded
      && (Number(charge.amount) !== Math.round(amount * 100) || charge.currency !== subscriptionQuote.currency);
    const succeeded = chargeSucceeded && !amountMismatch;
    const definitiveFailure = ['failed', 'abandoned', 'reversed'].includes(charge.status);
    const outcomeUnknown = !chargeSucceeded && !definitiveFailure;
    const retryCount = claim.attemptNumber;
    const now = new Date();
    const nextAttemptDate = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const graceEndsDate = new Date(dueDate.getTime() + 3 * 24 * 60 * 60 * 1000);
    const retryAllowed = !amountMismatch && !outcomeUnknown && retryCount < 3 && now < graceEndsDate;
    const nextRenewalDate = succeeded ? admin.firestore.Timestamp.fromDate(
      new Date(Date.now() + subscriptionQuote.billingCycleDays * 24 * 60 * 60 * 1000)
    ) : null;
    const batch = db.batch();
    batch.set(db.collection('payments').doc(claim.reference), {
      reference: claim.reference,
      studentId,
      payerId: claim.payerId,
      parentId: claim.payerId === studentId ? null : claim.payerId,
      email: claim.email,
      amount: Number(charge.amount ?? Math.round(amount * 100)) / 100,
      currency: charge.currency ?? subscriptionQuote.currency,
      status: amountMismatch ? 'amount_mismatch' : succeeded ? 'success' : outcomeUnknown ? 'processing' : (charge.status || 'failed'),
      recurring: true,
      attemptNumber: claim.attemptNumber,
      gatewayResponse: charge.gateway_response ?? null,
      paidAt: charge.paid_at ?? null,
      ...subscriptionQuote,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      ...(claim.resumeAttempt ? {} : { createdAt: admin.firestore.FieldValue.serverTimestamp() }),
    }, { merge: true });

    if (succeeded) {
      batch.set(subscriptionRef, {
        studentId,
        status: 'active',
        ...subscriptionQuote,
        latestReference: claim.reference,
        amount,
        currency: subscriptionQuote.currency,
        renewedAt: admin.firestore.FieldValue.serverTimestamp(),
        renewalDate: nextRenewalDate,
        autoRenew: true,
        cancelAtPeriodEnd: false,
        manualPaymentRequired: false,
        renewalAttemptCount: 0,
        graceEndsAt: admin.firestore.FieldValue.delete(),
        renewalVerificationHoldUntil: admin.firestore.FieldValue.delete(),
        nextRenewalAttemptAt: admin.firestore.FieldValue.delete(),
        renewalAttempt: admin.firestore.FieldValue.delete(),
        renewalChargeLock: admin.firestore.FieldValue.delete(),
        pendingPlan: admin.firestore.FieldValue.delete(),
        pendingPlanReference: admin.firestore.FieldValue.delete(),
        pendingPlanSetAt: admin.firestore.FieldValue.delete(),
        cancellation: admin.firestore.FieldValue.delete(),
        lastChargeStatus: 'success',
        lastChargeAttemptAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      if (claim.pendingPlanReference) {
        batch.set(db.collection('payments').doc(claim.pendingPlanReference), {
          status: 'applied',
          appliedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
      }
      batch.set(db.collection('users').doc(studentId), {
        paymentCompleted: true,
        subscriptionStatus: 'active',
        subscriptionPlanId: subscriptionQuote.planId,
        subscriptionPlanName: subscriptionQuote.planName,
        subscriptionBillingPeriod: subscriptionQuote.billingPeriod,
        subscriptionSubjectCount: subscriptionQuote.subjectCount,
        latestPaymentReference: claim.reference,
        subscriptionRenewalDate: nextRenewalDate,
        pendingSubscriptionPlan: admin.firestore.FieldValue.delete(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    } else {
      batch.set(subscriptionRef, {
        status: 'past_due',
        autoRenew: retryAllowed,
        manualPaymentRequired: !retryAllowed,
        renewalAttemptCount: claim.attemptNumber,
        graceEndsAt: admin.firestore.Timestamp.fromDate(graceEndsDate),
        renewalVerificationHoldUntil: admin.firestore.FieldValue.delete(),
        nextRenewalAttemptAt: retryAllowed
          ? admin.firestore.Timestamp.fromDate(nextAttemptDate)
          : outcomeUnknown
            ? admin.firestore.Timestamp.fromDate(nextAttemptDate)
          : admin.firestore.FieldValue.delete(),
        renewalAttempt: {
          reference: claim.reference,
          attemptNumber: claim.attemptNumber,
          renewalDate: admin.firestore.Timestamp.fromDate(dueDate),
          status: outcomeUnknown ? 'unknown' : amountMismatch ? 'amount_mismatch' : 'failed',
          startedAt: claim.startedAt,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          payerId: claim.payerId,
          email: claim.email,
          planId: subscriptionQuote.planId,
          planName: subscriptionQuote.planName,
          billingPeriod: subscriptionQuote.billingPeriod,
          subjectCount: subscriptionQuote.subjectCount,
          amount: subscriptionQuote.amount,
          currency: subscriptionQuote.currency,
          pendingPlanReference: claim.pendingPlanReference,
        },
        renewalChargeLock: admin.firestore.FieldValue.delete(),
        lastChargeStatus: amountMismatch ? 'amount_mismatch' : outcomeUnknown ? 'verification_pending' : (charge.status || 'failed'),
        lastChargeAttemptAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      batch.set(db.collection('users').doc(studentId), {
        paymentCompleted: false,
        subscriptionStatus: 'past_due',
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    }

    await batch.commit();

    return { charge, succeeded, processing: outcomeUnknown, amountMismatch, nextRenewalDate, reference: claim.reference };
  } catch (error) {
    await subscriptionRef.set({
      renewalChargeLock: admin.firestore.FieldValue.delete(),
    }, { merge: true }).catch((releaseError) => {
      logger.error('Could not release subscription renewal lock', { studentId, error: releaseError?.message });
    });
    throw error;
  }
};

export const chargeStoredAuthorization = onCall(async (request) => {
  const payerId = request.auth?.uid;
  const { studentId } = request.data ?? {};
  if (!payerId) throw new HttpsError('unauthenticated', 'Sign in before requesting a renewal charge.');
  if (!studentId) throw new HttpsError('invalid-argument', 'studentId is required.');

  const db = getDb();
  const [payerSnapshot, studentSnapshot, subscriptionSnapshot, authSnapshot] = await Promise.all([
    db.collection('users').doc(payerId).get(),
    db.collection('users').doc(studentId).get(),
    db.collection('subscriptions').doc(studentId).get(),
    db.collection('subscriptionAuthorizations').doc(studentId).get(),
  ]);
  if (!payerSnapshot.exists || !studentSnapshot.exists || studentSnapshot.data().role !== 'student') {
    throw new HttpsError('not-found', 'The student subscription was not found.');
  }

  await assertCanManageStudentSubscription({ db, payerId, studentId });
  if (!subscriptionSnapshot.exists) throw new HttpsError('failed-precondition', 'No active subscription is due for renewal.');

  const subscription = subscriptionSnapshot.data();
  const dueDate = subscription.renewalDate?.toDate?.() ?? null;
  const attemptDate = subscription.renewalAttempt?.renewalDate?.toDate?.() ?? null;
  const inFlightAttempt = ['processing', 'unknown'].includes(subscription.renewalAttempt?.status)
    && attemptDate?.getTime() === dueDate?.getTime();
  if (!inFlightAttempt && (subscription.pendingPlan?.planId === 'free' || subscription.cancelAtPeriodEnd === true)) {
    return { status: 'scheduled_free_change', charged: false };
  }
  if (!['active', 'past_due'].includes(subscription.status)
    || (subscription.autoRenew !== true && !inFlightAttempt)
    || !dueDate
    || dueDate > new Date()) {
    throw new HttpsError('failed-precondition', 'No automatic renewal is due yet.');
  }
  const nextAttemptAt = subscription.nextRenewalAttemptAt?.toDate?.();
  if (nextAttemptAt && nextAttemptAt > new Date() && !inFlightAttempt) {
    throw new HttpsError('failed-precondition', 'The next retry is not due yet.');
  }
  if ((Number(subscription.renewalAttemptCount) || 0) >= 3 && !inFlightAttempt) {
    throw new HttpsError('failed-precondition', 'Automatic retry attempts are complete. Please choose a plan and pay to continue.');
  }
  const authorization = authSnapshot.exists ? authSnapshot.data() : null;
  if (!inFlightAttempt && (!authorization || authorization.reusable !== true || !authorization.authorizationCode || !authorization.email)) {
    throw new HttpsError('failed-precondition', 'A reusable payment authorization is required for renewal.');
  }

  const selectedPlan = inFlightAttempt && subscription.renewalAttempt.planId
    ? subscription.renewalAttempt
    : subscription.pendingPlan?.planId ? subscription.pendingPlan : subscription;
  let subscriptionQuote;
  try {
    subscriptionQuote = calculateSubscriptionQuote({
      planId: selectedPlan.planId,
      billingPeriod: selectedPlan.billingPeriod,
      subjectCount: selectedPlan.subjectCount,
    });
  } catch {
    throw new HttpsError('failed-precondition', 'The saved subscription selection cannot be renewed.');
  }

  const result = await chargeAuthorizationForSubscription({
    studentId,
    payerId: subscription.renewalAttempt?.payerId || authorization?.payerId || payerId,
    email: authorization?.email || subscription.renewalAttempt?.email || '',
    amount: subscriptionQuote.amount,
    authorizationCode: authorization?.authorizationCode || '',
    subscriptionQuote,
    renewalDate: subscription.renewalDate,
    pendingPlanReference: inFlightAttempt
      ? subscription.renewalAttempt?.pendingPlanReference ?? null
      : subscription.pendingPlanReference,
    attemptNumber: inFlightAttempt ? Number(subscription.renewalAttempt?.attemptNumber) : (Number(subscription.renewalAttemptCount) || 0) + 1,
  });

  return result.skipped
    ? { status: result.reason === 'in_progress' ? 'processing' : 'not_due', charged: false }
    : {
      status: result.succeeded ? 'success' : result.processing ? 'processing' : result.amountMismatch ? 'amount_mismatch' : 'past_due',
      reference: result.reference,
      charged: result.succeeded,
      retryScheduled: !result.succeeded && !result.amountMismatch && !result.processing,
      planId: subscriptionQuote.planId,
      planName: subscriptionQuote.planName,
      renewalDate: result.nextRenewalDate?.toDate?.().toISOString() ?? null,
    };
});
