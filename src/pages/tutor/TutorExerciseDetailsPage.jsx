import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { AppShell } from '../../components/common/AppShell';
import { ExerciseCard } from '../../components/dashboard/ExerciseCard';
import { useAuth } from '../../hooks/useAuth';
import { getExerciseAssignmentById } from '../../services/firestoreService';
import { getExerciseAvailability } from '../../utils/exerciseRules';

export const TutorExerciseDetailsPage = () => {
  const { exerciseId } = useParams();
  const { profile, logout } = useAuth();
  const [exercise, setExercise] = useState(null);
  const [status, setStatus] = useState('Loading exercise...');

  useEffect(() => {
    getExerciseAssignmentById(exerciseId)
      .then((result) => { setExercise(result); setStatus(result ? '' : 'Exercise not found.'); })
      .catch((error) => setStatus(error.message || 'Could not load exercise.'));
  }, [exerciseId]);

  const availability = exercise ? getExerciseAvailability(exercise.assignmentDate, Boolean(exercise.submittedImageUrl || exercise.submitted === 'Yes')) : null;

  return (
    <AppShell title="Exercise details" subtitle={exercise ? `${exercise.subject} • ${exercise.assignmentDate}` : status} role="tutor" user={profile} onLogout={logout}>
      {status ? <div className="panel p-5 text-sm text-slate-500">{status}</div> : null}
      {exercise && availability ? <div className="space-y-4"><Link to="/tutor/exercises" className="btn-secondary inline-flex w-fit">Back to exercises</Link><ExerciseCard exercise={exercise} availability={availability} paymentLocked={false} studentId={exercise.studentId} showQuestionLinks viewerRole="tutor" /></div> : null}
    </AppShell>
  );
};
