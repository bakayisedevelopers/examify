import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { AppShell } from '../../components/common/AppShell';
import { SubscriptionLifecyclePanel } from '../../components/billing/SubscriptionLifecyclePanel';
import { SubscriptionPlanSelector } from '../../components/billing/SubscriptionPlanSelector';
import { useAuth } from '../../hooks/useAuth';
import { useStudentSubscriptionState } from '../../hooks/useStudentSubscriptionState';
import { generateExercisePlanIfEligible, getActiveSubjectsForStudent, getStudentAccessState } from '../../services/firestoreService';
import { initializeSubscriptionPayment, verifySubscriptionPayment } from '../../services/paymentsService';
import { refreshStudentSubscriptionState, setStudentSubscriptionState } from '../../services/studentSubscriptionStateStore';

export const StudentBillingPage = () => {
  const { profile, logout, refreshProfile } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const subscriptionState = useStudentSubscriptionState(profile);

  const [status, setStatus] = useState('');
  const [isVerifyingPayment, setIsVerifyingPayment] = useState(false);
  const [isStartingSubscription, setIsStartingSubscription] = useState(false);

  const lastVerifiedReferenceRef = useRef(null);
  const params = new URLSearchParams(location.search);
  const initialSelection = {
    planId: params.get('planId') || subscriptionState?.pendingPlan?.planId || subscriptionState?.subscriptionPlanId || 'free',
    billingPeriod: params.get('billingPeriod') || subscriptionState?.pendingPlan?.billingPeriod || subscriptionState?.subscriptionBillingPeriod,
    subjectCount: params.get('subjectCount') || subscriptionState?.pendingPlan?.subjectCount || subscriptionState?.subscriptionSubjectCount || 2,
  };

  const formatRenewalDate = (value) => {
    if (!value) return 'N/A';

    try {
      if (typeof value === 'string') {
        return new Date(value).toLocaleDateString();
      }

      if (value?.toDate) {
        return value.toDate().toLocaleDateString();
      }

      return String(value);
    } catch {
      return 'N/A';
    }
  };

  const completeStudentAccessFlow = useCallback(async (reference) => {
    const refreshedProfile = await refreshProfile(profile?.uid);
    const activeProfile = refreshedProfile || profile;
    await refreshStudentSubscriptionState(activeProfile);
    const subjects = await getActiveSubjectsForStudent(activeProfile.uid);
    if (!subjects.length) {
      setStatus('Payment verified successfully. Choose your registered subjects to start the Examifying Program.');
      return;
    }

    const outcomes = [];
    for (const subject of subjects) {
      const access = await getStudentAccessState(activeProfile, subject);
      if (!access.paidSubscriptionActive) continue;
      if (!access.initialGenerationReady || access.hasInitialGeneration) {
        outcomes.push({ subject, generated: false, waiting: !access.hasInitialGeneration });
        continue;
      }
      const generation = await generateExercisePlanIfEligible({
        student: { ...activeProfile, latestPaymentReference: reference },
        mode: 'initial',
        subject,
      });
      outcomes.push({ subject, generated: Boolean(generation?.generated), waiting: !generation?.generated });
    }

    const generatedSubjects = outcomes.filter((outcome) => outcome.generated).map((outcome) => outcome.subject);
    const waitingSubjects = outcomes.filter((outcome) => outcome.waiting).map((outcome) => outcome.subject);
    if (generatedSubjects.length) {
      setStatus(`Payment verified. Initial exercise generation started for ${generatedSubjects.join(', ')}.${waitingSubjects.length ? ` Still waiting on requirements for ${waitingSubjects.join(', ')}.` : ''}`);
    } else {
      setStatus(`Payment verified successfully. Initial exercise generation is waiting for the remaining requirements${waitingSubjects.length ? ` for ${waitingSubjects.join(', ')}` : ''}.`);
    }
  }, [profile, refreshProfile]);

  const handleContinue = async (selection) => {
    if (!profile?.uid) return;
    setIsStartingSubscription(true);
    setStatus('');
    try {
      const result = await initializeSubscriptionPayment({
        studentId: profile.uid,
        ...selection,
        callbackUrl: `${window.location.origin}/student/billing`,
      });
      if (result.free) {
        const refreshedProfile = await refreshProfile(profile.uid);
        await refreshStudentSubscriptionState(refreshedProfile || profile);
        setStatus('Free subscription activated. Unlimited question papers are available.');
        navigate('/student/papers');
      } else if (result.scheduledChange) {
        setStatus(`Your ${result.quote.planName} plan will begin on ${formatRenewalDate(result.effectiveAt)}.${result.manualPaymentRequired ? ' Payment will be required then.' : ''}`);
        const refreshedProfile = await refreshProfile(profile.uid);
        await refreshStudentSubscriptionState(refreshedProfile || profile);
      } else if (result.pendingChangeCancelled) {
        setStatus('Scheduled change cancelled. Your current plan will continue.');
      } else if (result.alreadyActive) {
        setStatus(result.renewalCancelled
          ? `Your ${result.quote.planName} subscription remains active until ${formatRenewalDate(result.renewalDate)}. Resume renewal in subscription management to keep it after that date.`
          : `Your ${result.quote.planName} subscription is already active.`);
      } else if (result.authorizationUrl) {
        window.location.href = result.authorizationUrl;
      } else {
        throw new Error('Could not start subscription checkout.');
      }
    } catch (error) {
      setStatus(error?.message || 'Could not start subscription checkout.');
    } finally {
      setIsStartingSubscription(false);
    }
  };

  useEffect(() => {
    const runVerification = async () => {
      if (!profile?.uid) return;

      const params = new URLSearchParams(location.search);
      const reference = params.get('reference') || params.get('trxref');

      if (!reference) return;
      if (lastVerifiedReferenceRef.current === reference) return;

      try {
        lastVerifiedReferenceRef.current = reference;
        setIsVerifyingPayment(true);
        setStatus('Verifying your payment...');

        console.log('[Examifying][Billing] payment:verify:start', {
          studentId: profile?.uid,
          reference,
        });

        const verification = await verifySubscriptionPayment(reference, profile.uid);

        console.log('[Examifying][Billing] payment:verify:result', verification);

        if (verification?.status !== 'success') {
          setStatus(`Payment verification returned status: ${verification?.status ?? 'unknown'}`);
          return;
        }

        await completeStudentAccessFlow(reference);

        navigate(location.pathname, { replace: true });
      } catch (error) {
        console.error('[Examifying][Billing] payment:verify:error', error);
        setStatus(error?.message || 'Payment verification failed.');
      } finally {
        setIsVerifyingPayment(false);
      }
    };

    runVerification();
  }, [completeStudentAccessFlow, location.pathname, location.search, navigate, profile?.uid]);

  return (
    <AppShell
      title="Subscription"
      subtitle="Choose a subscription and manage your billing period."
      role="student"
      user={profile}
      onLogout={logout}
    >
      <div className="panel mb-5 p-4 text-sm">
        {!subscriptionState ? <p role="status">Checking your current subscription…</p> : (
          <>
            <p>Current plan: <strong>{subscriptionState.subscriptionPlanName}</strong>{subscriptionState.paymentCompleted ? ` · ${subscriptionState.subscriptionSubjectCount} subjects` : ''}{subscriptionState.subscriptionRenewalDate ? ` · renews ${formatRenewalDate(subscriptionState.subscriptionRenewalDate)}` : ''}</p>
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
            handleContinue({
              planId: selection.planId || subscriptionState.subscriptionPlanId,
              billingPeriod: selection.billingPeriod || subscriptionState.subscriptionBillingPeriod || 'monthly',
              subjectCount: selection.subjectCount || subscriptionState.subscriptionSubjectCount || 2,
            });
          }}
        />
      ) : null}
      {subscriptionState ? <SubscriptionPlanSelector key={`${initialSelection.planId}-${initialSelection.billingPeriod}-${initialSelection.subjectCount}`} onContinue={handleContinue} isSubmitting={isStartingSubscription || isVerifyingPayment} initialSelection={initialSelection} /> : null}
      <div className="mt-5 space-y-3">
        {status ? <div role="status" className="panel p-4 text-sm text-slate-700">{status}</div> : null}
        {isVerifyingPayment ? <p role="status" className="text-sm text-slate-600">Verifying your payment…</p> : null}
      </div>
    </AppShell>
  );
};
