const group = (parentTopic, children) => ({ parentTopic, children });

const fet = (grade10, grade11 = grade10, grade12 = grade11) => ({
  'Grade 10': grade10,
  'Grade 11': grade11,
  'Grade 12': grade12,
});

const CAPS_FET_TOPICS = {
  'Mathematical Literacy': fet([
    group('Numbers and Operations', ['Numbers and calculations', 'Percentages, ratios and rates', 'Patterns and relationships', 'Tables, equations and graphs']),
    group('Finance', ['Income and expenditure', 'Budgets', 'Banking and accounts', 'Tariffs and costs', 'Taxation', 'Interest', 'Inflation', 'Exchange rates']),
    group('Measurement', ['Units and conversions', 'Time and schedules', 'Length, area and volume', 'Perimeter and surface area']),
    group('Maps, Plans and Scale', ['Maps and directions', 'Scale and distance', 'Plans and layouts', 'Representations of the physical world']),
    group('Statistics', ['Data collection', 'Data organisation and representation', 'Measures of central tendency', 'Interpreting data']),
    group('Probability', ['Probability']),
  ], [
    group('Numbers and Operations', ['Numbers and calculations', 'Percentages, ratios and rates', 'Patterns and relationships', 'Tables, equations and graphs']),
    group('Finance', ['Income and expenditure', 'Budgets', 'Banking and accounts', 'Tariffs and costs', 'Taxation', 'Interest', 'Inflation', 'Exchange rates']),
    group('Measurement', ['Units and conversions', 'Time and schedules', 'Length, area and volume', 'Perimeter and surface area']),
    group('Maps, Plans and Scale', ['Maps and directions', 'Scale and distance', 'Plans and layouts', 'Representations of the physical world']),
    group('Statistics', ['Data collection', 'Data organisation and representation', 'Measures of central tendency', 'Measures of spread', 'Interpreting data']),
    group('Probability', ['Probability']),
  ], [
    group('Numbers and Operations', ['Numbers and calculations', 'Percentages, ratios and rates', 'Patterns and relationships', 'Tables, equations and graphs']),
    group('Finance', ['Income and expenditure', 'Budgets', 'Banking and accounts', 'Tariffs and costs', 'Taxation', 'Interest', 'Inflation', 'Exchange rates']),
    group('Measurement', ['Units and conversions', 'Time and schedules', 'Length, area and volume', 'Perimeter and surface area']),
    group('Maps, Plans and Scale', ['Maps and directions', 'Scale and distance', 'Plans and layouts', 'Representations of the physical world']),
    group('Statistics', ['Data collection', 'Data organisation and representation', 'Measures of central tendency', 'Measures of spread', 'Interpreting data']),
    group('Probability', ['Probability']),
  ]),
  'Life Sciences': fet([
    group('Life at the Molecular, Cellular and Tissue Level', ['Chemistry of life', 'Cell structure and function', 'Mitosis', 'Plant and animal tissues']),
    group('Life Processes', ['Support and transport in plants', 'Support systems in animals', 'Transport in mammals']),
    group('Diversity, Change and Continuity', ['Biodiversity and classification', 'History of life on Earth']),
    group('Environmental Studies', ['Biosphere and ecosystems']),
  ], [
    group('Life Processes', ['Photosynthesis', 'Animal nutrition', 'Cellular respiration', 'Gas exchange', 'Excretion']),
    group('Diversity, Change and Continuity', ['Classification of microorganisms', 'Plant diversity', 'Plant reproduction', 'Animal diversity']),
    group('Environmental Studies', ['Population ecology', 'Human impact on the environment']),
  ], [
    group('Life at the Molecular, Cellular and Tissue Level', ['DNA and the genetic code', 'RNA and protein synthesis', 'Meiosis']),
    group('Life Processes', ['Reproduction in vertebrates', 'Human reproduction', 'Nervous system', 'Senses', 'Endocrine system', 'Homeostasis']),
    group('Diversity, Change and Continuity', ['Darwinism and natural selection', 'Human evolution']),
    group('Environmental Studies', ['Human impact on the environment']),
  ]),
  Accounting: fet([
    group('Financial Accounting', ['Accounting concepts and GAAP', 'Bookkeeping for sole traders', 'Accounting equation', 'Journals and ledgers', 'Trial balance', 'Final accounts and financial statements', 'Salaries and wages', 'Value-added tax', 'Debtors and creditors reconciliation', 'Depreciation', 'Perpetual inventory']),
    group('Managerial Accounting', ['Cost concepts and calculations', 'Budget concepts']),
    group('Managing Resources', ['Indigenous bookkeeping systems', 'Ethics', 'Internal control']),
  ], [
    group('Financial Accounting', ['Partnership accounting concepts', 'Partnership bookkeeping', 'Accounting equation for partnerships', 'Partnership financial statements', 'Club receipts and payments', 'Value-added tax calculations', 'Bank and creditors reconciliation', 'Fixed-asset acquisition and disposal', 'Periodic inventory system']),
    group('Managerial Accounting', ['Cost calculations and ledger accounts', 'Cash budgets']),
    group('Managing Resources', ['Ethics and internal control', 'Inventory systems']),
  ], [
    group('Financial Accounting', ['Company accounting concepts', 'Company bookkeeping', 'Accounting equation for companies', 'Company financial statements', 'Value-added tax ledger accounts', 'Bank, debtors and creditors reconciliations', 'Inventory valuation', 'Fixed-asset analysis']),
    group('Managerial Accounting', ['Production cost statements', 'Unit costs', 'Cash-budget analysis']),
    group('Managing Resources', ['Ethics and corporate governance', 'Internal control and reporting']),
  ]),
  'Business Studies': fet([
    group('Business Environments', ['Micro environment', 'Market environment', 'Macro environment', 'Business sectors', 'Business legislation']),
    group('Business Ventures', ['Entrepreneurship', 'Forms of ownership', 'Business location', 'Business plans', 'Contracts', 'Business information and presentations']),
    group('Business Roles', ['Creative thinking and problem solving', 'Ethics and professionalism', 'Social responsibility', 'Team performance']),
    group('Business Operations', ['Human resources', 'Marketing activities', 'Production function']),
  ], [
    group('Business Environments', ['Business strategies', 'Business legislation and compliance', 'Business challenges']),
    group('Business Ventures', ['Investment: securities', 'Investment: insurance', 'Entrepreneurial qualities', 'Presentation of business information']),
    group('Business Roles', ['Human rights and inclusivity', 'Environmental responsibility', 'Team dynamics', 'Conflict management']),
    group('Business Operations', ['Marketing function', 'Production planning', 'Quality of performance']),
  ], [
    group('Business Environments', ['Impact of recent legislation', 'Business strategies and challenges']),
    group('Business Ventures', ['Investment decisions', 'Insurance', 'Entrepreneurship and business opportunities']),
    group('Business Roles', ['Corporate social responsibility', 'Corporate citizenship', 'Ethics and professionalism']),
    group('Business Operations', ['Human resource function', 'Marketing function', 'Quality of performance', 'Business operations strategies']),
  ]),
  Economics: fet([
    group('Macroeconomics', ['Basic economic concepts', 'Basic economic problem', 'Circular flow', 'Quantitative elements', 'Economic systems']),
    group('Microeconomics', ['Dynamics of markets', 'Demand and supply', 'Market equilibrium']),
    group('Economic Pursuits', ['Economic growth and development', 'Money and banking']),
    group('Contemporary Economic Issues', ['Inflation', 'Tourism', 'Economic issues and data']),
  ], [
    group('Macroeconomics', ['Business cycles', 'Public sector and the South African economy']),
    group('Microeconomics', ['Market structures', 'Market failures']),
    group('Economic Pursuits', ['Population and labour force', 'Labour market', 'Redress since 1994']),
    group('Contemporary Economic Issues', ['Unemployment', 'Labour relations', 'Poverty']),
  ], [
    group('Macroeconomics', ['Business cycles and economic policy', 'Public sector economics']),
    group('Microeconomics', ['Market dynamics and market structures']),
    group('Economic Pursuits', ['Economic growth and development', 'Globalisation and international trade']),
    group('Contemporary Economic Issues', ['Inflation', 'Unemployment', 'Labour relations', 'Tourism', 'Poverty', 'Globalisation']),
  ]),
  History: fet([
    group('Historical Themes', ['Societies of the wider world in ancient times', 'Mali: rise and decline of an African empire', 'Ancient Ethiopia', 'Southern African kingdoms and Great Zimbabwe', 'African societies since the 1750s', 'Achievements of African people']),
    group('Historical Skills', ['Source analysis', 'Historical essay']),
  ], [
    group('Historical Themes', ['Europe and the wider world: 15th to 18th centuries', 'Europe and the wider world: 16th to 19th centuries', 'The Haitian Revolution and the slave trade', 'Southern African kingdoms to the 19th century', 'The Scramble for Africa']),
    group('Historical Skills', ['Source analysis', 'Historical essay']),
  ], [
    group('Historical Themes', ['South African politics and economics in the 19th and 20th centuries', 'The national question and political organisations in South Africa', 'The Cold War and anti-colonial struggles', 'Liberation struggles and apartheid in Africa', 'Anti-apartheid resistance in South Africa', 'Democracy in South Africa and coming to terms with the past']),
    group('Historical Skills', ['Source analysis', 'Historical essay']),
  ]),
  Geography: fet([
    group('The Atmosphere', ['Atmospheric composition and structure', 'Heating of the atmosphere', 'Atmospheric moisture', 'Synoptic weather maps']),
    group('Geomorphology', ['Structure of the Earth', 'Plate tectonics', 'Folding and faulting', 'Earthquakes and volcanoes']),
    group('Population', ['Population distribution and density', 'Population structure and growth', 'Population movements']),
    group('Geographical Skills', ['Atlas and map skills', 'Topographic maps', 'Fieldwork']),
  ], [
    group('The Atmosphere', ['Earth energy balance', 'Global air circulation', 'Africa weather and climate', 'Drought and desertification']),
    group('Geomorphology', ['Rock structure and landforms', 'Slopes', 'Mass movements']),
    group('Development Geography', ['Development concepts and frameworks', 'Trade and development', 'Development challenges and aid']),
    group('Geographical Skills', ['Aerial photographs and orthophoto maps', 'Mapwork and fieldwork', 'Geographical information systems']),
  ], [
    group('Climate and Weather', ['Mid-latitude cyclones', 'Tropical cyclones', 'Subtropical anticyclones', 'Valley climates', 'Urban climates']),
    group('Geomorphology', ['Drainage systems in South Africa', 'Fluvial processes', 'Catchment and river management']),
    group('Settlement Geography', ['Rural settlements and issues', 'Urban settlements and hierarchies', 'Urban structure and patterns', 'Urban settlement issues']),
    group('Economic Geography of South Africa', ['Structure of the economy', 'Agriculture', 'Mining', 'Secondary and tertiary sectors', 'Industrial development', 'Informal sector']),
    group('Geographical Skills', ['Topographic mapwork', 'Atlas work', 'Geographical information systems']),
  ]),
  'Computer Applications Technology': fet([
    group('Solution Development', ['Word processing', 'Spreadsheets', 'Presentations', 'Basic database concepts']),
    group('Systems Technologies', ['Computer systems and hardware', 'System software', 'Computer management']),
    group('Network Technologies', ['Network concepts', 'Personal and home area networks', 'Internet access']),
    group('Internet Technologies', ['Internet and the world wide web', 'Web browsing and communication']),
    group('Information Management', ['Data and information', 'Information processing', 'Information management cycle']),
    group('Social Implications', ['ICTs in society', 'Ergonomics, safety and security']),
  ], [
    group('Solution Development', ['Word processing advanced features', 'Spreadsheet functions and analysis', 'Database design and queries', 'Integrated documents']),
    group('Systems Technologies', ['Hardware components and performance', 'Operating systems and processing', 'Computer security and management']),
    group('Network Technologies', ['LAN and WLAN', 'Network components and connections', 'Intranet and network security']),
    group('Internet Technologies', ['Internet services', 'Web technologies and standards']),
    group('Information Management', ['Data validation and processing', 'Information evaluation and presentation']),
    group('Social Implications', ['Digital citizenship', 'Privacy, security and the digital divide']),
  ], [
    group('Solution Development', ['Advanced spreadsheets and modelling', 'Database management', 'Integrated problem solving']),
    group('Systems Technologies', ['System selection and emerging technologies', 'Computer management and data integrity']),
    group('Network Technologies', ['Wide area networks', 'Internet as a wide area network', 'Internet access decisions']),
    group('Internet Technologies', ['Internet services and communication standards', 'Web development concepts']),
    group('Information Management', ['Information systems and decision making', 'Information presentation']),
    group('Social Implications', ['ICT ethics and legislation', 'Technology trends and society']),
  ]),
  'Information Technology': fet([
    group('Solution Development', ['Problem solving and algorithms', 'Programming fundamentals', 'Data representation']),
    group('Systems Technologies', ['Computer system concepts', 'Hardware and system software', 'Computer management']),
    group('Communication Technologies', ['Network concepts', 'Data communication']),
    group('Internet Technologies', ['Internet and web concepts']),
    group('Information Management', ['Database concepts', 'Data modelling']),
    group('Social Implications', ['ICT ethics and social impact']),
  ], [
    group('Solution Development', ['Modular programming', 'Data structures', 'Object-oriented programming']),
    group('Systems Technologies', ['Computer architecture', 'Operating systems and virtualisation', 'Security and performance']),
    group('Communication Technologies', ['Network architecture and protocols', 'Network security']),
    group('Internet Technologies', ['Web application concepts']),
    group('Information Management', ['Relational databases', 'SQL and database applications']),
    group('Social Implications', ['Privacy, security and legal issues']),
  ], [
    group('Solution Development', ['Advanced algorithms and programming', 'Object-oriented design', 'Software development']),
    group('Systems Technologies', ['System performance and emerging technologies', 'Cloud computing and virtualisation']),
    group('Communication Technologies', ['Network services and security']),
    group('Internet Technologies', ['Internet services and web applications']),
    group('Information Management', ['Database design, SQL and transactions']),
    group('Social Implications', ['ICT ethics, law and social impact']),
  ]),
  'Engineering Graphics and Design': fet([
    group('Drawing Principles', ['Linework and lettering', 'Geometric constructions', 'Scales and dimensioning']),
    group('Mechanical Drawing', ['Orthographic projection', 'Isometric drawing', 'Basic mechanical components']),
    group('Civil Drawing', ['Orthographic views', 'Floor plans and elevations', 'Site plans']),
    group('Freehand Drawing', ['Freehand isometric drawing', 'Freehand orthographic drawing']),
    group('Computer-Aided Drawing', ['CAD tools and drawing conventions']),
  ], [
    group('Drawing Principles', ['Geometric constructions and loci', 'Dimensioning and drawing conventions']),
    group('Mechanical Drawing', ['Assembly and sectional views', 'Isometric and orthographic projection', 'Development of surfaces']),
    group('Civil Drawing', ['Civil plans and elevations', 'Sections and construction details']),
    group('Perspective Drawing', ['One-point and two-point perspective']),
    group('Computer-Aided Drawing', ['CAD modelling and presentation']),
  ], [
    group('Drawing Principles', ['Advanced geometric constructions', 'Drawing interpretation and design']),
    group('Mechanical Drawing', ['Working drawings and assemblies', 'Sections and developments', 'Mechanisms']),
    group('Civil Drawing', ['Working drawings', 'Site and landscape plans', 'Building sections']),
    group('Perspective Drawing', ['Perspective and pictorial views']),
    group('Computer-Aided Drawing', ['CAD design and documentation']),
  ]),
  'Agricultural Sciences': fet([
    group('Soil Science', ['Soil formation and composition', 'Soil properties', 'Soil water']),
    group('Plant Studies', ['Plant structure and function', 'Plant nutrition', 'Plant production']),
    group('Animal Studies', ['Animal structure and function', 'Animal nutrition', 'Animal production']),
    group('Basic Agricultural Chemistry', ['Atoms, molecules and compounds', 'Chemical reactions in agriculture']),
    group('Agricultural Economics', ['Agricultural production factors', 'Farm planning and records']),
  ], [
    group('Soil Science', ['Soil fertility and conservation', 'Soil preparation and management']),
    group('Plant Studies', ['Plant reproduction and propagation', 'Crop production systems']),
    group('Animal Studies', ['Animal reproduction and breeding', 'Animal health and production']),
    group('Agricultural Genetics', ['Genetics and inheritance', 'Selection and breeding']),
    group('Agricultural Economics', ['Farm management', 'Agricultural markets and finance']),
  ], [
    group('Soil Science', ['Sustainable soil management', 'Soil and water conservation']),
    group('Plant Studies', ['Crop production and protection', 'Plant improvement']),
    group('Animal Studies', ['Animal production systems', 'Animal improvement and health']),
    group('Agricultural Genetics', ['Genetics and breeding', 'Biotechnology in agriculture']),
    group('Agricultural Economics', ['Agricultural management', 'Agricultural policy and markets']),
    group('Sustainable Agriculture', ['Sustainable production systems', 'Agriculture and the environment']),
  ]),
  Tourism: fet([
    group('Tourism Sectors', ['Tourism sectors and services', 'Transport in tourism', 'Accommodation']),
    group('Tourism Geography', ['Map work and tour planning', 'South African tourist attractions']),
    group('Tourism Culture and Heritage', ['Culture and heritage tourism']),
    group('Tourism Marketing', ['Tourism marketing and promotion']),
    group('Customer Care', ['Communication and customer care']),
    group('Tourism Economy', ['Foreign exchange']),
  ], [
    group('Tourism Sectors', ['Domestic, regional and international tourism', 'Tourism organisations']),
    group('Tourism Geography', ['Tour planning and itineraries', 'Tourist attractions and destinations']),
    group('Tourism Culture and Heritage', ['World heritage and cultural tourism']),
    group('Tourism Marketing', ['Tourism products and marketing']),
    group('Customer Care', ['Customer service and communication']),
    group('Responsible Tourism', ['Sustainable and responsible tourism']),
  ], [
    group('Tourism Sectors', ['Domestic, regional and international tourism', 'Tourism trends']),
    group('Tourism Geography', ['Tour planning and destinations', 'Tourism map work']),
    group('Tourism Culture and Heritage', ['Cultural and heritage tourism']),
    group('Tourism Marketing', ['Tourism marketing and promotion']),
    group('Customer Care', ['Customer care and quality service']),
    group('Responsible Tourism', ['Sustainable and responsible tourism', 'Tourism impacts']),
    group('Tourism Economy', ['Foreign exchange and travel documentation']),
  ]),
  'Consumer Studies': fet([
    group('Food and Nutrition', ['Food commodities', 'Nutrition and meal planning', 'Food preparation']),
    group('Clothing and Textiles', ['Textiles and clothing choices', 'Clothing construction']),
    group('Housing and Interiors', ['Housing needs and choices', 'Interior design principles']),
    group('Consumer Education', ['Consumer rights and responsibilities', 'Consumer decision making']),
    group('Entrepreneurship', ['Consumer-related entrepreneurship']),
  ], [
    group('Food and Nutrition', ['Food production and processing', 'Nutrition and food choices']),
    group('Clothing and Textiles', ['Clothing production and quality', 'Textile properties']),
    group('Housing and Interiors', ['Housing and furnishing', 'Interior design and space planning']),
    group('Consumer Education', ['Consumer protection and legislation', 'Consumer choices']),
    group('Entrepreneurship', ['Product development and marketing']),
  ], [
    group('Food and Nutrition', ['Food commodities and nutrition', 'Food enterprise and production']),
    group('Clothing and Textiles', ['Clothing enterprise and production']),
    group('Housing and Interiors', ['Housing enterprise and design']),
    group('Consumer Education', ['Consumer rights, legislation and finance']),
    group('Entrepreneurship', ['Entrepreneurship and business planning', 'Production and marketing']),
  ]),
  'Dramatic Arts': fet([
    group('Performance', ['Voice and speech', 'Movement and physical theatre', 'Acting skills']),
    group('Theatre Making', ['Improvisation', 'Creating and staging performance']),
    group('Theatre Studies', ['Theatre conventions and styles', 'Script and role analysis']),
    group('Theatre History', ['South African and world theatre contexts']),
  ], [
    group('Performance', ['Characterisation and performance skills', 'Voice and movement']),
    group('Theatre Making', ['Improvisation and devised theatre', 'Directing and staging']),
    group('Theatre Studies', ['Play text analysis', 'Theatre forms and conventions']),
    group('Theatre History', ['South African theatre history', 'Theatre in context']),
  ], [
    group('Performance', ['Advanced performance skills', 'Ensemble performance']),
    group('Theatre Making', ['Directing and production', 'Devised theatre']),
    group('Theatre Studies', ['Set-work analysis', 'Theatre criticism']),
    group('Theatre History', ['South African theatre and performance traditions', 'World theatre movements']),
  ]),
  'Visual Arts': fet([
    group('Visual Literacy', ['Visual analysis and interpretation', 'Art elements and design principles']),
    group('Art Making', ['Drawing and mark making', 'Painting and colour', 'Three-dimensional art']),
    group('Visual Culture Studies', ['South African art contexts', 'Historical and contemporary art']),
  ], [
    group('Visual Literacy', ['Visual analysis and meaning', 'Art movements and contexts']),
    group('Art Making', ['Drawing and painting', 'Printmaking and sculpture', 'Portfolio development']),
    group('Visual Culture Studies', ['South African and African art', 'Modern and contemporary art']),
  ], [
    group('Visual Literacy', ['Comparative visual analysis', 'Art criticism and interpretation']),
    group('Art Making', ['Resolved practical project', 'Portfolio and exhibition']),
    group('Visual Culture Studies', ['South African art history', 'Global contemporary art']),
  ]),
  Music: fet([
    group('Music Literacy', ['Notation and music theory', 'Aural perception', 'Harmony']),
    group('Music Performance', ['Solo performance', 'Ensemble performance']),
    group('Composition', ['Music composition and arrangement']),
    group('Music in Context', ['South African music', 'Music history and styles']),
  ], [
    group('Music Literacy', ['Music theory and notation', 'Aural analysis', 'Harmony and form']),
    group('Music Performance', ['Solo and ensemble performance']),
    group('Composition', ['Composition and arrangement']),
    group('Music in Context', ['South African and African music', 'Music history and style']),
  ], [
    group('Music Literacy', ['Advanced theory and notation', 'Aural analysis and harmony']),
    group('Music Performance', ['Prepared performance programme']),
    group('Composition', ['Composition, arrangement and analysis']),
    group('Music in Context', ['South African music and identity', 'Music history and context']),
  ]),
};

