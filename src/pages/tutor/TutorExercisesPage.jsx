import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AppShell } from '../../components/common/AppShell';
import { SectionHeader } from '../../components/common/SectionHeader';
import { useAuth } from '../../hooks/useAuth';
import { getTutorAssignedStudentContexts, getTutorExercisesForAssignedStudents } from '../../services/firestoreService';

export const TutorExercisesPage = () => {
  const { profile, logout } = useAuth();
  const navigate = useNavigate();
  const [exercises, setExercises] = useState([]);
  const [contexts, setContexts] = useState([]);
  const [studentFilter, setStudentFilter] = useState('all');
  const [subjectFilter, setSubjectFilter] = useState('all');

  useEffect(() => {
    if (!profile?.uid) return;
    Promise.all([
      getTutorExercisesForAssignedStudents(profile.uid),
      getTutorAssignedStudentContexts(profile.uid),
    ]).then(([exerciseRows, contextRows]) => {
      setExercises(exerciseRows);
      setContexts(contextRows);
    });
  }, [profile?.uid]);

  const subjects = useMemo(() => [...new Set(contexts.map((item) => item.subject).filter(Boolean))], [contexts]);
  const students = useMemo(() => contexts.filter((item, index, list) => list.findIndex((row) => row.studentId === item.studentId) === index), [contexts]);
  const filteredExercises = exercises.filter((exercise) =>
    (studentFilter === 'all' || exercise.studentId === studentFilter) &&
    (subjectFilter === 'all' || exercise.subject === subjectFilter)
  );

  return (
    <AppShell title="Exercises" subtitle="Tutor view of exercises assigned to your students." role="tutor" user={profile} onLogout={logout}>
      <div className="panel grid gap-3 p-4 md:grid-cols-2">
        <select className="input" value={studentFilter} onChange={(event) => setStudentFilter(event.target.value)}>
          <option value="all">All students</option>
          {students.map((student) => <option key={student.studentId} value={student.studentId}>{student.displayName || student.name || student.email || student.studentId}</option>)}
        </select>
        <select className="input" value={subjectFilter} onChange={(event) => setSubjectFilter(event.target.value)}>
          <option value="all">All subjects</option>
          {subjects.map((subject) => <option key={subject} value={subject}>{subject}</option>)}
        </select>
      </div>
      <SectionHeader eyebrow="Assigned work" title="Student exercises" description="Filter by all, student, or subject. Only students assigned to you are shown." />
      <div className="grid gap-4">
        {filteredExercises.map((exercise) => (
          <button key={exercise.id} type="button" onClick={() => navigate(`/tutor/exercises/${exercise.id}`)} className="panel p-5 text-left transition hover:shadow-lg">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="font-semibold text-slate-950">{exercise.title}</p>
                <p className="mt-1 text-sm text-slate-500">{exercise.studentName || exercise.studentId} • {exercise.subject} • {exercise.assignmentDate}</p>
                <p className="mt-2 text-sm text-slate-600">{exercise.topic}</p>
              </div>
              <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">{exercise.submittedImageUrl ? 'Submitted' : 'Not submitted'}</span>
            </div>
          </button>
        ))}
        {!filteredExercises.length ? <div className="panel p-5 text-sm text-slate-500">No exercises match this filter.</div> : null}
      </div>
    </AppShell>
  );
};
