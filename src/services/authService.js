import {
  GoogleAuthProvider,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  updateProfile,
  updatePassword,
  deleteUser,
} from 'firebase/auth';
import { deleteDoc, deleteField, doc, getDoc as firebaseGetDoc, serverTimestamp, setDoc, updateDoc } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { auth, db, functions, isFirebaseConfigured } from '../firebase/config';
import { collections } from '../firebase/schema';
import { mockUsers } from '../data/mockData';
import { normalizeWhatsAppNumber } from '../utils/whatsapp';
import { trackFirestoreRead } from './performanceTelemetry';

const provider = isFirebaseConfigured ? new GoogleAuthProvider() : null;
const profileRequests = new Map();

export const loginWithEmail = async ({ email, password }) => {
  if (!auth) throw new Error('Firebase not configured. Please set up environment variables.');
  const credential = await signInWithEmailAndPassword(auth, email, password);
  const profile = await getUserProfile(credential.user.uid);
  if (!profile) {
    await signOut(auth);
    throw new Error('This login has no Examify profile. Contact an administrator to restore the account link.');
  }
  return { user: credential.user, profile };
};

export const registerWithEmail = async ({ fullName, email, password, role, extraProfile = {}, legalAcceptance }) => {
  if (!auth) throw new Error('Firebase not configured. Please set up environment variables.');
  if (!['student', 'tutor', 'teacher', 'parent'].includes(role)) throw new Error('Choose a valid account type.');
  if (legalAcceptance?.termsAccepted !== true || legalAcceptance?.privacyNoticeAcknowledged !== true
    || !legalAcceptance?.version) {
    throw new Error('Please accept the current Terms of Use and acknowledge the Privacy Policy before creating an account.');
  }
  const isTutorRole = role === 'tutor' || role === 'teacher';
  const marketingEmailOptIn = extraProfile.marketingEmailOptIn === true;
  const whatsappNumber = role === 'student' ? normalizeWhatsAppNumber(extraProfile.whatsappNumber) : '';
  const tutorWhatsAppNumber = isTutorRole ? normalizeWhatsAppNumber(extraProfile.whatsappNumber) : '';
  const safeExtraProfile = Object.fromEntries(Object.entries(extraProfile)
    .filter(([key]) => key !== 'marketingEmailOptIn' && (!isTutorRole || key !== 'whatsappNumber')));
  const studentDefaults = role === 'student'
    ? {
      paymentCompleted: false,
      subscriptionStatus: 'pending',
    }
    : {};

  const credential = await createUserWithEmailAndPassword(auth, email.trim(), password);
  const profile = Object.fromEntries(Object.entries({
    ...safeExtraProfile,
    ...studentDefaults,
    uid: credential.user.uid,
    email: credential.user.email || email.trim(),
    emailLowercase: (credential.user.email || email.trim()).toLowerCase(),
    displayName: fullName.trim(),
    role,
    marketingEmailOptIn,
    termsAccepted: true,
    termsAcceptedAt: serverTimestamp(),
    termsVersion: legalAcceptance.version,
    privacyNoticeAcknowledged: true,
    privacyNoticeAcknowledgedAt: serverTimestamp(),
    privacyNoticeVersion: legalAcceptance.version,
    ...(isTutorRole ? { subject: null, subjects: [] } : {}),
    isTeacher: role === 'teacher' || extraProfile.isTeacher === true || extraProfile.isTeacher === 'true',
    createdAt: serverTimestamp(),
    ...(role === 'student' ? { whatsappNumber } : {}),
  }).filter(([, value]) => value !== undefined));

  try {
    await updateProfile(credential.user, { displayName: fullName.trim() });
    await setDoc(doc(db, collections.users, credential.user.uid), profile);
    if (isTutorRole) {
      if (!functions) throw new Error('Firebase Functions are not configured. Tutor WhatsApp setup is temporarily unavailable.');
      await httpsCallable(functions, 'saveTutorWhatsAppNumber')({ whatsappNumber: tutorWhatsAppNumber });
    }
    return { user: credential.user, profile };
  } catch (error) {
    try {
      await deleteUser(credential.user);
    } catch {
      // Preserve the original profile creation error if account cleanup also fails.
    }
    throw error;
  }
};

