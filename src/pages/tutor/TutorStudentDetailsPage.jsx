import { useEffect, useState } from 'react';
import { FileText, Trash2, UserPlus, X } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { LoaderCircle } from 'lucide-react';
import { AppShell } from '../../components/common/AppShell';
import { LoadingState } from '../../components/common/LoadingState';
import { OperationStatusOverlay } from '../../components/common/OperationStatusOverlay';
import { SectionHeader } from '../../components/common/SectionHeader';
import { ExerciseStatusBadges } from '../../components/dashboard/ExerciseStatusBadges';
import { useAuth } from '../../hooks/useAuth';
import { useScreenLoadMetrics } from '../../hooks/useScreenLoadMetrics';
import { useOperationStatus } from '../../hooks/useOperationStatus';
import {
  generateExercisePlanIfEligible,
  getGlobalTopicOptionGroups,
  getLessonEligibleSubjectGradePairs,
  getQuestionPapers,
  getTutorAssignedStudentContexts,
  getTutorAssignmentHistoryContexts,
  getTutorAssignmentHistoryData,
  getTutorExercisesForAssignedStudents,
  getTutorLessonRowsForAssignedStudents,
  removeCompletedTopicFromLesson,
  getCompletedPeerMarkingWorkForTutor,
  deleteLessonSession,
  deleteExerciseAssignmentForTutor,
  regenerateFutureUnsubmittedExercisesForTutor,
  saveCompletedLesson,
  updateCompletedLesson,
  saveTutorReport,
  subscribeToExerciseGenerationStatus,
  getStaffMembersForAccess,
  getStaffStudentAccess,
  setStaffStudentAccess,
  revokeStaffStudentAccess,
} from '../../services/firestoreService';
import { DEFAULT_SUBJECT } from '../../lib/constants';
import { deleteExerciseSubmissionFiles } from '../../services/storageService';
import { isExerciseSubmitted } from '../../services/exerciseGenerationPlan';
import { ImagePageViewer } from '../../components/common/ImagePageViewer';
import { TutorPeerMarkingScoreEditor } from '../../components/tutor/TutorPeerMarkingScoreEditor';

  const today = () => {
  const date = new Date();
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
};
const emptyLessonForm = { selectedTopic: '', topicUnderstandingScores: [], topicReport: '', lessonDate: today(), lessonType: 'online', whatsappLessonLink: '', locationDetails: '' };
const emptyTopicGroups = { extracted: [], manual: [], all: [] };
const createLessonRequestId = () => globalThis.crypto?.randomUUID?.() ?? `lesson-log-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
const hasValidScores = (entries = []) =>
  entries.length > 0 && entries.every((entry) => {
    const score = Number(entry.understandingLevel);
    return Number.isFinite(score) && score >= 0 && score <= 10;
  });
const understandingScorePercent = (value) => {
  const score = Number(value);
  return Number.isFinite(score) ? Math.round(score > 1 ? score : score * 100) : 0;
};

const loadTutorStudentDetailCore = async ({ tutorId, studentId, periodId, subject, historyRows, currentContexts }) => {
  if (periodId) {
    const archivedContext = historyRows.find((item) => item.assignmentPeriodId === periodId);
    if (!archivedContext) {
      return {
        kind: 'unavailable-history',
        historyRows,
        currentAssignmentSubjects: [...new Set(currentContexts.map((item) => item.subject).filter(Boolean))],
        status: 'This assignment history is not available to your account.',
      };
    }
    const archivedData = await getTutorAssignmentHistoryData({ tutorId, studentId, periodId, historyContexts: historyRows });
    return {
      kind: 'historical',
      historyRows,
      currentAssignmentSubjects: [...new Set(currentContexts.map((item) => item.subject).filter(Boolean))],
      student: { ...archivedContext, accessRole: 'viewer', historicalAccessRole: archivedContext.accessRole },
      studentSubjects: [archivedContext.subject],
      exercises: archivedData.exercises,
      lessons: archivedData.lessons,
      peerMarkedWork: archivedData.peerMarkedWork,
      status: 'Historical assignment records are read-only.',
    };
  }

  const accessibleSubjects = [...new Set(currentContexts
    .filter((item) => item.studentId === studentId)
    .map((item) => item.subject)
    .filter(Boolean))];
  const activeSubject = accessibleSubjects.includes(subject) ? subject : accessibleSubjects[0];
  if (!activeSubject) {
    return {
      kind: 'unavailable-current',
      historyRows,
      studentSubjects: accessibleSubjects,
      currentAssignmentSubjects: accessibleSubjects,
      status: historyRows.length ? 'No current access. Previous assignment records remain available below.' : 'You do not have access to this student.',
    };
  }

  const studentContext = currentContexts.find((item) => item.studentId === studentId && item.subject === activeSubject) ?? null;
  const [exerciseRows, subjectLessons, peerMarkedRows] = await Promise.all([
    getTutorExercisesForAssignedStudents(tutorId, [studentContext]),
    getTutorLessonRowsForAssignedStudents(tutorId, [studentContext]),
    getCompletedPeerMarkingWorkForTutor({ tutorId, studentId, subject: activeSubject }),
  ]);

  return {
    kind: 'current',
    historyRows,
    student: studentContext,
    studentContext,
    studentSubjects: accessibleSubjects,
    currentAssignmentSubjects: accessibleSubjects,
    activeSubject,
    exercises: exerciseRows.filter((item) => item.studentId === studentId && item.subject === activeSubject),
    lessons: subjectLessons.filter((item) => item.studentId === studentId && item.subject === activeSubject),
    peerMarkedWork: peerMarkedRows,
    status: '',
  };
};

const loadTutorStudentDetailAncillary = async ({ tutorId, studentId, activeSubject, studentContext, currentContexts }) => {
  const eligibleContexts = currentContexts.filter((item) => item.studentId === studentId && item.accessRole === 'co-owner');
  const [papersResult, eligibilityResult, staffAccessResult] = await Promise.all([
    getQuestionPapers({ subject: activeSubject, grade: studentContext?.grade, region: studentContext?.province })
      .then((value) => ({ value }))
      .catch((error) => ({ error })),
    getLessonEligibleSubjectGradePairs(eligibleContexts)
      .then((pairs) => ({ pairs }))
      .catch((error) => ({ error })),
    getStaffStudentAccess({ studentId, subject: activeSubject, tutorId, subjectInstanceId: studentContext?.subjectInstanceId })
      .then((value) => ({ value }))
      .catch((error) => ({ error })),
  ]);
  const topicOptionsResult = papersResult.value
    ? await getGlobalTopicOptionGroups({
      subject: activeSubject,
      grade: studentContext?.grade,
      studentIds: [studentId],
      questionPapers: papersResult.value,
    }).then((value) => ({ value })).catch((error) => ({ error }))
    : { error: papersResult.error };
  return {
    staffAccess: staffAccessResult.value ?? [],
    lessonEligibleSubjects: [...new Set((eligibilityResult.pairs ?? []).map((pair) => pair.subject))].sort(),
    lessonEligibilityError: eligibilityResult.error?.message || '',
    topicOptions: topicOptionsResult.value ?? emptyTopicGroups,
    error: papersResult.error || staffAccessResult.error || topicOptionsResult.error || null,
  };
};

export const TutorStudentDetailsPage = () => {
  const { studentId } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const subject = searchParams.get('subject') || DEFAULT_SUBJECT;
  const periodId = searchParams.get('period');
  const { profile, logout } = useAuth();
  const { operationStatus, runOperation, closeOperationStatus } = useOperationStatus();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const [student, setStudent] = useState(null);
  const [studentSubjects, setStudentSubjects] = useState([]);
  const [lessonEligibleSubjects, setLessonEligibleSubjects] = useState([]);
  const [lessonEligibilityLoading, setLessonEligibilityLoading] = useState(false);
  const [lessonEligibilityError, setLessonEligibilityError] = useState('');
  const [currentAssignmentSubjects, setCurrentAssignmentSubjects] = useState([]);
  const [assignmentHistory, setAssignmentHistory] = useState([]);
  const [exercises, setExercises] = useState([]);
  const [peerMarkedWork, setPeerMarkedWork] = useState([]);
  const [lessons, setLessons] = useState([]);
  const [topicOptions, setTopicOptions] = useState(emptyTopicGroups);
  const [lessonForm, setLessonForm] = useState(emptyLessonForm);
  const [lessonLogRequestId, setLessonLogRequestId] = useState(createLessonRequestId);
  const [status, setStatus] = useState('');
  const [isRegenerating, setIsRegenerating] = useState(false);
  const [deletingExerciseId, setDeletingExerciseId] = useState('');
  const [regenerationStatus, setRegenerationStatus] = useState(null);
  const lessonLogFingerprint = JSON.stringify({ subject, lessonForm });

  useEffect(() => {
    setLessonLogRequestId(createLessonRequestId());
  }, [lessonLogFingerprint, studentId]);
  const [staffMembers, setStaffMembers] = useState([]);
  const [staffAccess, setStaffAccess] = useState([]);
  const [selectedStaffId, setSelectedStaffId] = useState('');
  const [selectedAccessRole, setSelectedAccessRole] = useState('marker');
  const [savingStaffAccess, setSavingStaffAccess] = useState(false);
  const [isDetailsOpen, setIsDetailsOpen] = useState(false);
  const [removingLessonTopicKey, setRemovingLessonTopicKey] = useState('');

  useEffect(() => {
    if (!studentId || !profile?.uid || periodId || student?.subject !== subject || !student?.subjectInstanceId) return undefined;
    setRegenerationStatus(null);
    return subscribeToExerciseGenerationStatus(studentId, subject, setRegenerationStatus, student.subjectInstanceId);
  }, [profile?.uid, studentId, subject, periodId, student?.subject, student?.subjectInstanceId]);

  const detailKey = ['tutor', 'student-details', profile?.uid ?? '', studentId ?? ''];
  const contextsQuery = useQuery({
    queryKey: [...detailKey, 'current-contexts'],
    queryFn: () => getTutorAssignedStudentContexts(profile.uid, studentId),
    enabled: Boolean(profile?.uid && studentId),
    staleTime: 15_000,
  });
  const historyQuery = useQuery({
    queryKey: [...detailKey, 'history-contexts'],
    queryFn: () => getTutorAssignmentHistoryContexts(profile.uid, studentId),
    enabled: Boolean(profile?.uid && studentId),
    staleTime: 15_000,
  });
  const currentContexts = contextsQuery.data ?? [];
  const historyRows = historyQuery.data ?? [];
  const accessibleSubjects = [...new Set(currentContexts
    .filter((item) => item.studentId === studentId)
    .map((item) => item.subject)
    .filter(Boolean))];
  const activeSubject = accessibleSubjects.includes(subject) ? subject : accessibleSubjects[0];
  const activeStudentContext = currentContexts.find((item) => item.studentId === studentId && item.subject === activeSubject) ?? null;
  const archivedContext = historyRows.find((item) => item.assignmentPeriodId === periodId);
  const coreSubject = periodId ? archivedContext?.subject : activeSubject;
  const studentDetailsQuery = useQuery({
    queryKey: [
      ...detailKey,
      'core',
      periodId ?? 'current',
      coreSubject ?? subject,
      activeStudentContext?.subjectInstanceId ?? '',
      activeStudentContext?.accessRole ?? '',
      activeStudentContext?.grade ?? '',
      activeStudentContext?.province ?? '',
    ],
    queryFn: () => loadTutorStudentDetailCore({
      tutorId: profile.uid,
      studentId,
      periodId,
      subject: coreSubject ?? subject,
      historyRows,
      currentContexts,
    }),
    enabled: Boolean(profile?.uid && studentId && contextsQuery.isSuccess && historyQuery.isSuccess
      && (periodId ? Boolean(archivedContext) || historyQuery.isSuccess : true)),
    staleTime: 15_000,
  });
  const coreData = studentDetailsQuery.data;
  const detailListsLoading = Boolean(profile?.uid && studentId && !coreData && !studentDetailsQuery.isError
    && (contextsQuery.isPending || historyQuery.isPending || studentDetailsQuery.isPending));
  const ancillaryQuery = useQuery({
    queryKey: [...detailKey, 'ancillary', activeSubject ?? '', coreData?.studentContext?.subjectInstanceId ?? ''],
    queryFn: () => loadTutorStudentDetailAncillary({
      tutorId: profile.uid,
      studentId,
      activeSubject: coreData.activeSubject,
      studentContext: coreData.studentContext,
      currentContexts,
    }),
    enabled: Boolean(isDetailsOpen && student?.accessRole === 'co-owner' && coreData?.kind === 'current' && profile?.uid && studentId),
    staleTime: 15_000,
  });
  const staffMembersQuery = useQuery({
    queryKey: [...detailKey, 'staff-options', activeSubject ?? ''],
    queryFn: () => getStaffMembersForAccess({ tutorId: profile.uid, subject: activeSubject }),
    enabled: Boolean(isDetailsOpen && student?.accessRole === 'co-owner' && profile?.uid && activeSubject),
    staleTime: 60_000,
  });

  useScreenLoadMetrics(
    'Student details',
    location.pathname.startsWith('/teacher') ? 'teacher' : 'tutor',
    studentDetailsQuery.isSuccess || studentDetailsQuery.isError || Boolean(contextsQuery.error || historyQuery.error),
    `${studentId}:${subject}:${periodId ?? ''}`,
  );

  useEffect(() => {
    if (contextsQuery.isFetching || historyQuery.isFetching || studentDetailsQuery.isFetching) {
      setLessonEligibilityLoading(!studentDetailsQuery.data);
    }
  }, [contextsQuery.isFetching, historyQuery.isFetching, studentDetailsQuery.data, studentDetailsQuery.isFetching]);

  useEffect(() => {
    if (historyQuery.data) setAssignmentHistory(historyQuery.data);
  }, [historyQuery.data]);

  useEffect(() => {
    if (contextsQuery.error || historyQuery.error) {
      setLessonEligibilityLoading(false);
      setStatus((contextsQuery.error || historyQuery.error).message || 'Could not load student access.');
    }
  }, [contextsQuery.error, historyQuery.error]);

  useEffect(() => {
    if (studentDetailsQuery.isError) {
      setLessonEligibilityLoading(false);
      setStatus(studentDetailsQuery.error?.message || 'Could not load student details.');
      return;
    }
    if (!coreData) return;

    setAssignmentHistory(coreData.historyRows);
    setStudent(coreData.student ?? null);
    setStudentSubjects(coreData.studentSubjects ?? []);
    setCurrentAssignmentSubjects(coreData.currentAssignmentSubjects ?? []);
    if (coreData.kind !== 'current') {
      setLessonEligibleSubjects([]);
      setLessonEligibilityError('');
    }
    setExercises(coreData.exercises ?? []);
    setLessons(coreData.lessons ?? []);
    setPeerMarkedWork(coreData.peerMarkedWork ?? []);
    setLessonEligibilityLoading(false);
    if (coreData.kind === 'historical') {
      setStaffAccess([]);
      setStaffMembers([]);
    }
    if (coreData.status) setStatus(coreData.status);
    if (coreData.kind === 'current' && coreData.activeSubject !== subject) {
      setSearchParams({ subject: coreData.activeSubject }, { replace: true });
    } else if (coreData.kind === 'historical' && coreData.student?.subject !== subject) {
      setSearchParams({ period: periodId, subject: coreData.student.subject }, { replace: true });
    }
  }, [coreData, periodId, setSearchParams, studentDetailsQuery.error, studentDetailsQuery.isError, subject]);

  useEffect(() => {
    if (!ancillaryQuery.data) return;
    setStaffAccess(ancillaryQuery.data.staffAccess);
    setLessonEligibleSubjects(ancillaryQuery.data.lessonEligibleSubjects);
    setLessonEligibilityError(ancillaryQuery.data.lessonEligibilityError);
    setTopicOptions(ancillaryQuery.data.topicOptions);
    if (ancillaryQuery.data.error) setStatus(ancillaryQuery.data.error.message || 'Some student details could not be loaded.');
  }, [ancillaryQuery.data]);

  useEffect(() => {
    if (isDetailsOpen && ancillaryQuery.isFetching && !ancillaryQuery.data) setLessonEligibilityLoading(true);
    else if (ancillaryQuery.data) setLessonEligibilityLoading(false);
  }, [ancillaryQuery.data, ancillaryQuery.isFetching, isDetailsOpen]);

  useEffect(() => {
    if (staffMembersQuery.data) setStaffMembers(staffMembersQuery.data);
  }, [staffMembersQuery.data]);

  const load = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: [...detailKey, 'current-contexts'], exact: true }),
      queryClient.invalidateQueries({ queryKey: [...detailKey, 'history-contexts'], exact: true }),
    ]);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: [...detailKey, 'core'] }),
      queryClient.invalidateQueries({ queryKey: [...detailKey, 'ancillary'] }),
    ]);
  };

  const canManage = student?.accessRole === 'co-owner';
  const canMark = canManage || student?.accessRole === 'marker';
  const removeLessonTopic = async (lesson, topic) => {
    const operationKey = `${lesson.id}:${topic}`;
    if (!canManage || removingLessonTopicKey) return;
    if (!window.confirm(`Remove “${topic}” from this completed lesson? Its lesson score will be removed and the topic will remain completed only if another completed lesson covers it.`)) return;
    setRemovingLessonTopicKey(operationKey);
    try {
      const result = await runOperation({
        operationName: `Removing ${topic} from the lesson`,
        successMessage: 'The completed lesson topic was updated.',
        failureMessage: 'Could not remove the completed topic.',
      }, async () => {
        const savedResult = await removeCompletedTopicFromLesson({
          studentId,
          subjectInstanceId: student.subjectInstanceId,
          lessonId: lesson.id,
          subject,
          topic,
        });
        await load();
        return savedResult;
      });
      setStatus(result.lessonStatus === 'incomplete'
        ? `Removed ${topic}. The lesson has no remaining completed topics and is now incomplete.`
        : result.topicRemainsCompleted
          ? `Removed ${topic} from this lesson. It remains completed because another completed lesson covers it.`
          : `Removed ${topic} from this lesson and the student's completed topic list.`);
    } catch (error) {
      setStatus(error.message || 'Could not remove the completed topic.');
    } finally {
      setRemovingLessonTopicKey('');
    }
  };
  const todayLocal = today();
  const regenerationInProgress = isRegenerating || (
    regenerationStatus?.status === 'processing'
    && Date.now() < Number(regenerationStatus.expiresAtMs ?? 0)
  );
  const basePath = location.pathname.startsWith('/teacher') ? '/teacher' : '/tutor';
  const sortedExercises = [...exercises].sort((a, b) => String(a.assignmentDate ?? '').localeCompare(String(b.assignmentDate ?? '')));

  const addTopic = () => {
    if (!lessonForm.selectedTopic || lessonForm.topicUnderstandingScores.some((entry) => entry.topic === lessonForm.selectedTopic)) return;
    setLessonForm((current) => ({ ...current, selectedTopic: '', topicUnderstandingScores: [...current.topicUnderstandingScores, { topic: current.selectedTopic, understandingLevel: 5 }] }));
  };
  const updateScore = (topic, value) => setLessonForm((current) => ({ ...current, topicUnderstandingScores: current.topicUnderstandingScores.map((entry) => entry.topic === topic ? { ...entry, understandingLevel: Number(value) } : entry) }));
  const removeTopic = (topic) => setLessonForm((current) => ({ ...current, topicUnderstandingScores: current.topicUnderstandingScores.filter((entry) => entry.topic !== topic) }));

  const grantStaffAccess = async () => {
    if (!selectedStaffId || !canManage) return;
    setSavingStaffAccess(true);
    try {
      await runOperation({ operationName: 'Updating staff access', successMessage: 'Staff access was updated.' }, async () => {
        await setStaffStudentAccess({ actorId: profile.uid, studentId, tutorId: selectedStaffId, subject, accessRole: selectedAccessRole });
        setStaffAccess(await getStaffStudentAccess({ studentId, subject, tutorId: profile.uid, subjectInstanceId: student?.subjectInstanceId }));
        await queryClient.invalidateQueries({ queryKey: [...detailKey, 'ancillary'] });
      });
      setStatus('Staff access updated.');
      setSelectedStaffId('');
    } catch (error) {
      setStatus(error.message || 'Could not update staff access.');
    } finally {
      setSavingStaffAccess(false);
    }
  };

  const removeStaffAccess = async (accessId) => {
    try {
      await runOperation({ operationName: 'Removing staff access', successMessage: 'Staff access was removed.' }, async () => {
        await revokeStaffStudentAccess({ actorId: profile.uid, studentId, subject, accessId });
        setStaffAccess(await getStaffStudentAccess({ studentId, subject, tutorId: profile.uid, subjectInstanceId: student?.subjectInstanceId }));
        await queryClient.invalidateQueries({ queryKey: [...detailKey, 'ancillary'] });
      });
      setStatus('Staff access removed.');
    } catch (error) {
      setStatus(error.message || 'Could not remove staff access.');
    }
  };

  const regenerateExercises = async () => {
    if (isRegenerating) {
      setStatus('Exercise regeneration is already in progress.');
      return;
    }
    if (!student || !student.subjectInstanceId) {
      setStatus('Student access details are still loading. Reload the page and try again.');
      return;
    }
    const confirmed = window.confirm(`Regenerate the upcoming exercise window for ${student.displayName || student.name || 'this student'}? Unsubmitted exercises in the window will be replaced, missing days can be filled, and submitted work will be kept.`);
    if (!confirmed) return;
    setIsRegenerating(true);
    setStatus('Starting exercise regeneration...');
    try {
      const result = await runOperation({
        operationName: `Regenerating ${subject} exercises`,
        successMessage: 'Exercise generation has finished.',
        failureMessage: 'Could not regenerate exercises.',
      }, () => regenerateFutureUnsubmittedExercisesForTutor({
        tutorId: profile.uid,
        student: { ...student, uid: studentId },
        subject,
        onProgress: setStatus,
      }));
      setStatus(result.generated
        ? `${result.reason} The student can now see the updated exercises.`
        : `No exercises were replaced: ${result.reason || 'No complete replacement set was available.'}`);
      await load();
    } catch (error) {
      setStatus(error.message || 'Could not regenerate exercises.');
    } finally {
      setIsRegenerating(false);
    }
  };

  const removeExercise = async (exercise) => {
    if (!window.confirm(`Delete “${exercise.title || 'this exercise'}” for ${student?.displayName || student?.name || 'this student'}? This cannot be undone.`)) return;
    setDeletingExerciseId(exercise.id);
    try {
      await runOperation({ operationName: 'Deleting exercise and uploaded work', successMessage: 'The exercise and its submitted files were deleted.' }, async () => {
        const result = await deleteExerciseAssignmentForTutor({ tutorId: profile.uid, exerciseId: exercise.id });
        await deleteExerciseSubmissionFiles(result.storageUrls);
        setExercises((current) => current.filter((item) => item.id !== exercise.id));
        await queryClient.invalidateQueries({ queryKey: [...detailKey, 'core'] });
      });
      setStatus('Exercise deleted.');
    } catch (error) {
      setStatus(error.message || 'Could not delete exercise.');
    } finally {
      setDeletingExerciseId('');
    }
  };

  const canDeleteExercise = (exercise) => String(exercise.assignmentDate ?? '').slice(0, 10) > today() && !isExerciseSubmitted(exercise);

  const completeLesson = async () => {
    if (!lessonEligibleSubjects.includes(subject)) {
      setStatus(lessonEligibilityError
        ? `Could not verify analyzed question papers: ${lessonEligibilityError}`
        : 'This subject has no analyzed question paper and topic catalog for the student’s grade. Analyze a paper before completing a lesson.');
      return;
    }
    if (!lessonForm.topicUnderstandingScores.length || !lessonForm.topicReport.trim() || !lessonForm.lessonDate || !lessonForm.lessonType || !hasValidScores(lessonForm.topicUnderstandingScores)) {
      setStatus('Choose at least one topic, date, lesson type, score from 0 to 10, and enter the lesson report.');
      return;
    }
    try {
      await runOperation({
        operationName: 'Completing lesson and updating exercises',
        successMessage: 'The lesson, report, and topic scores have been saved.',
        failureMessage: 'Could not complete and save this lesson.',
      }, async () => {
        const topics = lessonForm.topicUnderstandingScores.map((entry) => entry.topic);
        const understandingLevel = Math.round(lessonForm.topicUnderstandingScores.reduce((sum, entry) => sum + Number(entry.understandingLevel ?? 5), 0) / topics.length);
        const topicScoresText = lessonForm.topicUnderstandingScores.map((entry) => `${entry.topic}: ${Math.round(Number(entry.understandingLevel) * 10)}%`).join('\n');
        const report = [`--- ${topics.join(' | ')} ---`, 'Topics completed:', topicScoresText, 'Tutor report:', lessonForm.topicReport, `Date: ${new Date().toLocaleString()}`].join('\n');

        const completedEntries = lessonForm.topicUnderstandingScores.map((entry) => ({ ...entry, topicReport: lessonForm.topicReport }));
        const plannedLessons = lessons.filter((item) => item.status === 'planned' || item.status === 'incomplete');
        const lessonToComplete = plannedLessons.find((item) =>
          (item.topics?.length ? item.topics : [item.topic]).some((itemTopic) => topics.some((topicName) => topicName.toLocaleLowerCase() === String(itemTopic).toLocaleLowerCase())),
        );
        const lessonPayload = {
          tutorId: profile.uid,
          studentId,
          subject,
          topic: topics[0],
          topics,
          topicUnderstandingScores: completedEntries,
          topicReport: lessonForm.topicReport,
          understandingLevel,
          studentName: student?.displayName || student?.name || 'Student',
          lessonDate: lessonForm.lessonDate,
          lessonType: lessonForm.lessonType,
          whatsappLessonLink: lessonForm.whatsappLessonLink,
          locationDetails: lessonForm.locationDetails,
          status: 'completed',
        };
        const lesson = lessonToComplete
          ? await updateCompletedLesson({ lessonId: lessonToComplete.id, ...lessonPayload })
          : await saveCompletedLesson({ ...lessonPayload, requestId: lessonLogRequestId });
        await saveTutorReport({ reportId: `lesson-${lesson.id}`, tutorId: profile.uid, studentId, subject, reportType: 'lesson', note: report, studentName: student?.displayName || student?.name || 'Student' });
        const completedTopicKeys = new Set(topics.map((topicName) => topicName.toLocaleLowerCase()));
        const duplicatePlannedLessons = plannedLessons.filter((item) => item.id !== lessonToComplete?.id
          && (item.topics?.length ? item.topics : [item.topic]).some((itemTopic) => completedTopicKeys.has(String(itemTopic).toLocaleLowerCase())));
        if (duplicatePlannedLessons.length) {
          await deleteLessonSession({ tutorId: profile.uid, lessonRows: duplicatePlannedLessons });
        }
        const generation = await generateExercisePlanIfEligible({
          student: { ...student, uid: studentId },
          subject,
          mode: 'weekly',
          completedLesson: lesson,
          understandingLevel,
          onProgress: setStatus,
        });
        setLessonForm(emptyLessonForm);
        setStatus(generation.generated
          ? 'Lesson completed and exercises regenerated.'
          : `Lesson completed and saved. Exercise generation did not start: ${generation.reason || 'unknown reason'}`);
        await load();
      });
    } catch (error) {
      setStatus(error.message || 'Could not complete and save this lesson.');
    }
  };

  return (
    <AppShell title={student?.displayName || student?.name || 'Student'} subtitle={`${subject} learner details, reports, exercises, and lessons.`} role="tutor" user={profile} onLogout={logout}>
      {status || regenerationInProgress ? (
        <div role="status" aria-live="polite" className={`panel flex items-center gap-3 p-4 text-sm ${regenerationInProgress ? 'border border-lime-400/30 bg-lime-400/10 text-lime-300' : 'text-slate-300'}`}>
          {regenerationInProgress ? <LoaderCircle className="h-4 w-4 shrink-0 animate-spin text-lime-400" aria-hidden="true" /> : null}
          <span>{regenerationInProgress ? regenerationStatus?.message || status || 'Regenerating exercises...' : status}</span>
        </div>
      ) : null}
      {detailListsLoading ? <LoadingState label="Loading student exercises, lessons, and marking history…" /> : null}
      <Link to={`${basePath}`} className="hidden w-fit items-center gap-2 text-lime-400 hover:text-lime-300 sm:inline-flex"><span aria-hidden="true">&lt;</span><span>Assigned students</span></Link>

      {student?.historicalAccessRole ? <div className="panel border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-800">
        Historical assignment · {student.historicalAccessRole} access · read-only{student.endDateEstimated ? ' · end date estimated from legacy data' : ''}
      </div> : null}

      {assignmentHistory.length ? <section className="panel space-y-3 p-4">
        <div><h2 className="font-semibold text-slate-950">Previous access</h2><p className="text-sm text-slate-500">Ended assignments remain available as read-only records.</p></div>
        <div className="flex flex-wrap gap-2">
          {assignmentHistory.map((entry) => <button
            key={entry.assignmentPeriodId}
            type="button"
            className={periodId === entry.assignmentPeriodId ? 'btn-primary' : 'btn-secondary'}
            onClick={() => setSearchParams({ period: entry.assignmentPeriodId, subject: entry.subject })}
          >
            {entry.subject} · {entry.accessRole} · {entry.assignmentEndedAt?.toDate?.().toLocaleDateString?.() || (entry.assignmentEndedAt ? new Date(entry.assignmentEndedAt).toLocaleDateString() : 'Past access')}
          </button>)}
          {currentAssignmentSubjects.map((currentSubject) => <button key={`current-${currentSubject}`} type="button" className="btn-secondary" onClick={() => setSearchParams({ subject: currentSubject })}>Current · {currentSubject}</button>)}
        </div>
      </section> : null}

      {!student?.historicalAccessRole ? <div className="flex flex-wrap justify-center gap-2" role="tablist" aria-label="Student subjects">
        {studentSubjects.map((studentSubject) => (
          <button
            key={studentSubject}
            type="button"
            role="tab"
            aria-selected={subject === studentSubject}
            className={subject === studentSubject ? 'btn-primary' : 'btn-secondary'}
            onClick={() => setSearchParams({ subject: studentSubject })}
          >
            {studentSubject}
          </button>
        ))}
      </div> : null}

      <div className="flex justify-end">
        <button type="button" className="btn-secondary" onClick={() => setIsDetailsOpen(true)}>Student details and lessons</button>
      </div>

      {isDetailsOpen ? <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-950/80 p-3 sm:p-6" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setIsDetailsOpen(false); }}>
      <section className="panel my-auto w-full max-w-4xl space-y-5 p-5 sm:p-7" role="dialog" aria-modal="true" aria-labelledby="student-details-title">
      <div className="flex items-start justify-between gap-4"><div><h2 id="student-details-title" className="text-xl font-semibold text-slate-950">Student details and lessons</h2><p className="mt-1 text-sm text-slate-500">{subject}</p></div><button type="button" className="btn-secondary inline-flex items-center" aria-label="Close student details" onClick={() => setIsDetailsOpen(false)}><X className="h-4 w-4" /></button></div>
      <section className="panel p-5">
        <h2 className="text-xl font-semibold text-slate-950">Student details</h2>
        <p className="mt-2 text-sm text-slate-500">{student?.grade || '?'} • {student?.province || '?'} • {subject} • {student?.activeSubjectPlanId === 'personalized' || student?.lessonQuota?.planId === 'personalized' ? 'Personalized plan' : student?.activeSubjectPlanId === 'circle' || student?.lessonQuota?.planId === 'circle' ? 'Circle plan' : 'Lesson plan unavailable'}</p>
      </section>

      {canManage ? <section className="panel space-y-4 p-5">
        <SectionHeader eyebrow="Staff access" title="Share this student" description="Grant another tutor or teacher co-owner, marker, or viewer access for this subject." />
        <div className="grid gap-3 md:grid-cols-[1fr_180px_auto]">
          <select className="input" value={selectedStaffId} onChange={(event) => setSelectedStaffId(event.target.value)} disabled={staffMembersQuery.isFetching}>
            <option value="">{staffMembersQuery.isFetching ? 'Loading tutors and teachers…' : 'Choose tutor or teacher'}</option>
            {staffMembers.map((member) => <option key={member.uid} value={member.uid}>{member.displayName || member.email} {member.isTeacher === true || member.isTeacher === 'true' || member.role === 'teacher' ? '(Teacher)' : '(Tutor)'}</option>)}
          </select>
          <select className="input" value={selectedAccessRole} onChange={(event) => setSelectedAccessRole(event.target.value)}>
            <option value="co-owner">Co-owner</option><option value="marker">Marker</option><option value="viewer">Viewer</option>
          </select>
          <button type="button" className="btn-primary inline-flex items-center justify-center gap-2" onClick={grantStaffAccess} disabled={!selectedStaffId || savingStaffAccess}>
            <UserPlus className="h-4 w-4" aria-hidden="true" /> {savingStaffAccess ? 'Saving...' : 'Grant access'}
          </button>
        </div>
        <div className="divide-y divide-slate-200">
          {ancillaryQuery.isFetching || staffMembersQuery.isFetching ? <LoadingState label="Loading staff access…" /> : null}
          {staffAccess.map((entry) => <div key={entry.id} className="flex items-center justify-between gap-3 py-3">
            <div><p className="font-medium text-slate-900">{entry.displayName}</p><p className="text-sm capitalize text-slate-500">{entry.accessRole}</p></div>
            <button type="button" className="btn-secondary inline-flex items-center gap-2" onClick={() => removeStaffAccess(entry.id)}><X className="h-4 w-4" aria-hidden="true" /> Remove</button>
          </div>)}
          {!ancillaryQuery.isFetching && !staffAccess.length ? <p className="py-2 text-sm text-slate-500">No additional staff have access.</p> : null}
        </div>
      </section> : null}

      {canManage ? (
        <section className="panel space-y-4 p-5">
          <SectionHeader eyebrow="Lesson complete" title="Save completed topics" description="Choose topics from analyzed papers, add scores, and save the lesson to generate exercises." />
          <label className="grid max-w-xl gap-2 text-sm font-semibold text-slate-700">Lesson subject
            <select
              className="input"
              value={lessonEligibleSubjects.includes(subject) ? subject : ''}
              onChange={(event) => {
                if (!event.target.value) return;
                setLessonForm(emptyLessonForm);
                setStatus('');
                setSearchParams({ subject: event.target.value });
              }}
              disabled={lessonEligibilityLoading || ancillaryQuery.isFetching || !lessonEligibleSubjects.length}
            >
              <option value="">{lessonEligibilityLoading ? 'Checking analyzed papers…' : 'Choose an analyzed subject'}</option>
              {lessonEligibleSubjects.map((eligibleSubject) => <option key={eligibleSubject} value={eligibleSubject}>{eligibleSubject}</option>)}
            </select>
          </label>
          {lessonEligibilityError ? <p className="text-sm text-rose-700" role="alert">Could not verify lesson subjects: {lessonEligibilityError}</p> : null}
          {!lessonEligibilityLoading && !lessonEligibilityError && !lessonEligibleSubjects.includes(subject) ? <p className="text-sm text-amber-800" role="status">Lesson completion is available only for assigned subjects with an analyzed question paper and a topic catalog for this student’s grade.</p> : null}
          <div className="grid gap-3 md:grid-cols-2">
            <label className="grid gap-2 text-sm font-semibold text-slate-700">Lesson date<input type="date" className="input" value={lessonForm.lessonDate} onChange={(event) => setLessonForm((current) => ({ ...current, lessonDate: event.target.value }))} /></label>
            <label className="grid gap-2 text-sm font-semibold text-slate-700">Lesson type<select className="input" value={lessonForm.lessonType} onChange={(event) => setLessonForm((current) => ({ ...current, lessonType: event.target.value }))}><option value="online">Online (WhatsApp)</option><option value="inPerson">In-person</option></select></label>
          </div>
          {lessonForm.lessonType === 'online' ? (
            <label className="grid gap-2 text-sm font-semibold text-slate-700">WhatsApp lesson or group-invite link <span className="font-normal text-slate-500">Optional</span>
              <input type="url" className="input" value={lessonForm.whatsappLessonLink} onChange={(event) => setLessonForm((current) => ({ ...current, whatsappLessonLink: event.target.value }))} placeholder="https://call.whatsapp.com/... or https://chat.whatsapp.com/..." />
              <span className="text-xs font-normal text-slate-500">Online lessons use WhatsApp only.</span>
            </label>
          ) : (
            <label className="grid gap-2 text-sm font-semibold text-slate-700">Address or school name <span className="font-normal text-slate-500">Optional</span>
              <textarea className="input min-h-20" value={lessonForm.locationDetails} onChange={(event) => setLessonForm((current) => ({ ...current, locationDetails: event.target.value }))} placeholder="School name, street address, or meeting point" />
            </label>
          )}
          <div className="grid gap-3 lg:grid-cols-[1fr_auto]">
            <select className="input" value={lessonForm.selectedTopic} onChange={(event) => setLessonForm((current) => ({ ...current, selectedTopic: event.target.value }))} disabled={!lessonEligibleSubjects.includes(subject) || !topicOptions.all.length}>
              <option value="">{ancillaryQuery.isFetching ? 'Loading topics…' : topicOptions.all.length ? 'Choose topic' : 'No topics available'}</option>
              {topicOptions.extracted.length ? <optgroup label="Past paper extracted topics">{topicOptions.extracted.map((topic) => <option key={`paper-${topic}`}>{topic}</option>)}</optgroup> : null}
              {topicOptions.manual.length ? <optgroup label="Manual topic list">{topicOptions.manual.map((topic) => <option key={`manual-${topic}`}>{topic}</option>)}</optgroup> : null}
            </select>
            {ancillaryQuery.isFetching && !ancillaryQuery.data ? <LoadingState className="min-h-12 p-3" label="Loading topic choices…" /> : null}
            <button type="button" className="btn-secondary" onClick={addTopic} disabled={!lessonForm.selectedTopic}>Add topic</button>
          </div>
          <p className="text-sm text-slate-600">Enter an understanding score from 0 to 10 for every topic covered in this lesson.</p>
          {lessonForm.topicUnderstandingScores.map((entry) => (
            <div key={entry.topic} className="grid gap-3 rounded-2xl bg-slate-50 p-3 md:grid-cols-[1fr_160px_auto] md:items-center">
              <p className="font-semibold text-slate-900">{entry.topic}</p>
              <input type="number" min="0" max="10" step="1" className="input" aria-label={`${entry.topic} understanding score out of 10`} placeholder="0–10" value={entry.understandingLevel} onChange={(event) => updateScore(entry.topic, event.target.value)} />
              <button type="button" className="btn-secondary" onClick={() => removeTopic(entry.topic)}>Remove</button>
            </div>
          ))}
          <textarea className="input min-h-32" value={lessonForm.topicReport} onChange={(event) => setLessonForm((current) => ({ ...current, topicReport: event.target.value }))} placeholder="Lesson report" />
          <button type="button" className="btn-primary" onClick={completeLesson} disabled={lessonEligibilityLoading || ancillaryQuery.isFetching || !lessonEligibleSubjects.includes(subject) || !lessonForm.topicUnderstandingScores.length || !lessonForm.topicReport.trim() || !hasValidScores(lessonForm.topicUnderstandingScores)}>Lesson completed</button>
        </section>
      ) : null}

      <section className="panel p-5">
        <SectionHeader eyebrow="Lessons" title="Tutor lessons" description="Planned and completed lessons for this student." />
        <div className="space-y-3">{lessons.map((lesson) => {
          const lessonTopics = [...new Set((lesson.topics ?? [lesson.topic]).filter(Boolean))];
          const lessonStatus = lesson.status === 'planned' ? 'Planned' : lesson.status === 'incomplete' ? 'Incomplete' : lesson.status === 'missed' ? 'Missed' : lesson.status === 'cancelled' ? 'Cancelled' : 'Completed';
          const lessonTypeLabel = lesson.lessonType === 'inPerson' ? 'In-person' : 'Online (WhatsApp)';
          const content = <><div className="flex flex-wrap items-center justify-between gap-3"><p className="font-semibold text-slate-950">{lessonTopics.join(' | ') || lesson.topic || 'Lesson topic removed'}</p><span className="rounded-full border border-slate-700 bg-slate-800 px-3 py-1 text-xs font-semibold text-slate-300">{lessonStatus}</span></div><p className="text-sm text-slate-500">{lesson.completedOn || lesson.lessonDate || 'No date'} • {lessonTypeLabel}</p></>;
          return <div key={lesson.id} className="rounded-lg bg-slate-50 p-4">
            {student?.historicalAccessRole
              ? content
              : <Link to={`${basePath}/lessons/${lesson.id}`} className="block">{content}</Link>}
            {canManage && lesson.status === 'completed' && lessonTopics.length ? <div className="mt-3 border-t border-slate-200 pt-3">
              <p className="mb-2 text-xs font-semibold text-slate-500">Correct completed topics</p>
              <div className="flex flex-wrap gap-2">{lessonTopics.map((topic) => {
                const operationKey = `${lesson.id}:${topic}`;
                const isRemoving = removingLessonTopicKey === operationKey;
                return <span key={topic} className="inline-flex items-center gap-1 rounded-full border border-lime-300 bg-lime-100 px-3 py-1 text-sm font-medium text-lime-950">
                  {topic}
                  <button type="button" className="ml-1 text-xs font-semibold text-rose-700 hover:text-rose-900 disabled:opacity-50" onClick={() => removeLessonTopic(lesson, topic)} disabled={Boolean(removingLessonTopicKey)} aria-label={`Remove ${topic} from this completed lesson`}>
                    {isRemoving ? 'Removing…' : 'Remove'}
                  </button>
                </span>;
              })}</div>
            </div> : null}
          </div>;
        })}{!detailListsLoading && !studentDetailsQuery.isError && !lessons.length ? <p className="text-sm text-slate-500">No lessons yet.</p> : null}</div>
      </section>
      </section></div> : null}

      <section className="panel space-y-4 p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <SectionHeader eyebrow="Exercises" title="Assigned exercises" description="Click an exercise to view details and paper links." />
            {canManage ? <button type="button" className="btn-secondary inline-flex items-center gap-2 disabled:cursor-not-allowed" onClick={regenerateExercises} disabled={regenerationInProgress}>
              {regenerationInProgress ? <><LoaderCircle className="h-4 w-4 animate-spin text-lime-400" aria-hidden="true" /> Regenerating...</> : 'Regenerate exercise window'}
            </button> : null}
          </div>
          {exercises.some((exercise) => exercise.needsMorePaperAnalysis && String(exercise.assignmentDate ?? '') >= todayLocal) ? <div className="rounded-lg border border-amber-300/30 bg-amber-300/10 p-3 text-sm text-amber-100" role="status">
            Some completed topics have too few analyzed paper questions to fill every exercise slot. Upload and analyze more past papers to add question coverage.
          </div> : null}
          <div className="space-y-3">{sortedExercises.map((exercise) => (
            <div key={exercise.id} className="flex items-center gap-3 rounded-lg bg-slate-800/60 p-3">
              <button type="button" onClick={() => {
                const params = new URLSearchParams({ studentId });
                if (exercise.subjectInstanceId) params.set('subjectInstanceId', exercise.subjectInstanceId);
                if (student?.historicalAccessRole) params.set('period', periodId);
                navigate(`/tutor/exercises/${exercise.id}?${params.toString()}`);
              }} className="min-w-0 flex-1 text-left">
                <p className="font-semibold text-slate-100">{exercise.title}</p>
                <p className="text-sm text-slate-400">{exercise.subject} • {exercise.assignmentDate}</p>
                <ExerciseStatusBadges exercise={exercise} className="mt-2" />
              </button>
              {canManage && canDeleteExercise(exercise) ? <button type="button" className="btn-secondary inline-flex items-center gap-2 text-rose-300" onClick={() => removeExercise(exercise)} disabled={deletingExerciseId === exercise.id} aria-label={`Delete ${exercise.title}`} title="Delete future exercise">
                <Trash2 className="h-4 w-4" aria-hidden="true" /> {deletingExerciseId === exercise.id ? 'Deleting...' : 'Delete'}
              </button> : null}
            </div>
          ))}{!detailListsLoading && !studentDetailsQuery.isError && !exercises.length ? <p className="text-sm text-slate-400">No exercises yet.</p> : null}</div>
      </section>

      <section className="space-y-4">
        <SectionHeader eyebrow="Peer marking" title="Work this student marked" description="Review the original student work, your student's whiteboard annotations, and the exact paper question they marked." />
        {peerMarkedWork.map((assignment) => (
          <article key={assignment.id} className="panel space-y-4 p-5">
            <div>
              <p className="font-semibold text-slate-900">{assignment.title || 'Peer-marked exercise'} · {assignment.assignmentDate}</p>
              <p className="mt-1 text-sm text-slate-500">{assignment.topic || subject} · {assignment.tutorReviewStatus === 'reviewed' ? 'Tutor reviewed' : 'Awaiting tutor review'}</p>
              <p className="mt-1 text-xs text-slate-500">Marked exercise ID: {assignment.markedExerciseId || assignment.exerciseId} · Student exercise ID: {assignment.reviewerExerciseId || 'Not recorded'}</p>
            </div>
            {Array.isArray(assignment.questionLinks) && assignment.questionLinks.length ? (
              <div className="flex flex-wrap gap-2">
                {assignment.questionLinks.map((link, index) => (
                  <Link key={`${link.paperId}-${link.questionReference}-${index}`} className="btn-secondary inline-flex items-center gap-2" to={`/tutor/papers/${link.paperId}?page=${Math.max(1, Number(link.pageNumber) || 1)}&question=${encodeURIComponent(link.questionReference || '')}`}>
                    <FileText className="h-4 w-4" aria-hidden="true" />
                    {link.questionReference ? `Q${link.questionReference}` : 'Question'} · page {link.pageNumber || 1}{Number(link.marks) > 0 ? ` · ${link.marks} marks` : ''}
                  </Link>
                ))}
              </div>
            ) : assignment.paperIds?.[0] ? (
              <Link className="btn-secondary inline-flex items-center gap-2" to={`/tutor/papers/${assignment.paperIds[0]}?page=1`}><FileText className="h-4 w-4" aria-hidden="true" />Open question paper</Link>
            ) : null}
            {canMark ? <TutorPeerMarkingScoreEditor
              tutorId={profile.uid}
              studentId={studentId}
              assignment={assignment}
              onSaved={async (result) => {
                const summary = (result.topicScores ?? []).map((entry) => `${entry.topic}: ${understandingScorePercent(entry.averageUnderstandingLevel ?? entry.understandingLevel)}%`).join(' · ');
                setStatus(`Peer marking reviewed. ${summary}`);
                await load();
              }}
            /> : null}
            <div className="grid gap-5 lg:grid-cols-2">
              <ImagePageViewer images={assignment.submittedImages?.length ? assignment.submittedImages : [assignment.submittedImageUrl].filter(Boolean)} title="Other student's original work" alt="Unmarked work the student reviewed" />
              <ImagePageViewer images={assignment.reviewImages?.length ? assignment.reviewImages : [assignment.reviewImageUrl].filter(Boolean)} title="Student's peer marking" alt="Student's marked version of another learner's work" />
              <ImagePageViewer images={assignment.targetExercise?.tutorMarkedImages?.length ? assignment.targetExercise.tutorMarkedImages : [assignment.targetExercise?.tutorMarkedImageUrl].filter(Boolean)} title="Tutor-marked work" alt="Tutor-marked image for the reviewed exercise" />
            </div>
          </article>
        ))}
        {!detailListsLoading && !studentDetailsQuery.isError && !peerMarkedWork.length ? <div className="panel p-5 text-sm text-slate-500">No completed peer-marking work is available yet.</div> : null}
      </section>
      <OperationStatusOverlay
        state={operationStatus?.state}
        operationName={operationStatus?.operationName}
        message={operationStatus?.message}
        onDone={closeOperationStatus}
      />
    </AppShell>
  );
};
