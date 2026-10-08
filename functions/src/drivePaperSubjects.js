import {
  SUBJECT_ALIASES,
  SUPPORTED_SUBJECTS,
  normalizeSupportedSubject,
} from './subjects.js';

const normalizeSubjectLabel = (value) => String(value ?? '')
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/&/g, 'and')
  .replace(/[^a-z0-9]+/g, ' ')
  .trim()
  .replace(/\s+/g, ' ');

// FET CAPS subjects published by the Department of Basic Education that are
// not yet all selectable elsewhere in this Maths-focused application. These
// are accepted here so the past-paper importer can catalogue the wider Drive.
const ADDITIONAL_CAPS_SUBJECTS = [
  'Agricultural Management Practices',
  'Agricultural Technology',
  'Civil Technology',
  'Dance Studies',
  'Design Studies',
  'Equine Studies',
  'Hospitality Studies',
  'Life Orientation',
  'Marine Sciences',
  'Maritime Economics',
  'Nautical Science',
  'Religion Studies',
  'Sport and Exercise Science',
  'Technical Mathematics',
  'Technical Sciences',
  'Technical: Civil Technology',
  'Technical: Electrical Technology',
  'Technical: Mechanical Technology',
  'Economic Management Sciences',
  'Social Sciences',
  'Creative Arts',
  'Technology',
  'Life Skills',
  'Coding and Robotics',
];

// The DBE FET CAPS lists all eleven official South African languages at Home
// and First Additional Language levels. Its Second Additional Language list
// also includes French and Mandarin; other CAPS language options are accepted
// at that level for consistent importing of existing school exam archives.
const SOUTH_AFRICAN_LANGUAGES = [
  { name: 'Afrikaans', aliases: ['Afrikaans'] },
  { name: 'English', aliases: ['English'] },
  { name: 'isiNdebele', aliases: ['IsiNdebele', 'Ndebele'] },
  { name: 'isiXhosa', aliases: ['IsiXhosa', 'Xhosa'] },
  { name: 'isiZulu', aliases: ['IsiZulu', 'Zulu'] },
  { name: 'Sepedi', aliases: ['Sepedi', 'Pedi', 'Sesotho sa Leboa', 'Northern Sotho'] },
  { name: 'Sesotho', aliases: ['Sesotho', 'Southern Sotho'] },
  { name: 'Setswana', aliases: ['Setswana', 'Tswana'] },
  { name: 'siSwati', aliases: ['siSwati', 'Siswati', 'Swati'] },
  { name: 'Tshivenda', aliases: ['Tshivenda', 'Venda'] },
  { name: 'itsonga', aliases: ['itsonga', 'Tsonga'] },
];

const LANGUAGE_LEVELS = [
  { label: 'Home Language', short: 'HL' },
  { label: 'First Additional Language', short: 'FAL' },
  { label: 'Second Additional Language', short: 'SAL' },
];

const SECOND_ADDITIONAL_ONLY_LANGUAGES = [
  'French', 'Mandarin', 'Arabic', 'German', 'Gujarati', 'Hebrew', 'Hindi',
  'Italian', 'Latin', 'Modern Greek', 'Portuguese', 'Spanish', 'Tamil',
  'Telugu', 'Urdu',
];

