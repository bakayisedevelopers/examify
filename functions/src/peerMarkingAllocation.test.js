import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAssignments } from './peerMarkingAllocation.js';

const today = '2026-10-02';
const cohort = { subject: 'Mathematics', grade: 'Grade 11' };
const topic = 'Linear functions | Functions';
const topicKey = (value) => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const topicNames = (value) => value.split('|').map((item) => item.trim());
const reviewer = { id: 'own-exercise', studentId: 'reviewer-1', ...cohort, assignmentDate: today, topics: topicNames(topic) };
const target = (id, studentId, assignmentDate = today, patch = {}) => ({
  id,
  studentId,
  ...cohort,
  assignmentDate,
  topic,
  submittedImageUrl: `${id}.jpg`,
  submittedFileName: `${id}.jpg`,
  ...patch,
});

const assign = (options = {}) => buildAssignments({
  reviewers: [reviewer],
  topicKeysByReviewer: new Map([[reviewer.studentId, new Set(topicNames(topic).map(topicKey))]]),
  currentDate: today,
  ...cohort,
  ...options,
});

test('the reviewer topics come from their completed exercise for the assignment day', () => {
    const dailyReviewer = { ...reviewer, topics: topicNames('Quadratic functions | Functions') };
    const candidate = target('matching-daily-topic', 'reviewee-1', '2026-09-01', { topic: 'Quadratic functions | Functions' });
  const pairs = assign({
    reviewers: [dailyReviewer],
    topicKeysByReviewer: new Map([[reviewer.studentId, new Set(topicNames('Quadratic functions | Functions').map(topicKey))]]),
    candidates: [candidate],
  });
  assert.equal(pairs[0].target.id, candidate.id);
});

test('fresh work from another learner is preferred, including work from a past date', () => {
  const pairs = assign({ candidates: [
    target('self', reviewer.studentId, today),
    target('past-fresh', 'reviewee-1', '2026-09-01'),
  ] });
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].target.id, 'past-fresh');
});

test('reused work follows the strict older-than 21, 14, 7, then 3 day fallback', () => {
  const candidates = [
    target('age-22', 'reviewee-old', '2026-09-10'),
    target('age-15', 'reviewee-mid', '2026-09-17'),
    target('age-8', 'reviewee-recent', '2026-09-24'),
    target('age-4', 'reviewee-new', '2026-09-28'),
  ];
  const pairs = assign({
    candidates,
    markedExerciseIdsByReviewer: new Map([[reviewer.studentId, new Set(candidates.map((item) => item.id))]]),
  });
  assert.equal(pairs[0].target.id, 'age-22');
});

test('a previously marked item exactly 21 days old is eligible in the older-than-14 tier', () => {
  const candidates = [target('age-21', 'reviewee-1', '2026-09-11')];
  const pairs = assign({
    candidates,
    markedExerciseIdsByReviewer: new Map([[reviewer.studentId, new Set(['age-21'])]]),
  });
  assert.equal(pairs[0].target.id, 'age-21');
});

test('a reused item must be older than three days and more shared topics rank first', () => {
  const tooRecent = target('age-3', 'reviewee-1', '2026-09-29');
  assert.deepEqual(assign({
    candidates: [tooRecent],
    markedExerciseIdsByReviewer: new Map([[reviewer.studentId, new Set([tooRecent.id])]]),
  }), []);

  const secondTopic = 'Quadratic functions | Functions';
  const multiTopicReviewer = { ...reviewer, topics: [...topicNames(topic), ...topicNames(secondTopic)] };
  const oneTopicTarget = target('one-topic', 'reviewee-1', today, { topics: ['Linear functions'], topic: 'Linear functions' });
  const twoTopicTarget = target('two-topics', 'reviewee-2', today, { topics: [...topicNames(topic), ...topicNames(secondTopic)] });
  const pairs = assign({
    reviewers: [multiTopicReviewer],
    topicKeysByReviewer: new Map([[reviewer.studentId, new Set([...topicNames(topic), ...topicNames(secondTopic)].map(topicKey))]]),
    candidates: [oneTopicTarget, twoTopicTarget],
  });
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].target.id, 'two-topics');

  const oneSharedTopicPair = assign({
    reviewers: [multiTopicReviewer],
    topicKeysByReviewer: new Map([[reviewer.studentId, new Set([...topicNames(topic), ...topicNames(secondTopic)].map(topicKey))]]),
    candidates: [oneTopicTarget],
  });
  assert.equal(oneSharedTopicPair[0].target.id, 'one-topic');
});

test('when there is no submitted exercise with a shared topic, an unrelated eligible exercise is assigned', () => {
  const unrelated = target('unrelated', 'reviewee-1', today, { topics: ['Different topic'], topic: 'Different topic' });
  const shared = target('z-shared', 'reviewee-2', today);
  const pairs = assign({ candidates: [unrelated, shared] });
  assert.equal(pairs[0].target.id, shared.id);

  const fallback = assign({ candidates: [unrelated] });
  assert.equal(fallback[0].target.id, unrelated.id);
});

test('a target may be allocated to multiple reviewers while each reviewer gets one task', () => {
  const secondReviewer = { ...reviewer, id: 'own-exercise-2', studentId: 'reviewer-2' };
  const sharedTarget = target('shared-work', 'reviewee-1', '2026-09-25');
  const pairs = assign({
    reviewers: [reviewer, secondReviewer],
    candidates: [sharedTarget],
    topicKeysByReviewer: new Map([
      [reviewer.studentId, new Set([topic.toLowerCase()])],
      [secondReviewer.studentId, new Set([topic.toLowerCase()])],
    ]),
  });
  assert.equal(pairs.length, 2);
  assert.deepEqual(pairs.map((pair) => pair.target.id), ['shared-work', 'shared-work']);
});

test('self-work, cross-subject, cross-grade, and already-assigned reviewers are excluded', () => {
  const pairs = assign({
    assignedReviewerIds: new Set([reviewer.studentId]),
    candidates: [
      target('self', reviewer.studentId),
      target('other-grade', 'reviewee-1', today, { grade: 'Grade 10' }),
      target('other-subject', 'reviewee-2', today, { subject: 'Physical Sciences' }),
    ],
  });
  assert.deepEqual(pairs, []);
});
