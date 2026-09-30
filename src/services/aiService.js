import { httpsCallable } from 'firebase/functions';
import { jsonrepair } from 'jsonrepair';
import { functions, isFirebaseConfigured } from '../firebase/config';

const stripCodeFence = (text = '') =>
  String(text)
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();

const extractJsonObject = (text = '') => {
  const trimmed = String(text).trim();

  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');

  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    return trimmed;
  }

  return trimmed.slice(firstBrace, lastBrace + 1);
};

const parseModelJson = (text = '') => {
  const cleaned = stripCodeFence(text);
  const candidate = extractJsonObject(cleaned);
  try {
    return { parsed: JSON.parse(candidate), repaired: false };
  } catch {
    try {
      return { parsed: JSON.parse(jsonrepair(candidate)), repaired: true };
    } catch {
      if (candidate !== cleaned) return { parsed: JSON.parse(jsonrepair(cleaned)), repaired: true };
      throw new Error('Model response could not be repaired as JSON.');
    }
  }
};

const getFallbackRecommendations = (payload = {}) => {
  const assignmentDates = Array.isArray(payload.assignmentDates) && payload.assignmentDates.length
    ? payload.assignmentDates
    : [new Date().toISOString().slice(0, 10)];
  const topics = Array.isArray(payload.completedTopics) ? payload.completedTopics.filter(Boolean) : [];
  const titleForTopics = topics.length ? topics.slice(0, 3).map((topic, index) => `${index + 1}.1`).join(' | ') : '1.1';

  return {
    recommendations: assignmentDates.map((assignmentDate) => ({
      title: titleForTopics,
      topic: topics.length ? topics.slice(0, 3).join(' | ') : `Tutor-completed ${payload.subject ?? 'subject'} topic`,
      reason: `AI recommendations are temporarily unavailable, so Examifying is showing a safe fallback recommendation state for ${assignmentDate}.`,
      sourceLabel: 'Retry after confirming AI recommendations are enabled for this project.',
      instruction: `Complete the referenced question number(s) for ${assignmentDate}.`,
      assignmentDate,
      questionReferences: titleForTopics.split('|').map((item) => item.trim()),
      topicBreakdown: topics.slice(0, 3).map((topic, topicIndex) => ({
        topic,
        questionReference: `${topicIndex + 1}.1`,
      })),
      paperIdsUsed: Array.isArray(payload.selectedPaperIds) ? payload.selectedPaperIds.slice(0, 2) : [],
      questionLinks: [],
    })),
    source: 'fallback',
  };
};

const normalizeRecommendations = (parsed, payload = {}) => {
  const recommendations = Array.isArray(parsed?.recommendations)
    ? parsed.recommendations
    : [];

  return {
    recommendations: recommendations.map((item, index) => {
      const reference = item?.questionReference
        || item?.reference
        || item?.questionReferences?.[0]
        || item?.topicBreakdown?.[0]?.questionReference
        || item?.title
        || '';
      const topic = item?.topic || item?.topicBreakdown?.[0]?.topic || `${payload.subject ?? 'Subject'} topic`;
      const paperId = item?.paperId || item?.questionLinks?.[0]?.paperId || item?.questionLinks?.[0]?.id || '';
      const indexedQuestion = payload.selectedPapers?.flatMap((paper) => (
        !paperId || paper.id === paperId
          ? (paper.questions ?? []).map((question) => ({ paper, question }))
          : []
      )).find(({ question }) => String(question.questionReference || question.reference || '').trim() === String(reference).trim());
      const resolvedPaperId = paperId || indexedQuestion?.paper?.id || '';
      const pageNumber = Number(item?.pageNumber || item?.questionLinks?.[0]?.pageNumber || item?.questionLinks?.[0]?.page || indexedQuestion?.question?.pageNumber) || 1;
      const questionLinks = Array.isArray(item?.questionLinks) && item.questionLinks.length
        ? item.questionLinks
            .map((link) => ({
              paperId: link?.paperId || link?.id || resolvedPaperId,
              pageNumber: Number(link?.pageNumber ?? link?.page ?? pageNumber) || 1,
              questionReference: link?.questionReference || link?.reference || reference,
              topic: link?.topic || topic,
            }))
            .filter((link) => link.paperId && link.questionReference)
        : resolvedPaperId && reference
          ? [{ paperId: resolvedPaperId, pageNumber, questionReference: reference, topic }]
          : [];
      const sourcePaper = payload.selectedPapers?.find((paper) => paper.id === resolvedPaperId);
      const referenceList = Array.isArray(item?.questionReferences) && item.questionReferences.length
        ? item.questionReferences.filter(Boolean)
        : reference ? [reference] : [];

      return {
      title: item?.title || item?.questionReferences?.join(' | ') || reference || `Recommendation ${index + 1}`,
      topic,
      reason: item?.reason || `Selected from analyzed ${topic} question metadata.`,
      sourceLabel: item?.sourceLabel || [sourcePaper?.year, sourcePaper?.region, sourcePaper?.month, sourcePaper?.paperNumber].filter(Boolean).join(' ') || 'Analyzed question paper',
      instruction: item?.instruction || 'Answer the exact referenced question only.',
      assignmentDate: item?.assignmentDate || payload.assignmentDates?.[index] || null,
      questionReferences: referenceList,
      topicBreakdown: Array.isArray(item?.topicBreakdown)
        ? item.topicBreakdown
            .map((entry) => ({
              topic: entry?.topic || `${payload.subject ?? 'Subject'} topic`,
              questionReference: entry?.questionReference || entry?.reference || '',
            }))
            .filter((entry) => entry.questionReference)
        : reference ? [{ topic, questionReference: reference }] : [],
      paperIdsUsed: Array.isArray(item?.paperIdsUsed) && item.paperIdsUsed.length
        ? item.paperIdsUsed.filter(Boolean)
        : resolvedPaperId ? [resolvedPaperId] : Array.isArray(payload.selectedPaperIds)
          ? payload.selectedPaperIds.slice(0, 2)
          : [],
      questionLinks,
    };
    }),
    source: 'model',
  };
};

