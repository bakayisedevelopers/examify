import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateDiscount,
  applyRecurringDiscount,
  generateDiscountCode,
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
  assert.equal(validateDiscountSettings({ ...baseSettings, maxRedemptions: null }).maxRedemptions, null);
  assert.throws(() => validateDiscountSettings({ ...baseSettings, percentOff: 0 }), /1 to 100/);
  assert.throws(() => validateDiscountSettings({ ...baseSettings, percentOff: 10.5 }), /whole number/);
  assert.throws(() => validateDiscountSettings({ ...baseSettings, maxRedemptions: 0 }), /positive whole number/);
  assert.throws(() => validateDiscountSettings({ ...baseSettings, expiresAt: '2026-09-30T00:00:00.000Z' }), /later than the start/);
  assert.throws(() => validateDiscountSettings({ ...baseSettings, restrictedEmail: 'bad-email' }), /valid email/);
  assert.throws(() => validateDiscountSettings({ ...baseSettings, restrictedEmail: 'person@example.com', restrictedAccountId: 'uid-1' }), /email or one account/);
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

test('enforces start and expiry bounds using the supplied server time', () => {
  const code = { ...validateDiscountSettings(baseSettings), active: true };
  assert.match(getDiscountEligibilityError({ code, uid: 'u1', email: 'a@b.com', now: new Date('2026-09-30T23:59:59Z') }), /not available yet/);
  assert.equal(getDiscountEligibilityError({ code, uid: 'u1', email: 'a@b.com', now: new Date('2026-10-05T12:00:00Z') }), null);
  assert.match(getDiscountEligibilityError({ code, uid: 'u1', email: 'a@b.com', now: new Date('2026-11-01T00:00:00Z') }), /expired/);
});

test('rejects active and grace-period paid subscriptions but accepts ended or downgraded subscriptions', () => {
  const code = { ...validateDiscountSettings(baseSettings), active: true };
  const now = new Date('2026-10-05T12:00:00Z');
  const active = { planId: 'circle', status: 'active', renewalDate: new Date('2026-10-10T00:00:00Z') };
  const grace = { planId: 'personalized', status: 'past_due', graceEndsAt: new Date('2026-10-06T00:00:00Z') };
  const ended = { planId: 'circle', status: 'active', renewalDate: new Date('2026-10-04T00:00:00Z') };
  const free = { planId: 'free', status: 'active' };
  assert.match(getDiscountEligibilityError({ code, uid: 'u1', email: 'a@b.com', now, subscription: active }), /current paid subscription/);
  assert.match(getDiscountEligibilityError({ code, uid: 'u1', email: 'a@b.com', now, subscription: { ...active, cancelAtPeriodEnd: true } }), /current paid subscription/);
  assert.match(getDiscountEligibilityError({ code, uid: 'u1', email: 'a@b.com', now, subscription: grace }), /current paid subscription/);
  assert.equal(getDiscountEligibilityError({ code, uid: 'u1', email: 'a@b.com', now, subscription: ended }), null);
  assert.equal(getDiscountEligibilityError({ code, uid: 'u1', email: 'a@b.com', now, subscription: free }), null);
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
