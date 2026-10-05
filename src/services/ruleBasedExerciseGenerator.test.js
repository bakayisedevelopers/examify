import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildRuleBasedExercisePlan,
  createExerciseDateWindow,
  getExerciseGenerationDayCount,
} from './ruleBasedExerciseGenerator.js';

const dates = createExerciseDateWindow('2026-10-05', 7);
const topicQuestions = (topic, count, paperId = topic) => Array.from({ length: count }, (_, index) => ({
  topic,
  paperId,
  questionReference: `${topic}-Q${index + 1}`,
  pageNumber: index + 1,
  marks: 2,
}));

test('exercise window expands in seven-day blocks from completed topic count and caps at 30 days', () => {
  assert.equal(getExerciseGenerationDayCount(1), 7);
  assert.equal(getExerciseGenerationDayCount(3), 7);
  assert.equal(getExerciseGenerationDayCount(4), 14);
  assert.equal(getExerciseGenerationDayCount(7), 21);
  assert.equal(getExerciseGenerationDayCount(100), 30);
  assert.deepEqual(createExerciseDateWindow('2026-09-29', 3), ['2026-09-29', '2026-09-30', '2026-10-01']);
});

test('exercise date window rejects malformed dates and non-finite lengths instead of normalizing them', () => {
  assert.deepEqual(createExerciseDateWindow('2026-02-30', 7), []);
  assert.deepEqual(createExerciseDateWindow('2026-10-5', 7), []);
  assert.deepEqual(createExerciseDateWindow('2026-10-05', Number.POSITIVE_INFINITY), []);
});

test('planner fills all target slots by reusing recent questions across dates, never within one exercise', () => {
  const questions = [...topicQuestions('Algebra', 4), ...topicQuestions('Fractions', 4)];
  const recent = questions.map(({ paperId, questionReference }) => ({ paperId, questionReference }));
  const plan = buildRuleBasedExercisePlan({
    topicSummaries: [
      { topic: 'Algebra', topicStatus: 'done', understandingLevel: 0.8 },
      { topic: 'Fractions', topicStatus: 'done', understandingLevel: 0.6 },
    ],
    indexedQuestions: questions,
    assignmentDates: dates,
    targetQuestionsPerExercise: 4,
    recentlyUsedQuestionKeys: recent,
    matchesTopic: (question, topic) => question.topic === topic,
  });

  assert.equal(plan.recommendations.length, 7);
  assert.ok(plan.recommendations.every((day) => day.questions.length === 4));
  assert.ok(plan.recommendations.every((day) => new Set(day.questions.map((question) => `${question.paperId}::${question.questionReference}`)).size === 4));
  assert.ok(plan.repeatedRecentQuestionCount > 0);
  assert.equal(plan.totalQuestionShortage, 0);
});

test('planner avoids repeating any paper-question pair across the generation when enough unique indexes exist', () => {
  const plan = buildRuleBasedExercisePlan({
    topicSummaries: [{ topic: 'Algebra', topicStatus: 'done', understandingLevel: 0.7 }],
    indexedQuestions: topicQuestions('Algebra', 14, 'paper-1'),
    assignmentDates: dates,
    targetQuestionsPerExercise: 2,
    matchesTopic: (question, topic) => question.topic === topic,
  });
  const usedPairs = plan.recommendations.flatMap((day) => day.questions)
    .map((question) => `${question.paperId}::${question.questionReference}`);

  assert.equal(usedPairs.length, 14);
  assert.equal(new Set(usedPairs).size, 14);
  assert.equal(plan.repeatedWithinGenerationQuestionCount, 0);
});

test('planner can use analyzed questions from more than four source papers', () => {
  const questions = Array.from({ length: 7 }, (_, index) => ({
    topic: 'Algebra',
    paperId: `paper-${index + 1}`,
    questionReference: `Q${index + 1}`,
    pageNumber: index + 1,
  }));
  const plan = buildRuleBasedExercisePlan({
    topicSummaries: [{ topic: 'Algebra', topicStatus: 'done', understandingLevel: 0.8 }],
    indexedQuestions: questions,
    assignmentDates: [dates[0]],
    targetQuestionsPerExercise: 7,
    matchesTopic: (question, topic) => question.topic === topic,
  });

  assert.equal(plan.recommendations[0].questions.length, 7);
  assert.equal(new Set(plan.recommendations[0].questions.map((question) => question.paperId)).size, 7);
});

