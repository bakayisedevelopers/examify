const plans = {
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

export const calculateSubscriptionQuote = ({ planId, billingPeriod = 'monthly', subjectCount = 2 }) => {
  const plan = plans[planId];
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
