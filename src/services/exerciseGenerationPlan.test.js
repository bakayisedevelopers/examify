import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getCurrentGenerationNumber,
  getEligibleExerciseTopics,
  getExerciseGenerationMode,
  fillMissingPlannedQuestionsFromIndexes,
  fillTopicSlotsToQuestionCount,
  getGenerationWeekForTrigger,
  getRegenerationState,
  getSevenDayWindow,
  hasExerciseGeneration,
  selectTopicsForExerciseDay,
} from './exerciseGenerationPlan.js';

test('generation week advances from the greatest recorded week', () => {
  assert.equal(getCurrentGenerationNumber([{ generationWeek: 1 }, { generationWeek: 3 }, { generationWeek: 2 }]), 3);
  assert.equal(getCurrentGenerationNumber([{ generationMode: 'initial', generationBatchId: 'initial-1' }]), 1);
  assert.equal(getCurrentGenerationNumber([
    { generationMode: 'initial', generationBatchId: 'initial-1' },
    { generationMode: 'weekly', generationBatchId: 'weekly-1' },
  ]), 2);
  assert.equal(getCurrentGenerationNumber([], 4), 4);
});

test('any existing exercise documents count as a prior generation, including legacy records', () => {
  assert.equal(hasExerciseGeneration([]), false);
  assert.equal(hasExerciseGeneration([{ id: 'legacy-exercise' }]), true);
  assert.equal(hasExerciseGeneration([{ generationMode: 'initial' }]), true);
});

test('lesson completion starts initial generation when no exercises exist and refreshes legacy exercise history', () => {
  assert.equal(getExerciseGenerationMode({ mode: 'weekly', lessonCompleted: true, history: [] }), 'initial');
  assert.equal(getExerciseGenerationMode({ mode: 'weekly', lessonCompleted: true, history: [{ id: 'legacy-exercise' }] }), 'weekly');
  assert.equal(getExerciseGenerationMode({ mode: 'initial', lessonCompleted: false, history: [] }), 'initial');
});

test('a missing topic question is filled from selected analyzed paper indexes without repeating an unused question', () => {
  const plan = {
    perDayTopics: [{ assignmentDate: '2026-10-10', exerciseCount: 1, topics: ['Fractions', 'Decimals', 'Algebra', 'Geometry', 'Measurement'], requiredCount: 5 }],
  };
  const selectedPapers = [{
    id: 'paper-1',
    questions: [
      { topic: 'Fractions', questionReference: 'Q1', pageNumber: 2 },
      { topic: 'Decimals', questionReference: 'Q2', pageNumber: 3 },
      { topic: 'Algebra', questionReference: 'Q3', pageNumber: 4 },
      { topic: 'Geometry', questionReference: 'Q4', pageNumber: 5 },
      { topic: 'Measurement', questionReference: 'Q5', pageNumber: 6 },
      { topic: 'Measurement', questionReference: 'Q6', pageNumber: 7 },
    ],
  }];
  const result = fillMissingPlannedQuestionsFromIndexes({
    recommendations: [{ assignmentDate: '2026-10-10', questions: [
      { topic: 'Fractions', questionReference: 'Q1', paperId: 'paper-1', pageNumber: 2 },
      { topic: 'Decimals', questionReference: 'Q2', paperId: 'paper-1', pageNumber: 3 },
      { topic: 'Algebra', questionReference: 'Q3', paperId: 'paper-1', pageNumber: 4 },
      { topic: 'Geometry', questionReference: 'Q4', paperId: 'paper-1', pageNumber: 5 },
    ] }],
    questionPlan: plan,
    selectedPapers,
    previouslyUsedQuestionReferences: [{ paperId: 'paper-1', questionReference: 'Q5' }],
    isQuestionForTopic: (question, topic) => question.topic === topic,
  });

  assert.equal(result.filledCount, 1);
  assert.deepEqual(result.recommendations[0].questions.map((question) => question.topic), plan.perDayTopics[0].topics);
  assert.equal(result.recommendations[0].questions[4].questionReference, 'Q6');
});

