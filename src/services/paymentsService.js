import { httpsCallable } from 'firebase/functions';
import { functions, isFirebaseConfigured } from '../firebase/config';
import { calculateSubscriptionQuote } from '../utils/subscriptionPlans';

export const initializeSubscriptionPayment = async (payload) => {
  const quote = calculateSubscriptionQuote(payload);
  if (!isFirebaseConfigured) {
    if (payload.planId === 'free') return { free: true, quote };
    return {
      authorizationUrl: 'https://paystack.com/pay/demo-examifying-session-plan',
      reference: `demo-${payload.studentId}-${Date.now()}`,
      quote,
    };
  }

  const callable = httpsCallable(functions, 'initializePaystackTransaction');
  const response = await callable(payload);
  return response.data;
};

export const verifySubscriptionPayment = async (reference) => {
  if (!isFirebaseConfigured) {
    return { status: 'success', reference, authorizationStored: true };
  }

  const callable = httpsCallable(functions, 'verifyPaystackTransaction');
  const response = await callable({ reference });
  return response.data;
};
