export const normalizeExerciseTopicKey = (value) => String(value ?? '')
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/[^a-z0-9|]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const normalise = normalizeExerciseTopicKey;
const questionReference = (value) => normalizeExerciseTopicKey(value?.questionReference || value?.reference);
const topicText = (value) => String(value?.topic ?? value ?? '').trim();
const uniqueTopics = (values = []) => [...new Map(values.map(topicText).filter(Boolean)
  .map((topic) => [normalizeExerciseTopicKey(topic), topic])).values()];

const matchingBreakdownTopic = (link, breakdown = []) => {
  const reference = questionReference(link);
  if (!reference) return '';
  const paperId = String(link?.paperId ?? '').trim();
  const match = breakdown.find((item) => questionReference(item) === reference
    && (!paperId || !item?.paperId || paperId === String(item.paperId).trim()));
  return topicText(match);
};

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

export const getExerciseQuestionLinks = (exercise = {}) => {
  const links = Array.isArray(exercise.questionLinks) ? exercise.questionLinks : [];
  const breakdown = Array.isArray(exercise.topicBreakdown) ? exercise.topicBreakdown : [];
  if (links.length) {
    return links.map((link) => {
      const linkTopic = topicText(link);
      const breakdownTopic = matchingBreakdownTopic(link, breakdown);
      const topic = linkTopic.includes('|') ? linkTopic
        : breakdownTopic.includes('|') ? breakdownTopic
          : linkTopic || breakdownTopic;
      return { ...link, topic };
    });
  }
  return [];
};

export const getExerciseTopicNames = (exercise = {}) => {
  const questionTopics = uniqueTopics(getExerciseQuestionLinks(exercise).map((item) => item.topic));
  if (questionTopics.length) return questionTopics;

  const breakdown = Array.isArray(exercise.topicBreakdown) ? exercise.topicBreakdown : [];
  if (breakdown.length) return uniqueTopics(breakdown.map((item) => item?.topic));

  const declaredTopics = uniqueTopics(exercise.topics);
  if (declaredTopics.length) return declaredTopics;
  // Canonical topic labels use `|` internally; retain the field as one topic.
  return uniqueTopics([exercise.topic]);
};

export const getExerciseTopicKeys = (exercise = {}) => {
  const hasStructuredTopics = [exercise.questionLinks, exercise.topicBreakdown, exercise.topics]
    .some((value) => Array.isArray(value) && value.length > 0);
  // Legacy peer-allocation records have only a combined topic string. Preserve
  // its historical matching behavior for ranking, while structured records use
  // the complete canonical topic labels used by the score table.
  const legacyTopicParts = !hasStructuredTopics && String(exercise.topic ?? '').includes('|')
    ? String(exercise.topic).split('|')
    : [];
  const names = legacyTopicParts.length ? legacyTopicParts : getExerciseTopicNames(exercise);
  return new Set(names.map(normalise).filter(Boolean));
};

const candidateMatches = (candidate, reviewer, { grade, subject }) => {
  if (!candidate.studentId || candidate.studentId === reviewer.studentId) return false;
  if (String(candidate.grade ?? '') !== String(grade ?? '') || normalise(candidate.subject) !== normalise(subject)) return false;
  if (!dateKey(candidate.assignmentDate) || dateKey(candidate.assignmentDate) > dateKey(reviewer.assignmentDate)) return false;
  if (!(candidate.submittedImageUrl && candidate.submittedFileName) && !candidate.submittedImages?.some((image) => image?.url)) return false;
  return true;
};

const chooseCandidate = ({ candidates, reviewer, topicKeys, markedIds, recentReviewees, currentDate, cohort }) => {
  const eligible = candidates
    .filter((candidate) => candidateMatches(candidate, reviewer, cohort))
    .filter((candidate, index, list) => list.findIndex((item) => item.id === candidate.id) === index);
  const shared = eligible.filter((candidate) => [...getExerciseTopicKeys(candidate)].some((topic) => topicKeys.has(topic)));
  const pools = shared.length
    ? [shared, eligible.filter((candidate) => !shared.includes(candidate))]
    : [eligible];
  const sharedCount = (candidate) => [...getExerciseTopicKeys(candidate)].filter((topic) => topicKeys.has(topic)).length;

  const rank = (left, right, preferOlder = false) => {
    const topicMatchDifference = sharedCount(right) - sharedCount(left);
    if (topicMatchDifference) return topicMatchDifference;
    const leftRevieweeSeen = recentReviewees.has(left.studentId) ? 1 : 0;
    const rightRevieweeSeen = recentReviewees.has(right.studentId) ? 1 : 0;
    if (leftRevieweeSeen !== rightRevieweeSeen) return leftRevieweeSeen - rightRevieweeSeen;
    const leftDate = String(left.assignmentDate ?? '');
    const rightDate = String(right.assignmentDate ?? '');
    const dateCompare = leftDate.localeCompare(rightDate);
    if (dateCompare) return preferOlder ? dateCompare : -dateCompare;
    return String(left.id).localeCompare(String(right.id));
  };

  for (const pool of pools) {
    const fresh = pool.filter((candidate) => !markedIds.has(candidate.id)).sort((left, right) => rank(left, right));
    if (fresh.length) return fresh[0];

    const repeated = pool.filter((candidate) => markedIds.has(candidate.id));
    for (const minimumAge of [21, 14, 7, 3]) {
      const available = repeated.filter((candidate) => ageInDays(currentDate, candidate.assignmentDate) > minimumAge)
        .sort((left, right) => rank(left, right, true));
      if (available.length) return available[0];
    }
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
