import { randomInt } from 'node:crypto';

export const DISCOUNT_CODE_LENGTH = 10;
const CODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
export const DISCOUNT_BILLING_DURATIONS = ['first_payment', 'fixed_months', 'recurring'];
export const DISCOUNT_PLAN_IDS = ['circle', 'personalized'];
export const MAX_FIXED_DISCOUNT_MONTHS = 24;
export const MAX_REDEMPTION_WINDOW_MONTHS = 120;

export const normalizeDiscountCode = (value) => String(value ?? '').trim().toUpperCase();

export const generateDiscountCode = (length = DISCOUNT_CODE_LENGTH) => Array.from(
  { length },
  () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)],
).join('');

const toDate = (value) => {
  if (value instanceof Date) return value;
  if (value?.toDate) return value.toDate();
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
};

export const addCalendarMonths = (value, months) => {
  const date = toDate(value);
  const count = Number(months);
  if (!date || !Number.isInteger(count) || count < 1) throw new Error('A valid date and positive month count are required.');
  const target = new Date(date);
  const originalDay = target.getUTCDate();
  target.setUTCDate(1);
  target.setUTCMonth(target.getUTCMonth() + count);
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(originalDay, lastDay));
  return target;
};

export const calculateDiscountEndAt = (startedAt, durationMonths, billingCycleDays = 30) => {
  const start = toDate(startedAt);
  const months = Number(durationMonths);
  const daysPerCycle = Number(billingCycleDays);
  if (!start || !Number.isInteger(months) || months < 1 || !Number.isFinite(daysPerCycle) || daysPerCycle <= 0) {
    throw new Error('A valid subscription start and discount duration are required.');
  }
  return new Date(start.getTime() + months * daysPerCycle * 24 * 60 * 60 * 1000);
};

export const getDiscountBillingPeriodError = ({ billingDuration, billingPeriod }) => (
  billingDuration === 'fixed_months' && billingPeriod !== 'monthly'
    ? 'Fixed-month discounts are available on monthly subscriptions only.'
    : null
);

