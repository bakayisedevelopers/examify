import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { logger } from 'firebase-functions';
import { admin, getDb } from './admin.js';
import { getPaystackConfig } from './config.js';
import { calculateSubscriptionQuote } from './subscriptionPricing.js';
import { queueBrandedEmail } from './resendEmail.js';
import { isNotificationChannelEnabled } from './notificationPreferences.js';
import {
  calculateDiscount,
  generateDiscountCode,
  getDiscountBillingPeriodError,
  getDiscountEligibilityError,
  getDiscountUseCounts,
  normalizeDiscountCode,
  transitionRedemption,
  validateDiscountSettings,
} from './discountCodesCore.js';

const discountCodes = (db) => db.collection('discountCodes');
const subscriptionRef = (db, studentId) => db.collection('users').doc(studentId).collection('subscriptions').doc('current');
const redemptionRef = (db, code, reference) => discountCodes(db).doc(code).collection('redemptions').doc(reference);

const findProfileForRestrictedEmail = async (db, email) => {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const normalizedMatch = await db.collection('users').where('emailLowercase', '==', normalizedEmail).limit(1).get();
  if (!normalizedMatch.empty) return normalizedMatch.docs[0].data();
  const legacyMatch = await db.collection('users').where('email', '==', normalizedEmail).limit(1).get();
  return legacyMatch.empty ? null : legacyMatch.docs[0].data();
};

const requireAdmin = async (db, uid) => {
  const actor = await db.collection('users').doc(uid).get();
  if (!actor.exists || actor.data()?.role !== 'admin') {
    throw new HttpsError('permission-denied', 'Only an admin can manage discount codes.');
  }
};

const requireSubscriptionManager = async ({ db, payerId, studentId }) => {
  const [payerSnapshot, studentSnapshot] = await Promise.all([
    db.collection('users').doc(payerId).get(),
    db.collection('users').doc(studentId).get(),
  ]);
  if (!payerSnapshot.exists || !studentSnapshot.exists || studentSnapshot.data()?.role !== 'student') {
    throw new HttpsError('not-found', 'The student account was not found.');
  }
  const payer = payerSnapshot.data();
  const student = studentSnapshot.data();
  const allowed = (payerId === studentId && payer.role === 'student')
    || (payer.role === 'parent' && student.parentId === payerId);
  if (!allowed) throw new HttpsError('permission-denied', 'Only the student or their linked parent can use a discount code for this subscription.');
  return { payer, student };
};

const toMillis = (value) => value?.toMillis?.() ?? (value instanceof Date ? value.getTime() : null);

const getCodeStatus = (code, now = Date.now()) => {
  if (!code.active) return 'Deactivated';
  if (toMillis(code.startsAt) > now) return 'Scheduled';
  if (code.expiresAt && toMillis(code.expiresAt) <= now) return 'Expired';
  if (code.maxRedemptions !== null && code.maxRedemptions !== undefined
    && Number(code.successfulRedemptions || 0) + Number(code.reservedRedemptions || 0) >= Number(code.maxRedemptions)) return 'Exhausted';
  return 'Active';
};

const publicCodeQuote = ({ code, quote }) => {
  const discount = calculateDiscount(quote.amount, code.percentOff);
  return {
    code: code.code,
    percentOff: code.percentOff,
    eligiblePlans: Array.isArray(code.eligiblePlans) ? code.eligiblePlans : ['circle', 'personalized'],
    maxSubjectCount: code.maxSubjectCount ?? null,
    billingDuration: code.billingDuration || 'recurring',
    discountDurationMonths: code.discountDurationMonths ?? null,
    ...quote,
    originalAmount: discount.originalAmount,
    discountAmount: discount.discountAmount,
    finalAmount: discount.finalAmount,
    currency: quote.currency || 'ZAR',
  };
};

