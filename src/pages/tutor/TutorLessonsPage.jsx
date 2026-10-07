import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AppShell } from '../../components/common/AppShell';
import { LoadingState } from '../../components/common/LoadingState';
import { SectionHeader } from '../../components/common/SectionHeader';
import { useAuth } from '../../hooks/useAuth';
import { getTutorAssignedStudentContexts, getTutorLessonsForAssignedStudents } from '../../services/firestoreService';
import { useEffectiveRole } from '../../utils/effectiveRole';
import { warmNavigationRoute } from '../../routes/preloadNavigationRoute';

const sessionKey = (lesson) => lesson.groupSessionId || lesson.id;

export const TutorLessonsPage = () => {
  const { profile, logout } = useAuth();
  const { basePath, role } = useEffectiveRole();
  const [lessons, setLessons] = useState([]);
  const [students, setStudents] = useState([]);
  const [studentFilter, setStudentFilter] = useState('all');
  const [subjectFilter, setSubjectFilter] = useState('all');
  const [status, setStatus] = useState('');
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (!profile?.uid) { setIsLoading(false); return undefined; }
    let active = true;
    setIsLoading(true);
    setStatus('');
    getTutorAssignedStudentContexts(profile.uid)
      .then((studentRows) => getTutorLessonsForAssignedStudents(profile.uid, studentRows).then((lessonRows) => [lessonRows, studentRows]))
      .then(([lessonRows, studentRows]) => { if (active) { setLessons(lessonRows); setStudents(studentRows); } })
      .catch((error) => { if (active) setStatus(error.message || 'Could not load lessons.'); })
      .finally(() => { if (active) setIsLoading(false); });
    return () => { active = false; };
  }, [profile?.uid]);

  const subjects = useMemo(() => [...new Set(students.map((item) => item.subject).concat(lessons.map((item) => item.subject)).filter(Boolean))], [students, lessons]);
  const studentOptions = useMemo(() => students.filter((item, index, list) => list.findIndex((row) => row.studentId === item.studentId) === index), [students]);
  const filteredLessons = lessons.filter((lesson) => (studentFilter === 'all' || lesson.studentId === studentFilter) && (subjectFilter === 'all' || lesson.subject === subjectFilter));
  const sessions = useMemo(() => {
    const groups = new Map();
    filteredLessons.forEach((lesson) => {
      const key = sessionKey(lesson);
      const current = groups.get(key);
      if (!current) {
        groups.set(key, { ...lesson, studentNames: [lesson.studentName || lesson.studentId], totalStudents: Number(lesson.groupStudentCount) || 1, presentCount: lesson.attended === false || lesson.status === 'missed' ? 0 : (lesson.status === 'completed' ? 1 : null) });
        return;
      }
      if (!current.studentNames.includes(lesson.studentName || lesson.studentId)) current.studentNames.push(lesson.studentName || lesson.studentId);
      current.totalStudents = Math.max(current.totalStudents, Number(lesson.groupStudentCount) || current.studentNames.length);
      if (lesson.status === 'completed' || lesson.status === 'missed') current.presentCount = (current.presentCount ?? 0) + (lesson.attended === false || lesson.status === 'missed' ? 0 : 1);
    });
    return [...groups.values()].sort((left, right) => String(right.completedOn || right.lessonDate || '').localeCompare(String(left.completedOn || left.lessonDate || '')));
  }, [filteredLessons]);

  return (
    <AppShell title="Lessons" subtitle="Schedule one-on-one and group lessons, then record attendance and student progress." role={role} user={profile} onLogout={logout}>
      <div className="panel grid gap-3 p-4 md:grid-cols-[1fr_1fr_auto]">
        <select aria-label="Filter lessons by student" className="input" value={studentFilter} onChange={(event) => setStudentFilter(event.target.value)}><option value="all">All students</option>{studentOptions.map((student) => <option key={student.studentId} value={student.studentId}>{student.displayName || student.name || student.email || student.studentId}</option>)}</select>
        <select aria-label="Filter lessons by subject" className="input" value={subjectFilter} onChange={(event) => setSubjectFilter(event.target.value)}><option value="all">All subjects</option>{subjects.map((subject) => <option key={subject}>{subject}</option>)}</select>
        <Link to={`${basePath}/lessons/new`} onMouseEnter={() => warmNavigationRoute(`${basePath}/lessons/new`)} onFocus={() => warmNavigationRoute(`${basePath}/lessons/new`)} onPointerDown={() => warmNavigationRoute(`${basePath}/lessons/new`)} className="btn-primary text-center">Schedule lesson</Link>
      </div>
      <SectionHeader eyebrow="Lessons" title="Tutor lessons" description="Each student keeps an individual lesson record; group sessions are shown once here." />
      {status ? <div className="panel p-4 text-sm text-rose-700">{status}</div> : null}
      <div className="grid gap-4">
        {isLoading ? <LoadingState label="Loading tutor lessons…" /> : null}
        {sessions.map((lesson) => {
          const isGroup = lesson.sessionMode === 'group';
          const missed = lesson.status === 'missed';
          const completed = lesson.status === 'completed';
          const statusLabel = missed ? 'Missed' : completed ? 'Completed' : 'Planned';
          const statusTone = missed ? 'bg-amber-100 text-amber-800' : completed ? 'bg-lime-100 text-lime-800' : 'bg-slate-100 text-slate-600';
          return (
            <Link key={sessionKey(lesson)} to={`${basePath}/lessons/${lesson.id}?studentId=${encodeURIComponent(lesson.studentId)}&subjectInstanceId=${encodeURIComponent(lesson.subjectInstanceId || '')}`} onMouseEnter={() => warmNavigationRoute(`${basePath}/lessons/${lesson.id}`)} onFocus={() => warmNavigationRoute(`${basePath}/lessons/${lesson.id}`)} onPointerDown={() => warmNavigationRoute(`${basePath}/lessons/${lesson.id}`)} className="panel block p-5 transition hover:border-lime-700/40">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-semibold text-slate-950">{(lesson.topics ?? [lesson.topic]).filter(Boolean).join(' • ') || 'Lesson topics not recorded'}</p>
                  <p className="mt-1 text-sm text-slate-500">{isGroup ? `Group lesson • ${lesson.totalStudents} students` : lesson.studentNames[0]} • {lesson.subject} • {lesson.grade || 'Grade not recorded'} • {lesson.completedOn || lesson.lessonDate || 'No date'} • {lesson.lessonType === 'inPerson' ? 'In-person' : 'Online (WhatsApp)'}</p>
                  {isGroup ? <p className="mt-2 line-clamp-2 text-xs text-slate-500">{lesson.studentNames.slice(0, 6).join(', ')}{lesson.totalStudents > 6 ? ` and ${lesson.totalStudents - 6} more` : ''}</p> : null}
                </div>
                <span className={`rounded-full px-3 py-1 text-xs font-semibold ${statusTone}`}>{statusLabel}</span>
              </div>
              {lesson.topicReport ? <p className="mt-3 line-clamp-2 text-sm text-slate-600">{lesson.topicReport}</p> : null}
              {isGroup && lesson.presentCount !== null ? <p className="mt-2 text-xs font-medium text-slate-500">{lesson.presentCount} present • {lesson.totalStudents - lesson.presentCount} missed</p> : null}
            </Link>
          );
        })}
        {!isLoading && !status && !sessions.length ? <div className="panel p-5 text-sm text-slate-500">No lessons match this filter.</div> : null}
      </div>
    </AppShell>
  );
};
