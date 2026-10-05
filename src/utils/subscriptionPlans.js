export const SUBSCRIPTION_PLANS = {
  free: {
    name: 'Free',
    type: 'question-papers',
    baseMonthlyAmount: 0,
    includedSubjects: 0,
    additionalSubjectAmount: 0,
    groupLessonsPerSubject: 0,
    oneOnOneLessonsPerSubject: 0,
    allowedSessionModes: [],
    deliveryMode: null,
  },
  circle: {
    name: 'Circle',
    type: 'group',
    baseMonthlyAmount: 199,
    includedSubjects: 1,
    additionalSubjectAmount: 49,
    groupLessonsPerSubject: 4,
    oneOnOneLessonsPerSubject: 0,
    allowedSessionModes: ['group'],
    deliveryMode: 'online',
  },
  personalized: {
    name: 'Personalized',
    type: 'one-on-one',
    baseMonthlyAmount: 999,
    includedSubjects: 1,
    additionalSubjectAmount: 599,
    groupLessonsPerSubject: 2,
    oneOnOneLessonsPerSubject: 4,
    allowedSessionModes: ['group', 'one-on-one'],
    deliveryMode: 'inPerson',
  },
};

const asDate = (value) => {
  if (value?.toDate) return value.toDate();
  if (value instanceof Date) return value;
  if (typeof value === 'string' || typeof value === 'number') return new Date(value);
  return null;
};

export const getEffectiveSubscriptionState = ({ subscription, now = new Date() } = {}) => {
  const storedPlanId = subscription?.planId;
  const recognizedPlan = Boolean(SUBSCRIPTION_PLANS[storedPlanId]);
  const renewalDate = asDate(subscription?.renewalDate);
  const graceEndsAt = asDate(subscription?.graceEndsAt);
  const subjectCount = Number(subscription?.subjectCount);
  const isExplicitFree = storedPlanId === 'free' && subscription?.status === 'active';
  const paidPlan = ['circle', 'personalized'].includes(storedPlanId);
  const validPaidPlan = paidPlan
    && Number.isInteger(subjectCount)
    && subjectCount >= 1
    && subjectCount <= 20;
  const activePaidPlan = validPaidPlan
    && subscription?.status === 'active'
    && renewalDate instanceof Date
    && !Number.isNaN(renewalDate.getTime())
    && renewalDate > now;
  const renewalGraceActive = validPaidPlan
    && subscription?.status === 'past_due'
    && renewalDate instanceof Date
    && !Number.isNaN(renewalDate.getTime())
    && renewalDate <= now
    && graceEndsAt instanceof Date
    && !Number.isNaN(graceEndsAt.getTime())
    && graceEndsAt > now;
  const isCurrentPaidPlan = activePaidPlan || renewalGraceActive;
  const hasSelectedPlan = isExplicitFree || isCurrentPaidPlan;
  const effectivePlanId = hasSelectedPlan ? storedPlanId : 'free';

  return {
    subscriptionPlanId: effectivePlanId,
    subscriptionPlanName: SUBSCRIPTION_PLANS[effectivePlanId].name,
    subscriptionStatus: renewalGraceActive ? 'past_due' : hasSelectedPlan ? 'active' : (subscription?.status === 'past_due' ? 'past_due' : 'plan_required'),
    subscriptionBillingPeriod: hasSelectedPlan ? (subscription?.billingPeriod ?? 'monthly') : 'monthly',
    subscriptionSubjectCount: isCurrentPaidPlan ? subjectCount : 0,
    subscriptionRenewalDate: isCurrentPaidPlan ? subscription.renewalDate : null,
    paymentCompleted: isCurrentPaidPlan,
    renewalGraceActive,
    requiresSubscriptionSelection: !hasSelectedPlan,
    isLegacySubscription: !recognizedPlan,
  };
};