const LANGUAGE_SUBJECTS = [
  'English Home Language', 'English First Additional Language',
  'Afrikaans Home Language', 'Afrikaans First Additional Language',
  'isiZulu Home Language', 'isiXhosa Home Language', 'Sepedi Home Language',
  'Setswana Home Language', 'Sesotho Home Language',
];

const LANGUAGE_FET_TOPICS = fet(
  [
    group('Listening and Speaking', ['Listening comprehension', 'Prepared and unprepared speech', 'Oral communication']),
    group('Reading and Viewing', ['Reading comprehension', 'Visual literacy', 'Critical reading']),
    group('Writing and Presenting', ['Summary writing', 'Essay writing', 'Transactional writing']),
    group('Language Structures and Conventions', ['Sentence structure', 'Parts of speech', 'Punctuation and spelling', 'Vocabulary and figurative language']),
    group('Literature', ['Poetry analysis', 'Drama analysis', 'Novel and short-story analysis']),
  ],
  [
    group('Listening and Speaking', ['Listening comprehension', 'Prepared and unprepared speech', 'Oral communication']),
    group('Reading and Viewing', ['Reading comprehension', 'Visual literacy', 'Critical reading']),
    group('Writing and Presenting', ['Summary writing', 'Essay writing', 'Transactional writing']),
    group('Language Structures and Conventions', ['Sentence structure', 'Parts of speech', 'Punctuation and spelling', 'Vocabulary and figurative language']),
    group('Literature', ['Poetry analysis', 'Drama analysis', 'Novel and short-story analysis']),
  ],
  [
    group('Listening and Speaking', ['Listening comprehension', 'Prepared and unprepared speech', 'Oral communication']),
    group('Reading and Viewing', ['Reading comprehension', 'Visual literacy', 'Critical reading']),
    group('Writing and Presenting', ['Summary writing', 'Essay writing', 'Transactional writing']),
    group('Language Structures and Conventions', ['Sentence structure', 'Parts of speech', 'Punctuation and spelling', 'Vocabulary and figurative language']),
    group('Literature', ['Poetry analysis', 'Drama analysis', 'Novel and short-story analysis']),
  ],
);

