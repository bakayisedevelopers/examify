import { useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { AppShell } from '../../components/common/AppShell';
import { ExerciseCard } from '../../components/dashboard/ExerciseCard';
import { useAuth } from '../../hooks/useAuth';
import { deleteExerciseAssignmentForTutor, getExerciseAssignmentById, getStudentTopicScoresForTutor, getTutorAssignedStudentContexts, getTutorAssignmentHistoryContexts, getTutorAssignmentHistoryData } from '../../services/firestoreService';
import { deleteExerciseSubmissionFiles } from '../../services/storageService';
import { getExerciseAvailability, getExerciseStatusLabels } from '../../utils/exerciseRules';
import { useEffectiveRole } from '../../utils/effectiveRole';

export const TutorExerciseDetailsPage = () => {
  const { exerciseId } = useParams();
  const { profile, logout } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const periodId = searchParams.get('period');
  const studentId = searchParams.get('studentId');
  const subjectInstanceId = searchParams.get('subjectInstanceId');
  const { role, basePath } = useEffectiveRole();
  const [exercise, setExercise] = useState(null);
  const [status, setStatus] = useState('Loading exercise...');
  const [isDeleting, setIsDeleting] = useState(false);
  const [topicScores, setTopicScores] = useState({});
  const [accessRole, setAccessRole] = useState('viewer');
  const [isHistorical, setIsHistorical] = useState(false);

  useEffect(() => {
    getExerciseAssignmentById(exerciseId, { tutorId: profile?.uid, studentId, subjectInstanceId, periodId })
      .then(async (result) => {
        if (!result) {
          setStatus('Exercise not found.');
          return;
        }
        if (profile?.uid && periodId) {
          const history = await getTutorAssignmentHistoryContexts(profile.uid, result.studentId);
          if (!history.some((period) => period.assignmentPeriodId === periodId)) throw new Error('This assignment history is not available to your account.');
          const archivedData = await getTutorAssignmentHistoryData({ tutorId: profile.uid, studentId: result.studentId, periodId });
          const archivedExercise = archivedData.exercises.find((item) => item.id === exerciseId);
          if (!archivedExercise) throw new Error('This exercise is not part of the selected assignment period.');
          setExercise(archivedExercise);
          setTopicScores(Object.fromEntries((archivedExercise.topicUnderstandingScores ?? []).map((entry) => [entry.topic, entry.understandingLevel])));
          setAccessRole('viewer');
          setIsHistorical(true);
          setStatus('');
          return;
        }
        setIsHistorical(false);
        setExercise(result);
        setStatus('');
        if (profile?.uid) {
          const [scores, contexts] = await Promise.all([
            getStudentTopicScoresForTutor({ tutorId: profile.uid, studentId: result.studentId, subject: result.subject }),
            getTutorAssignedStudentContexts(profile.uid),
          ]);
          setTopicScores(scores);
          setAccessRole(contexts.find((context) => context.studentId === result.studentId && context.subject === result.subject)?.accessRole || 'viewer');
        }
      })
      .catch((error) => setStatus(error.message || 'Could not load exercise.'));
  }, [exerciseId, profile?.uid, periodId, studentId, subjectInstanceId]);

  const availability = exercise ? getExerciseAvailability(exercise.assignmentDate, Boolean(exercise.submittedImageUrl || exercise.submitted === 'Yes')) : null;
  const exerciseStatus = exercise ? getExerciseStatusLabels(exercise) : null;

  const removeExercise = async () => {
    if (!exercise || !window.confirm(`Delete “${exercise.title || 'this exercise'}”? This cannot be undone.`)) return;
    setIsDeleting(true);
    try {
      const result = await deleteExerciseAssignmentForTutor({ tutorId: profile.uid, exerciseId: exercise.id });
      await deleteExerciseSubmissionFiles(result.storageUrls);
      navigate(`${basePath}/exercises`, { replace: true });
    } catch (error) {
      setStatus(error.message || 'Could not delete exercise.');
      setIsDeleting(false);
    }
  };

  return (
    <AppShell title="Exercise details" subtitle={exercise ? `${exercise.subject} • ${exercise.assignmentDate}` : status} role={role} user={profile} onLogout={logout}>
      {status ? <div className="panel p-5 text-sm text-slate-500">{status}</div> : null}
      {isHistorical ? <div className="panel border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-800">Historical assignment record · read-only</div> : null}
      {exercise && availability ? (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Link to={`${basePath}/exercises`} className="btn-secondary inline-flex w-fit">Back to exercises</Link>
            {accessRole === 'co-owner' && !isHistorical && !exerciseStatus?.isToday ? <button type="button" className="btn-secondary inline-flex items-center gap-2 text-rose-300" onClick={removeExercise} disabled={isDeleting}>
              <Trash2 className="h-4 w-4" aria-hidden="true" /> {isDeleting ? 'Deleting...' : 'Delete exercise'}
            </button> : null}
          </div>
          <ExerciseCard exercise={exercise} availability={availability} paymentLocked={false} studentId={exercise.studentId} tutorId={profile?.uid} topicScores={topicScores} onTopicScoreSaved={(topic, score) => setTopicScores((current) => ({ ...current, [topic]: score }))} showQuestionLinks viewerRole="tutor" accessRole={accessRole} />
        </div>
      ) : null}
    </AppShell>
  );
};
