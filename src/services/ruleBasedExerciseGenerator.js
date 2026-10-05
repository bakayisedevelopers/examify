import {
  MAX_EXERCISE_GENERATION_DAYS,
  MAX_QUESTIONS_PER_EXERCISE,
  MARKED_TOPIC_SUGGESTIONS_PER_SEVEN_EXERCISES,
  TOPICS_PER_EXERCISE_WINDOW_STEP,
  WEEKLY_EXERCISE_DAYS,
} from '../lib/constants.js';

const normalizeTopic = (value) => String(value ?? '').trim().toLocaleLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const questionKey = (question) => `${String(question?.paperId ?? '').trim()}::${String(question?.questionReference ?? question?.reference ?? '').trim().toLocaleLowerCase()}`;
const clampUnderstanding = (value) => {
  const score = Number(value);
  return Number.isFinite(score) && score >= 0 && score <= 1 ? score : 0.5;
};

export const getExerciseGenerationDayCount = (completedTopicCount = 0) => {
  const count = Math.max(0, Math.floor(Number(completedTopicCount) || 0));
  const windows = Math.max(1, Math.ceil(count / TOPICS_PER_EXERCISE_WINDOW_STEP));
  return Math.min(MAX_EXERCISE_GENERATION_DAYS, windows * WEEKLY_EXERCISE_DAYS);
};

export const createExerciseDateWindow = (startDate, dayCount = WEEKLY_EXERCISE_DAYS) => {
  const [year, month, day] = String(startDate).slice(0, 10).split('-').map(Number);
  if (![year, month, day].every(Number.isFinite)) return [];
  return Array.from({ length: Math.max(0, Math.min(MAX_EXERCISE_GENERATION_DAYS, Math.floor(Number(dayCount) || 0))) }, (_, offset) => {
    const date = new Date(year, month - 1, day + offset);
    return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
  });
};

const calculateWeightedTopicQuotas = (topics, totalSlots, sevenDayBlockCount) => {
  let remaining = Math.max(0, totalSlots);
  const quotas = new Map(topics.map((topic) => [normalizeTopic(topic.topic), 0]));
  const active = [...topics];
  const caps = new Map(topics.map((topic) => [
    normalizeTopic(topic.topic), topic.topicStatus === 'marked'
      ? MARKED_TOPIC_SUGGESTIONS_PER_SEVEN_EXERCISES * sevenDayBlockCount
      : totalSlots,
  ]));

  while (remaining > 0 && active.length) {
    const weightTotal = active.reduce((sum, topic) => sum + Math.max(0.01, clampUnderstanding(topic.understandingLevel)), 0);
    const shares = active.map((topic) => {
      const key = normalizeTopic(topic.topic);
      const share = remaining * Math.max(0.01, clampUnderstanding(topic.understandingLevel)) / weightTotal;
      const room = Math.max(0, (caps.get(key) ?? totalSlots) - (quotas.get(key) ?? 0));
      return { key, share, room, floor: Math.min(room, Math.floor(share)) };
    });
    let allocated = 0;
    shares.forEach(({ key, floor }) => {
      if (floor > 0) {
        quotas.set(key, (quotas.get(key) ?? 0) + floor);
        allocated += floor;
      }
    });
    remaining -= allocated;
    const exhaustedKeys = active
      .filter((topic) => (quotas.get(normalizeTopic(topic.topic)) ?? 0) >= (caps.get(normalizeTopic(topic.topic)) ?? totalSlots))
      .map((topic) => normalizeTopic(topic.topic));
    if (exhaustedKeys.length) {
      for (let index = active.length - 1; index >= 0; index -= 1) {
        if (exhaustedKeys.includes(normalizeTopic(active[index].topic))) active.splice(index, 1);
      }
      continue;
    }
    if (remaining <= 0) break;
    const remainderOrder = shares
      .filter(({ room }) => room > 0)
      .sort((left, right) => (right.share - Math.floor(right.share)) - (left.share - Math.floor(left.share)));
    if (!remainderOrder.length) break;
    remainderOrder.forEach(({ key }) => {
      if (!remaining) return;
      const cap = caps.get(key) ?? totalSlots;
      const current = quotas.get(key) ?? 0;
      if (current < cap) {
        quotas.set(key, current + 1);
        remaining -= 1;
      }
    });
  }
  return quotas;
};