const LANGUAGE_OTHER_GRADE_TOPICS = {
  'Grade 4': [
    group('Listening and Speaking', ['Listening comprehension', 'Oral interaction']),
    group('Reading and Viewing', ['Reading comprehension', 'Reading fluency', 'Visual literacy']),
    group('Writing and Presenting', ['Narrative writing', 'Informational writing', 'Writing process']),
    group('Language Structures and Conventions', ['Vocabulary', 'Sentence structure', 'Spelling and punctuation']),
    group('Literature', ['Poetry', 'Stories and literary texts']),
  ],
  'Grade 5': [
    group('Listening and Speaking', ['Listening comprehension', 'Prepared and unprepared speaking']),
    group('Reading and Viewing', ['Reading comprehension', 'Reading strategies', 'Visual literacy']),
    group('Writing and Presenting', ['Narrative and descriptive writing', 'Transactional writing', 'Editing and drafting']),
    group('Language Structures and Conventions', ['Parts of speech', 'Sentence structure', 'Spelling and punctuation']),
    group('Literature', ['Poetry', 'Stories and literary texts']),
  ],
  'Grade 6': [
    group('Listening and Speaking', ['Listening comprehension', 'Discussion and oral presentation']),
    group('Reading and Viewing', ['Reading comprehension', 'Critical reading', 'Visual literacy']),
    group('Writing and Presenting', ['Essay writing', 'Transactional writing', 'Editing and proofreading']),
    group('Language Structures and Conventions', ['Parts of speech', 'Sentence structure', 'Vocabulary and punctuation']),
    group('Literature', ['Poetry analysis', 'Stories and literary texts']),
  ],
  'Grade 7': [
    group('Listening and Speaking', ['Listening comprehension', 'Oral communication']),
    group('Reading and Viewing', ['Reading comprehension', 'Visual literacy', 'Reading strategies']),
    group('Writing and Presenting', ['Essay writing', 'Transactional writing', 'Summary writing']),
    group('Language Structures and Conventions', ['Sentence structure', 'Parts of speech', 'Vocabulary and punctuation']),
    group('Literature', ['Poetry analysis', 'Drama and prose analysis']),
  ],
  'Grade 8': [
    group('Listening and Speaking', ['Listening comprehension', 'Prepared and unprepared speech']),
    group('Reading and Viewing', ['Reading comprehension', 'Visual literacy', 'Critical reading']),
    group('Writing and Presenting', ['Essay writing', 'Transactional writing', 'Summary writing']),
    group('Language Structures and Conventions', ['Sentence structure', 'Parts of speech', 'Vocabulary and language use']),
    group('Literature', ['Poetry analysis', 'Drama and prose analysis']),
  ],
  'Grade 9': [
    group('Listening and Speaking', ['Listening comprehension', 'Oral presentation and discussion']),
    group('Reading and Viewing', ['Reading comprehension', 'Visual literacy', 'Critical reading']),
    group('Writing and Presenting', ['Essay writing', 'Transactional writing', 'Summary writing']),
    group('Language Structures and Conventions', ['Sentence structure', 'Parts of speech', 'Vocabulary and language use']),
    group('Literature', ['Poetry analysis', 'Drama and prose analysis']),
  ],
};

