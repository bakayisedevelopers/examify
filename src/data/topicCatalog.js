import { SOUTH_AFRICAN_GRADES, SUBJECTS } from '../lib/constants.js';

const makeTopic = (childTopic, aliases = []) => ({ childTopic, aliases: [childTopic, ...aliases] });
const group = (parentTopic, children) => ({ parentTopic, children: children.map((item) => Array.isArray(item) ? makeTopic(item[0], item[1]) : makeTopic(item)) });

const PRIMARY_MATHS = [
  group('Numbers', [
    ['Place value and ordering', ['Whole numbers']], ['Whole-number operations', ['Addition', 'Subtraction', 'Multiplication', 'Division']],
    'Factors and multiples', 'Common fractions', 'Decimal fractions', 'Percentages', 'Ratio and rate',
  ]),
  group('Patterns and Relationships', [['Numeric patterns', ['Number patterns']], 'Geometric patterns', 'Flow diagrams and rules']),
  group('Space and Shape', ['2D shapes', '3D objects', 'Symmetry', 'Position and movement']),
  group('Measurement', ['Length, mass and capacity', 'Time', 'Perimeter and area', 'Volume']),
  group('Data Handling', ['Data collection and classification', ['Data representations', ['Data handling']], 'Mode and median', 'Probability']),
];

const SENIOR_MATHS = [
  group('Numbers, Operations and Relationships', ['Integers', 'Fractions, decimals and percentages', 'Ratio and rate', 'Exponents and roots', 'Scientific notation']),
  group('Patterns and Relationships', [
    ['Numeric patterns', ['Numeric and geometric patterns', 'Number patterns']], 'Geometric patterns', 'Input-output rules',
  ]),
  group('Algebra', ['Algebraic expressions', 'Equations', 'Inequalities', 'Algebraic fractions']),
  group('Functions', [['Linear functions', ['Functions and relationships']], 'Tables and function rules', 'Function graphs', 'Independent and dependent variables']),
  group('Space and Shape', ['Geometry of 2D shapes', 'Geometry of straight lines', 'Transformation geometry', 'Theorem of Pythagoras']),
  group('Measurement', ['Metric conversions', 'Perimeter and area', 'Surface area and volume']),
  group('Statistics', ['Data collection and classification', ['Data representations', ['Data handling']], 'Measures of central tendency', 'Range and spread']),
  group('Probability', ['Experimental probability', 'Theoretical probability']),
  group('Finance', ['Financial mathematics', 'Simple and compound interest']),
];

const FET_MATHS = [
  group('Algebra', ['Algebraic expressions', 'Equations and inequalities', ['Surds and exponents', ['Exponents']], 'Algebraic fractions']),
  group('Number Patterns', [
    ['Arithmetic sequences', ['Number patterns and sequences', 'Sequence', 'Sequences', 'Sequence and series', 'Arithmetic sequence', 'Linear sequence']],
    ['Geometric sequences', ['Geometric sequence']], ['Quadratic sequences', ['Quadratic sequence']],
    'Arithmetic series', 'Geometric series', 'Sigma notation',
  ]),
  group('Functions', [
    ['Linear functions', ['Linear function', 'Straight-line functions']], ['Quadratic functions', ['Parabola', 'Parabolic functions']],
    ['Exponential functions', ['Exponential function']], ['Logarithmic functions', ['Logarithms', 'Log function']],
    'Inverse functions', 'Function transformations', 'Function notation and domain',
  ]),
  group('Finance, Growth and Decay', ['Simple and compound interest', 'Depreciation', 'Growth and decay', 'Annuities and loans']),
  group('Calculus', ['First principles', 'Differentiation', 'Applications of derivatives', 'Integration']),
  group('Counting and Probability', ['Fundamental counting principle', 'Permutations and combinations', 'Probability rules', 'Independent and dependent events']),
  group('Statistics', [
    'Data representations', 'Measures of central tendency', 'Measures of dispersion',
    ['Scatter plots', ['Scatter plot']], 'Correlation and regression', 'Bivariate data',
  ]),
  group('Trigonometry', ['Trigonometric ratios', 'Trigonometric identities', 'Trigonometric equations', 'Sine and cosine rules', 'Area of a triangle']),
  group('Analytical Geometry', ['Distance and midpoint', 'Gradient and equation of a line', 'Equation of a circle']),
  group('Euclidean Geometry', ['Geometric proofs', 'Similarity and congruence', 'Cyclic quadrilaterals', 'Proportionality']),
  group('Measurement', ['Area and perimeter', 'Surface area and volume']),
];

const MATHS_BY_GRADE = {
  'Grade 4': PRIMARY_MATHS,
  'Grade 5': PRIMARY_MATHS,
  'Grade 6': PRIMARY_MATHS,
  'Grade 7': SENIOR_MATHS,
  'Grade 8': SENIOR_MATHS,
  'Grade 9': SENIOR_MATHS,
  'Grade 10': FET_MATHS.filter((item) => item.parentTopic !== 'Calculus'),
  'Grade 11': FET_MATHS,
  'Grade 12': FET_MATHS,
};

