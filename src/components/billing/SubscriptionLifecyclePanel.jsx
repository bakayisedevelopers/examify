import { useEffect, useState } from 'react';
import { Ban, CalendarClock, CreditCard, RotateCcw, Undo2 } from 'lucide-react';
import { getStudentSavedPaymentMethods, manageStudentSubscription, retryStudentSubscriptionPayment } from '../../services/paymentsService';
import { refreshStudentSubscriptionState } from '../../services/studentSubscriptionStateStore';
import { useOperationStatus } from '../../hooks/useOperationStatus';

const asDate = (value) => {
  if (value?.toDate) return value.toDate();
  if (value instanceof Date) return value;
  if (typeof value === 'string' || typeof value === 'number') return new Date(value);
  return null;
};

const formatDate = (value) => {
  const date = asDate(value);
  return date && !Number.isNaN(date.getTime()) ? date.toLocaleDateString() : 'Not scheduled';
};
const formatRand = (amount) => `R${Number(amount || 0).toLocaleString('en-ZA', { maximumFractionDigits: 2 })}`;

export const SubscriptionLifecyclePanel = ({
  studentId,
  subscriptionState,
  onStateChange,
  onContinuePayment,
}) => {
  const { runOperation } = useOperationStatus();
  const [busyAction, setBusyAction] = useState('');
  const [message, setMessage] = useState('');
  const [currentState, setCurrentState] = useState(subscriptionState);
  const [paymentMethods, setPaymentMethods] = useState([]);
  const [paymentMethodsLoading, setPaymentMethodsLoading] = useState(true);
  const [paymentMethodsError, setPaymentMethodsError] = useState('');

  useEffect(() => setCurrentState(subscriptionState), [subscriptionState]);

  useEffect(() => {
    let active = true;
    setPaymentMethodsLoading(true);
    setPaymentMethodsError('');
    getStudentSavedPaymentMethods(studentId)
      .then((result) => {
        if (active) setPaymentMethods(Array.isArray(result?.paymentMethods) ? result.paymentMethods : []);
      })
      .catch((error) => {
        if (active) {
          setPaymentMethods([]);
          setPaymentMethodsError(error?.message || 'Saved payment methods could not be loaded.');
        }
      })
      .finally(() => {
        if (active) setPaymentMethodsLoading(false);
      });
    return () => { active = false; };
  }, [studentId]);

  const refreshState = async () => {
    const nextState = await refreshStudentSubscriptionState({ uid: studentId });
    setCurrentState(nextState);
    onStateChange?.(nextState);
    try {
      const methodsResult = await getStudentSavedPaymentMethods(studentId);
      setPaymentMethods(Array.isArray(methodsResult?.paymentMethods) ? methodsResult.paymentMethods : []);
      setPaymentMethodsError('');
    } catch (error) {
      setPaymentMethodsError(error?.message || 'Saved payment methods could not be loaded.');
    }
  };

  const runAction = async (action) => {
    const prompts = {
      cancel: currentState?.subscriptionStatus === 'past_due'
        ? 'Stop renewal retries and switch this account to Free now?'
        : 'Stop automatic renewal? Your paid access will remain until the renewal date.',
      cancel_pending_change: 'Remove the scheduled plan change and keep your current plan?',
    };
    if (prompts[action] && !window.confirm(prompts[action])) return;

    setBusyAction(action);
    setMessage('');
    try {
      let result;
      if (action === 'retry') {
        result = await runOperation({ operationName: 'Retrying subscription payment', successMessage: 'The payment request finished.' }, () => retryStudentSubscriptionPayment(studentId));
        setMessage(result.charged
          ? 'Payment succeeded. Your subscription is renewed.'
          : result.status === 'processing'
            ? 'The payment is processing. We will update the subscription when it is confirmed.'
            : 'The payment was not completed. You can try again after the retry window or choose a plan below.');
      } else {
        result = await runOperation({ operationName: 'Updating subscription', successMessage: 'The subscription was updated.' }, () => manageStudentSubscription({ studentId, action }));
        if (result.freeImmediately) setMessage('Renewal stopped. Your paid period has ended, so the account is now on Free.');
        else if (action === 'cancel') setMessage(`Renewal cancelled. Paid access remains until ${formatDate(result.renewalDate)}.`);
        else if (action === 'resume') setMessage('Automatic renewal is back on.');
        else setMessage('The scheduled change was cancelled. Your current plan remains in place.');
      }
      if (result?.demo) {
        const nextState = action === 'cancel'
          ? { ...currentState, autoRenew: false, cancelAtPeriodEnd: true }
          : action === 'resume'
            ? { ...currentState, autoRenew: true, cancelAtPeriodEnd: false }
            : action === 'cancel_pending_change'
              ? { ...currentState, pendingPlan: null, pendingPlanReference: null, cancelAtPeriodEnd: false }
              : currentState;
        setCurrentState(nextState);
        onStateChange?.(nextState);
      } else {
        await refreshState();
      }
    } catch (error) {
      setMessage(error?.message || 'Subscription update failed. Please try again.');
    } finally {
      setBusyAction('');
    }
  };

  if (!currentState) return null;

  const paidPlan = ['circle', 'personalized'].includes(currentState.subscriptionPlanId);
  const currentUntil = currentState.subscriptionRenewalDate;
  const pendingPlan = currentState.pendingPlan;
  const pendingFree = pendingPlan?.planId === 'free';
  const pendingEffectiveAt = pendingPlan?.effectiveAt || currentUntil;
  const isPastDue = currentState.subscriptionStatus === 'past_due';
  const verificationPending = currentState.renewalVerificationPending;
  const paymentNeedsReview = currentState.lastChargeStatus === 'amount_mismatch';
  const canCancel = paidPlan && !currentState.cancelAtPeriodEnd && !verificationPending;
  const canResume = paidPlan && currentState.cancelAtPeriodEnd && !isPastDue;

  return (
    <section className="panel p-5" aria-label="Subscription status and actions">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-slate-950">Subscription status</h2>
          <p className="mt-1 text-sm text-slate-600">
            {isPastDue
              ? verificationPending
                ? `Renewal payment is being verified. Grace period ends ${formatDate(currentState.graceEndsAt)}.`
                : `Payment is due. Grace period ends ${formatDate(currentState.graceEndsAt)}.`
              : currentState.cancelAtPeriodEnd
                ? `Renewal is cancelled. Paid access ends ${formatDate(currentUntil)}.`
                : paidPlan
                  ? `${currentState.subscriptionPlanName} · ${currentState.subscriptionSubjectCount} subjects · ${currentState.autoRenew ? 'automatic renewal on' : 'manual renewal'}`
                  : 'Free · Past Papers access'}
          </p>
          {paidPlan && !isPastDue && !currentState.cancelAtPeriodEnd ? (
            <p className="mt-1 text-sm text-slate-500">Next renewal: {formatDate(currentUntil)}</p>
          ) : null}
          {paidPlan && currentState.discountPercent && ['recurring', 'fixed_months'].includes(currentState.discountBillingDuration) ? (
            <p className="mt-1 text-sm text-lime-700">
              {currentState.discountBillingDuration === 'fixed_months'
                ? `${currentState.discountPercent}% discount for the first ${currentState.discountDurationMonths} monthly billing periods (${currentState.discountCode}) · ends ${formatDate(currentState.discountEndsAt)}`
                : `Permanent recurring discount: ${currentState.discountPercent}% (${currentState.discountCode})`}
              {' '}· current cycle total {formatRand(currentState.amount)}
            </p>
          ) : null}
        </div>

        <div className="flex flex-wrap gap-2">
          {pendingPlan ? (
            <button type="button" className="btn-secondary inline-flex items-center gap-2" onClick={() => runAction('cancel_pending_change')} disabled={Boolean(busyAction)}>
              <Undo2 className="h-4 w-4" aria-hidden="true" />
              {busyAction === 'cancel_pending_change' ? 'Updating...' : 'Cancel scheduled change'}
            </button>
          ) : null}
          {canCancel ? (
            <button type="button" className="btn-secondary inline-flex items-center gap-2" onClick={() => runAction('cancel')} disabled={Boolean(busyAction)}>
              <Ban className="h-4 w-4" aria-hidden="true" />
              {busyAction === 'cancel' ? 'Updating...' : isPastDue ? 'Stop retries' : 'Cancel renewal'}
            </button>
          ) : null}
          {canResume ? (
            <button type="button" className="btn-primary inline-flex items-center gap-2" onClick={() => runAction('resume')} disabled={Boolean(busyAction)}>
              <RotateCcw className="h-4 w-4" aria-hidden="true" />
              {busyAction === 'resume' ? 'Updating...' : 'Resume renewal'}
            </button>
          ) : null}
          {isPastDue && (currentState.autoRenew || verificationPending) ? (
            <button type="button" className="btn-primary inline-flex items-center gap-2" onClick={() => runAction('retry')} disabled={Boolean(busyAction)}>
              <RotateCcw className="h-4 w-4" aria-hidden="true" />
              {busyAction === 'retry' ? 'Checking payment...' : verificationPending ? 'Check payment' : 'Retry payment'}
            </button>
          ) : null}
          {isPastDue && !verificationPending && !paymentNeedsReview && onContinuePayment ? (
            <button type="button" className="btn-secondary inline-flex items-center gap-2" onClick={onContinuePayment} disabled={Boolean(busyAction)}>
              <CalendarClock className="h-4 w-4" aria-hidden="true" />
              Pay with another method
            </button>
          ) : null}
        </div>
      </div>

      <div className="mt-4 border-t border-slate-200 pt-4">
        <div className="flex items-center gap-2">
          <CreditCard className="h-4 w-4 text-lime-700" aria-hidden="true" />
          <h3 className="text-sm font-semibold text-slate-900">Saved payment methods</h3>
        </div>
        <p className="mt-1 text-xs text-slate-500">Only the card type, bank label, expiry, and last four digits are shown.</p>
        {paymentMethodsLoading ? <p className="mt-3 text-sm text-slate-500">Loading saved cards…</p> : null}
        {!paymentMethodsLoading && paymentMethodsError ? <p className="mt-3 text-sm text-amber-700" role="status">{paymentMethodsError}</p> : null}
        {!paymentMethodsLoading && !paymentMethodsError && paymentMethods.length ? (
          <ul className="mt-3 grid gap-2 sm:grid-cols-2">
            {paymentMethods.map((method) => (
              <li key={method.id} className="flex items-center gap-3 rounded-xl border border-lime-500/40 bg-transparent p-3">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-white text-lime-800 shadow-sm">
                  <CreditCard className="h-4 w-4" aria-hidden="true" />
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-semibold text-slate-900">{method.cardType || 'Card'} ···· {method.last4}</span>
                  <span className="block text-xs text-slate-600">
                    {[method.bank, method.expMonth && method.expYear ? `Expires ${String(method.expMonth).padStart(2, '0')}/${method.expYear}` : ''].filter(Boolean).join(' · ') || 'Saved for subscription renewal'}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        {!paymentMethodsLoading && !paymentMethodsError && !paymentMethods.length ? (
          <p className="mt-3 text-sm text-slate-600">No reusable card is saved. You can pay with a card to save it for future renewals.</p>
        ) : null}
      </div>

      {pendingPlan ? (
        <p className="mt-4 border-t border-slate-200 pt-3 text-sm text-slate-600">
          {pendingFree ? 'Free' : pendingPlan.planName} is scheduled for {formatDate(pendingEffectiveAt)}.
          {subscriptionState.manualPaymentRequired && !pendingFree ? ' Payment will be required at that time.' : ''}
        </p>
      ) : null}
      {currentState.renewalAttemptCount > 0 && isPastDue ? (
        <p className="mt-2 text-sm text-amber-700">Renewal attempt {currentState.renewalAttemptCount} of 3. Your current grace period ends {formatDate(currentState.graceEndsAt)}.</p>
      ) : null}
      {message ? <p className="mt-3 text-sm text-slate-700" role="status">{message}</p> : null}
    </section>
  );
};