const NATURAL_SCIENCES_TOPICS = {
  'Grade 4': [
    group('Life and Living', ['Plants and animals', 'Habitats', 'Food chains']),
    group('Matter and Materials', ['Materials and properties', 'Solids, liquids and gases']),
    group('Energy and Change', ['Energy and movement', 'Electricity and circuits']),
    group('Planet Earth and Beyond', ['Earth and space', 'Weather and seasons']),
  ],
  'Grade 5': [
    group('Life and Living', ['Plants and photosynthesis', 'Animal life cycles', 'Ecosystems']),
    group('Matter and Materials', ['Materials and mixtures', 'Properties of materials']),
    group('Energy and Change', ['Energy transfer', 'Electric circuits']),
    group('Planet Earth and Beyond', ['The solar system', 'Earth resources']),
  ],
  'Grade 6': [
    group('Life and Living', ['Biodiversity', 'Ecosystems and food webs']),
    group('Matter and Materials', ['Separating mixtures', 'Reversible and irreversible changes']),
    group('Energy and Change', ['Energy and electricity', 'Electrical systems']),
    group('Planet Earth and Beyond', ['The Earth and beyond', 'The solar system']),
  ],
  'Grade 7': [
    group('Life and Living', ['Cells as the basic units of life', 'Support and transport systems in plants', 'Ecosystems and biodiversity']),
    group('Matter and Materials', ['Properties of materials', 'Particle model of matter', 'Separating mixtures']),
    group('Energy and Change', ['Potential and kinetic energy', 'Heat transfer', 'Electric circuits']),
    group('Planet Earth and Beyond', ['The solar system', 'The Earth and space']),
  ],
  'Grade 8': [
    group('Life and Living', ['Cells and cell structure', 'Microorganisms', 'Human body systems', 'Ecology']),
    group('Matter and Materials', ['Elements and compounds', 'Chemical reactions', 'Particle model of matter']),
    group('Energy and Change', ['Energy transfer and heat', 'Electricity and circuits', 'Forces and motion']),
    group('Planet Earth and Beyond', ['The solar system and the universe', 'Earth resources']),
  ],
  'Grade 9': [
    group('Life and Living', ['Cells and tissues', 'Systems in the human body', 'Biodiversity and classification', 'Human impact on ecosystems']),
    group('Matter and Materials', ['Atoms and the periodic table', 'Compounds and chemical reactions', 'Acids and bases']),
    group('Energy and Change', ['Electric circuits and energy', 'Forces and motion', 'Waves and sound']),
    group('Planet Earth and Beyond', ['The lithosphere', 'The solar system and space']),
  ],
};

