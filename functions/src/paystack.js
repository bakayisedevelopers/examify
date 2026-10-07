import { onCall, onRequest, HttpsError } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { logger } from 'firebase-functions';
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { getDb, admin } from './admin.js';
import { getPaystackConfig } from './config.js';
import { calculateSubscriptionQuote } from './subscriptionPricing.js';
import { getNextActualSubscriptionCharge, needsAuthorizationForZeroCostCheckout } from './paystackPricingCore.js';
import { getActiveSubjectLessonQuotaUpdates } from './lessonEntitlements.js';
import { applyRecurringDiscount, applyScheduledDiscount, calculateDiscount, calculateDiscountEndAt, normalizeDiscountCode } from './discountCodesCore.js';
import { getDiscountQuoteForCheckout, reserveDiscountRedemption, transitionDiscountRedemptionForPayment } from './discountCodes.js';

const studentSubscriptionRef = (db, studentId) => db.collection('users').doc(studentId).collection('subscriptions').doc('current');
const studentPaymentRef = (db, studentId, reference) => db.collection('users').doc(studentId).collection('payments').doc(reference);
const studentAuthorizationRef = (db, studentId) => db.collection('users').doc(studentId).collection('subscriptionAuthorizations').doc('current');

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
    const error = new HttpsError('internal', data.message ?? 'Paystack request failed.');
    error.paystackRejected = true;
    throw error;
  }

  return data.data;
};

const makeReference = (prefix, studentId) => `${prefix}-${studentId}-${randomUUID()}`;

const isReusableAuthorization = (authorization) => authorization?.reusable === true
  && Boolean(authorization.authorizationCode)
  && Boolean(authorization.email);

const toMinorUnits = (amount) => {
  const minorUnits = Math.round(Number(amount) * 100);
  if (!Number.isSafeInteger(minorUnits) || minorUnits < 0) {
    throw new HttpsError('failed-precondition', 'The subscription amount is invalid.');
  }
  return minorUnits;
};

const MAX_AUTHORIZATION_REFUND_ATTEMPTS = 5;

const requestAuthorizationRefund = async ({ db, studentId, reference }) => {
  const paymentRef = studentPaymentRef(db, studentId, reference);
  const now = admin.firestore.Timestamp.now();
  const claim = await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(paymentRef);
    if (!snapshot.exists) return { claimed: false, reason: 'payment_missing' };
    const payment = snapshot.data();
    if (payment.status !== 'success' || payment.authorizationOnly !== true) {
      return { claimed: false, reason: 'not_authorization_payment' };
    }
    const refundStatus = payment.authorizationRefundStatus;
    if (['pending', 'processing', 'processed', 'success', 'needs-attention'].includes(refundStatus)) {
      return { claimed: false, reason: 'refund_already_requested', refundStatus };
    }
    if (Number(payment.authorizationRefundAttempts || 0) >= MAX_AUTHORIZATION_REFUND_ATTEMPTS) {
      transaction.set(paymentRef, {
        authorizationRefundStatus: 'needs-attention',
        authorizationRefundError: 'Automatic refund initiation reached its retry limit.',
        authorizationRefundUpdatedAt: now,
        updatedAt: now,
      }, { merge: true });
      return { claimed: false, reason: 'refund_retry_limit_reached', refundStatus: 'needs-attention' };
    }
    const lastAttemptAt = payment.authorizationRefundAttemptedAt?.toDate?.();
    if (refundStatus === 'requesting' && lastAttemptAt && now.toDate() - lastAttemptAt < 10 * 60 * 1000) {
      return { claimed: false, reason: 'refund_request_in_progress', refundStatus };
    }
    transaction.set(paymentRef, {
      authorizationRefundStatus: 'requesting',
      authorizationRefundAttemptedAt: now,
      authorizationRefundAttempts: admin.firestore.FieldValue.increment(1),
      updatedAt: now,
    }, { merge: true });
    return {
      claimed: true,
      amount: toMinorUnits(payment.authorizationChargeAmount),
      attempts: Number(payment.authorizationRefundAttempts || 0) + 1,
      gatewayTransactionId: payment.gatewayTransactionId ?? null,
    };
  });
  if (!claim.claimed) return claim;

  let refundPostAttempted = false;
  try {
    let refund = null;
    if (claim.gatewayTransactionId) {
      const existingRefunds = await paystackRequest({
        path: `/refund?transaction=${encodeURIComponent(claim.gatewayTransactionId)}&perPage=50`,
        method: 'GET',
      });
      refund = (Array.isArray(existingRefunds) ? existingRefunds : []).find((item) =>
        Number(item.amount) === claim.amount && String(item.transaction?.reference ?? reference) === reference);
    }
    if (!refund) {
      refundPostAttempted = true;
      refund = await paystackRequest({
        path: '/refund',
        method: 'POST',
        payload: {
          transaction: reference,
          amount: claim.amount,
          currency: 'ZAR',
          customer_note: 'Refund of the temporary Examifying card authorization charge.',
          merchant_note: `Temporary subscription authorization refund for ${reference}`,
        },
      });
    }
    const providerStatus = String(refund.status ?? 'pending').toLowerCase();
    const normalizedStatus = providerStatus === 'processed' || providerStatus === 'success'
      ? 'processed'
      : providerStatus === 'failed' || providerStatus === 'needs-attention'
        ? providerStatus
        : 'pending';
    await paymentRef.set({
      authorizationRefundStatus: normalizedStatus,
      authorizationRefundProviderStatus: providerStatus,
      authorizationRefundId: refund.id ?? null,
      authorizationRefundAmount: Number(refund.amount ?? claim.amount) / 100,
      authorizationRefundCurrency: refund.currency ?? 'ZAR',
      authorizationRefundExpectedAt: refund.expected_at ?? null,
      authorizationRefundUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
      authorizationRefundError: admin.firestore.FieldValue.delete(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    return { claimed: true, refundStatus: normalizedStatus, refundId: refund.id ?? null };
  } catch (error) {
    logger.error('Could not initiate temporary subscription authorization refund', {
      studentId, reference, attempt: claim.attempts, error: error?.message ?? String(error),
    });
    await paymentRef.set({
      // A lost response after POST is ambiguous: stop automatic retries until the
      // provider's refund list has been reconciled, to avoid double-refunding.
      authorizationRefundStatus: refundPostAttempted && !error?.paystackRejected ? 'needs-attention' : 'failed',
      authorizationRefundError: String(error?.message ?? error).slice(0, 500),
      authorizationRefundUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true }).catch((persistError) => {
      logger.error('Could not persist temporary authorization refund failure', {
        studentId, reference, error: persistError?.message ?? String(persistError),
      });
    });
    return { claimed: true, refundStatus: 'failed' };
  }
};

export const applyFreeSubscription = async ({ studentId, pendingReference = null, pendingStatus = 'applied', reason = null }) => {
  const db = getDb();
  const beforeSnapshot = await studentSubscriptionRef(db, studentId).get();
  const pendingDiscount = beforeSnapshot.data()?.pendingPlan;
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
    discountBenefit: admin.firestore.FieldValue.delete(),
    manualPaymentRequired: false,
    lastChargeStatus: admin.firestore.FieldValue.delete(),
    updatedAt: now,
    ...(reason ? { lastSubscriptionChangeReason: reason } : {}),
  };
  const freeSubscription = { ...quote, planId: 'free', status: 'active', renewalDate: null, latestReference: null };
  const freeSubjectQuotas = await getActiveSubjectLessonQuotaUpdates({
    db, studentId, subscription: freeSubscription, carryForward: false,
    windowStartAt: null, renewalDate: null, cycleId: 'free', updatedAt: now,
  });
  batch.set(studentSubscriptionRef(db, studentId), subscriptionPatch, { merge: true });
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
    batch.set(studentPaymentRef(db, studentId, pendingReference), {
      status: pendingStatus,
      appliedAt: pendingStatus === 'applied' ? now : admin.firestore.FieldValue.delete(),
      updatedAt: now,
    }, { merge: true });
  }
  freeSubjectQuotas.forEach(({ ref, lessonQuota }) => batch.set(ref, { lessonQuota, updatedAt: now }, { merge: true }));
  await batch.commit();
  if (pendingDiscount?.discountRedemptionReference) {
    await transitionDiscountRedemptionForPayment({
      db, code: pendingDiscount.discountCode,
      reference: pendingDiscount.discountRedemptionReference, status: 'cancelled',
    });
  }
  return quote;
};

