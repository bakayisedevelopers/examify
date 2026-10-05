import { useEffect, useState } from 'react';
import { FileText, Trash2, UserPlus, X } from 'lucide-react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { LoaderCircle } from 'lucide-react';
import { AppShell } from '../../components/common/AppShell';
import { SectionHeader } from '../../components/common/SectionHeader';
import { ExerciseStatusBadges } from '../../components/dashboard/ExerciseStatusBadges';
import { useAuth } from '../../hooks/useAuth';
import {
  generateExercisePlanIfEligible,
  getGlobalTopicOptionGroups,
  getLessonEligibleSubjectGradePairs,
  getQuestionPapers,
  getTutorAssignedStudentContexts,
  getTutorAssignmentHistoryContexts,
  getTutorAssignmentHistoryData,
  getTutorExercisesForAssignedStudents,
  getTutorLessonsForAssignedStudents,
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
import { getSevenDayWindow, isExerciseSubmitted } from '../../services/exerciseGenerationPlan';
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
export const TutorStudentDetailsPage = () => {
  const { studentId } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const subject = searchParams.get('subject') || DEFAULT_SUBJECT;
  const periodId = searchParams.get('period');
  const { profile, logout } = useAuth();
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

  useEffect(() => {
    if (!studentId || !profile?.uid || periodId || student?.subject !== subject || !student?.subjectInstanceId) return undefined;
    setRegenerationStatus(null);
    return subscribeToExerciseGenerationStatus(studentId, subject, setRegenerationStatus, student.subjectInstanceId);
  }, [profile?.uid, studentId, subject, periodId, student?.subject, student?.subjectInstanceId]);

  const load = async () => {
    if (!profile?.uid) return;
    if (!periodId) {
      setLessonEligibleSubjects([]);
      setLessonEligibilityLoading(true);
      setLessonEligibilityError('');
    }
    const historyRows = await getTutorAssignmentHistoryContexts(profile.uid, studentId);
    setAssignmentHistory(historyRows);

    if (periodId) {
      setLessonEligibleSubjects([]);
      setLessonEligibilityLoading(false);
      const archivedContext = historyRows.find((item) => item.assignmentPeriodId === periodId);
      if (!archivedContext) {
        setStudent(null);
        setStudentSubjects([]);
        setExercises([]);
        setLessons([]);
        setPeerMarkedWork([]);
        setStatus('This assignment history is not available to your account.');
        return;
      }
      const archivedData = await getTutorAssignmentHistoryData({ tutorId: profile.uid, studentId, periodId });
      const currentContexts = await getTutorAssignedStudentContexts(profile.uid);
      setCurrentAssignmentSubjects([...new Set(currentContexts.filter((item) => item.studentId === studentId).map((item) => item.subject))]);
      const archivedSubject = archivedContext.subject;
      setStudent({ ...archivedContext, accessRole: 'viewer', historicalAccessRole: archivedContext.accessRole });
      setStudentSubjects([archivedSubject]);
      setExercises(archivedData.exercises);
      setLessons(archivedData.lessons);
      setPeerMarkedWork(archivedData.peerMarkedWork);
      setStaffAccess([]);
      setStaffMembers([]);
      setStatus('Historical assignment records are read-only.');
      if (subject !== archivedSubject) setSearchParams({ period: periodId, subject: archivedSubject }, { replace: true });
      return;
    }

    const [contexts, exerciseRows, lessonRows] = await Promise.all([
      getTutorAssignedStudentContexts(profile.uid),
      getTutorExercisesForAssignedStudents(profile.uid),
      getTutorLessonsForAssignedStudents(profile.uid),
    ]);
    const accessibleSubjects = [...new Set(contexts
      .filter((item) => item.studentId === studentId)
      .map((item) => item.subject)
      .filter(Boolean))];
    setStudentSubjects(accessibleSubjects);
    setCurrentAssignmentSubjects(accessibleSubjects);
    const activeSubject = accessibleSubjects.includes(subject) ? subject : accessibleSubjects[0];
    if (!activeSubject) {
      setLessonEligibleSubjects([]);
      setLessonEligibilityLoading(false);
      setStudent(null);
      setStatus(historyRows.length ? 'No current access. Previous assignment records remain available below.' : 'You do not have access to this student.');
      return;
    }
    if (activeSubject !== subject) setSearchParams({ subject: activeSubject }, { replace: true });
    const studentContext = contexts.find((item) => item.studentId === studentId && item.subject === activeSubject) ?? null;
    setLessonEligibilityLoading(true);
    setLessonEligibilityError('');
    let papers;
    let eligibilityResult;
    try {
      [papers, eligibilityResult] = await Promise.all([
        getQuestionPapers({ subject: activeSubject, grade: studentContext?.grade, region: studentContext?.province }),
        getLessonEligibleSubjectGradePairs(contexts.filter((item) => item.studentId === studentId && item.accessRole === 'co-owner'))
          .then((pairs) => ({ pairs }))
          .catch((error) => ({ error })),
      ]);
    } catch (error) {
      setLessonEligibilityLoading(false);
      throw error;
    }
    const eligiblePairs = eligibilityResult.pairs || [];
    setLessonEligibleSubjects([...new Set(eligiblePairs.map((pair) => pair.subject))].sort());
    setLessonEligibilityError(eligibilityResult.error?.message || '');
    setLessonEligibilityLoading(false);
    const extractedTopics = papers.flatMap((paper) => [
      ...(paper.topics ?? []),
      ...(Array.isArray(paper.questions) ? paper.questions.flatMap((question) => [
        question.topic,
        ...(Array.isArray(question.topics) ? question.topics : []),
      ]) : []),
    ]).filter(Boolean);
    setStudent(studentContext);
    setStaffAccess(await getStaffStudentAccess({ studentId, subject: activeSubject, tutorId: profile.uid, subjectInstanceId: studentContext?.subjectInstanceId }));
    if (studentContext?.accessRole === 'co-owner') setStaffMembers(await getStaffMembersForAccess({ tutorId: profile.uid, subject: activeSubject }));
    else setStaffMembers([]);
    setExercises(exerciseRows.filter((item) => item.studentId === studentId && item.subject === activeSubject));
    const subjectLessons = lessonRows.filter((item) => item.studentId === studentId && item.subject === activeSubject);
    setLessons(subjectLessons);
    setPeerMarkedWork(await getCompletedPeerMarkingWorkForTutor({ tutorId: profile.uid, studentId, subject: activeSubject }));
    try {
      setTopicOptions(await getGlobalTopicOptionGroups({
        subject: activeSubject,
        grade: studentContext?.grade,
        studentIds: [studentId],
        extractedTopics,
      }));
    } catch (error) {
      setTopicOptions(emptyTopicGroups);
      setStatus(error.message || 'Could not load topics from the global subject-grade list.');
    }
  };

  useEffect(() => {
    load().catch((error) => setStatus(error.message || 'Could not load student details.'));
  }, [profile?.uid, studentId, subject, periodId]);

  const canManage = student?.accessRole === 'co-owner';
  const canMark = canManage || student?.accessRole === 'marker';
  const todayLocal = today();
  const regenerationEndDate = getSevenDayWindow(todayLocal).at(-1);
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
      await setStaffStudentAccess({ actorId: profile.uid, studentId, tutorId: selectedStaffId, subject, accessRole: selectedAccessRole });
      setStatus('Staff access updated.');
      setStaffAccess(await getStaffStudentAccess({ studentId, subject, tutorId: profile.uid, subjectInstanceId: student?.subjectInstanceId }));
      setSelectedStaffId('');
    } catch (error) {
      setStatus(error.message || 'Could not update staff access.');
    } finally {
      setSavingStaffAccess(false);
    }
  };

  const removeStaffAccess = async (accessId) => {
    try {
      await revokeStaffStudentAccess({ actorId: profile.uid, studentId, subject, accessId });
      setStaffAccess(await getStaffStudentAccess({ studentId, subject, tutorId: profile.uid, subjectInstanceId: student?.subjectInstanceId }));
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
    const confirmed = window.confirm(`Regenerate exercises for ${student.displayName || student.name || 'this student'} from today through ${regenerationEndDate}? Unsubmitted exercises in this window will be replaced, missing days can be filled, and submitted work will be kept.`);
    if (!confirmed) return;
    setIsRegenerating(true);
    setStatus('Starting exercise regeneration...');
    try {
      const result = await regenerateFutureUnsubmittedExercisesForTutor({
        tutorId: profile.uid,
        student: { uid: studentId, grade: student.grade, province: student.province, paymentCompleted: student.paymentCompleted },
        subject,
        onProgress: setStatus,
      });
      setStatus(result.generated
        ? `${result.reason} The student can now see the updated exercises.`
        : `No exercises were replaced: ${result.reason || 'The model returned no complete replacement set.'}`);
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
      const result = await deleteExerciseAssignmentForTutor({ tutorId: profile.uid, exerciseId: exercise.id });
      await deleteExerciseSubmissionFiles(result.storageUrls);
      setExercises((current) => current.filter((item) => item.id !== exercise.id));
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
      student: { uid: studentId, grade: student?.grade, province: student?.province, paymentCompleted: student?.paymentCompleted },
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
  };

  return (
    <AppShell title={student?.displayName || student?.name || 'Student'} subtitle={`${subject} learner details, reports, exercises, and lessons.`} role="tutor" user={profile} onLogout={logout}>
      {status || regenerationInProgress ? (
        <div role="status" aria-live="polite" className={`panel flex items-center gap-3 p-4 text-sm ${regenerationInProgress ? 'border border-lime-400/30 bg-lime-400/10 text-lime-300' : 'text-slate-300'}`}>
          {regenerationInProgress ? <LoaderCircle className="h-4 w-4 shrink-0 animate-spin text-lime-400" aria-hidden="true" /> : null}
          <span>{regenerationInProgress ? regenerationStatus?.message || status || 'Regenerating exercises...' : status}</span>
        </div>
      ) : null}
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
          <select className="input" value={selectedStaffId} onChange={(event) => setSelectedStaffId(event.target.value)}>
            <option value="">Choose tutor or teacher</option>
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
          {staffAccess.map((entry) => <div key={entry.id} className="flex items-center justify-between gap-3 py-3">
            <div><p className="font-medium text-slate-900">{entry.displayName}</p><p className="text-sm capitalize text-slate-500">{entry.accessRole}</p></div>
            <button type="button" className="btn-secondary inline-flex items-center gap-2" onClick={() => removeStaffAccess(entry.id)}><X className="h-4 w-4" aria-hidden="true" /> Remove</button>
          </div>)}
          {!staffAccess.length ? <p className="py-2 text-sm text-slate-500">No additional staff have access.</p> : null}
        </div>
      </section> : null}

      {canManage ? (
        <section className="panel space-y-4 p-5">
          <SectionHeader eyebrow="Lesson complete" title="Save completed topics" description="Choose topics from analyzed papers, add scores, and save the lesson for AI generation." />
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
              disabled={lessonEligibilityLoading || !lessonEligibleSubjects.length}
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
              <option value="">{topicOptions.all.length ? 'Choose topic' : 'No topics available'}</option>
              {topicOptions.extracted.length ? <optgroup label="Past paper extracted topics">{topicOptions.extracted.map((topic) => <option key={`paper-${topic}`}>{topic}</option>)}</optgroup> : null}
              {topicOptions.manual.length ? <optgroup label="Manual topic list">{topicOptions.manual.map((topic) => <option key={`manual-${topic}`}>{topic}</option>)}</optgroup> : null}
            </select>
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
          <button type="button" className="btn-primary" onClick={completeLesson} disabled={lessonEligibilityLoading || !lessonEligibleSubjects.includes(subject) || !lessonForm.topicUnderstandingScores.length || !lessonForm.topicReport.trim() || !hasValidScores(lessonForm.topicUnderstandingScores)}>Lesson completed</button>
        </section>
      ) : null}

      <section className="panel p-5">
        <SectionHeader eyebrow="Lessons" title="Tutor lessons" description="Planned and completed lessons for this student." />
        <div className="space-y-3">{lessons.map((lesson) => {
          const lessonStatus = lesson.status === 'planned' ? 'Planned' : lesson.status === 'missed' ? 'Missed' : lesson.status === 'cancelled' ? 'Cancelled' : 'Completed';
          const lessonTypeLabel = lesson.lessonType === 'inPerson' ? 'In-person' : 'Online (WhatsApp)';
          const content = <><div className="flex flex-wrap items-center justify-between gap-3"><p className="font-semibold text-slate-950">{(lesson.topics ?? [lesson.topic]).filter(Boolean).join(' | ')}</p><span className="rounded-full border border-slate-700 bg-slate-800 px-3 py-1 text-xs font-semibold text-slate-300">{lessonStatus}</span></div><p className="text-sm text-slate-500">{lesson.completedOn || lesson.lessonDate || 'No date'} • {lessonTypeLabel}</p></>;
          return student?.historicalAccessRole
            ? <div key={lesson.id} className="block rounded-lg bg-slate-50 p-4">{content}</div>
            : <Link key={lesson.id} to={`${basePath}/lessons/${lesson.id}`} className="block rounded-lg bg-slate-50 p-4">{content}</Link>;
        })}{!lessons.length ? <p className="text-sm text-slate-500">No lessons yet.</p> : null}</div>
      </section>
      </section></div> : null}

      <section className="panel space-y-4 p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <SectionHeader eyebrow="Exercises" title="Assigned exercises" description="Click an exercise to view details and paper links." />
            {canManage ? <button type="button" className="btn-secondary inline-flex items-center gap-2 disabled:cursor-not-allowed" onClick={regenerateExercises} disabled={regenerationInProgress}>
              {regenerationInProgress ? <><LoaderCircle className="h-4 w-4 animate-spin text-lime-400" aria-hidden="true" /> Regenerating...</> : 'Regenerate next 7 days'}
            </button> : null}
          </div>
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
          ))}{!exercises.length ? <p className="text-sm text-slate-400">No exercises yet.</p> : null}</div>
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
        {!peerMarkedWork.length ? <div className="panel p-5 text-sm text-slate-500">No completed peer-marking work is available yet.</div> : null}
      </section>
    </AppShell>
  );
};
