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
import { deleteDoc, doc, getDoc, serverTimestamp, setDoc, updateDoc } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { auth, db, functions, isFirebaseConfigured } from '../firebase/config';
import { collections } from '../firebase/schema';
import { mockUsers } from '../data/mockData';
import { normalizeWhatsAppNumber } from '../utils/whatsapp';

const provider = isFirebaseConfigured ? new GoogleAuthProvider() : null;

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

export const registerWithEmail = async ({ fullName, email, password, role, extraProfile = {} }) => {
  if (!auth) throw new Error('Firebase not configured. Please set up environment variables.');
  if (!['student', 'tutor', 'teacher', 'parent'].includes(role)) throw new Error('Choose a valid account type.');
  const isTutorRole = role === 'tutor' || role === 'teacher';
  const whatsappNumber = role === 'student' ? normalizeWhatsAppNumber(extraProfile.whatsappNumber) : '';
  const studentDefaults = role === 'student'
    ? {
      previousYearMark: Number(extraProfile.previousYearMark ?? 0),
      latestMark: Number(extraProfile.previousYearMark ?? 0),
      paymentCompleted: false,
      subscriptionStatus: 'pending',
    }
    : {};

  const credential = await createUserWithEmailAndPassword(auth, email.trim(), password);
  const profile = Object.fromEntries(Object.entries({
    ...extraProfile,
    ...studentDefaults,
    uid: credential.user.uid,
    email: credential.user.email || email.trim(),
    displayName: fullName.trim(),
    role,
    ...(isTutorRole ? { subject: null, subjects: [] } : {}),
    isTeacher: role === 'teacher' || extraProfile.isTeacher === true || extraProfile.isTeacher === 'true',
    createdAt: serverTimestamp(),
    ...(role === 'student' ? { whatsappNumber } : {}),
  }).filter(([, value]) => value !== undefined));

  try {
    await updateProfile(credential.user, { displayName: fullName.trim() });
    await setDoc(doc(db, collections.users, credential.user.uid), profile);
    return { user: credential.user, profile };
  } catch (error) {
    try {
      await deleteUser(credential.user);
    } catch (cleanupError) {
      console.error('[Examifying][Auth] Could not remove an account after profile creation failed:', cleanupError?.code || cleanupError?.message);
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

  const snapshot = await getDoc(doc(db, collections.users, uid));
  return snapshot.exists() ? snapshot.data() : null;
};

export const logout = async () => {
  if (!isFirebaseConfigured) return true;
  await signOut(auth);
  return true;
};

export const updateUserProfileDetails = async ({ uid, displayName, previousYearMark, grade, whatsappNumber, newPassword }) => {

  const normalizedWhatsAppNumber = whatsappNumber === undefined ? undefined : normalizeWhatsAppNumber(whatsappNumber);

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
      await changeGrade({ studentId: uid, newGrade: grade });
    }

    const payload = { updatedAt: serverTimestamp() };
    if (displayName) payload.displayName = displayName;
    if (previousYearMark !== undefined && previousYearMark !== null) {
      payload.previousYearMark = Number(previousYearMark);
    }
    if (normalizedWhatsAppNumber) payload.whatsappNumber = normalizedWhatsAppNumber;
    
    await updateDoc(doc(db, collections.users, uid), payload);
    return { uid, ...payload };
  } else {
    // Demo mode bypass
    return { uid, displayName, previousYearMark, grade, whatsappNumber: normalizedWhatsAppNumber };
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