export const validateDiscountSettings = (settings) => {
  const percentOff = Number(settings.percentOff);
  if (!Number.isInteger(percentOff) || percentOff < 1 || percentOff > 100) {
    throw new Error('Discount percentage must be a whole number from 1 to 100.');
  }

  const maxRedemptions = settings.maxRedemptions === null || settings.maxRedemptions === ''
    || settings.maxRedemptions === undefined
    ? null
    : Number(settings.maxRedemptions);
  if (maxRedemptions !== null && (!Number.isSafeInteger(maxRedemptions) || maxRedemptions < 1)) {
    throw new Error('Maximum redemptions must be a positive whole number or unlimited.');
  }

  const maxSubjectCount = settings.maxSubjectCount === null || settings.maxSubjectCount === ''
    || settings.maxSubjectCount === undefined
    ? null
    : Number(settings.maxSubjectCount);
  if (maxSubjectCount !== null
    && (!Number.isSafeInteger(maxSubjectCount) || maxSubjectCount < 1 || maxSubjectCount > 20)) {
    throw new Error('The subject limit must be a whole number from 1 to 20 or unlimited.');
  }

  const restrictedEmail = String(settings.restrictedEmail ?? '').trim().toLowerCase() || null;
  const restrictedAccountId = String(settings.restrictedAccountId ?? '').trim() || null;
  if (restrictedEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(restrictedEmail)) {
    throw new Error('Enter a valid email address for the email restriction.');
  }
  if (restrictedEmail && restrictedAccountId) {
    throw new Error('Restrict a code to one email or one account, not both.');
  }

  const eligiblePlans = settings.eligiblePlans === undefined
    ? [...DISCOUNT_PLAN_IDS]
    : settings.eligiblePlans;
  if (!Array.isArray(eligiblePlans)
    || eligiblePlans.length === 0
    || eligiblePlans.some((planId) => !DISCOUNT_PLAN_IDS.includes(planId))) {
    throw new Error('Choose Circle, Personalized, or both subscription plans for this code.');
  }
  const normalizedEligiblePlans = [...new Set(eligiblePlans)];

  const startsAt = toDate(settings.startsAt);
  const redemptionExpiryMode = settings.redemptionExpiryMode
    || (settings.expiresAt ? 'manual' : 'none');
  if (!['none', 'manual', 'after_start'].includes(redemptionExpiryMode)) {
    throw new Error('Choose no expiry, a manual expiry date, or a period after the start date.');
  }
  const redemptionWindowMonths = redemptionExpiryMode === 'after_start'
    ? Number(settings.redemptionWindowMonths)
    : null;
  if (redemptionExpiryMode === 'after_start'
    && (!Number.isInteger(redemptionWindowMonths) || redemptionWindowMonths < 1 || redemptionWindowMonths > MAX_REDEMPTION_WINDOW_MONTHS)) {
    throw new Error(`The code redemption window must be from 1 to ${MAX_REDEMPTION_WINDOW_MONTHS} months.`);
  }
  if (redemptionExpiryMode !== 'manual' && settings.expiresAt) {
    throw new Error('Manual expiry dates can only be used with the manual expiry option.');
  }
  let expiresAt = redemptionExpiryMode === 'manual' && settings.expiresAt ? toDate(settings.expiresAt) : null;
  if (!startsAt) throw new Error('A valid start date and time are required.');
  if (redemptionExpiryMode === 'manual' && settings.expiresAt && !expiresAt) throw new Error('Enter a valid expiry date and time.');
  if (redemptionExpiryMode === 'after_start') expiresAt = addCalendarMonths(startsAt, redemptionWindowMonths);
  if (expiresAt && expiresAt <= startsAt) throw new Error('Expiry must be later than the start date.');

  const billingDuration = settings.billingDuration;
  if (!DISCOUNT_BILLING_DURATIONS.includes(billingDuration)) {
    throw new Error('Choose whether the discount applies to the first payment, a fixed number of months, or recurring payments.');
  }
  const discountDurationMonths = billingDuration === 'fixed_months'
    ? Number(settings.discountDurationMonths)
    : null;
  if (billingDuration === 'fixed_months'
    && (!Number.isInteger(discountDurationMonths) || discountDurationMonths < 1 || discountDurationMonths > MAX_FIXED_DISCOUNT_MONTHS)) {
    throw new Error(`A fixed discount duration must be from 1 to ${MAX_FIXED_DISCOUNT_MONTHS} months.`);
  }
  if (billingDuration !== 'fixed_months' && settings.discountDurationMonths !== undefined
    && settings.discountDurationMonths !== null && settings.discountDurationMonths !== '') {
    throw new Error('A fixed discount month count can only be set for fixed-month discounts.');
  }

  return {
    percentOff, maxRedemptions, maxSubjectCount, restrictedEmail, restrictedAccountId, eligiblePlans: normalizedEligiblePlans, startsAt, expiresAt,
    redemptionExpiryMode, redemptionWindowMonths, billingDuration, discountDurationMonths,
  };
};

export const calculateDiscount = (baseAmount, percentOff) => {
  const originalAmount = Math.round(Number(baseAmount) * 100) / 100;
  if (!Number.isFinite(originalAmount) || originalAmount < 0) throw new Error('Subscription price is invalid.');
  if (!Number.isInteger(percentOff) || percentOff < 1 || percentOff > 100) throw new Error('Discount percentage is invalid.');
  const finalAmount = Math.round(originalAmount * (100 - percentOff)) / 100;
  return {
    originalAmount,
    discountAmount: Math.round((originalAmount - finalAmount) * 100) / 100,
    finalAmount: Math.max(0, finalAmount),
  };
};

export const applyRecurringDiscount = (quote, benefit, selectedPlan = quote, at = new Date()) => {
  const billingDuration = benefit?.billingDuration || 'recurring';
  const discountEndsAt = toDate(benefit?.discountEndsAt);
  const fixedDurationActive = billingDuration === 'fixed_months'
    && discountEndsAt
    && toDate(at)
    && toDate(at) < discountEndsAt;
  const durationActive = billingDuration === 'recurring' || fixedDurationActive;
  const matches = benefit
    && durationActive
    && benefit.planId === selectedPlan.planId
    && benefit.billingPeriod === selectedPlan.billingPeriod
    && Number(benefit.subjectCount) === Number(selectedPlan.subjectCount)
    && Number.isInteger(Number(benefit.percentOff))
    && Number(benefit.percentOff) >= 1
    && Number(benefit.percentOff) <= 100;
  if (!matches) return quote;
  const discount = calculateDiscount(quote.amount, Number(benefit.percentOff));
  return {
    ...quote,
    amount: discount.finalAmount,
    originalAmount: discount.originalAmount,
    discountAmount: discount.discountAmount,
    discountPercent: Number(benefit.percentOff),
    discountCode: benefit.code,
    discountBillingDuration: billingDuration,
    discountBenefit: {
      ...benefit,
      billingDuration,
      ...(billingDuration === 'fixed_months' ? {
        discountDurationMonths: Number(benefit.discountDurationMonths),
        discountEndsAt: benefit.discountEndsAt,
      } : {}),
    },
    ...(billingDuration === 'fixed_months' ? {
      discountDurationMonths: Number(benefit.discountDurationMonths),
      discountEndsAt: benefit.discountEndsAt,
    } : {}),
  };
};

