const LANGUAGE_TOPICS = [
  'Listening and speaking',
  'Reading comprehension',
  'Summary writing',
  'Language structures and conventions',
  'Essay writing',
  'Transactional writing',
  'Poetry',
  'Drama',
  'Novel or short stories',
  'Visual literacy',
];

const phaseTopics = {
  intermediateMaths: [
    'Whole numbers',
    'Number patterns',
    'Common fractions',
    'Decimal fractions',
    'Percentages',
    'Money',
    'Time',
    'Length',
    'Mass',
    'Capacity and volume',
    'Perimeter',
    'Area',
    '2D shapes',
    '3D objects',
    'Symmetry',
    'Data handling',
    'Probability',
  ],
  seniorMaths: [
    'Integers',
    'Exponents',
    'Numeric and geometric patterns',
    'Algebraic expressions',
    'Equations',
    'Functions and relationships',
    'Graphs',
    'Geometry of 2D shapes',
    'Geometry of straight lines',
    'Transformation geometry',
    'Measurement',
    'Theorem of Pythagoras',
    'Area and volume',
    'Data handling',
    'Probability',
    'Financial mathematics',
  ],
  fetMaths: [
    'Algebra',
    'Equations and inequalities',
    'Number patterns and sequences',
    'Functions',
    'Graphs',
    'Analytical geometry',
    'Trigonometry',
    'Euclidean geometry',
    'Measurement',
    'Statistics',
    'Probability',
    'Finance, growth and decay',
    'Calculus',
    'Counting and probability',
  ],
};

const TOPICS_BY_SUBJECT = {
  Mathematics: {
    'Grade 4': phaseTopics.intermediateMaths,
    'Grade 5': phaseTopics.intermediateMaths,
    'Grade 6': phaseTopics.intermediateMaths,
    'Grade 7': phaseTopics.seniorMaths,
    'Grade 8': phaseTopics.seniorMaths,
    'Grade 9': phaseTopics.seniorMaths,
    'Grade 10': phaseTopics.fetMaths.filter((topic) => topic !== 'Calculus'),
    'Grade 11': phaseTopics.fetMaths,
    'Grade 12': phaseTopics.fetMaths,
  },
  'Mathematical Literacy': {
    default: [
      'Finance',
      'Measurement',
      'Maps, plans and scale',
      'Data handling',
      'Probability',
      'Tariff systems',
      'Taxation',
      'Interest',
      'Banking',
      'Inflation',
      'Exchange rates',
    ],
  },
  'Physical Sciences': {
    default: [
      'Mechanics',
      'Waves, sound and light',
      'Electricity and magnetism',
      'Matter and materials',
      'Chemical change',
      'Chemical systems',
      'Organic chemistry',
      'Rates of reaction',
      'Acids and bases',
      'Electrochemistry',
      'Work, energy and power',
      'Momentum and impulse',
    ],
  },
  'Natural Sciences': {
    default: [
      'Life and living',
      'Matter and materials',
      'Energy and change',
      'Planet Earth and beyond',
      'Cells',
      'Systems in the human body',
      'Biodiversity',
      'Electric circuits',
      'Forces',
    ],
  },
  'Life Sciences': {
    default: [
      'Cells and molecular studies',
      'Life processes in plants and animals',
      'Environmental studies',
      'Diversity, change and continuity',
      'Human reproduction',
      'Genetics and inheritance',
      'Evolution',
      'Human impact on the environment',
    ],
  },
  Accounting: {
    default: [
      'Accounting concepts',
      'Source documents',
      'Journals',
      'Ledgers',
      'Trial balance',
      'Financial statements',
      'Cash budgets',
      'Bank reconciliation',
      'Debtors and creditors',
      'Inventory systems',
      'VAT',
      'Cost accounting',
    ],
  },
  'Business Studies': {
    default: [
      'Business environments',
      'Business ventures',
      'Business roles',
      'Business operations',
      'Entrepreneurship',
      'Marketing',
      'Human resources',
      'Investment and insurance',
      'Forms of ownership',
      'Corporate social responsibility',
    ],
  },
  Economics: {
    default: [
      'Basic economic problem',
      'Circular flow',
      'Business cycles',
      'Public sector',
      'Foreign exchange markets',
      'Protectionism and free trade',
      'Economic growth and development',
      'Inflation',
      'Tourism',
      'Environmental sustainability',
    ],
  },
  History: {
    default: [
      'Source-based questions',
      'Essay writing',
      'Industrialisation',
      'Imperialism',
      'Apartheid South Africa',
      'Civil resistance',
      'Cold War',
      'Democracy in South Africa',
      'Civil society protests',
    ],
  },
  Geography: {
    default: [
      'Map skills',
      'Geomorphology',
      'Climatology',
      'Settlement geography',
      'Economic geography',
      'Development geography',
      'Population geography',
      'GIS',
      'Weather and climate',
      'Resources and sustainability',
    ],
  },
  'Computer Applications Technology': {
    default: [
      'Systems technologies',
      'Network technologies',
      'Internet technologies',
      'Information management',
      'Social implications',
      'Word processing',
      'Spreadsheets',
      'Databases',
      'Presentations',
    ],
  },
  'Information Technology': {
    default: [
      'Solution development',
      'Algorithms',
      'Programming concepts',
      'Data structures',
      'Databases',
      'Systems technologies',
      'Communication technologies',
      'Internet technologies',
      'Social implications',
    ],
  },
  'Engineering Graphics and Design': {
    default: [
      'Freehand drawing',
      'Instrument drawing',
      'Orthographic projection',
      'Isometric drawing',
      'Perspective drawing',
      'Sectional views',
      'Mechanical drawings',
      'Civil drawings',
      'CAD',
    ],
  },
  'Agricultural Sciences': {
    default: [
      'Soil science',
      'Plant studies',
      'Animal studies',
      'Agricultural economics',
      'Basic agricultural chemistry',
      'Production factors',
      'Sustainable agriculture',
      'Genetics and breeding',
    ],
  },
  Tourism: {
    default: [
      'Tourism sectors',
      'Map work and tour planning',
      'Foreign exchange',
      'Tourist attractions',
      'Culture and heritage tourism',
      'Marketing',
      'Sustainable tourism',
      'Customer care',
    ],
  },
  'Consumer Studies': {
    default: [
      'Food and nutrition',
      'Clothing',
      'Housing and interiors',
      'Consumer education',
      'Entrepreneurship',
      'Design elements',
      'Production and marketing',
    ],
  },
  'Dramatic Arts': {
    default: [
      'Performance skills',
      'Improvisation',
      'Script analysis',
      'Theatre history',
      'South African theatre',
      'Movement and voice',
      'Directing and staging',
    ],
  },
  'Visual Arts': {
    default: [
      'Visual literacy',
      'Drawing',
      'Painting',
      'Sculpture',
      'Design principles',
      'Art history',
      'South African art',
      'Practical portfolio',
    ],
  },
  Music: {
    default: [
      'Music theory',
      'Harmony',
      'Aural training',
      'Music literacy',
      'Performance',
      'Composition',
      'Music history',
      'South African music',
    ],
  },
};