export const createDiscountCode = onCall({ cpu: 'gcf_gen1' }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in as an admin to create a discount code.');
  const db = getDb();
  await requireAdmin(db, uid);

  let settings;
  try {
    settings = validateDiscountSettings(request.data ?? {});
  } catch (error) {
    throw new HttpsError('invalid-argument', error.message);
  }
  if (settings.restrictedAccountId) {
    const restrictedAccount = await db.collection('users').doc(settings.restrictedAccountId).get();
    if (!restrictedAccount.exists) throw new HttpsError('not-found', 'The restricted account could not be found.');
  }

  for (let attempt = 0; attempt < 12; attempt += 1) {
    const code = generateDiscountCode();
    const ref = discountCodes(db).doc(code);
    const created = await db.runTransaction(async (transaction) => {
      const existing = await transaction.get(ref);
      if (existing.exists) return false;
      const now = admin.firestore.Timestamp.now();
      transaction.create(ref, {
        code,
        ...settings,
        startsAt: admin.firestore.Timestamp.fromDate(settings.startsAt),
        expiresAt: settings.expiresAt ? admin.firestore.Timestamp.fromDate(settings.expiresAt) : null,
        active: true,
        successfulRedemptions: 0,
        reservedRedemptions: 0,
        createdBy: uid,
        createdAt: now,
        updatedAt: now,
      });
      return true;
    });
    if (created) {
      if (settings.restrictedEmail) {
        try {
          const recipient = await findProfileForRestrictedEmail(db, settings.restrictedEmail);
          const recipientEmail = String(recipient?.email || '').trim().toLowerCase();
          if (recipientEmail === settings.restrictedEmail
            && recipient?.marketingEmailOptIn === true
            && isNotificationChannelEnabled(recipient, 'discount.offer', 'email')) {
            const eligiblePlans = settings.eligiblePlans.map((planId) => planId === 'circle' ? 'Circle' : 'Personalized').join(' and ');
            const discountDuration = settings.billingDuration === 'first_payment'
              ? 'First payment only'
              : settings.billingDuration === 'fixed_months'
                ? `First ${settings.discountDurationMonths} monthly billing periods`
                : 'Recurring while the same plan selection remains active';
            await queueBrandedEmail({
              type: 'discount.offer',
              eventId: `discount-${code}`,
              to: settings.restrictedEmail,
              name: recipient.displayName || recipient.name || '',
              subject: `A ${settings.percentOff}% Examifying discount is available for you`,
              heading: 'You have a subscription offer',
              paragraphs: [
                'Use this email-restricted code on an eligible Examifying subscription. The offer is available only while the code is active and within its redemption window.',
                'To stop discount and product-update emails, turn off Discount offers in your Examifying Settings.',
              ],
              details: [
                { label: 'Discount code', value: code },
                { label: 'Discount', value: `${settings.percentOff}% off` },
                { label: 'Eligible plans', value: eligiblePlans },
                { label: 'Discount duration', value: discountDuration },
                { label: 'Maximum subjects', value: settings.maxSubjectCount ? String(settings.maxSubjectCount) : 'No subject cap' },
                ...(settings.expiresAt ? [{ label: 'Use by', value: settings.expiresAt.toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg' }) }] : []),
              ],
              actionLabel: 'View subscription plans',
              actionUrl: `/?discountCode=${encodeURIComponent(code)}`,
            });
          }
        } catch (error) {
          logger.error('Discount code created but its opted-in email could not be queued', {
            code,
            error: error?.message || String(error),
          });
        }
      }
      return { code };
    }
  }

  throw new HttpsError('resource-exhausted', 'Could not generate a unique discount code. Please try again.');
});

export const listDiscountCodes = onCall({ cpu: 'gcf_gen1' }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in as an admin to view discount codes.');
  const db = getDb();
  await requireAdmin(db, uid);
  const snapshot = await discountCodes(db).orderBy('createdAt', 'desc').limit(250).get();
  const now = Date.now();
  return {
    codes: snapshot.docs.map((doc) => {
      const data = doc.data();
      const uses = getDiscountUseCounts(data);
      return {
        code: data.code || doc.id,
        title: data.title || null,
        percentOff: data.percentOff,
        maxRedemptions: data.maxRedemptions ?? null,
        maxSubjectCount: data.maxSubjectCount ?? null,
        successfulRedemptions: uses.successfulRedemptions,
        reservedRedemptions: uses.reservedRedemptions,
        remainingUses: uses.remainingUses,
        restrictedEmail: data.restrictedEmail || null,
        restrictedAccountId: data.restrictedAccountId || null,
        eligiblePlans: Array.isArray(data.eligiblePlans) ? data.eligiblePlans : ['circle', 'personalized'],
        startsAt: data.startsAt?.toDate?.().toISOString?.() ?? null,
        expiresAt: data.expiresAt?.toDate?.().toISOString?.() ?? null,
        billingDuration: data.billingDuration || 'recurring',
        discountDurationMonths: data.discountDurationMonths ?? null,
        redemptionExpiryMode: data.redemptionExpiryMode || (data.expiresAt ? 'manual' : 'none'),
        redemptionWindowMonths: data.redemptionWindowMonths ?? null,
        active: data.active === true,
        status: getCodeStatus(data, now),
        createdAt: data.createdAt?.toDate?.().toISOString?.() ?? null,
      };
    }),
  };
});

export const setDiscountCodeActive = onCall({ cpu: 'gcf_gen1' }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in as an admin to manage discount codes.');
  const code = normalizeDiscountCode(request.data?.code);
  if (!/^[A-Z0-9]{10}$/.test(code) || typeof request.data?.active !== 'boolean') {
    throw new HttpsError('invalid-argument', 'A valid code and active status are required.');
  }
  const db = getDb();
  await requireAdmin(db, uid);
  const ref = discountCodes(db).doc(code);
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists) throw new HttpsError('not-found', 'Discount code not found.');
    transaction.update(ref, { active: request.data.active, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
  });
  return { code, active: request.data.active };
});

