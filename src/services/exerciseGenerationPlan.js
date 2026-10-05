export const isExerciseSubmitted = (exercise) => Boolean(
  exercise?.submittedImageUrl || exercise?.submitted === 'Yes' || exercise?.submissionStatus === 'submitted'
);

export const getCurrentGenerationNumber = (history = [], storedGenerationNumber = 1) => {
  const recordedWeeks = history
    .map((assignment) => Number(assignment?.generationWeek))
    .filter((week) => Number.isInteger(week) && week > 0);
  if (recordedWeeks.length) return Math.max(...recordedWeeks, Number(storedGenerationNumber) || 1);

  const batches = new Set(history
    .filter((assignment) => ['initial', 'weekly'].includes(assignment?.generationMode))
    .map((assignment) => assignment?.generationBatchId)
    .filter(Boolean));
  return Math.max(1, batches.size, Number(storedGenerationNumber) || 1);
};

export const hasExerciseGeneration = (history = []) => Array.isArray(history) && history.length > 0;

const normalizeQuestionTopic = (value) => String(value ?? '').trim().toLocaleLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const questionReferenceKey = (paperId, reference) => `${String(paperId ?? '').trim()}::${String(reference ?? '').trim()}`;

export const fillMissingPlannedQuestionsFromIndexes = ({
  recommendations = [],
  questionPlan = {},
  selectedPapers = [],
  previouslyUsedQuestionReferences = [],
  isQuestionForTopic = (question, topic) => normalizeQuestionTopic(question?.topic) === normalizeQuestionTopic(topic),
} = {}) => {
  const recommendationsByDate = new Map();
  recommendations.forEach((recommendation) => {
    const date = String(recommendation?.assignmentDate ?? '');
    if (!date) return;
    const rowsForDate = recommendationsByDate.get(date) ?? [];
    rowsForDate.push(recommendation);
    recommendationsByDate.set(date, rowsForDate);
  });
  const questionKey = (question) => questionReferenceKey(
    question?.paperId,
    question?.questionReference ?? question?.reference,
  );
  const used = new Set(previouslyUsedQuestionReferences
    .map((question) => questionReferenceKey(question?.paperId, question?.questionReference ?? question?.reference))
    .filter((key) => !key.endsWith('::')));

  let filledCount = 0;
  const rows = [];
  for (const day of questionPlan.perDayTopics ?? []) {
    if (Number(day.exerciseCount) !== 1 || !Array.isArray(day.topics)) continue;
    const date = String(day.assignmentDate);
    const originals = recommendationsByDate.get(date) ?? [];
    const originalQuestions = originals.flatMap((recommendation) => Array.isArray(recommendation?.questions)
      ? recommendation.questions : []);
    const selectedForDate = new Set();
    const questions = [];
    const topicSlotCounts = new Map();
    day.topics.forEach((topic) => {
      const key = normalizeQuestionTopic(topic);
      topicSlotCounts.set(key, (topicSlotCounts.get(key) ?? 0) + 1);
    });

    for (const topic of day.topics) {
      const topicKey = normalizeQuestionTopic(topic);
      if (!topicKey) continue;
      const candidates = selectedPapers.flatMap((paper) => (paper.questions ?? [])
        .filter((question) => isQuestionForTopic(question, topic))
        .map((question) => ({
          topic,
          questionReference: String(question.questionReference || question.reference || '').trim(),
          paperId: String(paper.id || '').trim(),
          pageNumber: Number(question.pageNumber ?? question.page),
          marks: Number(question.marks) || 0,
        }))
        .filter((question) => question.questionReference && question.paperId && Number.isFinite(question.pageNumber) && question.pageNumber > 0));
      const originalCandidates = originalQuestions
        .filter((question) => normalizeQuestionTopic(question?.topic) === topicKey)
        .flatMap((question) => {
          const indexed = candidates.find((candidate) => questionKey(candidate) === questionKey(question)
            && Number(candidate.pageNumber) === Number(question.pageNumber ?? question.page));
          return indexed ? [indexed] : [];
        });
      const available = candidates.filter((candidate) => !selectedForDate.has(questionKey(candidate)));
      const distinctAvailable = available.filter((candidate) => !used.has(questionKey(candidate)));
      const sourceQuestion = originalCandidates.find((candidate) => !used.has(questionKey(candidate))
        && !selectedForDate.has(questionKey(candidate)))
        || distinctAvailable[0]
        || originalCandidates.find((candidate) => !selectedForDate.has(questionKey(candidate)))
        || available[0]
        || (topicSlotCounts.get(topicKey) > 1 ? candidates[0] : null);

      if (!sourceQuestion) {
        filledCount += 1;
        continue;
      }

      questions.push(sourceQuestion);
      selectedForDate.add(questionKey(sourceQuestion));
      used.add(questionKey(sourceQuestion));
      if (!originalCandidates.some((candidate) => questionKey(candidate) === questionKey(sourceQuestion))) filledCount += 1;
    }

    if (originalQuestions.length > day.topics.length) filledCount += originalQuestions.length - day.topics.length;
    rows.push({ ...(originals[0] ?? {}), assignmentDate: day.assignmentDate, questions });
  }

  return { recommendations: rows, filledCount };
};

