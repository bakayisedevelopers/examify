import assert from 'node:assert/strict';
import test from 'node:test';
import { buildLessonTopicScores, nextTopicRollup } from './lessonPersistence.js';

test('completed lessons require one tutor score per covered topic', () => {
  assert.deepEqual(buildLessonTopicScores({
    completed: true,
    topics: ['Algebra', 'Functions'],
    topicUnderstandingScores: [
      { topic: 'Algebra', understandingLevel: 8 },
      { topic: 'Functions', understandingLevel: 6 },
    ],
  }), [
    { topic: 'Algebra', understandingLevel: 8 },
    { topic: 'Functions', understandingLevel: 6 },
  ]);
  assert.throws(() => buildLessonTopicScores({
    completed: true,
    topics: ['Algebra', 'Functions'],
    topicUnderstandingScores: [{ topic: 'Algebra', understandingLevel: 8 }],
  }), /score from 0 to 10/);
});

test('missed lessons do not create topic score entries', () => {
  assert.deepEqual(buildLessonTopicScores({
    completed: false,
    topics: ['Algebra'],
    topicUnderstandingScores: [{ topic: 'Algebra', understandingLevel: 8 }],
  }), []);
});

test('topic rollups include each new immutable lesson score', () => {
  assert.deepEqual(nextTopicRollup({ understandingLevel: 6, scoreCount: 2 }, 9), {
    understandingLevel: 7,
    scoreCount: 3,
    latestScore: 9,
  });
  assert.deepEqual(nextTopicRollup({}, 8), {
    understandingLevel: 8,
    scoreCount: 1,
    latestScore: 8,
  });
});
