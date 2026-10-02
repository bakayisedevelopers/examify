import assert from 'node:assert/strict';
import test from 'node:test';
import { getTopicCatalog, resolveTopic } from '../data/topicCatalog.js';
import { buildTopicResolverRows } from './topicResolver.js';
import { SUBJECTS } from '../lib/constants.js';

test('topic catalog is scoped to an exact subject and grade', () => {
  const gradeTen = getTopicCatalog({ subject: 'Mathematics', grade: 'Grade 10' });
  const gradeTwelve = getTopicCatalog({ subject: 'Mathematics', grade: 'Grade 12' });

  assert.ok(gradeTen.length > 0);
  assert.ok(gradeTwelve.length > gradeTen.length);
  assert.ok(!gradeTen.some((topic) => topic.canonicalLabel.startsWith('Differentiation |')));
  assert.equal(getTopicCatalog({ subject: 'Mathematics' }).length, 0);
});

test('known mathematics aliases resolve to the canonical child-parent label', () => {
  assert.equal(
    resolveTopic({ topic: 'Quadratic sequence', subject: 'Mathematics', grade: 'Grade 12' })?.canonicalLabel,
    'Quadratic sequences | Number Patterns',
  );
  assert.equal(
    resolveTopic({ topic: 'Scatter plot', subject: 'Mathematics', grade: 'Grade 12' })?.canonicalLabel,
    'Scatter plots | Statistics',
  );
});

test('all internally supported CAPS subjects are present in the subject catalog', () => {
  assert.ok(SUBJECTS.includes('Physical Sciences'));
  assert.ok(SUBJECTS.includes('Natural Sciences'));
  assert.ok(SUBJECTS.includes('Geography'));
  assert.ok(SUBJECTS.includes('English Home Language'));
  assert.ok(getTopicCatalog({ subject: 'Physical Sciences', grade: 'Grade 11' }).length > 0);
  assert.ok(getTopicCatalog({ subject: 'Geography', grade: 'Grade 12' }).length > 0);
  assert.ok(resolveTopic({ topic: 'Newton second law', subject: 'Physical Sciences', grade: 'Grade 11' }));
});

test('Grade 10 and 11 Mathematics wording resolves into available grade topics', () => {
  for (const grade of ['Grade 10', 'Grade 11']) {
    assert.equal(
      resolveTopic({ topic: 'Quadratic patterns in sequences', subject: 'Mathematics', grade })?.canonicalLabel,
      'Quadratic sequences | Number Patterns',
    );
    assert.equal(
      resolveTopic({ topic: 'Scatter diagram analysis', subject: 'Mathematics', grade })?.canonicalLabel,
      'Scatter plots | Statistics',
    );
    assert.equal(
      resolveTopic({ topic: 'Equation of a circle', subject: 'Mathematics', grade })?.canonicalLabel,
      'Equation of a circle | Analytical Geometry',
    );
  }
  assert.equal(
    resolveTopic({ topic: 'Calculus differentiation', subject: 'Mathematics', grade: 'Grade 10' }),
    null,
  );
});

test('text rules remain scoped and leave ambiguous terms for manual review', () => {
  assert.equal(resolveTopic({ topic: 'Equilibrium', subject: 'Physical Sciences', grade: 'Grade 11' }), null);
  assert.equal(resolveTopic({ topic: 'Newton second law', subject: 'Physical Sciences', grade: 'Grade 12' }), null);
  assert.equal(resolveTopic({ topic: 'Scatter diagram analysis', subject: 'Mathematics', grade: 'Grade 12' }), null);
  assert.equal(resolveTopic({ topic: 'Boyle law', subject: 'Mathematics', grade: 'Grade 11' }), null);
});

test('Maths CAPS catalogs are grade scoped and use canonical child-parent labels', () => {
  const grade11 = getTopicCatalog({ subject: 'Mathematics', grade: 'Grade 11' });
  const grade12 = getTopicCatalog({ subject: 'Mathematics', grade: 'Grade 12' });
  assert.ok(grade11.every((entry) => entry.canonicalLabel.includes(' | ')));
  assert.ok(grade12.some((entry) => entry.canonicalLabel === 'Differentiation | Calculus'));
  assert.ok(getTopicCatalog({ subject: 'Geography', grade: 'Grade 12' }).length > 0);
});

test('resolver groups topics by subject and grade and leaves unknown names for review', () => {
  const rows = buildTopicResolverRows([
    { subject: 'Mathematics', grade: 'Grade 12', topic: 'Quadratic sequence', sourceType: 'paper' },
    { subject: 'Mathematics', grade: 'Grade 12', topic: 'Quadratic sequence', sourceType: 'lesson' },
    { subject: 'Mathematics', grade: 'Grade 11', topic: 'Quadratic sequence', sourceType: 'paper' },
    { subject: 'Mathematics', grade: 'Grade 12', topic: 'Novel research project', sourceType: 'paper' },
  ]);

  assert.equal(rows.length, 3);
  assert.equal(rows.find((row) => row.grade === 'Grade 12' && row.sourceTopic === 'Quadratic sequence').occurrenceCount, 2);
  assert.equal(rows.find((row) => row.sourceTopic === 'Novel research project').matchType, 'unmapped');
});

test('saved Maths mappings are restored only while their topic remains in the catalog', () => {
  const rows = buildTopicResolverRows(
    [{ subject: 'Mathematics', grade: 'Grade 12', topic: 'Quadratic sequence' }],
    [{ subject: 'Mathematics', grade: 'Grade 12', sourceTopic: 'Quadratic sequence', canonicalTopic: 'Quadratic sequences | Number Patterns' }],
  );
  assert.equal(rows[0].suggestedTopic, 'Quadratic sequences | Number Patterns');
  assert.equal(rows[0].matchType, 'saved');
  assert.equal(rows[0].isSaved, true);
});
