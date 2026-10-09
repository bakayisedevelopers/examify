import { getStudentSubscriptionState } from './firestoreService';

const FREE_PLAN_STATE = {
  subscriptionPlanId: 'free',
  subscriptionPlanName: 'Free',
  subscriptionStatus: 'plan_required',
  subscriptionSubjectCount: 0,
  paymentCompleted: false,
  requiresSubscriptionSelection: true,
  paidSubscriptionActive: false,
};

const snapshots = new Map();
const listeners = new Map();
const inFlight = new Map();

const notify = (uid) => {
  listeners.get(uid)?.forEach((listener) => listener());
};

export const getCachedStudentSubscriptionState = (uid) => snapshots.get(uid)?.state ?? null;

export const subscribeToStudentSubscriptionState = (uid, listener) => {
  if (!uid) return () => {};
  const group = listeners.get(uid) ?? new Set();
  group.add(listener);
  listeners.set(uid, group);
  return () => {
    group.delete(listener);
    if (!group.size) listeners.delete(uid);
  };
};

export const setStudentSubscriptionState = (uid, state) => {
  if (!uid || !state) return state;
  snapshots.set(uid, { state, updatedAt: Date.now() });
  notify(uid);
  return state;
};

export const loadStudentSubscriptionState = (student, { maxAgeMs = Infinity, force = false } = {}) => {
  const uid = student?.uid;
  if (!uid) return Promise.resolve(null);

  const activeRequest = inFlight.get(uid);
  if (activeRequest) return activeRequest;

  const existing = snapshots.get(uid);
  if (existing && !force && Date.now() - existing.updatedAt <= maxAgeMs) {
    return Promise.resolve(existing.state);
  }

  const request = getStudentSubscriptionState(student)
    .then((state) => setStudentSubscriptionState(uid, state || FREE_PLAN_STATE))
    .catch(() => {
      return snapshots.get(uid)?.state || setStudentSubscriptionState(uid, FREE_PLAN_STATE);
    })
    .finally(() => {
      if (inFlight.get(uid) === request) inFlight.delete(uid);
    });

  inFlight.set(uid, request);
  return request;
};

export const refreshStudentSubscriptionState = (student) =>
  loadStudentSubscriptionState(student, { force: true });