export const getExerciseGenerationMode = ({ mode, lessonCompleted = false, history = [] } = {}) =>
  lessonCompleted && !hasExerciseGeneration(history) ? 'initial' : mode;

export const getGenerationWeekForTrigger = (currentWeek, { initial = false, lessonCompleted = false } = {}) => {
  const week = Math.max(1, Number(currentWeek) || 1);
  if (initial) return 1;
  return lessonCompleted ? week + 1 : week;
};

export const getSevenDayWindow = (today) => {
  const [year, month, day] = String(today).split('-').map(Number);
  return Array.from({ length: 7 }, (_, offset) => {
    const date = new Date(year, month - 1, day + offset);
    return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
  });
};

export const getRegenerationState = ({ history = [], assignmentDates = [], completedTopicCount = 1, maxDailyExercises = 5 } = {}) => {
  const limit = Math.min(maxDailyExercises, Math.max(1, completedTopicCount));
  const exercisesByDate = new Map();
  history.forEach((exercise) => {
    const date = String(exercise?.assignmentDate ?? '').slice(0, 10);
    if (!date || !assignmentDates.includes(date)) return;
    const items = exercisesByDate.get(date) ?? [];
    items.push(exercise);
    exercisesByDate.set(date, items);
  });

  const dailyExerciseCaps = {};
  const overrideExerciseIdsByDate = {};
  assignmentDates.forEach((date) => {
    const exercises = exercisesByDate.get(date) ?? [];
    const completedCount = exercises.filter(isExerciseSubmitted).length;
    dailyExerciseCaps[date] = Math.max(0, limit - completedCount);
    overrideExerciseIdsByDate[date] = exercises.filter((exercise) => !isExerciseSubmitted(exercise)).map((exercise) => exercise.id).filter(Boolean);
  });

  return { dailyExerciseCaps, overrideExerciseIdsByDate, dailyLimit: limit };
};

export const getEligibleExerciseTopics = (topicSummaries = []) => topicSummaries
  .filter((topic) => topic.topicStatus === 'done');

export const selectTopicsForExerciseDay = ({
  topicSummaries = [],
  maxTopicsPerDay = 0,
  dayIndex = 0,
  generationNumber = 1,
} = {}) => {
  const eligibleTopics = getEligibleExerciseTopics(topicSummaries);
  if (!eligibleTopics.length || maxTopicsPerDay <= 0) return [];
  const sortedByStrength = [...eligibleTopics].sort((left, right) => {
    const understandingDifference = (right.understandingLevel ?? 0) - (left.understandingLevel ?? 0);
    if (understandingDifference !== 0) return understandingDifference;
    return new Date(left.completedOn || 0) - new Date(right.completedOn || 0);
  });
  const offsetPool = dayIndex % Math.max(sortedByStrength.length, 1);
  const rotated = [...sortedByStrength.slice(offsetPool), ...sortedByStrength.slice(0, offsetPool)];
  const ordered = generationNumber <= 2 ? eligibleTopics : rotated;
  const selected = [];
  ordered.forEach((topic) => {
    if (selected.length >= maxTopicsPerDay || selected.includes(topic.topic)) return;
    selected.push(topic.topic);
  });
  return selected;
};

export const fillTopicSlotsToQuestionCount = (topics = [], requiredCount = 0) => {
  const uniqueTopics = [...new Set(topics.map((topic) => String(topic ?? '').trim()).filter(Boolean))];
  const count = Math.max(0, Math.floor(Number(requiredCount) || 0));
  if (!uniqueTopics.length || !count) return [];
  return Array.from({ length: count }, (_, index) => uniqueTopics[index % uniqueTopics.length]);
};
