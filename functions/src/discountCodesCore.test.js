import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addCalendarMonths,
  calculateDiscount,
  calculateDiscountEndAt,
  applyRecurringDiscount,
  applyScheduledDiscount,
  generateDiscountCode,
  getDiscountBillingPeriodError,
  getDiscountEligibilityError,
  getDiscountUseCounts,
  transitionRedemption,
  validateDiscountSettings,
} from './discountCodesCore.js';

const baseSettings = {
  percentOff: 25,
  maxRedemptions: 50,
  startsAt: '2026-10-01T00:00:00.000Z',
  expiresAt: '2026-11-01T00:00:00.000Z',
  billingDuration: 'first_payment',
};

test('generates uppercase alphanumeric codes in the configured length', () => {
  const code = generateDiscountCode();
  assert.match(code, /^[A-Z0-9]{10}$/);
});

test('validates discount percentages, redemption limits, and conflicting restrictions', () => {
  assert.equal(validateDiscountSettings(baseSettings).percentOff, 25);
  assert.equal(validateDiscountSettings(baseSettings).maxSubjectCount, null);
  assert.equal(validateDiscountSettings({ ...baseSettings, maxSubjectCount: 3 }).maxSubjectCount, 3);
  assert.equal(validateDiscountSettings({ ...baseSettings, maxRedemptions: null }).maxRedemptions, null);
  assert.throws(() => validateDiscountSettings({ ...baseSettings, percentOff: 0 }), /1 to 100/);
  assert.throws(() => validateDiscountSettings({ ...baseSettings, percentOff: 10.5 }), /whole number/);
  assert.throws(() => validateDiscountSettings({ ...baseSettings, maxRedemptions: 0 }), /positive whole number/);
  assert.throws(() => validateDiscountSettings({ ...baseSettings, maxSubjectCount: 0 }), /subject limit/);
  assert.throws(() => validateDiscountSettings({ ...baseSettings, maxSubjectCount: 21 }), /subject limit/);
  assert.throws(() => validateDiscountSettings({ ...baseSettings, expiresAt: '2026-09-30T00:00:00.000Z' }), /later than the start/);
  assert.throws(() => validateDiscountSettings({ ...baseSettings, restrictedEmail: 'bad-email' }), /valid email/);
  assert.throws(() => validateDiscountSettings({ ...baseSettings, restrictedEmail: 'person@example.com', restrictedAccountId: 'uid-1' }), /email or one account/);
});

test('keeps code redemption expiry separate and can calculate it from the start date', () => {
  const startsAt = '2026-01-31T10:15:00.000Z';
  const timedWindow = validateDiscountSettings({
    ...baseSettings,
    startsAt,
    expiresAt: null,
    redemptionExpiryMode: 'after_start',
    redemptionWindowMonths: 1,
  });
  assert.equal(timedWindow.redemptionExpiryMode, 'after_start');
  assert.equal(timedWindow.expiresAt.toISOString(), '2026-02-28T10:15:00.000Z');
  assert.equal(addCalendarMonths(new Date('2026-10-31T10:15:00.000Z'), 3).toISOString(), '2027-01-31T10:15:00.000Z');
  assert.equal(validateDiscountSettings({ ...baseSettings, expiresAt: null, redemptionExpiryMode: 'none' }).expiresAt, null);
  assert.throws(() => validateDiscountSettings({ ...baseSettings, redemptionExpiryMode: 'after_start', redemptionWindowMonths: 0 }), /redemption window/);
  assert.throws(() => validateDiscountSettings({ ...baseSettings, redemptionExpiryMode: 'none', expiresAt: baseSettings.expiresAt }), /Manual expiry dates/);
});

test('validates fixed discount periods separately from the redemption window', () => {
  const fixed = validateDiscountSettings({
    ...baseSettings,
    billingDuration: 'fixed_months',
    discountDurationMonths: 3,
  });
  assert.equal(fixed.billingDuration, 'fixed_months');
  assert.equal(fixed.discountDurationMonths, 3);
  assert.equal(validateDiscountSettings(baseSettings).discountDurationMonths, null);
  assert.throws(() => validateDiscountSettings({ ...baseSettings, billingDuration: 'fixed_months', discountDurationMonths: 0 }), /fixed discount duration/);
  assert.throws(() => validateDiscountSettings({ ...baseSettings, discountDurationMonths: 3 }), /only be set for fixed-month/);
  assert.equal(getDiscountBillingPeriodError({ billingDuration: 'fixed_months', billingPeriod: 'yearly' }), 'Fixed-month discounts are available on monthly subscriptions only.');
  assert.equal(getDiscountBillingPeriodError({ billingDuration: 'fixed_months', billingPeriod: 'monthly' }), null);
});

