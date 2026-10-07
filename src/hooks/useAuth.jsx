import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { onAuthStateChanged } from 'firebase/auth';
import { auth, isFirebaseConfigured } from '../firebase/config';
import {
  getUserProfile,
  loginWithEmail,
  logout,
  registerWithEmail,
  signInWithGoogle,
  updateStudentOnboarding,
} from '../services/authService';
import { mockUsers } from '../data/mockData';
import { loadStudentSubscriptionState } from '../services/studentSubscriptionStateStore';
import { queryClient } from '../lib/queryClient';

const AuthContext = createContext(null);

export const AuthProvider = ({ children }) => {
  const [state, setState] = useState({ user: null, profile: null, loading: true, error: null });
  const lastAuthUid = useRef(null);

  const refreshProfile = async (uid, userOverride = null) => {
    const profile = await getUserProfile(uid);
    setState((current) => ({ ...current, user: userOverride ?? current.user, profile, loading: false, error: null }));
    return profile;
  };

  useEffect(() => {
    if (!isFirebaseConfigured) {
      setState({ user: null, profile: null, loading: false, error: null });
      return undefined;
    }

    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      const nextUid = firebaseUser?.uid ?? null;
      if (lastAuthUid.current !== nextUid) queryClient.clear();
      lastAuthUid.current = nextUid;

      if (!firebaseUser) {
        setState({ user: null, profile: null, loading: false, error: null });
        return;
      }

      const profile = await getUserProfile(firebaseUser.uid);
      setState({ user: firebaseUser, profile, loading: false, error: null });
      if (profile?.role === 'student') {
        void loadStudentSubscriptionState(profile, { maxAgeMs: 30_000 });
      }
    });

    return unsubscribe;
  }, []);

  const value = useMemo(() => ({
    ...state,
    isDemoMode: !isFirebaseConfigured,
    refreshProfile,
    login: async (payload) => {
      const result = await loginWithEmail(payload);
      queryClient.clear();
      setState({ user: result.user, profile: result.profile, loading: false, error: null });
      if (result.profile?.role === 'student') {
        void loadStudentSubscriptionState(result.profile, { maxAgeMs: 30_000 });
      }
      return result;
    },
    register: async (payload) => {
      const result = await registerWithEmail(payload);
      queryClient.clear();
      setState({ user: result.user, profile: result.profile, loading: false, error: null });
      if (result.profile?.role === 'student') {
        void loadStudentSubscriptionState(result.profile, { maxAgeMs: 30_000 });
      }
      return result;
    },
    updateStudentOnboarding: async (payload) => {
      const updated = await updateStudentOnboarding(payload);
      setState((current) => ({
        ...current,
        profile: { ...current.profile, ...updated },
      }));
      return updated;
    },
    loginAsDemo: async (email) => {
      const mockUser = mockUsers[email];
      if (!mockUser) throw new Error('Unknown demo account');
      queryClient.clear();
      if (mockUser.role === 'student') {
        await loadStudentSubscriptionState(mockUser, { maxAgeMs: 30_000 });
      }
      setState({ user: mockUser, profile: mockUser, loading: false, error: null });
      return mockUser;
    },
    loginWithGoogle: async () => {
      const result = await signInWithGoogle();
      queryClient.clear();
      setState({ user: result.user, profile: result.profile, loading: false, error: null });
      if (result.profile?.role === 'student') {
        void loadStudentSubscriptionState(result.profile, { maxAgeMs: 30_000 });
      }
      return result;
    },
    logout: async () => {
      await logout();
      queryClient.clear();
      setState({ user: null, profile: null, loading: false, error: null });
    },
  }), [state]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within AuthProvider');
  return context;
};