const buildPrompt = ({
  grade,
  region,
  subject = 'Mathematics',
  completedTopics = [],
  tutorReports = [],
  pastMarks = [],
  questionPaperMetadata = [],
  topicPaperMetadata = [],
  tutorNotes = '',
  mode = 'initial',
  assignmentDates = [],
  selectedPapers = [],
  maxExercisesPerDay = 1,
  maxQuestionsPerDay = 1,
  questionPlanRules = {},
  lessonHistory = [],
  understandingByTopic = [],
  recentExerciseHistory = [],
  previousGenerationSummaries = [],
} = {}) => `
You are Examifying's ${subject} exercise recommendation assistant for South African grades.

Business rules:
- Recommend ${subject} only.
- Recommend exercises only from tutor-completed topics.
- Prefer references to question papers and question numbers instead of rewriting full question text.
- Consider grade, region, tutor reports, tutor notes, topic-based question metadata, question paper metadata, stored question indexes, and past marks.
- Return a compact JSON object with a top-level key called "recommendations".
- Each recommendation must contain only these fields: assignmentDate, topic, questionReference, paperId, pageNumber.
- Return only valid JSON.
- Use double quotes for all property names and string values.
- Do not include markdown.
- Do not include code fences.
- Do not include comments.
- Do not include trailing commas.
- Do not include any explanation before or after the JSON.

Example format:
{
  "recommendations": [
    {
      "assignmentDate": "2026-03-24",
      "topic": "Probability",
      "questionReference": "1.1",
      "paperId": "paper-a",
      "pageNumber": 2
    }
  ]
}

Student grade: ${grade ?? 'Unknown'}
Region: ${region ?? 'Unknown'}
Subject: ${subject}
Generation mode: ${mode}
Completed topics: ${JSON.stringify(completedTopics)}
Tutor reports: ${JSON.stringify(tutorReports)}
Tutor notes: ${tutorNotes}
Past marks: ${JSON.stringify(pastMarks)}
Question paper metadata: ${JSON.stringify(questionPaperMetadata)}
Topic-based source metadata: ${JSON.stringify(topicPaperMetadata)}
Stored source paper question indexes: ${JSON.stringify(selectedPapers.map((paper) => ({
  id: paper.id,
  metadata: paper.paperMetadata,
  topics: paper.topics,
  questions: paper.questions,
})))}
Assignment dates to schedule: ${JSON.stringify(assignmentDates)}
Lesson history with understanding: ${JSON.stringify(lessonHistory)}
Understanding by topic: ${JSON.stringify(understandingByTopic)}
Last 28 days exercise history to avoid short repeats: ${JSON.stringify(recentExerciseHistory)}
Recent generation summaries to avoid repeating source papers: ${JSON.stringify(previousGenerationSummaries)}
Question-plan rules: ${JSON.stringify(questionPlanRules)}
Maximum question references per day: ${maxQuestionsPerDay}
Maximum separate exercises per day: ${maxExercisesPerDay}

Additional mandatory generation rules:
- Follow Question-plan rules.perDayTopics. Return one recommendation object for each planned topic slot, repeating the same assignmentDate when that date has multiple planned slots.
- Each recommendation is one exercise and must contain exactly one question reference and one topic.
- Never return more than Maximum separate exercises per day for any assignmentDate. The frontend enforces this cap too.
- Each question reference must belong to a tutor-completed topic.
- Choose questions from Topic-based source metadata first. For each topic, prefer using questions from at least two different papers when available.
- Do not use a question for a topic unless that question appears under that exact topic in Topic-based source metadata.
- Return exactly one question reference for each exercise, without ranges like "1.1.3 - 1.1.5".
- For initial mode, schedule at most one exercise per day, even when multiple topics are completed.
- For weekly mode, schedule no more than the planned number of exercises per day; use different topics on the same date.
- When more than three topics are available, bias selections toward higher understanding topics, while still occasionally including lower understanding topics.
- Only use the selected source papers and include their exact ids in paperId.
- Use only questions from the stored source paper question indexes. Do not invent question numbers.
- Use the exact questionReference, paperId, and pageNumber found in the stored question index.
- Return only the five example fields per recommendation; the app fills display and linking fields locally.
- Avoid repeating exact questionReferences from the same paper that appear in Last 28 days exercise history.
- Repeating a recent exact question is allowed only when the topic-based source metadata does not contain enough different questions for that topic.
- NEVER REPEAT the same question for different assignment dates in the new plan, unless the total number of available matching questions is not enough.
- Vary papers across recommendations when suitable questions are available.
`;

