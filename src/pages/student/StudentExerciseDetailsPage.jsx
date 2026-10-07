import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { AppShell } from '../../components/common/AppShell';
import { LoadingState } from '../../components/common/LoadingState';
import { ExerciseCard } from '../../components/dashboard/ExerciseCard';
import { useAuth } from '../../hooks/useAuth';
import { getCompletedPeerMarkingAssignmentsForStudent, getExerciseAssignmentById, getStudentEntitlementState, getTopicUnderstandingQuestionScores } from '../../services/firestoreService';
import { getExerciseAvailability } from '../../utils/exerciseRules';
import { getExerciseTopicNames, getPeerMarkingTopicNames, uniqueTopicNames } from '../../utils/exerciseTopicRows';

export const StudentExerciseDetailsPage = () => {
  const { exerciseId } = useParams();
  const [searchParams] = useSearchParams();
  const subjectInstanceId = searchParams.get('subjectInstanceId');
  const { profile, logout } = useAuth();
  const [exercise, setExercise] = useState(null);
  const [paymentLocked, setPaymentLocked] = useState(false);
  const [status, setStatus] = useState('Loading exercise...');
  const [isLoading, setIsLoading] = useState(true);
  const [completedMarkingAssignments, setCompletedMarkingAssignments] = useState([]);
  const [scoreEntries, setScoreEntries] = useState([]);

  useEffect(() => {
    let active = true;
    setIsLoading(true);
    const load = async () => {
      try {
        const assignment = await getExerciseAssignmentById(exerciseId, { studentId: profile?.uid, subjectInstanceId });
        if (!active) return;
        setExercise(assignment);
        if (!assignment) {
          setStatus('Exercise not found.');
          return;
        }
        const [access, markingAssignments] = await Promise.all([
          getStudentEntitlementState(profile, assignment.subject, assignment.subjectInstanceId),
          getCompletedPeerMarkingAssignmentsForStudent(profile?.uid, assignment.subject).catch(() => []),
        ]);
        if (!active) return;
        setPaymentLocked(!access.paymentCompleted);
        const topicNames = uniqueTopicNames([
          ...getExerciseTopicNames(assignment),
          ...markingAssignments.flatMap(getPeerMarkingTopicNames),
        ]);
        const questionScores = await getTopicUnderstandingQuestionScores({
          studentId: assignment.studentId || profile?.uid,
          subjectInstanceId: assignment.subjectInstanceId,
          topics: topicNames,
          sourceIds: [assignment.id, ...markingAssignments.map((item) => item.id)],
        }).catch(() => []);
        if (!active) return;
        setCompletedMarkingAssignments(markingAssignments);
        setScoreEntries(questionScores);
        setStatus('');
      } catch (error) {
        if (!active) return;
        setStatus(error.message ?? 'Could not load exercise.');
      }
    };
    load().finally(() => { if (active) setIsLoading(false); });
    return () => { active = false; };
  }, [exerciseId, profile?.uid, subjectInstanceId]);

  const availability = exercise ? getExerciseAvailability(exercise.assignmentDate, Boolean(exercise.submittedImageUrl || exercise.submitted === 'Yes')) : null;

  return (
    <AppShell title="Exercise details" subtitle={exercise ? `${exercise.subject} • ${exercise.assignmentDate}` : status} role="student" user={profile} onLogout={logout}>
      {isLoading ? <LoadingState label="Loading exercise details and scores…" /> : null}
      {status && !isLoading ? <div className="panel p-5 text-sm text-slate-500">{status}</div> : null}
      {exercise && availability ? (
        <div className="space-y-4">
          <Link to="/student" className="btn-secondary inline-flex w-fit">Back to today’s exercises</Link>
          <ExerciseCard
            exercise={exercise}
            availability={availability}
            paymentLocked={paymentLocked}
            studentId={profile?.uid}
            scoreEntries={scoreEntries}
            completedMarkingAssignments={completedMarkingAssignments}
            showQuestionLinks
          />
        </div>
      ) : null}
    </AppShell>
  );
};
