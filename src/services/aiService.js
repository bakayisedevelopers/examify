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
  const planByDate = new Map((payload.questionPlanRules?.perDayTopics ?? []).map((day) => [day.assignmentDate, day]));

  return {
    recommendations: assignmentDates.flatMap((assignmentDate, dayIndex) => {
      const plannedDay = planByDate.get(assignmentDate);
      const plannedTopics = plannedDay?.topics ?? topics.slice(0, Math.min(5, topics.length));
      if (plannedDay?.exerciseCount === 0 || !plannedTopics.length) return [];
      return [{
        title: plannedTopics.map((topic, index) => `${index + 1}.1`).join(' | '),
        topic: plannedTopics.join(' | '),
        reason: `AI recommendations are temporarily unavailable, so Examifying is showing a safe fallback recommendation state for ${assignmentDate}.`,
        sourceLabel: 'Retry after confirming AI recommendations are enabled for this project.',
        instruction: `Complete the referenced question number(s) for ${assignmentDate}.`,
        assignmentDate,
        questions: plannedTopics.map((topic, topicIndex) => ({
          topic,
          questionReference: `${topicIndex + 1}.${dayIndex + 1}`,
          paperId: payload.selectedPaperIds?.[0] ?? '',
          pageNumber: 1,
        })),
      }];
    }),
    source: 'fallback',
  };
};

