import { getMessaging, getToken, isSupported } from 'firebase/messaging';
import { doc, serverTimestamp, setDoc } from 'firebase/firestore';
import { db, firebaseApp, isFirebaseConfigured } from '../firebase/config';
import { collections } from '../firebase/schema';

const vapidKey = import.meta.env.VITE_FIREBASE_VAPID_KEY;

const tokenToId = (token) => btoa(token).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');

const getDeviceLabel = () => {
  if (typeof navigator === 'undefined') return 'Unknown device';
  const parts = [navigator.platform, navigator.userAgentData?.mobile ? 'Mobile' : 'Browser'].filter(Boolean);
  return parts.join(' • ') || 'Browser';
};

export const getNotificationSupportState = async () => {
  if (typeof window === 'undefined' || !('Notification' in window)) return { supported: false, reason: 'unsupported-browser' };
  if (!('serviceWorker' in navigator)) return { supported: false, reason: 'unsupported-service-worker' };
  if (!isFirebaseConfigured || !firebaseApp || !db) return { supported: false, reason: 'firebase-not-configured' };
  const supported = await isSupported();
  if (!supported) return { supported: false, reason: 'unsupported-firebase-messaging' };
  return { supported: true, hasCustomVapidKey: Boolean(vapidKey) };
};

export const registerStudentNotificationDevice = async (studentId) => {
  if (!studentId) throw new Error('Student id is required for notification registration.');

  const support = await getNotificationSupportState();
  if (!support.supported) {
    if (support.reason === 'missing-vapid-key') {
      throw new Error('This browser cannot receive Examifying push notifications.');
    }
    throw new Error('This browser cannot receive Examifying push notifications.');
  }

  const registration = await navigator.serviceWorker.register('/firebase-messaging-sw.js');
  const messaging = getMessaging(firebaseApp);
  const tokenOptions = vapidKey ? { vapidKey, serviceWorkerRegistration: registration } : { serviceWorkerRegistration: registration };
  const token = await getToken(messaging, tokenOptions);
  if (!token) throw new Error('No notification token was returned for this browser.');

  const tokenId = tokenToId(token);
  await setDoc(doc(db, collections.users, studentId, 'notificationTokens', tokenId), {
    token,
    tokenId,
    platform: getDeviceLabel(),
    userAgent: navigator.userAgent ?? '',
    active: true,
    permission: Notification.permission,
    updatedAt: serverTimestamp(),
    createdAt: serverTimestamp(),
  }, { merge: true });

  return { token, tokenId };
};
