import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AppShell } from '../../components/common/AppShell';
import { SectionHeader } from '../../components/common/SectionHeader';
import { useAuth } from '../../hooks/useAuth';
import { getLessonsForStudent } from '../../services/firestoreService';

export const StudentLessonsPage = () => {
  const { profile, logout } = useAuth();
  const [lessons, setLessons] = useState([]);

  useEffect(() => {
    if (!profile?.uid) return;
    getLessonsForStudent(profile.uid).then(setLessons);
  }, [profile?.uid]);

  return (
    <AppShell title="Lessons" subtitle="Completed and upcoming lesson context from your tutors." role="student" user={profile} onLogout={logout}>
      <SectionHeader eyebrow="Lessons" title="Lesson history" description="Completed lessons show topics, reports, and understanding scores used for exercise generation." />
      <div className="grid gap-4">
        {lessons.map((lesson) => (
          <Link key={lesson.id} to={`/student/lessons/${lesson.id}`} className="panel block p-5 transition hover:shadow-lg">
            <p className="font-semibold text-slate-950">{(lesson.topics ?? [lesson.topic]).filter(Boolean).join(' | ')}</p>
            <p className="mt-1 text-sm text-slate-500">{lesson.subject} • {lesson.completedOn || 'No date'}</p>
            <p className="mt-2 text-sm text-slate-600">{lesson.topicReport || lesson.note}</p>
          </Link>
        ))}
        {!lessons.length ? <div className="panel p-5 text-sm text-slate-500">No lessons have been completed yet.</div> : null}
      </div>
    </AppShell>
  );
};
