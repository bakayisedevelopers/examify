import { useCallback, useEffect, useRef, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { AppShell } from '../../components/common/AppShell';
import { SubscriptionLifecyclePanel } from '../../components/billing/SubscriptionLifecyclePanel';
import { SubscriptionPlanSelector } from '../../components/billing/SubscriptionPlanSelector';
import { AuthorizationChargeDisclosure } from '../../components/billing/AuthorizationChargeDisclosure';
import { OperationStatusOverlay } from '../../components/common/OperationStatusOverlay';
import { useAuth } from '../../hooks/useAuth';
import { useOperationStatus } from '../../hooks/useOperationStatus';
import { useStudentSubscriptionState } from '../../hooks/useStudentSubscriptionState';
import { generateExercisePlanIfEligible, getActiveSubjectsForStudent, getStudentAccessState } from '../../services/firestoreService';
import { cancelSubscriptionPaymentCheckout, initializeSubscriptionPayment, verifySubscriptionPayment } from '../../services/paymentsService';
import { refreshStudentSubscriptionState, setStudentSubscriptionState } from '../../services/studentSubscriptionStateStore';

export const StudentBillingPage = () => {
  const { profile, logout, refreshProfile } = useAuth();
  const { runOperation, closeOperationStatus } = useOperationStatus();
  const location = useLocation();
  const navigate = useNavigate();
  const subscriptionState = useStudentSubscriptionState(profile);

  const [status, setStatus] = useState('');
  const [isVerifyingPayment, setIsVerifyingPayment] = useState(false);
  const [paymentVerificationState, setPaymentVerificationState] = useState('idle');
  const [paymentVerificationMessage, setPaymentVerificationMessage] = useState('');
  const [isStartingSubscription, setIsStartingSubscription] = useState(false);
  const [pendingAuthorizationCheckout, setPendingAuthorizationCheckout] = useState(null);
  const [isCancellingAuthorizationCheckout, setIsCancellingAuthorizationCheckout] = useState(false);

  const lastVerifiedReferenceRef = useRef(null);
  const params = new URLSearchParams(location.search);
  const initialSelection = {
    planId: params.get('planId') || subscriptionState?.pendingPlan?.planId || subscriptionState?.subscriptionPlanId || 'free',
    billingPeriod: params.get('billingPeriod') || subscriptionState?.pendingPlan?.billingPeriod || subscriptionState?.subscriptionBillingPeriod,
    subjectCount: params.get('subjectCount') || subscriptionState?.pendingPlan?.subjectCount || subscriptionState?.subscriptionSubjectCount || 1,
    discountCode: params.get('discountCode') || subscriptionState?.pendingPlan?.discountCode || '',
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

  const completeStudentAccessFlow = useCallback(async (reference, verification = null) => {
    const refreshedProfile = await refreshProfile(profile?.uid);
    const activeProfile = refreshedProfile || profile;
    const refreshedSubscription = await refreshStudentSubscriptionState(activeProfile);
    if (!refreshedSubscription?.paidSubscriptionActive) {
      throw new Error(`Paystack verified payment ${reference}, but subscription activation is still being finalized. Retry verification from this page; do not pay again.`);
    }
    const authorizationNote = verification?.authorizationOnly
      ? ` R1.00 was temporarily charged for card authorization; the automatic refund request is ${verification.refundStatus || 'pending'}${verification.nextBillingDate ? `. The next actual charge is expected ${new Date(verification.nextBillingDate).toLocaleDateString()} for R${Number(verification.nextBillingAmount || 0).toFixed(2)}` : (verification.noNextChargeWhileOfferApplies ? '. This offer has no paid renewal while it remains active' : '')}.${verification.manualPaymentRequired ? ' Paystack did not provide a reusable authorization, so the next payment will need to be completed manually.' : ''}`
      : '';
    const subjects = await getActiveSubjectsForStudent(activeProfile.uid);
    if (!subjects.length) {
      setStatus(`Payment verified and subscription activated. Choose your registered subjects to start the Examifying Program.${authorizationNote}`);
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
      const generation = await runOperation({
        operationName: `Generating initial ${subject} exercises`,
        successMessage: 'Initial exercise generation has finished.',
      }, () => generateExercisePlanIfEligible({
        student: { ...activeProfile, latestPaymentReference: reference },
        mode: 'initial',
        subject,
      }));
      outcomes.push({ subject, generated: Boolean(generation?.generated), waiting: !generation?.generated });
    }

    const generatedSubjects = outcomes.filter((outcome) => outcome.generated).map((outcome) => outcome.subject);
    const waitingSubjects = outcomes.filter((outcome) => outcome.waiting).map((outcome) => outcome.subject);
    if (generatedSubjects.length) {
      setStatus(`Payment verified and subscription activated. Initial exercise generation started for ${generatedSubjects.join(', ')}.${waitingSubjects.length ? ` Still waiting on requirements for ${waitingSubjects.join(', ')}.` : ''}${authorizationNote}`);
    } else {
      setStatus(`Payment verified and subscription activated. Initial exercise generation is waiting for the remaining requirements${waitingSubjects.length ? ` for ${waitingSubjects.join(', ')}` : ''}.${authorizationNote}`);
    }
  }, [profile, refreshProfile, runOperation]);

  const verifyPaymentReference = useCallback(async (reference) => {
    if (!reference || !profile?.uid) return 'failed';
    setPaymentVerificationState('verifying');
    setPaymentVerificationMessage('');
    setIsVerifyingPayment(true);
    setStatus('Verifying your payment...');
    try {
      console.log('[Examifying][Billing] payment:verify:start', { studentId: profile.uid, reference });
      const verification = await verifySubscriptionPayment(reference, profile.uid);
      console.log('[Examifying][Billing] payment:verify:result', verification);

      if (verification?.status === 'success') {
        await completeStudentAccessFlow(reference, verification);
        setPaymentVerificationState('success');
        setPaymentVerificationMessage('Your subscription is active. Exercise generation may continue while any remaining requirements are completed.');
        setPendingAuthorizationCheckout(null);
        navigate(location.pathname, { replace: true });
        return 'success';
      }

      const paymentStatus = String(verification?.status || 'unknown').toLowerCase();
      if (['failed', 'abandoned', 'reversed', 'amount_mismatch', 'cancelled'].includes(paymentStatus)) {
        setPaymentVerificationState('failed');
        setPaymentVerificationMessage(`Paystack returned “${paymentStatus}”. If you completed the payment, retry verification before starting another checkout.`);
        setStatus(`Payment verification returned status: ${paymentStatus}`);
        return 'failed';
      }

      setPaymentVerificationState('processing');
      setStatus('Your payment is still processing.');
      return 'processing';
    } catch (error) {
      console.error('[Examifying][Billing] payment:verify:error', error);
      const message = error?.message || 'Payment verification failed.';
      if (message.includes('subscription activation is still being finalized')) {
        setPaymentVerificationState('processing');
        setStatus(message);
        return 'processing';
      }
      setPaymentVerificationState('failed');
      setPaymentVerificationMessage(message);
      setStatus(message);
      return 'failed';
    } finally {
      setIsVerifyingPayment(false);
    }
  }, [completeStudentAccessFlow, location.pathname, navigate, profile?.uid]);

  const handleContinue = async (selection) => {
    if (!profile?.uid) return;
    setIsStartingSubscription(true);
    setStatus('');
    try {
      const result = await runOperation({ operationName: 'Starting subscription checkout', successMessage: 'The subscription request is ready.' }, () => initializeSubscriptionPayment({
        studentId: profile.uid,
        ...selection,
        callbackUrl: `${window.location.origin}/student/billing`,
      }));
      if (result.freeCheckout) {
        await completeStudentAccessFlow(result.reference);
        navigate(location.pathname, { replace: true });
      } else if (result.free) {
        const refreshedProfile = await refreshProfile(profile.uid);
        await refreshStudentSubscriptionState(refreshedProfile || profile);
        setStatus('Free subscription activated. Unlimited question papers are available.');
        navigate('/student/papers');
      } else if (result.scheduledChange) {
        const discountNote = result.discount
          ? ` A ${result.discount.percentOff}% discount (${result.discount.billingDuration === 'fixed_months' ? `first ${result.discount.discountDurationMonths} months` : result.discount.billingDuration === 'recurring' ? 'recurring' : 'first payment'}) is reserved for this change; the next payment is R${Number(result.discount.finalAmount).toLocaleString('en-ZA')}.`
          : '';
        setStatus(`Your ${result.quote.planName} plan will begin on ${formatRenewalDate(result.effectiveAt)}.${discountNote}${result.manualPaymentRequired ? ' Payment will be required then.' : ''}`);
        const refreshedProfile = await refreshProfile(profile.uid);
        await refreshStudentSubscriptionState(refreshedProfile || profile);
      } else if (result.pendingChangeCancelled) {
        setStatus('Scheduled change cancelled. Your current plan will continue.');
      } else if (result.alreadyActive) {
        setStatus(result.renewalCancelled
          ? `Your ${result.quote.planName} subscription remains active until ${formatRenewalDate(result.renewalDate)}. Resume renewal in subscription management to keep it after that date.`
          : `Your ${result.quote.planName} subscription is already active.`);
      } else if (result.requiresAuthorizationDisclosure && result.authorizationUrl) {
        setPendingAuthorizationCheckout(result);
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

  const cancelAuthorizationCheckout = async () => {
    if (!pendingAuthorizationCheckout?.reference || !profile?.uid) return;
    setIsCancellingAuthorizationCheckout(true);
    try {
      const result = await runOperation({ operationName: 'Closing pending checkout', successMessage: 'The checkout status was confirmed.' }, () => cancelSubscriptionPaymentCheckout({ studentId: profile.uid, reference: pendingAuthorizationCheckout.reference }));
      if (result.paymentSucceeded) {
        closeOperationStatus();
        await verifyPaymentReference(pendingAuthorizationCheckout.reference);
        return;
      }
      setPendingAuthorizationCheckout(null);
      setStatus('Checkout closed. If you did not complete the Paystack payment, the reserved discount will be released after Paystack confirms the transaction was abandoned.');
    } catch (error) {
      setStatus(error?.message || 'Could not close the pending checkout.');
    } finally {
      setIsCancellingAuthorizationCheckout(false);
    }
  };

  useEffect(() => {
    const runVerification = async () => {
      if (!profile?.uid) return;

      const params = new URLSearchParams(location.search);
      const reference = params.get('reference') || params.get('trxref');

      if (!reference) return;
      if (lastVerifiedReferenceRef.current === reference) return;

      lastVerifiedReferenceRef.current = reference;
      await verifyPaymentReference(reference);
    };

    runVerification();
  }, [location.search, profile?.uid, verifyPaymentReference]);

  return (
    <AppShell
      title="Subscription"
      subtitle="Choose a subscription and manage your billing period."
      role="student"
      user={profile}
      onLogout={logout}
    >
      <div className="panel mb-5 p-4 text-sm">
          {!subscriptionState ? <p className="flex items-center gap-2" role="status"><LoaderCircle className="h-4 w-4 animate-spin text-lime-500" aria-hidden="true" />Checking your current subscription…</p> : (
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
              subjectCount: selection.subjectCount || subscriptionState.subscriptionSubjectCount || 1,
              discountCode: selection.discountCode || '',
            });
          }}
        />
      ) : null}
      <AuthorizationChargeDisclosure
        checkout={pendingAuthorizationCheckout}
        isCancelling={isCancellingAuthorizationCheckout}
        onContinue={() => { if (pendingAuthorizationCheckout?.authorizationUrl) window.location.assign(pendingAuthorizationCheckout.authorizationUrl); }}
        onCancel={cancelAuthorizationCheckout}
      />
      {subscriptionState ? <SubscriptionPlanSelector key={`${initialSelection.planId}-${initialSelection.billingPeriod}-${initialSelection.subjectCount}-${initialSelection.discountCode}`} onContinue={handleContinue} isSubmitting={isStartingSubscription || isVerifyingPayment || paymentVerificationState === 'processing'} initialSelection={initialSelection} initialDiscountCode={initialSelection.discountCode} studentId={profile.uid} mobileSwipe /> : null}
      <div className="mt-5 space-y-3">
        {status ? <div role="status" className="panel p-4 text-sm text-slate-700">{status}</div> : null}
      </div>
      <OperationStatusOverlay
        state={paymentVerificationState}
        operationName="Payment verification"
        title={paymentVerificationState === 'verifying' ? 'Verifying payment' : paymentVerificationState === 'processing' ? 'Payment processing' : paymentVerificationState === 'success' ? 'Payment successful' : paymentVerificationState === 'failed' ? 'Payment verification failed' : undefined}
        message={paymentVerificationState === 'processing' ? 'Your payment is processing.' : paymentVerificationMessage}
        onDone={() => {
          setPaymentVerificationState('idle');
          setPaymentVerificationMessage('');
          setStatus('');
          navigate(location.pathname, { replace: true });
        }}
        onRetry={() => {
          const reference = params.get('reference') || params.get('trxref') || pendingAuthorizationCheckout?.reference;
          if (reference) void verifyPaymentReference(reference);
        }}
      />
    </AppShell>
  );
};
