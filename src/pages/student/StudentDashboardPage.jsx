import { useEffect, useState } from 'react';
import { ChevronDown, CreditCard } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { AppShell } from '../../components/common/AppShell';
import { MarkingCanvas as ImageEditor } from '../../components/canvas/pictureEditorCanvas';
import { ExerciseStatusBadges } from '../../components/dashboard/ExerciseStatusBadges';
import { useAuth } from '../../hooks/useAuth';
import { useScreenLoadMetrics } from '../../hooks/useScreenLoadMetrics';
import { canOpenExercise } from '../../utils/exerciseRules';
import {
  generateExercisePlanIfEligible,
  completePeerMarkingAssignment,
  getActiveSubjectEpisodesForStudent,
  getPeerMarkingAssignmentsForStudent,
  getStudentAccessState,
  getStudentEntitlementState,
  getTodayExercises,
  subscribeToExerciseGenerationStatus,
} from '../../services/firestoreService';
import { loadStudentSubscriptionState } from '../../services/studentSubscriptionStateStore';
import { uploadPeerReviewImage } from '../../services/storageService';
import { DEFAULT_SUBJECT } from '../../lib/constants';

const TodayExerciseCard = ({ exercise, onOpen }) => {
  return (
    <button
      type="button"
      onClick={onOpen}
      disabled={!canOpenExercise(exercise.assignmentDate)}
      className="panel w-full p-5 text-left transition hover:-translate-y-0.5 hover:shadow-soft disabled:cursor-not-allowed disabled:opacity-70"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="rounded-full bg-brand-50 px-3 py-1 text-xs font-semibold text-brand-700">{exercise.subject ?? DEFAULT_SUBJECT}</span>
        <ExerciseStatusBadges exercise={exercise} className="justify-end" />
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

const ExerciseGenerationProgressBar = ({ progress = 65, indeterminate = false }) => (
  <div
    className="relative h-8 w-full overflow-hidden rounded-full bg-slate-200"
    role="progressbar"
    aria-label="Generating exercises"
    aria-valuemin="0"
    aria-valuemax="100"
    {...(!indeterminate ? { 'aria-valuenow': progress } : {})}
  >
    <div
      className={`h-full rounded-full bg-lime-400 transition-all duration-500 ease-out ${indeterminate ? 'animate-pulse' : ''}`}
      style={{ width: `${indeterminate ? 65 : Math.min(100, Math.max(0, progress))}%` }}
    />
    <span className="absolute inset-0 flex items-center justify-center text-sm font-semibold text-slate-900">Generating...</span>
  </div>
);


const ReadinessChecklist = ({ rows, studentName }) => {
  const unmetRows = rows.filter((row) => Object.values(row.checks ?? {}).some((passed) => !passed));
  if (!unmetRows.length) return null;
  const labels = {
    paidSubscriptionActive: 'Paid subscription active',
    minimumQuestionPaperCountMet: 'At least 2 analyzed papers available',
    lessonCompleted: 'At least 1 completed topic lesson logged',
    initialGenerationExists: 'Initial AI plan already generated',
  };
  return (
    <div className="panel space-y-4 p-5">
      <div>
        <h2 className="text-xl font-bold text-slate-950">Subjects missing requirements</h2>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        {unmetRows.map((row) => (
          <details key={`${row.subject}-${row.mode}`} className="group rounded-2xl bg-slate-50 p-4">
            <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-3">
              <span className="min-w-0 font-semibold text-slate-950">{studentName} • {row.subject}</span>
              <span className="flex items-center gap-2"><span className="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-semibold text-amber-800">{Object.values(row.checks).filter((passed) => !passed).length ? `${Object.values(row.checks).filter((passed) => !passed).length} missing` : 'Ready'}</span><ChevronDown className="h-4 w-4 text-slate-500 transition-transform group-open:rotate-180" aria-hidden="true" /></span>
            </summary>
            <div className="mt-3 space-y-2 border-t border-slate-200 pt-3">
              {Object.entries(row.checks).map(([key, passed]) => (
                <div key={key} className="flex items-center justify-between gap-3 text-sm">
                  <span className="text-slate-600">{labels[key] ?? key}</span>
                  <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${passed ? 'bg-lime-400/15 text-lime-300 border border-lime-400/30' : 'bg-amber-400/15 text-amber-300 border border-amber-400/30'}`}>{passed ? 'Done' : 'Missing'}</span>
                </div>
              ))}
              {row.reason ? <p className="rounded-xl border border-amber-400/30 bg-amber-400/10 p-3 text-xs font-medium text-amber-300">{row.reason}</p> : null}
              <p className="text-xs text-slate-500">Papers available: {row.availablePaperCount}. Completed lessons: {row.completedLessonCount}.</p>
            </div>
          </details>
        ))}
      </div>
    </div>
  );
};

export const StudentDashboardPage = () => {
  const { profile, logout } = useAuth();
  const navigate = useNavigate();
  const [availableSubjects, setAvailableSubjects] = useState([]);
  const [availableSubjectEpisodes, setAvailableSubjectEpisodes] = useState([]);
  const [isLoadingSubjects, setIsLoadingSubjects] = useState(true);
  const [todayExercises, setTodayExercises] = useState([]);
  const [peerAssignments, setPeerAssignments] = useState([]);
  const [reviewingAssignment, setReviewingAssignment] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [paymentLocked, setPaymentLocked] = useState(true);
  const [isLoadingExercises, setIsLoadingExercises] = useState(true);
  const [isLoadingPeerAssignments, setIsLoadingPeerAssignments] = useState(true);
  const [isCheckingAccess, setIsCheckingAccess] = useState(true);
  const [isGenerating, setIsGenerating] = useState(false);
  const [generationProgress, setGenerationProgress] = useState(0);
  const [readinessRows, setReadinessRows] = useState([]);
  const [generationStatuses, setGenerationStatuses] = useState({});
  const [initialRetrySubjects, setInitialRetrySubjects] = useState([]);
  const [retryingInitialSubject, setRetryingInitialSubject] = useState('');
  const [subscriptionPlanId, setSubscriptionPlanId] = useState('free');
  const [subscriptionPlanName, setSubscriptionPlanName] = useState('Free');
  const [requiresSubscriptionSelection, setRequiresSubscriptionSelection] = useState(true);

  useScreenLoadMetrics(
    'Student Home',
    'student',
    !isLoadingSubjects && !isCheckingAccess && !isLoadingExercises && !isLoadingPeerAssignments,
  );

  useEffect(() => {
    let active = true;
    if (!profile?.uid) {
      setAvailableSubjects([]);
      setAvailableSubjectEpisodes([]);
      setIsLoadingSubjects(false);
      return undefined;
    }
    setIsLoadingSubjects(true);
    getActiveSubjectEpisodesForStudent(profile.uid)
      .then((episodes) => {
        if (!active) return;
        setAvailableSubjectEpisodes(episodes);
        setAvailableSubjects([...new Set(episodes.map((episode) => episode.subjectKey).filter(Boolean))].sort());
        setIsLoadingSubjects(false);
      })
      .catch((error) => {
        if (!active) return;
        setLoadError(error.message || 'Could not load your active subjects.');
        setIsLoadingSubjects(false);
      });
    return () => { active = false; };
  }, [profile?.uid]);

  useEffect(() => {
    if (!profile?.uid) return undefined;
    const unsubscribes = availableSubjects.map((subject) => {
      const episode = availableSubjectEpisodes.find((item) => item.studentId === profile.uid && item.subjectKey === subject);
      return subscribeToExerciseGenerationStatus(profile.uid, subject, (status) => {
        setGenerationStatuses((current) => ({ ...current, [subject]: status }));
      }, episode?.id ?? null);
    });
    return () => unsubscribes.forEach((unsubscribe) => unsubscribe());
  }, [profile?.uid, availableSubjects, availableSubjectEpisodes]);

  useEffect(() => {
    let active = true;

    const runGeneratePlan = async (subject, mode) => {
      setIsGenerating(true);
      setGenerationProgress(25);

      const result = await generateExercisePlanIfEligible({
        student: profile,
        mode,
        subject,
      });

      setGenerationProgress(75);
      return result;
    };

    const load = async () => {
      if (!profile?.uid || isLoadingSubjects) return;
      try {
        setLoadError('');
        setPaymentLocked(true);
        setIsLoadingExercises(true);
        setIsLoadingPeerAssignments(true);
        setIsCheckingAccess(true);
        setInitialRetrySubjects([]);
        const readiness = [];
        const subjectsToCheck = availableSubjects;
        const sharedSubscriptionState = loadStudentSubscriptionState(profile, { force: true });
        Promise.all(subjectsToCheck.map((subject) => getTodayExercises(
          profile.uid,
          subject,
          availableSubjectEpisodes.find((episode) => episode.studentId === profile.uid && episode.subjectKey === subject) ?? null,
        )))
          .then((nestedRows) => {
            if (active) {
              const rows = nestedRows.flat();
              setTodayExercises(rows.filter(Boolean).sort((left, right) => String(left.subject).localeCompare(String(right.subject))));
              setIsLoadingExercises(false);
            }
            return nestedRows;
          })
          .catch((error) => {
            if (active) {
              setLoadError(error?.message ?? 'Today’s exercises could not be loaded yet.');
              setIsLoadingExercises(false);
            }
            return [];
          });
        getPeerMarkingAssignmentsForStudent(profile.uid)
          .then((rows) => {
            if (active) {
              setPeerAssignments(rows);
              setIsLoadingPeerAssignments(false);
            }
            return rows;
          })
          .catch((error) => {
            if (active) {
              setLoadError((current) => current || error?.message || 'Marking work could not be loaded yet.');
              setIsLoadingPeerAssignments(false);
            }
            return [];
          });
        const entitlementStates = await Promise.all(subjectsToCheck.map((subject) =>
          getStudentEntitlementState(
            profile,
            subject,
            availableSubjectEpisodes.find((episode) => episode.studentId === profile.uid && episode.subjectKey === subject) ?? null,
            sharedSubscriptionState,
          ).then((access) => ({ subject, access })),
        ));
        if (!active) return;
        const effectiveSubscription = entitlementStates[0]?.access ?? await sharedSubscriptionState;
        setSubscriptionPlanId(effectiveSubscription.subscriptionPlanId || 'free');
        setSubscriptionPlanName(effectiveSubscription.subscriptionPlanName || 'Free');
        setRequiresSubscriptionSelection(Boolean(effectiveSubscription.requiresSubscriptionSelection));
        const anyPaidSubject = entitlementStates.some(({ access }) => Boolean(access.paidSubscriptionActive));
        setPaymentLocked(!anyPaidSubject);
        setIsCheckingAccess(false);
        if (!anyPaidSubject) {
          setReadinessRows([]);
          setInitialRetrySubjects([]);
          return;
        }

        try {
          const accessStates = await Promise.all(subjectsToCheck.map((subject) =>
            getStudentAccessState(
              profile,
              subject,
              availableSubjectEpisodes.find((episode) => episode.studentId === profile.uid && episode.subjectKey === subject) ?? null,
              sharedSubscriptionState,
            ).then((access) => ({ subject, access })),
          ));
          if (!active) return;
          setInitialRetrySubjects(accessStates
            .filter(({ access }) => access.paidSubscriptionActive
              && !access.hasInitialGeneration
              && access.initialGenerationReady
              && access.generationRunStatus?.lastTrigger === 'initial'
              && access.generationRunStatus?.status === 'failed')
            .map(({ subject }) => subject));

          for (const { subject, access } of accessStates) {
            const initialWasAttempted = access.generationRunStatus?.lastTrigger === 'initial'
              && ['completed', 'failed'].includes(access.generationRunStatus?.status);
            const shouldGenerate = access.paidSubscriptionActive
              && !access.hasInitialGeneration
              && access.initialGenerationReady
              && !initialWasAttempted;
            if (shouldGenerate) {
              const result = await runGeneratePlan(subject, 'initial');
              if (!result?.generated) {
                const resultStatus = result?.criteria?.initial ?? access.generationStatus?.initial;
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
          }

          if (!active) return;
          setReadinessRows(readiness);
          setGenerationProgress(100);
        } catch (error) {
          if (active) setLoadError((current) => current || error?.message || 'Subject readiness could not be loaded yet.');
        }
      } catch (error) {
        if (!active) return;
        setTodayExercises([]);
        setReadinessRows([]);
        setInitialRetrySubjects([]);
        setSubscriptionPlanId('free');
        setSubscriptionPlanName('Free');
        setRequiresSubscriptionSelection(true);
        setPaymentLocked(true);
        setIsLoadingExercises(false);
        setIsLoadingPeerAssignments(false);
        setIsCheckingAccess(false);
        setLoadError(error?.message ?? 'Some exercises could not be loaded yet.');
      } finally {
        if (active) setTimeout(() => setIsGenerating(false), 500);
      }
    };

    load();
    return () => { active = false; };
  }, [availableSubjects, availableSubjectEpisodes, isLoadingSubjects, profile]);

  const retryInitialGeneration = async (subject) => {
    if (!subject || retryingInitialSubject) return;
    setRetryingInitialSubject(subject);
    setIsGenerating(true);
    setGenerationProgress(25);
    try {
      const result = await generateExercisePlanIfEligible({
        student: profile,
        mode: 'initial',
        subject,
      });
      setGenerationProgress(100);
      if (!result.generated) return;

      setInitialRetrySubjects((current) => current.filter((item) => item !== subject));
      setReadinessRows((current) => current.filter((row) => row.subject !== subject));
      setTodayExercises((await getTodayExercises(profile.uid, subject)).filter(Boolean));
    } catch (error) {
      setLoadError(error.message || 'Initial generation failed.');
    } finally {
      setRetryingInitialSubject('');
      setTimeout(() => setIsGenerating(false), 500);
    }
  };

  const handleSavePeerMarking = async (files) => {
    if (!reviewingAssignment) return;
    const reviewImages = await Promise.all(files.map(async (file, index) => {
      const reviewFileName = (file.name || reviewingAssignment.submittedFileName || 'submission.png').replace(/\.[^/.]+$/, `-peer-review-${index + 1}.png`);
      const renamedFile = new File([file], reviewFileName, { type: file.type || 'image/png' });
      const upload = await uploadPeerReviewImage({
        file: renamedFile,
        studentId: profile.uid,
        exerciseId: reviewingAssignment.reviewerExerciseId,
        subjectInstanceId: reviewingAssignment.reviewerSubjectInstanceId,
      });
      return { ...upload, pageNumber: index + 1 };
    }));
    await completePeerMarkingAssignment({ assignmentId: reviewingAssignment.id, assignmentPath: reviewingAssignment.assignmentPath, reviewerId: profile.uid, reviewImages });
    setPeerAssignments(await getPeerMarkingAssignmentsForStudent(profile.uid));
    setReviewingAssignment(null);
  };

  if (isCheckingAccess) {
    return (
      <AppShell title="Overview" subtitle="Checking your subscription access." role="student" user={profile} onLogout={logout}>
        <div className="panel flex min-h-40 items-center justify-center gap-3 p-6 text-sm text-slate-500" role="status">
          <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-lime-500 border-r-transparent" aria-hidden="true" />
          Checking subscription...
        </div>
      </AppShell>
    );
  }

  if (subscriptionPlanId === 'free') {
    return (
      <AppShell
        title="Past papers"
        subtitle="Your Free plan includes access to question papers."
        role="student"
        user={profile}
        onLogout={logout}
      >
        <section className="panel mx-auto max-w-3xl space-y-4 p-6">
          <div>
            <p className="text-sm font-semibold text-lime-700">Current plan: {subscriptionPlanName}</p>
            <h2 className="mt-2 text-xl font-bold text-slate-950">
              {requiresSubscriptionSelection ? 'Choose a subscription to unlock the Examifying Program' : 'Your Free plan is active'}
            </h2>
            <p className="mt-2 text-sm leading-6 text-slate-600">
              {requiresSubscriptionSelection
                ? 'Your account is on Free for now. Past papers remain available; choose Circle or Personalized and complete payment to unlock exercises, lessons, peer marking, and subject selection.'
                : 'Past papers remain available on Free. Choose Circle or Personalized and complete payment to unlock the Examifying Program.'}
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            <button type="button" className="btn-primary inline-flex items-center gap-2" onClick={() => navigate('/student/billing')}>
              <CreditCard className="h-4 w-4" aria-hidden="true" />
              View subscriptions
            </button>
            <button type="button" className="btn-secondary" onClick={() => navigate('/student/papers')}>Browse Past Papers</button>
          </div>
        </section>
      </AppShell>
    );
  }

  return (
    <AppShell
      title="Today’s exercises"
      subtitle="Open today’s exercise, view the exact question pages, and submit your work from the exercise details page."
      role="student"
      user={profile}
      onLogout={logout}
    >
      {loadError ? <div className="panel p-4 text-sm text-amber-700">{loadError}</div> : null}
      {!availableSubjects.length && !requiresSubscriptionSelection ? (
        <div className="panel p-5 text-sm text-slate-600">
          Add a subject to your active plan before exercises can be assigned. <button type="button" className="ml-1 font-semibold text-brand-700 underline" onClick={() => navigate('/student/profile/subjects')}>Manage subjects</button>
        </div>
      ) : null}

      {Object.entries(generationStatuses).filter(([subject, status]) => {
        if (!status) return false;
        if (status.status === 'processing') return !isGenerating && Date.now() < Number(status.expiresAtMs ?? 0);
        if (status.status === 'failed' && status.lastTrigger === 'initial' && initialRetrySubjects.includes(subject)) return true;
        return Date.now() - Number(status.finishedAtMs || 0) < 120000;
      }).map(([subject, status]) => (
        status.status === 'processing' ? (
          <div key={subject} className="panel p-4" role="status" aria-live="polite">
            <ExerciseGenerationProgressBar indeterminate />
          </div>
        ) : (
          <div key={subject} role="status" aria-live="polite" className={`panel flex items-start gap-3 p-4 ${status.status === 'failed' ? 'border border-rose-400/30 bg-rose-400/10 text-rose-300' : 'border border-lime-400/30 bg-lime-400/10 text-lime-300'}`}>
            <div>
              <p className="font-semibold">{status.status === 'completed' ? `${subject}: Exercise generation complete` : `${subject}: Exercise generation did not complete`}</p>
              <p className="mt-1 text-sm">{status.message}</p>
              {status.status === 'failed' && status.lastTrigger === 'initial' && initialRetrySubjects.includes(subject) ? (
                <button
                  type="button"
                  className="btn-secondary mt-3"
                  onClick={() => retryInitialGeneration(subject)}
                  disabled={Boolean(retryingInitialSubject)}
                >
                  {retryingInitialSubject === subject ? 'Retrying initial generation...' : 'Retry initial generation'}
                </button>
              ) : null}
            </div>
          </div>
        )
      ))}

      {isGenerating ? (
        <div className="panel p-4">
          <ExerciseGenerationProgressBar progress={generationProgress} />
        </div>
      ) : null}

      <section className="space-y-4">
        <div className="rounded-2xl bg-gradient-to-r from-lime-300 via-lime-400 to-emerald-400 p-5 text-slate-950 shadow-soft sm:p-6">
          <p className="text-xs font-bold uppercase tracking-[0.25em] text-emerald-950/70">Exercises</p>
          <h2 className="mt-1 text-2xl font-extrabold tracking-tight">Work to Complete</h2>
          <p className="mt-2 max-w-2xl text-sm text-emerald-950/80">Open today’s exercise to view the question pages and submit your work.</p>
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          {isLoadingExercises || isCheckingAccess ? (
            <div className="panel col-span-full flex min-h-40 items-center justify-center gap-3 p-6 text-sm text-slate-500" role="status">
              <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-lime-500 border-r-transparent" aria-hidden="true" />
              Loading today’s exercises...
            </div>
          ) : isGenerating ? null : !paymentLocked && todayExercises.length ? todayExercises.map((exercise) => (
            <TodayExerciseCard key={exercise.id} exercise={exercise} onOpen={() => {
              const params = new URLSearchParams();
              if (exercise.subjectInstanceId) params.set('subjectInstanceId', exercise.subjectInstanceId);
              navigate(`/student/exercises/${exercise.id}${params.size ? `?${params.toString()}` : ''}`);
            }} />
          )) : (
            <div className="panel col-span-full flex min-h-40 items-center justify-center p-6 text-center text-sm text-slate-500">
              {paymentLocked ? 'Exercises are locked until payment is complete.' : 'No exercises have been assigned for today yet.'}
            </div>
          )}
        </div>
        {!isGenerating ? <ReadinessChecklist rows={readinessRows} studentName={profile?.displayName || profile?.name || profile?.email || 'Student'} /> : null}
      </section>

      {!isLoadingPeerAssignments && peerAssignments.length ? (
        <section className="space-y-4">
          <div className="rounded-2xl bg-gradient-to-r from-lime-300 via-lime-400 to-emerald-400 p-5 text-slate-950 shadow-soft sm:p-6">
            <p className="text-xs font-bold uppercase tracking-[0.25em] text-emerald-950/70">Peer marking</p>
            <h2 className="mt-1 text-2xl font-extrabold tracking-tight">Work to Mark</h2>
            <p className="mt-2 max-w-2xl text-sm text-emerald-950/80">Mark the submitted work assigned to you.</p>
          </div>
          <div className="grid gap-4">
            {peerAssignments.map((assignment) => (
              <div key={assignment.id} className="panel p-4 sm:p-5">
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div>
                    <p className="font-semibold text-slate-950">{assignment.title || 'Exercise submission'}</p>
                    <p className="mt-1 text-sm text-slate-500">{assignment.subject} • {assignment.grade} • {assignment.assignmentDate}</p>
                    <p className="mt-1 text-sm text-slate-600">{assignment.topic}</p>
                  </div>
                  <button type="button" className="btn-primary px-4 py-2" onClick={() => setReviewingAssignment((current) => current?.id === assignment.id ? null : assignment)}>{reviewingAssignment?.id === assignment.id ? 'Close marking' : 'Open Marking'}</button>
                </div>
                {reviewingAssignment?.id === assignment.id ? (
                  <div className="mt-4">
                    <ImageEditor imageUrls={assignment.submittedImages?.length ? assignment.submittedImages : [assignment.submittedImageUrl].filter(Boolean)} onSave={handleSavePeerMarking} onCancel={() => setReviewingAssignment(null)} />
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </AppShell>
  );
};
