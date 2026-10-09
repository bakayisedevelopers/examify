import { initializeApp, getApps, getApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';
import { getStorage } from 'firebase/storage';
import { getFunctions } from 'firebase/functions';

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

export const firestoreDatabaseId = import.meta.env.VITE_FIRESTORE_DATABASE_ID?.trim() || '(default)';

export const isFirebaseConfigured = Boolean(
  firebaseConfig.apiKey && firebaseConfig.authDomain && firebaseConfig.projectId,
);

let app = null;
try {
  app = getApps().length ? getApp() : initializeApp(firebaseConfig);
} catch {
  // Keep Firebase services unavailable when the runtime configuration cannot initialize.
}
export const firebaseApp = app;
export const auth = app ? getAuth(app) : null;
export const db = app ? (firestoreDatabaseId === '(default)' ? getFirestore(app) : getFirestore(app, firestoreDatabaseId)) : null;
export const storage = app ? getStorage(app) : null;
export const functions = app ? getFunctions(app) : null;