const LEGACY_TOPICS_BY_SUBJECT = {
  'Mathematical Literacy': ['Finance', 'Measurement', 'Maps, plans and scale', 'Data handling', 'Probability', 'Tariff systems', 'Taxation', 'Interest', 'Banking', 'Inflation', 'Exchange rates'],
  'Physical Sciences': ['Mechanics', 'Waves, sound and light', 'Electricity and magnetism', 'Matter and materials', 'Chemical change', 'Chemical systems', 'Organic chemistry', 'Rates of reaction', 'Acids and bases', 'Electrochemistry', 'Work, energy and power', 'Momentum and impulse'],
  'Natural Sciences': ['Life and living', 'Matter and materials', 'Energy and change', 'Planet Earth and beyond', 'Cells', 'Systems in the human body', 'Biodiversity', 'Electric circuits', 'Forces'],
  'Life Sciences': ['Cells and molecular studies', 'Life processes in plants and animals', 'Environmental studies', 'Diversity, change and continuity', 'Human reproduction', 'Genetics and inheritance', 'Evolution', 'Human impact on the environment'],
  Accounting: ['Accounting concepts', 'Source documents', 'Journals', 'Ledgers', 'Trial balance', 'Financial statements', 'Cash budgets', 'Bank reconciliation', 'Debtors and creditors', 'Inventory systems', 'VAT', 'Cost accounting'],
  'Business Studies': ['Business environments', 'Business ventures', 'Business roles', 'Business operations', 'Entrepreneurship', 'Marketing', 'Human resources', 'Investment and insurance', 'Forms of ownership', 'Corporate social responsibility'],
  Economics: ['Basic economic problem', 'Circular flow', 'Business cycles', 'Public sector', 'Foreign exchange markets', 'Protectionism and free trade', 'Economic growth and development', 'Inflation', 'Tourism', 'Environmental sustainability'],
  History: ['Source-based questions', 'Essay writing', 'Industrialisation', 'Imperialism', 'Apartheid South Africa', 'Civil resistance', 'Cold War', 'Democracy in South Africa', 'Civil society protests'],
  Geography: ['Map skills', 'Geomorphology', 'Climatology', 'Settlement geography', 'Economic geography', 'Development geography', 'Population geography', 'GIS', 'Weather and climate', 'Resources and sustainability'],
  'Computer Applications Technology': ['Systems technologies', 'Network technologies', 'Internet technologies', 'Information management', 'Social implications', 'Word processing', 'Spreadsheets', 'Databases', 'Presentations'],
  'Information Technology': ['Solution development', 'Algorithms', 'Programming concepts', 'Data structures', 'Databases', 'Systems technologies', 'Communication technologies', 'Internet technologies', 'Social implications'],
  'Engineering Graphics and Design': ['Freehand drawing', 'Instrument drawing', 'Orthographic projection', 'Isometric drawing', 'Perspective drawing', 'Sectional views', 'Mechanical drawings', 'Civil drawings', 'CAD'],
  'Agricultural Sciences': ['Soil science', 'Plant studies', 'Animal studies', 'Agricultural economics', 'Basic agricultural chemistry', 'Production factors', 'Sustainable agriculture', 'Genetics and breeding'],
  Tourism: ['Tourism sectors', 'Map work and tour planning', 'Foreign exchange', 'Tourist attractions', 'Culture and heritage tourism', 'Marketing', 'Sustainable tourism', 'Customer care'],
  'Consumer Studies': ['Food and nutrition', 'Clothing', 'Housing and interiors', 'Consumer education', 'Entrepreneurship', 'Design elements', 'Production and marketing'],
  'Dramatic Arts': ['Performance skills', 'Improvisation', 'Script analysis', 'Theatre history', 'South African theatre', 'Movement and voice', 'Directing and staging'],
  'Visual Arts': ['Visual literacy', 'Drawing', 'Painting', 'Sculpture', 'Design principles', 'Art history', 'South African art', 'Practical portfolio'],
  Music: ['Music theory', 'Harmony', 'Aural training', 'Music literacy', 'Performance', 'Composition', 'Music history', 'South African music'],
  'English Home Language': ['Listening and speaking', 'Reading comprehension', 'Summary writing', 'Language structures and conventions', 'Essay writing', 'Transactional writing', 'Poetry', 'Drama', 'Novel or short stories', 'Visual literacy'],
  'English First Additional Language': ['Listening and speaking', 'Reading comprehension', 'Summary writing', 'Language structures and conventions', 'Essay writing', 'Transactional writing', 'Poetry', 'Drama', 'Novel or short stories', 'Visual literacy'],
  'Afrikaans Home Language': ['Listening and speaking', 'Reading comprehension', 'Summary writing', 'Language structures and conventions', 'Essay writing', 'Transactional writing', 'Poetry', 'Drama', 'Novel or short stories', 'Visual literacy'],
  'Afrikaans First Additional Language': ['Listening and speaking', 'Reading comprehension', 'Summary writing', 'Language structures and conventions', 'Essay writing', 'Transactional writing', 'Poetry', 'Drama', 'Novel or short stories', 'Visual literacy'],
  'isiZulu Home Language': ['Listening and speaking', 'Reading comprehension', 'Summary writing', 'Language structures and conventions', 'Essay writing', 'Transactional writing', 'Poetry', 'Drama', 'Novel or short stories', 'Visual literacy'],
  'isiXhosa Home Language': ['Listening and speaking', 'Reading comprehension', 'Summary writing', 'Language structures and conventions', 'Essay writing', 'Transactional writing', 'Poetry', 'Drama', 'Novel or short stories', 'Visual literacy'],
  'Sepedi Home Language': ['Listening and speaking', 'Reading comprehension', 'Summary writing', 'Language structures and conventions', 'Essay writing', 'Transactional writing', 'Poetry', 'Drama', 'Novel or short stories', 'Visual literacy'],
  'Setswana Home Language': ['Listening and speaking', 'Reading comprehension', 'Summary writing', 'Language structures and conventions', 'Essay writing', 'Transactional writing', 'Poetry', 'Drama', 'Novel or short stories', 'Visual literacy'],
  'Sesotho Home Language': ['Listening and speaking', 'Reading comprehension', 'Summary writing', 'Language structures and conventions', 'Essay writing', 'Transactional writing', 'Poetry', 'Drama', 'Novel or short stories', 'Visual literacy'],
};