export const applyScheduledDiscount = (quote, scheduledPlan) => {
  const reference = scheduledPlan?.discountRedemptionReference;
  const percentOff = Number(scheduledPlan?.discountPercent);
  if (!reference || !Number.isInteger(percentOff) || percentOff < 1 || percentOff > 100) return quote;
  const discount = calculateDiscount(quote.amount, percentOff);
  return {
    ...quote,
    ...discount,
    amount: discount.finalAmount,
    discountPercent: percentOff,
    discountCode: scheduledPlan.discountCode,
    discountBillingDuration: scheduledPlan.discountBillingDuration || 'first_payment',
    discountDurationMonths: scheduledPlan.discountDurationMonths ?? null,
    discountRedemptionReference: reference,
  };
};

export const getDiscountUseCounts = ({ successfulRedemptions = 0, reservedRedemptions = 0, maxRedemptions = null }) => {
  const successful = Math.max(0, Number(successfulRedemptions) || 0);
  const reserved = Math.max(0, Number(reservedRedemptions) || 0);
  const max = maxRedemptions === null || maxRedemptions === undefined ? null : Number(maxRedemptions);
  return {
    successfulRedemptions: successful,
    reservedRedemptions: reserved,
    remainingUses: max === null ? null : Math.max(0, max - successful - reserved),
    available: max === null || successful + reserved < max,
  };
};

export const getDiscountEligibilityError = ({ code, uid, email, planId, subjectCount, now = new Date(), previewOnly = false }) => {
  if (!code || code.active !== true) return 'This discount code is not active.';
  const startsAt = toDate(code.startsAt);
  const expiresAt = code.expiresAt ? toDate(code.expiresAt) : null;
  if (!startsAt || now < startsAt) return 'This discount code is not available yet.';
  if (expiresAt && now >= expiresAt) return 'This discount code has expired.';
  if (planId && DISCOUNT_PLAN_IDS.includes(planId)) {
    const eligiblePlans = code.eligiblePlans === undefined ? DISCOUNT_PLAN_IDS : code.eligiblePlans;
    if (!Array.isArray(eligiblePlans) || !eligiblePlans.includes(planId)) {
      const planName = planId === 'circle' ? 'Circle' : 'Personalized';
      return `This discount code is not available for ${planName} subscriptions.`;
    }
  }
  const maxSubjectCount = code.maxSubjectCount === null || code.maxSubjectCount === undefined
    ? null
    : Number(code.maxSubjectCount);
  if (maxSubjectCount !== null && Number(subjectCount) > maxSubjectCount) {
    return `This discount is limited to subscriptions with up to ${maxSubjectCount} subject${maxSubjectCount === 1 ? '' : 's'}.`;
  }
  if (!previewOnly) {
    if (code.restrictedEmail && String(email ?? '').trim().toLowerCase() !== String(code.restrictedEmail).trim().toLowerCase()) {
      return 'This discount code is not available for this email address.';
    }
    if (code.restrictedAccountId && uid !== code.restrictedAccountId) return 'This discount code is not available for this account.';
  }
  return null;
};

export const transitionRedemption = (status) => {
  if (status === 'success') return { status: 'redeemed', successfulDelta: 1, reservedDelta: -1 };
  if (['failed', 'abandoned', 'reversed', 'cancelled'].includes(status)) {
    return { status: 'released', successfulDelta: 0, reservedDelta: -1 };
  }
  return { status: 'reserved', successfulDelta: 0, reservedDelta: 0 };
};