export const updateDiscountCodeTitle = onCall({ cpu: 'gcf_gen1' }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in as an admin to edit discount titles.');
  const code = normalizeDiscountCode(request.data?.code);
  const title = String(request.data?.title ?? '').trim();
  if (!/^[A-Z0-9]{10}$/.test(code)) {
    throw new HttpsError('invalid-argument', 'Enter a valid discount code.');
  }
  if (!title || title.length > 80) {
    throw new HttpsError('invalid-argument', 'Discount title must contain 1 to 80 characters.');
  }
  const db = getDb();
  await requireAdmin(db, uid);
  const ref = discountCodes(db).doc(code);
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists) throw new HttpsError('not-found', 'Discount code not found.');
    transaction.update(ref, { title, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
  });
  return { code, title };
});

export const getDiscountQuoteForCheckout = async ({ db, code: rawCode, uid, email, studentId, planId, billingPeriod, subjectCount }) => {
  const code = normalizeDiscountCode(rawCode);
  if (!/^[A-Z0-9]{10}$/.test(code)) throw new HttpsError('invalid-argument', 'Enter a valid discount code.');
  let quote;
  try {
    quote = calculateSubscriptionQuote({ planId, billingPeriod, subjectCount });
  } catch (error) {
    throw new HttpsError('invalid-argument', error.message);
  }
  if (quote.planId === 'free') throw new HttpsError('failed-precondition', 'Discount codes apply to paid subscriptions only.');
  const codeSnapshot = await discountCodes(db).doc(code).get();
  if (!codeSnapshot.exists) throw new HttpsError('not-found', 'This discount code was not found.');
  const data = codeSnapshot.data();
  const billingPeriodError = getDiscountBillingPeriodError({ billingDuration: data.billingDuration, billingPeriod });
  if (billingPeriodError) throw new HttpsError('failed-precondition', billingPeriodError);
  const subscriptionSnapshot = studentId ? await subscriptionRef(db, studentId).get() : null;
  const pendingPlan = subscriptionSnapshot?.exists ? subscriptionSnapshot.data()?.pendingPlan : null;
  let existingScheduledRedemptionReference = null;
  if (pendingPlan?.discountCode === code
    && pendingPlan?.planId === quote.planId
    && pendingPlan?.billingPeriod === quote.billingPeriod
    && Number(pendingPlan?.subjectCount) === quote.subjectCount
    && pendingPlan?.discountRedemptionReference) {
    const scheduledUse = await redemptionRef(db, code, pendingPlan.discountRedemptionReference).get();
    const useData = scheduledUse.data();
    if (scheduledUse.exists && useData?.status === 'scheduled' && useData.studentId === studentId) {
      existingScheduledRedemptionReference = pendingPlan.discountRedemptionReference;
    }
  }
  const now = new Date();
  if (!existingScheduledRedemptionReference) {
    const eligibilityError = getDiscountEligibilityError({ code: data, uid, email, planId, subjectCount: quote.subjectCount, now });
    if (eligibilityError) throw new HttpsError('failed-precondition', eligibilityError);
    const usage = getDiscountUseCounts(data);
    if (!usage.available) throw new HttpsError('resource-exhausted', 'This discount code has no remaining uses.');
  }
  return {
    ...publicCodeQuote({ code: { ...data, code }, quote }),
    ...(existingScheduledRedemptionReference ? { existingScheduledRedemptionReference } : {}),
  };
};

