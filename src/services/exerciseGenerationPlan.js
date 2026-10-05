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

export const getEligibleExerciseTopics = (topicSummaries = [], minimumMarkedAverage = 0.7) => topicSummaries
  .filter((topic) => topic.topicStatus !== 'marked'
    || (Number.isFinite(Number(topic.understandingLevel)) && Number(topic.understandingLevel) >= minimumMarkedAverage));

export const selectTopicsForExerciseDay = ({
  topicSummaries = [],
  maxTopicsPerDay = 0,
  dayIndex = 0,
  generationNumber = 1,
  topicUsageCounts = new Map(),
  markedTopicUsageLimit = 2,
} = {}) => {
  if (!topicSummaries.length || maxTopicsPerDay <= 0) return [];
  const sortedByStrength = [...topicSummaries].sort((left, right) => {
    const understandingDifference = (right.understandingLevel ?? 0) - (left.understandingLevel ?? 0);
    if (understandingDifference !== 0) return understandingDifference;
    return new Date(left.completedOn || 0) - new Date(right.completedOn || 0);
  });
  const offsetPool = dayIndex % Math.max(sortedByStrength.length, 1);
  const rotated = [...sortedByStrength.slice(offsetPool), ...sortedByStrength.slice(0, offsetPool)];
  const ordered = generationNumber <= 2 ? topicSummaries : rotated;
  const selected = [];
  ordered.forEach((topic) => {
    if (selected.length >= maxTopicsPerDay || selected.includes(topic.topic)) return;
    if (topic.topicStatus === 'marked' && (topicUsageCounts.get(topic.topic) ?? 0) >= markedTopicUsageLimit) return;
    selected.push(topic.topic);
    if (topic.topicStatus === 'marked') topicUsageCounts.set(topic.topic, (topicUsageCounts.get(topic.topic) ?? 0) + 1);
  });
  return selected;
};
