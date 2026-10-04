import { randomInt } from 'node:crypto';

export const DISCOUNT_CODE_LENGTH = 10;
const CODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
export const DISCOUNT_BILLING_DURATIONS = ['first_payment', 'recurring'];

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

  const restrictedEmail = String(settings.restrictedEmail ?? '').trim().toLowerCase() || null;
  const restrictedAccountId = String(settings.restrictedAccountId ?? '').trim() || null;
  if (restrictedEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(restrictedEmail)) {
    throw new Error('Enter a valid email address for the email restriction.');
  }
  if (restrictedEmail && restrictedAccountId) {
    throw new Error('Restrict a code to one email or one account, not both.');
  }

  const startsAt = toDate(settings.startsAt);
  const expiresAt = settings.expiresAt ? toDate(settings.expiresAt) : null;
  if (!startsAt) throw new Error('A valid start date and time are required.');
  if (settings.expiresAt && !expiresAt) throw new Error('Enter a valid expiry date and time.');
  if (expiresAt && expiresAt <= startsAt) throw new Error('Expiry must be later than the start date.');

  const billingDuration = settings.billingDuration;
  if (!DISCOUNT_BILLING_DURATIONS.includes(billingDuration)) {
    throw new Error('Choose whether the discount applies to the first payment or recurring payments.');
  }

  return { percentOff, maxRedemptions, restrictedEmail, restrictedAccountId, startsAt, expiresAt, billingDuration };
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

export const applyRecurringDiscount = (quote, benefit, selectedPlan = quote) => {
  const matches = benefit
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
    discountBillingDuration: 'recurring',
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

export const getDiscountEligibilityError = ({ code, uid, email, now = new Date(), subscription = null }) => {
  if (!code || code.active !== true) return 'This discount code is not active.';
  const startsAt = toDate(code.startsAt);
  const expiresAt = code.expiresAt ? toDate(code.expiresAt) : null;
  if (!startsAt || now < startsAt) return 'This discount code is not available yet.';
  if (expiresAt && now >= expiresAt) return 'This discount code has expired.';
  if (code.restrictedEmail && String(email ?? '').trim().toLowerCase() !== String(code.restrictedEmail).trim().toLowerCase()) {
    return 'This discount code is not available for this email address.';
  }
  if (code.restrictedAccountId && uid !== code.restrictedAccountId) return 'This discount code is not available for this account.';
  if (subscription?.planId && ['circle', 'personalized'].includes(subscription.planId)) {
    const renewalDate = toDate(subscription.renewalDate);
    const graceEndsAt = toDate(subscription.graceEndsAt);
    const activePaid = subscription.status === 'active' && renewalDate && renewalDate > now;
    const paidGrace = subscription.status === 'past_due' && graceEndsAt && graceEndsAt > now;
    if (activePaid || paidGrace) return 'Discount codes are available after your current paid subscription ends.';
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
