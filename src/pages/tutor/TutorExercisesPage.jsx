import { useEffect, useMemo, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { AppShell } from '../../components/common/AppShell';
import { SectionHeader } from '../../components/common/SectionHeader';
import { ExerciseStatusBadges } from '../../components/dashboard/ExerciseStatusBadges';
import { useAuth } from '../../hooks/useAuth';
import { deleteExerciseAssignmentForTutor, getTutorAssignedStudentContexts, getTutorExercisesForAssignedStudents } from '../../services/firestoreService';
import { deleteExerciseSubmissionFiles } from '../../services/storageService';
import { isExerciseSubmitted } from '../../services/exerciseGenerationPlan';
import { useEffectiveRole } from '../../utils/effectiveRole';

const getLocalDate = () => {
  const now = new Date();
  return [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');
};

export const TutorExercisesPage = () => {
  const { profile, logout } = useAuth();
  const navigate = useNavigate();
  const { role, basePath } = useEffectiveRole();
  const [exercises, setExercises] = useState([]);
  const [contexts, setContexts] = useState([]);
  const [studentFilter, setStudentFilter] = useState('all');
  const [subjectFilter, setSubjectFilter] = useState('all');
  const [status, setStatus] = useState('');
  const [deletingExerciseId, setDeletingExerciseId] = useState('');
  const today = getLocalDate();

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
  const canDeleteExercise = (exercise) => String(exercise.assignmentDate ?? '').slice(0, 10) > today && !isExerciseSubmitted(exercise);
  const openExercise = (exercise) => {
    const params = new URLSearchParams({ studentId: exercise.studentId, subjectInstanceId: exercise.subjectInstanceId });
    navigate(`${basePath}/exercises/${exercise.id}?${params.toString()}`);
  };

  const removeExercise = async (exercise) => {
    if (!window.confirm(`Delete “${exercise.title || 'this exercise'}” for ${exercise.studentName || 'this student'}? This cannot be undone.`)) return;
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

  return (
    <AppShell title="Exercises" subtitle="Tutor view of exercises assigned to your students." role={role} user={profile} onLogout={logout}>
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
      {status ? <div role="status" className="panel p-4 text-sm text-slate-300">{status}</div> : null}
      <SectionHeader eyebrow="Assigned work" title="Student exercises" description="Filter by all, student, or subject. Only students assigned to you are shown." />
      <div className="grid gap-4">
        {filteredExercises.map((exercise) => (
          <div key={exercise.id} className="panel flex flex-wrap items-center justify-between gap-3 p-5">
            <button type="button" onClick={() => openExercise(exercise)} className="min-w-0 flex-1 text-left transition">
              <div>
                <p className="font-semibold text-slate-100">{exercise.title}</p>
                <p className="mt-1 text-sm text-slate-400">{exercise.studentName || exercise.studentId} • {exercise.subject} • {exercise.assignmentDate}</p>
                <p className="mt-2 text-sm text-slate-300">{exercise.topic}</p>
              </div>
            </button>
            <ExerciseStatusBadges exercise={exercise} className="justify-end" />
            {canDeleteExercise(exercise) ? (
              <button type="button" className="btn-secondary inline-flex items-center gap-2 text-rose-300" onClick={() => removeExercise(exercise)} disabled={deletingExerciseId === exercise.id} aria-label={`Delete ${exercise.title}`} title="Delete future exercise">
                <Trash2 className="h-4 w-4" aria-hidden="true" /> {deletingExerciseId === exercise.id ? 'Deleting...' : 'Delete'}
              </button>
            ) : null}
          </div>
        ))}
        {!filteredExercises.length ? <div className="panel p-5 text-sm text-slate-500">No exercises match this filter.</div> : null}
      </div>
    </AppShell>
  );
};
