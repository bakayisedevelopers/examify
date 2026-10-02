import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, CreditCard } from 'lucide-react';
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
  getStudentSubscriptionState,
  getTodayExercises,
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


const ReadinessChecklist = ({ rows, studentName }) => {
  if (!rows.length) return null;
  const labels = {
    paidSubscriptionActive: 'Paid subscription active',
    latestTutorReportExists: 'Tutor initial report added',
    minimumQuestionPaperCountMet: 'At least 2 analyzed papers available',
    lessonCompleted: 'At least 1 completed lesson logged',
    initialGenerationExists: 'Initial AI plan already generated',
  };
  return (
    <div className="panel space-y-4 p-5">
      <div>
        <h2 className="text-xl font-bold text-slate-950">Subjects missing requirements</h2>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        {rows.map((row) => (
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
  const [searchParams, setSearchParams] = useSearchParams();
  const availableSubjects = useMemo(() => {
    const subjects = getUserSubjects(profile);
    return subjects.length ? subjects : [DEFAULT_SUBJECT];
  }, [profile]);
  const [todayExercises, setTodayExercises] = useState([]);
  const [peerAssignments, setPeerAssignments] = useState([]);
  const [activeTab, setActiveTab] = useState(searchParams.get('tab') === 'mark' ? 'mark' : 'exercises');
  const [reviewingAssignment, setReviewingAssignment] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [paymentLocked, setPaymentLocked] = useState(true);
  const [isLoadingExercises, setIsLoadingExercises] = useState(true);
  const [isLoadingPeerAssignments, setIsLoadingPeerAssignments] = useState(true);
  const [isCheckingAccess, setIsCheckingAccess] = useState(true);
  const [isGenerating, setIsGenerating] = useState(false);
  const [generationProgress, setGenerationProgress] = useState(0);
  const [generationMessage, setGenerationMessage] = useState('');
  const [readinessRows, setReadinessRows] = useState([]);
  const [generationStatuses, setGenerationStatuses] = useState({});
  const [subscriptionPlanId, setSubscriptionPlanId] = useState('free');
  const [subscriptionPlanName, setSubscriptionPlanName] = useState('Free');
  const [requiresSubscriptionSelection, setRequiresSubscriptionSelection] = useState(true);

  useEffect(() => {
    if (!profile?.uid) return undefined;
    const unsubscribes = availableSubjects.map((subject) => subscribeToExerciseGenerationStatus(profile.uid, subject, (status) => {
      setGenerationStatuses((current) => ({ ...current, [subject]: status }));
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
        setPaymentLocked(true);
        setIsLoadingExercises(true);
        setIsLoadingPeerAssignments(true);
        setIsCheckingAccess(true);
        const readiness = [];
        const assignedSubjects = await getAssignedSubjectsForStudent(profile.uid);
        const subjectsToCheck = availableSubjects.filter((subject) => assignedSubjects.includes(subject));
        Promise.all(subjectsToCheck.map((subject) => getTodayExercises(profile.uid, subject)))
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
        const accessStates = await Promise.all(subjectsToCheck.map((subject) =>
          getStudentAccessState(profile, subject).then((access) => ({ subject, access })),
        ));
        if (!active) return;
        const effectiveSubscription = accessStates[0]?.access ?? await getStudentSubscriptionState(profile);
        setSubscriptionPlanId(effectiveSubscription.subscriptionPlanId || 'free');
        setSubscriptionPlanName(effectiveSubscription.subscriptionPlanName || 'Free');
        setRequiresSubscriptionSelection(Boolean(effectiveSubscription.requiresSubscriptionSelection));
        const anyPaidSubject = accessStates.some(({ access }) => Boolean(access.paidSubscriptionActive));
        setPaymentLocked(!anyPaidSubject);
        setIsCheckingAccess(false);

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
        if (!active) return;
        setTodayExercises([]);
        setReadinessRows([]);
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
  }, [availableSubjects, profile]);

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

      {Object.entries(generationStatuses).filter(([, status]) => {
        if (!status) return false;
        if (status.status === 'processing') return Date.now() < Number(status.expiresAtMs ?? 0);
        return Date.now() - Number(status.finishedAtMs || 0) < 120000;
      }).map(([subject, status]) => (
        <div key={subject} role="status" aria-live="polite" className={`panel flex items-start gap-3 p-4 ${status.status === 'failed' ? 'border border-rose-400/30 bg-rose-400/10 text-rose-300' : 'border border-lime-400/30 bg-lime-400/10 text-lime-300'}`}>
          {status.status === 'processing' ? <span className="mt-0.5 inline-block h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-lime-400 border-r-transparent" aria-hidden="true" /> : null}
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
            <div className="h-full rounded-full bg-lime-400 transition-all duration-300" style={{ width: `${Math.min(100, Math.max(0, generationProgress))}%` }} />
          </div>
        </div>
      ) : null}

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
            {isLoadingExercises || isCheckingAccess ? (
              <div className="panel col-span-full flex min-h-40 items-center justify-center gap-3 p-6 text-sm text-slate-500" role="status">
                <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-lime-500 border-r-transparent" aria-hidden="true" />
                Loading today’s exercises...
              </div>
            ) : !paymentLocked && todayExercises.length ? todayExercises.map((exercise) => (
              <TodayExerciseCard
                key={exercise.id}
                exercise={exercise}
                onOpen={() => navigate(`/student/exercises/${exercise.id}`)}
              />
            )) : (
              <div className="panel col-span-full flex min-h-72 items-center justify-center p-6 text-center text-sm text-slate-500">
                {isGenerating ? 'Your exercises are being prepared. This page will update when generation finishes.' : paymentLocked ? 'Exercises are locked until payment is complete.' : 'No exercises have been assigned for today yet.'}
              </div>
            )}
          </section>
          {!isGenerating ? <ReadinessChecklist rows={readinessRows} studentName={profile?.displayName || profile?.name || profile?.email || 'Student'} /> : null}
        </>
      ) : (
        <>
          <SectionHeader eyebrow="Peer marking" title="Work to mark" description="Mark submitted work from learners in your grade and subject." />
          <section className="grid gap-4">
            {isLoadingPeerAssignments ? <div className="panel flex min-h-32 items-center justify-center gap-3 p-5 text-sm text-slate-500" role="status"><span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-lime-500 border-r-transparent" aria-hidden="true" />Loading marking work...</div> : null}
            {!isLoadingPeerAssignments ? peerAssignments.map((assignment) => (
              <div key={assignment.id} className="panel p-4">
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div>
                    <p className="font-semibold text-slate-950">{assignment.title || 'Exercise submission'}</p>
                    <p className="mt-1 text-sm text-slate-500">{assignment.subject} • {assignment.grade} • {assignment.assignmentDate}</p>
                    <p className="mt-1 text-sm text-slate-600">{assignment.topic}</p>
                  </div>
                  <button type="button" className="btn-primary" onClick={() => setReviewingAssignment((current) => current?.id === assignment.id ? null : assignment)}>{reviewingAssignment?.id === assignment.id ? 'Close marking' : 'Mark work'}</button>
                </div>
                {reviewingAssignment?.id === assignment.id ? (
                  <div className="mt-4">
                    <ImageEditor imageUrls={assignment.submittedImages?.length ? assignment.submittedImages : [assignment.submittedImageUrl].filter(Boolean)} onSave={handleSavePeerMarking} onCancel={() => setReviewingAssignment(null)} />
                  </div>
                ) : null}
              </div>
            )) : null}
            {!isLoadingPeerAssignments && !peerAssignments.length ? <div className="panel p-5 text-sm text-slate-500">No one to mark for yet. When learners in your grade and subject submit, marking work will appear here.</div> : null}
          </section>
          {!isGenerating ? <ReadinessChecklist rows={readinessRows} studentName={profile?.displayName || profile?.name || profile?.email || 'Student'} /> : null}
        </>
      )}
    </AppShell>
  );
};