test('matches email restrictions case-insensitively and account restrictions by authenticated uid', () => {
  const now = new Date('2026-10-05T12:00:00.000Z');
  const emailCode = { ...validateDiscountSettings({ ...baseSettings, restrictedEmail: 'Person@Example.com' }), active: true };
  assert.equal(getDiscountEligibilityError({ code: emailCode, uid: 'u1', email: 'person@example.COM', now }), null);
  assert.match(getDiscountEligibilityError({ code: emailCode, uid: 'u1', email: 'other@example.com', now }), /email address/);

  const accountCode = { ...validateDiscountSettings({ ...baseSettings, restrictedAccountId: 'u1' }), active: true };
  assert.equal(getDiscountEligibilityError({ code: accountCode, uid: 'u1', email: 'a@b.com', now }), null);
  assert.match(getDiscountEligibilityError({ code: accountCode, uid: 'u2', email: 'a@b.com', now }), /account/);
});

test('public price previews defer identity checks but still enforce the code redemption window', () => {
  const now = new Date('2026-10-05T12:00:00.000Z');
  const code = { ...validateDiscountSettings({ ...baseSettings, restrictedEmail: 'person@example.com' }), active: true };
  assert.equal(getDiscountEligibilityError({ code, now, previewOnly: true }), null);
  assert.match(getDiscountEligibilityError({ code, now, email: 'other@example.com' }), /email address/);
  assert.match(getDiscountEligibilityError({ code, now: new Date('2026-11-01T00:00:00.000Z'), previewOnly: true }), /expired/);
});

test('enforces start and expiry bounds using the supplied server time', () => {
  const code = { ...validateDiscountSettings(baseSettings), active: true };
  assert.match(getDiscountEligibilityError({ code, uid: 'u1', email: 'a@b.com', now: new Date('2026-09-30T23:59:59Z') }), /not available yet/);
  assert.equal(getDiscountEligibilityError({ code, uid: 'u1', email: 'a@b.com', now: new Date('2026-10-05T12:00:00Z') }), null);
  assert.match(getDiscountEligibilityError({ code, uid: 'u1', email: 'a@b.com', now: new Date('2026-11-01T00:00:00Z') }), /expired/);
});

test('allows existing paid subscribers to use a code when the subscription selection is otherwise eligible', () => {
  const code = { ...validateDiscountSettings(baseSettings), active: true };
  const now = new Date('2026-10-05T12:00:00Z');
  const active = { planId: 'circle', status: 'active', renewalDate: new Date('2026-10-10T00:00:00Z') };
  const grace = { planId: 'personalized', status: 'past_due', graceEndsAt: new Date('2026-10-06T00:00:00Z') };
  const ended = { planId: 'circle', status: 'active', renewalDate: new Date('2026-10-04T00:00:00Z') };
  const free = { planId: 'free', status: 'active' };
  assert.equal(getDiscountEligibilityError({ code, uid: 'u1', email: 'a@b.com', now, subscription: active }), null);
  assert.equal(getDiscountEligibilityError({ code, uid: 'u1', email: 'a@b.com', now, subscription: { ...active, cancelAtPeriodEnd: true } }), null);
  assert.equal(getDiscountEligibilityError({ code, uid: 'u1', email: 'a@b.com', now, subscription: grace }), null);
  assert.equal(getDiscountEligibilityError({ code, uid: 'u1', email: 'a@b.com', now, subscription: ended }), null);
  assert.equal(getDiscountEligibilityError({ code, uid: 'u1', email: 'a@b.com', now, subscription: free }), null);
});

test('enforces a discount subject cap against the selected subscription subject count', () => {
  const code = { ...validateDiscountSettings({ ...baseSettings, maxSubjectCount: 2 }), active: true };
  const now = new Date('2026-10-05T12:00:00Z');
  assert.equal(getDiscountEligibilityError({ code, planId: 'circle', subjectCount: 2, now }), null);
  assert.match(getDiscountEligibilityError({ code, planId: 'circle', subjectCount: 3, now }), /up to 2 subjects/);
});

