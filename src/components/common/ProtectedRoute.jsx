import { Navigate, Outlet } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';

export const ProtectedRoute = ({ allowedRoles }) => {
  const { loading, profile } = useAuth();

  if (loading) {
    return <div className="flex min-h-screen items-center justify-center text-slate-700">Loading Examifying…</div>;
  }

  if (!profile) {
    return <Navigate to="/login" replace />;
  }

  if (allowedRoles && !allowedRoles.includes(profile.role)) {
    return <Navigate to={`/${profile.role}`} replace />;
  }

  return <Outlet />;
};
