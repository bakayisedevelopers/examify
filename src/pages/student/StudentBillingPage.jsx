import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { AppShell } from '../../components/common/AppShell';
import { SubscriptionPlanSelector } from '../../components/billing/SubscriptionPlanSelector';
import { useAuth } from '../../hooks/useAuth';
import { generateExercisePlanIfEligible, getStudentAccessState } from '../../services/firestoreService';
import { initializeSubscriptionPayment, verifySubscriptionPayment } from '../../services/paymentsService';
import { DEFAULT_SUBJECT } from '../../lib/constants';

export const StudentBillingPage = () => {
  const { profile, logout, refreshProfile } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();

  const [status, setStatus] = useState('');
  const [isVerifyingPayment, setIsVerifyingPayment] = useState(false);
  const [isStartingSubscription, setIsStartingSubscription] = useState(false);

  const lastVerifiedReferenceRef = useRef(null);
  const params = new URLSearchParams(location.search);
  const initialSelection = {
    planId: params.get('planId'),
    billingPeriod: params.get('billingPeriod'),
    subjectCount: params.get('subjectCount'),
  };

  const refreshAccess = useCallback(async () => {
    return getStudentAccessState(profile, DEFAULT_SUBJECT);
  }, [profile]);

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
    await refreshProfile(profile?.uid);
    const snapshot = await refreshAccess();

    if (snapshot?.initialGenerationReady) {
      const generation = await generateExercisePlanIfEligible({
        student: {
          ...profile,
          paymentCompleted: true,
          latestPaymentReference: reference,
        },
        mode: 'initial',
        subject: DEFAULT_SUBJECT,
      });

      setStatus(
        `Payment verified successfully. Initial exercise generation ${
          generation?.generated ? 'ran successfully.' : 'is waiting for remaining criteria.'
        }`,
      );
    } else {
      setStatus('Payment verified successfully. Initial exercise generation is still waiting for the remaining criteria.');
    }
  }, [profile, refreshAccess, refreshProfile]);

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
        await refreshProfile(profile.uid);
        setStatus('Free subscription activated. Unlimited question papers are available.');
        navigate('/student/papers');
      } else if (result.scheduledChange) {
        setStatus(`Your ${result.quote.planName} plan will begin on ${formatRenewalDate(result.effectiveAt)}.`);
        await refreshProfile(profile.uid);
      } else if (result.alreadyActive) {
        setStatus(`Your ${result.quote.planName} subscription is already active.`);
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

        const verification = await verifySubscriptionPayment(reference);

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
      title="Billing"
      subtitle="Choose a subscription and manage your billing period."
      role="student"
      user={profile}
      onLogout={logout}
    >
      {profile?.subscriptionPlanId ? (
        <div className="panel mb-5 p-4 text-sm">
          Current plan: <strong>{profile.subscriptionPlanName || 'Free'}</strong>{profile?.subscriptionRenewalDate ? ` · renews ${formatRenewalDate(profile.subscriptionRenewalDate)}` : ''}
        </div>
      ) : null}
      <SubscriptionPlanSelector onContinue={handleContinue} isSubmitting={isStartingSubscription || isVerifyingPayment} initialSelection={initialSelection} />
      <div className="mt-5 space-y-3">
        {status ? <div role="status" className="panel p-4 text-sm text-slate-700">{status}</div> : null}
        {isVerifyingPayment ? <p role="status" className="text-sm text-slate-600">Verifying your payment…</p> : null}
      </div>
    </AppShell>
  );
};
