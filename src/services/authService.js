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
import { auth, db, isFirebaseConfigured } from '../firebase/config';
import { collections } from '../firebase/schema';
import { mockUsers } from '../data/mockData';
import { DEFAULT_SUBJECT } from '../lib/constants';

const provider = isFirebaseConfigured ? new GoogleAuthProvider() : null;

export const loginWithEmail = async ({ email, password }) => {
  if (!auth) throw new Error('Firebase not configured. Please set up environment variables.');
  const credential = await signInWithEmailAndPassword(auth, email, password);
  const profile = await getUserProfile(credential.user.uid);
  return { user: credential.user, profile };
};

export const registerWithEmail = async ({ fullName, email, password, role, extraProfile = {} }) => {
  if (!auth) throw new Error('Firebase not configured. Please set up environment variables.');
  const studentDefaults = role === 'student'
    ? {
      previousYearMark: Number(extraProfile.previousYearMark ?? 0),
      latestMark: Number(extraProfile.previousYearMark ?? 0),
      paymentCompleted: false,
      subscriptionStatus: 'pending',
      subject: DEFAULT_SUBJECT,
    }
    : {};

  const credential = await createUserWithEmailAndPassword(auth, email, password);
  await updateProfile(credential.user, { displayName: fullName });

  const profile = {
    uid: credential.user.uid,
    email,
    displayName: fullName,
    role,
    subject: role === 'tutor' ? null : DEFAULT_SUBJECT,
    subjects: role === 'tutor' ? [] : [DEFAULT_SUBJECT],
    createdAt: serverTimestamp(),
    ...studentDefaults,
    ...extraProfile,
  };

  await setDoc(doc(db, collections.users, credential.user.uid), profile);
  return { user: credential.user, profile };
};

export const updateStudentOnboarding = async ({ uid, previousYearMark, sessionType }) => {
  if (!isFirebaseConfigured) {
    return { uid, previousYearMark, latestMark: previousYearMark, sessionType, paymentCompleted: false, subscriptionStatus: 'pending' };
  }

  const payload = {
    previousYearMark: Number(previousYearMark),
    latestMark: Number(previousYearMark),
    sessionType,
    paymentCompleted: false,
    subscriptionStatus: 'pending',
    updatedAt: serverTimestamp(),
  };

  await updateDoc(doc(db, collections.users, uid), payload);
  return { uid, ...payload };
};

export const markStudentPaymentComplete = async ({ uid, reference }) => {
  if (!isFirebaseConfigured) {
    return { uid, paymentCompleted: true, subscriptionStatus: 'active', latestPaymentReference: reference };
  }

  const payload = {
    paymentCompleted: true,
    subscriptionStatus: 'active',
    latestPaymentReference: reference,
    updatedAt: serverTimestamp(),
  };

  await updateDoc(doc(db, collections.users, uid), payload);
  return { uid, ...payload };
};

export const signInWithGoogle = async () => {
  if (!auth) throw new Error('Firebase not configured. Please set up environment variables.');
  const credential = await signInWithPopup(auth, provider);
  const profile = await getUserProfile(credential.user.uid);
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

export const updateUserProfileDetails = async ({ uid, displayName, previousYearMark, grade, newPassword }) => {

  if (isFirebaseConfigured && auth?.currentUser) {
    if (displayName) {
      await updateProfile(auth.currentUser, { displayName });
    }
    if (newPassword) {
      await updatePassword(auth.currentUser, newPassword);
    }
    
    const payload = { updatedAt: serverTimestamp() };
    if (displayName) payload.displayName = displayName;
    if (previousYearMark !== undefined && previousYearMark !== null) {
      payload.previousYearMark = Number(previousYearMark);
    }
    if (grade) payload.grade = grade;
    
    await updateDoc(doc(db, collections.users, uid), payload);
    return { uid, ...payload };
  } else {
    // Demo mode bypass
    return { uid, displayName, previousYearMark, grade };
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
