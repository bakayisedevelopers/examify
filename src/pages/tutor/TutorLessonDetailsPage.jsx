import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AppShell } from '../../components/common/AppShell';
import { SectionHeader } from '../../components/common/SectionHeader';
import { useAuth } from '../../hooks/useAuth';
import { DEFAULT_SUBJECT } from '../../lib/constants';
import { getTopicOptionGroups } from '../../data/topicCatalog';
import { deleteLesson, generateExercisePlanIfEligible, getLessonById, getQuestionPapers, getTutorAssignedStudentContexts, saveCompletedLesson, updateCompletedLesson } from '../../services/firestoreService';
import { useEffectiveRole } from '../../utils/effectiveRole';

const today = () => new Date().toISOString().slice(0, 10);
const emptyTopicGroups = { extracted: [], manual: [], all: [] };
const hasValidScores = (entries = []) =>
  entries.length > 0 && entries.every((entry) => {
    const score = Number(entry.understandingLevel);
    return Number.isFinite(score) && score >= 0 && score <= 10;
  });

export const TutorLessonDetailsPage = () => {
  const { lessonId } = useParams();
  const isNew = lessonId === 'new';
  const { profile, logout } = useAuth();
  const navigate = useNavigate();
  const { role, basePath } = useEffectiveRole();
  const [contexts, setContexts] = useState([]);
  const [studentId, setStudentId] = useState('');
  const [subject, setSubject] = useState(DEFAULT_SUBJECT);
  const [topicOptions, setTopicOptions] = useState(emptyTopicGroups);
  const [selectedTopic, setSelectedTopic] = useState('');
  const [topicUnderstandingScores, setTopicUnderstandingScores] = useState([]);
  const [topicReport, setTopicReport] = useState('');
  const [lessonDate, setLessonDate] = useState(today());
  const [lessonType, setLessonType] = useState('online');
  const [lessonStatus, setLessonStatus] = useState('planned');
  const [status, setStatus] = useState('');

  useEffect(() => {
    if (!profile?.uid) return;
    getTutorAssignedStudentContexts(profile.uid).then(setContexts);
  }, [profile?.uid]);

  useEffect(() => {
    if (isNew) return;
    getLessonById(lessonId).then((row) => {
      setStudentId(row?.studentId ?? '');
      setSubject(row?.subject ?? DEFAULT_SUBJECT);
      setTopicUnderstandingScores(row?.topicUnderstandingScores?.length ? row.topicUnderstandingScores : (row?.topics ?? (row?.topic ? [row.topic] : [])).map((topic) => ({ topic, understandingLevel: row?.understandingLevel ?? 5 })));
      setTopicReport(row?.topicReport ?? row?.note ?? '');
      setLessonDate(row?.lessonDate || row?.completedOn || today());
      setLessonType(row?.lessonType ?? 'online');
      setLessonStatus(row?.status ?? 'completed');
    });
  }, [isNew, lessonId]);

  const selectedStudent = useMemo(() => contexts.find((item) => item.studentId === studentId && item.subject === subject), [contexts, studentId, subject]);
  const allowedContexts = contexts;

  useEffect(() => {
    if (!subject) return;
    const grade = selectedStudent?.grade;
    const region = selectedStudent?.province;
    getQuestionPapers({ subject, grade, region }).then((papers) => {
      const extractedTopics = papers.flatMap((paper) => paper.topics ?? []).filter(Boolean);
      setTopicOptions(getTopicOptionGroups({ extractedTopics, subject, grade }));
    });
  }, [subject, selectedStudent?.grade, selectedStudent?.province]);

  const handleContextChange = (value) => {
    const [nextStudentId, nextSubject] = value.split('|');
    setStudentId(nextStudentId);
    setSubject(nextSubject || DEFAULT_SUBJECT);
    setTopicUnderstandingScores([]);
  };
  const addTopic = () => {
    if (!selectedTopic || topicUnderstandingScores.some((entry) => entry.topic === selectedTopic)) return;
    setTopicUnderstandingScores((current) => [...current, { topic: selectedTopic, understandingLevel: 5 }]);
    setSelectedTopic('');
  };
  const updateScore = (topic, value) => setTopicUnderstandingScores((current) => current.map((entry) => entry.topic === topic ? { ...entry, understandingLevel: Number(value) } : entry));

  const saveLesson = async () => {
    if (!studentId || !subject || !topicUnderstandingScores.length || !lessonDate || !lessonType) {
      setStatus('Choose a student, topic, date, and lesson type first.');
      return;
    }
    const completingLesson = !isNew && lessonStatus !== 'completed';
    if ((!isNew || completingLesson) && (!topicReport.trim() || !hasValidScores(topicUnderstandingScores))) {
      setStatus('Add an understanding score from 0 to 10 and a lesson report before marking the lesson complete.');
      return;
    }
    const topics = topicUnderstandingScores.map((entry) => entry.topic);
    const understandingLevel = Math.round(topicUnderstandingScores.reduce((sum, entry) => sum + Number(entry.understandingLevel ?? 5), 0) / topics.length);

    if (isNew) {
      const created = await saveCompletedLesson({
        tutorId: profile.uid,
        studentId,
        subject,
        topic: topics[0],
        topics,
        topicUnderstandingScores: [],
        topicReport: '',
        understandingLevel: null,
        studentName: selectedStudent?.displayName || selectedStudent?.name || 'Student',
        lessonDate,
        lessonType,
        status: 'planned',
      });
      navigate(`/tutor/lessons/${created.id}`);
      return;
    }

    const updated = await updateCompletedLesson({
      lessonId,
      topics,
      topicUnderstandingScores: topicUnderstandingScores.map((entry) => ({ ...entry, topicReport })),
      topicReport,
      understandingLevel,
      lessonDate,
      lessonType,
      status: 'completed',
    });
    await generateExercisePlanIfEligible({
      student: { uid: studentId, grade: selectedStudent?.grade, province: selectedStudent?.province, paymentCompleted: selectedStudent?.paymentCompleted },
      subject,
      mode: 'weekly',
      completedLesson: updated,
      understandingLevel,
      onProgress: setStatus,
    });
    setLessonStatus('completed');
    setStatus('Lesson marked complete.');
  };

  const handleDeleteLesson = async () => {
    if (isNew || !lessonId) return;
    if (!window.confirm('Delete this lesson? This cannot be undone.')) return;
    await deleteLesson(lessonId);
    navigate(`${basePath}/lessons`);
  };

  return (
    <AppShell title={isNew ? 'Add lesson' : 'Lesson details'} subtitle="Save completed topics and understanding scores for exercise generation." role={role} user={profile} onLogout={logout}>
      <Link to={`${basePath}/lessons`} className="btn-secondary inline-flex w-fit">Back to lessons</Link>
      {status ? <div className="panel p-4 text-sm text-slate-700">{status}</div> : null}
      <section className="panel space-y-4 p-5">
        <SectionHeader eyebrow="Lesson" title={isNew ? 'Create lesson' : 'Edit lesson'} description="Topics come from analyzed question papers." />
        <select className="input" value={`${studentId}|${subject}`} onChange={(event) => handleContextChange(event.target.value)} disabled={!isNew}>
          <option value="|">Choose assigned student and subject</option>
          {allowedContexts.map((context) => <option key={`${context.studentId}-${context.subject}`} value={`${context.studentId}|${context.subject}`}>{context.displayName || context.name || context.studentId} • {context.subject}</option>)}
        </select>
        <div className="grid gap-3 md:grid-cols-2">
          <label className="grid gap-2 text-sm font-semibold text-slate-700">Lesson date<input type="date" className="input" value={lessonDate} onChange={(event) => setLessonDate(event.target.value)} /></label>
          <label className="grid gap-2 text-sm font-semibold text-slate-700">Lesson type<select className="input" value={lessonType} onChange={(event) => setLessonType(event.target.value)}><option value="online">Online</option><option value="inPerson">In-person</option></select></label>
        </div>
        <div className="grid gap-3 lg:grid-cols-[1fr_auto]">
          <select className="input" value={selectedTopic} onChange={(event) => setSelectedTopic(event.target.value)} disabled={!topicOptions.all.length}>
            <option value="">{topicOptions.all.length ? 'Choose topic' : 'No topics available'}</option>
            {topicOptions.extracted.length ? <optgroup label="Past paper extracted topics">{topicOptions.extracted.map((topic) => <option key={`paper-${topic}`}>{topic}</option>)}</optgroup> : null}
            {topicOptions.manual.length ? <optgroup label="Manual topic list">{topicOptions.manual.map((topic) => <option key={`manual-${topic}`}>{topic}</option>)}</optgroup> : null}
          </select>
          <button type="button" className="btn-secondary" onClick={addTopic} disabled={!selectedTopic}>Add topic</button>
        </div>
        {topicUnderstandingScores.map((entry) => <div key={entry.topic} className={`grid gap-3 rounded-2xl bg-slate-50 p-3 ${isNew ? 'md:grid-cols-[1fr_auto]' : 'md:grid-cols-[1fr_160px_auto]'} md:items-center`}><p className="font-semibold text-slate-900">{entry.topic}</p>{!isNew ? <input type="number" min="0" max="10" className="input" value={entry.understandingLevel} onChange={(event) => updateScore(entry.topic, event.target.value)} /> : null}<button type="button" className="btn-secondary" onClick={() => setTopicUnderstandingScores((current) => current.filter((item) => item.topic !== entry.topic))}>Remove</button></div>)}
        {!isNew ? <textarea className="input min-h-32" value={topicReport} onChange={(event) => setTopicReport(event.target.value)} placeholder="Lesson report after completing the lesson" /> : null}
        <div className="flex flex-wrap gap-3">
          <button type="button" className="btn-primary" onClick={saveLesson}>{isNew ? 'Create lesson' : 'Mark lesson complete'}</button>
          {!isNew ? <button type="button" className="btn-secondary text-rose-700 hover:text-rose-800" onClick={handleDeleteLesson}>Delete lesson</button> : null}
        </div>
      </section>
    </AppShell>
  );
};
