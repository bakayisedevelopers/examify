import { LoaderCircle } from 'lucide-react';

export const LoadingState = ({ label = 'Loading…', className = '' }) => (
  <div
    className={`panel flex min-h-20 items-center justify-center gap-3 border-lime-400/20 bg-slate-900/95 p-5 text-sm text-slate-200 ${className}`}
    role="status"
    aria-live="polite"
  >
    <LoaderCircle className="h-5 w-5 shrink-0 animate-spin text-lime-300 drop-shadow-[0_0_8px_rgba(163,230,53,0.55)]" aria-hidden="true" />
    <span className="font-medium">{label}</span>
  </div>
);
