const normalizeTopicLabel = (value = '') => String(value ?? '')
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLocaleLowerCase()
  .replace(/[^a-z0-9]+/g, ' ')
  .trim();

const getCanonicalTopicParts = (value = '') => {
  const parts = String(value ?? '').split('|').map(normalizeTopicLabel).filter(Boolean);
  return parts.length === 2 ? parts : [normalizeTopicLabel(value)].filter(Boolean);
};

/**
 * Match exact global topic labels (or a legacy child-only label). Deliberately
 * do not match on a shared word or parent alone: sibling topics such as
 * "Linear Equations | Algebra" and "Quadratic Equations | Algebra" must stay
 * separate in generated exercise pools.
 */
export const topicLabelsMatch = (left = '', right = '') => {
  const leftParts = getCanonicalTopicParts(left);
  const rightParts = getCanonicalTopicParts(right);
  if (!leftParts.length || !rightParts.length) return false;

  if (leftParts.length === 2 && rightParts.length === 2) {
    return leftParts[0] === rightParts[0] && leftParts[1] === rightParts[1];
  }
  if (leftParts.length === 2) return rightParts[0] === leftParts[0];
  if (rightParts.length === 2) return leftParts[0] === rightParts[0];
  return leftParts[0] === rightParts[0];
};

export const questionMatchesTopics = (question = {}, completedTopics = []) => {
  const completed = completedTopics.map((topic) => String(topic ?? '').trim()).filter(Boolean);
  if (!completed.length) return true;

  const questionTopics = [
    question.topic,
    ...(Array.isArray(question.topics) ? question.topics : []),
  ].map((topic) => String(topic ?? '').trim()).filter(Boolean);

  return questionTopics.some((questionTopic) =>
    completed.some((completedTopic) => topicLabelsMatch(questionTopic, completedTopic)),
  );
};