const PARENT_BY_SUBJECT = {
  'Mathematical Literacy': {
    Finance: 'Finance', 'Tariff systems': 'Finance', Taxation: 'Finance', Interest: 'Finance', Banking: 'Finance', Inflation: 'Finance', 'Exchange rates': 'Finance',
    Measurement: 'Measurement', 'Maps, plans and scale': 'Maps, Plans and Scale', 'Data handling': 'Statistics', Probability: 'Probability',
  },
  'Physical Sciences': {
    Mechanics: 'Mechanics', 'Work, energy and power': 'Mechanics', 'Momentum and impulse': 'Mechanics', 'Waves, sound and light': 'Waves and Optics',
    'Electricity and magnetism': 'Electricity and Magnetism', 'Matter and materials': 'Matter and Materials', 'Chemical change': 'Chemical Change',
    'Chemical systems': 'Chemical Systems', 'Organic chemistry': 'Organic Chemistry', 'Rates of reaction': 'Chemical Change', 'Acids and bases': 'Chemical Change', 'Electrochemistry': 'Chemical Systems',
  },
  'Natural Sciences': {
    'Life and living': 'Life and Living', Cells: 'Life and Living', 'Systems in the human body': 'Life and Living', Biodiversity: 'Life and Living',
    'Matter and materials': 'Matter and Materials', 'Energy and change': 'Energy and Change', 'Electric circuits': 'Energy and Change', Forces: 'Energy and Change', 'Planet Earth and beyond': 'Planet Earth and Beyond',
  },
  'Life Sciences': {
    'Cells and molecular studies': 'Life at the Molecular, Cellular and Tissue Level', 'Life processes in plants and animals': 'Life Processes',
    'Environmental studies': 'Environmental Studies', 'Human impact on the environment': 'Environmental Studies', 'Diversity, change and continuity': 'Diversity, Change and Continuity',
    'Human reproduction': 'Life Processes', 'Genetics and inheritance': 'Genetics and Inheritance', Evolution: 'Evolution',
  },
  Accounting: {
    'Accounting concepts': 'Accounting Concepts', 'Source documents': 'Recording and Processing', Journals: 'Recording and Processing', Ledgers: 'Recording and Processing',
    'Trial balance': 'Financial Accounting', 'Financial statements': 'Financial Accounting', 'Cash budgets': 'Managerial Accounting', 'Bank reconciliation': 'Financial Accounting',
    'Debtors and creditors': 'Financial Accounting', 'Inventory systems': 'Financial Accounting', VAT: 'Financial Accounting', 'Cost accounting': 'Managerial Accounting',
  },
  'Business Studies': {
    'Business environments': 'Business Environments', 'Business ventures': 'Business Ventures', 'Business roles': 'Business Roles', 'Business operations': 'Business Operations',
    Entrepreneurship: 'Business Ventures', Marketing: 'Business Operations', 'Human resources': 'Business Operations', 'Investment and insurance': 'Business Ventures',
    'Forms of ownership': 'Business Ventures', 'Corporate social responsibility': 'Business Environments',
  },
  Economics: {
    'Basic economic problem': 'Microeconomics', 'Circular flow': 'Macroeconomics', 'Business cycles': 'Macroeconomics', 'Public sector': 'Macroeconomics',
    'Foreign exchange markets': 'International Trade', 'Protectionism and free trade': 'International Trade', 'Economic growth and development': 'Macroeconomics',
    Inflation: 'Macroeconomics', Tourism: 'Economic Issues', 'Environmental sustainability': 'Economic Issues',
  },
  History: {
    'Source-based questions': 'Historical Skills', 'Essay writing': 'Historical Skills', Industrialisation: 'Industrialisation', Imperialism: 'Imperialism',
    'Apartheid South Africa': 'Apartheid South Africa', 'Civil resistance': 'Resistance and Protest', 'Civil society protests': 'Resistance and Protest',
    'Cold War': 'The Cold War', 'Democracy in South Africa': 'Democracy in South Africa',
  },
  Geography: {
    'Map skills': 'Geographical Skills', GIS: 'Geographical Skills', Geomorphology: 'Physical Geography', Climatology: 'Physical Geography', 'Weather and climate': 'Physical Geography',
    'Settlement geography': 'Human Geography', 'Economic geography': 'Human Geography', 'Development geography': 'Human Geography', 'Population geography': 'Human Geography', 'Resources and sustainability': 'Resources and Sustainability',
  },
  'Computer Applications Technology': {
    'Systems technologies': 'Systems Technologies', 'Network technologies': 'Network Technologies', 'Internet technologies': 'Internet Technologies', 'Information management': 'Information Management',
    'Social implications': 'Social Implications', 'Word processing': 'Application Packages', Spreadsheets: 'Application Packages', Databases: 'Application Packages', Presentations: 'Application Packages',
  },
  'Information Technology': {
    'Solution development': 'Solution Development', Algorithms: 'Solution Development', 'Programming concepts': 'Solution Development', 'Data structures': 'Solution Development',
    Databases: 'Data and Information Management', 'Systems technologies': 'Systems Technologies', 'Communication technologies': 'Communication Technologies',
    'Internet technologies': 'Internet Technologies', 'Social implications': 'Social Implications',
  },
  'Engineering Graphics and Design': {
    'Freehand drawing': 'Graphics and Presentation', 'Instrument drawing': 'Graphics and Presentation', 'Orthographic projection': 'Mechanical Graphics', 'Isometric drawing': 'Mechanical Graphics',
    'Perspective drawing': 'Civil Graphics', 'Sectional views': 'Mechanical Graphics', 'Mechanical drawings': 'Mechanical Graphics', 'Civil drawings': 'Civil Graphics', CAD: 'Computer-Aided Design',
  },
  'Agricultural Sciences': {
    'Soil science': 'Plant Production', 'Plant studies': 'Plant Production', 'Animal studies': 'Animal Production', 'Agricultural economics': 'Agricultural Management',
    'Basic agricultural chemistry': 'Basic Agricultural Sciences', 'Production factors': 'Agricultural Management', 'Sustainable agriculture': 'Agricultural Management', 'Genetics and breeding': 'Animal Production',
  },
  Tourism: {
    'Tourism sectors': 'Tourism Sectors', 'Map work and tour planning': 'Tourism Geography', 'Foreign exchange': 'Tourism Geography', 'Tourist attractions': 'Tourism Geography',
    'Culture and heritage tourism': 'Culture and Heritage', Marketing: 'Tourism Marketing', 'Sustainable tourism': 'Sustainable Tourism', 'Customer care': 'Tourism Operations',
  },
  'Consumer Studies': {
    'Food and nutrition': 'Food and Nutrition', Clothing: 'Clothing', 'Housing and interiors': 'Housing and Interiors', 'Consumer education': 'Consumer Decisions',
    Entrepreneurship: 'Entrepreneurship', 'Design elements': 'Design and Production', 'Production and marketing': 'Design and Production',
  },
  'Dramatic Arts': {
    'Performance skills': 'Performance', Improvisation: 'Performance', 'Script analysis': 'Theatre Making', 'Theatre history': 'Theatre History', 'South African theatre': 'Theatre History',
    'Movement and voice': 'Performance', 'Directing and staging': 'Theatre Making',
  },
  'Visual Arts': {
    'Visual literacy': 'Visual Literacy', Drawing: 'Art Making', Painting: 'Art Making', Sculpture: 'Art Making', 'Design principles': 'Design', 'Art history': 'Visual Culture Studies', 'South African art': 'Visual Culture Studies', 'Practical portfolio': 'Art Making',
  },
  Music: {
    'Music theory': 'Music Literacy', Harmony: 'Music Literacy', 'Aural training': 'Music Literacy', 'Music literacy': 'Music Literacy', Performance: 'Music Performance', Composition: 'Composition',
    'Music history': 'Music in Context', 'South African music': 'Music in Context',
  },
};

const LANGUAGE_SUBJECTS = SUBJECTS.filter((subject) => /Home Language|First Additional Language/.test(subject));
LANGUAGE_SUBJECTS.forEach((subject) => {
  PARENT_BY_SUBJECT[subject] = {
    'Listening and speaking': 'Listening and Speaking', 'Reading comprehension': 'Reading and Viewing', 'Summary writing': 'Writing and Presenting',
    'Language structures and conventions': 'Language Structures and Conventions', 'Essay writing': 'Writing and Presenting',
    'Transactional writing': 'Writing and Presenting', Poetry: 'Literature', Drama: 'Literature', 'Novel or short stories': 'Literature', 'Visual literacy': 'Reading and Viewing',
  };
});

