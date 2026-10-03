import { logger } from 'firebase-functions';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { getDb } from './admin.js';
import { callGeminiGenerateContent } from './gemini.js';

const MODEL = 'gemini-3.5-flash-lite';
const MAX_SOURCE_TOPICS = 25;
const MAX_ALLOWED_TOPICS = 300;
const MAX_GEMINI_ATTEMPTS = 2;

const normalizeLabel = (value) => String(value ?? '')
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/[^a-z0-9|]+/g, ' ')
  .replace(/\s*\|\s*/g, ' | ')
  .replace(/\s+/g, ' ')
  .trim();

const parseTopicArray = (value = '') => {
  const text = String(value).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const first = text.indexOf('[');
  const last = text.lastIndexOf(']');
  if (first < 0 || last <= first) return [];
  try {
    const parsed = JSON.parse(text.slice(first, last + 1));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

export const resolveTopicsWithGemini = onCall({ timeoutSeconds: 240, memory: '256MiB' }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in as an admin to resolve topics.');

  const actorSnapshot = await getDb().collection('users').doc(uid).get();
  if (!actorSnapshot.exists || actorSnapshot.data()?.role !== 'admin') {
    throw new HttpsError('permission-denied', 'Only admins can resolve topic names.');
  }

  const subject = String(request.data?.subject ?? '').trim().slice(0, 100);
  const grade = String(request.data?.grade ?? '').trim().slice(0, 32);
  const topics = Array.isArray(request.data?.topics)
    ? request.data.topics.map((topic) => String(topic ?? '').trim().slice(0, 160))
    : [];
  const allowedTopics = Array.isArray(request.data?.allowedTopics)
    ? [...new Set(request.data.allowedTopics.map((topic) => String(topic ?? '').trim().slice(0, 180)).filter(Boolean))]
    : [];

  if (!subject || !grade || !topics.length || topics.length > MAX_SOURCE_TOPICS || topics.some((topic) => !topic)) {
    throw new HttpsError('invalid-argument', `Provide a subject, grade, and 1-${MAX_SOURCE_TOPICS} source topics.`);
  }
  if (!allowedTopics.length || allowedTopics.length > MAX_ALLOWED_TOPICS || allowedTopics.some((topic) => !topic.includes('|'))) {
    throw new HttpsError('invalid-argument', 'The frontend topic catalog is missing or invalid.');
  }

  const allowedByKey = new Map(allowedTopics.map((topic) => [normalizeLabel(topic), topic]));
  const prompt = [
    'You are resolving extracted topic labels from South African school question papers.',
    `Subject: ${subject}. Grade: ${grade}.`,
    'Use official South African DBE CAPS/ATP sources and Google Search grounding to verify the curriculum meaning where possible.',
    'For every source label, select the single best exact canonical label from the supplied allowed list. Never invent, rewrite, or combine labels.',
    'If the evidence is insufficient or no allowed label fits, return an empty string for that item.',
    'Return only a JSON array of strings, in the same order and with exactly the same number of items as the source list. No explanation or object wrapper.',
    `Allowed canonical topics:\n${JSON.stringify(allowedTopics)}`,
    `Source topics to resolve:\n${JSON.stringify(topics)}`,
  ].join('\n\n');

  let generated;
  let proposed = [];
  for (let attempt = 1; attempt <= MAX_GEMINI_ATTEMPTS; attempt += 1) {
    generated = await callGeminiGenerateContent({
      prompt,
      model: MODEL,
      useGoogleSearch: true,
      responseFormat: { type: 'json_array' },
      maxTokens: 0,
      thinkingLevel: 'low',
      temperature: 0,
    });
    proposed = generated.text.trim() ? parseTopicArray(generated.text) : [];
    if (proposed.length === topics.length) break;

    const candidate = generated.raw?.candidates?.[0] ?? {};
    logger.warn('Gemini topic-resolution attempt returned an empty or incomplete list', {
      model: generated.model,
      attempt,
      maxAttempts: MAX_GEMINI_ATTEMPTS,
      topicCount: topics.length,
      proposedCount: proposed.length,
      textLength: generated.text.length,
      finishReason: candidate.finishReason ?? null,
      promptBlockReason: generated.raw?.promptFeedback?.blockReason ?? null,
      candidateTokenCount: generated.usage?.candidatesTokenCount ?? null,
    });
  }

  if (!generated.text.trim()) {
    throw new HttpsError('unavailable', 'Gemini returned an empty topic-resolution response. Please retry.');
  }
  if (proposed.length !== topics.length) {
    logger.warn('Gemini returned an incomplete topic-resolution list', {
      model: generated.model,
      topicCount: topics.length,
      proposedCount: proposed.length,
    });
    throw new HttpsError('unavailable', `Gemini returned ${proposed.length} topic results for ${topics.length} source topics. Please retry.`);
  }
  const resolved = topics.map((_, index) => {
    const key = normalizeLabel(typeof proposed[index] === 'string' ? proposed[index] : '');
    return allowedByKey.get(key) ?? '';
  });

  logger.info('Admin topic resolution completed', {
    uid,
    subject,
    grade,
    topicCount: topics.length,
    resolvedCount: resolved.filter(Boolean).length,
    model: generated.model,
  });
  return { topics: resolved, model: MODEL };
});
