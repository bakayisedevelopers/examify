import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateDiscountedAmount, isSubscriptionPaymentConsistent } from './subscriptionPlans.js';

const personalizedQuote = { amount: 999, currency: 'ZAR' };

test('discounted subscription calculations use integer minor units', () => {
  assert.equal(calculateDiscountedAmount(999, 50), 499.5);
  assert.equal(calculateDiscountedAmount(199, 1), 197.01);
  assert.equal(calculateDiscountedAmount(999, 100), 0);
});

test('payment consistency accepts a normal payment at the undiscounted price', () => {
  const subscription = { planId: 'personalized', billingPeriod: 'monthly', subjectCount: 1 };
  const payment = {
    status: 'success', reference: 'normal-ref', studentId: 'student-1',
    planId: 'personalized', billingPeriod: 'monthly', subjectCount: 1,
    amount: 999, currency: 'ZAR',
  };
  assert.equal(isSubscriptionPaymentConsistent({ quote: personalizedQuote, subscription, payment }), true);
});

test('payment consistency accepts discounted and zero-cost subscription charges', () => {
  const subscription = {
    planId: 'personalized', billingPeriod: 'monthly', subjectCount: 1,
    discountCode: 'HALFPRICE1', discountPercent: 50, discountBillingDuration: 'fixed_months',
  };
  const payment = {
    planId: 'personalized', billingPeriod: 'monthly', subjectCount: 1,
    amount: 499.5, currency: 'ZAR', discountCode: 'HALFPRICE1', discountPercent: 50,
    discountBillingDuration: 'fixed_months',
  };
  assert.equal(isSubscriptionPaymentConsistent({ quote: personalizedQuote, subscription, payment }), true);

  const zeroSubscription = {
    ...subscription, discountPercent: 100,
  };
  const zeroPayment = {
    ...payment, amount: 0, discountPercent: 100, subscriptionAmountDue: 0,
  };
  assert.equal(isSubscriptionPaymentConsistent({ quote: personalizedQuote, subscription: zeroSubscription, payment: zeroPayment }), true);
});

test('R1 authorization charge is distinct from the zero subscription amount due', () => {
  const subscription = {
    planId: 'personalized', billingPeriod: 'monthly', subjectCount: 1,
    discountCode: 'FREECYCLE1', discountPercent: 100, discountBillingDuration: 'fixed_months',
  };
  const payment = {
    planId: 'personalized', billingPeriod: 'monthly', subjectCount: 1,
    amount: 1, authorizationOnly: true, authorizationChargeAmount: 1,
    subscriptionAmountDue: 0, currency: 'ZAR', discountCode: 'FREECYCLE1',
    discountPercent: 100, discountBillingDuration: 'fixed_months',
  };
  assert.equal(isSubscriptionPaymentConsistent({ quote: personalizedQuote, subscription, payment }), true);
  assert.equal(isSubscriptionPaymentConsistent({ quote: personalizedQuote, subscription, payment: { ...payment, amount: 2 } }), false);
});

test('payment consistency rejects a discounted amount that does not match the subscription offer', () => {
  const subscription = {
    planId: 'personalized', billingPeriod: 'monthly', subjectCount: 1,
    discountCode: 'HALFPRICE1', discountPercent: 50, discountBillingDuration: 'first_payment',
  };
  const payment = {
    planId: 'personalized', billingPeriod: 'monthly', subjectCount: 1,
    amount: 499.6, currency: 'ZAR', discountCode: 'HALFPRICE1', discountPercent: 50,
    discountBillingDuration: 'first_payment',
  };
  assert.equal(isSubscriptionPaymentConsistent({ quote: personalizedQuote, subscription, payment }), false);
  assert.throws(() => calculateDiscountedAmount(999, 101), /Discount percentage/);
});
