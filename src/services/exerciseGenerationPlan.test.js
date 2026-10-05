import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getCurrentGenerationNumber,
  getEligibleExerciseTopics,
  getExerciseGenerationMode,
  fillMissingPlannedQuestionsFromIndexes,
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

test('generation eligibility includes all done topics and marked-only topics at 70 percent or higher', () => {
  const topics = getEligibleExerciseTopics([
    { topic: 'Done without recent score', topicStatus: 'done', understandingLevel: null },
    { topic: 'Marked at threshold', topicStatus: 'marked', understandingLevel: 0.7 },
    { topic: 'Marked above threshold', topicStatus: 'marked', understandingLevel: 0.84 },
    { topic: 'Marked below threshold', topicStatus: 'marked', understandingLevel: 0.69 },
  ]);
  assert.deepEqual(topics.map((topic) => topic.topic), [
    'Done without recent score', 'Marked at threshold', 'Marked above threshold',
  ]);
});

test('a marked-only topic can be planned no more than twice in a seven-day generation', () => {
  const marked = { topic: 'Marked topic', topicStatus: 'marked', understandingLevel: 0.75 };
  const done = { topic: 'Done topic', topicStatus: 'done', understandingLevel: 0.5 };
  const usageCounts = new Map();
  const plan = Array.from({ length: 7 }, (_, dayIndex) => selectTopicsForExerciseDay({
    topicSummaries: [marked, done],
    maxTopicsPerDay: 1,
    dayIndex,
    generationNumber: 1,
    topicUsageCounts: usageCounts,
    markedTopicUsageLimit: 2,
  }));
  assert.equal(plan.flat().filter((topic) => topic === marked.topic).length, 2);
  assert.ok(plan.every((topics) => topics.length === 1));
});