const stableHash = (value) => {
  let hash = 2166136261;
  for (const character of String(value)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
};

export const buildRuleBasedExercisePlan = ({
  topicSummaries = [],
  indexedQuestions = [],
  assignmentDates = [],
  dailyExerciseCaps = {},
  targetQuestionsPerExercise = MAX_QUESTIONS_PER_EXERCISE,
  recentlyUsedQuestionKeys = [],
  matchesTopic = (question, topic) => normalizeTopic(question?.topic) === normalizeTopic(topic),
} = {}) => {
  const topics = topicSummaries.filter((topic) => normalizeTopic(topic.topic));
  const topicByKey = new Map(topics.map((topic) => [normalizeTopic(topic.topic), topic]));
  const candidatesByTopic = new Map(topics.map((topic) => [normalizeTopic(topic.topic), []]));
  const candidateByKey = new Map();

  indexedQuestions.forEach((question) => {
    const paperId = String(question?.paperId ?? '').trim();
    const reference = String(question?.questionReference ?? question?.reference ?? '').trim();
    const pageNumber = Number(question?.pageNumber ?? question?.page);
    if (!paperId || !reference || !Number.isFinite(pageNumber) || pageNumber <= 0) return;
    const key = questionKey({ paperId, questionReference: reference });
    const candidate = {
      topic: String(question?.topic ?? '').trim(),
      paperId,
      questionReference: reference,
      pageNumber,
      marks: Number(question?.marks) || 0,
      key,
    };
    const indexed = candidateByKey.get(key) ?? candidate;
    candidateByKey.set(key, indexed);
    topics.forEach((topic) => {
      if (!matchesTopic(question, topic.topic)) return;
      const topicKey = normalizeTopic(topic.topic);
      const rows = candidatesByTopic.get(topicKey) ?? [];
      if (!rows.some((row) => row.key === key)) rows.push({ ...indexed, topic: topic.topic });
      candidatesByTopic.set(topicKey, rows);
    });
  });

  const availableTopics = topics.filter((topic) => (candidatesByTopic.get(normalizeTopic(topic.topic)) ?? []).length > 0);
  const activeDates = assignmentDates.filter((date) => Number(dailyExerciseCaps[date] ?? 1) > 0);
  const targetCount = Math.max(0, Math.min(MAX_QUESTIONS_PER_EXERCISE, Math.floor(Number(targetQuestionsPerExercise) || 0)));
  const totalTargetSlots = activeDates.length * targetCount;
  const quotas = calculateWeightedTopicQuotas(availableTopics, totalTargetSlots, Math.max(1, Math.ceil(assignmentDates.length / WEEKLY_EXERCISE_DAYS)));
  const assignedTopicSlots = new Map(availableTopics.map((topic) => [normalizeTopic(topic.topic), 0]));
  const usedRecently = new Set(recentlyUsedQuestionKeys.map((item) => typeof item === 'string' ? item : questionKey(item)).filter((key) => !key.endsWith('::')));
  const usedInPlan = new Set();
  const perDayTopics = [];
  const recommendations = [];
  let repeatedRecentQuestionCount = 0;
  let repeatedWithinGenerationQuestionCount = 0;
  let uniqueQuestionCount = 0;
  const markedCountsByBlock = new Map();

  assignmentDates.forEach((assignmentDate, dayIndex) => {
    const exerciseCount = Number(dailyExerciseCaps[assignmentDate] ?? 1) > 0 ? 1 : 0;
    if (!exerciseCount) {
      perDayTopics.push({ assignmentDate, exerciseCount: 0, requiredCount: 0, topics: [] });
      return;
    }
    const selected = [];
    const usedForDate = new Set();
    const blockIndex = Math.floor(dayIndex / WEEKLY_EXERCISE_DAYS);
    const markedCountsInBlock = markedCountsByBlock.get(blockIndex) ?? new Map();
    markedCountsByBlock.set(blockIndex, markedCountsInBlock);

    while (selected.length < targetCount) {
      const eligibleForSlot = availableTopics.filter((topic) => {
        const topicKey = normalizeTopic(topic.topic);
        if (topic.topicStatus !== 'marked') return true;
        const usedCount = markedCountsInBlock.get(topicKey) ?? 0;
        return usedCount < MARKED_TOPIC_SUGGESTIONS_PER_SEVEN_EXERCISES;
      }).filter((topic) => (candidatesByTopic.get(normalizeTopic(topic.topic)) ?? [])
        .some((candidate) => !usedForDate.has(candidate.key)));
      if (!eligibleForSlot.length) break;

      const allocatedSoFar = [...assignedTopicSlots.values()].reduce((sum, count) => sum + count, 0);
      const quotaEligible = eligibleForSlot.filter((topic) =>
        (assignedTopicSlots.get(normalizeTopic(topic.topic)) ?? 0) < (quotas.get(normalizeTopic(topic.topic)) ?? 0));
      const topicsForSlot = quotaEligible.length ? quotaEligible : eligibleForSlot;
      const nextSlotNumber = Math.min(totalTargetSlots, allocatedSoFar + 1);
      const topic = [...topicsForSlot].sort((left, right) => {
        const leftKey = normalizeTopic(left.topic);
        const rightKey = normalizeTopic(right.topic);
        const leftTarget = (quotas.get(leftKey) ?? 0) * nextSlotNumber / Math.max(1, totalTargetSlots);
        const rightTarget = (quotas.get(rightKey) ?? 0) * nextSlotNumber / Math.max(1, totalTargetSlots);
        const leftDeficit = leftTarget - (assignedTopicSlots.get(leftKey) ?? 0);
        const rightDeficit = rightTarget - (assignedTopicSlots.get(rightKey) ?? 0);
        return rightDeficit - leftDeficit
          || clampUnderstanding(right.understandingLevel) - clampUnderstanding(left.understandingLevel)
          || leftKey.localeCompare(rightKey);
      })[0];
      const topicKey = normalizeTopic(topic.topic);
      const candidates = [...(candidatesByTopic.get(topicKey) ?? [])]
        .filter((candidate) => !usedForDate.has(candidate.key))
        .sort((left, right) => {
          const priority = (candidate) => (usedRecently.has(candidate.key) ? 2 : 0) + (usedInPlan.has(candidate.key) ? 1 : 0);
          return priority(left) - priority(right)
            || stableHash(`${assignmentDate}:${left.key}`) - stableHash(`${assignmentDate}:${right.key}`);
        });
      const question = candidates[0];
      if (!question) break;
      if (usedRecently.has(question.key)) repeatedRecentQuestionCount += 1;
      else uniqueQuestionCount += 1;
      if (usedInPlan.has(question.key)) repeatedWithinGenerationQuestionCount += 1;
      usedInPlan.add(question.key);
      usedForDate.add(question.key);
      assignedTopicSlots.set(topicKey, (assignedTopicSlots.get(topicKey) ?? 0) + 1);
      if (topic.topicStatus === 'marked') markedCountsInBlock.set(topicKey, (markedCountsInBlock.get(topicKey) ?? 0) + 1);
      selected.push({
        topic: topic.topic,
        paperId: question.paperId,
        questionReference: question.questionReference,
        pageNumber: question.pageNumber,
        marks: question.marks,
      });
    }

    const topicsForDay = selected.map((question) => question.topic);
    perDayTopics.push({
      assignmentDate,
      exerciseCount: selected.length ? 1 : 0,
      requiredCount: selected.length,
      targetCount,
      topics: topicsForDay,
      hasQuestionShortage: selected.length < targetCount,
      shortageCount: Math.max(0, targetCount - selected.length),
      markedTopicSuggestionCount: selected.filter((question) => topicByKey.get(normalizeTopic(question.topic))?.topicStatus === 'marked').length,
    });
    if (selected.length) recommendations.push({ assignmentDate, questions: selected });
  });

  const totalQuestionShortage = perDayTopics.reduce((sum, day) => sum + day.shortageCount, 0);
  return {
    recommendations,
    perDayTopics,
    targetQuestionsPerExercise: targetCount,
    totalTargetSlots,
    totalSelectedQuestions: recommendations.reduce((sum, item) => sum + item.questions.length, 0),
    totalQuestionShortage,
    needsMorePaperAnalysis: totalQuestionShortage > 0 || topics.some((topic) => !candidatesByTopic.get(normalizeTopic(topic.topic))?.length),
    topicsWithoutSources: topics.filter((topic) => !candidatesByTopic.get(normalizeTopic(topic.topic))?.length).map((topic) => topic.topic),
    repeatedRecentQuestionCount,
    repeatedWithinGenerationQuestionCount,
    uniqueQuestionCount,
    indexedQuestionCount: candidateByKey.size,
    allocatedQuestionCountByTopic: Object.fromEntries(assignedTopicSlots),
  };
};
