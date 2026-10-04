import { useEffect, useState } from 'react';
import { Ban, CalendarClock, RotateCcw, Undo2 } from 'lucide-react';
import { manageStudentSubscription, retryStudentSubscriptionPayment } from '../../services/paymentsService';
import { refreshStudentSubscriptionState } from '../../services/studentSubscriptionStateStore';

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
  const [busyAction, setBusyAction] = useState('');
  const [message, setMessage] = useState('');
  const [currentState, setCurrentState] = useState(subscriptionState);

  useEffect(() => setCurrentState(subscriptionState), [subscriptionState]);

  const refreshState = async () => {
    const nextState = await refreshStudentSubscriptionState({ uid: studentId });
    setCurrentState(nextState);
    onStateChange?.(nextState);
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
        result = await retryStudentSubscriptionPayment(studentId);
        setMessage(result.charged
          ? 'Payment succeeded. Your subscription is renewed.'
          : result.status === 'processing'
            ? 'The payment is processing. We will update the subscription when it is confirmed.'
            : 'The payment was not completed. You can try again after the retry window or choose a plan below.');
      } else {
        result = await manageStudentSubscription({ studentId, action });
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
          {paidPlan && currentState.discountBillingDuration === 'recurring' && currentState.discountPercent ? (
            <p className="mt-1 text-sm text-lime-700">Recurring discount: {currentState.discountPercent}% ({currentState.discountCode}) · current cycle total {formatRand(currentState.amount)}</p>
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
          {isPastDue && currentState.manualPaymentRequired && onContinuePayment ? (
            <button type="button" className="btn-primary inline-flex items-center gap-2" onClick={onContinuePayment}>
              <CalendarClock className="h-4 w-4" aria-hidden="true" />
              Continue payment
            </button>
          ) : null}
        </div>
      </div>

      {pendingPlan ? (
        <p className="mt-4 border-t border-slate-200 pt-3 text-sm text-slate-600">
          {pendingFree ? 'Free' : pendingPlan.planName} is scheduled for {formatDate(pendingEffectiveAt)}.
          {subscriptionState.manualPaymentRequired && !pendingFree ? ' Payment will be required at that time.' : ''}
        </p>
      ) : null}
      {currentState.renewalAttemptCount > 0 && isPastDue ? (
        <p className="mt-2 text-sm text-amber-700">Renewal attempt {currentState.renewalAttemptCount} of 3.</p>
      ) : null}
      {message ? <p className="mt-3 text-sm text-slate-700" role="status">{message}</p> : null}
    </section>
  );
};
