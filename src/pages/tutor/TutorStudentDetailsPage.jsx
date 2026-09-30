import { useEffect, useState } from 'react';
import { FileText, Trash2 } from 'lucide-react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { LoaderCircle } from 'lucide-react';
import { AppShell } from '../../components/common/AppShell';
import { SectionHeader } from '../../components/common/SectionHeader';
import { useAuth } from '../../hooks/useAuth';
import {
  generateExercisePlanIfEligible,
  getQuestionPapers,
  getTutorAssignedStudentContexts,
  getTutorExercisesForAssignedStudents,
  getTutorLessonsForAssignedStudents,
  getTutorReportsForAssignedStudents,
  getCompletedPeerMarkingWorkForTutor,
  getStudentTopicScoresForTutor,
  deleteExerciseAssignmentForTutor,
  regenerateFutureUnsubmittedExercisesForTutor,
  saveCompletedLesson,
  saveTutorReport,
  subscribeToExerciseGenerationStatus,
} from '../../services/firestoreService';
import { DEFAULT_SUBJECT } from '../../lib/constants';
import { getTopicOptionGroups } from '../../data/topicCatalog';
import { deleteExerciseSubmissionFiles } from '../../services/storageService';
import { getSevenDayWindow } from '../../services/exerciseGenerationPlan';
import { TutorTopicScoreEditor } from '../../components/tutor/TutorTopicScoreEditor';

const today = () => {
  const date = new Date();
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
};
const emptyLessonForm = { selectedTopic: '', topicUnderstandingScores: [], topicReport: '', lessonDate: today(), lessonType: 'online' };
const emptyTopicGroups = { extracted: [], manual: [], all: [] };
const hasValidScores = (entries = []) =>
  entries.length > 0 && entries.every((entry) => {
    const score = Number(entry.understandingLevel);
    return Number.isFinite(score) && score >= 0 && score <= 10;
  });

