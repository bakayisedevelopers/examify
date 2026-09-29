import { SUBJECTS } from '../lib/constants';

const normalizeComparable = (value = '') =>
  String(value)
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');

const SUBJECT_LOOKUP = new Map(
  SUBJECTS.flatMap((subject) => {
    const normalized = normalizeComparable(subject);
    const entries = [[normalized, subject]];

    if (subject === 'Mathematics') entries.push(['maths', subject], ['math', subject]);
    if (subject === 'Mathematical Literacy') entries.push(['maths literacy', subject], ['math lit', subject], ['mathematics literacy', subject]);
    if (subject === 'Physical Sciences') entries.push(['physical science', subject], ['physics', subject], ['chemistry', subject]);
    if (subject === 'Life Sciences') entries.push(['life science', subject], ['biology', subject]);
    if (subject === 'Computer Applications Technology') entries.push(['cat', subject]);
    if (subject === 'Information Technology') entries.push(['it', subject]);
    if (subject === 'Engineering Graphics and Design') entries.push(['egd', subject]);

    return entries;
  }),
);

export const normalizeEligibleSubject = (value) => SUBJECT_LOOKUP.get(normalizeComparable(value)) ?? null;

const parseMark = (value) => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;

  const match = String(value).match(/\d+(?:\.\d+)?/);
  if (!match) return null;

  const mark = Number(match[0]);
  return Number.isFinite(mark) ? mark : null;
};

const stripJsonFences = (value = '') =>
  String(value)
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/i, '')
    .trim();

const extractJsonCandidate = (value = '') => {
  const text = stripJsonFences(value);
  const firstArray = text.indexOf('[');
  const lastArray = text.lastIndexOf(']');
  if (firstArray !== -1 && lastArray > firstArray) return text.slice(firstArray, lastArray + 1);

  const firstObject = text.indexOf('{');
  const lastObject = text.lastIndexOf('}');
  if (firstObject !== -1 && lastObject > firstObject) return text.slice(firstObject, lastObject + 1);

  return text;
};

const collectRows = (parsed) => {
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed?.subjects)) return parsed.subjects;
  if (Array.isArray(parsed?.results)) return parsed.results;
  if (Array.isArray(parsed?.marks)) return parsed.marks;
  return [];
};

const dedupeMarks = (rows = []) => {
  const bestBySubject = new Map();

  rows.forEach((row) => {
    const subject = normalizeEligibleSubject(row.subject ?? row.rawSubject);
    const mark = parseMark(row.mark);
    if (!subject || mark === null) return;

    const existing = bestBySubject.get(subject);
    if (!existing || Number(mark) > Number(existing.mark)) {
      bestBySubject.set(subject, {
        subject,
        rawSubject: row.rawSubject ?? row.subject,
        mark,
      });
    }
  });

  return [...bestBySubject.values()];
};

const escapeRegExp = (value = '') => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const aliasPattern = (alias = '') => escapeRegExp(alias).replace(/\\ /g, '\\s+');

const extractMarksFromPlainText = (aiText = '') => {
  const text = String(aiText);
  const rows = [];

  SUBJECTS.forEach((subject) => {
    const aliases = [...SUBJECT_LOOKUP.entries()]
      .filter(([, mappedSubject]) => mappedSubject === subject)
      .map(([alias]) => alias)
      .sort((left, right) => right.length - left.length);

    aliases.forEach((alias) => {
      const escapedAlias = aliasPattern(alias);
      const subjectThenMark = new RegExp(`\\b${escapedAlias}\\b[^\\n\\r%]{0,80}(\\d{2,3}(?:\\.\\d+)?)\\s*%?`, 'i');
      const markThenSubject = new RegExp(`(\\d{2,3}(?:\\.\\d+)?)\\s*%?[^\\n\\r]{0,80}\\b${escapedAlias}\\b`, 'i');
      const match = text.match(subjectThenMark) || text.match(markThenSubject);

      if (match) {
        rows.push({ subject, rawSubject: subject, mark: Number(match[1]) });
      }
    });
  });

  return dedupeMarks(rows.filter((row) => Number(row.mark) >= 0 && Number(row.mark) <= 100));
};

export const extractTutorSubjectMarks = (aiText = '') => {
  const text = String(aiText ?? '').trim();
  if (!text) return [];

  try {
    const parsed = JSON.parse(extractJsonCandidate(text));
    const rows = collectRows(parsed)
      .map((row) => ({
        subject: normalizeEligibleSubject(row.subject ?? row.name ?? row.learningArea ?? row.course),
        rawSubject: row.subject ?? row.name ?? row.learningArea ?? row.course ?? '',
        mark: parseMark(row.mark ?? row.percentage ?? row.score ?? row.result),
      }))
      .filter((row) => row.subject && row.mark !== null);

    if (rows.length) return dedupeMarks(rows);
  } catch (error) {
    console.warn('[Examifying][TutorSubjects] Could not parse AI marks JSON, trying text parser:', error);
  }

  return extractMarksFromPlainText(text);
};

export const getApprovedTutorSubjects = (profile) => {
  const profileSubjects = Array.isArray(profile?.subjects) ? profile.subjects : [];
  const legacySubject = profile?.subject ? [profile.subject] : [];
  const markedSubjects = Array.isArray(profile?.tutorSubjectMarks)
    ? profile.tutorSubjectMarks.filter((item) => Number(item.mark) >= 60).map((item) => item.subject)
    : [];
  const approved = [...new Set([...profileSubjects, ...legacySubject, ...markedSubjects].map(normalizeEligibleSubject).filter(Boolean))];
  return approved;
};

export const getNewEligibleTutorSubjects = ({ extractedMarks = [], existingSubjects = [], minimumMark = 60 }) => {
  const existing = new Set(existingSubjects.map(normalizeEligibleSubject).filter(Boolean));

  return extractedMarks
    .filter((item) => item.subject && Number(item.mark) >= minimumMark && SUBJECTS.includes(item.subject) && !existing.has(item.subject))
    .map((item) => item.subject)
    .filter((subject, index, subjects) => subjects.indexOf(subject) === index);
};


export const getUserSubjects = (profile) => {
  const profileSubjects = Array.isArray(profile?.subjects) ? profile.subjects : [];
  const legacySubject = profile?.subject ? [profile.subject] : [];
  return [...new Set([...legacySubject, ...profileSubjects].map(normalizeEligibleSubject).filter(Boolean))];
};


export const mergeBestTutorSubjectMarks = ({ existingMarks = [], extractedMarks = [], minimumMark = 60 }) => {
  const bestBySubject = new Map();

  existingMarks.forEach((item) => {
    const subject = normalizeEligibleSubject(item.subject ?? item.rawSubject);
    const mark = parseMark(item.mark ?? item.bestMark);
    if (!subject || mark === null) return;
    bestBySubject.set(subject, {
      subject,
      rawSubject: item.rawSubject ?? item.subject,
      mark,
      source: item.source ?? 'profile',
    });
  });

  extractedMarks.forEach((item) => {
    const subject = normalizeEligibleSubject(item.subject ?? item.rawSubject);
    const mark = parseMark(item.mark);
    if (!subject || mark === null || mark < minimumMark) return;

    const existing = bestBySubject.get(subject);
    if (!existing || mark > Number(existing.mark)) {
      bestBySubject.set(subject, {
        subject,
        rawSubject: item.rawSubject ?? item.subject,
        mark,
        source: 'ai-extraction',
      });
    }
  });

  return [...bestBySubject.values()].sort((left, right) => left.subject.localeCompare(right.subject));
};
