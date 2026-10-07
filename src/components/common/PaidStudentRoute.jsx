import { Navigate, Outlet } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';
import { useStudentSubscriptionState } from '../../hooks/useStudentSubscriptionState';
import { LoaderCircle } from 'lucide-react';

export const PaidStudentRoute = () => {
  const { profile } = useAuth();
  const subscriptionState = useStudentSubscriptionState(profile);

  if (!subscriptionState) {
    return <div className="flex min-h-screen items-center justify-center gap-3 bg-slate-950 text-sm font-medium text-slate-200" role="status"><LoaderCircle className="h-5 w-5 animate-spin text-lime-300" aria-hidden="true" />Checking subscription access…</div>;
  }

  if (!subscriptionState.paymentCompleted) {
    return <Navigate to="/student/papers" replace />;
  }

  return <Outlet />;
};
