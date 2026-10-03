const normalise = (value) => String(value ?? '')
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/[^a-z0-9|]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const dateKey = (value) => {
  if (value?.toDate) return value.toDate().toISOString().slice(0, 10);
  return String(value ?? '').slice(0, 10);
};

const ageInDays = (today, value) => {
  const current = Date.parse(`${dateKey(today)}T00:00:00Z`);
  const past = Date.parse(`${dateKey(value)}T00:00:00Z`);
  if (!Number.isFinite(current) || !Number.isFinite(past)) return -1;
  return Math.floor((current - past) / 86400000);
};

export const getExerciseTopicKeys = (exercise = {}) => {
  const values = [
    ...(Array.isArray(exercise.topics) ? exercise.topics : []),
    ...(Array.isArray(exercise.topicBreakdown) ? exercise.topicBreakdown.map((entry) => entry?.topic) : []),
    ...(Array.isArray(exercise.questionLinks) ? exercise.questionLinks.map((entry) => entry?.topic) : []),
    ...String(exercise.topic || '').split('|'),
  ];
  return new Set(values.map(normalise).filter(Boolean));
};

const candidateMatches = (candidate, reviewer, topicKeys, { grade, subject }) => {
  if (!candidate.studentId || candidate.studentId === reviewer.studentId) return false;
  if (String(candidate.grade ?? '') !== String(grade ?? '') || normalise(candidate.subject) !== normalise(subject)) return false;
  if (!dateKey(candidate.assignmentDate) || dateKey(candidate.assignmentDate) > dateKey(reviewer.assignmentDate)) return false;
  if (!(candidate.submittedImageUrl && candidate.submittedFileName) && !candidate.submittedImages?.some((image) => image?.url)) return false;
  const candidateTopics = getExerciseTopicKeys(candidate);
  const sharedTopicCount = [...candidateTopics].filter((topic) => topicKeys.has(topic)).length;
  return sharedTopicCount >= Math.min(topicKeys.size, 2);
};

const chooseCandidate = ({ candidates, reviewer, topicKeys, markedIds, recentReviewees, currentDate, cohort }) => {
  const matching = candidates
    .filter((candidate) => candidateMatches(candidate, reviewer, topicKeys, cohort))
    .filter((candidate, index, list) => list.findIndex((item) => item.id === candidate.id) === index);

  const rank = (left, right, preferOlder = false) => {
    const leftRevieweeSeen = recentReviewees.has(left.studentId) ? 1 : 0;
    const rightRevieweeSeen = recentReviewees.has(right.studentId) ? 1 : 0;
    if (leftRevieweeSeen !== rightRevieweeSeen) return leftRevieweeSeen - rightRevieweeSeen;
    const leftDate = String(left.assignmentDate ?? '');
    const rightDate = String(right.assignmentDate ?? '');
    const dateCompare = leftDate.localeCompare(rightDate);
    if (dateCompare) return preferOlder ? dateCompare : -dateCompare;
    return String(left.id).localeCompare(String(right.id));
  };

  const fresh = matching.filter((candidate) => !markedIds.has(candidate.id)).sort((left, right) => rank(left, right));
  if (fresh.length) return fresh[0];

  const repeated = matching.filter((candidate) => markedIds.has(candidate.id));
  for (const minimumAge of [21, 14, 7, 3]) {
    const eligible = repeated.filter((candidate) => ageInDays(currentDate, candidate.assignmentDate) > minimumAge)
      .sort((left, right) => rank(left, right, true));
    if (eligible.length) return eligible[0];
  }
  return null;
};

export const buildAssignments = ({
  reviewers = [],
  candidates = [],
  topicKeysByReviewer = new Map(),
  markedExerciseIdsByReviewer = new Map(),
  recentRevieweesByReviewer = new Map(),
  assignedReviewerIds = new Set(),
  currentDate,
  subject,
  grade,
}) => {
  const cohort = { subject, grade };
  return reviewers
    .filter((reviewer) => reviewer.studentId && !assignedReviewerIds.has(reviewer.studentId))
    .map((reviewer) => {
      const topicKeys = topicKeysByReviewer.get(reviewer.studentId) ?? new Set();
      if (!topicKeys.size) return null;
      const markedIds = markedExerciseIdsByReviewer.get(reviewer.studentId) ?? new Set();
      const recentReviewees = recentRevieweesByReviewer.get(reviewer.studentId) ?? new Set();
      const target = chooseCandidate({ candidates, reviewer, topicKeys, markedIds, recentReviewees, currentDate, cohort });
      return target ? { reviewer, target } : null;
    })
    .filter(Boolean);
};
