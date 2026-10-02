import assert from 'node:assert/strict';
import test from 'node:test';
import { SUBJECTS } from '../lib/constants.js';
import { SUPPORTED_SUBJECTS } from '../../functions/src/subjects.js';
import {
  extractTutorSubjectMarks,
  getNewEligibleTutorSubjects,
  normalizeEligibleSubject,
} from './tutorSubjects.js';

test('marks extraction accepts every subject in the shared curriculum catalog', () => {
  assert.deepEqual([...SUPPORTED_SUBJECTS].sort(), [...SUBJECTS].sort());
  const jsonRows = JSON.stringify({
    subjects: SUBJECTS.map((subject, index) => ({ subject, mark: 60 + (index % 41) })),
  });
  const extracted = extractTutorSubjectMarks(jsonRows);
  const extractedAfterOcrText = extractTutorSubjectMarks(`OCR transcription [unclear]\n${jsonRows}`);

  assert.deepEqual(extracted.map((item) => item.subject).sort(), [...SUBJECTS].sort());
  assert.deepEqual(extractedAfterOcrText.map((item) => item.subject).sort(), [...SUBJECTS].sort());
  assert.deepEqual(
    getNewEligibleTutorSubjects({ extractedMarks: extracted, existingSubjects: [] }).sort(),
    [...SUBJECTS].sort(),
  );
});

test('marks extraction normalizes common names and abbreviations for supported subjects', () => {
  assert.equal(normalizeEligibleSubject('CAT'), 'Computer Applications Technology');
  assert.equal(normalizeEligibleSubject('EGD'), 'Engineering Graphics and Design');
  assert.equal(normalizeEligibleSubject('English FAL'), 'English First Additional Language');
  assert.deepEqual(
    extractTutorSubjectMarks('CAT 78%\nEGD 81%\nEnglish FAL 74%').map(({ subject }) => subject).sort(),
    ['Computer Applications Technology', 'Engineering Graphics and Design', 'English First Additional Language'].sort(),
  );
});
