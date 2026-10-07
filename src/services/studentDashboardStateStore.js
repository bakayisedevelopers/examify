const snapshots = new Map();

export const getCachedStudentDashboardState = (uid) => snapshots.get(uid) ?? null;

export const updateCachedStudentDashboardState = (uid, patch) => {
  if (!uid || !patch) return null;
  const next = { ...(snapshots.get(uid) ?? {}), ...patch };
  snapshots.set(uid, next);
  return next;
};
