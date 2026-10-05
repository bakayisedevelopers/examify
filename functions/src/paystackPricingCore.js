const PAID_PLAN_IDS = new Set(['circle', 'personalized']);

const toMinorUnits = (amount) => {
  const value = Math.round(Number(amount) * 100);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('The subscription amount is invalid.');
  return value;
};

export const needsAuthorizationForZeroCostCheckout = ({
  amountDue,
  planId,
  currentPaidSubscription = false,
  hasReusableAuthorization = false,
  discountPercent,
  billingDuration,
}) => {
  if (amountDue === null || amountDue === undefined) return false;
  if (toMinorUnits(amountDue) !== 0 || !PAID_PLAN_IDS.has(planId)
    || currentPaidSubscription || hasReusableAuthorization) return false;
  // A permanent 100% subscription has no future paid renewal to authorize.
  return !(Number(discountPercent) === 100 && billingDuration === 'recurring');
};

export const getNextActualSubscriptionCharge = ({
  baseAmount,
  percentOff,
  billingDuration,
  discountDurationMonths,
  billingCycleDays,
  activationDate = new Date(),
}) => {
  const percent = Number(percentOff);
  const baseMinor = toMinorUnits(baseAmount);
  const cycleDays = Number(billingCycleDays);
  const startedAt = activationDate instanceof Date ? activationDate : new Date(activationDate);
  if (!Number.isFinite(cycleDays) || cycleDays <= 0 || Number.isNaN(startedAt.getTime())) {
    throw new Error('The subscription renewal schedule is invalid.');
  }
  if (percent === 100 && billingDuration === 'recurring') {
    return { nextBillingDate: null, nextBillingAmount: null, noNextChargeWhileOfferApplies: true };
  }

  const fixedMonths = Number(discountDurationMonths);
  const nextChargeCycles = percent === 100 && billingDuration === 'fixed_months'
    ? fixedMonths
    : 1;
  if (!Number.isInteger(nextChargeCycles) || nextChargeCycles < 1) {
    throw new Error('The discount duration is invalid.');
  }
  const discountAppliesToNextCharge = percent < 100 && (
    billingDuration === 'recurring'
    || (billingDuration === 'fixed_months' && fixedMonths > 1)
  );
  const nextAmountMinor = discountAppliesToNextCharge
    ? Math.round((baseMinor * (100 - percent)) / 100)
    : baseMinor;
  const nextBillingDate = new Date(startedAt.getTime() + cycleDays * nextChargeCycles * 24 * 60 * 60 * 1000);
  return {
    nextBillingDate,
    nextBillingAmount: nextAmountMinor / 100,
    noNextChargeWhileOfferApplies: false,
  };
};

export const isSavedSubscriptionPaymentConsistent = ({ quote, subscription, payment }) => {
  if (!quote || !subscription || !payment) return false;
  const hasDiscountValue = payment.discountPercent !== null && payment.discountPercent !== undefined;
  const percentOff = Number(payment.discountPercent);
  const hasDiscount = Number.isInteger(percentOff) && percentOff >= 1 && percentOff <= 100;
  if (hasDiscountValue && !hasDiscount) return false;
  if (hasDiscount && (!payment.discountCode
    || payment.discountCode !== subscription.discountCode
    || Number(subscription.discountPercent) !== percentOff
    || payment.discountBillingDuration !== subscription.discountBillingDuration)) return false;
  if (!hasDiscount && Number(subscription.discountPercent) > 0) return false;

  try {
    const baseMinor = toMinorUnits(quote.amount);
    const expectedSubscriptionMinor = hasDiscount
      ? Math.round((baseMinor * (100 - percentOff)) / 100)
      : baseMinor;
    if (payment.subscriptionAmountDue !== null && payment.subscriptionAmountDue !== undefined
      && toMinorUnits(payment.subscriptionAmountDue) !== expectedSubscriptionMinor) return false;
    const actualPaymentMinor = toMinorUnits(payment.amount);
    if (payment.authorizationOnly === true) {
      const authorizationMinor = toMinorUnits(payment.authorizationChargeAmount);
      return expectedSubscriptionMinor === 0 && authorizationMinor > 0 && actualPaymentMinor === authorizationMinor;
    }
    return actualPaymentMinor === expectedSubscriptionMinor;
  } catch {
    return false;
  }
};
