import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { AppShell } from '../../components/common/AppShell';
import { LoadingState } from '../../components/common/LoadingState';
import { ExerciseCard } from '../../components/dashboard/ExerciseCard';
import { useAuth } from '../../hooks/useAuth';
import { getCompletedPeerMarkingAssignmentsForStudent, getExerciseAssignmentById, getStudentEntitlementState, getTopicUnderstandingQuestionScores, subscribePeerMarkingAssignmentsForStudent } from '../../services/firestoreService';
import { getExerciseAvailability } from '../../utils/exerciseRules';
import { getExerciseTopicNames, getPeerMarkingTopicNames, getQuestionTopicIds, uniqueTopicNames } from '../../utils/exerciseTopicRows';

const assignmentBelongsToExercise = (markingAssignment, exercise) => {
  if (!markingAssignment || !exercise) return false;
  const matchesPath = Boolean(exercise.documentPath && markingAssignment.reviewerExercisePath === exercise.documentPath);
  const matchesIds = markingAssignment.reviewerExerciseId === exercise.id
    && markingAssignment.reviewerSubjectInstanceId === exercise.subjectInstanceId;
  return matchesPath || matchesIds;
};

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
  const [assignedMarkingAssignment, setAssignedMarkingAssignment] = useState(null);
  const [scoreEntries, setScoreEntries] = useState([]);

  useEffect(() => {
    let active = true;
    setIsLoading(true);
    setAssignedMarkingAssignment(null);
    const load = async () => {
      try {
        const assignment = await getExerciseAssignmentById(exerciseId, { studentId: profile?.uid, subjectInstanceId });
        if (!active) return;
        setExercise(assignment);
        if (!assignment) {
          setStatus('Exercise not found.');
          return;
        }
        const [access, allMarkingAssignments] = await Promise.all([
          getStudentEntitlementState(profile, assignment.subject, assignment.subjectInstanceId),
          getCompletedPeerMarkingAssignmentsForStudent(profile?.uid, assignment.subject).catch(() => []),
        ]);
        if (!active) return;
        setPaymentLocked(!access.paymentCompleted);
        const markingAssignments = allMarkingAssignments.filter((item) => assignmentBelongsToExercise(item, assignment));
        const topicNames = uniqueTopicNames([
          ...getExerciseTopicNames(assignment),
          ...markingAssignments.flatMap(getPeerMarkingTopicNames),
        ]);
        const questionScores = await getTopicUnderstandingQuestionScores({
          studentId: assignment.studentId || profile?.uid,
          subjectInstanceId: assignment.subjectInstanceId,
          topics: topicNames,
          topicIds: [...new Set([
            ...getQuestionTopicIds(assignment),
            ...markingAssignments.flatMap(getQuestionTopicIds),
          ])],
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
  }, [exerciseId, profile, subjectInstanceId]);

  useEffect(() => {
    if (!profile?.uid || !exercise) {
      setAssignedMarkingAssignment(null);
      return undefined;
    }
    return subscribePeerMarkingAssignmentsForStudent(profile.uid, (assignments) => {
      const matchingAssignment = assignments.find((assignment) => assignment.status === 'assigned'
        && assignment.reviewerId === profile.uid
        && assignmentBelongsToExercise(assignment, exercise)) ?? null;
      setAssignedMarkingAssignment(matchingAssignment);
    });
  }, [exercise, profile?.uid]);

  const handlePeerMarkingCompleted = ({ assignment, reviewImages }) => {
    setAssignedMarkingAssignment(null);
    const completedAssignment = {
      ...assignment,
      status: 'completed',
      reviewImages,
      reviewImageUrl: reviewImages[0]?.url || '',
    };
    setCompletedMarkingAssignments((current) => [
      completedAssignment,
      ...current.filter((item) => item.assignmentPath !== assignment.assignmentPath),
    ]);
    setExercise((current) => current ? {
      ...current,
      peerMarkingImages: reviewImages,
      peerMarkingImageUrl: reviewImages[0]?.url || '',
      peerMarkingAssignmentId: assignment.id,
      peerMarkingStatus: 'completed',
    } : current);
  };

  const availability = exercise ? getExerciseAvailability(exercise.assignmentDate, Boolean(exercise.submittedImageUrl || exercise.submitted === 'Yes')) : null;

  return (
    <AppShell title="Exercise details" subtitle={exercise ? `${exercise.subject} • ${exercise.assignmentDate}` : status} role="student" user={profile} onLogout={logout}>
      {isLoading ? <LoadingState label="Loading exercise details and scores…" /> : null}
      {status && !isLoading ? <div className="panel p-5 text-sm text-slate-500">{status}</div> : null}
      {exercise && availability ? (
        <div className="space-y-4">
          <Link to="/student" className="btn-secondary hidden w-fit lg:inline-flex">Back to today’s exercises</Link>
          <ExerciseCard
            exercise={exercise}
            availability={availability}
            paymentLocked={paymentLocked}
            studentId={profile?.uid}
            scoreEntries={scoreEntries}
            completedMarkingAssignments={completedMarkingAssignments}
            assignedMarkingAssignment={assignedMarkingAssignment}
            onPeerMarkingCompleted={handlePeerMarkingCompleted}
            showQuestionLinks
          />
        </div>
      ) : null}
    </AppShell>
  );
};
