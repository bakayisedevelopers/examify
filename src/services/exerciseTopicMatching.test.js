import assert from 'node:assert/strict';
import test from 'node:test';
import { questionMatchesTopics, topicLabelsMatch } from './exerciseTopicMatching.js';

test('matches exact canonical labels without case, punctuation, or accent sensitivity', () => {
  assert.equal(topicLabelsMatch('Quadratic functions | Functions', 'QUADRATIC FUNCTIONS | Functions'), true);
  assert.equal(topicLabelsMatch('Geometric sequences | Number Patterns', 'Geometric sequences | Number Patterns'), true);
  assert.equal(topicLabelsMatch('Fractions | Fraction Concepts', 'Fractions | Fraction Concepts'), true);
});

test('matches legacy child-only labels to their canonical topic', () => {
  assert.equal(topicLabelsMatch('Fractions', 'Fractions | Fraction Concepts'), true);
  assert.equal(topicLabelsMatch('Quadratic functions | Functions', 'Quadratic functions'), true);
});

test('does not match sibling topics merely because they share a parent or generic word', () => {
  assert.equal(topicLabelsMatch('Linear Equations | Algebra', 'Quadratic Equations | Algebra'), false);
  assert.equal(topicLabelsMatch('Linear equations', 'Quadratic equations'), false);
  assert.equal(topicLabelsMatch('Linear functions | Functions', 'Quadratic functions | Functions'), false);
});

test('question topic arrays match the specific topic and ignore a broad unrelated topic field', () => {
  assert.equal(questionMatchesTopics({
    topic: 'Algebra',
    topics: ['Quadratic functions | Functions'],
  }, ['Quadratic functions | Functions']), true);
  assert.equal(questionMatchesTopics({
    topic: 'Linear equations | Algebra',
    topics: ['Linear equations | Algebra'],
  }, ['Quadratic equations | Algebra']), false);
  assert.equal(questionMatchesTopics({ topic: 'Fractions' }, ['Fractions | Fraction Concepts']), true);
});
