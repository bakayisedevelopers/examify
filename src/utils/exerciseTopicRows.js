const normalizeTopic = (value) => String(value ?? '').trim().toLocaleLowerCase();
const topicName = (value) => String(value?.topic ?? value ?? '').trim();
const questionReference = (question) => normalizeTopic(question?.questionReference || question?.reference);

export const uniqueTopicNames = (values = []) => [...new Map(values
  .map(topicName)
  .filter(Boolean)
  .map((topic) => [normalizeTopic(topic), topic])).values()];

const matchingBreakdownTopic = (link, topicBreakdown) => {
  const reference = questionReference(link);
  if (!reference) return '';
  const paperId = String(link?.paperId ?? '').trim();
  const match = topicBreakdown.find((item) => questionReference(item) === reference
    && (!paperId || !item?.paperId || paperId === String(item.paperId).trim()));
  return topicName(match);
};

/**
 * Keep question links aligned with their structured topic breakdown. Some legacy
 * records have the canonical child | parent label in one field and child-only
 * labels in the other; the richer canonical label is the topic key used by scores.
 */
export const getTopicQuestionLinks = (questionLinks = [], topicBreakdown = []) => {
  const links = Array.isArray(questionLinks) && questionLinks.length
    ? questionLinks
    : Array.isArray(topicBreakdown) ? topicBreakdown : [];
  const breakdown = Array.isArray(topicBreakdown) ? topicBreakdown : [];

  return links.map((link) => {
    const linkedTopic = topicName(link);
    const breakdownTopic = matchingBreakdownTopic(link, breakdown);
    const topic = linkedTopic.includes('|')
      ? linkedTopic
      : breakdownTopic.includes('|')
        ? breakdownTopic
        : linkedTopic || breakdownTopic;
    return { ...link, topic };
  });
};

const structuredTopicNames = (questionLinks, topicBreakdown) => {
  const links = getTopicQuestionLinks(questionLinks, topicBreakdown);
  const linkedNames = uniqueTopicNames(links.map((item) => item.topic));
  if (linkedNames.length) return linkedNames;
  return uniqueTopicNames((Array.isArray(topicBreakdown) ? topicBreakdown : []).map((item) => item.topic));
};

export const getExerciseTopicNames = (exercise = {}) => {
  const structuredNames = structuredTopicNames(exercise.questionLinks, exercise.topicBreakdown);
  if (structuredNames.length) return structuredNames;

  const declaredTopics = uniqueTopicNames(exercise.topics);
  if (declaredTopics.length) return declaredTopics;

  // `topic` may contain canonical labels using `|` internally, so keep it whole.
  return uniqueTopicNames([exercise.topic]);
};

export const getPeerMarkingTopicNames = (assignment = {}) => {
  const structuredNames = structuredTopicNames(assignment.questionLinks, assignment.topicBreakdown);
  if (structuredNames.length) return structuredNames;

  const declaredTopics = uniqueTopicNames(assignment.topics);
  if (declaredTopics.length) return declaredTopics;

  // As with exercises, don't split a legacy value whose separator is ambiguous.
  return uniqueTopicNames([assignment.topic]);
};