export const recommendExercises = async (payload = {}) => {
  console.log('[Examifying][AI] recommendExercises:start', payload);

  if (!isFirebaseConfigured) {
    return getFallbackRecommendations(payload);
  }

  if (!functions) {
    console.log('[Examifying][AI] recommendExercises:fallback:no-functions-instance');
    return { recommendations: [], source: 'unavailable', model: '' };
  }

  const request = {
    system: 'You return strict JSON only. Do not include markdown, comments, or explanatory text.',
    prompt: buildPrompt(payload),
    responseFormat: { type: 'json_object' },
    maxTokens: 2000,
    temperature: 0.2,
  };
  const parseResult = (result, provider) => {
    const rawText = result?.data?.text ?? '';
    const { parsed, repaired } = parseModelJson(rawText);
    if (!Array.isArray(parsed?.recommendations) || !parsed.recommendations.length) {
      throw new Error(`${provider} did not return exercise recommendations.`);
    }
    if (repaired) console.info('[Examifying][AI] repaired model JSON response', { provider });
    return {
      ...normalizeRecommendations(parsed, payload),
      source: provider,
      model: result?.data?.model ?? '',
      fallbackUsed: Boolean(result?.data?.fallbackUsed),
    };
  };

  try {
    const callExerciseGenerationText = httpsCallable(functions, 'callExerciseGenerationText');
    const kiloResult = await callExerciseGenerationText({ ...request, requiredJsonKey: 'recommendations' });
    const response = parseResult(kiloResult, 'kilo');
    console.info('[Examifying][AI] exercise model completed', { provider: response.source, model: response.model, fallbackUsed: response.fallbackUsed });
    return response;
  } catch (kiloError) {
    console.warn('[Examifying][AI] Kilo exercise model chain exhausted; trying Gemini.', { message: kiloError?.message });
  }

  try {
    const callGeminiText = httpsCallable(functions, 'callGeminiText');
    const geminiResult = await callGeminiText(request);
    const response = parseResult(geminiResult, 'gemini');
    console.info('[Examifying][AI] exercise model completed', { provider: response.source, model: response.model, fallbackUsed: true });
    return response;
  } catch (geminiError) {
    console.error('[Examifying][AI] Kilo and Gemini exercise generation failed.', { message: geminiError?.message });
    return { recommendations: [], source: 'unavailable', model: '' };
  }
};
