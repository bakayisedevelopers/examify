import { useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AppShell } from '../../components/common/AppShell';
import { ExerciseCard } from '../../components/dashboard/ExerciseCard';
import { useAuth } from '../../hooks/useAuth';
import { deleteExerciseAssignmentForTutor, getExerciseAssignmentById, getStudentTopicScoresForTutor } from '../../services/firestoreService';
import { deleteExerciseSubmissionFiles } from '../../services/storageService';
import { getExerciseAvailability } from '../../utils/exerciseRules';

export const TutorExerciseDetailsPage = () => {
  const { exerciseId } = useParams();
  const { profile, logout } = useAuth();
  const navigate = useNavigate();
  const [exercise, setExercise] = useState(null);
  const [status, setStatus] = useState('Loading exercise...');
  const [isDeleting, setIsDeleting] = useState(false);
  const [topicScores, setTopicScores] = useState({});

  useEffect(() => {
    getExerciseAssignmentById(exerciseId)
      .then(async (result) => {
        setExercise(result);
        setStatus(result ? '' : 'Exercise not found.');
        if (result && profile?.uid) {
          const scores = await getStudentTopicScoresForTutor({ tutorId: profile.uid, studentId: result.studentId, subject: result.subject });
          setTopicScores(scores);
        }
      })
      .catch((error) => setStatus(error.message || 'Could not load exercise.'));
  }, [exerciseId, profile?.uid]);

  const availability = exercise ? getExerciseAvailability(exercise.assignmentDate, Boolean(exercise.submittedImageUrl || exercise.submitted === 'Yes')) : null;

  const removeExercise = async () => {
    if (!exercise || !window.confirm(`Delete “${exercise.title || 'this exercise'}”? This cannot be undone.`)) return;
    setIsDeleting(true);
    try {
      const result = await deleteExerciseAssignmentForTutor({ tutorId: profile.uid, exerciseId: exercise.id });
      await deleteExerciseSubmissionFiles(result.storageUrls);
      navigate('/tutor/exercises', { replace: true });
    } catch (error) {
      setStatus(error.message || 'Could not delete exercise.');
      setIsDeleting(false);
    }
  };

  return (
    <AppShell title="Exercise details" subtitle={exercise ? `${exercise.subject} • ${exercise.assignmentDate}` : status} role="tutor" user={profile} onLogout={logout}>
      {status ? <div className="panel p-5 text-sm text-slate-500">{status}</div> : null}
      {exercise && availability ? (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Link to="/tutor/exercises" className="btn-secondary inline-flex w-fit">Back to exercises</Link>
            <button type="button" className="btn-secondary inline-flex items-center gap-2 text-rose-300" onClick={removeExercise} disabled={isDeleting}>
              <Trash2 className="h-4 w-4" aria-hidden="true" /> {isDeleting ? 'Deleting...' : 'Delete exercise'}
            </button>
          </div>
          <ExerciseCard exercise={exercise} availability={availability} paymentLocked={false} studentId={exercise.studentId} tutorId={profile?.uid} topicScores={topicScores} onTopicScoreSaved={(topic, score) => setTopicScores((current) => ({ ...current, [topic]: score }))} showQuestionLinks viewerRole="tutor" />
        </div>
      ) : null}
    </AppShell>
  );
};
