import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { AppShell } from '../../components/common/AppShell';
import { SectionHeader } from '../../components/common/SectionHeader';
import { useAuth } from '../../hooks/useAuth';
import { generateExercisePlanIfEligible, getStudentAccessState } from '../../services/firestoreService';
import {
  getSubscriptionQuote,
  initializeSubscriptionPayment,
  verifySubscriptionPayment,
} from '../../services/paymentsService';
import { DEFAULT_SUBJECT, SESSION_TYPE_LABELS } from '../../lib/constants';

export const StudentBillingPage = () => {
  const { profile, logout, refreshProfile, isDemoMode } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();

  const [status, setStatus] = useState('');
  const [accessState, setAccessState] = useState(null);
  const [isInitializingPayment, setIsInitializingPayment] = useState(false);
  const [isVerifyingPayment, setIsVerifyingPayment] = useState(false);

  const lastVerifiedReferenceRef = useRef(null);

  const quote = useMemo(
    () =>
      getSubscriptionQuote({
        latestMark:  profile?.previousYearMark ?? 0,
        sessionType: profile?.sessionType ?? 'online',
      }),
    [profile],
  );

  const refreshAccess = async () => {
    const snapshot = await getStudentAccessState(profile, DEFAULT_SUBJECT);
    setAccessState(snapshot);
    return snapshot;
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

  const completeStudentAccessFlow = async (reference) => {
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
  };

  const handlePaymentStart = async () => {
    try {
      setIsInitializingPayment(true);
      setStatus('');

      const result = await initializeSubscriptionPayment({
        email: profile?.email,
        studentId: profile?.uid,
        latestMark:  profile?.previousYearMark ?? 0,
        sessionType: profile?.sessionType ?? 'online',
        callbackUrl: `${window.location.origin}${location.pathname}`,
      });

      if (!result?.authorizationUrl) {
        throw new Error('No Paystack authorization URL was returned.');
      }

      setStatus('Redirecting you to Paystack...');
      window.location.href = result.authorizationUrl;
    } catch (error) {
      setStatus(error?.message || 'Unable to initialize payment right now.');
    } finally {
      setIsInitializingPayment(false);
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
  }, [location.pathname, location.search, navigate, profile?.uid]);

  return (
    <AppShell
      title="Billing"
      subtitle="Manage subscription logic, payment completion, and the exercise-unlock workflow."
      role="student"
      user={profile}
      onLogout={logout}
    >
      <SectionHeader
        eyebrow="Subscription"
        title="Current recommendation"
        description="Examifying calculates the monthly amount from the student-entered previous year mark until fresh learning data is available."
      />

      <div className="grid gap-4 md:grid-cols-4">
        <div className="panel p-5">
          <p className="text-sm text-slate-500">Session type</p>
          <p className="mt-2 text-2xl font-bold text-slate-950">
            {SESSION_TYPE_LABELS[quote.sessionType]}
          </p>
        </div>

        <div className="panel p-5">
          <p className="text-sm text-slate-500">Previous year mark</p>
          <p className="mt-2 text-2xl font-bold text-slate-950">
            {profile?.previousYearMark ?? 0}%
          </p>
        </div>

        <div className="panel p-5">
          <p className="text-sm text-slate-500">Sessions</p>
          <p className="mt-2 text-2xl font-bold text-slate-950">{quote.sessionCount}</p>
        </div>

        <div className="panel p-5">
          <p className="text-sm text-slate-500">Monthly amount</p>
          <p className="mt-2 text-2xl font-bold text-slate-950">R{quote.amount.toFixed(2)}</p>
        </div>
      </div>

      <div className="panel mt-6 space-y-4 p-5 text-sm leading-7 text-slate-600">
        <p>Complete payment here to unlock the student learning flow and keep your subscription active.</p>

        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            className="btn-primary"
            onClick={handlePaymentStart}
            disabled={isInitializingPayment || isVerifyingPayment || profile?.paymentCompleted}
          >
            {isInitializingPayment
              ? 'Initializing Payment...'
              : isVerifyingPayment
              ? 'Verifying Payment...'
              : 'Pay Now'}
          </button>

          {profile?.paymentCompleted && (
            <>
              <button type="button" className="btn-secondary" disabled>
                Payment Done ✅
              </button>

              <button type="button" className="btn-secondary" disabled>
                Renews on: {formatRenewalDate(profile?.subscriptionRenewalDate)}
              </button>
            </>
          )}
        </div>

        {status ? (
          <div className="rounded-2xl bg-slate-50 p-4">
            <p className="font-medium text-slate-900">{status}</p>
          </div>
        ) : null}

        {accessState ? (
          <div className="rounded-2xl bg-slate-50 p-4">
            <p className="font-semibold text-slate-900">Access checks</p>
            <p className="mt-2">Payment completed: {String(accessState.paymentCompleted)}</p>
            <p>Initial generation ready: {String(accessState.initialGenerationReady)}</p>
            <p>Weekly generation ready: {String(accessState.weeklyGenerationReady)}</p>
          </div>
        ) : null}

        <p>
          {isDemoMode
            ? 'Demo mode is active.'
            : 'Live mode is active. Payment verification is handled automatically after Paystack redirects back.'}
        </p>
      </div>
    </AppShell>
  );
};