export const TutorStudentDetailsPage = () => {
  const { studentId } = useParams();
  const [searchParams] = useSearchParams();
  const subject = searchParams.get('subject') || DEFAULT_SUBJECT;
  const { profile, logout } = useAuth();
  const navigate = useNavigate();
  const [student, setStudent] = useState(null);
  const [reports, setReports] = useState([]);
  const [exercises, setExercises] = useState([]);
  const [peerMarkedWork, setPeerMarkedWork] = useState([]);
  const [topicScores, setTopicScores] = useState({});
  const [lessons, setLessons] = useState([]);
  const [topicOptions, setTopicOptions] = useState(emptyTopicGroups);
  const [reportNote, setReportNote] = useState('');
  const [lessonForm, setLessonForm] = useState(emptyLessonForm);
  const [status, setStatus] = useState('');
  const [isRegenerating, setIsRegenerating] = useState(false);
  const [deletingExerciseId, setDeletingExerciseId] = useState('');
  const [regenerationStatus, setRegenerationStatus] = useState(null);

  useEffect(() => {
    if (!studentId || !profile?.uid) return undefined;
    return subscribeToExerciseGenerationStatus(studentId, subject, setRegenerationStatus);
  }, [profile?.uid, studentId, subject]);

  const load = async () => {
    if (!profile?.uid) return;
    const [contexts, reportRows, exerciseRows, lessonRows] = await Promise.all([
      getTutorAssignedStudentContexts(profile.uid),
      getTutorReportsForAssignedStudents(profile.uid),
      getTutorExercisesForAssignedStudents(profile.uid),
      getTutorLessonsForAssignedStudents(profile.uid),
    ]);
    const studentContext = contexts.find((item) => item.studentId === studentId && item.subject === subject) ?? null;
    const papers = await getQuestionPapers({ subject, grade: studentContext?.grade, region: studentContext?.province });
    const extractedTopics = papers.flatMap((paper) => paper.topics ?? []).filter(Boolean);
    setStudent(studentContext);
    setReports(reportRows.filter((item) => item.studentId === studentId && item.subject === subject));
    setExercises(exerciseRows.filter((item) => item.studentId === studentId && item.subject === subject));
    setLessons(lessonRows.filter((item) => item.studentId === studentId && item.subject === subject));
    setPeerMarkedWork(await getCompletedPeerMarkingWorkForTutor({ tutorId: profile.uid, studentId, subject }));
    setTopicScores(await getStudentTopicScoresForTutor({ tutorId: profile.uid, studentId, subject }));
    setTopicOptions(getTopicOptionGroups({ extractedTopics, subject, grade: studentContext?.grade }));
  };

  useEffect(() => {
    load().catch((error) => setStatus(error.message || 'Could not load student details.'));
  }, [profile?.uid, studentId, subject]);

  const latestReport = student?.latestReportsBySubject?.[subject] || reports[0]?.note || (subject === DEFAULT_SUBJECT ? student?.latestReport : '') || '';
  const hasInitialReport = Boolean(latestReport.trim());
  const todayLocal = today();
  const regenerationEndDate = getSevenDayWindow(todayLocal).at(-1);
  const regenerableExercises = exercises.filter((exercise) =>
    String(exercise.assignmentDate ?? '') >= todayLocal
    && String(exercise.assignmentDate ?? '') <= regenerationEndDate
    && !exercise.submittedImageUrl
    && exercise.submitted !== 'Yes'
    && exercise.submissionStatus !== 'submitted'
  );
  const regenerationInProgress = isRegenerating || (
    regenerationStatus?.status === 'processing'
    && Date.now() < Number(regenerationStatus.expiresAtMs ?? 0)
  );

  const addTopic = () => {
    if (!lessonForm.selectedTopic || lessonForm.topicUnderstandingScores.some((entry) => entry.topic === lessonForm.selectedTopic)) return;
    setLessonForm((current) => ({ ...current, selectedTopic: '', topicUnderstandingScores: [...current.topicUnderstandingScores, { topic: current.selectedTopic, understandingLevel: 5 }] }));
  };
  const updateScore = (topic, value) => setLessonForm((current) => ({ ...current, topicUnderstandingScores: current.topicUnderstandingScores.map((entry) => entry.topic === topic ? { ...entry, understandingLevel: Number(value) } : entry) }));
  const removeTopic = (topic) => setLessonForm((current) => ({ ...current, topicUnderstandingScores: current.topicUnderstandingScores.filter((entry) => entry.topic !== topic) }));

  const saveInitialReport = async () => {
    if (!reportNote.trim()) return;
    await saveTutorReport({ tutorId: profile.uid, studentId, subject, reportType: 'initial', note: reportNote, studentName: student?.displayName || student?.name || 'Student' });
    setReportNote('');
    setStatus('Initial report saved.');
    await load();
  };

  const regenerateExercises = async () => {
    if (isRegenerating || !student || !regenerableExercises.length) return;
    const confirmed = window.confirm(`Regenerate uncompleted exercises from today through ${regenerationEndDate} for ${student.displayName || student.name || 'this student'}? Completed exercises and exercises outside this 7-day window will be kept.`);
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

  const completeLesson = async () => {
    if (!lessonForm.topicUnderstandingScores.length || !lessonForm.topicReport.trim() || !lessonForm.lessonDate || !lessonForm.lessonType || !hasValidScores(lessonForm.topicUnderstandingScores)) {
      setStatus('Choose at least one topic, date, lesson type, score from 0 to 10, and enter the lesson report.');
      return;
    }
    const topics = lessonForm.topicUnderstandingScores.map((entry) => entry.topic);
    const understandingLevel = Math.round(lessonForm.topicUnderstandingScores.reduce((sum, entry) => sum + Number(entry.understandingLevel ?? 5), 0) / topics.length);
    const topicScoresText = lessonForm.topicUnderstandingScores.map((entry) => `${entry.topic}: ${entry.understandingLevel}/10`).join('\n');
    const report = [`--- ${topics.join(' | ')} ---`, 'Topics completed:', topicScoresText, 'Tutor report:', lessonForm.topicReport, `Date: ${new Date().toLocaleString()}`].join('\n');

    await saveTutorReport({ tutorId: profile.uid, studentId, subject, reportType: 'lesson', note: report, studentName: student?.displayName || student?.name || 'Student' });
    const lesson = await saveCompletedLesson({
      tutorId: profile.uid,
      studentId,
      subject,
      topic: topics[0],
      topics,
      topicUnderstandingScores: lessonForm.topicUnderstandingScores.map((entry) => ({ ...entry, topicReport: lessonForm.topicReport })),
      topicReport: lessonForm.topicReport,
      understandingLevel,
      studentName: student?.displayName || student?.name || 'Student',
      lessonDate: lessonForm.lessonDate,
      lessonType: lessonForm.lessonType,
      status: 'completed',
    });
    const generation = await generateExercisePlanIfEligible({
      student: { uid: studentId, grade: student?.grade, province: student?.province, paymentCompleted: student?.paymentCompleted },
      subject,
      mode: 'weekly',
      completedLesson: lesson,
      understandingLevel,
      onProgress: setStatus,
    });
    setLessonForm(emptyLessonForm);
    setStatus(generation.generated ? 'Lesson completed and exercises generated.' : 'Lesson completed and saved for future AI generation.');
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
      <Link to="/tutor" className="btn-secondary inline-flex w-fit">Back to students</Link>

      <section className="panel p-5">
        <h2 className="text-xl font-semibold text-slate-950">Student details</h2>
        <p className="mt-2 text-sm text-slate-500">{student?.grade || '?'} • {student?.province || '?'} • {subject} • {student?.paymentCompleted ? 'Paid' : 'Unpaid'}</p>
        <p className="mt-4 whitespace-pre-wrap rounded-2xl bg-slate-50 p-4 text-sm text-slate-600">{latestReport || 'No initial report for this subject yet.'}</p>
      </section>

      {!hasInitialReport ? (
        <section className="panel space-y-4 p-5">
          <SectionHeader eyebrow="Initial report" title="Create subject report" description="This unlocks subject-specific lesson completion and AI context." />
          <textarea className="input min-h-36" value={reportNote} onChange={(event) => setReportNote(event.target.value)} placeholder="Initial report for this student and subject" />
          <button type="button" className="btn-primary" onClick={saveInitialReport} disabled={!reportNote.trim()}>Save initial report</button>
        </section>
      ) : (
        <section className="panel space-y-4 p-5">
          <SectionHeader eyebrow="Lesson complete" title="Save completed topics" description="Choose topics from analyzed papers, add scores, and save the lesson for AI generation." />
          <div className="grid gap-3 md:grid-cols-2">
            <label className="grid gap-2 text-sm font-semibold text-slate-700">Lesson date<input type="date" className="input" value={lessonForm.lessonDate} onChange={(event) => setLessonForm((current) => ({ ...current, lessonDate: event.target.value }))} /></label>
            <label className="grid gap-2 text-sm font-semibold text-slate-700">Lesson type<select className="input" value={lessonForm.lessonType} onChange={(event) => setLessonForm((current) => ({ ...current, lessonType: event.target.value }))}><option value="online">Online</option><option value="inPerson">In-person</option></select></label>
          </div>
          <div className="grid gap-3 lg:grid-cols-[1fr_auto]">
            <select className="input" value={lessonForm.selectedTopic} onChange={(event) => setLessonForm((current) => ({ ...current, selectedTopic: event.target.value }))} disabled={!topicOptions.all.length}>
              <option value="">{topicOptions.all.length ? 'Choose topic' : 'No topics available'}</option>
              {topicOptions.extracted.length ? <optgroup label="Past paper extracted topics">{topicOptions.extracted.map((topic) => <option key={`paper-${topic}`}>{topic}</option>)}</optgroup> : null}
              {topicOptions.manual.length ? <optgroup label="Manual topic list">{topicOptions.manual.map((topic) => <option key={`manual-${topic}`}>{topic}</option>)}</optgroup> : null}
            </select>
            <button type="button" className="btn-secondary" onClick={addTopic} disabled={!lessonForm.selectedTopic}>Add topic</button>
          </div>
          {lessonForm.topicUnderstandingScores.map((entry) => (
            <div key={entry.topic} className="grid gap-3 rounded-2xl bg-slate-50 p-3 md:grid-cols-[1fr_160px_auto] md:items-center">
              <p className="font-semibold text-slate-900">{entry.topic}</p>
              <input type="number" min="0" max="10" className="input" value={entry.understandingLevel} onChange={(event) => updateScore(entry.topic, event.target.value)} />
              <button type="button" className="btn-secondary" onClick={() => removeTopic(entry.topic)}>Remove</button>
            </div>
          ))}
          <textarea className="input min-h-32" value={lessonForm.topicReport} onChange={(event) => setLessonForm((current) => ({ ...current, topicReport: event.target.value }))} placeholder="Lesson report" />
          <button type="button" className="btn-primary" onClick={completeLesson} disabled={!lessonForm.topicUnderstandingScores.length || !lessonForm.topicReport.trim() || !hasValidScores(lessonForm.topicUnderstandingScores)}>Lesson completed</button>
        </section>
      )}

      <section className="grid gap-6 xl:grid-cols-2">
        <div className="panel space-y-4 p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <SectionHeader eyebrow="Exercises" title="Assigned exercises" description="Click an exercise to view details and paper links." />
            <button type="button" className="btn-secondary inline-flex items-center gap-2 disabled:cursor-not-allowed" onClick={regenerateExercises} disabled={!regenerableExercises.length || regenerationInProgress}>
              {regenerationInProgress ? <><LoaderCircle className="h-4 w-4 animate-spin text-lime-400" aria-hidden="true" /> Regenerating...</> : 'Regenerate next 7 days'}
            </button>
          </div>
          <div className="space-y-3">{exercises.map((exercise) => (
            <div key={exercise.id} className="flex items-center gap-3 rounded-lg bg-slate-800/60 p-3">
              <button type="button" onClick={() => navigate(`/tutor/exercises/${exercise.id}`)} className="min-w-0 flex-1 text-left">
                <p className="font-semibold text-slate-100">{exercise.title}</p>
                <p className="text-sm text-slate-400">{exercise.subject} • {exercise.assignmentDate}{exercise.submittedImageUrl || exercise.submitted === 'Yes' ? ' • Submitted' : ''}</p>
              </button>
              <button type="button" className="btn-secondary inline-flex items-center gap-2 text-rose-300" onClick={() => removeExercise(exercise)} disabled={deletingExerciseId === exercise.id} aria-label={`Delete ${exercise.title}`} title="Delete exercise">
                <Trash2 className="h-4 w-4" aria-hidden="true" /> {deletingExerciseId === exercise.id ? 'Deleting...' : 'Delete'}
              </button>
            </div>
          ))}{!exercises.length ? <p className="text-sm text-slate-400">No exercises yet.</p> : null}</div>
        </div>
        <div className="panel p-5"><SectionHeader eyebrow="Lessons" title="Tutor lessons" description="Planned and completed lessons for this student." /><div className="space-y-3">{lessons.map((lesson) => <Link key={lesson.id} to={`/tutor/lessons/${lesson.id}`} className="block rounded-2xl bg-slate-50 p-4"><div className="flex flex-wrap items-center justify-between gap-3"><p className="font-semibold text-slate-950">{(lesson.topics ?? [lesson.topic]).filter(Boolean).join(' | ')}</p><span className="rounded-full bg-slate-800 border border-slate-700 px-3 py-1 text-xs font-semibold text-slate-300">{lesson.status === 'planned' ? 'Planned' : 'Completed'}</span></div><p className="text-sm text-slate-500">{lesson.completedOn || lesson.lessonDate || 'No date'} • {lesson.lessonType === 'inPerson' ? 'In-person' : 'Online'}</p></Link>)}{!lessons.length ? <p className="text-sm text-slate-500">No lessons yet.</p> : null}</div></div>
      </section>

      <section className="space-y-4">
        <SectionHeader eyebrow="Peer marking" title="Work this student marked" description="Review the original student work, your student's whiteboard annotations, and the exact paper question they marked." />
        {peerMarkedWork.map((assignment) => (
          <article key={assignment.id} className="panel space-y-4 p-5">
            <div>
              <p className="font-semibold text-slate-900">{assignment.title || 'Peer-marked exercise'} · {assignment.assignmentDate}</p>
              <p className="mt-1 text-sm text-slate-500">{assignment.topic || subject} · Marking completed</p>
            </div>
            {Array.isArray(assignment.questionLinks) && assignment.questionLinks.length ? (
              <div className="flex flex-wrap gap-2">
                {assignment.questionLinks.map((link, index) => (
                  <Link key={`${link.paperId}-${link.questionReference}-${index}`} className="btn-secondary inline-flex items-center gap-2" to={`/tutor/papers/${link.paperId}?page=${Math.max(1, Number(link.pageNumber) || 1)}&question=${encodeURIComponent(link.questionReference || '')}`}>
                    <FileText className="h-4 w-4" aria-hidden="true" />
                    {link.questionReference ? `Q${link.questionReference}` : 'Question'} · page {link.pageNumber || 1}
                  </Link>
                ))}
              </div>
            ) : assignment.paperIds?.[0] ? (
              <Link className="btn-secondary inline-flex items-center gap-2" to={`/tutor/papers/${assignment.paperIds[0]}?page=1`}><FileText className="h-4 w-4" aria-hidden="true" />Open question paper</Link>
            ) : null}
            <div className="space-y-2">
              <p className="text-sm font-medium text-slate-600">Manual topic understanding scores</p>
              {[...new Set(String(assignment.topic || subject).split('|').map((topic) => topic.trim()).filter(Boolean))].map((topic) => (
                <TutorTopicScoreEditor
                  key={topic}
                  tutorId={profile?.uid}
                  studentId={studentId}
                  subject={assignment.subject || subject}
                  topic={topic}
                  value={topicScores[topic]}
                  onSaved={(savedTopic, score) => setTopicScores((current) => ({ ...current, [savedTopic]: score }))}
                />
              ))}
            </div>
            <div className="grid gap-4 lg:grid-cols-2">
              <div><p className="mb-2 text-sm font-medium text-slate-600">Other student's submitted work</p><a href={assignment.submittedImageUrl} target="_blank" rel="noreferrer"><img src={assignment.submittedImageUrl} alt="Original work marked by the tutor's student" className="max-h-[620px] w-full rounded-md bg-slate-100 object-contain" /></a></div>
              {assignment.reviewImageUrl ? <div><p className="mb-2 text-sm font-medium text-slate-600">{student?.displayName || student?.name || 'Student'}'s whiteboard marking</p><a href={assignment.reviewImageUrl} target="_blank" rel="noreferrer"><img src={assignment.reviewImageUrl} alt="Student's completed whiteboard annotations" className="max-h-[620px] w-full rounded-md bg-slate-100 object-contain" /></a></div> : null}
            </div>
          </article>
        ))}
        {!peerMarkedWork.length ? <div className="panel p-5 text-sm text-slate-500">No completed peer-marking work is available yet.</div> : null}
      </section>
    </AppShell>
  );
};