const PHYSICAL_SCIENCES_GRADE_12_TOPICS = [
  group('Mechanics', ['Momentum and impulse', 'Work, energy and power']),
  group('Waves and Optics', ['Doppler effect', 'Wave properties and sound']),
  group('Electricity and Magnetism', ['Electric circuits and energy', 'Electrochemical cells', 'Electrostatics']),
  group('Matter and Materials', ['Organic molecules', 'Organic reactions']),
  group('Chemical Change', ['Rates of reaction', 'Chemical equilibrium', 'Acids and bases', 'Redox reactions', 'Stoichiometry']),
  group('Chemical Systems', ['Electrochemistry', 'Chemical industry and the environment']),
  group('Scientific Investigations', ['Graphs and data analysis', 'Scientific investigations']),
];

export const getCapsTopicGroups = ({ subject, grade } = {}) => {
  if (!subject || !grade) return null;
  if (subject === 'Physical Sciences' && grade === 'Grade 12') return PHYSICAL_SCIENCES_GRADE_12_TOPICS;
  if (subject === 'Natural Sciences') return NATURAL_SCIENCES_TOPICS[grade] ?? null;
  if (LANGUAGE_SUBJECTS.includes(subject)) return LANGUAGE_FET_TOPICS[grade] ?? LANGUAGE_OTHER_GRADE_TOPICS[grade] ?? null;
  return CAPS_FET_TOPICS[subject]?.[grade] ?? null;
};

export const hasScopedCapsTopicCatalog = (subject) =>
  subject === 'Natural Sciences' || LANGUAGE_SUBJECTS.includes(subject) || subject in CAPS_FET_TOPICS;
