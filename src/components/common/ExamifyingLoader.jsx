import { LoaderCircle } from 'lucide-react';

export const ExamifyingLoader = () => (
  <div className="flex min-h-screen items-center justify-center gap-3 bg-slate-950 text-sm font-semibold text-slate-200" role="status" aria-live="polite">
    <LoaderCircle className="h-5 w-5 animate-spin text-lime-300" aria-hidden="true" />
    <span className="bg-gradient-to-r from-lime-400 via-lime-300 to-emerald-400 bg-clip-text text-transparent">Loading Examifying…</span>
  </div>
);
