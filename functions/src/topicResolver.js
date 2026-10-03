import { logger } from 'firebase-functions';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { getDb } from './admin.js';
import { normalizeGeneratedTopicLabel, normalizeStoredTopicLabel } from './globalTopicCatalog.js';
import { callGeminiGenerateContent } from './gemini.js';

const MODEL = 'gemini-3.5-flash-lite';
const MAX_SOURCE_TOPICS = 25;
const MAX_GEMINI_ATTEMPTS = 2;

const normalizeLabel = (value) => String(value ?? '')
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/[^a-z0-9|]+/g, ' ')
  .replace(/\s*\|\s*/g, ' | ')
  .replace(/\s+/g, ' ')
  .trim();

const normalizeSuggestedTopic = (value) => {
  return normalizeGeneratedTopicLabel(value);
};

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
  if (!subject || !grade || !topics.length || topics.length > MAX_SOURCE_TOPICS || topics.some((topic) => !topic)) {
    throw new HttpsError('invalid-argument', `Provide a subject, grade, and 1-${MAX_SOURCE_TOPICS} source topics.`);
  }
  if (subject.includes('/') || grade.includes('/')) {
    throw new HttpsError('invalid-argument', 'Subject and grade must be valid topic catalog IDs.');
  }

  const topicSnapshot = await getDb().collection('subjects').doc(subject).collection('grades').doc(grade).get();
  const allowedTopics = [...new Set((Array.isArray(topicSnapshot.data()?.topics) ? topicSnapshot.data().topics : [])
    .map(normalizeStoredTopicLabel)
    .filter(Boolean))];
  const allowedByKey = new Map(allowedTopics.map((topic) => [normalizeLabel(topic), topic]));
  const prompt = [
    'Resolve each source topic label against the supplied Firestore topic list first. If the list is empty or has no accurate match, suggest a new topic.',
    `Subject: ${subject}. Grade: ${grade}.`,
    'If a supplied topic fits, return that exact label.',
    'Only when none of the supplied topics fits, suggest a new concise label exactly in this structure: Child | Parent. Base it on the source label and subject; do not search for topics.',
    'Child and Parent must each be a specific topic name of no more than three words, never a sentence. Split compound concepts into separate labels. Use the narrowest useful parent category and create distinct precise parent names instead of using one broad catch-all parent. For example, use Fractions | Fraction Concepts, Decimals | Decimal Concepts, or Percentages | Percentage Concepts when those concepts are separate.',
    'Do not invent a replacement when a supplied topic fits. Return an empty string only when the source label is too unclear to resolve or suggest.',
    'Return only a JSON array with one string per source topic in the same order. No explanation or object wrapper.',
    `Allowed topics:\n${JSON.stringify(allowedTopics)}`,
    `Source topics to resolve:\n${JSON.stringify(topics)}`,
  ].join('\n\n');

  let generated;
  let proposed = [];
  for (let attempt = 1; attempt <= MAX_GEMINI_ATTEMPTS; attempt += 1) {
    generated = await callGeminiGenerateContent({
      prompt,
      model: MODEL,
      responseFormat: { type: 'json_array' },
      maxTokens: 0,
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
  const normalized = topics.map((_, index) => {
    const candidate = typeof proposed[index] === 'string' ? proposed[index].trim() : '';
    const canonicalTopic = allowedByKey.get(normalizeLabel(candidate));
    if (canonicalTopic) return { topic: canonicalTopic, type: 'canonical' };
    const suggestedTopic = normalizeSuggestedTopic(candidate);
    return suggestedTopic ? { topic: suggestedTopic, type: 'suggested' } : { topic: '', type: 'unresolved' };
  });
  const resolved = normalized.map(({ topic }) => topic);
  const resolutionTypes = normalized.map(({ type }) => type);

  logger.info('Admin topic resolution completed', {
    uid,
    subject,
    grade,
    topicCount: topics.length,
    resolvedCount: resolutionTypes.filter((type) => type === 'canonical').length,
    suggestedCount: resolutionTypes.filter((type) => type === 'suggested').length,
    unresolvedCount: resolutionTypes.filter((type) => type === 'unresolved').length,
    model: generated.model,
  });
  return { topics: resolved, resolutionTypes, model: MODEL };
});
