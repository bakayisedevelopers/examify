import { AlertCircle, CheckCircle2, LoaderCircle, RefreshCw } from 'lucide-react';
import { Logo } from './Logo';

const visuals = {
  working: {
    icon: LoaderCircle,
    iconClass: 'animate-spin text-lime-300',
    borderClass: 'border-lime-400/30',
    badgeClass: 'bg-lime-400/10 text-lime-200',
    title: 'Working…',
    description: 'Please wait while this is completed.',
  },
  verifying: {
    icon: LoaderCircle,
    iconClass: 'animate-spin text-lime-300',
    borderClass: 'border-lime-400/30',
    badgeClass: 'bg-lime-400/10 text-lime-200',
    title: 'Verifying payment',
    description: 'Please wait while Paystack confirms your payment.',
  },
  processing: {
    icon: LoaderCircle,
    iconClass: 'animate-spin text-amber-300',
    borderClass: 'border-amber-400/30',
    badgeClass: 'bg-amber-400/10 text-amber-200',
    title: 'Processing',
    description: 'Your request is still processing.',
  },
  success: {
    icon: CheckCircle2,
    iconClass: 'text-emerald-300',
    borderClass: 'border-emerald-400/30',
    badgeClass: 'bg-emerald-400/10 text-emerald-200',
    title: 'Completed',
    description: 'Your changes have been confirmed.',
  },
  failed: {
    icon: AlertCircle,
    iconClass: 'text-rose-300',
    borderClass: 'border-rose-400/30',
    badgeClass: 'bg-rose-400/10 text-rose-200',
    title: 'Could not complete this action',
    description: 'Check the details and try again.',
  },
};

export const OperationStatusOverlay = ({
  state,
  operationName = 'your request',
  title,
  message = '',
  onDone,
  onRetry,
  doneLabel = 'Done',
  retryLabel = 'Retry',
}) => {
  const visual = visuals[state];
  if (!visual) return null;
  const Icon = visual.icon;
  const isFailure = state === 'failed';
  const isSuccess = state === 'success';
  const isProcessing = state === 'processing';
  const defaultTitle = state === 'working' ? `${operationName}…`
    : isSuccess ? 'Saved successfully'
      : isFailure ? 'Action failed' : visual.title;
  const defaultDescription = state === 'working' ? 'Please keep this page open while the request finishes.'
    : isSuccess ? 'The server confirmed that your changes were saved.'
      : isFailure ? 'The action did not finish successfully. Review the error and continue from the form.' : visual.description;

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-sm" role="presentation">
      <section
        className={`panel relative w-full max-w-md space-y-5 overflow-hidden border p-6 pt-8 shadow-2xl sm:p-8 sm:pt-10 ${visual.borderClass}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="operation-status-title"
        aria-live="polite"
      >
        <span className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-lime-300 via-lime-400 to-emerald-400" aria-hidden="true" />
        <div className="flex justify-center border-b border-lime-400/15 pb-4">
          <Logo />
        </div>
        <div className="flex items-center gap-4">
          <span className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl ${visual.badgeClass}`}>
            <Icon className={`h-6 w-6 ${visual.iconClass}`} aria-hidden="true" />
          </span>
          <div>
            <h2 id="operation-status-title" className="text-lg font-bold text-white">{title || defaultTitle}</h2>
            <p className="mt-1 text-sm text-slate-300">{message && !isFailure && !isSuccess ? message : defaultDescription}</p>
          </div>
        </div>
        {isFailure && message ? <p className="rounded-xl border border-rose-400/20 bg-rose-400/5 p-3 text-sm text-rose-100" role="alert">{message}</p> : null}
        {isSuccess && message ? <p className="text-sm text-slate-300">{message}</p> : null}
        {isSuccess && onDone ? <button type="button" className="btn-primary w-full" onClick={onDone}>{doneLabel}</button> : null}
        {isFailure && onRetry ? <button type="button" className="inline-flex w-full items-center justify-center gap-2 rounded-full bg-rose-500 px-5 py-3 text-sm font-bold text-white transition hover:bg-rose-400" onClick={onRetry}><RefreshCw className="h-4 w-4" aria-hidden="true" />{retryLabel}</button> : null}
        {isFailure && !onRetry && onDone ? <button type="button" className="btn-secondary w-full" onClick={onDone}>Close</button> : null}
        {isProcessing && onRetry ? <button type="button" className="btn-primary w-full" onClick={onRetry}><RefreshCw className="mr-2 inline h-4 w-4" aria-hidden="true" />{retryLabel}</button> : null}
        {isProcessing ? <span className="sr-only">Processing</span> : null}
      </section>
    </div>
  );
};
