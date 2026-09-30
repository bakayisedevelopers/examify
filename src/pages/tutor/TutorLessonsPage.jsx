import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AppShell } from '../../components/common/AppShell';
import { SectionHeader } from '../../components/common/SectionHeader';
import { useAuth } from '../../hooks/useAuth';
import { getTutorAssignedStudentContexts, getTutorLessonsForAssignedStudents } from '../../services/firestoreService';

export const TutorLessonsPage = () => {
  const { profile, logout } = useAuth();
  const [lessons, setLessons] = useState([]);
  const [students, setStudents] = useState([]);
  const [studentFilter, setStudentFilter] = useState('all');
  const [subjectFilter, setSubjectFilter] = useState('all');

  useEffect(() => {
    if (!profile?.uid) return;
    Promise.all([getTutorLessonsForAssignedStudents(profile.uid), getTutorAssignedStudentContexts(profile.uid)]).then(([lessonRows, studentRows]) => { setLessons(lessonRows); setStudents(studentRows); });
  }, [profile?.uid]);

  const subjects = useMemo(() => [...new Set(students.map((item) => item.subject).concat(lessons.map((item) => item.subject)).filter(Boolean))], [students, lessons]);
  const studentOptions = useMemo(() => students.filter((item, index, list) => list.findIndex((row) => row.studentId === item.studentId) === index), [students]);
  const filteredLessons = lessons.filter((lesson) => (studentFilter === 'all' || lesson.studentId === studentFilter) && (subjectFilter === 'all' || lesson.subject === subjectFilter));

  return (
    <AppShell title="Lessons" subtitle="Create, view, and edit lessons for assigned students." role="tutor" user={profile} onLogout={logout}>
      <div className="panel grid gap-3 p-4 md:grid-cols-[1fr_1fr_auto]">
        <select className="input" value={studentFilter} onChange={(event) => setStudentFilter(event.target.value)}><option value="all">All students</option>{studentOptions.map((student) => <option key={student.studentId} value={student.studentId}>{student.displayName || student.name || student.email || student.studentId}</option>)}</select>
        <select className="input" value={subjectFilter} onChange={(event) => setSubjectFilter(event.target.value)}><option value="all">All subjects</option>{subjects.map((subject) => <option key={subject}>{subject}</option>)}</select>
        <Link to="/tutor/lessons/new" className="btn-primary text-center">Add lesson</Link>
      </div>
      <SectionHeader eyebrow="Lessons" title="Tutor lessons" description="Plan lessons first, then mark them complete with understanding scores and reports." />
      <div className="grid gap-4">
        {filteredLessons.map((lesson) => <Link key={lesson.id} to={`/tutor/lessons/${lesson.id}`} className="panel block p-5"><div className="flex flex-wrap items-start justify-between gap-3"><p className="font-semibold text-slate-950">{(lesson.topics ?? [lesson.topic]).filter(Boolean).join(' | ')}</p><span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">{lesson.status === 'planned' ? 'Planned' : 'Completed'}</span></div><p className="mt-1 text-sm text-slate-500">{lesson.studentName || lesson.studentId} • {lesson.subject} • {lesson.completedOn || lesson.lessonDate || 'No date'} • {lesson.lessonType === 'inPerson' ? 'In-person' : 'Online'}</p><p className="mt-2 text-sm text-slate-600">{lesson.topicReport || lesson.note || 'No completion report yet.'}</p></Link>)}
        {!filteredLessons.length ? <div className="panel p-5 text-sm text-slate-500">No lessons match this filter.</div> : null}
      </div>
    </AppShell>
  );
};
