export const SUBSCRIPTION_PLANS = {
  free: {
    name: 'Free',
    type: 'question-papers',
    baseMonthlyAmount: 0,
    includedSubjects: 0,
    additionalSubjectAmount: 0,
    sessionsPerSubject: 0,
    deliveryMode: null,
  },
  circle: {
    name: 'Circle',
    type: 'group',
    baseMonthlyAmount: 249,
    includedSubjects: 2,
    additionalSubjectAmount: 50,
    sessionsPerSubject: 4,
    deliveryMode: 'online',
  },
  personalized: {
    name: 'Personalized',
    type: 'one-on-one',
    baseMonthlyAmount: 1699,
    includedSubjects: 2,
    additionalSubjectAmount: 600,
    sessionsPerSubject: 4,
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
    && subjectCount >= 2
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

export const calculateSubscriptionQuote = ({ planId, billingPeriod = 'monthly', subjectCount = 2 }) => {
  const plan = SUBSCRIPTION_PLANS[planId];
  if (!plan) throw new Error('Choose a valid subscription plan.');
  if (!['monthly', 'yearly'].includes(billingPeriod)) throw new Error('Choose monthly or yearly billing.');

  const normalizedSubjectCount = planId === 'free' ? 0 : Number(subjectCount);
  if (planId !== 'free' && (!Number.isInteger(normalizedSubjectCount) || normalizedSubjectCount < 2 || normalizedSubjectCount > 20)) {
    throw new Error('Choose between 2 and 20 registered subjects.');
  }

  const additionalSubjects = Math.max(0, normalizedSubjectCount - plan.includedSubjects);
  const monthlyAmount = plan.baseMonthlyAmount + additionalSubjects * plan.additionalSubjectAmount;
  const amount = billingPeriod === 'yearly' && planId !== 'free' ? monthlyAmount * 10 : monthlyAmount;

  return {
    planId,
    planName: plan.name,
    planType: plan.type,
    billingPeriod,
    subjectCount: normalizedSubjectCount,
    includedSubjects: plan.includedSubjects,
    additionalSubjects,
    additionalSubjectAmount: plan.additionalSubjectAmount,
    sessionsPerSubject: plan.sessionsPerSubject,
    sessionsPerMonth: plan.sessionsPerSubject * normalizedSubjectCount,
    deliveryMode: plan.deliveryMode,
    monthlyAmount,
    annualDiscountMonths: billingPeriod === 'yearly' && planId !== 'free' ? 2 : 0,
    amount,
    currency: 'ZAR',
    billingCycleDays: billingPeriod === 'yearly' ? 365 : 30,
  };
};
