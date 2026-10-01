import { Navigate, Outlet } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';
import { useStudentSubscriptionState } from '../../hooks/useStudentSubscriptionState';

export const PaidStudentRoute = () => {
  const { profile } = useAuth();
  const subscriptionState = useStudentSubscriptionState(profile);

  if (!subscriptionState) {
    return <div className="flex min-h-screen items-center justify-center text-slate-700">Checking subscription…</div>;
  }

  if (!subscriptionState.paymentCompleted) {
    return <Navigate to="/student/papers" replace />;
  }

  return <Outlet />;
};