[
  'English Home Language',
  'English First Additional Language',
  'Afrikaans Home Language',
  'Afrikaans First Additional Language',
  'isiZulu Home Language',
  'isiXhosa Home Language',
  'Sepedi Home Language',
  'Setswana Home Language',
  'Sesotho Home Language',
].forEach((subject) => {
  TOPICS_BY_SUBJECT[subject] = { default: LANGUAGE_TOPICS };
});

export const getHardcodedTopics = ({ subject, grade } = {}) => {
  const subjectTopics = TOPICS_BY_SUBJECT[subject] ?? {};
  return [...new Set([...(subjectTopics[grade] ?? []), ...(subjectTopics.default ?? [])])]
    .map((topic) => String(topic).trim())
    .filter(Boolean);
};

export const mergeTopicOptions = ({ extractedTopics = [], subject, grade } = {}) => {
  const hardcodedTopics = getHardcodedTopics({ subject, grade });
  return [...new Set([...extractedTopics, ...hardcodedTopics].map((topic) => String(topic).trim()).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right));
};

export const getTopicOptionGroups = ({ extractedTopics = [], subject, grade } = {}) => {
  const extracted = [...new Set(extractedTopics.map((topic) => String(topic).trim()).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right));
  const extractedKeys = new Set(extracted.map((topic) => topic.toLowerCase()));
  const manual = getHardcodedTopics({ subject, grade })
    .filter((topic) => !extractedKeys.has(topic.toLowerCase()))
    .sort((left, right) => left.localeCompare(right));

  return {
    extracted,
    manual,
    all: [...extracted, ...manual],
  };
};
