import { doc, getDoc, serverTimestamp, updateDoc } from 'firebase/firestore';
import { db, isFirebaseConfigured } from '../firebase/config';

export const COOKIE_CONSENT_VERSION = '1';
export const COOKIE_CONSENT_STORAGE_KEY = 'examifying.cookie-consent';

const validChoices = new Set(['accept-all', 'necessary-only']);

const toIsoString = (value) => {
  if (typeof value === 'string' && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  if (value && typeof value.toDate === 'function') {
    const date = value.toDate();
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  return null;
};

const normalizeConsent = (value) => {
  if (!value || value.consentVersion !== COOKIE_CONSENT_VERSION || !validChoices.has(value.choice)) return null;
  return {
    necessary: true,
    choice: value.choice,
    consentVersion: COOKIE_CONSENT_VERSION,
    updatedAt: toIsoString(value.updatedAt),
  };
};

export const createCookieConsent = (choice) => {
  if (!validChoices.has(choice)) throw new Error('Choose a valid cookie preference.');
  return {
    necessary: true,
    choice,
    consentVersion: COOKIE_CONSENT_VERSION,
    updatedAt: new Date().toISOString(),
  };
};

export const readLocalCookieConsent = () => {
  try {
    const stored = window.localStorage.getItem(COOKIE_CONSENT_STORAGE_KEY);
    return stored ? normalizeConsent(JSON.parse(stored)) : null;
  } catch {
    return null;
  }
};

export const writeLocalCookieConsent = (value) => {
  const consent = normalizeConsent(value);
  if (!consent) return false;
  try {
    window.localStorage.setItem(COOKIE_CONSENT_STORAGE_KEY, JSON.stringify(consent));
    return true;
  } catch {
    return false;
  }
};

export const getAccountCookieConsent = async (uid) => {
  if (!uid || !isFirebaseConfigured || !db) return null;
  const snapshot = await getDoc(doc(db, 'users', uid));
  return normalizeConsent(snapshot.data()?.cookieConsent);
};

export const saveAccountCookieConsent = async (uid, value) => {
  const consent = normalizeConsent(value);
  if (!uid || !consent || !isFirebaseConfigured || !db) return;
  await updateDoc(doc(db, 'users', uid), {
    cookieConsent: {
      necessary: true,
      choice: consent.choice,
      consentVersion: COOKIE_CONSENT_VERSION,
      updatedAt: serverTimestamp(),
    },
  });
};
