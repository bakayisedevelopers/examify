import { getExerciseStatusLabels } from '../../utils/exerciseRules';

const primaryTone = (status) => {
  if (status === 'Ready') return 'bg-lime-100 text-lime-800';
  if (status === 'Submitted') return 'bg-emerald-100 text-emerald-800';
  return 'bg-amber-100 text-amber-800';
};

const detailTone = (complete) => complete ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-600';

export const ExerciseStatusBadges = ({ exercise, className = '' }) => {
  const status = getExerciseStatusLabels(exercise);
  return (
    <div className={`flex flex-wrap items-center gap-2 ${className}`} aria-label="Exercise status">
      <span className={`rounded-full px-3 py-1 text-xs font-semibold ${primaryTone(status.primary)}`}>{status.primary}</span>
      {status.isToday ? <span className={`rounded-full px-3 py-1 text-xs font-semibold ${detailTone(status.submitted)}`}>Work: {status.submitted ? 'Submitted' : 'Not submitted'}</span> : null}
      {status.showMarking ? <span className={`rounded-full px-3 py-1 text-xs font-semibold ${detailTone(status.markingSubmitted)}`}>Marking: {status.markingSubmitted ? 'Submitted' : 'Not submitted'}</span> : null}
    </div>
  );
};
