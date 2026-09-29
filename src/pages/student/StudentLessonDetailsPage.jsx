import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { AppShell } from '../../components/common/AppShell';
import { useAuth } from '../../hooks/useAuth';
import { getLessonById } from '../../services/firestoreService';

export const StudentLessonDetailsPage = () => {
  const { lessonId } = useParams();
  const { profile, logout } = useAuth();
  const [lesson, setLesson] = useState(null);

  useEffect(() => { getLessonById(lessonId).then(setLesson); }, [lessonId]);

  return (
    <AppShell title="Lesson details" subtitle={lesson ? `${lesson.subject} • ${lesson.completedOn || 'No date'}` : 'Loading lesson'} role="student" user={profile} onLogout={logout}>
      <Link to="/student/lessons" className="btn-secondary inline-flex w-fit">Back to lessons</Link>
      {lesson ? <section className="panel p-5"><h2 className="text-xl font-semibold text-slate-950">{(lesson.topics ?? [lesson.topic]).filter(Boolean).join(' | ')}</h2><div className="mt-4 space-y-2 text-sm text-slate-600">{(lesson.topicUnderstandingScores ?? []).map((entry) => <p key={entry.topic}>{entry.topic}: {entry.understandingLevel}/10</p>)}</div><p className="mt-4 whitespace-pre-wrap rounded-2xl bg-slate-50 p-4 text-sm text-slate-700">{lesson.topicReport || lesson.note}</p></section> : null}
    </AppShell>
  );
};
