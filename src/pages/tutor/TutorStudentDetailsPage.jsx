import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
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
  regenerateFutureUnsubmittedExercisesForTutor,
  saveCompletedLesson,
  saveTutorReport,
} from '../../services/firestoreService';
import { DEFAULT_SUBJECT } from '../../lib/constants';
import { getTopicOptionGroups } from '../../data/topicCatalog';

const today = () => new Date().toISOString().slice(0, 10);
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
  const [lessons, setLessons] = useState([]);
  const [topicOptions, setTopicOptions] = useState(emptyTopicGroups);
  const [reportNote, setReportNote] = useState('');
  const [lessonForm, setLessonForm] = useState(emptyLessonForm);
  const [status, setStatus] = useState('');
  const [isRegenerating, setIsRegenerating] = useState(false);

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
    setTopicOptions(getTopicOptionGroups({ extractedTopics, subject, grade: studentContext?.grade }));
  };

  useEffect(() => {
    load().catch((error) => setStatus(error.message || 'Could not load student details.'));
  }, [profile?.uid, studentId, subject]);

  const latestReport = student?.latestReportsBySubject?.[subject] || reports[0]?.note || (subject === DEFAULT_SUBJECT ? student?.latestReport : '') || '';
  const hasInitialReport = Boolean(latestReport.trim());
  const todayLocal = today();
  const regenerableExercises = exercises.filter((exercise) =>
    String(exercise.assignmentDate ?? '') >= todayLocal
    && !exercise.submittedImageUrl
    && exercise.submitted !== 'Yes'
    && exercise.submissionStatus !== 'submitted'
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

  const regenerateExercises = async () => {
    if (isRegenerating || !student || !regenerableExercises.length) return;
    const confirmed = window.confirm(`Regenerate ${regenerableExercises.length} future unsubmitted exercise${regenerableExercises.length === 1 ? '' : 's'} for ${student.displayName || student.name || 'this student'}? Past exercises and submitted work will be kept.`);
    if (!confirmed) return;
    setIsRegenerating(true);
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

  return (
    <AppShell title={student?.displayName || student?.name || 'Student'} subtitle={`${subject} learner details, reports, exercises, and lessons.`} role="tutor" user={profile} onLogout={logout}>
      {status ? <div className="panel p-4 text-sm text-slate-700">{status}</div> : null}
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
            <button type="button" className="btn-secondary" onClick={regenerateExercises} disabled={!regenerableExercises.length || isRegenerating}>
              {isRegenerating ? <><span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-r-transparent" aria-hidden="true" /> Regenerating...</> : 'Regenerate future exercises'}
            </button>
          </div>
          <div className="space-y-3">{exercises.map((exercise) => <button key={exercise.id} type="button" onClick={() => navigate(`/tutor/exercises/${exercise.id}`)} className="block w-full rounded-2xl bg-slate-50 p-4 text-left"><p className="font-semibold text-slate-950">{exercise.title}</p><p className="text-sm text-slate-500">{exercise.subject} • {exercise.assignmentDate}{exercise.submittedImageUrl || exercise.submitted === 'Yes' ? ' • Submitted' : ''}</p></button>)}{!exercises.length ? <p className="text-sm text-slate-500">No exercises yet.</p> : null}</div>
        </div>
        <div className="panel p-5"><SectionHeader eyebrow="Lessons" title="Tutor lessons" description="Planned and completed lessons for this student." /><div className="space-y-3">{lessons.map((lesson) => <Link key={lesson.id} to={`/tutor/lessons/${lesson.id}`} className="block rounded-2xl bg-slate-50 p-4"><div className="flex flex-wrap items-center justify-between gap-3"><p className="font-semibold text-slate-950">{(lesson.topics ?? [lesson.topic]).filter(Boolean).join(' | ')}</p><span className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-slate-600">{lesson.status === 'planned' ? 'Planned' : 'Completed'}</span></div><p className="text-sm text-slate-500">{lesson.completedOn || lesson.lessonDate || 'No date'} • {lesson.lessonType === 'inPerson' ? 'In-person' : 'Online'}</p></Link>)}{!lessons.length ? <p className="text-sm text-slate-500">No lessons yet.</p> : null}</div></div>
      </section>
    </AppShell>
  );
};