export const validateDiscountCode = onCall({ cpu: 'gcf_gen1' }, async (request) => {
  const payerId = request.auth?.uid;
  const { studentId, planId, billingPeriod, subjectCount, code } = request.data ?? {};
  if (!payerId) throw new HttpsError('unauthenticated', 'Sign in before validating a discount code.');
  if (!studentId) throw new HttpsError('invalid-argument', 'A student account is required.');
  const db = getDb();
  const { payer } = await requireSubscriptionManager({ db, payerId, studentId });
  const email = request.auth.token?.email || payer.email || '';
  return getDiscountQuoteForCheckout({ db, code, uid: payerId, email, studentId, planId, billingPeriod, subjectCount });
});

export const previewDiscountCode = onCall({ cpu: 'gcf_gen1' }, async (request) => {
  const { code: rawCode, planId, billingPeriod, subjectCount } = request.data ?? {};
  const code = normalizeDiscountCode(rawCode);
  if (!/^[A-Z0-9]{10}$/.test(code)) throw new HttpsError('invalid-argument', 'Enter a valid discount code.');

  let quote;
  try {
    quote = calculateSubscriptionQuote({ planId, billingPeriod, subjectCount });
  } catch (error) {
    throw new HttpsError('invalid-argument', error.message);
  }
  if (quote.planId === 'free') throw new HttpsError('failed-precondition', 'Discount codes apply to paid subscriptions only.');

  const db = getDb();
  const codeSnapshot = await discountCodes(db).doc(code).get();
  if (!codeSnapshot.exists) throw new HttpsError('not-found', 'This discount code was not found.');
  const data = codeSnapshot.data();
  const billingPeriodError = getDiscountBillingPeriodError({ billingDuration: data.billingDuration, billingPeriod });
  if (billingPeriodError) throw new HttpsError('failed-precondition', billingPeriodError);
  const availabilityError = getDiscountEligibilityError({ code: data, planId, subjectCount: quote.subjectCount, now: new Date(), previewOnly: true });
  if (availabilityError) throw new HttpsError('failed-precondition', availabilityError);
  const usage = getDiscountUseCounts(data);
  if (!usage.available) throw new HttpsError('resource-exhausted', 'This discount code has no remaining uses.');

  return {
    ...publicCodeQuote({ code: { ...data, code }, quote }),
    previewOnly: true,
  };
});

export const reserveDiscountRedemption = async ({ db, code: rawCode, reference, studentId, payerId, email, quote, reservationStatus = 'reserved' }) => {
  const code = normalizeDiscountCode(rawCode);
  const codeRef = discountCodes(db).doc(code);
  const useRef = redemptionRef(db, code, reference);
  const result = await db.runTransaction(async (transaction) => {
    const nowDate = new Date();
    const now = admin.firestore.Timestamp.fromDate(nowDate);
    const [codeSnapshot, priorUse] = await Promise.all([transaction.get(codeRef), transaction.get(useRef)]);
    if (priorUse.exists) throw new HttpsError('already-exists', 'This checkout already has a discount reservation.');
    if (!codeSnapshot.exists) throw new HttpsError('not-found', 'This discount code was not found.');
    const data = codeSnapshot.data();
    const billingPeriodError = getDiscountBillingPeriodError({ billingDuration: data.billingDuration, billingPeriod: quote.billingPeriod });
    if (billingPeriodError) throw new HttpsError('failed-precondition', billingPeriodError);
    const issue = getDiscountEligibilityError({
      code: data, uid: payerId, email, planId: quote.planId, now: nowDate,
      subjectCount: quote.subjectCount,
    });
    if (issue) throw new HttpsError('failed-precondition', issue);
    const usage = getDiscountUseCounts(data);
    if (!usage.available) throw new HttpsError('resource-exhausted', 'This discount code has no remaining uses.');
    const discount = calculateDiscount(quote.amount, data.percentOff);
    transaction.update(codeRef, {
      reservedRedemptions: admin.firestore.FieldValue.increment(1),
      updatedAt: now,
    });
    transaction.create(useRef, {
      code,
      reference,
      studentId,
      payerId,
      payerEmail: String(email ?? '').trim().toLowerCase(),
      planId: quote.planId,
      billingPeriod: quote.billingPeriod,
      subjectCount: quote.subjectCount,
      percentOff: data.percentOff,
      billingDuration: data.billingDuration || 'recurring',
      discountDurationMonths: data.discountDurationMonths ?? null,
      originalAmount: discount.originalAmount,
      discountAmount: discount.discountAmount,
      finalAmount: discount.finalAmount,
      status: reservationStatus,
      reservedAt: now,
      updatedAt: now,
    });
    return {
      code,
      percentOff: data.percentOff,
      billingDuration: data.billingDuration || 'recurring',
      discountDurationMonths: data.discountDurationMonths ?? null,
      ...discount,
    };
  });
  return result;
};

