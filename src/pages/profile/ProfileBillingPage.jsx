import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AppShell } from '../../components/common/AppShell';
import { useAuth } from '../../hooks/useAuth';
import { useStudentSubscriptionState } from '../../hooks/useStudentSubscriptionState';
import { ROLES } from '../../lib/constants';
import { getTutorBillingSummary } from '../../services/firestoreService';
import { SubscriptionLifecyclePanel } from '../../components/billing/SubscriptionLifecyclePanel';
import { SubscriptionPlanSelector } from '../../components/billing/SubscriptionPlanSelector';
import { initializeSubscriptionPayment } from '../../services/paymentsService';
import { refreshStudentSubscriptionState, setStudentSubscriptionState } from '../../services/studentSubscriptionStateStore';

export const ProfileBillingPage = ({ role }) => {
  const { profile, logout, refreshProfile } = useAuth();
  const navigate = useNavigate();
  const [summary, setSummary] = useState(null);
  const [subscriptionStatus, setSubscriptionStatus] = useState('');
  const [isStartingSubscription, setIsStartingSubscription] = useState(false);
  const subscriptionState = useStudentSubscriptionState(role === ROLES.STUDENT ? profile : null);

  const continueSubscription = async (selection) => {
    setSubscriptionStatus('');
    setIsStartingSubscription(true);
    try {
      const result = await initializeSubscriptionPayment({
        studentId: profile.uid,
        ...selection,
        callbackUrl: `${window.location.origin}/student/billing`,
      });
      if (result.free) {
        const refreshedProfile = await refreshProfile(profile.uid);
        await refreshStudentSubscriptionState(refreshedProfile || profile);
        setSubscriptionStatus('Free plan activated. Unlimited question papers are available.');
        navigate('/student/papers');
      } else if (result.scheduledChange) {
        const refreshedProfile = await refreshProfile(profile.uid);
        await refreshStudentSubscriptionState(refreshedProfile || profile);
        setSubscriptionStatus(`${result.quote.planName} will start on ${new Date(result.effectiveAt).toLocaleDateString()}.${result.manualPaymentRequired ? ' Payment will be required then.' : ''}`);
      } else if (result.pendingChangeCancelled) {
        setSubscriptionStatus('Scheduled change cancelled. Your current plan will continue.');
      } else if (result.alreadyActive) {
        setSubscriptionStatus(result.renewalCancelled
          ? `${result.quote.planName} remains active until ${new Date(result.renewalDate).toLocaleDateString()}. Resume renewal in subscription management to keep it after that date.`
          : `${result.quote.planName} is already active.`);
      } else if (result.authorizationUrl) {
        window.location.href = result.authorizationUrl;
      } else {
        throw new Error('Could not start subscription checkout.');
      }
    } catch (error) {
      setSubscriptionStatus(error?.message || 'Could not start subscription checkout.');
    } finally {
      setIsStartingSubscription(false);
    }
  };

  useEffect(() => {
    if (role === ROLES.TUTOR && profile?.uid) {
      getTutorBillingSummary(profile.uid).then(setSummary).catch((error) => {
        console.error('[Examifying][TutorBilling] load:error', error);
        setSummary({ totalLessons: 0, studentsTutored: 0, subjectsTutored: [], recentLessons: [] });
      });
    }
  }, [profile?.uid, role]);

  if (role === ROLES.STUDENT) {
    return (
      <AppShell title="Subscription" subtitle="Choose your plan and billing period." role={role} user={profile} onLogout={logout}>
        <div className="panel mb-5 p-4 text-sm">
          {!subscriptionState ? <p role="status">Checking your current subscription…</p> : (
            <>
              <p>Current plan: <strong>{subscriptionState.subscriptionPlanName}</strong>{subscriptionState.paymentCompleted ? ` · ${subscriptionState.subscriptionSubjectCount} subjects` : ''}{subscriptionState.subscriptionRenewalDate ? ` · renews ${new Date(subscriptionState.subscriptionRenewalDate?.toDate?.() ?? subscriptionState.subscriptionRenewalDate).toLocaleDateString()}` : ''}</p>
              {subscriptionState.subscriptionPlanId === 'free' ? <p className="mt-2 text-amber-700">{subscriptionState.requiresSubscriptionSelection ? 'Your account is on Free until you choose a subscription and complete payment.' : 'Free includes Past Papers. Choose a paid subscription to unlock the Examifying Program.'} Question papers remain available.</p> : null}
            </>
          )}
        </div>
        {subscriptionState ? (
          <SubscriptionLifecyclePanel
            studentId={profile.uid}
            subscriptionState={subscriptionState}
            onStateChange={(nextState) => setStudentSubscriptionState(profile.uid, nextState)}
            onContinuePayment={() => {
              const selection = subscriptionState.pendingPlan || subscriptionState;
              continueSubscription({
                planId: selection.planId || subscriptionState.subscriptionPlanId,
                billingPeriod: selection.billingPeriod || subscriptionState.subscriptionBillingPeriod || 'monthly',
                subjectCount: selection.subjectCount || subscriptionState.subscriptionSubjectCount || 1,
              });
            }}
          />
        ) : null}
        {subscriptionState ? <SubscriptionPlanSelector
          key={`${subscriptionState.pendingPlan?.planId || subscriptionState.subscriptionPlanId}-${subscriptionState.pendingPlan?.billingPeriod || subscriptionState.subscriptionBillingPeriod}-${subscriptionState.pendingPlan?.subjectCount || subscriptionState.subscriptionSubjectCount}`}
          initialSelection={{
            planId: subscriptionState.pendingPlan?.planId || subscriptionState.subscriptionPlanId,
            billingPeriod: subscriptionState.pendingPlan?.billingPeriod || subscriptionState.subscriptionBillingPeriod,
            subjectCount: subscriptionState.pendingPlan?.subjectCount || subscriptionState.subscriptionSubjectCount || 1,
          }}
          onContinue={continueSubscription}
          isSubmitting={isStartingSubscription}
        /> : null}
        {subscriptionStatus ? <div role="status" className="panel mt-5 p-4 text-sm">{subscriptionStatus}</div> : null}
      </AppShell>
    );
  }

  if (role === ROLES.TUTOR) {
    return (
      <AppShell title="Tutor billing" subtitle="Review tutoring activity used for billing and reconciliation." role={role} user={profile} onLogout={logout}>
        <section className="grid gap-4 md:grid-cols-3">
          <div className="panel p-5"><p className="text-sm text-slate-500">Lessons tutored</p><p className="mt-2 text-3xl font-bold text-slate-950">{summary?.totalLessons ?? 0}</p></div>
          <div className="panel p-5"><p className="text-sm text-slate-500">Students tutored</p><p className="mt-2 text-3xl font-bold text-slate-950">{summary?.studentsTutored ?? 0}</p></div>
          <div className="panel p-5"><p className="text-sm text-slate-500">Subjects tutored</p><p className="mt-2 text-3xl font-bold text-slate-950">{summary?.subjectsTutored?.length ?? 0}</p></div>
        </section>
        <section className="panel p-5">
          <p className="text-sm font-semibold text-slate-950">Recent lessons</p>
          <div className="mt-4 space-y-3">
            {(summary?.recentLessons ?? []).map((lesson) => (
              <div key={lesson.id ?? `${lesson.studentId}-${lesson.topic}-${lesson.completedOn}`} className="rounded-2xl bg-slate-50 p-4 text-sm">
                <p className="font-semibold text-slate-900">{lesson.topic}</p>
                <p className="mt-1 text-slate-500">{lesson.subject} • {lesson.studentName ?? 'Student'} • {lesson.completedOn ?? 'No date'}</p>
              </div>
            ))}
            {summary && !summary.recentLessons?.length ? <p className="text-sm text-slate-500">No completed lessons have been recorded yet.</p> : null}
          </div>
        </section>
      </AppShell>
    );
  }

  return (
    <AppShell title="Billing" subtitle="Billing information for this account." role={role} user={profile} onLogout={logout}>
      <div className="panel p-5 text-sm text-slate-600">No billing workflow is configured for this role yet.</div>
    </AppShell>
  );
};