export const calculateSubscriptionQuote = ({ planId, billingPeriod = 'monthly', subjectCount = 1 }) => {
  const plan = SUBSCRIPTION_PLANS[planId];
  if (!plan) throw new Error('Choose a valid subscription plan.');
  if (!['monthly', 'yearly'].includes(billingPeriod)) throw new Error('Choose monthly or yearly billing.');

  const normalizedSubjectCount = planId === 'free' ? 0 : Number(subjectCount);
  if (planId !== 'free' && (!Number.isInteger(normalizedSubjectCount) || normalizedSubjectCount < 1 || normalizedSubjectCount > 20)) {
    throw new Error('Choose between 1 and 20 registered subjects.');
  }

  const additionalSubjects = Math.max(0, normalizedSubjectCount - plan.includedSubjects);
  const monthlyAmount = plan.baseMonthlyAmount + additionalSubjects * plan.additionalSubjectAmount;
  const amount = billingPeriod === 'yearly' && planId !== 'free' ? monthlyAmount * 10 : monthlyAmount;
  const groupLessonsPerWindow = plan.groupLessonsPerSubject * normalizedSubjectCount;
  const oneOnOneLessonsPerWindow = plan.oneOnOneLessonsPerSubject * normalizedSubjectCount;

  return {
    planId,
    planName: plan.name,
    planType: plan.type,
    billingPeriod,
    subjectCount: normalizedSubjectCount,
    includedSubjects: plan.includedSubjects,
    additionalSubjects,
    additionalSubjectAmount: plan.additionalSubjectAmount,
    additionalSubjectAmountForPeriod: plan.additionalSubjectAmount * (billingPeriod === 'yearly' ? 10 : 1),
    groupLessonsPerSubject: plan.groupLessonsPerSubject,
    oneOnOneLessonsPerSubject: plan.oneOnOneLessonsPerSubject,
    groupLessonsPerWindow,
    oneOnOneLessonsPerWindow,
    sessionsPerWindow: groupLessonsPerWindow + oneOnOneLessonsPerWindow,
    allowedSessionModes: plan.allowedSessionModes,
    deliveryMode: plan.deliveryMode,
    monthlyAmount,
    annualDiscountMonths: billingPeriod === 'yearly' && planId !== 'free' ? 2 : 0,
    amount,
    currency: 'ZAR',
    billingCycleDays: billingPeriod === 'yearly' ? 365 : 30,
  };
};

export const calculateDiscountedAmount = (amount, percentOff) => {
  const amountMinor = Math.round(Number(amount) * 100);
  const percent = Number(percentOff);
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) throw new Error('Subscription amount is invalid.');
  if (!Number.isInteger(percent) || percent < 1 || percent > 100) throw new Error('Discount percentage is invalid.');
  return Math.round((amountMinor * (100 - percent)) / 100) / 100;
};

export const isSubscriptionPaymentConsistent = ({ quote, subscription, payment }) => {
  if (!quote || !subscription || !payment) return false;
  const percentOff = Number(payment.discountPercent);
  const hasDiscount = Number.isInteger(percentOff) && percentOff >= 1 && percentOff <= 100;
  if (hasDiscount && (!payment.discountCode
    || payment.discountCode !== subscription.discountCode
    || Number(subscription.discountPercent) !== percentOff
    || payment.discountBillingDuration !== subscription.discountBillingDuration)) return false;
  if (!hasDiscount && Number(subscription.discountPercent) > 0) return false;

  const expectedSubscriptionAmount = hasDiscount
    ? calculateDiscountedAmount(quote.amount, percentOff)
    : quote.amount;
  if (payment.subscriptionAmountDue !== null && payment.subscriptionAmountDue !== undefined
    && Number.isFinite(Number(payment.subscriptionAmountDue))
    && Number(payment.subscriptionAmountDue) !== expectedSubscriptionAmount) return false;

  const actualAmount = Number(payment.amount);
  if (payment.authorizationOnly === true) {
    const authorizationAmount = Number(payment.authorizationChargeAmount);
    return expectedSubscriptionAmount === 0
      && Number.isFinite(authorizationAmount)
      && authorizationAmount > 0
      && actualAmount === authorizationAmount;
  }
  return actualAmount === expectedSubscriptionAmount;
};
