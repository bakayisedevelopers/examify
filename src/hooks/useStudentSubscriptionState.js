import { useEffect, useState } from 'react';
import { getStudentSubscriptionState } from '../services/firestoreService';

const FREE_PLAN_STATE = {
  subscriptionPlanId: 'free',
  subscriptionPlanName: 'Free',
  subscriptionStatus: 'plan_required',
  subscriptionSubjectCount: 0,
  paymentCompleted: false,
  requiresSubscriptionSelection: true,
};

export const useStudentSubscriptionState = (profile) => {
  const [subscriptionState, setSubscriptionState] = useState(null);

  useEffect(() => {
    if (!profile?.uid || profile.role !== 'student') {
      setSubscriptionState(null);
      return undefined;
    }

    let active = true;
    getStudentSubscriptionState(profile)
      .then((state) => { if (active) setSubscriptionState(state); })
      .catch((error) => {
        console.error('[Examifying][Subscription] state:error', error);
        if (active) setSubscriptionState(FREE_PLAN_STATE);
      });

    return () => { active = false; };
  }, [profile]);

  return subscriptionState;
};