const EXTRA_SUBJECT_ALIASES = {
  'Agricultural Management Practices': ['AMP'],
  'Agricultural Sciences': ['Agricultural Science'],
  'Agricultural Technology': ['Agri Technology', 'Agri Tech'],
  'Business Studies': ['Besigheidstudies'],
  'Civil Technology': ['Civil Tech', 'Siviele Tegnologie'],
  'Computer Applications Technology': ['Computer Application Technology', 'Rekenaartoepassing Tegnologie'],
  'Consumer Studies': ['Verbruikerstudies'],
  'Design Studies': ['Design', 'Ontwerp'],
  'Dramatic Arts': ['Drama', 'Dramatiese Kunste'],
  Economics: ['Ekonomie'],
  'Electrical Technology': ['Electrical Tech', 'Elektriese Tegnologie'],
  'Engineering Graphics and Design': ['EGD', 'Engineering Graphics Design', 'Ingenieursgrafika en ontwerp'],
  'Equine Studies': ['Equine', 'Perdestudies'],
  Geography: ['Geografie'],
  History: ['Geskiedenis'],
  'Hospitality Studies': ['Hospitality', 'Gasvryheid'],
  'Information Technology': ['IT', 'Inligtings Tegnologie'],
  'Life Orientation': ['LO', 'Lewensorientering'],
  'Life Sciences': ['Life Science', 'Biology', 'Lewenswetenskappe'],
  'Marine Sciences': ['Marine Science'],
  'Maritime Economics': ['Maritime Economics'],
  'Mathematical Literacy': ['Maths Literacy', 'Mathematics Literacy', 'Math Literacy', 'Maths Lit', 'Math Lit'],
  Mathematics: ['Maths', 'Math', 'Wiskunde'],
  'Mechanical Technology': ['Mechanical Tech'],
  'Physical Sciences': ['Physical Science', 'Physics', 'Chemistry', 'Fisiese Wetenskappe'],
  'Religion Studies': ['Religious Studies', 'Religie Studies'],
  'Sport and Exercise Science': ['Sports and Exercise Science', 'Sport Science'],
  'Technical Mathematics': ['Technical Maths', 'Tech Maths', 'Tegniese Wiskunde'],
  'Technical Sciences': ['Technical Science', 'Tech Sciences', 'Tegniese Wetenskappe'],
  'Technical: Civil Technology': ['Technical Civil Technology', 'Technical Civil'],
  'Technical: Electrical Technology': ['Technical Electrical Technology', 'Technical Electrical'],
  'Technical: Mechanical Technology': ['Technical Mechanical Technology', 'Technical Mechanical'],
  Tourism: ['Toerisme'],
  'Visual Arts': ['Visual Art', 'Visuele Kunste'],
};

const subjectLookup = new Map();
const subjectQueryValues = new Set();
const addSubjectLabel = (label, canonical) => {
  const key = normalizeSubjectLabel(label);
  if (!key) return;
  const candidates = subjectLookup.get(key) ?? new Set();
  candidates.add(canonical);
  subjectLookup.set(key, candidates);
  subjectQueryValues.add(label);
};

const baseSubjectNames = [...new Set([
  ...SUPPORTED_SUBJECTS,
  ...ADDITIONAL_CAPS_SUBJECTS,
])];

for (const subject of baseSubjectNames) {
  addSubjectLabel(subject, subject);
  for (const alias of [
    ...(SUBJECT_ALIASES[subject] ?? []),
    ...(EXTRA_SUBJECT_ALIASES[subject] ?? []),
  ]) {
    addSubjectLabel(alias, subject);
  }
}

const languageSubjects = [];
for (const language of SOUTH_AFRICAN_LANGUAGES) {
  for (const level of LANGUAGE_LEVELS) {
    const canonical = `${language.name} ${level.label}`;
    languageSubjects.push(canonical);
    addSubjectLabel(canonical, canonical);
    addSubjectLabel(`${language.name} ${level.short}`, canonical);
    for (const languageAlias of language.aliases) {
      addSubjectLabel(`${languageAlias} ${level.label}`, canonical);
      addSubjectLabel(`${languageAlias} ${level.short}`, canonical);
    }
  }
  // A language without a level is intentionally left ambiguous in filenames.
  for (const alias of language.aliases) {
    for (const level of LANGUAGE_LEVELS) addSubjectLabel(alias, `${language.name} ${level.label}`);
  }
}

const secondAdditionalLanguageSubjects = SECOND_ADDITIONAL_ONLY_LANGUAGES.map((language) => (
  `${language} Second Additional Language`
));
for (const subject of secondAdditionalLanguageSubjects) {
  languageSubjects.push(subject);
  addSubjectLabel(subject, subject);
  addSubjectLabel(`${subject.replace(/ Second Additional Language$/, '')} SAL`, subject);
}

for (const language of ['South African Sign Language', 'SASL']) {
  const canonical = 'South African Sign Language Home Language';
  languageSubjects.push(canonical);
  addSubjectLabel(canonical, canonical);
  addSubjectLabel(`${language} HL`, canonical);
  addSubjectLabel(language, canonical);
}

export const getDrivePaperSubjectCandidates = (value) => {
  const key = normalizeSubjectLabel(value);
  const matches = subjectLookup.get(key);
  if (matches?.size) return [...matches];
  const supported = normalizeSupportedSubject(value);
  return supported ? [supported] : [];
};

export const canonicalDrivePaperSubject = (value) => {
  const matches = getDrivePaperSubjectCandidates(value);
  return matches.length === 1 ? matches[0] : normalizeSubjectLabel(value);
};

export const DRIVE_PAPER_SUBJECT_QUERY_VALUES = Object.freeze([...subjectQueryValues]);
export const DRIVE_PAPER_SUBJECTS = Object.freeze([...new Set([...baseSubjectNames, ...languageSubjects])]);
