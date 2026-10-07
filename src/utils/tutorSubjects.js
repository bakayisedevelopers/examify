import { SUBJECTS } from '../lib/constants.js';
import { getTutorSubjectsAutoGrantedByMarks } from '../../functions/src/subjects.js';

const normalizeComparable = (value = '') =>
  String(value)
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

const SUBJECT_LOOKUP = new Map(
  SUBJECTS.flatMap((subject) => {
    const normalized = normalizeComparable(subject);
    return [[normalized, subject], ...(SUBJECT_ALIASES[subject] ?? []).map((alias) => [normalizeComparable(alias), subject])];
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

const collectRows = (parsed) => {
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed?.subjects)) return parsed.subjects;
  if (Array.isArray(parsed?.results)) return parsed.results;
  if (Array.isArray(parsed?.marks)) return parsed.marks;
  return [];
};

const balancedJsonEnd = (text, start) => {
  const opening = text[start];
  if (opening !== '{' && opening !== '[') return -1;
  const expectedClosers = [];
  let quoted = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') {
      quoted = true;
      continue;
    }
    if (character === '{') expectedClosers.push('}');
    else if (character === '[') expectedClosers.push(']');
    else if (character === '}' || character === ']') {
      if (expectedClosers.pop() !== character) return -1;
      if (!expectedClosers.length) return index;
    }
  }

  return -1;
};

const extractRowsFromJson = (value = '') => {
  const text = stripJsonFences(value);
  try {
    const rows = collectRows(JSON.parse(text));
    if (rows.length) return rows;
  } catch {
    // OCR commonly includes non-JSON text before the model's JSON response.
  }

  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== '{' && text[start] !== '[') continue;
    const end = balancedJsonEnd(text, start);
    if (end < 0) continue;
    try {
      const rows = collectRows(JSON.parse(text.slice(start, end + 1)));
      if (rows.length) return rows;
    } catch {
      // Keep scanning; OCR annotations such as [unclear] are not JSON payloads.
    }
  }

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

  const rows = extractRowsFromJson(text)
    .map((row) => ({
      subject: normalizeEligibleSubject(row.subject ?? row.name ?? row.learningArea ?? row.course),
      rawSubject: row.subject ?? row.name ?? row.learningArea ?? row.course ?? '',
      mark: parseMark(row.mark ?? row.percentage ?? row.score ?? row.result),
    }))
    .filter((row) => row.subject && row.mark !== null);

  if (rows.length) return dedupeMarks(rows);

  return extractMarksFromPlainText(text);
};

export const getApprovedTutorSubjects = (profile) => {
  const profileSubjects = Array.isArray(profile?.subjects) ? profile.subjects : [];
  const legacySubject = profile?.subject ? [profile.subject] : [];
  const markedSubjects = Array.isArray(profile?.tutorSubjectMarks)
    ? profile.tutorSubjectMarks.filter((item) => Number(item.mark) >= 60).map((item) => item.subject)
    : [];
  const automaticallyGranted = getTutorSubjectsAutoGrantedByMarks(profile?.tutorSubjectMarks);
  const approved = [...new Set([...profileSubjects, ...legacySubject, ...markedSubjects, ...automaticallyGranted].map(normalizeEligibleSubject).filter(Boolean))];
  return approved;
};

export const getNewEligibleTutorSubjects = ({ extractedMarks = [], existingSubjects = [], minimumMark = 60 }) => {
  const existing = new Set(existingSubjects.map(normalizeEligibleSubject).filter(Boolean));
  const eligible = extractedMarks
    .map((item) => ({ subject: normalizeEligibleSubject(item.subject ?? item.rawSubject), mark: parseMark(item.mark) }))
    .filter((item) => item.subject && item.mark !== null && item.mark >= minimumMark)
    .map((item) => item.subject);

  eligible.push(...getTutorSubjectsAutoGrantedByMarks(extractedMarks, minimumMark));

  return [...new Set(eligible)].filter((subject) => !existing.has(subject));
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
