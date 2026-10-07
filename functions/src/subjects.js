// Keep this allowlist aligned with CAPS_SUBJECTS in src/data/capsTopicCatalog.js.
export const SUPPORTED_SUBJECTS = [
  'Mathematics',
  'Mathematical Literacy',
  'Life Sciences',
  'Accounting',
  'Business Studies',
  'Economics',
  'History',
  'Geography',
  'Computer Applications Technology',
  'Information Technology',
  'Engineering Graphics and Design',
  'Agricultural Sciences',
  'Tourism',
  'Consumer Studies',
  'Dramatic Arts',
  'Visual Arts',
  'Music',
  'Physical Sciences',
  'Natural Sciences',
  'English Home Language',
  'English First Additional Language',
  'Afrikaans Home Language',
  'Afrikaans First Additional Language',
  'isiZulu Home Language',
  'isiXhosa Home Language',
  'Sepedi Home Language',
  'Setswana Home Language',
  'Sesotho Home Language',
];

const normalizeComparable = (value) => String(value ?? '')
  .toLowerCase()
  .replace(/&/g, 'and')
  .replace(/[^a-z0-9]+/g, ' ')
  .trim()
  .replace(/\s+/g, ' ');

const SUBJECT_ALIASES = {
  Mathematics: ['maths', 'math'],
  'Mathematical Literacy': ['maths literacy', 'math lit', 'mathematics literacy', 'math literacy'],
  'Physical Sciences': ['physical science', 'physics', 'chemistry'],
  'Natural Sciences': ['natural science'],
  'Life Sciences': ['life science', 'biology'],
  'Computer Applications Technology': ['cat', 'computer application technology'],
  'Information Technology': ['it', 'computer science'],
  'Engineering Graphics and Design': ['egd', 'engineering graphics design'],
  'Agricultural Sciences': ['agricultural science', 'agriculture'],
  'Dramatic Arts': ['drama'],
  'Visual Arts': ['visual art'],
  'English Home Language': ['english hl', 'english home lang'],
  'English First Additional Language': ['english fal', 'english first additional lang'],
  'Afrikaans Home Language': ['afrikaans hl', 'afrikaans home lang'],
  'Afrikaans First Additional Language': ['afrikaans fal', 'afrikaans first additional lang'],
  'isiZulu Home Language': ['zulu home language', 'isizulu hl'],
  'isiXhosa Home Language': ['xhosa home language', 'isixhosa hl'],
  'Sepedi Home Language': ['sepedi hl'],
  'Setswana Home Language': ['setswana hl'],
  'Sesotho Home Language': ['sesotho hl'],
};

const SUBJECT_LOOKUP = new Map(SUPPORTED_SUBJECTS.flatMap((subject) => [
  [normalizeComparable(subject), subject],
  ...(SUBJECT_ALIASES[subject] ?? []).map((alias) => [normalizeComparable(alias), subject]),
]));

export const normalizeSupportedSubject = (value) => SUBJECT_LOOKUP.get(normalizeComparable(value)) ?? null;

export const getTutorSubjectsAutoGrantedByMarks = (marks = [], minimumMark = 60) => {
  const hasQualifiedMathematics = (Array.isArray(marks) ? marks : []).some((item) =>
    normalizeSupportedSubject(item?.subject ?? item?.rawSubject) === 'Mathematics'
      && Number.isFinite(Number(item?.mark)) && Number(item.mark) >= minimumMark);
  return hasQualifiedMathematics ? ['Mathematical Literacy'] : [];
};

const LOWER_GRADE_SUBJECTS = new Set([
  'Mathematics',
  'Natural Sciences',
  'English Home Language',
  'English First Additional Language',
  'Afrikaans Home Language',
  'Afrikaans First Additional Language',
  'isiZulu Home Language',
  'isiXhosa Home Language',
  'Sepedi Home Language',
  'Setswana Home Language',
  'Sesotho Home Language',
]);

// Keep the student picker and callable validation aligned with the CAPS
// grade bands used by this app: Mathematics/languages in Grades 4–12,
// Natural Sciences in Grades 4–9, and the remaining supported subjects in
// Grades 10–12. Historical subject episodes are retained independently.
export const isSubjectAvailableForGrade = (subjectValue, gradeValue) => {
  const subject = normalizeSupportedSubject(subjectValue);
  const gradeMatch = String(gradeValue ?? '').trim().match(/^Grade\s+(\d{1,2})$/i);
  const grade = gradeMatch ? Number(gradeMatch[1]) : NaN;
  if (!subject || !Number.isInteger(grade) || grade < 4 || grade > 12) return false;
  if (grade <= 9) return LOWER_GRADE_SUBJECTS.has(subject);
  return subject !== 'Natural Sciences';
};

export const getSubjectsAvailableForGrade = (grade, subjects = []) =>
  [...new Set((Array.isArray(subjects) ? subjects : [])
    .map(normalizeSupportedSubject)
    .filter((subject) => subject && isSubjectAvailableForGrade(subject, grade)))];
