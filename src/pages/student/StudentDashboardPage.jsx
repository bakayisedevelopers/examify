import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { AppShell } from '../../components/common/AppShell';
import { MarkingCanvas as ImageEditor } from '../../components/canvas/pictureEditorCanvas';
import { SectionHeader } from '../../components/common/SectionHeader';
import { useAuth } from '../../hooks/useAuth';
import { canOpenExercise, getExerciseAvailability } from '../../utils/exerciseRules';
import {
  generateExercisePlanIfEligible,
  completePeerMarkingAssignment,
  getAssignedSubjectsForStudent,
  getPeerMarkingAssignmentsForStudent,
  getStudentAccessState,
  getTodayExercise,
  subscribeToExerciseGenerationStatus,
} from '../../services/firestoreService';
import { uploadPeerReviewImage } from '../../services/storageService';
import { DEFAULT_SUBJECT } from '../../lib/constants';
import { getUserSubjects } from '../../utils/tutorSubjects';

const TodayExerciseCard = ({ exercise, onOpen }) => {
  const submitted = Boolean(exercise.submittedImageUrl || exercise.submitted === 'Yes');
  const availability = getExerciseAvailability(exercise.assignmentDate, submitted);

  return (
    <button
      type="button"
      onClick={onOpen}
      disabled={!canOpenExercise(exercise.assignmentDate)}
      className="panel w-full p-5 text-left transition hover:-translate-y-0.5 hover:shadow-soft disabled:cursor-not-allowed disabled:opacity-70"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="rounded-full bg-brand-50 px-3 py-1 text-xs font-semibold text-brand-700">{exercise.subject ?? DEFAULT_SUBJECT}</span>
        <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">{availability.label}</span>
      </div>
      <h3 className="mt-4 text-xl font-bold text-slate-950">{exercise.title}</h3>
      <p className="mt-2 text-sm font-semibold text-accent">{exercise.topic}</p>
      <p className="mt-3 line-clamp-2 text-sm leading-6 text-slate-500">{exercise.instruction}</p>
      <div className="mt-4 flex items-center justify-between gap-3 text-xs uppercase tracking-[0.25em] text-slate-400">
        <span>{exercise.assignmentDate}</span>
        <span>{canOpenExercise(exercise.assignmentDate) ? 'Open exercise' : 'Locked'}</span>
      </div>
    </button>
  );
};


