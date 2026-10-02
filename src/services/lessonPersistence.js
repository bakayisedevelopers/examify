export const buildLessonTopicScores = ({
  topics = [],
  topicUnderstandingScores = [],
  understandingLevel = null,
  completed = false,
} = {}) => {
  if (!completed) return [];
  const scores = topics.filter(Boolean).map((topic) => {
    const matching = topicUnderstandingScores.find((entry) =>
      String(entry?.topic || '').trim().toLowerCase() === String(topic).trim().toLowerCase());
    const rawScore = matching?.understandingLevel ?? understandingLevel;
    return { topic, understandingLevel: rawScore === null || rawScore === '' || rawScore === undefined ? null : Number(rawScore) };
  });
  if (!scores.length || scores.some((entry) =>
    !Number.isFinite(entry.understandingLevel) || entry.understandingLevel < 0 || entry.understandingLevel > 10)) {
    throw new Error('Enter a tutor understanding score from 0 to 10 for every completed topic.');
  }
  return scores;
};

export const nextTopicRollup = ({ understandingLevel = 0, scoreCount = 0 } = {}, score) => {
  const normalizedCount = Math.max(0, Number(scoreCount) || 0);
  const normalizedScore = Number(score);
  if (!Number.isFinite(normalizedScore) || normalizedScore < 0 || normalizedScore > 10) {
    throw new Error('Topic scores must be between 0 and 10.');
  }
  return {
    understandingLevel: Math.round((((Number(understandingLevel) || 0) * normalizedCount) + normalizedScore) / (normalizedCount + 1)),
    scoreCount: normalizedCount + 1,
    latestScore: normalizedScore,
  };
};
