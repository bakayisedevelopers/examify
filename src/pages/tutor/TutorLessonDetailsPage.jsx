import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AppShell } from '../../components/common/AppShell';
import { SectionHeader } from '../../components/common/SectionHeader';
import { useAuth } from '../../hooks/useAuth';
import { DEFAULT_SUBJECT } from '../../lib/constants';
import { generateExercisePlanIfEligible, getLessonById, getQuestionPapers, getTutorAssignedStudentContexts, saveCompletedLesson, updateCompletedLesson } from '../../services/firestoreService';

export const TutorLessonDetailsPage = () => {
  const { lessonId } = useParams();
  const isNew = lessonId === 'new';
  const { profile, logout } = useAuth();
  const navigate = useNavigate();
  const [contexts, setContexts] = useState([]);
  const [studentId, setStudentId] = useState('');
  const [subject, setSubject] = useState(DEFAULT_SUBJECT);
  const [topicOptions, setTopicOptions] = useState([]);
  const [selectedTopic, setSelectedTopic] = useState('');
  const [topicUnderstandingScores, setTopicUnderstandingScores] = useState([]);
  const [topicReport, setTopicReport] = useState('');
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
      setTopicUnderstandingScores(row?.topicUnderstandingScores ?? (row?.topic ? [{ topic: row.topic, understandingLevel: row.understandingLevel ?? 5 }] : []));
      setTopicReport(row?.topicReport ?? row?.note ?? '');
    });
  }, [isNew, lessonId]);

  useEffect(() => {
    if (!subject) return;
    getQuestionPapers({ subject }).then((papers) => setTopicOptions([...new Set(papers.flatMap((paper) => paper.topics ?? []).filter(Boolean))].sort()));
  }, [subject]);

  const selectedStudent = useMemo(() => contexts.find((item) => item.studentId === studentId && item.subject === subject), [contexts, studentId, subject]);
  const allowedContexts = contexts;

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
    if (!studentId || !subject || !topicUnderstandingScores.length || !topicReport.trim()) {
      setStatus('Choose a student, topic, score, and report first.');
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
        topicUnderstandingScores: topicUnderstandingScores.map((entry) => ({ ...entry, topicReport })),
        topicReport,
        understandingLevel,
        studentName: selectedStudent?.displayName || selectedStudent?.name || 'Student',
      });
      await generateExercisePlanIfEligible({
        student: { uid: studentId, grade: selectedStudent?.grade, province: selectedStudent?.province, paymentCompleted: selectedStudent?.paymentCompleted },
        subject,
        mode: 'weekly',
        completedLesson: created,
        understandingLevel,
        onProgress: setStatus,
      });
      navigate(`/tutor/lessons/${created.id}`);
      return;
    }

    await updateCompletedLesson({ lessonId, topics, topicUnderstandingScores: topicUnderstandingScores.map((entry) => ({ ...entry, topicReport })), topicReport, understandingLevel });
    setStatus('Lesson updated.');
  };

  return (
    <AppShell title={isNew ? 'Add lesson' : 'Lesson details'} subtitle="Save completed topics and understanding scores for exercise generation." role="tutor" user={profile} onLogout={logout}>
      <Link to="/tutor/lessons" className="btn-secondary inline-flex w-fit">Back to lessons</Link>
      {status ? <div className="panel p-4 text-sm text-slate-700">{status}</div> : null}
      <section className="panel space-y-4 p-5">
        <SectionHeader eyebrow="Lesson" title={isNew ? 'Create lesson' : 'Edit lesson'} description="Topics come from analyzed question papers." />
        <select className="input" value={`${studentId}|${subject}`} onChange={(event) => handleContextChange(event.target.value)} disabled={!isNew}>
          <option value="|">Choose assigned student and subject</option>
          {allowedContexts.map((context) => <option key={`${context.studentId}-${context.subject}`} value={`${context.studentId}|${context.subject}`}>{context.displayName || context.name || context.studentId} • {context.subject}</option>)}
        </select>
        <div className="grid gap-3 lg:grid-cols-[1fr_auto]">
          <select className="input" value={selectedTopic} onChange={(event) => setSelectedTopic(event.target.value)} disabled={!topicOptions.length}><option value="">{topicOptions.length ? 'Choose analyzed topic' : 'No analyzed topics available'}</option>{topicOptions.map((topic) => <option key={topic}>{topic}</option>)}</select>
          <button type="button" className="btn-secondary" onClick={addTopic} disabled={!selectedTopic}>Add topic</button>
        </div>
        {topicUnderstandingScores.map((entry) => <div key={entry.topic} className="grid gap-3 rounded-2xl bg-slate-50 p-3 md:grid-cols-[1fr_160px_auto] md:items-center"><p className="font-semibold text-slate-900">{entry.topic}</p><input type="number" min="0" max="10" className="input" value={entry.understandingLevel} onChange={(event) => updateScore(entry.topic, event.target.value)} /><button type="button" className="btn-secondary" onClick={() => setTopicUnderstandingScores((current) => current.filter((item) => item.topic !== entry.topic))}>Remove</button></div>)}
        <textarea className="input min-h-32" value={topicReport} onChange={(event) => setTopicReport(event.target.value)} placeholder="Lesson report" />
        <button type="button" className="btn-primary" onClick={saveLesson}>{isNew ? 'Create lesson' : 'Save lesson'}</button>
      </section>
    </AppShell>
  );
};
