import { createContext, useContext, useEffect, useMemo, useState } from 'react';
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

const AuthContext = createContext(null);

export const AuthProvider = ({ children }) => {
  const [state, setState] = useState({ user: null, profile: null, loading: true, error: null });

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
      if (!firebaseUser) {
        setState({ user: null, profile: null, loading: false, error: null });
        return;
      }

      const profile = await getUserProfile(firebaseUser.uid);
      if (profile?.role === 'student') {
        await loadStudentSubscriptionState(profile, { maxAgeMs: 30_000 });
      }
      setState({ user: firebaseUser, profile, loading: false, error: null });
    });

    return unsubscribe;
  }, []);

  const value = useMemo(() => ({
    ...state,
    isDemoMode: !isFirebaseConfigured,
    refreshProfile,
    login: async (payload) => {
      const result = await loginWithEmail(payload);
      if (result.profile?.role === 'student') {
        await loadStudentSubscriptionState(result.profile, { maxAgeMs: 30_000 });
      }
      setState({ user: result.user, profile: result.profile, loading: false, error: null });
      return result;
    },
    register: async (payload) => {
      const result = await registerWithEmail(payload);
      if (result.profile?.role === 'student') {
        await loadStudentSubscriptionState(result.profile, { maxAgeMs: 30_000 });
      }
      setState({ user: result.user, profile: result.profile, loading: false, error: null });
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
      if (mockUser.role === 'student') {
        await loadStudentSubscriptionState(mockUser, { maxAgeMs: 30_000 });
      }
      setState({ user: mockUser, profile: mockUser, loading: false, error: null });
      return mockUser;
    },
    loginWithGoogle: async () => {
      const result = await signInWithGoogle();
      if (result.profile?.role === 'student') {
        await loadStudentSubscriptionState(result.profile, { maxAgeMs: 30_000 });
      }
      setState({ user: result.user, profile: result.profile, loading: false, error: null });
      return result;
    },
    logout: async () => {
      await logout();
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
