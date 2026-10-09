import { useCallback, useEffect, useState } from 'react';
import { Check, ChevronDown, ChevronLeft, ChevronRight, CreditCard, Hourglass, LockKeyhole, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { AppShell } from '../../components/common/AppShell';
import { LoadingState } from '../../components/common/LoadingState';
import { OperationStatusOverlay } from '../../components/common/OperationStatusOverlay';
import { MarkingCanvas as ImageEditor } from '../../components/canvas/pictureEditorCanvas';
import { ExerciseStatusBadges } from '../../components/dashboard/ExerciseStatusBadges';
import { useAuth } from '../../hooks/useAuth';
import { useScreenLoadMetrics } from '../../hooks/useScreenLoadMetrics';
import { useOperationStatus } from '../../hooks/useOperationStatus';
import { canOpenExercise } from '../../utils/exerciseRules';
import {
  generateExercisePlanIfEligible,
  completePeerMarkingAssignment,
  getActiveSubjectEpisodesForStudent,
  getCompletedPeerMarkingAssignmentsForCalendar,
  getPeerMarkingAssignmentsForStudent,
  getStudentExerciseCalendarBounds,
  getStudentExerciseCalendarWindow,
  getStudentAccessState,
  getStudentEntitlementState,
  getTodayExercises,
  subscribeToExerciseGenerationStatus,
} from '../../services/firestoreService';
import { getCachedStudentSubscriptionState, loadStudentSubscriptionState } from '../../services/studentSubscriptionStateStore';
import { getCachedStudentDashboardState, updateCachedStudentDashboardState } from '../../services/studentDashboardStateStore';
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

const getLocalDateKey = (date = new Date()) => [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
const shiftDateKey = (dateKey, days) => {
  const [year, month, day] = String(dateKey).split('-').map(Number);
  const date = new Date(year, month - 1, day + days, 12);
  return getLocalDateKey(date);
};
const dateFromKey = (dateKey) => new Date(`${dateKey}T12:00:00`);
const isSubmittedExercise = (exercise = {}) => Boolean(exercise.submittedImageUrl || exercise.submitted === 'Yes' || exercise.submissionStatus === 'submitted');

const ExerciseActivityCalendar = ({
  weekStart,
  bounds,
  exercises,
  assignedMarking,
  completedMarking,
  activeSubjectInstanceIds,
  loading,
  onWeekChange,
}) => {
  const today = getLocalDateKey();
  const dates = Array.from({ length: 7 }, (_, index) => shiftDateKey(weekStart, index));
  const weekEnd = dates.at(-1);
  const canGoBack = Boolean(bounds?.earliestDate && weekStart > bounds.earliestDate);
  const canGoForward = Boolean(bounds?.latestDate && weekEnd < bounds.latestDate);
  const activeInstances = new Set(activeSubjectInstanceIds);
  const markingRowsByPath = new Map();
  [...assignedMarking, ...completedMarking].forEach((assignment) => {
    if (activeInstances.has(assignment.reviewerSubjectInstanceId)) {
      markingRowsByPath.set(assignment.assignmentPath || assignment.id, assignment);
    }
  });
  const markingRows = [...markingRowsByPath.values()];
  const statusDetails = {
    completed: { label: 'Completed', Icon: Check, iconClass: 'text-slate-950' },
    missed: { label: 'Missed', Icon: X, iconClass: 'text-rose-700' },
    inProgress: { label: 'In progress', Icon: Hourglass, iconClass: 'text-slate-950' },
    locked: { label: 'Locked', Icon: LockKeyhole, iconClass: 'text-slate-700' },
    none: { label: 'No work assigned', Icon: null, iconClass: '' },
  };

  const statusForDate = (dateKey) => {
    if (dateKey > today) return 'locked';
    if (!bounds) return dateKey === today ? 'inProgress' : 'none';
    const dayExercises = exercises.filter((exercise) => String(exercise.assignmentDate ?? '').slice(0, 10) === dateKey);
    const dayMarking = markingRows.filter((assignment) => String(assignment.assignmentDate ?? '').slice(0, 10) === dateKey);
    const expectedSubjectIds = activeSubjectInstanceIds.filter((subjectInstanceId) => {
      const subjectBounds = bounds?.subjectBounds?.[subjectInstanceId];
      return subjectBounds?.earliestDate && subjectBounds?.latestDate
        && dateKey >= subjectBounds.earliestDate && dateKey <= subjectBounds.latestDate;
    });
    const hasActivity = expectedSubjectIds.length > 0 || dayExercises.length > 0 || dayMarking.length > 0;
    const allExercisesSubmitted = expectedSubjectIds.length
      ? expectedSubjectIds.every((subjectInstanceId) => {
        const subjectExercises = dayExercises.filter((exercise) => exercise.subjectInstanceId === subjectInstanceId);
        return subjectExercises.length > 0 && subjectExercises.every(isSubmittedExercise);
      })
      : dayExercises.every(isSubmittedExercise);
    const allMarkingCompleted = dayMarking.every((assignment) => assignment.status === 'completed');

    if (hasActivity && allExercisesSubmitted && allMarkingCompleted) return 'completed';
    if (dateKey === today) return 'inProgress';
    return hasActivity ? 'missed' : 'none';
  };

  const changeWeek = (direction) => {
    if (direction < 0) {
      const previousStart = shiftDateKey(weekStart, -7);
      onWeekChange(bounds?.earliestDate && previousStart < bounds.earliestDate ? bounds.earliestDate : previousStart);
      return;
    }
    const nextStart = shiftDateKey(weekStart, 7);
    const latestFullWeekStart = bounds?.latestDate ? shiftDateKey(bounds.latestDate, -6) : nextStart;
    onWeekChange(nextStart > latestFullWeekStart ? latestFullWeekStart : nextStart);
  };

  const visibleRange = `${dateFromKey(weekStart).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' })} – ${dateFromKey(weekEnd).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' })}`;

  return (
    <div className="mt-4 w-full rounded-xl border border-emerald-950/20 bg-transparent p-3 sm:p-4" aria-label="Exercise and peer-marking activity calendar">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <p className="shrink-0 text-[10px] font-bold uppercase tracking-[0.16em] text-emerald-950/75 sm:text-xs">Last 7 days</p>
        <div className="flex min-w-0 items-center gap-1">
          <button type="button" className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-slate-950 transition hover:bg-lime-200 disabled:cursor-not-allowed disabled:opacity-35" onClick={() => changeWeek(-1)} disabled={!canGoBack} aria-label="Show previous week">
            <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          </button>
          <span className="min-w-0 text-center text-[10px] font-semibold tabular-nums text-emerald-950/80 sm:text-xs" aria-live="polite">{visibleRange}</span>
          <button type="button" className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-slate-950 transition hover:bg-lime-200 disabled:cursor-not-allowed disabled:opacity-35" onClick={() => changeWeek(1)} disabled={!canGoForward} aria-label="Show next week">
            <ChevronRight className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      </div>
      {loading ? <p className="sr-only" role="status">Loading activity for this week.</p> : null}
      <div className="mt-3 grid w-full grid-cols-7 gap-1.5 sm:gap-3">
        {dates.map((dateKey) => {
          const status = statusForDate(dateKey);
          const { label, Icon, iconClass } = statusDetails[status];
          const date = dateFromKey(dateKey);
          return (
            <div key={dateKey} className="grid min-w-0 justify-items-center gap-1" role="group" aria-label={`${date.toLocaleDateString('en-ZA', { weekday: 'long', day: 'numeric', month: 'long' })}: ${label}`}>
              <span className="text-[9px] font-semibold uppercase text-emerald-950/65 sm:text-[10px]">{date.toLocaleDateString('en-ZA', { weekday: 'short' }).slice(0, 2)}</span>
              <span className="flex aspect-square w-full max-w-11 items-center justify-center rounded-full border border-emerald-950/35 bg-transparent" title={`${date.toLocaleDateString('en-ZA')}: ${label}`}>
                {Icon ? <Icon className={`h-4 w-4 stroke-[2.5] sm:h-5 sm:w-5 ${iconClass}`} aria-hidden="true" /> : null}
              </span>
              <span className="text-[10px] font-semibold tabular-nums text-emerald-950/80 sm:text-xs">{date.getDate()}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
};


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
  const { operationStatus, runOperation, closeOperationStatus } = useOperationStatus();
  const cachedDashboardState = getCachedStudentDashboardState(profile?.uid);
  const cachedSubscriptionState = getCachedStudentSubscriptionState(profile?.uid);
  const hasCachedAccessState = Boolean(cachedDashboardState?.accessChecked || cachedSubscriptionState);
  const [lastAppData, setLastAppData] = useState(() => cachedDashboardState ? { uid: profile?.uid, ...cachedDashboardState } : null);
  const visibleLastAppData = lastAppData?.uid === profile?.uid ? lastAppData : null;
  const saveLastAppData = useCallback((patch) => {
    if (!profile?.uid) return;
    const next = updateCachedStudentDashboardState(profile.uid, patch);
    setLastAppData({ uid: profile.uid, ...next });
  }, [profile?.uid]);
  const [availableSubjects, setAvailableSubjects] = useState(() => cachedDashboardState?.availableSubjects ?? []);
  const [availableSubjectEpisodes, setAvailableSubjectEpisodes] = useState(() => cachedDashboardState?.availableSubjectEpisodes ?? []);
  const [isLoadingSubjects, setIsLoadingSubjects] = useState(() => !cachedDashboardState?.subjectsLoaded);
  const [todayExercises, setTodayExercises] = useState(() => cachedDashboardState?.todayExercises ?? []);
  const [peerAssignments, setPeerAssignments] = useState(() => cachedDashboardState?.peerAssignments ?? []);
  const [calendarWeekStart, setCalendarWeekStart] = useState(() => shiftDateKey(getLocalDateKey(), -6));
  const [exerciseCalendarBounds, setExerciseCalendarBounds] = useState(null);
  const [calendarExercises, setCalendarExercises] = useState([]);
  const [completedCalendarMarking, setCompletedCalendarMarking] = useState([]);
  const [isLoadingCalendar, setIsLoadingCalendar] = useState(true);
  const [reviewingAssignment, setReviewingAssignment] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [paymentLocked, setPaymentLocked] = useState(() => cachedDashboardState?.paymentLocked ?? true);
  const [isLoadingExercises, setIsLoadingExercises] = useState(() => !cachedDashboardState?.exercisesLoaded);
  const [isLoadingPeerAssignments, setIsLoadingPeerAssignments] = useState(() => !cachedDashboardState?.peerAssignmentsLoaded);
  const [isCheckingAccess, setIsCheckingAccess] = useState(() => !hasCachedAccessState);
  const [isGenerating, setIsGenerating] = useState(false);
  const [generationProgress, setGenerationProgress] = useState(0);
  const [readinessRows, setReadinessRows] = useState(() => cachedDashboardState?.readinessRows ?? []);
  const [generationStatuses, setGenerationStatuses] = useState({});
  const [initialRetrySubjects, setInitialRetrySubjects] = useState([]);
  const [retryingInitialSubject, setRetryingInitialSubject] = useState('');
  const [subscriptionPlanId, setSubscriptionPlanId] = useState(() => cachedDashboardState?.subscriptionPlanId ?? cachedSubscriptionState?.subscriptionPlanId ?? 'free');
  const [subscriptionPlanName, setSubscriptionPlanName] = useState(() => cachedDashboardState?.subscriptionPlanName ?? cachedSubscriptionState?.subscriptionPlanName ?? 'Free');
  const [requiresSubscriptionSelection, setRequiresSubscriptionSelection] = useState(() => cachedDashboardState?.requiresSubscriptionSelection ?? cachedSubscriptionState?.requiresSubscriptionSelection ?? true);

  useEffect(() => {
    const snapshot = getCachedStudentDashboardState(profile?.uid);
    if (!snapshot) {
      setLastAppData(null);
      if (profile?.uid) {
        const currentSubscription = getCachedStudentSubscriptionState(profile.uid);
        setAvailableSubjects([]);
        setAvailableSubjectEpisodes([]);
        setTodayExercises([]);
        setPeerAssignments([]);
        setReadinessRows([]);
        setIsLoadingSubjects(true);
        setIsLoadingExercises(true);
        setIsLoadingPeerAssignments(true);
        setPaymentLocked(currentSubscription ? !currentSubscription.paymentCompleted : true);
        setSubscriptionPlanId(currentSubscription?.subscriptionPlanId ?? 'free');
        setSubscriptionPlanName(currentSubscription?.subscriptionPlanName ?? 'Free');
        setRequiresSubscriptionSelection(currentSubscription?.requiresSubscriptionSelection ?? true);
        setIsCheckingAccess(!currentSubscription);
      }
      return;
    }
    setLastAppData({ uid: profile.uid, ...snapshot });
    setAvailableSubjects(snapshot.availableSubjects ?? []);
    setAvailableSubjectEpisodes(snapshot.availableSubjectEpisodes ?? []);
    setIsLoadingSubjects(!snapshot.subjectsLoaded);
    setTodayExercises(snapshot.todayExercises ?? []);
    setPeerAssignments(snapshot.peerAssignments ?? []);
    setReadinessRows(snapshot.readinessRows ?? []);
    setSubscriptionPlanId(snapshot.subscriptionPlanId ?? 'free');
    setSubscriptionPlanName(snapshot.subscriptionPlanName ?? 'Free');
    setRequiresSubscriptionSelection(snapshot.requiresSubscriptionSelection ?? true);
    setPaymentLocked(snapshot.paymentLocked ?? true);
    setIsLoadingExercises(!snapshot.exercisesLoaded);
    setIsLoadingPeerAssignments(!snapshot.peerAssignmentsLoaded);
  }, [profile?.uid]);

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
    const cachedState = getCachedStudentDashboardState(profile.uid);
    setIsLoadingSubjects(!cachedState?.subjectsLoaded);
    getActiveSubjectEpisodesForStudent(profile.uid)
      .then((episodes) => {
        if (!active) return;
        const subjects = [...new Set(episodes.map((episode) => episode.subjectKey).filter(Boolean))].sort();
        const episodeSignature = (items = []) => JSON.stringify([...items]
          .map((episode) => ({
            id: episode.id,
            studentId: episode.studentId,
            subjectKey: episode.subjectKey,
            status: episode.status,
            accessRole: episode.accessRole,
          }))
          .sort((left, right) => String(left.id).localeCompare(String(right.id))));
        if (episodeSignature(cachedState?.availableSubjectEpisodes) !== episodeSignature(episodes)) {
          setAvailableSubjectEpisodes(episodes);
        }
        if (JSON.stringify(cachedState?.availableSubjects ?? []) !== JSON.stringify(subjects)) {
          setAvailableSubjects(subjects);
        }
        saveLastAppData({ availableSubjects: subjects, availableSubjectEpisodes: episodes, subjectsLoaded: true });
        setIsLoadingSubjects(false);
      })
      .catch((error) => {
        if (!active) return;
        setLoadError(error.message || 'Could not load your active subjects.');
        setIsLoadingSubjects(false);
      });
    return () => { active = false; };
  }, [profile?.uid, saveLastAppData]);

  useEffect(() => {
    let active = true;
    if (!profile?.uid || isLoadingSubjects) return undefined;
    if (!availableSubjectEpisodes.length) {
      setExerciseCalendarBounds({ earliestDate: '', latestDate: '', subjectBounds: {} });
      return undefined;
    }
    getStudentExerciseCalendarBounds(profile.uid, availableSubjectEpisodes)
      .then((bounds) => { if (active) setExerciseCalendarBounds(bounds); })
      .catch((error) => {
        if (active) setLoadError((current) => current || error?.message || 'Exercise history dates could not be loaded.');
      });
    return () => { active = false; };
  }, [availableSubjectEpisodes, isLoadingSubjects, profile?.uid]);

  useEffect(() => {
    let active = true;
    if (!profile?.uid || isLoadingSubjects) return undefined;
    if (!availableSubjectEpisodes.length) {
      setCalendarExercises([]);
      setCompletedCalendarMarking([]);
      setIsLoadingCalendar(false);
      setIsLoadingExercises(false);
      return undefined;
    }

    const weekEnd = shiftDateKey(calendarWeekStart, 6);
    const visibleIncludesToday = getLocalDateKey() >= calendarWeekStart && getLocalDateKey() <= weekEnd;
    setIsLoadingCalendar(true);
    Promise.all([
      getStudentExerciseCalendarWindow({
        studentId: profile.uid,
        subjectEpisodes: availableSubjectEpisodes,
        startDate: calendarWeekStart,
        endDate: weekEnd,
      }),
      getCompletedPeerMarkingAssignmentsForCalendar({
        reviewerId: profile.uid,
        startDate: calendarWeekStart,
        endDate: weekEnd,
        subjectInstanceIds: availableSubjectEpisodes.map((episode) => episode.id),
      }).catch((error) => {
        console.error('[Examifying][ExerciseCalendar] completed marking load:error', error);
        if (active) setLoadError((current) => current || 'Completed marking activity could not be refreshed.');
        return [];
      }),
    ]).then(([exercises, completedMarking]) => {
      if (!active) return;
      setCalendarExercises(exercises);
      setCompletedCalendarMarking(completedMarking);
      if (visibleIncludesToday) {
        const todaysExercises = exercises.filter((exercise) => String(exercise.assignmentDate ?? '').slice(0, 10) === getLocalDateKey());
        setTodayExercises(todaysExercises);
        saveLastAppData({ todayExercises: todaysExercises, exercisesLoaded: true });
        setIsLoadingExercises(false);
      }
    }).catch((error) => {
      if (active) {
        setLoadError((current) => current || error?.message || 'Exercise activity could not be loaded.');
        if (visibleIncludesToday) setIsLoadingExercises(false);
      }
    }).finally(() => {
      if (active) setIsLoadingCalendar(false);
    });

    return () => { active = false; };
  }, [availableSubjectEpisodes, calendarWeekStart, isLoadingSubjects, profile?.uid, saveLastAppData]);

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

      const result = await runOperation({
        operationName: `Generating ${subject} exercises`,
        successMessage: 'Exercise generation has finished.',
        failureMessage: 'Could not generate the exercise plan.',
      }, () => generateExercisePlanIfEligible({ student: profile, mode, subject }));

      setGenerationProgress(75);
      return result;
    };

    const load = async () => {
      if (!profile?.uid || isLoadingSubjects) return;
      try {
        setLoadError('');
        const previousData = getCachedStudentDashboardState(profile.uid);
        if (!previousData) setPaymentLocked(true);
        setIsLoadingExercises(!previousData?.exercisesLoaded);
        setIsLoadingPeerAssignments(!previousData?.peerAssignmentsLoaded);
        setIsCheckingAccess(true);
        setInitialRetrySubjects([]);
        const readiness = [];
        const subjectsToCheck = availableSubjects;
        const sharedSubscriptionState = loadStudentSubscriptionState(profile, { force: true });
        getPeerMarkingAssignmentsForStudent(profile.uid)
          .then((rows) => {
            if (active) {
              setPeerAssignments(rows);
              saveLastAppData({ peerAssignments: rows, peerAssignmentsLoaded: true });
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
        saveLastAppData({
          subscriptionPlanId: effectiveSubscription.subscriptionPlanId || 'free',
          subscriptionPlanName: effectiveSubscription.subscriptionPlanName || 'Free',
          requiresSubscriptionSelection: Boolean(effectiveSubscription.requiresSubscriptionSelection),
          paymentLocked: !anyPaidSubject,
          accessChecked: true,
        });
        if (!anyPaidSubject) {
          setReadinessRows([]);
          saveLastAppData({ readinessRows: [] });
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
          saveLastAppData({ readinessRows: readiness });
          setGenerationProgress(100);
        } catch (error) {
          if (active) setLoadError((current) => current || error?.message || 'Subject readiness could not be loaded yet.');
        }
      } catch (error) {
        if (!active) return;
        const previousData = getCachedStudentDashboardState(profile?.uid);
        if (!previousData) {
          setTodayExercises([]);
          setReadinessRows([]);
          setInitialRetrySubjects([]);
          setSubscriptionPlanId('free');
          setSubscriptionPlanName('Free');
          setRequiresSubscriptionSelection(true);
          setPaymentLocked(true);
        }
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
  }, [availableSubjects, availableSubjectEpisodes, isLoadingSubjects, profile, runOperation, saveLastAppData]);

  const retryInitialGeneration = async (subject) => {
    if (!subject || retryingInitialSubject) return;
    setRetryingInitialSubject(subject);
    setIsGenerating(true);
    setGenerationProgress(25);
    try {
      const result = await runOperation({
        operationName: `Generating ${subject} exercises`,
        successMessage: 'Exercise generation has finished.',
        failureMessage: 'Initial exercise generation failed.',
      }, () => generateExercisePlanIfEligible({ student: profile, mode: 'initial', subject }));
      setGenerationProgress(100);
      if (!result.generated) return;

      setInitialRetrySubjects((current) => current.filter((item) => item !== subject));
      setReadinessRows((current) => current.filter((row) => row.subject !== subject));
      const episode = availableSubjectEpisodes.find((item) => item.studentId === profile.uid && item.subjectKey === subject) ?? null;
      const refreshedExercises = await getTodayExercises(profile.uid, subject, episode);
      setTodayExercises((current) => [...current.filter((item) => item.subjectInstanceId !== episode?.id), ...refreshedExercises]
        .sort((left, right) => String(left.subject).localeCompare(String(right.subject))));
    } catch (error) {
      setLoadError(error.message || 'Initial generation failed.');
    } finally {
      setRetryingInitialSubject('');
      setTimeout(() => setIsGenerating(false), 500);
    }
  };

  const handleSavePeerMarking = async (files) => runOperation({
    operationName: 'Submitting peer marking',
    successMessage: 'Your marked pages were uploaded and the marking submission was saved.',
    failureMessage: 'Could not submit peer marking.',
  }, async () => {
    if (!reviewingAssignment) throw new Error('No peer-marking assignment is open.');
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
    setCompletedCalendarMarking((current) => [
      ...current.filter((item) => item.assignmentPath !== reviewingAssignment.assignmentPath),
      { ...reviewingAssignment, status: 'completed' },
    ]);
    const refreshedAssignments = await getPeerMarkingAssignmentsForStudent(profile.uid);
    setPeerAssignments(refreshedAssignments);
    saveLastAppData({ peerAssignments: refreshedAssignments, peerAssignmentsLoaded: true });
    setReviewingAssignment(null);
  });

  if (subscriptionPlanId === 'free' && (hasCachedAccessState || !isCheckingAccess)) {
    return (
      <AppShell
        title="Past papers"
        subtitle="Your Free plan includes access to question papers."
        role="student"
        user={profile}
        onLogout={logout}
      >
        {isCheckingAccess ? <p className="inline-flex items-center gap-2 text-sm text-slate-300" role="status"><span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-lime-300 border-r-transparent" aria-hidden="true" />Refreshing your subscription status in the background.</p> : null}
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
      {isCheckingAccess && (visibleLastAppData?.accessChecked || hasCachedAccessState) ? <p className="inline-flex items-center gap-2 text-xs font-medium text-slate-300" role="status"><span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-lime-300 border-r-transparent" aria-hidden="true" />Refreshing subscription and access in the background; showing your last loaded data.</p> : null}
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
          <ExerciseActivityCalendar
            weekStart={calendarWeekStart}
            bounds={exerciseCalendarBounds}
            exercises={calendarExercises}
            assignedMarking={peerAssignments}
            completedMarking={completedCalendarMarking}
            activeSubjectInstanceIds={availableSubjectEpisodes.map((episode) => episode.id)}
            loading={isLoadingCalendar}
            onWeekChange={setCalendarWeekStart}
          />
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          {(isLoadingExercises || (isCheckingAccess && !hasCachedAccessState)) && !todayExercises.length ? (
            <LoadingState className="col-span-full min-h-40" label="Loading today’s exercises…" />
          ) : isGenerating && !todayExercises.length ? null : !paymentLocked && todayExercises.length ? todayExercises.map((exercise) => (
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

      {isLoadingPeerAssignments && !peerAssignments.length ? <LoadingState label="Checking for work assigned to you to mark…" /> : null}
      {peerAssignments.length > 0 ? (
        <section className="space-y-4">
          {isLoadingPeerAssignments ? <p className="inline-flex items-center gap-2 text-xs font-medium text-slate-300" role="status"><span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-lime-300 border-r-transparent" aria-hidden="true" />Refreshing assigned marking work…</p> : null}
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
      <OperationStatusOverlay
        state={operationStatus?.state}
        operationName={operationStatus?.operationName}
        message={operationStatus?.message}
        onDone={closeOperationStatus}
      />
    </AppShell>
  );
};
