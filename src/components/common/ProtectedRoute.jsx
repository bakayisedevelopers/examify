import { Navigate, Outlet } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';
import { ROLES } from '../../lib/constants';
import { StudentNotificationGate } from './StudentNotificationGate';
import { ExamifyingLoader } from './ExamifyingLoader';

export const ProtectedRoute = ({ allowedRoles }) => {
  const { loading, profile } = useAuth();

  if (loading) {
    return <ExamifyingLoader />;
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