export const updateStudentOnboarding = async ({ uid, previousYearMark }) => {
  if (!isFirebaseConfigured) {
    return { uid, previousYearMark, latestMark: previousYearMark, paymentCompleted: false, subscriptionStatus: 'pending' };
  }

  const payload = {
    previousYearMark: Number(previousYearMark),
    latestMark: Number(previousYearMark),
    updatedAt: serverTimestamp(),
  };

  await updateDoc(doc(db, collections.users, uid), payload);
  return { uid, ...payload };
};

export const signInWithGoogle = async () => {
  if (!auth) throw new Error('Firebase not configured. Please set up environment variables.');
  const credential = await signInWithPopup(auth, provider);
  const profile = await getUserProfile(credential.user.uid);
  if (!profile) {
    await signOut(auth);
    throw new Error('This login has no Examify profile. Contact an administrator to restore the account link.');
  }
  return { user: credential.user, profile };
};

export const getUserProfile = async (uid) => {
  if (!isFirebaseConfigured) {
    return Object.values(mockUsers).find((user) => user.uid === uid) ?? null;
  }

  const existingRequest = profileRequests.get(uid);
  if (existingRequest) return existingRequest;

  const request = trackFirestoreRead('getUserProfile', () => firebaseGetDoc(doc(db, collections.users, uid)))
    .then((snapshot) => snapshot.exists() ? snapshot.data() : null);
  profileRequests.set(uid, request);
  try {
    return await request;
  } finally {
    if (profileRequests.get(uid) === request) profileRequests.delete(uid);
  }
};

export const logout = async () => {
  if (!isFirebaseConfigured) return true;
  await signOut(auth);
  return true;
};

export const updateUserProfileDetails = async ({ uid, displayName, grade, whatsappNumber, role, newPassword, restoreSubjectInstanceIds = [] }) => {

  const normalizedWhatsAppNumber = whatsappNumber === undefined ? undefined : normalizeWhatsAppNumber(whatsappNumber);
  let gradeChangeResult = null;

  if (isFirebaseConfigured && auth?.currentUser) {
    if (displayName) {
      await updateProfile(auth.currentUser, { displayName });
    }
    if (newPassword) {
      await updatePassword(auth.currentUser, newPassword);
    }
    
    if (grade) {
      if (!functions) throw new Error('Firebase Functions are not configured. Grade changes are temporarily unavailable.');
      const changeGrade = httpsCallable(functions, 'changeStudentGrade');
      gradeChangeResult = (await changeGrade({ studentId: uid, newGrade: grade, restoreSubjectInstanceIds })).data;
    }

    const payload = { updatedAt: serverTimestamp() };
    if (displayName) payload.displayName = displayName;
    if (role === 'tutor' || role === 'teacher') {
      if (normalizedWhatsAppNumber) {
        if (!functions) throw new Error('Firebase Functions are not configured. Tutor WhatsApp setup is temporarily unavailable.');
        await httpsCallable(functions, 'saveTutorWhatsAppNumber')({ whatsappNumber: normalizedWhatsAppNumber });
      }
      await updateDoc(doc(db, collections.users, uid), { ...payload, whatsappNumber: deleteField() });
    } else {
      if (normalizedWhatsAppNumber) payload.whatsappNumber = normalizedWhatsAppNumber;
      await updateDoc(doc(db, collections.users, uid), payload);
    }
    return { uid, ...payload, gradeChangeResult };
  } else {
    // Demo mode bypass
    return { uid, displayName, grade, whatsappNumber: normalizedWhatsAppNumber };
  }
};


export const deleteCurrentUserAccount = async (uid) => {
  if (!isFirebaseConfigured) {
    return true;
  }

  if (!auth?.currentUser || auth.currentUser.uid !== uid) {
    throw new Error('You must be signed in as this user to delete the account.');
  }

  await deleteDoc(doc(db, collections.users, uid));
  await deleteUser(auth.currentUser);
  return true;
};
