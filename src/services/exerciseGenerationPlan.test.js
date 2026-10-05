import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getCurrentGenerationNumber,
  getEligibleExerciseTopics,
  getExerciseGenerationMode,
  getGenerationWeekForTrigger,
  getRegenerationState,
  getSevenDayWindow,
  hasExerciseGeneration,
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

test('seven-day window starts today and crosses month boundaries', () => {
  assert.deepEqual(getSevenDayWindow('2026-09-29'), [
    '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05',
  ]);
});

test('completed exercises consume that date capacity while pending ones remain replaceable', () => {
  const state = getRegenerationState({
    assignmentDates: ['2026-09-30', '2026-10-01'],
    completedTopicCount: 1,
    maxDailyExercises: 1,
    history: [
      { id: 'done', assignmentDate: '2026-09-30', submitted: 'Yes' },
      { id: 'pending', assignmentDate: '2026-10-01' },
      { id: 'outside-window', assignmentDate: '2026-10-02' },
    ],
  });

  assert.equal(state.dailyLimit, 1);
  assert.deepEqual(state.dailyExerciseCaps, { '2026-09-30': 0, '2026-10-01': 1 });
  assert.deepEqual(state.overrideExerciseIdsByDate, { '2026-09-30': [], '2026-10-01': ['pending'] });
});

test('initial and manual triggers keep their week while lesson completion advances it', () => {
  assert.equal(getGenerationWeekForTrigger(7, { initial: true }), 1);
  assert.equal(getGenerationWeekForTrigger(2), 2);
  assert.equal(getGenerationWeekForTrigger(1, { lessonCompleted: true }), 2);
  assert.equal(getGenerationWeekForTrigger(2, { lessonCompleted: true }), 3);
  assert.equal(getGenerationWeekForTrigger(3, { lessonCompleted: true }), 4);
});

test('done topics and marked topics scoring at least 0.7 are eligible; other states are not', () => {
  const topics = getEligibleExerciseTopics([
    { topic: 'Done without recent score', topicStatus: 'done', understandingLevel: null },
    { topic: 'Marked at threshold', topicStatus: 'marked', understandingLevel: 0.7 },
    { topic: 'Marked below threshold', topicStatus: 'marked', understandingLevel: 0.69 },
    { topic: 'Planned topic', topicStatus: 'planned', understandingLevel: 1 },
  ]);
  assert.deepEqual(topics.map((topic) => topic.topic), ['Done without recent score', 'Marked at threshold']);
});
