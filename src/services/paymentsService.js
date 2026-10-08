import { httpsCallable } from 'firebase/functions';
import { functions, isFirebaseConfigured } from '../firebase/config';
import { calculateSubscriptionQuote } from '../utils/subscriptionPlans';
import { trackDataRequest } from './performanceTelemetry';

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

export const verifySubscriptionPayment = async (reference, studentId) => {
  if (!isFirebaseConfigured) {
    return { status: 'success', reference, authorizationStored: true };
  }

  const callable = httpsCallable(functions, 'verifyPaystackTransaction');
  const response = await callable({ reference, studentId });
  return response.data;
};

export const cancelSubscriptionPaymentCheckout = async ({ studentId, reference }) => {
  if (!isFirebaseConfigured) return { cancelled: true, demo: true };
  const callable = httpsCallable(functions, 'cancelPaystackCheckout');
  const response = await callable({ studentId, reference });
  return response.data;
};

export const manageStudentSubscription = async ({ studentId, action }) => {
  if (!isFirebaseConfigured) return { action, status: 'success', demo: true };

  const callable = httpsCallable(functions, 'manageStudentSubscription');
  const response = await callable({ studentId, action });
  return response.data;
};

export const retryStudentSubscriptionPayment = async (studentId) => {
  if (!isFirebaseConfigured) return { status: 'success', charged: true, demo: true };

  const callable = httpsCallable(functions, 'chargeStoredAuthorization');
  const response = await callable({ studentId });
  return response.data;
};

export const getStudentSavedPaymentMethods = async (studentId) => {
  if (!isFirebaseConfigured) return { paymentMethods: [] };
  return trackDataRequest('Saved subscription payment methods', async () => {
    const callable = httpsCallable(functions, 'getStudentSavedPaymentMethods');
    const response = await callable({ studentId });
    return response.data;
  });
};

export const getAdminAuthorizationRefundIssues = async () => {
  if (!isFirebaseConfigured) return { issues: [] };
  return trackDataRequest('Admin authorization refunds', async () => {
    const callable = httpsCallable(functions, 'getAdminAuthorizationRefundIssues');
    const response = await callable();
    return response.data;
  });
};
