import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { BookOpen, CalendarDays, ChevronLeft, FileText } from 'lucide-react';
import { AppShell } from '../../components/common/AppShell';
import { LoadingState } from '../../components/common/LoadingState';
import { SectionHeader } from '../../components/common/SectionHeader';
import { ExerciseStatusBadges } from '../../components/dashboard/ExerciseStatusBadges';
import { useAuth } from '../../hooks/useAuth';
import { getTutorAssignmentHistoryContexts, getTutorAssignmentHistoryData } from '../../services/firestoreService';
import { useEffectiveRole } from '../../utils/effectiveRole';

const dateLabel = (value) => {
  const date = value?.toDate?.() ?? (value instanceof Date ? value : value ? new Date(value) : null);
  return date && !Number.isNaN(date.getTime()) ? date.toLocaleDateString() : 'Date not recorded';
};
const dateSortValue = (value) => {
  const date = value?.toDate?.() ?? (value instanceof Date ? value : value ? new Date(value) : null);
  return date && !Number.isNaN(date.getTime()) ? date.getTime() : 0;
};

export const TutorStudentHistorySubjectPage = () => {
  const { studentId, periodId } = useParams();
  const { profile, logout } = useAuth();
  const { basePath, role } = useEffectiveRole();
  const [history, setHistory] = useState(null);
  const [status, setStatus] = useState('');
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (!profile?.uid || !studentId || !periodId) return undefined;
    let active = true;
    setIsLoading(true);
    setHistory(null);
    setStatus('');
    Promise.resolve()
      .then(async () => {
        const contexts = await getTutorAssignmentHistoryContexts(profile.uid, studentId);
        const context = contexts.find((entry) => entry.assignmentPeriodId === periodId);
        if (!context) throw new Error('This subject history is not available to your account.');
        const records = await getTutorAssignmentHistoryData({
          tutorId: profile.uid,
          studentId,
          periodId,
          historyContexts: contexts,
        });
        if (active) setHistory({ ...records, context });
      })
      .catch((error) => {
        if (active) setStatus(error?.message || 'Could not load this subject history.');
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });
    return () => { active = false; };
  }, [periodId, profile?.uid, studentId]);

  const exercises = useMemo(() => [...(history?.exercises ?? [])]
    .sort((left, right) => dateSortValue(right.assignmentDate) - dateSortValue(left.assignmentDate)), [history?.exercises]);
  const lessons = useMemo(() => [...(history?.lessons ?? [])]
    .sort((left, right) => dateSortValue(right.completedOn || right.lessonDate) - dateSortValue(left.completedOn || left.lessonDate)), [history?.lessons]);

  const exercisePath = (exercise) => {
    const params = new URLSearchParams({ studentId, period: periodId });
    if (exercise.subjectInstanceId) params.set('subjectInstanceId', exercise.subjectInstanceId);
    return `${basePath}/exercises/${encodeURIComponent(exercise.id)}?${params.toString()}`;
  };
  const lessonPath = (lesson) => {
    const params = new URLSearchParams({ studentId, period: periodId });
    if (lesson.subjectInstanceId) params.set('subjectInstanceId', lesson.subjectInstanceId);
    return `${basePath}/lessons/${encodeURIComponent(lesson.id)}?${params.toString()}`;
  };

  const studentName = history?.context?.displayName || history?.context?.name || history?.context?.email || 'Student';
  const subject = history?.context?.subject || 'Subject history';

  return (
    <AppShell title={`${subject} history`} subtitle={`${studentName} · historical subject episode`} role={role} user={profile} onLogout={logout}>
      <Link to={`${basePath}/students/${encodeURIComponent(studentId)}`} className="btn-secondary hidden w-fit items-center gap-2 sm:inline-flex">
        <ChevronLeft className="h-4 w-4" aria-hidden="true" /> Back to student
      </Link>
      {isLoading ? <LoadingState label="Loading historical subject exercises and lessons…" /> : null}
      {status && !isLoading ? <div className="panel p-5 text-sm text-rose-700" role="alert">{status}</div> : null}
      {history && !isLoading ? <>
        <section className="panel space-y-4 p-5 sm:p-6">
          <SectionHeader
            eyebrow="Read-only subject episode"
            title={subject}
            description={`${studentName} · ${history.context.grade || 'Grade not recorded'}${history.context.province ? ` · ${history.context.province}` : ''}`}
          />
          <div className="flex flex-wrap gap-2 text-xs">
            <span className="rounded-full bg-lime-100 px-3 py-1 font-semibold text-lime-900">Previous {history.context.accessRole} access</span>
            <span className="rounded-full bg-slate-100 px-3 py-1 font-semibold text-slate-700">Ended {dateLabel(history.context.assignmentEndedAt)}</span>
          </div>
          <p className="text-sm text-slate-500">Choose an exercise or lesson to open its existing detail page. Historical records are read-only.</p>
        </section>

        <section className="space-y-4">
          <SectionHeader eyebrow="Exercise history" title="Exercises" description="Past exercise assignments for this subject episode." />
          <div className="grid gap-3">
            {exercises.map((exercise) => (
              <Link key={exercise.id} to={exercisePath(exercise)} className="panel flex flex-wrap items-center justify-between gap-3 p-4 transition hover:border-lime-700/40 hover:bg-lime-50/40">
                <span className="flex min-w-0 items-start gap-3">
                  <FileText className="mt-0.5 h-5 w-5 shrink-0 text-lime-700" aria-hidden="true" />
                  <span className="min-w-0"><span className="block font-semibold text-slate-950">{exercise.title || 'Exercise'}</span><span className="mt-1 block text-sm text-slate-500">{exercise.topic || subject} · {exercise.assignmentDate || 'Date not recorded'}</span></span>
                </span>
                <ExerciseStatusBadges exercise={exercise} className="justify-end" />
              </Link>
            ))}
            {!exercises.length ? <div className="panel p-5 text-sm text-slate-500">No exercises are recorded for this subject episode.</div> : null}
          </div>
        </section>

        <section className="space-y-4">
          <SectionHeader eyebrow="Lesson history" title="Lessons" description="Past lesson records for this subject episode." />
          <div className="grid gap-3">
            {lessons.map((lesson) => {
              const topics = lesson.topics?.length ? lesson.topics : [lesson.topic].filter(Boolean);
              const isMissed = lesson.status === 'missed' || lesson.attended === false;
              return <Link key={lesson.id} to={lessonPath(lesson)} className="panel flex flex-wrap items-center justify-between gap-3 p-4 transition hover:border-lime-700/40 hover:bg-lime-50/40">
                <span className="flex min-w-0 items-start gap-3">
                  <BookOpen className="mt-0.5 h-5 w-5 shrink-0 text-lime-700" aria-hidden="true" />
                  <span className="min-w-0"><span className="block font-semibold text-slate-950">{topics.join(' · ') || 'Lesson'}</span><span className="mt-1 flex flex-wrap items-center gap-1 text-sm text-slate-500"><CalendarDays className="h-3.5 w-3.5" aria-hidden="true" />{lesson.completedOn || lesson.lessonDate || 'Date not recorded'} · {lesson.lessonType === 'inPerson' ? 'In-person' : 'Online'}</span></span>
                </span>
                <span className={`rounded-full px-3 py-1 text-xs font-semibold ${isMissed ? 'bg-amber-100 text-amber-800' : lesson.status === 'completed' ? 'bg-lime-100 text-lime-900' : 'bg-slate-100 text-slate-700'}`}>{isMissed ? 'Missed' : lesson.status === 'completed' ? 'Completed' : lesson.status || 'Recorded'}</span>
              </Link>;
            })}
            {!lessons.length ? <div className="panel p-5 text-sm text-slate-500">No lessons are recorded for this subject episode.</div> : null}
          </div>
        </section>
      </> : null}
    </AppShell>
  );
};
