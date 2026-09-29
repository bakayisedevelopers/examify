import { httpsCallable } from 'firebase/functions';
import { functions, isFirebaseConfigured } from '../firebase/config';
import { calculateSubscriptionQuote } from '../utils/subscription';

export const getSubscriptionQuote = calculateSubscriptionQuote;

export const initializeSubscriptionPayment = async (payload) => {
  if (!isFirebaseConfigured) {
    let quote = null;
    let totalAmount = 0;
    
    if (payload.studentId) {
      quote = calculateSubscriptionQuote(payload);
      totalAmount = quote.amount;
    } else if (payload.studentIds && payload.studentIds.length > 0) {
      for (const s of payload.studentIds) {
        totalAmount += calculateSubscriptionQuote({ latestMark: s.latestMark, sessionType: s.sessionType }).amount;
      }
      quote = { amount: totalAmount };
    }

    return {
      authorizationUrl: 'https://paystack.com/pay/demo-examifying-session-plan',
      reference: `demo-${payload.studentId || 'bulk'}-${Date.now()}`,
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