const ReadinessChecklist = ({ rows }) => {
  if (!rows.length) return null;
  const labels = {
    paymentCompleted: 'Payment active',
    latestTutorReportExists: 'Tutor initial report added',
    minimumQuestionPaperCountMet: 'At least 2 analyzed papers available',
    lessonCompleted: 'At least 1 completed lesson logged',
    initialGenerationExists: 'Initial AI plan already generated',
  };
  return (
    <div className="panel space-y-4 p-5">
      <div>
        <p className="text-sm font-semibold uppercase tracking-[0.25em] text-brand-700">AI readiness</p>
        <h2 className="mt-2 text-xl font-bold text-slate-950">What is needed before exercises can generate</h2>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        {rows.map((row) => (
          <div key={`${row.subject}-${row.mode}`} className="rounded-2xl bg-slate-50 p-4">
            <p className="font-semibold text-slate-950">{row.subject} • {row.mode === 'initial' ? 'First generation' : 'Weekly generation'}</p>
            <div className="mt-3 space-y-2">
              {Object.entries(row.checks).map(([key, passed]) => (
                <div key={key} className="flex items-center justify-between gap-3 text-sm">
                  <span className="text-slate-600">{labels[key] ?? key}</span>
                  <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${passed ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>{passed ? 'Done' : 'Missing'}</span>
                </div>
              ))}
            </div>
            {row.reason ? <p className="mt-3 rounded-xl bg-amber-50 p-3 text-xs font-medium text-amber-700">{row.reason}</p> : null}
            <p className="mt-3 text-xs text-slate-500">Papers available: {row.availablePaperCount}. Completed lessons: {row.completedLessonCount}.</p>
          </div>
        ))}
      </div>
    </div>
  );
};

export const StudentDashboardPage = () => {
  const { profile, logout } = useAuth();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const availableSubjects = useMemo(() => {
    const subjects = getUserSubjects(profile);
    return subjects.length ? subjects : [DEFAULT_SUBJECT];
  }, [profile]);
  const [todayExercises, setTodayExercises] = useState([]);
  const [peerAssignments, setPeerAssignments] = useState([]);
  const [activeTab, setActiveTab] = useState(searchParams.get('tab') === 'mark' ? 'mark' : 'exercises');
  const [markSubjectFilter, setMarkSubjectFilter] = useState('all');
  const [reviewingAssignment, setReviewingAssignment] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [paymentLocked, setPaymentLocked] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [generationProgress, setGenerationProgress] = useState(0);
  const [generationMessage, setGenerationMessage] = useState('');
  const [readinessRows, setReadinessRows] = useState([]);
  const [exerciseGenerationStatuses, setExerciseGenerationStatuses] = useState({});

  useEffect(() => {
    if (!profile?.uid) return undefined;
    const unsubscribes = availableSubjects.map((subject) => subscribeToExerciseGenerationStatus(profile.uid, subject, (status) => {
      setExerciseGenerationStatuses((current) => ({ ...current, [subject]: status }));
    }));
    return () => unsubscribes.forEach((unsubscribe) => unsubscribe());
  }, [profile?.uid, availableSubjects]);

  useEffect(() => {
    setActiveTab(searchParams.get('tab') === 'mark' ? 'mark' : 'exercises');
  }, [searchParams]);

  const selectTab = (tab) => {
    setActiveTab(tab);
    setSearchParams(tab === 'mark' ? { tab: 'mark' } : {});
  };

  useEffect(() => {
    let active = true;

    const runGeneratePlan = async (subject, mode) => {
      setIsGenerating(true);
      setGenerationProgress(25);
      setGenerationMessage(`${subject}: ${mode === 'initial' ? 'Initial' : 'Weekly'} AI generation started...`);

      const result = await generateExercisePlanIfEligible({
        student: profile,
        mode,
        subject,
        onProgress: (message) => setGenerationMessage(`${subject}: ${message}`),
      });

      setGenerationProgress(75);
      if (result?.generated) {
        setGenerationMessage(`${subject}: generated ${result.assignments?.length ?? 0} exercise(s).`);
      } else {
        setGenerationMessage(`${subject}: ${result?.reason ?? 'generation criteria not met'}.`);
      }
      return result;
    };

    const load = async () => {
      if (!profile?.uid) return;
      try {
        setLoadError('');
        const loadedExercises = [];
        const readiness = [];
        const assignedSubjects = await getAssignedSubjectsForStudent(profile.uid);
        const subjectsToCheck = availableSubjects.filter((subject) => assignedSubjects.includes(subject));
        let anyPaidSubject = false;

        for (const subject of subjectsToCheck) {
          const access = await getStudentAccessState(profile, subject);
          anyPaidSubject = anyPaidSubject || Boolean(access.paymentCompleted);

          const mode = access.hasInitialGeneration ? 'weekly' : 'initial';
          const modeStatus = access.generationStatus?.[mode];
          const shouldGenerate = access.paymentCompleted && ((mode === 'initial' && access.initialGenerationReady) || (mode === 'weekly' && access.weeklyGenerationReady));
          if (shouldGenerate) {
            const result = await runGeneratePlan(subject, mode);
            if (!result?.generated && !access.hasInitialGeneration) {
              const resultStatus = result?.criteria?.initial ?? access.generationStatus?.initial ?? modeStatus;
              readiness.push({
                subject,
                mode: 'initial',
                checks: resultStatus?.checks ?? access.generationStatus?.initial?.checks ?? {},
                availablePaperCount: result?.criteria?.analyzedPaperCount ?? access.matchingQuestionPapers?.length ?? 0,
                completedLessonCount: access.completedLessons?.length ?? 0,
                reason: result?.reason ?? 'Generation did not complete.',
              });
            }
          } else if (!access.hasInitialGeneration && !access.generationStatus?.initial?.ready) {
            readiness.push({ subject, mode: 'initial', checks: access.generationStatus?.initial?.checks ?? {}, availablePaperCount: access.matchingQuestionPapers?.length ?? 0, completedLessonCount: access.completedLessons?.length ?? 0 });
          }

          const today = await getTodayExercise(profile.uid, subject);
          if (today) loadedExercises.push(today);
        }

        if (!active) return;
        setPaymentLocked(!anyPaidSubject);
        setTodayExercises(loadedExercises.sort((left, right) => String(left.subject).localeCompare(String(right.subject))));
        setPeerAssignments(await getPeerMarkingAssignmentsForStudent(profile.uid));
        setReadinessRows(readiness);
        setGenerationProgress(100);
      } catch (error) {
        if (!active) return;
        setTodayExercises([]);
        setReadinessRows([]);
        setLoadError(error?.message ?? 'Some exercises could not be loaded yet.');
      } finally {
        if (active) setTimeout(() => setIsGenerating(false), 500);
      }
    };

    load();
    return () => { active = false; };
  }, [availableSubjects, profile]);

  const markSubjects = [...new Set(peerAssignments.map((assignment) => assignment.subject).filter(Boolean))];
  const visiblePeerAssignments = peerAssignments.filter((assignment) => markSubjectFilter === 'all' || assignment.subject === markSubjectFilter);

  const handleSavePeerMarking = async (file) => {
    if (!reviewingAssignment) return;
    const reviewFileName = (reviewingAssignment.submittedFileName || 'submission.png').replace(/\.[^/.]+$/, '-peer-review.png');
    const renamedFile = new File([file], reviewFileName, { type: file.type });
    const upload = await uploadPeerReviewImage({ file: renamedFile, studentId: profile.uid, exerciseId: reviewingAssignment.exerciseId });
    await completePeerMarkingAssignment({ assignmentId: reviewingAssignment.id, reviewImageUrl: upload.url, reviewFileName: upload.fileName });
    setPeerAssignments(await getPeerMarkingAssignmentsForStudent(profile.uid));
    setReviewingAssignment(null);
  };

  return (
    <AppShell
      title="Today’s exercises"
      subtitle="Open today’s exercise, view the exact question pages, and submit your work from the exercise details page."
      role="student"
      user={profile}
      onLogout={logout}
    >
      {loadError ? <div className="panel p-4 text-sm text-amber-700">{loadError}</div> : null}

      {Object.entries(exerciseGenerationStatuses).filter(([, status]) => {
        if (!status) return false;
        if (status.status === 'processing') return true;
        return Date.now() - Number(status.finishedAtMs || 0) < 120000;
      }).map(([subject, status]) => (
        <div key={subject} role="status" aria-live="polite" className={`panel flex items-start gap-3 p-4 ${status.status === 'failed' ? 'text-rose-700' : 'text-slate-700'}`}>
          {status.status === 'processing' ? <span className="mt-0.5 inline-block h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-current border-r-transparent" aria-hidden="true" /> : null}
          <div>
            <p className="font-semibold">{status.status === 'processing' ? `${subject}: AI is regenerating your exercises` : `${subject}: ${status.status === 'completed' ? 'Exercise regeneration complete' : 'Exercise regeneration did not complete'}`}</p>
            <p className="mt-1 text-sm">{status.message}</p>
          </div>
        </div>
      ))}

      {isGenerating ? (
        <div className="panel p-4">
          <p className="font-medium text-slate-700">{generationMessage}</p>
          <div className="mt-3 h-2 w-full rounded-full bg-slate-200">
            <div className="h-full rounded-full bg-brand-600 transition-all duration-300" style={{ width: `${Math.min(100, Math.max(0, generationProgress))}%` }} />
          </div>
        </div>
      ) : null}

      {!isGenerating ? <ReadinessChecklist rows={readinessRows} /> : null}

      <div className="panel mx-auto flex w-fit justify-center gap-2 p-2">
        <button type="button" className={activeTab === 'exercises' ? 'btn-primary' : 'btn-secondary'} onClick={() => selectTab('exercises')}>Exercises</button>
        <button type="button" className={activeTab === 'mark' ? 'btn-primary' : 'btn-secondary'} onClick={() => selectTab('mark')}>Mark</button>
      </div>

      {activeTab === 'exercises' ? (
        <>
          <SectionHeader
            eyebrow="Exercises"
            title="Due today"
            description="Each card shows the subject and opens the exercise details page for uploads and paper links."
          />
          <section className="grid gap-4 lg:grid-cols-2">
            {!paymentLocked && todayExercises.length ? todayExercises.map((exercise) => (
              <TodayExerciseCard
                key={exercise.id}
                exercise={exercise}
                onOpen={() => navigate(`/student/exercises/${exercise.id}`)}
              />
            )) : (
              <div className="panel col-span-full flex min-h-72 items-center justify-center p-6 text-center text-sm text-slate-500">
                {paymentLocked ? 'Exercises are locked until payment is complete.' : 'No exercises have been assigned for today yet.'}
              </div>
            )}
          </section>
        </>
      ) : (
        <>
          <SectionHeader eyebrow="Peer marking" title="Work to mark" description="Mark submitted work from learners in your grade and subject." />
          <div className="panel flex flex-wrap items-center justify-between gap-3 p-4">
            <p className="text-sm font-semibold text-slate-950">Filter marking work</p>
            <select className="input max-w-xs" value={markSubjectFilter} onChange={(event) => setMarkSubjectFilter(event.target.value)}>
              <option value="all">All subjects</option>
              {markSubjects.map((subject) => <option key={subject}>{subject}</option>)}
            </select>
          </div>
          <section className="grid gap-4">
            {visiblePeerAssignments.map((assignment) => (
              <div key={assignment.id} className="panel p-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="font-semibold text-slate-950">{assignment.title || 'Exercise submission'}</p>
                    <p className="mt-1 text-sm text-slate-500">{assignment.subject} • {assignment.grade} • {assignment.assignmentDate}</p>
                    <p className="mt-2 text-sm text-slate-600">{assignment.topic}</p>
                  </div>
                  <button type="button" className="btn-primary" onClick={() => setReviewingAssignment(assignment)}>Mark</button>
                </div>
                {reviewingAssignment?.id === assignment.id ? (
                  <div className="mt-4">
                    <ImageEditor imageUrl={assignment.submittedImageUrl} onSave={handleSavePeerMarking} />
                    <button type="button" className="btn-secondary mt-2" onClick={() => setReviewingAssignment(null)}>Cancel</button>
                  </div>
                ) : null}
              </div>
            ))}
            {!visiblePeerAssignments.length ? <div className="panel p-5 text-sm text-slate-500">No one to mark for yet. When learners in your grade and subject submit, marking work will appear here.</div> : null}
          </section>
        </>
      )}
    </AppShell>
  );
};
