import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AppShell } from '../../components/common/AppShell';
import { LoadingState } from '../../components/common/LoadingState';
import { SectionHeader } from '../../components/common/SectionHeader';
import { useAuth } from '../../hooks/useAuth';
import { getLessonsForStudent } from '../../services/firestoreService';

export const StudentLessonsPage = () => {
  const { profile, logout } = useAuth();
  const [lessons, setLessons] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    if (!profile?.uid) { setIsLoading(false); return undefined; }
    let active = true;
    setIsLoading(true);
    setLoadError('');
    getLessonsForStudent(profile.uid).then((rows) => { if (active) setLessons(rows); })
      .catch((error) => { if (active) setLoadError(error.message || 'Could not load lessons.'); })
      .finally(() => { if (active) setIsLoading(false); });
    return () => { active = false; };
  }, [profile?.uid]);

  return (
    <AppShell title="Lessons" subtitle="Completed and upcoming lesson context from your tutors." role="student" user={profile} onLogout={logout}>
      <SectionHeader eyebrow="Lessons" title="Lesson history" description="Completed lessons show topics, reports, and understanding scores used for exercise generation." />
      <div className="grid gap-4">
        {isLoading ? <LoadingState label="Loading your lessons…" /> : null}
        {lessons.map((lesson) => {
          const missed = lesson.status === 'missed' || lesson.attendanceStatus === 'missed' || lesson.attended === false;
          const planned = lesson.status === 'planned';
          const statusLabel = missed ? 'Missed' : planned ? 'Upcoming' : 'Completed';
          const topics = (lesson.topics ?? [lesson.topic]).filter(Boolean);
          return (
            <Link key={lesson.id} to={`/student/lessons/${lesson.id}?studentId=${encodeURIComponent(profile.uid)}&subjectInstanceId=${encodeURIComponent(lesson.subjectInstanceId || '')}`} className="panel block p-5 transition hover:border-lime-700/40">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <p className="font-semibold text-slate-950">{topics.join(' | ') || 'Lesson topics not recorded'}</p>
                <span className={`rounded-full px-3 py-1 text-xs font-semibold ${missed ? 'bg-amber-100 text-amber-800' : planned ? 'bg-sky-100 text-sky-800' : 'bg-lime-100 text-lime-800'}`}>{statusLabel}</span>
              </div>
              <p className="mt-1 text-sm text-slate-500">{lesson.sessionMode === 'group' ? `Group lesson • ${lesson.groupStudentCount || 2} students • ` : ''}{lesson.subject} • {lesson.lessonDate || lesson.completedOn || 'No date'} • {lesson.lessonType === 'inPerson' ? 'In-person' : 'Online (WhatsApp)'}</p>
              {missed ? <p className="mt-2 text-sm text-slate-600">You were marked absent.</p> : !planned && (lesson.topicReport || lesson.note) ? <p className="mt-2 text-sm text-slate-600">{lesson.topicReport || lesson.note}</p> : null}
            </Link>
          );
        })}
        {!isLoading && !loadError && !lessons.length ? <div className="panel p-5 text-sm text-slate-500">No lessons have been completed yet.</div> : null}
      </div>
      {loadError ? <div className="panel p-4 text-sm text-rose-700" role="alert">{loadError}</div> : null}
    </AppShell>
  );
};