const normaliseTopic = (value = '') => String(value)
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/['’]s\b/g, '')
  .replace(/&/g, ' and ')
  .replace(/[^a-z0-9]+/g, ' ')
  .trim()
  .replace(/\s+/g, ' ');

const textIncludesTopicPhrase = (normalizedTopic, phrase) => {
  const words = normaliseTopic(phrase).split(' ').filter(Boolean);
  if (!words.length) return false;
  const lastWord = words.pop();
  const stems = [lastWord];
  if (lastWord === 'gas') {
    stems.push('gases');
  } else if (lastWord === 'gases') {
    stems.push('gas');
  } else if (lastWord.endsWith('ies') && !['series', 'species'].includes(lastWord)) {
    stems.push(`${lastWord.slice(0, -3)}y`);
  } else if (/(ches|shes|xes|zes|sses)$/.test(lastWord)) {
    stems.push(lastWord.replace(/es$/, ''));
  } else if (lastWord.endsWith('s') && !/(ss|us|is)$/.test(lastWord)) {
    stems.push(lastWord.slice(0, -1));
    if (lastWord !== 'series') stems.push(`${lastWord}es`);
  } else {
    stems.push(`${lastWord}s`);
  }
  const prefix = words.length ? `${words.join(' ')} ` : '';
  const alternatives = [...new Set(stems)].join('|');
  return new RegExp(`(?:^| )${prefix}(?:${alternatives})(?: |$)`).test(normalizedTopic);
};

const gradeBandFor = (grade) => {
  const number = Number(String(grade || '').match(/\d+/)?.[0]);
  if (number >= 4 && number <= 6) return 'primary';
  if (number >= 7 && number <= 9) return 'senior';
  if (number >= 10 && number <= 12) return 'fet';
  return '';
};

const getMathDefinitions = (grade) => MATHS_BY_GRADE[grade] ?? [];

const getLegacyParent = (subject, childTopic) => PARENT_BY_SUBJECT[subject]?.[childTopic] ?? subject;

const PHYSICAL_SCIENCES_GRADE_10_TOPICS = [
  ['Kinematics', 'Mechanics'],
  ['Vectors and scalars', 'Mechanics'],
  ['Energy', 'Mechanics'],
  ['Waves and sound', 'Waves and Optics'],
  ['Electromagnetic radiation', 'Waves and Optics'],
  ['Electrostatics', 'Electricity and Magnetism'],
  ['Magnetic fields', 'Electricity and Magnetism'],
  ['Electric circuits', 'Electricity and Magnetism'],
  ['Matter and mixtures', 'Matter and Materials'],
  ['States of matter', 'Matter and Materials'],
  ['Atomic structure', 'Matter and Materials'],
  ['Periodic table', 'Matter and Materials'],
  ['Chemical bonding and molecular structure', 'Matter and Materials'],
  ['Chemical equations and formulae', 'Chemical Change'],
  ['Chemical reactions', 'Chemical Change'],
  ['Acids and bases', 'Chemical Change'],
  ['Redox reactions', 'Chemical Change'],
  ['Stoichiometry and mole calculations', 'Chemical Change'],
  ['Solutions and concentration', 'Chemical Change'],
  ['Hydrosphere', 'Chemical Systems'],
  ['Scientific investigations', 'Scientific Investigations'],
  ['Graphs and data analysis', 'Scientific Investigations'],
];

const PHYSICAL_SCIENCES_GRADE_11_TOPICS = [
  ['Kinematics', 'Mechanics'],
  ['Forces', 'Mechanics'],
  ["Newton's laws of motion", 'Mechanics'],
  ['Universal gravitation', 'Mechanics'],
  ['Vectors and scalars', 'Mechanics'],
  ['Geometrical optics', 'Waves and Optics'],
  ['Wave properties', 'Waves and Optics'],
  ['Diffraction', 'Waves and Optics'],
  ['Electrostatics', 'Electricity and Magnetism'],
  ['Electric circuits', 'Electricity and Magnetism'],
  ['Electrical energy and power', 'Electricity and Magnetism'],
  ['Magnetic fields', 'Electricity and Magnetism'],
  ['Electromagnetic induction', 'Electricity and Magnetism'],
  ['Atomic structure', 'Matter and Materials'],
  ['Chemical bonding and molecular structure', 'Matter and Materials'],
  ['Intermolecular forces and physical properties', 'Matter and Materials'],
  ['Gases and gas laws', 'Matter and Materials'],
  ['Chemical equations and formulae', 'Chemical Change'],
  ['Chemical reactions', 'Chemical Change'],
  ['Acids and bases', 'Chemical Change'],
  ['Redox reactions', 'Chemical Change'],
  ['Stoichiometry and mole calculations', 'Chemical Change'],
  ['Solutions and concentration', 'Chemical Change'],
  ['Energy changes in chemical reactions', 'Chemical Change'],
  ['Chemical equilibrium', 'Chemical Systems'],
  ['Environmental impacts', 'Chemical Systems'],
  ['Mining and extraction of metals', 'Chemical Systems'],
  ['Scientific investigations', 'Scientific Investigations'],
  ['Graphs and data analysis', 'Scientific Investigations'],
];

const PHYSICAL_SCIENCES_GRADE_10_TEXT_RULES = [
  { childTopic: 'Acids and bases', parentTopic: 'Chemical Change', phrases: [
    'acid base', 'acids and bases', 'acid base reaction', 'neutralisation', 'neutralization', 'ph',
  ] },
  { childTopic: 'Redox reactions', parentTopic: 'Chemical Change', phrases: [
    'redox', 'oxidation reduction', 'oxidation number', 'oxidation', 'reduction',
  ] },
  { childTopic: 'Chemical equations and formulae', parentTopic: 'Chemical Change', phrases: [
    'balanced chemical equation', 'balancing chemical equation', 'balancing equation',
    'chemical equation', 'ionic equation', 'chemical formula', 'chemical nomenclature',
  ] },
  { childTopic: 'Stoichiometry and mole calculations', parentTopic: 'Chemical Change', phrases: [
    'stoichiometry', 'stoichiometric calculation', 'mole calculation', 'mole concept',
    'mole ratio', 'molar mass', 'concentration calculation', 'concentration of solution',
    'solution concentration', 'mass calculation', 'percentage composition',
  ] },
  { childTopic: 'Solutions and concentration', parentTopic: 'Chemical Change', phrases: [
    'concentration', 'aqueous solution', 'solution concentration',
  ] },
  { childTopic: 'Chemical reactions', parentTopic: 'Chemical Change', phrases: [
    'chemical reaction', 'reaction type', 'precipitation reaction', 'gas forming reaction',
  ] },
  { childTopic: 'Chemical bonding and molecular structure', parentTopic: 'Matter and Materials', phrases: [
    'chemical bonding', 'covalent bonding', 'ionic bonding', 'metallic bonding',
    'bond polarity', 'bond length', 'chemical formula', 'molecular structure',
  ] },
  { childTopic: 'Periodic table', parentTopic: 'Matter and Materials', phrases: [
    'periodic table', 'periodic properties', 'electron configuration',
  ] },
  { childTopic: 'Atomic structure', parentTopic: 'Matter and Materials', phrases: [
    'atomic structure', 'atom structure', 'isotope', 'proton neutron electron',
  ] },
  { childTopic: 'Matter and mixtures', parentTopic: 'Matter and Materials', phrases: [
    'matter classification', 'classification of matter', 'mixture', 'pure substance',
    'metals and non metals', 'conductors and insulators',
  ] },
  { childTopic: 'States of matter', parentTopic: 'Matter and Materials', phrases: [
    'state of matter', 'phase of matter', 'kinetic molecular theory', 'boiling point',
    'evaporation', 'melting point',
  ] },
  { childTopic: 'Electrostatics', parentTopic: 'Electricity and Magnetism', phrases: [
    'electrostatics', 'electrostatic force', 'coulomb law', 'electric charge',
    'charge redistribution', 'polarisation', 'polarization',
  ] },
  { childTopic: 'Magnetic fields', parentTopic: 'Electricity and Magnetism', phrases: [
    'magnetic field', 'magnetic fields', 'magnetism', 'magnetic field pattern', 'compass',
  ] },
  { childTopic: 'Electric circuits', parentTopic: 'Electricity and Magnetism', phrases: [
    'electric circuit', 'electrical circuit', 'circuit analysis', 'parallel circuit',
    'resistor in parallel', 'ohm law', 'electric current', 'potential difference',
    'ammeter', 'voltmeter', 'electrical resistance', 'emf',
  ] },
  { childTopic: 'Vectors and scalars', parentTopic: 'Mechanics', phrases: [
    'vector and scalar', 'scalars and vectors', 'vector component', 'vector addition',
  ] },
  { childTopic: 'Kinematics', parentTopic: 'Mechanics', phrases: [
    'inclined plane', 'constant velocity', 'free fall', 'acceleration', 'velocity', 'speed',
    'displacement', 'distance and displacement', 'motion in one dimension',
  ] },
  { childTopic: 'Energy', parentTopic: 'Mechanics', phrases: [
    'kinetic energy', 'gravitational potential energy', 'mechanical energy', 'conservation of energy',
  ] },
  { childTopic: 'Waves and sound', parentTopic: 'Waves and Optics', phrases: [
    'wave property', 'wavelength', 'frequency', 'amplitude', 'wave speed', 'sound wave',
    'sound', 'transverse wave', 'longitudinal wave', 'wave',
  ] },
  { childTopic: 'Electromagnetic radiation', parentTopic: 'Waves and Optics', phrases: [
    'electromagnetic radiation', 'electromagnetic spectrum', 'photon', 'wave nature of light',
  ] },
  { childTopic: 'Hydrosphere', parentTopic: 'Chemical Systems', phrases: [
    'hydrosphere', 'water purification', 'water cycle', 'water quality',
  ] },
  { childTopic: 'Graphs and data analysis', parentTopic: 'Scientific Investigations', phrases: [
    'graph gradient', 'gradient of a graph', 'graph interpretation', 'graph construction',
    'graphical analysis', 'graph sketch', 'graphing', 'graphs', 'data analysis', 'data handling',
  ] },
  { childTopic: 'Scientific investigations', parentTopic: 'Scientific Investigations', phrases: [
    'scientific investigation', 'scientific method', 'investigative question',
    'independent variable', 'dependent variable', 'controlled variable', 'scientific conclusion',
    'laboratory safety',
  ] },
];

const PHYSICAL_SCIENCES_GRADE_11_TEXT_RULES = [
  { childTopic: 'Acids and bases', parentTopic: 'Chemical Change', phrases: [
    'acid base', 'acids and bases', 'acid base reaction', 'acid base titration', 'acid base pair',
    'conjugate acid', 'conjugate base', 'bronsted lowry', 'ampholyte', 'neutralisation',
    'neutralization', 'indicator', 'ph', 'salt preparation', 'salts preparation',
  ] },
  { childTopic: 'Redox reactions', parentTopic: 'Chemical Change', phrases: [
    'redox', 'oxidation reduction', 'oxidation number', 'oxidation state', 'oxidising agent',
    'oxidizing agent', 'reducing agent', 'half reaction', 'reduction half', 'oxidation half',
    'oxidation', 'reduction', 'reactivity series',
  ] },
  { childTopic: 'Chemical equations and formulae', parentTopic: 'Chemical Change', phrases: [
    'balanced chemical equation', 'balanced chemical equations', 'balancing chemical equation',
    'balancing chemical equations', 'balancing equation', 'balancing equations',
    'chemical equation', 'chemical equations', 'ionic equation', 'ionic equations',
    'chemical formula', 'chemical formulas', 'chemical formulae', 'chemical name and formula',
    'chemical names and formulas', 'chemical nomenclature',
  ] },
  { childTopic: 'Stoichiometry and mole calculations', parentTopic: 'Chemical Change', phrases: [
    'stoichiometry', 'stoichiometric calculation', 'quantitative chemistry', 'mole calculation',
    'mole concept', 'mole ratio', 'molar mass', 'limiting reagent', 'limiting reagents',
    'empirical formula', 'molecular formula', 'percentage composition', 'percentage purity',
    'gas stoichiometry', 'combustion analysis', 'gas volume calculation', 'mole and gas volume', 'moles and volume', 'molar gas volume',
    'mass calculation', 'mass calculations',
  ] },
  { childTopic: 'Solutions and concentration', parentTopic: 'Chemical Change', phrases: [
    'concentration calculation', 'concentration of solution', 'solution concentration',
    'concentration of solutions', 'concentration', 'moles in solution', 'moles in solutions', 'molar concentration',
  ] },
  { childTopic: 'Rates of reaction', parentTopic: 'Chemical Change', phrases: [
    'chemical kinetics', 'reaction rate', 'reaction rates', 'rate of reaction', 'rates of reaction',
    'activation energy', 'activated complex', 'catalyst', 'catalysts',
  ] },
  { childTopic: 'Energy changes in chemical reactions', parentTopic: 'Chemical Change', phrases: [
    'thermochemistry', 'endothermic', 'exothermic', 'enthalpy change', 'reaction energy',
    'energy change in chemical reaction', 'energy changes in chemical reaction',
    'potential energy diagram', 'potential energy diagrams', 'energy diagram', 'energy diagrams', 'energy profile',
  ] },
  { childTopic: 'Chemical reactions', parentTopic: 'Chemical Change', phrases: ['chemical reaction'] },
  { childTopic: 'Chemical equilibrium', parentTopic: 'Chemical Systems', phrases: [
    'chemical equilibrium', 'equilibrium constant', 'equilibrium position',
  ] },
  { childTopic: 'Mining and extraction of metals', parentTopic: 'Chemical Systems', phrases: [
    'mining method', 'mining methods', 'economic importance of mining',
    'environmental impact of mining', 'environmental impacts of mining', 'extraction of metal',
    'iron extraction', 'gold extraction', 'properties and uses of gold',
  ] },
  { childTopic: 'Environmental impacts', parentTopic: 'Chemical Systems', phrases: [
    'environmental impact', 'environmental impacts', 'carbon dioxide emission', 'carbon dioxide emissions',
  ] },
  { childTopic: 'Chemical bonding and molecular structure', parentTopic: 'Matter and Materials', phrases: [
    'chemical bonding', 'bond polarity', 'bond length', 'dative bond', 'dative bonding', 'lewis diagram',
    'lewis diagrams', 'lewis structure', 'lewis structures', 'molecular geometry', 'molecular polarity', 'molecular shape',
    'molecular structure', 'electronegativity', 'hydrogen bond', 'bond energy',
  ] },
  { childTopic: 'Intermolecular forces and physical properties', parentTopic: 'Matter and Materials', phrases: [
    'intermolecular force', 'london force', 'boiling point', 'vapour pressure',
    'vapor pressure', 'evaporation', 'phase of matter', 'states of matter', 'solubility',
  ] },
  { childTopic: 'Gases and gas laws', parentTopic: 'Matter and Materials', phrases: [
    'absolute zero', 'boyle law', 'charles law', 'combined gas law', 'ideal gas equation',
    'ideal gas law', 'ideal gas laws', 'gas law', 'gas laws', 'kinetic molecular theory',
    'kinetic theory of gas', 'real gas', 'gas identification', 'gases', 'gas pressure', 'gas volume', 'pressure and temperature',
    'pressure temperature relationship', 'pressure and volume', 'pressure volume temperature',
    'volume temperature relationship', 'gas graph', 'gas graphs',
  ] },
  { childTopic: 'Atomic structure', parentTopic: 'Matter and Materials', phrases: [
    'atomic structure', 'atom structure',
  ] },
  { childTopic: 'Electromagnetic induction', parentTopic: 'Electricity and Magnetism', phrases: [
    'electromagnetic induction', 'faraday law', 'lenz law', 'magnetic flux',
  ] },
  { childTopic: 'Electrostatics', parentTopic: 'Electricity and Magnetism', phrases: [
    'electrostatics', 'electrostatic force', 'coulomb law', 'electric charge',
    'electric field strength', 'electric fields', 'electric field', 'charge redistribution', 'inverse square law',
  ] },
  { childTopic: 'Magnetic fields', parentTopic: 'Electricity and Magnetism', phrases: [
    'magnetic field patterns', 'magnetic field pattern', 'magnetic fields', 'magnetic field', 'magnetism', 'electromagnetism',
  ] },
  { childTopic: 'Electrical energy and power', parentTopic: 'Electricity and Magnetism', phrases: [
    'electrical energy', 'electrical power', 'power and time',
    'electricity cost',
  ] },
  { childTopic: 'Electric circuits', parentTopic: 'Electricity and Magnetism', phrases: [
    'electric circuit', 'electric circuits', 'electrical circuit', 'electrical circuits', 'circuit analysis', 'series and parallel circuit',
    'series and parallel circuits', 'parallel circuit', 'parallel circuits', 'resistor in parallel',
    'resistors in parallel', 'resistance in series and parallel', 'ohm law', 'electric current',
    'potential difference', 'ammeter', 'ammeters', 'voltmeter', 'voltmeters', 'electrical resistance',
    'electricity',
  ] },
  { childTopic: 'Geometrical optics', parentTopic: 'Waves and Optics', phrases: [
    'geometrical optic', 'refraction', 'angle of refraction', 'critical angle',
    'refractive index', 'relative refractive index', 'snell law', 'total internal reflection',
    'optical density', 'optical fibre', 'optical fiber', 'speed of light',
  ] },
  { childTopic: 'Diffraction', parentTopic: 'Waves and Optics', phrases: [
    'diffraction', 'huygens principle', 'single slit',
  ] },
  { childTopic: 'Wave properties', parentTopic: 'Waves and Optics', phrases: [
    'wave nature of light', 'wave optics', 'wave properties', 'wavelength', 'frequency', 'waves',
  ] },
  { childTopic: 'Geometrical optics', parentTopic: 'Waves and Optics', phrases: ['optics'] },
  { childTopic: 'Universal gravitation', parentTopic: 'Mechanics', phrases: [
    'universal gravitation', 'newton law of gravitation', 'newton law of universal gravitation',
    'gravitational field', 'gravitational force', 'gravitational acceleration', 'satellite motion',
    'weightlessness',
  ] },
  { childTopic: 'Vectors and scalars', parentTopic: 'Mechanics', phrases: [
    'scalars and vectors', 'vector component', 'vector addition', 'resultant vector', 'force vector',
    'resolution of force', 'components of force',
  ] },
  { childTopic: 'Newton\'s laws of motion', parentTopic: 'Mechanics', phrases: [
    'newton first law', 'newton second law', 'newton third law', 'newton law of motion',
    'newton laws', 'newtonian mechanics', 'inertia',
  ] },
  { childTopic: 'Forces', parentTopic: 'Mechanics', phrases: [
    'inclined plane', 'free body diagram', 'force diagram', 'equilibrium of force',
    'force equilibrium', 'force calculation', 'force direction', 'force system', 'net force',
    'resultant force', 'frictional force', 'kinetic friction', 'friction', 'normal force',
    'tension force', 'tension', 'weight and mass', 'mass and acceleration', 'force and acceleration',
    'weight', 'forces',
  ] },
  { childTopic: 'Kinematics', parentTopic: 'Mechanics', phrases: [
    'constant velocity', 'free fall', 'direction of acceleration', 'acceleration', 'velocity',
    'speed',
  ] },
  { childTopic: 'Graphs and data analysis', parentTopic: 'Scientific Investigations', phrases: [
    'graph gradient', 'gradient of a graph', 'graph interpretation', 'graph construction',
    'graphical analysis', 'graph sketch', 'graphing', 'graphs', 'data analysis', 'data handling', 'graphs and functions',
  ] },
  { childTopic: 'Scientific investigations', parentTopic: 'Scientific Investigations', phrases: [
    'scientific investigation', 'scientific method', 'investigative question',
    'independent variable', 'independent variables', 'dependent variable', 'dependent variables',
    'controlled variable', 'controlled variables', 'scientific conclusion', 'scientific conclusions',
    'laboratory safety',
  ] },
];

const materialisePhysicalSciencesTopics = (subject, grade) => {
  const topics = grade === 'Grade 10' ? PHYSICAL_SCIENCES_GRADE_10_TOPICS : PHYSICAL_SCIENCES_GRADE_11_TOPICS;
  return topics.map(([childTopic, parentTopic]) => ({
  subject,
  grade,
  parentTopic,
  childTopic,
  canonicalLabel: `${childTopic} | ${parentTopic}`,
  aliases: [childTopic],
  }));
};

const materialiseEntries = (subject, grade) => {
  if (subject === 'Mathematics') {
    return getMathDefinitions(grade).flatMap(({ parentTopic, children }) => children.map(({ childTopic, aliases }) => ({
      subject,
      grade,
      parentTopic,
      childTopic,
      canonicalLabel: `${childTopic} | ${parentTopic}`,
      aliases,
    })));
  }

  const names = LEGACY_TOPICS_BY_SUBJECT[subject] ?? [];
  const entries = names.map((childTopic) => {
    const parentTopic = getLegacyParent(subject, childTopic);
    return {
      subject,
      grade,
      parentTopic,
      childTopic,
      canonicalLabel: `${childTopic} | ${parentTopic}`,
      aliases: [childTopic],
    };
  });
  if (subject === 'Physical Sciences' && ['Grade 10', 'Grade 11'].includes(grade)) {
    const detailed = materialisePhysicalSciencesTopics(subject, grade);
    const keys = new Set(entries.map((entry) => normaliseTopic(entry.canonicalLabel)));
    return [...entries, ...detailed.filter((entry) => !keys.has(normaliseTopic(entry.canonicalLabel)))];
  }
  return entries;
};

export const TOPIC_CATALOG_BY_SUBJECT_GRADE = Object.fromEntries(SUBJECTS.map((subject) => [
  subject,
  Object.fromEntries(SOUTH_AFRICAN_GRADES.filter((grade) => grade !== 'Select Grade').map((grade) => [grade, materialiseEntries(subject, grade)])),
]));

const MATH_ALIAS_TARGETS = [
  { aliases: ['whole numbers'], childTopic: 'Whole-number operations', parentTopic: 'Numbers', band: 'primary' },
  { aliases: ['number patterns', 'numeric and geometric patterns'], childTopic: 'Numeric patterns', parentTopic: 'Patterns and Relationships', band: 'senior' },
  { aliases: ['number patterns', 'number patterns and sequences', 'sequence', 'sequences', 'sequence and series', 'linear sequence', 'arithmetic sequence'], childTopic: 'Arithmetic sequences', parentTopic: 'Number Patterns', band: 'fet' },
  { aliases: ['geometric sequence', 'geometric sequences'], childTopic: 'Geometric sequences', parentTopic: 'Number Patterns', band: 'fet' },
  { aliases: ['quadratic sequence', 'quadratic sequences'], childTopic: 'Quadratic sequences', parentTopic: 'Number Patterns', band: 'fet' },
  { aliases: ['functions and relationships', 'linear function', 'linear functions'], childTopic: 'Linear functions', parentTopic: 'Functions', band: 'fet' },
  { aliases: ['parabola', 'quadratic function', 'quadratic functions'], childTopic: 'Quadratic functions', parentTopic: 'Functions', band: 'fet' },
  { aliases: ['data handling', 'statistics'], childTopic: 'Data representations', parentTopic: 'Statistics', band: 'fet' },
  { aliases: ['scatter plot', 'scatter plots'], childTopic: 'Scatter plots', parentTopic: 'Statistics', band: 'fet' },
  { aliases: ['financial mathematics', 'finance growth and decay', 'finance growth decay'], childTopic: 'Simple and compound interest', parentTopic: 'Finance, Growth and Decay', band: 'fet' },
  { aliases: ['theorem of pythagoras', 'pythagoras theorem'], childTopic: 'Theorem of Pythagoras', parentTopic: 'Space and Shape', band: 'senior' },
  { aliases: ['functions', 'functions and relationships', 'linear function', 'linear functions'], childTopic: 'Linear functions', parentTopic: 'Functions', band: 'fet' },
  { aliases: ['algebra'], childTopic: 'Algebraic expressions', parentTopic: 'Algebra', band: 'fet' },
  { aliases: ['equations', 'equations and inequalities'], childTopic: 'Equations and inequalities', parentTopic: 'Algebra', band: 'fet' },
  { aliases: ['exponents'], childTopic: 'Surds and exponents', parentTopic: 'Algebra', band: 'fet' },
  { aliases: ['trigonometry'], childTopic: 'Trigonometric ratios', parentTopic: 'Trigonometry', band: 'fet' },
  { aliases: ['analytical geometry'], childTopic: 'Distance and midpoint', parentTopic: 'Analytical Geometry', band: 'fet' },
  { aliases: ['euclidean geometry', 'geometry of 2d shapes', 'geometry of straight lines'], childTopic: 'Geometric proofs', parentTopic: 'Euclidean Geometry', band: 'fet' },
  { aliases: ['probability', 'counting and probability'], childTopic: 'Probability rules', parentTopic: 'Counting and Probability', band: 'fet' },
  { aliases: ['calculus'], childTopic: 'Differentiation', parentTopic: 'Calculus', band: 'fet' },
  { aliases: ['measurement'], childTopic: 'Area and perimeter', parentTopic: 'Measurement', band: 'fet' },
  { aliases: ['graphs'], childTopic: 'Function transformations', parentTopic: 'Functions', band: 'fet' },
];

const FET_MATHEMATICS_TEXT_RULES = [
  { childTopic: 'Quadratic sequences', parentTopic: 'Number Patterns', phrases: ['quadratic sequence', 'quadratic number pattern', 'quadratic pattern', 'quadratic patterns'] },
  { childTopic: 'Geometric sequences', parentTopic: 'Number Patterns', phrases: ['geometric sequence', 'geometric number pattern'] },
  { childTopic: 'Arithmetic sequences', parentTopic: 'Number Patterns', phrases: ['arithmetic sequence', 'linear sequence', 'number pattern', 'numeric pattern'] },
  { childTopic: 'Arithmetic series', parentTopic: 'Number Patterns', phrases: ['arithmetic series'] },
  { childTopic: 'Geometric series', parentTopic: 'Number Patterns', phrases: ['geometric series'] },
  { childTopic: 'Sigma notation', parentTopic: 'Number Patterns', phrases: ['sigma notation', 'summation notation'] },
  { childTopic: 'Quadratic functions', parentTopic: 'Functions', phrases: ['quadratic function', 'parabola', 'parabolic function'] },
  { childTopic: 'Linear functions', parentTopic: 'Functions', phrases: ['linear function', 'straight line function', 'straight line graph'] },
  { childTopic: 'Exponential functions', parentTopic: 'Functions', phrases: ['exponential function', 'exponential graph'] },
  { childTopic: 'Logarithmic functions', parentTopic: 'Functions', phrases: ['logarithm', 'logarithmic function', 'log function'] },
  { childTopic: 'Inverse functions', parentTopic: 'Functions', phrases: ['inverse function'] },
  { childTopic: 'Function transformations', parentTopic: 'Functions', phrases: ['function transformation', 'transformations of functions', 'function shift', 'graph transformation'] },
  { childTopic: 'Tables and function rules', parentTopic: 'Functions', phrases: ['input output rule', 'function rule', 'table of values', 'function table'] },
  { childTopic: 'Function graphs', parentTopic: 'Functions', phrases: ['function graph', 'graphs of functions', 'sketching graphs'] },
  { childTopic: 'Function notation and domain', parentTopic: 'Functions', phrases: ['function notation', 'domain and range', 'domain of a function', 'range of a function'] },
  { childTopic: 'Independent and dependent variables', parentTopic: 'Functions', phrases: ['independent variable', 'dependent variable', 'independent and dependent variables'] },
  { childTopic: 'Algebraic expressions', parentTopic: 'Algebra', phrases: ['algebraic expression', 'simplifying expressions', 'factorisation', 'factorization'] },
  { childTopic: 'Equations and inequalities', parentTopic: 'Algebra', phrases: ['linear equation', 'inequality', 'simultaneous equations', 'quadratic equation', 'equations and inequalities'] },
  { childTopic: 'Algebraic fractions', parentTopic: 'Algebra', phrases: ['algebraic fraction', 'rational expression'] },
  { childTopic: 'Surds and exponents', parentTopic: 'Algebra', phrases: ['surds', 'exponent', 'indices', 'laws of exponents', 'laws of indices'] },
  { childTopic: 'Simple and compound interest', parentTopic: 'Finance, Growth and Decay', phrases: ['simple interest', 'compound interest', 'interest calculation'] },
  { childTopic: 'Depreciation', parentTopic: 'Finance, Growth and Decay', phrases: ['depreciation'] },
  { childTopic: 'Growth and decay', parentTopic: 'Finance, Growth and Decay', phrases: ['growth and decay', 'exponential growth', 'exponential decay'] },
  { childTopic: 'Annuities and loans', parentTopic: 'Finance, Growth and Decay', phrases: ['annuity', 'annuities', 'loan repayment', 'loans'] },
  { childTopic: 'Scatter plots', parentTopic: 'Statistics', phrases: ['scatter plot', 'scatter diagram'] },
  { childTopic: 'Correlation and regression', parentTopic: 'Statistics', phrases: ['correlation', 'regression', 'line of best fit'] },
  { childTopic: 'Bivariate data', parentTopic: 'Statistics', phrases: ['bivariate data', 'two variable data'] },
  { childTopic: 'Measures of central tendency', parentTopic: 'Statistics', phrases: ['mean median mode', 'measures of central tendency'] },
  { childTopic: 'Measures of dispersion', parentTopic: 'Statistics', phrases: ['standard deviation', 'variance', 'quartile', 'interquartile range', 'measures of dispersion'] },
  { childTopic: 'Data representations', parentTopic: 'Statistics', phrases: ['data handling', 'data representation', 'data graph', 'statistical graph'] },
  { childTopic: 'Trigonometric ratios', parentTopic: 'Trigonometry', phrases: ['trigonometric ratio', 'sine cosine tangent', 'sine rule', 'cosine rule', 'trigonometry'] },
  { childTopic: 'Trigonometric identities', parentTopic: 'Trigonometry', phrases: ['trigonometric identity', 'trigonometric identities'] },
  { childTopic: 'Trigonometric equations', parentTopic: 'Trigonometry', phrases: ['trigonometric equation', 'trig equation'] },
  { childTopic: 'Distance and midpoint', parentTopic: 'Analytical Geometry', phrases: ['distance formula', 'midpoint', 'distance and midpoint'] },
  { childTopic: 'Gradient and equation of a line', parentTopic: 'Analytical Geometry', phrases: ['gradient of a line', 'slope of a line', 'equation of a straight line', 'analytical geometry'] },
  { childTopic: 'Equation of a circle', parentTopic: 'Analytical Geometry', phrases: ['equation of a circle', 'circle geometry coordinates'] },
  { childTopic: 'Geometric proofs', parentTopic: 'Euclidean Geometry', phrases: ['geometric proof', 'geometry proof', 'euclidean geometry'] },
  { childTopic: 'Similarity and congruence', parentTopic: 'Euclidean Geometry', phrases: ['similarity', 'congruence', 'similar triangles', 'congruent triangles'] },
  { childTopic: 'Cyclic quadrilaterals', parentTopic: 'Euclidean Geometry', phrases: ['cyclic quadrilateral', 'cyclic quadrilaterals'] },
  { childTopic: 'Proportionality', parentTopic: 'Euclidean Geometry', phrases: ['proportionality', 'proportional sides'] },
  { childTopic: 'Theorem of Pythagoras', parentTopic: 'Space and Shape', phrases: ['pythagoras', 'pythagorean theorem'] },
  { childTopic: 'Perimeter and area', parentTopic: 'Measurement', phrases: ['perimeter', 'area of a shape', 'area and perimeter'] },
  { childTopic: 'Surface area and volume', parentTopic: 'Measurement', phrases: ['surface area', 'volume of a prism', 'volume of a solid'] },
  { childTopic: 'Metric conversions', parentTopic: 'Measurement', phrases: ['unit conversion', 'metric conversion', 'measurement conversion'] },
  { childTopic: 'Differentiation', parentTopic: 'Calculus', phrases: ['differentiation', 'derivative', 'first principles'] },
  { childTopic: 'Applications of derivatives', parentTopic: 'Calculus', phrases: ['application of derivatives', 'turning points', 'rate of change'] },
  { childTopic: 'Integration', parentTopic: 'Calculus', phrases: ['integration', 'integral calculus'] },
  { childTopic: 'Probability rules', parentTopic: 'Counting and Probability', phrases: ['probability rule', 'probability', 'complementary events'] },
  { childTopic: 'Fundamental counting principle', parentTopic: 'Counting and Probability', phrases: ['fundamental counting principle', 'counting principle'] },
  { childTopic: 'Permutations and combinations', parentTopic: 'Counting and Probability', phrases: ['permutation', 'combination', 'factorial notation'] },
  { childTopic: 'Independent and dependent events', parentTopic: 'Counting and Probability', phrases: ['independent events', 'dependent events'] },
];

const resolveFetMathematicsTextRule = ({ rawKey, catalog }) => {
  const matchingRules = FET_MATHEMATICS_TEXT_RULES.filter((item) => item.phrases.some((phrase) =>
    textIncludesTopicPhrase(rawKey, phrase)));
  for (const rule of matchingRules) {
    const match = catalog.find((entry) => entry.childTopic === rule.childTopic && entry.parentTopic === rule.parentTopic);
    if (match) return match;
  }
  return null;
};

export const getTopicCatalog = ({ subject, grade } = {}) => {
  if (!subject || !grade || grade === 'Select Grade') return [];
  return TOPIC_CATALOG_BY_SUBJECT_GRADE[subject]?.[grade] ?? [];
};

export const getHardcodedTopics = ({ subject, grade } = {}) =>
  getTopicCatalog({ subject, grade }).map((entry) => entry.canonicalLabel);

const resolvePhysicalSciencesTextRule = ({ rawKey, grade, catalog }) => {
  const rules = grade === 'Grade 10' ? PHYSICAL_SCIENCES_GRADE_10_TEXT_RULES : PHYSICAL_SCIENCES_GRADE_11_TEXT_RULES;
  const rule = rules.find((item) => item.phrases.some((phrase) =>
    textIncludesTopicPhrase(rawKey, phrase)));
  if (!rule) return null;
  return catalog.find((entry) => entry.childTopic === rule.childTopic && entry.parentTopic === rule.parentTopic) ?? null;
};

export const resolveTopic = ({ topic, subject, grade } = {}) => {
  const raw = String(topic ?? '').trim();
  if (!raw || !subject || !grade) return null;
  const catalog = getTopicCatalog({ subject, grade });
  const rawKey = normaliseTopic(raw);
  const exact = catalog.find((entry) => normaliseTopic(entry.canonicalLabel) === rawKey);
  if (exact) return { ...exact, matchType: 'canonical' };

  const alias = catalog.find((entry) => entry.aliases.some((value) => normaliseTopic(value) === rawKey));
  if (alias) return { ...alias, matchType: 'alias' };

  if (subject === 'Mathematics') {
    const band = gradeBandFor(grade);
    const target = MATH_ALIAS_TARGETS.find((item) => item.band === band && item.aliases.some((value) => normaliseTopic(value) === rawKey));
    if (target) {
      const match = catalog.find((entry) => entry.childTopic === target.childTopic && entry.parentTopic === target.parentTopic);
      if (match) return { ...match, matchType: 'alias' };
    }
    if (['Grade 10', 'Grade 11'].includes(grade)) {
      const ruleMatch = resolveFetMathematicsTextRule({ rawKey, catalog });
      if (ruleMatch) return { ...ruleMatch, matchType: 'rule' };
    }
  }

  if (subject === 'Physical Sciences' && ['Grade 10', 'Grade 11'].includes(grade)) {
    const ruleMatch = resolvePhysicalSciencesTextRule({ rawKey, grade, catalog });
    if (ruleMatch) return { ...ruleMatch, matchType: 'rule' };
  }
  return null;
};

export const mergeTopicOptions = ({ extractedTopics = [], subject, grade } = {}) => {
  const extracted = extractedTopics
    .map((topic) => resolveTopic({ topic, subject, grade })?.canonicalLabel)
    .filter(Boolean);
  return [...new Set([...extracted, ...getHardcodedTopics({ subject, grade })])]
    .sort((left, right) => left.localeCompare(right));
};

export const getTopicOptionGroups = ({ extractedTopics = [], subject, grade } = {}) => {
  const extracted = [...new Set(extractedTopics
    .map((topic) => resolveTopic({ topic, subject, grade })?.canonicalLabel)
    .filter(Boolean))]
    .sort((left, right) => left.localeCompare(right));
  const extractedKeys = new Set(extracted.map(normaliseTopic));
  const manual = getHardcodedTopics({ subject, grade })
    .filter((topic) => !extractedKeys.has(normaliseTopic(topic)))
    .sort((left, right) => left.localeCompare(right));
  return { extracted, manual, all: [...extracted, ...manual] };
};

export const getTopicGradeOptions = ({ subject } = {}) =>
  SOUTH_AFRICAN_GRADES.filter((grade) => grade !== 'Select Grade' && getTopicCatalog({ subject, grade }).length > 0);

export const normalizeTopicKey = normaliseTopic;