test('planner prefers a fresh topic when doing so preserves the weighted topic quotas', () => {
  const recentQuestion = { topic: 'Strong topic', paperId: 'paper-strong', questionReference: 'Q1', pageNumber: 1 };
  const freshQuestion = { topic: 'Developing topic', paperId: 'paper-developing', questionReference: 'Q1', pageNumber: 1 };
  const plan = buildRuleBasedExercisePlan({
    topicSummaries: [
      { topic: 'Strong topic', topicStatus: 'done', understandingLevel: 0.5 },
      { topic: 'Developing topic', topicStatus: 'done', understandingLevel: 0.5 },
    ],
    indexedQuestions: [recentQuestion, freshQuestion],
    assignmentDates: dates.slice(0, 2),
    targetQuestionsPerExercise: 1,
    recentlyUsedQuestionKeys: [{ paperId: recentQuestion.paperId, questionReference: recentQuestion.questionReference }],
    matchesTopic: (question, topic) => question.topic === topic,
  });

  const selectedTopics = plan.recommendations.map((day) => day.questions[0].topic).sort();
  assert.deepEqual(selectedTopics, ['Developing topic', 'Strong topic']);
  assert.equal(plan.recommendations[0].questions[0].topic, 'Developing topic');
  assert.equal(plan.repeatedRecentQuestionCount, 1);
});

test('topics without a recorded understanding score receive a neutral weight', () => {
  const plan = buildRuleBasedExercisePlan({
    topicSummaries: [
      { topic: 'Scored topic', topicStatus: 'done', understandingLevel: 0.5 },
      { topic: 'Unscored topic', topicStatus: 'done', understandingLevel: null },
    ],
    indexedQuestions: [
      ...topicQuestions('Scored topic', 7),
      ...topicQuestions('Unscored topic', 7),
    ],
    assignmentDates: dates,
    targetQuestionsPerExercise: 2,
    matchesTopic: (question, topic) => question.topic === topic,
  });
  const counts = plan.recommendations.flatMap((day) => day.questions).reduce((result, question) => {
    result[question.topic] = (result[question.topic] ?? 0) + 1;
    return result;
  }, {});

  assert.equal(counts['Scored topic'], 7);
  assert.equal(counts['Unscored topic'], 7);
});

test('question indexes with non-integer page numbers are discarded', () => {
  const plan = buildRuleBasedExercisePlan({
    topicSummaries: [{ topic: 'Algebra', topicStatus: 'done', understandingLevel: 0.7 }],
    indexedQuestions: [{ topic: 'Algebra', paperId: 'paper-1', questionReference: 'Q1', pageNumber: 1.5 }],
    assignmentDates: [dates[0]],
    targetQuestionsPerExercise: 1,
    matchesTopic: (question, topic) => question.topic === topic,
  });

  assert.equal(plan.indexedQuestionCount, 0);
  assert.equal(plan.recommendations.length, 0);
  assert.equal(plan.totalQuestionShortage, 1);
});

test('question-count reduction is the final fallback after all distinct indexed pairs are exhausted', () => {
  const plan = buildRuleBasedExercisePlan({
    topicSummaries: [{ topic: 'Geometry', topicStatus: 'done', understandingLevel: 0.5 }],
    indexedQuestions: topicQuestions('Geometry', 3, 'paper-1'),
    assignmentDates: dates,
    targetQuestionsPerExercise: 4,
    matchesTopic: (question, topic) => question.topic === topic,
  });

  assert.ok(plan.recommendations.every((day) => day.questions.length === 3));
  assert.equal(plan.totalQuestionShortage, 7);
  assert.equal(plan.needsMorePaperAnalysis, true);
  assert.ok(plan.recommendations.every((day) => new Set(day.questions.map((question) => `${question.paperId}::${question.questionReference}`)).size === day.questions.length));
});

test('higher understanding topics get a larger share and marked topics are capped twice per seven-day block', () => {
  const twoWeeks = createExerciseDateWindow('2026-10-05', 14);
  const plan = buildRuleBasedExercisePlan({
    topicSummaries: [
      { topic: 'Strong topic', topicStatus: 'done', understandingLevel: 0.9 },
      { topic: 'Developing topic', topicStatus: 'done', understandingLevel: 0.1 },
      { topic: 'Marked topic', topicStatus: 'marked', understandingLevel: 0.99 },
    ],
    indexedQuestions: [
      ...topicQuestions('Strong topic', 4),
      ...topicQuestions('Developing topic', 4),
      ...topicQuestions('Marked topic', 4),
    ],
    assignmentDates: twoWeeks,
    targetQuestionsPerExercise: 3,
    matchesTopic: (question, topic) => question.topic === topic,
  });
  const topicCounts = plan.recommendations.flatMap((day) => day.questions).reduce((counts, question) => {
    counts[question.topic] = (counts[question.topic] ?? 0) + 1;
    return counts;
  }, {});
  const markedPerWeek = [0, 1].map((week) => plan.recommendations
    .slice(week * 7, week * 7 + 7)
    .flatMap((day) => day.questions)
    .filter((question) => question.topic === 'Marked topic').length);

  assert.ok(topicCounts['Strong topic'] > topicCounts['Developing topic']);
  assert.deepEqual(markedPerWeek, [2, 2]);
});