const normalizeRecommendations = (parsed, payload = {}) => {
  const recommendations = Array.isArray(parsed?.recommendations)
    ? parsed.recommendations
    : [];

  const selectedPapers = payload.selectedPapers ?? [];
  const normalizeQuestion = (question = {}) => {
    const reference = String(question?.questionReference || question?.reference || '').trim();
    const topic = String(question?.topic || `${payload.subject ?? 'Subject'} topic`).trim();
    const requestedPaperId = String(question?.paperId || question?.id || '').trim();
    const matchingIndexedQuestions = selectedPapers.flatMap((paper) =>
      (paper.questions ?? [])
        .filter((indexed) => String(indexed.questionReference || indexed.reference || '').trim() === reference)
        .map((indexed) => ({ paper, question: indexed })),
    );
    const indexedQuestion = matchingIndexedQuestions.find(({ paper }) => String(paper.id) === requestedPaperId)
      ?? (matchingIndexedQuestions.length === 1 ? matchingIndexedQuestions[0] : null);
    return {
      topic,
      questionReference: indexedQuestion?.question?.questionReference || indexedQuestion?.question?.reference || reference,
      paperId: indexedQuestion?.paper?.id || requestedPaperId,
      pageNumber: Number(indexedQuestion?.question?.pageNumber ?? question?.pageNumber ?? question?.page) || 1,
      marks: Number(indexedQuestion?.question?.marks ?? question?.marks) || 0,
    };
  };

  return {
    recommendations: recommendations.map((item, index) => {
      const rawQuestions = Array.isArray(item?.questions)
        ? item.questions
        : item?.questionReference || item?.reference
          ? [item]
          : [];
      const questions = rawQuestions.map(normalizeQuestion);
      const topicBreakdown = questions.map(({ topic, questionReference }) => ({ topic, questionReference }));
      const questionReferences = questions.map((question) => question.questionReference).filter(Boolean);
      const questionLinks = questions.map(({ topic, questionReference, paperId, pageNumber, marks }) => ({ topic, questionReference, paperId, pageNumber, marks }));
      const paperIdsUsed = [...new Set(questions.map((question) => question.paperId).filter(Boolean))];
      const sourceLabels = [...new Set(paperIdsUsed.map((paperId) => {
        const paper = selectedPapers.find((entry) => entry.id === paperId);
        return paper?.displayName || [paper?.year, paper?.region, paper?.month, paper?.paperNumber].filter(Boolean).join(' ');
      }).filter(Boolean))];
      const topics = topicBreakdown.map((entry) => entry.topic).filter(Boolean);
      return {
        title: item?.title || questionReferences.join(' | ') || `Exercise ${index + 1}`,
        topic: topics.join(' | ') || item?.topic || `${payload.subject ?? 'Subject'} topic`,
        reason: item?.reason || 'Selected from analyzed question metadata for the completed topics.',
        sourceLabel: item?.sourceLabel || sourceLabels.join('; ') || 'Analyzed question papers',
        instruction: item?.instruction || 'Answer each referenced question only.',
        assignmentDate: item?.assignmentDate || payload.assignmentDates?.[index] || null,
        questions,
        questionReferences,
        topicBreakdown,
        paperIdsUsed,
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
  eligibleTopics = completedTopics,
  markedTopicSuggestions = [],
  markedTopicUsageLimits = {},
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
  correctionInstruction = '',
} = {}) => `
You are Examifying's ${subject} exercise recommendation assistant for South African grades.

Business rules:
- Recommend ${subject} only.
- Use only topics listed in Eligible topics. Topics marked done through a completed lesson are eligible. A topic recorded from marking but not attended is eligible only when its 28-day average understanding score is at least 0.7 (70%).
- Marked-only topics are suggestions, not completed lesson topics. Use each marked-only topic no more than its limit in Marked-topic usage limits across this entire seven-day generation; the limit is two uses per marked-only topic.
- Prefer references to question papers and question numbers instead of rewriting full question text.
- Consider grade, region, tutor reports, tutor notes, topic-based question metadata, question paper metadata, stored question indexes, and past marks.
- Return a compact JSON object with a top-level key called "recommendations".
- Each recommendation is one parent exercise for one date and contains only these fields: assignmentDate, questions.
- Each question inside questions contains only these fields: topic, questionReference, paperId, pageNumber.
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
      "questions": [
        { "topic": "Probability", "questionReference": "1.1", "paperId": "paper-a", "pageNumber": 2 },
        { "topic": "Algebra", "questionReference": "2.1", "paperId": "paper-b", "pageNumber": 3 }
      ]
    }
  ]
}

Student grade: ${grade ?? 'Unknown'}
Region: ${region ?? 'Unknown'}
Subject: ${subject}
Generation mode: ${mode}
Completed topics: ${JSON.stringify(completedTopics)}
Eligible topics for this generation: ${JSON.stringify(eligibleTopics)}
Marked-only topic suggestions (score scale is 0 to 1): ${JSON.stringify(markedTopicSuggestions)}
Marked-topic usage limits across this seven-day generation: ${JSON.stringify(markedTopicUsageLimits)}
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
Required parent exercise document count by date (also used by the app's validator): ${JSON.stringify(Object.fromEntries((questionPlanRules.perDayTopics ?? []).map((day) => [day.assignmentDate, day.exerciseCount])))}
Required question count inside each dated exercise (also used by the app's validator): ${JSON.stringify(Object.fromEntries((questionPlanRules.perDayTopics ?? []).map((day) => [day.assignmentDate, day.requiredCount])))}
Maximum question references in one exercise: ${maxQuestionsPerDay}
Maximum exercise documents per date: ${maxExercisesPerDay}

Additional mandatory generation rules:
- All structured understandingLevel values in lesson history and topic summaries use a normalized ratio from 0 to 1, where 0 means no demonstrated understanding and 1 means full understanding. Interpret these values only on that scale; a percentage is the ratio multiplied by 100. Tutor report notes may show the same understanding as a human-readable percentage; divide that percentage by 100 before comparing it with structured understandingLevel values. Never interpret understanding as a 0-to-10 or 0-to-100 stored score.
- Follow Question-plan rules.perDayTopics. Return exactly one recommendation object for each date with exerciseCount 1, and place every planned topic question for that date inside that object's questions array.
- requiredCount is the number of questions inside that one exercise document, not the number of exercise documents. The array must contain exactly that number and one question for each planned topic.
- Return no unplanned exercise documents, no extra questions, and no missing questions. When exerciseCount is zero, return no recommendation for that date.
- Each question object is one indexed question reference and one topic. Each parent recommendation is one exercise document for the date, even when its questions come from different topics or question papers.
- Never return more than Maximum exercise documents per date. The frontend validates parent document counts and nested question counts separately and rejects the entire plan if either is short or over.
- Each question reference must belong to an eligible topic, and marked-only topics must follow the stated per-topic usage limit across all seven dates.
- Choose questions from Topic-based source metadata first. For each topic, prefer using questions from at least two different papers when available.
- Do not use a question for a topic unless that question appears under that exact topic in Topic-based source metadata.
- Return exactly one question reference for each question object, without ranges like "1.1.3 - 1.1.5".
- For both initial and weekly modes, follow the exact daily topic slots in the plan; use each planned topic once for that date.
- When more than three topics are available, bias selections toward higher understanding topics, while still occasionally including lower understanding topics.
- Only use the selected source papers and include their exact ids in paperId.
- Use only questions from the stored source paper question indexes. Do not invent question numbers.
- Each completed topic has up to four matching analyzed paper sources in Topic-based source metadata. Use those sources to find enough indexed questions for every planned slot.
- Preserve the generation-history restriction: prefer matching papers not used in the recent generation summaries and use a recent paper only when fewer than four matching unused papers are available for that topic. Avoid exact questions from the last 28 days while there are enough distinct indexed questions for that topic.
- If the available distinct indexed questions are still insufficient to fill every planned slot, repeat an exact indexed question for that same topic on a different assignment date as the final fallback. Do not repeat a question twice on the same date. Repetition is not a reason to omit a planned slot: always return the exact required count, and never invent a reference, paper id, or page number.
- Use the exact questionReference, paperId, and pageNumber found in the stored question index.
- Return only the two example fields per recommendation and the four example fields per nested question; the app fills display and linking fields locally.
- Avoid repeating exact questionReferences from the same paper that appear in Last 28 days exercise history while other distinct indexed questions for that topic remain available.
- Repeating a recent exact question is allowed only when the topic-based source metadata does not contain enough different questions for that topic.
- NEVER REPEAT the same question for different assignment dates in the new plan, unless the total number of available matching questions is not enough.
- Vary paper sources across questions in each exercise when suitable questions are available.
${correctionInstruction ? `\nCorrection required: ${correctionInstruction}` : ''}
`;

export const recommendExercises = async (payload = {}) => {
  console.log('[Examifying][AI] recommendExercises:start', { studentId: payload.studentId, subject: payload.subject, mode: payload.mode });

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
    exerciseGenerationContext: {
      studentId: payload.studentId,
      subject: payload.subject,
    },
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
