const plans = {
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

export const calculateSubscriptionQuote = ({ planId, billingPeriod = 'monthly', subjectCount = 1 }) => {
  const plan = plans[planId];
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
