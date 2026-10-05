import { format, isAfter, isBefore, isSameDay, startOfDay } from 'date-fns';

export const getExerciseAvailability = (assignmentDate, hasSubmission) => {
  const today = startOfDay(new Date());
  const target = startOfDay(new Date(assignmentDate));

  if (isSameDay(today, target)) {
    return {
      state: 'active',
      label: hasSubmission ? 'Submitted today ✅' : 'Ready today ⏳',
    };
  }

  if (isAfter(target, today)) {
    return {
      state: 'upcoming',
      label: `Opens ${format(target, 'PPP')}`,
    };
  }

  return {
    state: hasSubmission ? 'completed' : 'locked',
    label: hasSubmission ? 'Completed' : 'Missed and locked',
  };
};

const localDateKey = (date = new Date()) => [
  date.getFullYear(),
  String(date.getMonth() + 1).padStart(2, '0'),
  String(date.getDate()).padStart(2, '0'),
].join('-');

export const getExerciseStatusLabels = (exercise = {}, today = localDateKey()) => {
  const assignmentDate = String(exercise.assignmentDate ?? '').slice(0, 10);
  const submitted = Boolean(exercise.submittedImageUrl || exercise.submitted === 'Yes' || exercise.submissionStatus === 'submitted');
  const markingSubmitted = String(exercise.peerMarkingStatus ?? '').toLowerCase() === 'completed'
    || Boolean(exercise.peerMarkingImageUrl || exercise.peerMarkingImages?.length);
  const isReady = assignmentDate >= today;

  return {
    primary: isReady ? 'Ready' : submitted ? 'Submitted' : 'Not submitted',
    submitted,
    markingSubmitted,
    isToday: assignmentDate === today,
    showMarking: Boolean(assignmentDate) && assignmentDate <= today,
  };
};

export const canOpenExercise = (assignmentDate) => isSameDay(startOfDay(new Date(assignmentDate)), startOfDay(new Date()));

export const canSubmitPeerReview = ({ ownSubmissionComplete, peerReviewSubmitted, assignmentDate }) => {
  if (!assignmentDate) return false;
  return ownSubmissionComplete && !peerReviewSubmitted && !isBefore(startOfDay(new Date()), startOfDay(new Date(assignmentDate)));
};
