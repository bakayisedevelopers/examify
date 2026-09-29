import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions';
import { getDb, admin } from './admin.js';
import { getPaystackConfig } from './config.js';

const sessionPricing = {
  online: 220,
  inPerson: 250,
};

const getRecommendedSessionCount = (latestMark = 0) => {
  if (latestMark < 70) return 4;
  return 2;
};

const calculateSubscriptionQuote = ({ latestMark = 0, sessionType = 'online' }) => {
  const sessionCount = getRecommendedSessionCount(latestMark);
  const unitPrice = sessionPricing[sessionType] ?? sessionPricing.online;

  return {
    latestMark,
    sessionType,
    sessionCount,
    unitPrice,
    amount: Number((sessionCount * unitPrice).toFixed(2)),
  };
};

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
    const { email, studentId, latestMark, sessionType, studentIds, callbackUrl } = request.data ?? {};

    if (!email || (!studentId && (!studentIds || studentIds.length === 0))) {
      throw new HttpsError('invalid-argument', 'email and either studentId or studentIds are required.');
    }

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

    const db = getDb();
    let totalAmount = 0;
    
    // For single student
    let quote = null;
    if (studentId) {
      quote = calculateSubscriptionQuote({ latestMark, sessionType });
      totalAmount = quote.amount;
    } 
    // For bulk students
    else if (studentIds && studentIds.length > 0) {
      for (const s of studentIds) {
        totalAmount += calculateSubscriptionQuote({ latestMark: s.latestMark, sessionType: s.sessionType }).amount;
      }
    }

    const reference = `examifying-${studentId || 'bulk'}-${Date.now()}`;

    logger.info('Initializing Paystack transaction', {
      email,
      studentId,
      studentIds,
      reference,
      callbackUrl: paystackCallbackUrl,
      amount: totalAmount,
    });

    const transaction = await paystackRequest({
      path: '/transaction/initialize',
      method: 'POST',
      payload: {
        email,
        amount: Math.round(totalAmount * 100),
        currency: 'ZAR',
        reference,
        callback_url: paystackCallbackUrl,
        metadata: {
          studentId: studentId || null,
          studentIds: studentIds ? JSON.stringify(studentIds.map(s => s.id)) : null,
          product: 'Examifying subscription',
        },
      },
    });

    await db.collection('payments').doc(reference).set({
      reference,
      studentId: studentId || null,
      email,
      amount: totalAmount,
      currency: 'ZAR',
      status: 'initialized',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return {
      authorizationUrl: transaction.authorization_url,
      accessCode: transaction.access_code,
      reference,
      quote: quote || { amount: totalAmount },
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

  if (!reference) {
    throw new HttpsError('invalid-argument', 'reference is required.');
  }

  const db = getDb();

  const transaction = await paystackRequest({
    path: `/transaction/verify/${reference}`,
    method: 'GET',
  });

  const authorization = transaction.authorization ?? null;
  const metadata = transaction.metadata ?? {};

  await db.collection('payments').doc(reference).set(
    {
      reference,
      amount: transaction.amount / 100,
      currency: transaction.currency,
      status: transaction.status,
      gatewayResponse: transaction.gateway_response,
      paidAt: transaction.paid_at,
      channel: transaction.channel,
      studentId: metadata.studentId ?? null,
      email: transaction.customer?.email ?? null,
      metadata,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  let targetStudents = [];
  if (metadata.studentId) targetStudents.push(metadata.studentId);
  if (metadata.studentIds) {
    try {
      const parsedIds = JSON.parse(metadata.studentIds);
      if (Array.isArray(parsedIds)) {
        targetStudents = [...new Set([...targetStudents, ...parsedIds])];
      }
    } catch (error) {
      logger.warn('Failed to parse Paystack studentIds metadata', { error });
    }
  }

  if (authorization?.authorization_code && targetStudents.length > 0) {
    const nextRenewalDate = admin.firestore.Timestamp.fromDate(
      new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
    );

    for (const sId of targetStudents) {
      await db.collection('subscriptionAuthorizations').doc(sId).set(
        {
          studentId: sId,
          email: transaction.customer?.email ?? null,
          authorizationCode: authorization.authorization_code,
          bin: authorization.bin,
          last4: authorization.last4,
          expMonth: authorization.exp_month,
          expYear: authorization.exp_year,
          cardType: authorization.card_type,
          bank: authorization.bank,
          reusable: authorization.reusable,
          signature: authorization.signature,
          storedAt: admin.firestore.FieldValue.serverTimestamp(),
          reference,
        },
        { merge: true }
      );

      await db.collection('subscriptions').doc(sId).set(
        {
          studentId: sId,
          status: transaction.status === 'success' ? 'active' : 'pending',
          currency: transaction.currency,
          latestReference: reference,
          renewedAt: admin.firestore.FieldValue.serverTimestamp(),
          renewalDate: transaction.status === 'success' ? nextRenewalDate : null,
          billingCycleDays: 30,
          autoRenew: true,
        },
        { merge: true }
      );

      await db.collection('users').doc(sId).set(
        {
          paymentCompleted: transaction.status === 'success',
          subscriptionStatus: transaction.status === 'success' ? 'active' : 'pending',
          latestPaymentReference: reference,
          subscriptionRenewalDate: transaction.status === 'success' ? nextRenewalDate : null,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    }
  }

  return {
    status: transaction.status,
    reference,
    authorizationStored: Boolean(authorization?.authorization_code),
  };
});

export const chargeAuthorizationForSubscription = async ({
  studentId,
  email,
  amount,
  authorizationCode,
  metadata = {},
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
        ...metadata,
        studentId,
        product: 'Examifying subscription',
        recurring: true,
      },
    },
  });

  const succeeded = charge.status === 'success';

  const nextRenewalDate = admin.firestore.Timestamp.fromDate(
    new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
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
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  await db.collection('subscriptions').doc(studentId).set(
    {
      studentId,
      status: succeeded ? 'active' : 'past_due',
      latestReference: charge.reference,
      amount,
      currency: 'ZAR',
      renewedAt: succeeded ? admin.firestore.FieldValue.serverTimestamp() : null,
      renewalDate: succeeded ? nextRenewalDate : admin.firestore.FieldValue.delete(),
      lastChargeStatus: charge.status ?? 'processing',
      lastChargeAttemptAt: admin.firestore.FieldValue.serverTimestamp(),
      autoRenew: true,
    },
    { merge: true }
  );

  await db.collection('users').doc(studentId).set(
    {
      paymentCompleted: succeeded,
      subscriptionStatus: succeeded ? 'active' : 'past_due',
      latestPaymentReference: charge.reference,
      subscriptionRenewalDate: succeeded ? nextRenewalDate : null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  return { charge, succeeded, nextRenewalDate };
};

export const chargeStoredAuthorization = onCall(async (request) => {
  const { studentId, email, amount, authorizationCode, metadata = {} } = request.data ?? {};

  if (!studentId || !email || !amount || !authorizationCode) {
    throw new HttpsError(
      'invalid-argument',
      'studentId, email, amount, and authorizationCode are required.'
    );
  }

  const result = await chargeAuthorizationForSubscription({
    studentId,
    email,
    amount,
    authorizationCode,
    metadata,
  });

  return {
    ...result.charge,
    nextRenewalDate: result.succeeded ? result.nextRenewalDate.toDate().toISOString() : null,
  };
});
