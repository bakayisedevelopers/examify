import assert from 'node:assert/strict';
import test from 'node:test';
import { getTopicCatalog, resolveTopic } from '../data/topicCatalog.js';
import { buildTopicResolverRows } from './topicResolver.js';

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

test('Grade 10 and 11 Physical Sciences wording resolves by prioritized text rules', () => {
  const examples = [
    ['Acid-base titration', 'Acids and bases | Chemical Change'],
    ['Acceleration on an inclined plane', 'Forces | Mechanics'],
    ["Newton's Second Law of Motion", "Newton's laws of motion | Mechanics"],
    ["Boyle's law", 'Gases and gas laws | Matter and Materials'],
    ['Electromagnetic induction principles', 'Electromagnetic induction | Electricity and Magnetism'],
    ['Refraction of light', 'Geometrical optics | Waves and Optics'],
    ['Optics', 'Geometrical optics | Waves and Optics'],
    ['Graph gradient', 'Graphs and data analysis | Scientific Investigations'],
    ['Gas volume calculations', 'Stoichiometry and mole calculations | Chemical Change'],
    ['Series and Parallel Circuits', 'Electric circuits | Electricity and Magnetism'],
  ];

  for (const [topic, expected] of examples) {
    const match = resolveTopic({ topic, subject: 'Physical Sciences', grade: 'Grade 11' });
    assert.equal(match?.canonicalLabel, expected, `Grade 11: ${topic}`);
    assert.equal(match?.matchType, 'rule', `Grade 11: ${topic} should be a text-rule match`);
  }

  assert.equal(
    resolveTopic({ topic: 'Acceleration on an inclined plane', subject: 'Physical Sciences', grade: 'Grade 10' })?.canonicalLabel,
    'Kinematics | Mechanics',
  );
  assert.equal(
    resolveTopic({ topic: 'Wavelength', subject: 'Physical Sciences', grade: 'Grade 10' })?.canonicalLabel,
    'Waves and sound | Waves and Optics',
  );
  assert.equal(
    resolveTopic({ topic: 'Balancing chemical equations', subject: 'Physical Sciences', grade: 'Grade 10' })?.canonicalLabel,
    'Chemical equations and formulae | Chemical Change',
  );
  assert.equal(resolveTopic({ topic: "Boyle's law", subject: 'Physical Sciences', grade: 'Grade 10' }), null);
  assert.equal(resolveTopic({ topic: 'Gas laws', subject: 'Physical Sciences', grade: 'Grade 10' }), null);
  assert.equal(resolveTopic({ topic: 'Electromagnetic induction', subject: 'Physical Sciences', grade: 'Grade 10' }), null);
  assert.ok(!getTopicCatalog({ subject: 'Physical Sciences', grade: 'Grade 10' })
    .some((entry) => entry.childTopic === 'Geometrical optics'));
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
