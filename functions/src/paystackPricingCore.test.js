import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getNextActualSubscriptionCharge,
  isSavedSubscriptionPaymentConsistent,
  needsAuthorizationForZeroCostCheckout,
} from './paystackPricingCore.js';

test('zero-cost recurring paid offers require R1 authorization only when future collection is needed', () => {
  const base = {
    planId: 'personalized',
    amountDue: 0,
    discountPercent: 100,
    billingDuration: 'fixed_months',
  };
  assert.equal(needsAuthorizationForZeroCostCheckout(base), true);
  assert.equal(needsAuthorizationForZeroCostCheckout({ ...base, billingDuration: 'recurring' }), false);
  assert.equal(needsAuthorizationForZeroCostCheckout({ ...base, hasReusableAuthorization: true }), false);
  assert.equal(needsAuthorizationForZeroCostCheckout({ ...base, currentPaidSubscription: true }), false);
  assert.equal(needsAuthorizationForZeroCostCheckout({ ...base, planId: 'free' }), false);
  assert.equal(needsAuthorizationForZeroCostCheckout({ ...base, amountDue: 1 }), false);
});

test('free to paid discounted checkouts with a positive amount do not use R1 authorization', () => {
  assert.equal(needsAuthorizationForZeroCostCheckout({
    planId: 'circle', amountDue: 99.5, discountPercent: 50,
    billingDuration: 'fixed_months',
  }), false);
});

test('a 100% three-cycle discount counts the initial free cycle and charges the base price after it ends', () => {
  const startedAt = new Date('2026-10-05T00:00:00.000Z');
  const result = getNextActualSubscriptionCharge({
    baseAmount: 999, percentOff: 100, billingDuration: 'fixed_months',
    discountDurationMonths: 3, billingCycleDays: 30, activationDate: startedAt,
  });
  assert.equal(result.nextBillingDate.toISOString(), '2027-01-03T00:00:00.000Z');
  assert.equal(result.nextBillingAmount, 999);
});

test('a 50% three-cycle offer charges the discounted amount at the first renewal', () => {
  const result = getNextActualSubscriptionCharge({
    baseAmount: 999, percentOff: 50, billingDuration: 'fixed_months',
    discountDurationMonths: 3, billingCycleDays: 30,
    activationDate: new Date('2026-10-05T00:00:00.000Z'),
  });
  assert.equal(result.nextBillingDate.toISOString(), '2026-11-04T00:00:00.000Z');
  assert.equal(result.nextBillingAmount, 499.5);
});

test('first-payment-only offers renew at the base price and permanent 100% offers have no paid renewal', () => {
  const startedAt = new Date('2026-10-05T00:00:00.000Z');
  const firstPayment = getNextActualSubscriptionCharge({
    baseAmount: 199, percentOff: 100, billingDuration: 'first_payment',
    billingCycleDays: 30, activationDate: startedAt,
  });
  assert.equal(firstPayment.nextBillingAmount, 199);
  const permanent = getNextActualSubscriptionCharge({
    baseAmount: 199, percentOff: 100, billingDuration: 'recurring',
    billingCycleDays: 30, activationDate: startedAt,
  });
  assert.equal(permanent.nextBillingDate, null);
  assert.equal(permanent.noNextChargeWhileOfferApplies, true);
});

test('subscription payment checks accept the real discounted charge rather than the undiscounted list price', () => {
  const quote = { amount: 999, currency: 'ZAR', planId: 'personalized', billingPeriod: 'monthly', subjectCount: 1 };
  const subscription = {
    latestReference: 'promo-ref', discountCode: 'HALFPRICE1',
    discountPercent: 50, discountBillingDuration: 'fixed_months',
  };
  const payment = {
    ...quote, reference: 'promo-ref', status: 'success', amount: 499.5,
    subscriptionAmountDue: 499.5, discountCode: 'HALFPRICE1',
    discountPercent: 50, discountBillingDuration: 'fixed_months',
  };
  assert.equal(isSavedSubscriptionPaymentConsistent({ quote, subscription, payment }), true);
  assert.equal(isSavedSubscriptionPaymentConsistent({ quote, subscription, payment: { ...payment, amount: 999 } }), false);
});

test('subscription payment checks accept an R1 authorization transaction for an R0 plan amount', () => {
  const quote = { amount: 999, currency: 'ZAR', planId: 'personalized', billingPeriod: 'monthly', subjectCount: 1 };
  const subscription = {
    discountCode: 'FREECYCLE1', discountPercent: 100, discountBillingDuration: 'fixed_months',
  };
  const payment = {
    ...quote, status: 'success', amount: 1, subscriptionAmountDue: 0,
    authorizationOnly: true, authorizationChargeAmount: 1,
    discountCode: 'FREECYCLE1', discountPercent: 100, discountBillingDuration: 'fixed_months',
  };
  assert.equal(isSavedSubscriptionPaymentConsistent({ quote, subscription, payment }), true);
  assert.equal(isSavedSubscriptionPaymentConsistent({ quote, subscription, payment: { ...payment, amount: 0 } }), false);
});