const completeZeroCostDiscountCheckout = async ({ db, studentId, payerId, isParent, email, reference, quote, discount, reusableAuthorization = false, isNewRedemption = true }) => {
  const now = admin.firestore.Timestamp.now();
  const renewalDate = admin.firestore.Timestamp.fromDate(
    new Date(now.toDate().getTime() + quote.billingCycleDays * 24 * 60 * 60 * 1000),
  );
  const paymentRef = studentPaymentRef(db, studentId, reference);
  const subRef = studentSubscriptionRef(db, studentId);
  const userRef = db.collection('users').doc(studentId);
  const codeRef = db.collection('discountCodes').doc(discount.code);
  const redemptionReference = discount.discountRedemptionReference || reference;
  const useRef = codeRef.collection('redemptions').doc(redemptionReference);
  const discountEndsAt = discount.billingDuration === 'fixed_months'
    ? admin.firestore.Timestamp.fromDate(discount.discountEndsAt?.toDate?.()
      ?? calculateDiscountEndAt(now.toDate(), discount.discountDurationMonths, quote.billingCycleDays))
    : null;
  const subscriptionForQuota = {
    ...quote,
    status: 'active',
    latestReference: reference,
    renewalDate,
    entitlementWindowStartAt: now,
    activatedAt: now,
    renewedAt: now,
  };
  const quotas = await getActiveSubjectLessonQuotaUpdates({
    db, studentId, subscription: subscriptionForQuota, carryForward: false,
    windowStartAt: now, renewalDate, cycleId: reference, updatedAt: now,
  });

  await db.runTransaction(async (transaction) => {
    const hasRedemptionReservation = Boolean(discount.discountRedemptionReference || isNewRedemption);
    const [paymentSnapshot, subscriptionSnapshot, codeSnapshot, useSnapshot] = await Promise.all([
      transaction.get(paymentRef), transaction.get(subRef),
      ...(hasRedemptionReservation ? [transaction.get(codeRef), transaction.get(useRef)] : []),
    ]);
    if (paymentSnapshot.exists && paymentSnapshot.data()?.status === 'success') return;
    const expectedReservationStatus = discount.reservationStatus || 'reserved';
    if (hasRedemptionReservation && (!codeSnapshot?.exists || !useSnapshot?.exists || useSnapshot.data()?.status !== expectedReservationStatus)) {
      throw new HttpsError('failed-precondition', 'The discount reservation could not be confirmed. Please start checkout again.');
    }
    const currentSubscription = subscriptionSnapshot.exists ? subscriptionSnapshot.data() : {};
    const oldPendingReference = currentSubscription.pendingPlanReference;
    const oldPendingRef = oldPendingReference && oldPendingReference !== reference
      ? studentPaymentRef(db, studentId, oldPendingReference)
      : null;
    if (oldPendingRef) await transaction.get(oldPendingRef);

    const carriesRenewalDiscount = ['recurring', 'fixed_months'].includes(discount.billingDuration);
    const recurringBenefit = carriesRenewalDiscount ? {
      code: discount.code,
      percentOff: discount.percentOff,
      planId: quote.planId,
      billingPeriod: quote.billingPeriod,
      subjectCount: quote.subjectCount,
      activatedAt: discount.discountStartedAt || now,
      billingDuration: discount.billingDuration,
      ...(discount.billingDuration === 'fixed_months' ? {
        discountDurationMonths: discount.discountDurationMonths,
        discountEndsAt,
      } : {}),
    } : admin.firestore.FieldValue.delete();
    transaction.set(paymentRef, {
      reference, studentId, payerId, parentId: isParent ? payerId : null, email,
      status: 'success', originalAmount: discount.originalAmount,
      discountAmount: discount.discountAmount, discountPercent: discount.percentOff,
      discountCode: discount.code, discountBillingDuration: discount.billingDuration,
      ...(hasRedemptionReservation ? {
        discountRedemptionReference: redemptionReference,
        discountReservationStatus: expectedReservationStatus,
      } : {}),
      ...(discount.billingDuration === 'fixed_months' ? { discountDurationMonths: discount.discountDurationMonths, discountEndsAt } : {}),
      currency: quote.currency, ...quote, amount: 0, subscriptionAmountDue: 0,
      product: 'Examifying subscription',
      paidAt: now, zeroCostCheckout: true, createdAt: now, updatedAt: now,
    }, { merge: true });
    transaction.set(subRef, {
      studentId, status: 'active', ...quote, amount: 0,
      originalAmount: discount.originalAmount, discountAmount: discount.discountAmount,
      discountPercent: discount.percentOff, discountCode: discount.code,
      discountBillingDuration: discount.billingDuration,
      discountRedemptionReference: admin.firestore.FieldValue.delete(),
      ...(discount.billingDuration === 'fixed_months'
        ? { discountDurationMonths: discount.discountDurationMonths, discountEndsAt }
        : { discountDurationMonths: admin.firestore.FieldValue.delete(), discountEndsAt: admin.firestore.FieldValue.delete() }),
      discountBenefit: recurringBenefit,
      latestReference: reference, activatedAt: now, entitlementWindowStartAt: now,
      renewedAt: now, renewalDate, cancelAtPeriodEnd: false,
      manualPaymentRequired: !reusableAuthorization,
      autoRenew: reusableAuthorization,
      renewalAttemptCount: 0,
      graceEndsAt: admin.firestore.FieldValue.delete(), renewalAttempt: admin.firestore.FieldValue.delete(),
      renewalChargeLock: admin.firestore.FieldValue.delete(), pendingPlan: admin.firestore.FieldValue.delete(),
      pendingPlanReference: admin.firestore.FieldValue.delete(), pendingPlanSetAt: admin.firestore.FieldValue.delete(),
      cancellation: admin.firestore.FieldValue.delete(), updatedAt: now,
    }, { merge: true });
    transaction.set(userRef, {
      paymentCompleted: true, subscriptionStatus: 'active',
      subscriptionPlanId: quote.planId, subscriptionPlanName: quote.planName,
      subscriptionBillingPeriod: quote.billingPeriod, subscriptionSubjectCount: quote.subjectCount,
      latestPaymentReference: reference, subscriptionRenewalDate: renewalDate,
      pendingSubscriptionPlan: admin.firestore.FieldValue.delete(), updatedAt: now,
    }, { merge: true });
    if (hasRedemptionReservation) {
      transaction.set(useRef, { status: 'redeemed', paymentStatus: 'success', redeemedAt: now, updatedAt: now }, { merge: true });
      transaction.update(codeRef, {
        reservedRedemptions: admin.firestore.FieldValue.increment(-1),
        successfulRedemptions: admin.firestore.FieldValue.increment(1), updatedAt: now,
      });
    }
    if (oldPendingRef) {
      const pendingPlan = currentSubscription.pendingPlan;
      const appliesPendingPlan = pendingPlan?.discountRedemptionReference === redemptionReference
        && pendingPlan?.planId === quote.planId
        && pendingPlan?.billingPeriod === quote.billingPeriod
        && Number(pendingPlan?.subjectCount) === Number(quote.subjectCount);
      transaction.set(oldPendingRef, {
        status: appliesPendingPlan ? 'applied' : 'cancelled',
        ...(appliesPendingPlan ? { appliedAt: now } : { cancelledAt: now, cancellationReason: 'discounted_checkout_completed' }),
      }, { merge: true });
    }
    quotas.forEach(({ ref, lessonQuota }) => transaction.set(ref, { lessonQuota, updatedAt: now }, { merge: true }));
  });
  return { freeCheckout: true, reference, quote, discount };
};