test('indexed-question repair returns the required count from one through five', () => {
  const topicNames = ['Fractions', 'Decimals', 'Algebra', 'Geometry', 'Measurement'];
  const selectedPapers = [{
    id: 'paper-1',
    questions: topicNames.map((topic, index) => ({ topic, questionReference: `Q${index + 1}`, pageNumber: index + 1 })),
  }];

  for (let requiredCount = 1; requiredCount <= 5; requiredCount += 1) {
    const topics = topicNames.slice(0, requiredCount);
    const result = fillMissingPlannedQuestionsFromIndexes({
      recommendations: [],
      questionPlan: { perDayTopics: [{ assignmentDate: '2026-10-10', exerciseCount: 1, topics, requiredCount }] },
      selectedPapers,
      isQuestionForTopic: (question, topic) => question.topic === topic,
    });
    assert.equal(result.recommendations[0].questions.length, requiredCount);
    assert.deepEqual(result.recommendations[0].questions.map((question) => question.topic), topics);
  }
});

test('a limited analyzed-topic set is repeated to preserve the completed-topic question quota', () => {
  assert.deepEqual(fillTopicSlotsToQuestionCount(['Fractions', 'Decimals', 'Algebra'], 4), [
    'Fractions', 'Decimals', 'Algebra', 'Fractions',
  ]);
  assert.deepEqual(fillTopicSlotsToQuestionCount(['Fractions', 'Decimals', 'Algebra', 'Geometry'], 4), [
    'Fractions', 'Decimals', 'Algebra', 'Geometry',
  ]);
  assert.deepEqual(fillTopicSlotsToQuestionCount([], 4), []);
});

test('indexed-question repair repeats a same-topic question on other dates after distinct references run out', () => {
  const dates = ['2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13'];
  const result = fillMissingPlannedQuestionsFromIndexes({
    recommendations: [{ assignmentDate: dates[0], questions: [{
      topic: 'Fractions', questionReference: 'Q1', paperId: 'paper-1', pageNumber: 2,
    }] }],
    questionPlan: { perDayTopics: dates.map((assignmentDate) => ({
      assignmentDate, exerciseCount: 1, topics: ['Fractions'], requiredCount: 1,
    })) },
    selectedPapers: [{ id: 'paper-1', questions: [{ topic: 'Fractions', questionReference: 'Q1', pageNumber: 2 }] }],
    isQuestionForTopic: (question, topic) => question.topic === topic,
  });

  assert.equal(result.recommendations.length, dates.length);
  assert.deepEqual(result.recommendations.map((recommendation) => recommendation.assignmentDate), dates);
  assert.ok(result.recommendations.every((recommendation) => recommendation.questions.length === 1));
  assert.ok(result.recommendations.every((recommendation) => recommendation.questions[0].questionReference === 'Q1'));
});

test('indexed-question repair preserves a repeated topic slot when its only indexed question must repeat', () => {
  const result = fillMissingPlannedQuestionsFromIndexes({
    recommendations: [],
    questionPlan: { perDayTopics: [{
      assignmentDate: '2026-10-10', exerciseCount: 1,
      topics: ['Fractions', 'Decimals', 'Algebra', 'Fractions'], requiredCount: 4,
    }] },
    selectedPapers: [{ id: 'paper-1', questions: [
      { topic: 'Fractions', questionReference: 'F1', pageNumber: 2 },
      { topic: 'Decimals', questionReference: 'D1', pageNumber: 3 },
      { topic: 'Algebra', questionReference: 'A1', pageNumber: 4 },
    ] }],
    isQuestionForTopic: (question, topic) => question.topic === topic,
  });

  assert.equal(result.recommendations[0].questions.length, 4);
  assert.deepEqual(result.recommendations[0].questions.map((question) => question.topic), [
    'Fractions', 'Decimals', 'Algebra', 'Fractions',
  ]);
  assert.deepEqual(result.recommendations[0].questions.map((question) => question.questionReference), ['F1', 'D1', 'A1', 'F1']);
});