test('reserves concurrent uses against the maximum while unlimited codes have no remaining-use cap', () => {
  assert.deepEqual(getDiscountUseCounts({ successfulRedemptions: 2, reservedRedemptions: 1, maxRedemptions: 3 }), {
    successfulRedemptions: 2, reservedRedemptions: 1, remainingUses: 0, available: false,
  });
  assert.deepEqual(getDiscountUseCounts({ successfulRedemptions: 20, reservedRedemptions: 4, maxRedemptions: null }), {
    successfulRedemptions: 20, reservedRedemptions: 4, remainingUses: null, available: true,
  });
});

test('failed and abandoned payments release reservations; only payment success counts a redemption', () => {
  assert.deepEqual(transitionRedemption('failed'), { status: 'released', successfulDelta: 0, reservedDelta: -1 });
  assert.deepEqual(transitionRedemption('abandoned'), { status: 'released', successfulDelta: 0, reservedDelta: -1 });
  assert.deepEqual(transitionRedemption('success'), { status: 'redeemed', successfulDelta: 1, reservedDelta: -1 });
  assert.deepEqual(transitionRedemption('processing'), { status: 'reserved', successfulDelta: 0, reservedDelta: 0 });
});

test('calculates decimal and 100% discounts in currency units', () => {
  assert.deepEqual(calculateDiscount(199, 25), { originalAmount: 199, discountAmount: 49.75, finalAmount: 149.25 });
  assert.deepEqual(calculateDiscount(999, 100), { originalAmount: 999, discountAmount: 999, finalAmount: 0 });
});

test('recurring discounts apply only to the same saved plan selection', () => {
  const quote = { planId: 'circle', billingPeriod: 'monthly', subjectCount: 2, amount: 248 };
  const benefit = { code: 'ABCD123456', percentOff: 20, planId: 'circle', billingPeriod: 'monthly', subjectCount: 2 };
  assert.equal(applyRecurringDiscount(quote, benefit, quote).amount, 198.4);
  assert.equal(applyRecurringDiscount(quote, benefit, { ...quote, subjectCount: 3 }).amount, 248);
  assert.equal(applyRecurringDiscount(quote, null, quote), quote);
});

test('applies a previously reserved plan-change discount to its selected renewal quote', () => {
  const quote = { planId: 'personalized', billingPeriod: 'monthly', subjectCount: 2, amount: 1598 };
  const discounted = applyScheduledDiscount(quote, {
    discountCode: 'ABCD123456',
    discountPercent: 25,
    discountBillingDuration: 'fixed_months',
    discountDurationMonths: 3,
    discountRedemptionReference: 'change-student-1',
  });
  assert.equal(discounted.originalAmount, 1598);
  assert.equal(discounted.discountAmount, 399.5);
  assert.equal(discounted.amount, 1198.5);
  assert.equal(discounted.discountRedemptionReference, 'change-student-1');
});

test('fixed discounts expire from each customer activation date after the configured monthly cycles', () => {
  const quote = { planId: 'circle', billingPeriod: 'monthly', subjectCount: 1, amount: 199 };
  const activatedAt = new Date('2026-10-04T12:00:00.000Z');
  const discountEndsAt = calculateDiscountEndAt(activatedAt, 3, 30);
  const laterCustomerEndsAt = calculateDiscountEndAt(new Date('2026-10-14T12:00:00.000Z'), 3, 30);
  const benefit = {
    code: 'ABCD123456', percentOff: 50, planId: 'circle', billingPeriod: 'monthly', subjectCount: 1,
    billingDuration: 'fixed_months', discountDurationMonths: 3, discountEndsAt, activatedAt,
  };
  assert.equal(discountEndsAt.toISOString(), '2027-01-02T12:00:00.000Z');
  assert.equal(laterCustomerEndsAt.toISOString(), '2027-01-12T12:00:00.000Z');
  assert.equal(applyRecurringDiscount(quote, benefit, quote, new Date('2026-12-03T12:00:00.000Z')).amount, 99.5);
  assert.equal(applyRecurringDiscount(quote, benefit, quote, discountEndsAt).amount, 199);
  assert.equal(applyRecurringDiscount(quote, benefit, { ...quote, subjectCount: 2 }, new Date('2026-11-01T00:00:00.000Z')).amount, 199);
});
