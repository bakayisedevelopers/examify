import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions';
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

export const initializePaystackTransaction = onCall(async (request) => {
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
    const currentSubscriptionSnapshot = await subscriptionRef.get();
    const currentSubscription = currentSubscriptionSnapshot.exists ? currentSubscriptionSnapshot.data() : null;
    const renewalDate = currentSubscription?.renewalDate?.toDate?.() ?? null;
    const subscriptionIsCurrent = currentSubscription?.status === 'active' && renewalDate && renewalDate > new Date();
    const samePlan = subscriptionIsCurrent
      && currentSubscription.planId === quote.planId
      && currentSubscription.billingPeriod === quote.billingPeriod
      && Number(currentSubscription.subjectCount) === quote.subjectCount;

    if (samePlan) return { alreadyActive: true, quote, renewalDate: renewalDate.toISOString() };

    if (subscriptionIsCurrent) {
      const reference = `change-${studentId}-${Date.now()}`;
      const pendingPlan = { ...quote, effectiveAt: renewalDate };
      await Promise.all([
        subscriptionRef.set({
          pendingPlan,
          pendingPlanReference: reference,
          pendingPlanSetAt: admin.firestore.FieldValue.serverTimestamp(),
          autoRenew: true,
        }, { merge: true }),
        db.collection('users').doc(studentId).set({
          pendingSubscriptionPlan: pendingPlan,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true }),
        db.collection('payments').doc(reference).set({
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
        }),
      ]);
      return { scheduledChange: true, quote, effectiveAt: renewalDate.toISOString() };
    }

    const reference = `examifying-${studentId}-${Date.now()}`;

    if (planId === 'free') {
      const activeFree = {
        studentId,
        status: 'active',
        ...quote,
        amount: 0,
        latestReference: reference,
        renewalDate: null,
        autoRenew: false,
        activatedAt: admin.firestore.FieldValue.serverTimestamp(),
        pendingPlan: admin.firestore.FieldValue.delete(),
        pendingPlanReference: admin.firestore.FieldValue.delete(),
      };
      const batch = db.batch();
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

export const verifyPaystackTransaction = onCall(async (request) => {
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
    }

    batch.set(db.collection('subscriptions').doc(payment.studentId), {
      studentId: payment.studentId,
      status: 'active',
      ...quote,
      amount: quote.amount,
      latestReference: reference,
      renewedAt: admin.firestore.FieldValue.serverTimestamp(),
      renewalDate: nextRenewalDate,
      autoRenew: reusableAuthorization,
      pendingPlan: admin.firestore.FieldValue.delete(),
      pendingPlanReference: admin.firestore.FieldValue.delete(),
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
}) => {
  const db = getDb();

  const charge = await paystackRequest({
    path: '/transaction/charge_authorization',
    method: 'POST',
    payload: {
      email,
      amount: Math.round(amount * 100),
      authorization_code: authorizationCode,
      metadata: {
        planId: subscriptionQuote.planId,
        planName: subscriptionQuote.planName,
        billingPeriod: subscriptionQuote.billingPeriod,
        subjectCount: subscriptionQuote.subjectCount,
        sessionsPerMonth: subscriptionQuote.sessionsPerMonth,
        studentId,
        product: 'Examifying subscription',
        recurring: true,
      },
    },
  });

  const succeeded = charge.status === 'success';

  const nextRenewalDate = admin.firestore.Timestamp.fromDate(
    new Date(Date.now() + subscriptionQuote.billingCycleDays * 24 * 60 * 60 * 1000)
  );

  await db.collection('payments').doc(charge.reference).set(
    {
      reference: charge.reference,
      studentId,
      email,
      amount,
      currency: 'ZAR',
      status: charge.status ?? 'processing',
      recurring: true,
      ...subscriptionQuote,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  await db.collection('subscriptions').doc(studentId).set(
    {
      studentId,
      status: succeeded ? 'active' : 'past_due',
      ...subscriptionQuote,
      latestReference: charge.reference,
      amount,
      currency: 'ZAR',
      renewedAt: succeeded ? admin.firestore.FieldValue.serverTimestamp() : null,
      renewalDate: succeeded ? nextRenewalDate : admin.firestore.FieldValue.delete(),
      lastChargeStatus: charge.status ?? 'processing',
      lastChargeAttemptAt: admin.firestore.FieldValue.serverTimestamp(),
      autoRenew: succeeded,
      pendingPlan: admin.firestore.FieldValue.delete(),
      pendingPlanReference: admin.firestore.FieldValue.delete(),
    },
    { merge: true }
  );

  const userPatch = {
    paymentCompleted: succeeded,
    subscriptionStatus: succeeded ? 'active' : 'past_due',
    subscriptionPlanId: succeeded ? subscriptionQuote.planId : admin.firestore.FieldValue.delete(),
    subscriptionPlanName: succeeded ? subscriptionQuote.planName : admin.firestore.FieldValue.delete(),
    subscriptionBillingPeriod: succeeded ? subscriptionQuote.billingPeriod : admin.firestore.FieldValue.delete(),
    subscriptionSubjectCount: succeeded ? subscriptionQuote.subjectCount : admin.firestore.FieldValue.delete(),
    latestPaymentReference: charge.reference,
    subscriptionRenewalDate: succeeded ? nextRenewalDate : null,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  if (succeeded) userPatch.pendingSubscriptionPlan = admin.firestore.FieldValue.delete();
  await db.collection('users').doc(studentId).set(userPatch, { merge: true });

  return { charge, succeeded, nextRenewalDate };
};