test('indexed-question repair removes duplicate, unplanned and extra parent outputs', () => {
  const result = fillMissingPlannedQuestionsFromIndexes({
    recommendations: [
      { assignmentDate: '2026-10-10', questions: [
        { topic: 'Fractions', questionReference: 'Q1', paperId: 'paper-1', pageNumber: 2 },
        { topic: 'Fractions', questionReference: 'Q1', paperId: 'paper-1', pageNumber: 2 },
        { topic: 'Planned lesson topic', questionReference: 'Q9', paperId: 'paper-1', pageNumber: 9 },
      ] },
      { assignmentDate: '2026-10-10', questions: [
        { topic: 'Decimals', questionReference: 'Q2', paperId: 'paper-1', pageNumber: 3 },
      ] },
      { assignmentDate: '2026-10-11', questions: [{ topic: 'Fractions', questionReference: 'Q1' }] },
    ],
    questionPlan: { perDayTopics: [{
      assignmentDate: '2026-10-10', exerciseCount: 1, topics: ['Fractions', 'Decimals'], requiredCount: 2,
    }] },
    selectedPapers: [{ id: 'paper-1', questions: [
      { topic: 'Fractions', questionReference: 'Q1', pageNumber: 2 },
      { topic: 'Decimals', questionReference: 'Q2', pageNumber: 3 },
    ] }],
    isQuestionForTopic: (question, topic) => question.topic === topic,
  });

  assert.equal(result.recommendations.length, 1);
  assert.equal(result.recommendations[0].questions.length, 2);
  assert.deepEqual(result.recommendations[0].questions.map((question) => question.topic), ['Fractions', 'Decimals']);
});

test('seven-day regeneration window starts today and crosses month boundaries', () => {
  assert.deepEqual(getSevenDayWindow('2026-09-29'), [
    '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05',
  ]);
});

test('completed exercises consume that date capacity while pending ones remain replaceable', () => {
  const state = getRegenerationState({
    assignmentDates: ['2026-09-30', '2026-10-01'],
    completedTopicCount: 2,
    history: [
      { id: 'done', assignmentDate: '2026-09-30', submitted: 'Yes' },
      { id: 'pending', assignmentDate: '2026-09-30' },
      { id: 'future', assignmentDate: '2026-10-01' },
    ],
  });

  assert.equal(state.dailyLimit, 2);
  assert.deepEqual(state.dailyExerciseCaps, { '2026-09-30': 1, '2026-10-01': 2 });
  assert.deepEqual(state.overrideExerciseIdsByDate, { '2026-09-30': ['pending'], '2026-10-01': ['future'] });
});

test('daily limit follows completed topics and is capped at five', () => {
  assert.equal(getRegenerationState({ completedTopicCount: 1 }).dailyLimit, 1);
  assert.equal(getRegenerationState({ completedTopicCount: 2 }).dailyLimit, 2);
  assert.equal(getRegenerationState({ completedTopicCount: 3 }).dailyLimit, 3);
  assert.equal(getRegenerationState({ completedTopicCount: 8 }).dailyLimit, 5);
});

test('initial and manual triggers keep their week while lesson completion advances it', () => {
  assert.equal(getGenerationWeekForTrigger(7, { initial: true }), 1);
  assert.equal(getGenerationWeekForTrigger(2), 2);
  assert.equal(getGenerationWeekForTrigger(1, { lessonCompleted: true }), 2);
  assert.equal(getGenerationWeekForTrigger(2, { lessonCompleted: true }), 3);
  assert.equal(getGenerationWeekForTrigger(3, { lessonCompleted: true }), 4);
});

test('generation eligibility includes completed lesson topics and excludes marked and planned topics', () => {
  const topics = getEligibleExerciseTopics([
    { topic: 'Done without recent score', topicStatus: 'done', understandingLevel: null },
    { topic: 'Marked at threshold', topicStatus: 'marked', understandingLevel: 0.7 },
    { topic: 'Planned lesson topic', topicStatus: 'planned', understandingLevel: 1 },
  ]);
  assert.deepEqual(topics.map((topic) => topic.topic), ['Done without recent score']);
});

test('day selection excludes marked and planned topics even when passed directly', () => {
  const marked = { topic: 'Marked topic', topicStatus: 'marked', understandingLevel: 0.75 };
  const planned = { topic: 'Planned topic', topicStatus: 'planned', understandingLevel: 1 };
  const done = { topic: 'Done topic', topicStatus: 'done', understandingLevel: 0.5 };
  const topics = selectTopicsForExerciseDay({
    topicSummaries: [marked, planned, done],
    maxTopicsPerDay: 3,
    dayIndex: 0,
    generationNumber: 1,
  });
  assert.deepEqual(topics, [done.topic]);
});
