import assert from 'node:assert/strict';
import test from 'node:test';
import { getCurrentGenerationNumber, getGenerationWeekForTrigger, getRegenerationState, getSevenDayWindow } from './exerciseGenerationPlan.js';

test('generation week advances from the greatest recorded week', () => {
  assert.equal(getCurrentGenerationNumber([{ generationWeek: 1 }, { generationWeek: 3 }, { generationWeek: 2 }]), 3);
  assert.equal(getCurrentGenerationNumber([{ generationMode: 'initial', generationBatchId: 'initial-1' }]), 1);
  assert.equal(getCurrentGenerationNumber([
    { generationMode: 'initial', generationBatchId: 'initial-1' },
    { generationMode: 'weekly', generationBatchId: 'weekly-1' },
  ]), 2);
  assert.equal(getCurrentGenerationNumber([], 4), 4);
});

test('seven-day regeneration window starts today and crosses month boundaries', () => {
  assert.deepEqual(getSevenDayWindow('2026-09-29'), [
    '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05',
  ]);
});

test('completed exercises consume that date capacity while pending ones remain replaceable', () => {
  const state = getRegenerationState({
    assignmentDates: ['2026-09-30', '2026-10-01'],
    generationNumber: 2,
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

test('daily limit increases from week 1 to 2 to 3 and stays capped thereafter', () => {
  assert.equal(getRegenerationState({ generationNumber: 1 }).dailyLimit, 1);
  assert.equal(getRegenerationState({ generationNumber: 2 }).dailyLimit, 2);
  assert.equal(getRegenerationState({ generationNumber: 3 }).dailyLimit, 3);
  assert.equal(getRegenerationState({ generationNumber: 8 }).dailyLimit, 3);
});

test('initial and manual triggers keep their week while lesson completion advances it', () => {
  assert.equal(getGenerationWeekForTrigger(7, { initial: true }), 1);
  assert.equal(getGenerationWeekForTrigger(2), 2);
  assert.equal(getGenerationWeekForTrigger(1, { lessonCompleted: true }), 2);
  assert.equal(getGenerationWeekForTrigger(2, { lessonCompleted: true }), 3);
  assert.equal(getGenerationWeekForTrigger(3, { lessonCompleted: true }), 4);
});
