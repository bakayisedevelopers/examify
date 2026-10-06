import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { AppShell } from '../../components/common/AppShell';
import { ExerciseCard } from '../../components/dashboard/ExerciseCard';
import { useAuth } from '../../hooks/useAuth';
import { getCompletedPeerMarkingAssignmentsForStudent, getExerciseAssignmentById, getStudentAccessState, getTopicUnderstandingQuestionScores } from '../../services/firestoreService';
import { getExerciseAvailability } from '../../utils/exerciseRules';

export const StudentExerciseDetailsPage = () => {
  const { exerciseId } = useParams();
  const { profile, logout } = useAuth();
  const [exercise, setExercise] = useState(null);
  const [paymentLocked, setPaymentLocked] = useState(false);
  const [status, setStatus] = useState('Loading exercise...');
  const [completedMarkingAssignments, setCompletedMarkingAssignments] = useState([]);
  const [scoreEntries, setScoreEntries] = useState([]);

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const assignment = await getExerciseAssignmentById(exerciseId, { studentId: profile?.uid });
        if (!active) return;
        setExercise(assignment);
        if (!assignment) {
          setStatus('Exercise not found.');
          return;
        }
        const access = await getStudentAccessState(profile, assignment.subject);
        if (!active) return;
        setPaymentLocked(!access.paymentCompleted);
        const markingAssignments = await getCompletedPeerMarkingAssignmentsForStudent(profile?.uid, assignment.subject).catch(() => []);
        if (!active) return;
        const topicNames = [...new Set([
          ...(assignment.questionLinks ?? []).map((item) => item.topic),
          ...(assignment.topicBreakdown ?? []).map((item) => item.topic),
          ...String(assignment.topic ?? '').split('|'),
          ...markingAssignments.flatMap((item) => [
            ...(item.topics ?? []), item.topic, ...(item.questionLinks ?? []).map((link) => link.topic),
          ]),
        ].map((topic) => String(topic ?? '').trim()).filter(Boolean))];
        const questionScores = await getTopicUnderstandingQuestionScores({
          studentId: assignment.studentId || profile?.uid,
          subjectInstanceId: assignment.subjectInstanceId,
          topics: topicNames,
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
    load();
    return () => { active = false; };
  }, [exerciseId, profile]);

  const availability = exercise ? getExerciseAvailability(exercise.assignmentDate, Boolean(exercise.submittedImageUrl || exercise.submitted === 'Yes')) : null;

  return (
    <AppShell title="Exercise details" subtitle={exercise ? `${exercise.subject} • ${exercise.assignmentDate}` : status} role="student" user={profile} onLogout={logout}>
      {status ? <div className="panel p-5 text-sm text-slate-500">{status}</div> : null}
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
