import { Navigate, Outlet } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';
import { ROLES } from '../../lib/constants';
import { StudentNotificationGate } from './StudentNotificationGate';
import { LoaderCircle } from 'lucide-react';

export const ProtectedRoute = ({ allowedRoles }) => {
  const { loading, profile } = useAuth();

  if (loading) {
    return <div className="flex min-h-screen items-center justify-center gap-3 bg-slate-950 text-sm font-semibold text-slate-200" role="status"><LoaderCircle className="h-5 w-5 animate-spin text-lime-300" aria-hidden="true" /><span className="bg-gradient-to-r from-lime-400 via-lime-300 to-emerald-400 bg-clip-text text-transparent">Loading Examifying…</span></div>;
  }

  if (!profile) {
    return <Navigate to="/login" replace />;
  }

  if (allowedRoles && !allowedRoles.includes(profile.role)) {
    return <Navigate to={`/${profile.role}`} replace />;
  }

  return (
    <StudentNotificationGate profile={profile} required={profile.role === ROLES.STUDENT && allowedRoles?.includes(ROLES.STUDENT)}>
      <Outlet />
    </StudentNotificationGate>
  );
};