export const transitionDiscountRedemptionForPayment = async ({ db, code: rawCode, reference, status }) => {
  if (!rawCode) return false;
  const code = normalizeDiscountCode(rawCode);
  const codeRef = discountCodes(db).doc(code);
  const useRef = redemptionRef(db, code, reference);
  return db.runTransaction(async (transaction) => {
    const [codeSnapshot, useSnapshot] = await Promise.all([transaction.get(codeRef), transaction.get(useRef)]);
    if (!codeSnapshot.exists || !useSnapshot.exists || !['reserved', 'scheduled'].includes(useSnapshot.data()?.status)) return false;
    const transition = transitionRedemption(status);
    if (transition.status === 'reserved') return false;
    transaction.update(useRef, {
      status: transition.status,
      ...(transition.status === 'redeemed' ? { redeemedAt: admin.firestore.FieldValue.serverTimestamp() } : { releasedAt: admin.firestore.FieldValue.serverTimestamp() }),
      paymentStatus: status,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    transaction.update(codeRef, {
      reservedRedemptions: admin.firestore.FieldValue.increment(transition.reservedDelta),
      ...(transition.successfulDelta ? { successfulRedemptions: admin.firestore.FieldValue.increment(transition.successfulDelta) } : {}),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return true;
  });
};

export const reconcileDiscountCodeReservations = onSchedule(
  { schedule: 'every 60 minutes', timeZone: 'Africa/Johannesburg', cpu: 'gcf_gen1' },
  async () => {
    const db = getDb();
    const { paystackSecretKey, paystackBaseUrl } = getPaystackConfig();
    if (!paystackSecretKey) {
      logger.error('Discount reservation reconciliation skipped because Paystack is not configured.');
      return;
    }
    const cutoff = Date.now() - 60 * 60 * 1000;
    const pending = await db.collectionGroup('redemptions')
      .where('status', '==', 'reserved')
      .orderBy('reservedAt', 'asc')
      .limit(100)
      .get();
    for (const redemptionSnapshot of pending.docs) {
      const redemption = redemptionSnapshot.data();
      if ((redemption.reservedAt?.toMillis?.() ?? Date.now()) > cutoff) continue;
      const codeRef = redemptionSnapshot.ref.parent.parent;
      const code = redemption.code || codeRef?.id;
      if (!code || !redemption.reference || !redemption.studentId) continue;
      try {
        const response = await fetch(`${paystackBaseUrl}/transaction/verify/${encodeURIComponent(redemption.reference)}`, {
          method: 'GET',
          headers: { Authorization: `Bearer ${paystackSecretKey}`, 'Content-Type': 'application/json' },
        });
        const payload = await response.json();
        if (!response.ok || payload.status !== true) continue;
        const transaction = payload.data;
        const definitiveFailure = ['failed', 'abandoned', 'reversed'].includes(transaction.status);
        const paymentRef = db.collection('users').doc(redemption.studentId).collection('payments').doc(redemption.reference);
        const paymentSnapshot = await paymentRef.get();
        const payment = paymentSnapshot.data();
        if (transaction.status === 'success' && payment?.status === 'success') {
          // The finalizer validates gateway amount (including the temporary R1
          // authorization charge) and persists the subscription atomically. This
          // task only repairs a redemption counter after that finalization.
          const amountMatches = Number(transaction.amount) === Math.round(Number(payment.amount) * 100)
            && transaction.currency === payment.currency;
          if (amountMatches) {
            await transitionDiscountRedemptionForPayment({ db, code, reference: redemption.reference, status: 'success' });
          } else {
            logger.error('Finalized discounted payment no longer matches the verified Paystack amount', {
              code, reference: redemption.reference, expectedAmount: payment.amount,
              actualAmount: transaction.amount, authorizationOnly: payment.authorizationOnly === true,
            });
          }
        } else if (definitiveFailure && payment?.status !== 'success') {
          await transitionDiscountRedemptionForPayment({ db, code, reference: redemption.reference, status: transaction.status });
          await paymentRef.set({
            status: transaction.status,
            gatewayResponse: transaction.gateway_response ?? null,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          }, { merge: true });
        }
      } catch (error) {
        logger.warn('Could not reconcile a pending discount reservation', {
          code, reference: redemption.reference, error: error?.message ?? String(error),
        });
      }
    }
  },
);
