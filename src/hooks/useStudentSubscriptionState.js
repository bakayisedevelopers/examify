import { useCallback, useEffect, useSyncExternalStore } from 'react';
import {
  getCachedStudentSubscriptionState,
  loadStudentSubscriptionState,
  subscribeToStudentSubscriptionState,
} from '../services/studentSubscriptionStateStore';

export const useStudentSubscriptionState = (profile) => {
  const uid = profile?.role === 'student' ? profile.uid : null;
  const subscribe = useCallback(
    (listener) => subscribeToStudentSubscriptionState(uid, listener),
    [uid],
  );
  const getSnapshot = useCallback(() => getCachedStudentSubscriptionState(uid), [uid]);
  const subscriptionState = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    if (uid) void loadStudentSubscriptionState(profile, { maxAgeMs: 30_000 });
  }, [profile, uid]);

  return subscriptionState;
};
