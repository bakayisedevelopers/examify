const normalizeTopic = (value) => String(value ?? '').trim().toLocaleLowerCase();
const topicName = (value) => String(value?.topic ?? value ?? '').trim();
const questionReference = (question) => normalizeTopic(question?.questionReference || question?.reference);

export const uniqueTopicNames = (values = []) => [...new Map(values
  .map(topicName)
  .filter(Boolean)
  .map((topic) => [normalizeTopic(topic), topic])).values()];

const matchingBreakdownEntry = (link, topicBreakdown) => {
  const reference = questionReference(link);
  if (!reference) return null;
  const paperId = String(link?.paperId ?? '').trim();
  return topicBreakdown.find((item) => questionReference(item) === reference
    && (!paperId || !item?.paperId || paperId === String(item.paperId).trim()));
};

/** Resolve a question's topic from its link, using the breakdown only when missing. */
export const getTopicQuestionLinks = (questionLinks = [], topicBreakdown = []) => {
  const links = Array.isArray(questionLinks) && questionLinks.length
    ? questionLinks
    : Array.isArray(topicBreakdown) ? topicBreakdown : [];
  const breakdown = Array.isArray(topicBreakdown) ? topicBreakdown : [];

  return links.map((link) => {
    const linkedTopic = topicName(link);
    const matchedBreakdown = matchingBreakdownEntry(link, breakdown);
    return {
      ...link,
      topic: linkedTopic || topicName(matchedBreakdown),
      topicId: link?.topicId || link?.canonicalTopicKey || matchedBreakdown?.topicId || matchedBreakdown?.canonicalTopicKey || '',
    };
  });
};

export const getQuestionPaperPath = (question, role = 'student') => {
  if (!question?.paperId) return '';
  const page = Math.max(1, Number(question.pageNumber ?? 1) || 1);
  const params = new URLSearchParams({ page: String(page) });
  const reference = String(question.questionReference || question.reference || '').trim();
  if (reference) params.set('question', reference);
  return `/${role}/papers/${question.paperId}?${params.toString()}`;
};

const structuredTopicNames = (questionLinks, topicBreakdown, questions = []) => {
  const links = getTopicQuestionLinks(questionLinks, topicBreakdown);
  const linkedNames = uniqueTopicNames([
    ...links.map((item) => item.topic),
    ...(Array.isArray(questions) ? questions.map((item) => item?.topic) : []),
  ]);
  if (linkedNames.length) return linkedNames;
  return uniqueTopicNames((Array.isArray(topicBreakdown) ? topicBreakdown : []).map((item) => item.topic));
};

export const getExerciseTopicNames = (exercise = {}) => {
  const structuredNames = structuredTopicNames(exercise.questionLinks, exercise.topicBreakdown, exercise.questions);
  if (structuredNames.length) return structuredNames;

  const declaredTopics = uniqueTopicNames(exercise.topics);
  if (declaredTopics.length) return declaredTopics;

  // `topic` may contain canonical labels using `|` internally, so keep it whole.
  return uniqueTopicNames([exercise.topic]);
};

export const getPeerMarkingTopicNames = (assignment = {}) => {
  const structuredNames = structuredTopicNames(assignment.questionLinks, assignment.topicBreakdown, assignment.questions);
  if (structuredNames.length) return structuredNames;

  const declaredTopics = uniqueTopicNames(assignment.topics);
  if (declaredTopics.length) return declaredTopics;

  // As with exercises, don't split a legacy value whose separator is ambiguous.
  return uniqueTopicNames([assignment.topic]);
};

export const getQuestionTopicIds = (source = {}) => [
  ...getTopicQuestionLinks(source.questionLinks, source.topicBreakdown),
  ...(Array.isArray(source.questions) ? source.questions : []),
]
  .map((question) => String(question?.topicId || question?.canonicalTopicKey || '').trim())
  .filter(Boolean);