export const applyZeroCostSubscriptionRenewal = async ({ studentId, quote, renewalDate }) => {
  const db = getDb();
  const dueDate = renewalDate?.toDate?.() ?? (renewalDate instanceof Date ? renewalDate : null);
  if (!dueDate || quote?.amount !== 0 || quote?.discountPercent !== 100
    || (!quote?.discountRedemptionReference && !['recurring', 'fixed_months'].includes(quote?.discountBillingDuration))) {
    throw new HttpsError('failed-precondition', 'The zero-cost recurring renewal is not eligible.');
  }
  const reference = `zero-renewal-${studentId}-${dueDate.getTime()}`;
  const subRef = studentSubscriptionRef(db, studentId);
  const paymentRef = studentPaymentRef(db, studentId, reference);
  const userRef = db.collection('users').doc(studentId);
  const scheduledCodeRef = quote.discountRedemptionReference
    ? db.collection('discountCodes').doc(quote.discountCode)
    : null;
  const scheduledUseRef = quote.discountRedemptionReference
    ? scheduledCodeRef.collection('redemptions').doc(quote.discountRedemptionReference)
    : null;
  const now = admin.firestore.Timestamp.now();
  const nextRenewalDate = admin.firestore.Timestamp.fromDate(
    new Date(now.toDate().getTime() + quote.billingCycleDays * 24 * 60 * 60 * 1000),
  );
  const quotaSubscription = { ...quote, status: 'active', latestReference: reference, renewalDate: nextRenewalDate };
  const quotas = await getActiveSubjectLessonQuotaUpdates({
    db, studentId, subscription: quotaSubscription, carryForward: true,
    windowStartAt: now, renewalDate: nextRenewalDate, cycleId: reference, updatedAt: now,
  });
  await db.runTransaction(async (transaction) => {
    const [subSnapshot, paymentSnapshot, codeSnapshot, useSnapshot] = await Promise.all([
      transaction.get(subRef), transaction.get(paymentRef),
      scheduledCodeRef ? transaction.get(scheduledCodeRef) : Promise.resolve(null),
      scheduledUseRef ? transaction.get(scheduledUseRef) : Promise.resolve(null),
    ]);
    if (paymentSnapshot.exists && paymentSnapshot.data()?.status === 'success') return;
    if (!subSnapshot.exists) throw new HttpsError('not-found', 'The subscription could not be found.');
    const current = subSnapshot.data();
    const currentDue = current.renewalDate?.toDate?.();
    const selectedPlan = current.pendingPlan?.planId ? current.pendingPlan : current;
    const benefit = current.discountBenefit;
    const baseQuote = calculateSubscriptionQuote({
      planId: selectedPlan.planId,
      billingPeriod: selectedPlan.billingPeriod,
      subjectCount: selectedPlan.subjectCount,
    });
    const expectedQuote = quote.discountRedemptionReference
      ? applyScheduledDiscount(baseQuote, selectedPlan)
      : applyRecurringDiscount(baseQuote, benefit, selectedPlan, dueDate);
    if (currentDue?.getTime() !== dueDate.getTime()
      || current.cancelAtPeriodEnd === true || current.pendingPlan?.planId === 'free'
      || (!quote.discountRedemptionReference && (benefit?.percentOff !== 100
        || benefit?.planId !== selectedPlan.planId || benefit?.billingPeriod !== selectedPlan.billingPeriod
        || Number(benefit?.subjectCount) !== Number(selectedPlan.subjectCount)))
      || (quote.discountRedemptionReference && (selectedPlan.discountRedemptionReference !== quote.discountRedemptionReference
        || !codeSnapshot?.exists || !useSnapshot?.exists || useSnapshot.data()?.status !== 'scheduled'))
      || expectedQuote.amount !== 0 || expectedQuote.discountBillingDuration !== quote.discountBillingDuration
      || expectedQuote.discountCode !== quote.discountCode) {
      throw new HttpsError('aborted', 'The subscription changed before its free renewal could be applied.');
    }
    const carriedDiscountEndsAt = quote.discountBenefit?.discountEndsAt ?? benefit?.discountEndsAt ?? null;
    const discountEndsAt = quote.discountBillingDuration === 'fixed_months'
      ? (carriedDiscountEndsAt?.toDate
        ? carriedDiscountEndsAt
        : carriedDiscountEndsAt instanceof Date
          ? admin.firestore.Timestamp.fromDate(carriedDiscountEndsAt)
          : admin.firestore.Timestamp.fromDate(calculateDiscountEndAt(now.toDate(), quote.discountDurationMonths, quote.billingCycleDays)))
      : null;
    const newBenefit = quote.discountRedemptionReference
      && ['recurring', 'fixed_months'].includes(quote.discountBillingDuration)
      ? {
        code: quote.discountCode,
        percentOff: quote.discountPercent,
        planId: quote.planId,
        billingPeriod: quote.billingPeriod,
        subjectCount: quote.subjectCount,
        billingDuration: quote.discountBillingDuration,
        activatedAt: quote.discountBenefit?.activatedAt ?? benefit?.activatedAt ?? now,
        ...(quote.discountBillingDuration === 'fixed_months' ? {
          discountDurationMonths: quote.discountDurationMonths,
          discountEndsAt,
        } : {}),
      }
      : (quote.discountRedemptionReference ? null : quote.discountBenefit || benefit);
    const shouldAutoRenew = ['recurring', 'fixed_months'].includes(quote.discountBillingDuration)
      ? true
      : current.autoRenew === true;
    transaction.set(paymentRef, {
      reference, studentId, payerId: current.renewalAttempt?.payerId || studentId,
      status: 'success', recurring: true, zeroCostCheckout: true,
      originalAmount: quote.originalAmount, discountAmount: quote.discountAmount,
      discountPercent: 100, discountCode: quote.discountCode || benefit?.code,
      discountBillingDuration: quote.discountBillingDuration || benefit?.billingDuration || 'recurring',
      ...(quote.discountBillingDuration === 'fixed_months' ? {
        discountDurationMonths: quote.discountDurationMonths,
        discountEndsAt,
      } : {}),
      currency: quote.currency, ...quote, amount: 0,
      createdAt: now, paidAt: now, updatedAt: now,
    }, { merge: true });
    transaction.set(subRef, {
      ...quote, amount: 0, originalAmount: quote.originalAmount, discountAmount: quote.discountAmount,
      discountPercent: 100, discountCode: quote.discountCode || benefit?.code,
      discountBillingDuration: quote.discountBillingDuration || benefit?.billingDuration || 'recurring',
      discountRedemptionReference: admin.firestore.FieldValue.delete(),
      ...(quote.discountBillingDuration === 'fixed_months' ? {
        discountDurationMonths: quote.discountDurationMonths,
        discountEndsAt,
      } : {}),
      discountBenefit: newBenefit || admin.firestore.FieldValue.delete(),
      latestReference: reference, status: 'active', autoRenew: shouldAutoRenew, manualPaymentRequired: !shouldAutoRenew,
      renewalDate: nextRenewalDate, activatedAt: now, entitlementWindowStartAt: now, renewedAt: now,
      renewalAttemptCount: 0, renewalAttempt: admin.firestore.FieldValue.delete(),
      renewalChargeLock: admin.firestore.FieldValue.delete(), graceEndsAt: admin.firestore.FieldValue.delete(),
      nextRenewalAttemptAt: admin.firestore.FieldValue.delete(), pendingPlan: admin.firestore.FieldValue.delete(),
      pendingPlanReference: admin.firestore.FieldValue.delete(), pendingPlanSetAt: admin.firestore.FieldValue.delete(),
      updatedAt: now,
    }, { merge: true });
    transaction.set(userRef, {
      paymentCompleted: true, subscriptionStatus: 'active', subscriptionPlanId: quote.planId,
      subscriptionPlanName: quote.planName, subscriptionBillingPeriod: quote.billingPeriod,
      subscriptionSubjectCount: quote.subjectCount, latestPaymentReference: reference,
      subscriptionRenewalDate: nextRenewalDate, pendingSubscriptionPlan: admin.firestore.FieldValue.delete(),
      updatedAt: now,
    }, { merge: true });
    if (scheduledUseRef && scheduledCodeRef) {
      transaction.set(scheduledUseRef, {
        status: 'redeemed', paymentStatus: 'success', redeemedAt: now, updatedAt: now,
      }, { merge: true });
      transaction.update(scheduledCodeRef, {
        reservedRedemptions: admin.firestore.FieldValue.increment(-1),
        successfulRedemptions: admin.firestore.FieldValue.increment(1),
        updatedAt: now,
      });
    }
    quotas.forEach(({ ref, lessonQuota }) => transaction.set(ref, { lessonQuota, updatedAt: now }, { merge: true }));
  });
  return { succeeded: true, reference, zeroCostRenewal: true, nextRenewalDate };
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
    const { studentId, planId, billingPeriod, subjectCount, callbackUrl, discountCode } = request.data ?? {};
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

    let callbackUrlWithStudent;
    try {
      callbackUrlWithStudent = new URL(paystackCallbackUrl);
      callbackUrlWithStudent.searchParams.set('studentId', studentId);
      if (!['http:', 'https:'].includes(callbackUrlWithStudent.protocol)) {
        throw new Error('Unsupported callback URL protocol.');
      }
    } catch {
      throw new HttpsError('invalid-argument', 'callbackUrl must be a valid http or https URL.');
    }

    const subscriptionRef = studentSubscriptionRef(db, studentId);
    const [currentSubscriptionSnapshot, authorizationSnapshot] = await Promise.all([
      subscriptionRef.get(),
      studentAuthorizationRef(db, studentId).get(),
    ]);
    const currentSubscription = currentSubscriptionSnapshot.exists ? currentSubscriptionSnapshot.data() : null;
    const currentAuthorization = authorizationSnapshot.exists ? authorizationSnapshot.data() : null;
    const hasReusableAuthorization = isReusableAuthorization(currentAuthorization);
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

    const normalizedRequestedCode = normalizeDiscountCode(discountCode);
    const pendingSelectionMatches = subscriptionIsCurrent
      && currentPendingPlan?.planId === quote.planId
      && currentPendingPlan?.billingPeriod === quote.billingPeriod
      && Number(currentPendingPlan?.subjectCount) === quote.subjectCount;
    const pendingDiscountMatches = (currentPendingPlan?.discountCode || null) === (normalizedRequestedCode || null);
    if (pendingSelectionMatches && pendingDiscountMatches) {
      const pendingDiscount = currentPendingPlan?.discountCode ? {
        code: currentPendingPlan.discountCode,
        percentOff: currentPendingPlan.discountPercent,
        billingDuration: currentPendingPlan.discountBillingDuration,
        discountDurationMonths: currentPendingPlan.discountDurationMonths ?? null,
        originalAmount: currentPendingPlan.originalAmount,
        discountAmount: currentPendingPlan.discountAmount,
        finalAmount: currentPendingPlan.amount,
      } : null;
      return {
        scheduledChange: true,
        alreadyScheduled: true,
        quote: currentPendingPlan,
        ...(pendingDiscount ? { discount: pendingDiscount } : {}),
        effectiveAt: renewalDate.toISOString(),
        manualPaymentRequired: currentSubscription.autoRenew !== true,
      };
    }

    let discountQuote = null;
    if (discountCode) {
      discountQuote = await getDiscountQuoteForCheckout({
        db, code: discountCode, uid: payerId, email, studentId, planId, billingPeriod, subjectCount,
      });
    }
    let rememberedDiscount = null;
    const savedBenefit = currentSubscription?.discountBenefit;
    if (!discountCode && ['recurring', 'fixed_months'].includes(currentSubscription?.discountBillingDuration) && savedBenefit) {
      const discountReferenceDate = currentSubscription?.renewalDate?.toDate?.() ?? new Date();
      const recurringQuote = applyRecurringDiscount(quote, savedBenefit, quote, discountReferenceDate);
      if (recurringQuote.discountPercent) {
        const amountParts = calculateDiscount(quote.amount, Number(savedBenefit.percentOff));
        rememberedDiscount = {
          code: savedBenefit.code,
          percentOff: Number(savedBenefit.percentOff),
          billingDuration: savedBenefit.billingDuration || 'recurring',
          ...(savedBenefit.billingDuration === 'fixed_months' ? {
            discountDurationMonths: savedBenefit.discountDurationMonths,
            discountEndsAt: savedBenefit.discountEndsAt,
            discountStartedAt: savedBenefit.activatedAt,
          } : {}),
          ...amountParts,
        };
      }
    }
    if (samePlan && !discountQuote) {
      if (currentSubscription.pendingPlanReference) {
        const batch = db.batch();
        batch.set(studentPaymentRef(db, studentId, currentSubscription.pendingPlanReference), {
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
        if (currentPendingPlan?.discountRedemptionReference) {
          await transitionDiscountRedemptionForPayment({
            db, code: currentPendingPlan.discountCode,
            reference: currentPendingPlan.discountRedemptionReference, status: 'cancelled',
          });
        }
        return { pendingChangeCancelled: true, quote, renewalDate: renewalDate.toISOString() };
      }
      if (currentSubscription.cancelAtPeriodEnd) {
        return { alreadyActive: true, renewalCancelled: true, quote, renewalDate: renewalDate.toISOString() };
      }
      return { alreadyActive: true, quote, renewalDate: renewalDate.toISOString() };
    }

    if (subscriptionIsCurrent) {
      const reference = makeReference('change', studentId);
      let scheduledDiscount = null;
      if (discountQuote) {
        scheduledDiscount = await reserveDiscountRedemption({
          db, code: discountQuote.code, reference, studentId, payerId, email, quote,
          reservationStatus: 'scheduled',
        });
      }
      const scheduledQuote = scheduledDiscount ? {
        ...quote,
        amount: scheduledDiscount.finalAmount,
        originalAmount: scheduledDiscount.originalAmount,
        discountAmount: scheduledDiscount.discountAmount,
        discountPercent: scheduledDiscount.percentOff,
        discountCode: scheduledDiscount.code,
        discountBillingDuration: scheduledDiscount.billingDuration,
        discountDurationMonths: scheduledDiscount.discountDurationMonths,
        discountRedemptionReference: reference,
      } : quote;
      const pendingPlan = { ...scheduledQuote, effectiveAt: renewalDate };
      const reusableAuthorization = isReusableAuthorization(authorizationSnapshot.data());
      const batch = db.batch();
      if (currentSubscription.pendingPlanReference) {
        batch.set(studentPaymentRef(db, studentId, currentSubscription.pendingPlanReference), {
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
      batch.set(studentPaymentRef(db, studentId, reference), {
        reference,
        studentId,
        payerId,
        parentId: isParent ? payerId : null,
        status: 'scheduled_change',
        amount: scheduledQuote.amount,
        currency: quote.currency,
        ...scheduledQuote,
        ...(scheduledDiscount ? {
          originalAmount: scheduledDiscount.originalAmount,
          discountAmount: scheduledDiscount.discountAmount,
          discountPercent: scheduledDiscount.percentOff,
          discountCode: scheduledDiscount.code,
          discountBillingDuration: scheduledDiscount.billingDuration,
          discountDurationMonths: scheduledDiscount.discountDurationMonths,
          discountRedemptionReference: reference,
        } : {}),
        effectiveAt: renewalDate,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      try {
        await batch.commit();
      } catch (error) {
        if (scheduledDiscount) {
          await transitionDiscountRedemptionForPayment({
            db, code: scheduledDiscount.code, reference, status: 'failed',
          }).catch(() => {});
        }
        throw error;
      }
      if (currentPendingPlan?.discountRedemptionReference) {
        await transitionDiscountRedemptionForPayment({
          db, code: currentPendingPlan.discountCode,
          reference: currentPendingPlan.discountRedemptionReference, status: 'cancelled',
        });
      }
      return {
        scheduledChange: true,
        quote: scheduledQuote,
        ...(scheduledDiscount ? { discount: scheduledDiscount } : {}),
        effectiveAt: renewalDate.toISOString(),
        manualPaymentRequired: quote.planId !== 'free' && !reusableAuthorization,
      };
    }

    const reference = makeReference('examifying', studentId);

    if (planId === 'free') {
      const now = admin.firestore.Timestamp.now();
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
        activatedAt: now,
        entitlementWindowStartAt: null,
        pendingPlan: admin.firestore.FieldValue.delete(),
        pendingPlanReference: admin.firestore.FieldValue.delete(),
        pendingPlanSetAt: admin.firestore.FieldValue.delete(),
      };
      const batch = db.batch();
      const freeSubjectQuotas = await getActiveSubjectLessonQuotaUpdates({
        db, studentId, subscription: { ...quote, planId: 'free', status: 'active', latestReference: reference, renewalDate: null },
        carryForward: false, windowStartAt: null, renewalDate: null, cycleId: reference, updatedAt: now,
      });
      if (currentSubscription?.pendingPlanReference) {
        batch.set(studentPaymentRef(db, studentId, currentSubscription.pendingPlanReference), {
          status: 'cancelled',
          cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
          cancellationReason: 'activated_free_plan',
        }, { merge: true });
      }
      batch.set(studentPaymentRef(db, studentId, reference), {
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
      freeSubjectQuotas.forEach(({ ref, lessonQuota }) => batch.set(ref, { lessonQuota, updatedAt: now }, { merge: true }));
      await batch.commit();
      return { free: true, reference, quote };
    }

    let reservedDiscount = null;
    let appliedDiscount = rememberedDiscount;
    if (discountQuote) {
      if (discountQuote.existingScheduledRedemptionReference) {
        const amountParts = calculateDiscount(quote.amount, Number(discountQuote.percentOff));
        appliedDiscount = {
          code: discountQuote.code,
          percentOff: Number(discountQuote.percentOff),
          billingDuration: discountQuote.billingDuration,
          discountDurationMonths: discountQuote.discountDurationMonths ?? null,
          discountRedemptionReference: discountQuote.existingScheduledRedemptionReference,
          reservationStatus: 'scheduled',
          ...amountParts,
        };
      } else {
        reservedDiscount = await reserveDiscountRedemption({
          db, code: discountQuote.code, reference, studentId, payerId, email, quote,
        });
        appliedDiscount = {
          ...reservedDiscount,
          discountRedemptionReference: reference,
          reservationStatus: 'reserved',
        };
      }
    }
    const zeroCostCheckout = appliedDiscount?.finalAmount === 0;
    const requiresAuthorizationOnlyCharge = needsAuthorizationForZeroCostCheckout({
      amountDue: appliedDiscount?.finalAmount,
      planId: quote.planId,
      currentPaidSubscription: subscriptionIsCurrent,
      hasReusableAuthorization,
      discountPercent: appliedDiscount?.percentOff,
      billingDuration: appliedDiscount?.billingDuration,
    });
    if (zeroCostCheckout && !requiresAuthorizationOnlyCharge) {
      return await completeZeroCostDiscountCheckout({
        db, studentId, payerId, isParent, email, reference, quote,
        discount: appliedDiscount,
        reusableAuthorization: hasReusableAuthorization,
        isNewRedemption: Boolean(appliedDiscount?.discountRedemptionReference),
      });
    }
    const subscriptionAmountDue = appliedDiscount?.finalAmount ?? quote.amount;
    const authorizationChargeAmount = requiresAuthorizationOnlyCharge ? 1 : null;
    const transactionAmount = authorizationChargeAmount ?? subscriptionAmountDue;
    if (appliedDiscount) {
      await studentPaymentRef(db, studentId, reference).set({
        reference, studentId, payerId, parentId: isParent ? payerId : null, email,
        status: 'initializing',
        authorizationOnly: requiresAuthorizationOnlyCharge,
        ...(requiresAuthorizationOnlyCharge ? { authorizationChargeAmount } : {}),
        subscriptionAmountDue,
        originalAmount: appliedDiscount.originalAmount, discountAmount: appliedDiscount.discountAmount,
        discountPercent: appliedDiscount.percentOff, discountCode: appliedDiscount.code,
        discountBillingDuration: appliedDiscount.billingDuration,
        ...(appliedDiscount.discountRedemptionReference ? {
          discountRedemptionReference: appliedDiscount.discountRedemptionReference,
          discountReservationStatus: appliedDiscount.reservationStatus,
        } : {}),
        ...(appliedDiscount.billingDuration === 'fixed_months' ? {
          discountDurationMonths: appliedDiscount.discountDurationMonths,
          discountEndsAt: appliedDiscount.discountEndsAt || null,
          discountStartedAt: appliedDiscount.discountStartedAt || null,
        } : {}),
        currency: quote.currency, ...quote, amount: transactionAmount,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    logger.info('Initializing Paystack transaction', {
      email,
      studentId,
      payerId,
      quote,
      reference,
      callbackUrl: paystackCallbackUrl,
    });

    let transaction;
    try {
      transaction = await paystackRequest({
        path: '/transaction/initialize',
        method: 'POST',
        payload: {
          email,
          amount: toMinorUnits(transactionAmount),
          currency: 'ZAR',
          reference,
          callback_url: callbackUrlWithStudent.toString(),
          metadata: {
            studentId,
            payerId,
            planId: quote.planId,
            billingPeriod: quote.billingPeriod,
            subjectCount: quote.subjectCount,
            ...(appliedDiscount ? { discountCode: appliedDiscount.code, discountPercent: appliedDiscount.percentOff } : {}),
            ...(requiresAuthorizationOnlyCharge ? {
              checkoutPurpose: 'subscription_authorization',
              authorizationOnly: true,
              authorizationChargeAmount: 1,
              subscriptionAmountDue: 0,
            } : {}),
            product: 'Examifying subscription',
          },
        },
      });
    } catch (error) {
      if (appliedDiscount && error instanceof HttpsError) {
        const cleanup = [studentPaymentRef(db, studentId, reference).set({ status: 'failed', updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true })];
        if (reservedDiscount) cleanup.push(transitionDiscountRedemptionForPayment({ db, code: reservedDiscount.code, reference, status: 'failed' }));
        await Promise.all(cleanup);
      }
      throw error;
    }

    await studentPaymentRef(db, studentId, reference).set({
      reference,
      studentId,
      payerId,
      parentId: isParent ? payerId : null,
      email,
      status: 'initialized',
      ...(appliedDiscount ? {
        authorizationOnly: requiresAuthorizationOnlyCharge,
        ...(requiresAuthorizationOnlyCharge ? { authorizationChargeAmount } : {}),
        subscriptionAmountDue,
        originalAmount: appliedDiscount.originalAmount,
        discountAmount: appliedDiscount.discountAmount,
        discountPercent: appliedDiscount.percentOff,
        discountCode: appliedDiscount.code,
        discountBillingDuration: appliedDiscount.billingDuration,
        ...(appliedDiscount.discountRedemptionReference ? {
          discountRedemptionReference: appliedDiscount.discountRedemptionReference,
          discountReservationStatus: appliedDiscount.reservationStatus,
        } : {}),
        ...(appliedDiscount.billingDuration === 'fixed_months' ? {
          discountDurationMonths: appliedDiscount.discountDurationMonths,
          discountEndsAt: appliedDiscount.discountEndsAt || null,
          discountStartedAt: appliedDiscount.discountStartedAt || null,
        } : {}),
      } : {}),
      currency: 'ZAR',
      ...quote,
      amount: transactionAmount,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    const nextAuthorizationCharge = requiresAuthorizationOnlyCharge
      ? getNextActualSubscriptionCharge({
        baseAmount: quote.amount,
        percentOff: appliedDiscount.percentOff,
        billingDuration: appliedDiscount.billingDuration,
        discountDurationMonths: appliedDiscount.discountDurationMonths,
        billingCycleDays: quote.billingCycleDays,
      })
      : null;

    return {
      authorizationUrl: transaction.authorization_url,
      accessCode: transaction.access_code,
      reference,
      quote,
      ...(requiresAuthorizationOnlyCharge ? {
        requiresAuthorizationDisclosure: true,
        authorizationOnly: true,
        authorizationChargeAmount,
        subscriptionAmountDue,
        nextBillingDate: nextAuthorizationCharge.nextBillingDate?.toISOString?.() ?? null,
        nextBillingAmount: nextAuthorizationCharge.nextBillingAmount,
        ...(nextAuthorizationCharge.noNextChargeWhileOfferApplies ? { noNextChargeWhileOfferApplies: true } : {}),
      } : {}),
      ...(appliedDiscount ? { discount: appliedDiscount } : {}),
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
  const subscriptionRef = studentSubscriptionRef(db, studentId);
  const userRef = db.collection('users').doc(studentId);
  const authorizationSnapshot = await studentAuthorizationRef(db, studentId).get();
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
    const pendingPaymentRef = pendingReference ? studentPaymentRef(db, studentId, pendingReference) : null;
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
      return {
        action, cancelled: true, renewalDate: renewalDate?.toISOString?.() ?? null,
        discountCode: subscription.pendingPlan?.discountCode ?? null,
        discountRedemptionReference: subscription.pendingPlan?.discountRedemptionReference ?? null,
      };
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
      return {
        action, graceEnded: true, pendingReference,
        discountCode: subscription.pendingPlan?.discountCode ?? null,
        discountRedemptionReference: subscription.pendingPlan?.discountRedemptionReference ?? null,
      };
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
    return {
      action, cancelled: true, renewalDate: renewalDate.toISOString(),
      discountCode: subscription.pendingPlan?.discountCode ?? null,
      discountRedemptionReference: subscription.pendingPlan?.discountRedemptionReference ?? null,
    };
  });

  if (result.discountRedemptionReference) {
    await transitionDiscountRedemptionForPayment({
      db, code: result.discountCode, reference: result.discountRedemptionReference, status: 'cancelled',
    });
  }
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

export const cancelPaystackCheckout = onCall({ cpu: 'gcf_gen1' }, async (request) => {
  const payerId = request.auth?.uid;
  const { studentId, reference } = request.data ?? {};
  if (!payerId) throw new HttpsError('unauthenticated', 'Sign in before cancelling checkout.');
  if (!studentId || !reference) throw new HttpsError('invalid-argument', 'studentId and reference are required.');
  const db = getDb();
  await assertCanManageStudentSubscription({ db, payerId, studentId });
  const paymentRef = studentPaymentRef(db, studentId, reference);
  const result = await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(paymentRef);
    if (!snapshot.exists) throw new HttpsError('not-found', 'The pending checkout was not found.');
    const payment = snapshot.data();
    if (payment.payerId !== payerId) throw new HttpsError('permission-denied', 'This checkout belongs to another account.');
    if (payment.checkoutCancellationRequested === true) return { cancelled: true };
    if (payment.status === 'success') return { cancelled: false, paymentSucceeded: true };
    if (!['initializing', 'initialized', 'pending', 'processing', 'ongoing'].includes(payment.status)) {
      throw new HttpsError('failed-precondition', 'This checkout can no longer be cancelled.');
    }
    transaction.set(paymentRef, {
      checkoutCancellationRequested: true,
      checkoutCancellationRequestedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    return {
      cancelled: true,
    };
  });
  return result;
});

const finalizePaystackPayment = async ({ reference, studentId, payerId }) => {
  const db = getDb();
  const paymentRef = studentPaymentRef(db, studentId, reference);
  const paymentSnapshot = await paymentRef.get();
  if (!paymentSnapshot.exists) throw new HttpsError('not-found', 'Payment record not found.');
  const payment = paymentSnapshot.data();
  if (payment.payerId !== payerId) throw new HttpsError('permission-denied', 'This payment belongs to another account.');
  if (payment.status === 'success') {
    const existingAuthorization = await studentAuthorizationRef(db, studentId).get();
    const authorizationStored = isReusableAuthorization(existingAuthorization.data());
    if (payment.discountCode && payment.discountReservationStatus !== 'scheduled') {
      await transitionDiscountRedemptionForPayment({
        db,
        code: payment.discountCode,
        reference: payment.discountRedemptionReference || reference,
        status: 'success',
      }).catch((error) => {
        logger.error('Could not repair a redeemed discount after an idempotent payment verification', {
          studentId, reference, code: payment.discountCode, error: error?.message ?? String(error),
        });
      });
    }
    const refund = payment.authorizationOnly === true
      ? await requestAuthorizationRefund({ db, studentId, reference })
      : null;
    return {
      status: 'success', reference, authorizationStored,
      ...(payment.authorizationOnly ? {
        authorizationOnly: true,
        refundStatus: refund?.refundStatus ?? payment.authorizationRefundStatus ?? 'pending',
        manualPaymentRequired: !authorizationStored,
      } : {}),
    };
  }
  if (['failed', 'abandoned', 'reversed', 'amount_mismatch', 'cancelled'].includes(payment.status)) {
    return { status: payment.status, reference, authorizationStored: false };
  }
  if (!['initializing', 'initialized', 'pending', 'processing', 'ongoing'].includes(payment.status) || !payment.planId || !payment.studentId) {
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

  const discount = payment.discountPercent
    ? calculateDiscount(quote.amount, Number(payment.discountPercent))
    : null;
  const expectedSubscriptionAmount = Number.isFinite(Number(payment.subscriptionAmountDue))
    ? Number(payment.subscriptionAmountDue)
    : (discount?.finalAmount ?? quote.amount);
  const expectedTransactionAmount = payment.authorizationOnly === true
    ? Number(payment.authorizationChargeAmount)
    : expectedSubscriptionAmount;
  if (!Number.isFinite(expectedTransactionAmount) || expectedTransactionAmount < 0) {
    throw new HttpsError('failed-precondition', 'The saved payment amount is invalid. Please start a new checkout.');
  }

  const transaction = await paystackRequest({
    path: `/transaction/verify/${reference}`,
    method: 'GET',
  });

  if (transaction.status === 'success' && (transaction.reference !== reference
    || Number(transaction.amount) !== toMinorUnits(expectedTransactionAmount)
    || transaction.currency !== quote.currency)) {
    await paymentRef.set({ status: 'amount_mismatch', updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    throw new HttpsError('failed-precondition', 'The verified payment does not match this subscription price.');
  }

  const authorization = transaction.authorization ?? null;
  const succeeded = transaction.status === 'success';
  const reusableAuthorization = Boolean(authorization?.authorization_code && authorization.reusable);
  const activationDate = succeeded && transaction.paid_at && !Number.isNaN(new Date(transaction.paid_at).getTime())
    ? new Date(transaction.paid_at)
    : new Date();
  const activationTimestamp = succeeded ? admin.firestore.Timestamp.fromDate(activationDate) : null;
  const discountEndsAt = payment.discountBillingDuration === 'fixed_months' && discount
    ? (payment.discountEndsAt || (succeeded
      ? admin.firestore.Timestamp.fromDate(calculateDiscountEndAt(activationDate, payment.discountDurationMonths, quote.billingCycleDays))
      : null))
    : null;
  const nextRenewalDate = succeeded
    ? admin.firestore.Timestamp.fromDate(new Date(activationDate.getTime() + quote.billingCycleDays * 24 * 60 * 60 * 1000))
    : null;
  const batch = db.batch();
  batch.set(paymentRef, {
    reference,
    currency: transaction.currency ?? quote.currency,
    status: transaction.status,
    gatewayResponse: transaction.gateway_response,
    gatewayTransactionId: transaction.id ?? null,
    paidAt: transaction.paid_at ?? null,
    channel: transaction.channel ?? null,
    studentId: payment.studentId,
    payerId,
    email: transaction.customer?.email ?? payment.email,
    ...quote,
    amount: Number(transaction.amount ?? 0) / 100,
    subscriptionAmountDue: expectedSubscriptionAmount,
    ...(payment.authorizationOnly === true ? {
      authorizationOnly: true,
      authorizationChargeAmount: expectedTransactionAmount,
      ...(succeeded ? { authorizationRefundStatus: payment.authorizationRefundStatus || 'pending_initiation' } : {}),
    } : {}),
    ...(discount ? {
      originalAmount: discount.originalAmount,
      discountAmount: discount.discountAmount,
      discountPercent: Number(payment.discountPercent),
      discountCode: payment.discountCode,
      discountBillingDuration: payment.discountBillingDuration,
      ...(payment.discountBillingDuration === 'fixed_months' ? {
        discountDurationMonths: payment.discountDurationMonths,
        discountEndsAt,
        discountStartedAt: payment.discountStartedAt || activationTimestamp,
      } : {}),
    } : {}),
    ...(succeeded ? { finalizedAt: admin.firestore.FieldValue.serverTimestamp() } : {}),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });

  let displacedPendingDiscount = null;
  let reusableAuthorizationAvailable = reusableAuthorization;
  if (succeeded) {
    const subscriptionRef = studentSubscriptionRef(db, payment.studentId);
    const authorizationRef = studentAuthorizationRef(db, payment.studentId);
    const [currentSubscriptionSnapshot, currentAuthorizationSnapshot] = await Promise.all([
      subscriptionRef.get(), authorizationRef.get(),
    ]);
    const currentSubscription = currentSubscriptionSnapshot.exists ? currentSubscriptionSnapshot.data() : null;
    const currentAuthorization = currentAuthorizationSnapshot.exists ? currentAuthorizationSnapshot.data() : null;
    reusableAuthorizationAvailable = reusableAuthorization || isReusableAuthorization(currentAuthorization);
    const subscriptionForQuota = {
      ...quote, status: 'active', latestReference: reference,
      renewalDate: nextRenewalDate, entitlementWindowStartAt: activationTimestamp,
      activatedAt: activationTimestamp, renewedAt: activationTimestamp,
    };
    const activeSubjectQuotas = await getActiveSubjectLessonQuotaUpdates({
      db, studentId: payment.studentId, subscription: subscriptionForQuota,
      carryForward: false, windowStartAt: activationTimestamp,
      renewalDate: nextRenewalDate, cycleId: reference, updatedAt: activationTimestamp,
    });
    const oldPendingReference = currentSubscription?.pendingPlanReference;
    if (oldPendingReference && oldPendingReference !== reference) {
      const oldPendingPlan = currentSubscription?.pendingPlan;
      const pendingWasApplied = oldPendingPlan?.planId === quote.planId
        && oldPendingPlan?.billingPeriod === quote.billingPeriod
        && Number(oldPendingPlan?.subjectCount) === Number(quote.subjectCount)
        && (!oldPendingPlan?.discountRedemptionReference
          || oldPendingPlan.discountRedemptionReference === payment.discountRedemptionReference);
      if (!pendingWasApplied && oldPendingPlan?.discountRedemptionReference) {
        displacedPendingDiscount = oldPendingPlan;
      }
      batch.set(studentPaymentRef(db, payment.studentId, oldPendingReference), {
        status: pendingWasApplied ? 'applied' : 'cancelled',
        ...(pendingWasApplied ? { appliedAt: admin.firestore.FieldValue.serverTimestamp() } : { cancelledAt: admin.firestore.FieldValue.serverTimestamp() }),
      }, { merge: true });
    }
    if (reusableAuthorization) {
      batch.set(authorizationRef, {
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

    batch.set(subscriptionRef, {
      studentId: payment.studentId,
      status: 'active',
      ...quote,
      amount: expectedSubscriptionAmount,
      ...(discount ? {
        originalAmount: discount.originalAmount,
        discountAmount: discount.discountAmount,
        discountPercent: Number(payment.discountPercent),
        discountCode: payment.discountCode,
        discountBillingDuration: payment.discountBillingDuration,
        ...(payment.discountBillingDuration === 'fixed_months' ? {
          discountDurationMonths: payment.discountDurationMonths,
          discountEndsAt,
        } : {}),
        ...(['recurring', 'fixed_months'].includes(payment.discountBillingDuration) ? {
          discountBenefit: {
            code: payment.discountCode,
            percentOff: Number(payment.discountPercent),
            planId: quote.planId,
            billingPeriod: quote.billingPeriod,
            subjectCount: quote.subjectCount,
            activatedAt: payment.discountStartedAt || activationTimestamp,
            billingDuration: payment.discountBillingDuration,
            ...(payment.discountBillingDuration === 'fixed_months' ? {
              discountDurationMonths: payment.discountDurationMonths,
              discountEndsAt,
            } : {}),
          },
        } : { discountBenefit: admin.firestore.FieldValue.delete() }),
      } : {
        discountBenefit: admin.firestore.FieldValue.delete(),
        originalAmount: admin.firestore.FieldValue.delete(),
        discountAmount: admin.firestore.FieldValue.delete(),
        discountPercent: admin.firestore.FieldValue.delete(),
        discountCode: admin.firestore.FieldValue.delete(),
        discountBillingDuration: admin.firestore.FieldValue.delete(),
        discountDurationMonths: admin.firestore.FieldValue.delete(),
        discountEndsAt: admin.firestore.FieldValue.delete(),
        discountStartedAt: admin.firestore.FieldValue.delete(),
      }),
      latestReference: reference,
      activatedAt: activationTimestamp,
      entitlementWindowStartAt: activationTimestamp,
      renewedAt: activationTimestamp,
      renewalDate: nextRenewalDate,
      autoRenew: reusableAuthorizationAvailable,
      cancelAtPeriodEnd: false,
      manualPaymentRequired: !reusableAuthorizationAvailable,
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
    activeSubjectQuotas.forEach(({ ref, lessonQuota }) => batch.set(ref, { lessonQuota, updatedAt: activationTimestamp }, { merge: true }));
  }

  try {
    await batch.commit();
  } catch (error) {
    if (succeeded) {
      logger.error('Paystack succeeded but subscription finalization failed', {
        studentId, payerId, reference, planId: quote.planId,
        subjectCount: quote.subjectCount, amount: expectedSubscriptionAmount,
        error: error?.message ?? String(error),
      });
      throw new HttpsError('internal', `Payment succeeded but subscription activation could not be finalized. Retry verification for reference ${reference}; do not make another payment.`);
    }
    throw error;
  }

  if (payment.discountReservationStatus !== 'scheduled' || succeeded) {
    await transitionDiscountRedemptionForPayment({
      db, code: payment.discountCode,
      reference: payment.discountRedemptionReference || reference,
      status: transaction.status,
    }).catch((error) => {
      logger.error('Could not finalize the discount redemption after subscription activation', {
        studentId, reference, code: payment.discountCode, error: error?.message ?? String(error),
      });
    });
  }

  if (displacedPendingDiscount?.discountRedemptionReference) {
    await transitionDiscountRedemptionForPayment({
      db, code: displacedPendingDiscount.discountCode,
      reference: displacedPendingDiscount.discountRedemptionReference, status: 'cancelled',
    });
  }

  const authorizationRefund = succeeded && payment.authorizationOnly === true
    ? await requestAuthorizationRefund({ db, studentId: payment.studentId, reference })
    : null;
  const nextActualCharge = succeeded && payment.authorizationOnly === true
    ? getNextActualSubscriptionCharge({
      baseAmount: quote.amount,
      percentOff: Number(payment.discountPercent),
      billingDuration: payment.discountBillingDuration,
      discountDurationMonths: payment.discountDurationMonths,
      billingCycleDays: quote.billingCycleDays,
      activationDate,
    })
    : null;
  return {
    status: transaction.status,
    reference,
    authorizationStored: reusableAuthorizationAvailable,
    ...(payment.authorizationOnly === true ? {
      authorizationOnly: true,
      refundStatus: authorizationRefund?.refundStatus ?? 'pending',
      nextBillingDate: nextActualCharge?.nextBillingDate?.toISOString?.() ?? null,
      nextBillingAmount: nextActualCharge?.nextBillingAmount ?? null,
      manualPaymentRequired: !reusableAuthorizationAvailable,
      ...(nextActualCharge?.noNextChargeWhileOfferApplies ? { noNextChargeWhileOfferApplies: true } : {}),
    } : {}),
  };
};

export const verifyPaystackTransaction = onCall({ cpu: 'gcf_gen1' }, async (request) => {
  const { reference, studentId } = request.data ?? {};
  const payerId = request.auth?.uid;
  if (!payerId) throw new HttpsError('unauthenticated', 'Sign in to verify your payment.');
  if (!reference || !studentId) {
    throw new HttpsError('invalid-argument', 'reference and studentId are required.');
  }
  const db = getDb();
  await assertCanManageStudentSubscription({ db, payerId, studentId });
  return finalizePaystackPayment({ reference, studentId, payerId });
});

const findPaymentForWebhook = async ({ db, transactionReference, gatewayTransactionId }) => {
  if (transactionReference) {
    const byReference = await db.collectionGroup('payments')
      .where('reference', '==', transactionReference).limit(1).get();
    if (!byReference.empty) return byReference.docs[0];
  }
  if (gatewayTransactionId !== null && gatewayTransactionId !== undefined) {
    const byGatewayId = await db.collectionGroup('payments')
      .where('gatewayTransactionId', '==', Number(gatewayTransactionId)).limit(1).get();
    if (!byGatewayId.empty) return byGatewayId.docs[0];
  }
  return null;
};

const processPaystackWebhookEvent = async ({ db, event }) => {
  const data = event.data ?? {};
  if (event.event === 'charge.success') {
    const reference = String(data.reference ?? '').trim();
    if (!reference) throw new Error('The charge.success event has no transaction reference.');
    const paymentSnapshot = await findPaymentForWebhook({ db, transactionReference: reference });
    if (!paymentSnapshot) throw new Error(`Payment record for ${reference} has not been created yet.`);
    const payment = paymentSnapshot.data();
    const result = await finalizePaystackPayment({
      reference,
      studentId: payment.studentId || paymentSnapshot.ref.parent.parent?.id,
      payerId: payment.payerId,
    });
    if (result.status !== 'success') {
      throw new Error(`Paystack verification for ${reference} is still ${result.status}.`);
    }
    return { status: 'processed', result: 'payment_finalized' };
  }

  const refundStatusByEvent = {
    'refund.pending': 'pending',
    'refund.processing': 'processing',
    'refund.processed': 'processed',
    'refund.failed': 'failed',
  };
  const refundStatus = refundStatusByEvent[event.event];
  if (!refundStatus) return { status: 'ignored', result: 'unsupported_event' };

  const transactionReference = typeof data.transaction === 'object'
    ? data.transaction?.reference
    : (typeof data.reference === 'string' ? data.reference : null);
  const gatewayTransactionId = typeof data.transaction === 'object'
    ? data.transaction?.id
    : data.transaction;
  const paymentSnapshot = await findPaymentForWebhook({ db, transactionReference, gatewayTransactionId });
  if (!paymentSnapshot) throw new Error('Could not match the refund event to a payment record.');
  const payment = paymentSnapshot.data();
  if (payment.authorizationOnly !== true) return { status: 'ignored', result: 'not_authorization_payment' };

  await db.runTransaction(async (transaction) => {
    const freshSnapshot = await transaction.get(paymentSnapshot.ref);
    if (!freshSnapshot.exists || freshSnapshot.data()?.authorizationOnly !== true) return;
    const existingStatus = freshSnapshot.data()?.authorizationRefundStatus;
    if (existingStatus === 'processed' || existingStatus === 'success') return;
    transaction.set(paymentSnapshot.ref, {
      authorizationRefundStatus: refundStatus,
      authorizationRefundProviderStatus: refundStatus,
      authorizationRefundId: data.id ?? freshSnapshot.data()?.authorizationRefundId ?? null,
      authorizationRefundAmount: Number.isFinite(Number(data.amount)) ? Number(data.amount) / 100 : null,
      authorizationRefundCurrency: data.currency ?? freshSnapshot.data()?.authorizationRefundCurrency ?? 'ZAR',
      authorizationRefundUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
      ...(refundStatus === 'failed' ? { authorizationRefundError: data.message ?? 'Paystack reported that the refund failed.' } : { authorizationRefundError: admin.firestore.FieldValue.delete() }),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
  });
  return { status: 'processed', result: `refund_${refundStatus}` };
};

export const paystackWebhook = onRequest({ cpu: 'gcf_gen1', invoker: 'public', timeoutSeconds: 60 }, async (request, response) => {
  if (request.method !== 'POST') {
    response.status(405).send('Method not allowed');
    return;
  }
  const { paystackSecretKey } = getPaystackConfig();
  if (!paystackSecretKey) {
    logger.error('Paystack webhook cannot validate signatures because PAYSTACK_SECRET_KEY is not configured.');
    response.status(500).send('Webhook is not configured');
    return;
  }
  const rawBody = request.rawBody;
  const signature = String(request.get('x-paystack-signature') ?? '');
  if (!Buffer.isBuffer(rawBody) || !/^[a-f0-9]{128}$/i.test(signature)) {
    response.status(401).send('Invalid Paystack signature');
    return;
  }
  const expected = createHmac('sha512', paystackSecretKey).update(rawBody).digest();
  const supplied = Buffer.from(signature, 'hex');
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
    response.status(401).send('Invalid Paystack signature');
    return;
  }

  const event = request.body;
  if (!event || !['charge.success', 'refund.pending', 'refund.processing', 'refund.processed', 'refund.failed'].includes(event.event)) {
    response.status(200).send('Event ignored');
    return;
  }
  try {
    const digest = createHash('sha256').update(rawBody).digest('hex');
    const eventRef = getDb().collection('paystackWebhookEvents').doc(digest);
    await getDb().runTransaction(async (transaction) => {
      const existing = await transaction.get(eventRef);
      const data = event.data ?? {};
      const queuedEvent = {
        event: event.event,
        transactionReference: data.reference ?? (typeof data.transaction === 'object' ? data.transaction?.reference : null) ?? null,
        gatewayTransactionId: (typeof data.transaction === 'object' ? data.transaction?.id : data.transaction) ?? null,
        refundId: data.id ?? null,
        data: {
          reference: data.reference ?? null,
          transaction: typeof data.transaction === 'object'
            ? { reference: data.transaction?.reference ?? null, id: data.transaction?.id ?? null }
            : data.transaction ?? null,
          id: data.id ?? null,
          amount: data.amount ?? null,
          currency: data.currency ?? null,
          status: data.status ?? null,
          message: data.message ?? null,
        },
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };
      if (existing.exists) {
        if (existing.data()?.status === 'needs-attention') {
          transaction.set(eventRef, {
            ...queuedEvent, status: 'pending', attempts: 0,
            lastError: admin.firestore.FieldValue.delete(),
          }, { merge: true });
        }
        return;
      }
      transaction.create(eventRef, {
        ...queuedEvent,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        status: 'pending',
        attempts: 0,
      });
    });
    response.status(200).send('Event accepted');
  } catch (error) {
    logger.error('Could not queue signed Paystack webhook event', { error: error?.message ?? String(error) });
    response.status(500).send('Could not queue event');
  }
});

export const processPaystackWebhookEvents = onSchedule(
  { schedule: 'every 1 minutes', timeZone: 'UTC', cpu: 'gcf_gen1' },
  async () => {
    const db = getDb();
    const pending = await db.collection('paystackWebhookEvents')
      .where('status', '==', 'pending').limit(100).get();
    for (const snapshot of pending.docs) {
      try {
        const result = await processPaystackWebhookEvent({ db, event: snapshot.data() });
        await snapshot.ref.set({ ...result, processedAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      } catch (error) {
        const attempts = Number(snapshot.data().attempts || 0) + 1;
        const exhausted = attempts >= 72;
        logger.error('Paystack webhook event processing failed', {
          eventId: snapshot.id, event: snapshot.data().event, attempts,
          error: error?.message ?? String(error),
        });
        await snapshot.ref.set({
          attempts,
          ...(exhausted ? { status: 'needs-attention' } : {}),
          lastError: String(error?.message ?? error).slice(0, 500),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
      }
    }
  },
);

export const retryAuthorizationRefunds = onSchedule(
  { schedule: 'every 30 minutes', timeZone: 'UTC', cpu: 'gcf_gen1' },
  async () => {
    const db = getDb();
    const snapshot = await db.collectionGroup('payments')
      .where('authorizationOnly', '==', true).limit(500).get();
    for (const paymentSnapshot of snapshot.docs) {
      const payment = paymentSnapshot.data();
      const refundStatus = payment.authorizationRefundStatus;
      const attemptedAt = payment.authorizationRefundAttemptedAt?.toDate?.();
      const staleRequest = refundStatus === 'requesting'
        && (!attemptedAt || Date.now() - attemptedAt.getTime() >= 10 * 60 * 1000);
      const safelyRetryable = ['pending_initiation', 'failed'].includes(refundStatus) || staleRequest;
      if (!safelyRetryable || payment.status !== 'success'
        || Number(payment.authorizationRefundAttempts || 0) >= MAX_AUTHORIZATION_REFUND_ATTEMPTS) continue;
      const studentId = payment.studentId || paymentSnapshot.ref.parent.parent?.id;
      const reference = payment.reference || paymentSnapshot.id;
      if (!studentId || !reference) continue;
      await requestAuthorizationRefund({ db, studentId, reference });
    }
  },
);

export const reconcileUnfinalizedPaystackPayments = onSchedule(
  { schedule: 'every 15 minutes', timeZone: 'UTC', cpu: 'gcf_gen1' },
  async () => {
    const db = getDb();
    const pending = await db.collectionGroup('payments')
      .where('status', 'in', ['initializing', 'initialized', 'pending', 'processing', 'ongoing'])
      .limit(500).get();
    const cutoff = Date.now() - 5 * 60 * 1000;
    for (const paymentSnapshot of pending.docs) {
      const payment = paymentSnapshot.data();
      if (payment.recurring === true) continue;
      const createdAt = payment.createdAt?.toDate?.()?.getTime?.();
      if (createdAt && createdAt > cutoff) continue;
      const studentId = payment.studentId || paymentSnapshot.ref.parent.parent?.id;
      const payerId = payment.payerId;
      const reference = payment.reference || paymentSnapshot.id;
      if (!studentId || !payerId || !reference || !payment.planId || !payment.billingPeriod) continue;
      try {
        await paymentSnapshot.ref.set({
          reconciliationAttempts: admin.firestore.FieldValue.increment(1),
          lastReconciliationAttemptAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
        const result = await finalizePaystackPayment({ reference, studentId, payerId });
        logger.info('Reconciled a pending Paystack checkout', { studentId, reference, status: result.status });
      } catch (error) {
        logger.error('Could not reconcile a pending Paystack checkout', {
          studentId, reference, error: error?.message ?? String(error),
        });
      }
    }
  },
);

export const getAdminAuthorizationRefundIssues = onCall({ cpu: 'gcf_gen1' }, async (request) => {
  const startedAt = Date.now();
  const metrics = { firestoreReadOperations: 0, firestoreDocumentsReturned: 0 };
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in as an admin to review authorization refunds.');
  const db = getDb();
  metrics.firestoreReadOperations += 1;
  const adminSnapshot = await db.collection('users').doc(uid).get();
  metrics.firestoreDocumentsReturned += adminSnapshot.exists ? 1 : 0;
  if (!adminSnapshot.exists || adminSnapshot.data()?.role !== 'admin') {
    throw new HttpsError('permission-denied', 'Only an admin can review authorization refunds.');
  }
  metrics.firestoreReadOperations += 1;
  const snapshot = await db.collectionGroup('payments').where('authorizationOnly', '==', true).limit(500).get();
  metrics.firestoreDocumentsReturned += snapshot.size;
  const now = Date.now();
  const issues = snapshot.docs.map((paymentSnapshot) => {
    const payment = paymentSnapshot.data();
    const status = payment.authorizationRefundStatus || 'pending_initiation';
    const attemptedAt = payment.authorizationRefundAttemptedAt?.toDate?.() ?? null;
    const staleRequest = status === 'requesting' && (!attemptedAt || now - attemptedAt.getTime() >= 10 * 60 * 1000);
    if (!['failed', 'needs-attention', 'pending_initiation'].includes(status) && !staleRequest) return null;
    return {
      reference: payment.reference || paymentSnapshot.id,
      studentId: payment.studentId || paymentSnapshot.ref.parent.parent?.id || null,
      email: payment.email || null,
      status,
      amount: Number(payment.authorizationChargeAmount || 1),
      refundStatus: status,
      attempts: Number(payment.authorizationRefundAttempts || 0),
      error: payment.authorizationRefundError || null,
      transactionStatus: payment.status || null,
      updatedAt: payment.updatedAt?.toDate?.().toISOString?.() ?? null,
    };
  }).filter(Boolean);
  logger.info('Admin authorization refund issues loaded', {
    durationMs: Date.now() - startedAt,
    ...metrics,
    issuesReturned: issues.length,
  });
  return { issues };
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
  const subscriptionRef = studentSubscriptionRef(db, studentId);
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
        ...(subscriptionQuote.discountPercent ? {
          originalAmount: subscriptionQuote.originalAmount,
          discountAmount: subscriptionQuote.discountAmount,
          discountPercent: subscriptionQuote.discountPercent,
          discountCode: subscriptionQuote.discountCode,
          discountBillingDuration: subscriptionQuote.discountBillingDuration,
          ...(subscriptionQuote.discountBillingDuration === 'fixed_months' ? {
            discountDurationMonths: subscriptionQuote.discountDurationMonths,
            discountEndsAt: subscriptionQuote.discountEndsAt,
            discountStartedAt: subscriptionQuote.discountBenefit?.activatedAt ?? null,
          } : {}),
          ...(subscriptionQuote.discountRedemptionReference ? {
            discountRedemptionReference: subscriptionQuote.discountRedemptionReference,
          } : {}),
        } : {}),
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
              groupLessonsPerWindow: subscriptionQuote.groupLessonsPerWindow,
              oneOnOneLessonsPerWindow: subscriptionQuote.oneOnOneLessonsPerWindow,
              sessionsPerWindow: subscriptionQuote.sessionsPerWindow,
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
    const renewalActivationDate = succeeded && charge.paid_at && !Number.isNaN(new Date(charge.paid_at).getTime())
      ? new Date(charge.paid_at)
      : new Date();
    const renewalActivationAt = succeeded ? admin.firestore.Timestamp.fromDate(renewalActivationDate) : null;
    const nextRenewalDate = succeeded ? admin.firestore.Timestamp.fromDate(
        new Date(renewalActivationDate.getTime() + subscriptionQuote.billingCycleDays * 24 * 60 * 60 * 1000)
      ) : null;
    const batch = db.batch();
    batch.set(studentPaymentRef(db, studentId, claim.reference), {
      reference: claim.reference,
      studentId,
      payerId: claim.payerId,
      parentId: claim.payerId === studentId ? null : claim.payerId,
      email: claim.email,
      currency: charge.currency ?? subscriptionQuote.currency,
      status: amountMismatch ? 'amount_mismatch' : succeeded ? 'success' : outcomeUnknown ? 'processing' : (charge.status || 'failed'),
      recurring: true,
      attemptNumber: claim.attemptNumber,
      gatewayResponse: charge.gateway_response ?? null,
      paidAt: charge.paid_at ?? null,
      ...subscriptionQuote,
      amount: Number(charge.amount ?? Math.round(amount * 100)) / 100,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      ...(claim.resumeAttempt ? {} : { createdAt: admin.firestore.FieldValue.serverTimestamp() }),
    }, { merge: true });

    if (succeeded) {
      const renewedSubscriptionForQuota = {
        ...subscriptionQuote, status: 'active', latestReference: claim.reference,
        renewalDate: nextRenewalDate, entitlementWindowStartAt: renewalActivationAt,
        activatedAt: renewalActivationAt, renewedAt: renewalActivationAt,
      };
      const renewedSubjectQuotas = await getActiveSubjectLessonQuotaUpdates({
        db, studentId, subscription: renewedSubscriptionForQuota,
        carryForward: true, windowStartAt: renewalActivationAt,
        renewalDate: nextRenewalDate, cycleId: claim.reference, updatedAt: renewalActivationAt,
      });
      const scheduledDiscountBenefit = subscriptionQuote.discountRedemptionReference
        && ['recurring', 'fixed_months'].includes(subscriptionQuote.discountBillingDuration)
        ? {
          code: subscriptionQuote.discountCode,
          percentOff: subscriptionQuote.discountPercent,
          planId: subscriptionQuote.planId,
          billingPeriod: subscriptionQuote.billingPeriod,
          subjectCount: subscriptionQuote.subjectCount,
          billingDuration: subscriptionQuote.discountBillingDuration,
          activatedAt: renewalActivationAt,
          ...(subscriptionQuote.discountBillingDuration === 'fixed_months' ? {
            discountDurationMonths: subscriptionQuote.discountDurationMonths,
            discountEndsAt: admin.firestore.Timestamp.fromDate(calculateDiscountEndAt(
              renewalActivationDate, subscriptionQuote.discountDurationMonths, subscriptionQuote.billingCycleDays,
            )),
          } : {}),
        }
        : null;
      const activeDiscountBenefit = scheduledDiscountBenefit || subscriptionQuote.discountBenefit || null;
      batch.set(subscriptionRef, {
        studentId,
        status: 'active',
        ...subscriptionQuote,
        latestReference: claim.reference,
        amount,
        currency: subscriptionQuote.currency,
        activatedAt: renewalActivationAt,
        entitlementWindowStartAt: renewalActivationAt,
        renewedAt: renewalActivationAt,
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
        discountBenefit: subscriptionQuote.discountPercent && ['recurring', 'fixed_months'].includes(subscriptionQuote.discountBillingDuration)
          ? activeDiscountBenefit
          : admin.firestore.FieldValue.delete(),
        discountRedemptionReference: admin.firestore.FieldValue.delete(),
        ...(!subscriptionQuote.discountPercent ? {
          originalAmount: admin.firestore.FieldValue.delete(),
          discountAmount: admin.firestore.FieldValue.delete(),
          discountPercent: admin.firestore.FieldValue.delete(),
          discountCode: admin.firestore.FieldValue.delete(),
          discountBillingDuration: admin.firestore.FieldValue.delete(),
          discountDurationMonths: admin.firestore.FieldValue.delete(),
          discountEndsAt: admin.firestore.FieldValue.delete(),
          discountStartedAt: admin.firestore.FieldValue.delete(),
        } : {}),
      }, { merge: true });
      if (claim.pendingPlanReference) {
        batch.set(studentPaymentRef(db, studentId, claim.pendingPlanReference), {
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
      renewedSubjectQuotas.forEach(({ ref, lessonQuota }) => batch.set(ref, { lessonQuota, updatedAt: renewalActivationAt }, { merge: true }));
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
        ...(subscriptionQuote.discountPercent ? {
          originalAmount: subscriptionQuote.originalAmount,
          discountAmount: subscriptionQuote.discountAmount,
          discountPercent: subscriptionQuote.discountPercent,
          discountCode: subscriptionQuote.discountCode,
          discountBillingDuration: subscriptionQuote.discountBillingDuration,
          ...(subscriptionQuote.discountBillingDuration === 'fixed_months' ? {
            discountDurationMonths: subscriptionQuote.discountDurationMonths,
            discountEndsAt: subscriptionQuote.discountEndsAt,
            discountStartedAt: subscriptionQuote.discountBenefit?.activatedAt ?? null,
          } : {}),
          ...(subscriptionQuote.discountRedemptionReference ? {
            discountRedemptionReference: subscriptionQuote.discountRedemptionReference,
          } : {}),
        } : {}),
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

    if (succeeded && subscriptionQuote.discountRedemptionReference) {
      await transitionDiscountRedemptionForPayment({
        db, code: subscriptionQuote.discountCode,
        reference: subscriptionQuote.discountRedemptionReference, status: 'success',
      });
    }

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
    studentSubscriptionRef(db, studentId).get(),
    studentAuthorizationRef(db, studentId).get(),
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

  const selectedPlan = inFlightAttempt && subscription.renewalAttempt.planId
    ? subscription.renewalAttempt
    : subscription.pendingPlan?.planId ? subscription.pendingPlan : subscription;
  let subscriptionQuote;
  try {
    const baseQuote = calculateSubscriptionQuote({
      planId: selectedPlan.planId,
      billingPeriod: selectedPlan.billingPeriod,
      subjectCount: selectedPlan.subjectCount,
    });
    const recurringBenefit = inFlightAttempt && subscription.renewalAttempt.discountPercent
      ? {
        code: subscription.renewalAttempt.discountCode,
        percentOff: subscription.renewalAttempt.discountPercent,
        planId: subscription.renewalAttempt.planId,
        billingPeriod: subscription.renewalAttempt.billingPeriod,
        subjectCount: subscription.renewalAttempt.subjectCount,
        billingDuration: subscription.renewalAttempt.discountBillingDuration || 'recurring',
        discountDurationMonths: subscription.renewalAttempt.discountDurationMonths,
        discountEndsAt: subscription.renewalAttempt.discountEndsAt,
        activatedAt: subscription.renewalAttempt.discountStartedAt,
      }
      : subscription.discountBenefit;
    subscriptionQuote = applyRecurringDiscount(baseQuote, recurringBenefit, selectedPlan, dueDate);
    if (inFlightAttempt && subscription.renewalAttempt?.discountRedemptionReference) {
      subscriptionQuote = applyScheduledDiscount(baseQuote, subscription.renewalAttempt);
    }
  } catch {
    throw new HttpsError('failed-precondition', 'The saved subscription selection cannot be renewed.');
  }

  if (subscriptionQuote.amount === 0 && subscriptionQuote.discountPercent === 100
    && (subscriptionQuote.discountRedemptionReference
      || ['recurring', 'fixed_months'].includes(subscriptionQuote.discountBillingDuration))) {
    const zeroRenewal = await applyZeroCostSubscriptionRenewal({
      studentId, quote: subscriptionQuote, renewalDate: subscription.renewalDate,
    });
    return { status: 'success', charged: false, ...zeroRenewal };
  }
  if (!inFlightAttempt && (!authorization || authorization.reusable !== true || !authorization.authorizationCode || !authorization.email)) {
    throw new HttpsError('failed-precondition', 'A reusable payment authorization is required for renewal.');
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
