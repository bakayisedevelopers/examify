import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions';
import { normalizeMessages } from './kilo.js';
import { assertPaidExerciseGenerationAccess } from './exerciseAccess.js';

const geminiApiKey = () => process.env.GEMINI_API_KEY?.trim();
const geminiModel = () => process.env.GEMINI_MODEL?.trim() || 'gemini-3.5-flash-lite';
const geminiBaseUrl = () => process.env.GEMINI_BASE_URL?.trim() || 'https://generativelanguage.googleapis.com/v1beta';

const extractGeminiText = (data = {}) =>
  (data.candidates?.[0]?.content?.parts ?? [])
    .map((part) => part?.text ?? '')
    .filter(Boolean)
    .join('\n')
    .trim();

const messagesToPrompt = (messages = []) =>
  messages
    .map((message) => `${String(message.role ?? 'user').toUpperCase()}:\n${message.content}`)
    .join('\n\n');

const assertGeminiKey = () => {
  const key = geminiApiKey();
  if (!key) {
    throw new HttpsError('failed-precondition', 'GEMINI_API_KEY is not configured for Firebase Functions.');
  }
  return key;
};

export const callGeminiGenerateContent = async ({
  prompt,
  pdfBase64,
  pdfMimeType = 'application/pdf',
  maxTokens = 2500,
  temperature = 0.1,
  responseFormat,
  model: requestedModel,
  useGoogleSearch = false,
} = {}) => {
  const key = assertGeminiKey();
  const model = String(requestedModel ?? geminiModel()).trim() || geminiModel();
  const parts = [{ text: String(prompt ?? '').trim() }];
  if (!parts[0].text) throw new HttpsError('invalid-argument', 'prompt is required.');
  if (pdfBase64) {
    parts.push({
      inline_data: {
        mime_type: pdfMimeType,
        data: pdfBase64,
      },
    });
  }

  const response = await fetch(`${geminiBaseUrl()}/models/${model}:generateContent?key=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts }],
      ...(useGoogleSearch ? { tools: [{ google_search: {} }] } : {}),
      generationConfig: {
        temperature,
        maxOutputTokens: maxTokens,
        ...(['json_object', 'json_array'].includes(responseFormat?.type) ? { responseMimeType: 'application/json' } : {}),
      },
    }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    logger.error('Gemini request failed', {
      status: response.status,
      model,
      error: data?.error?.message,
    });
    throw new HttpsError('unavailable', data?.error?.message || `Gemini request failed with status ${response.status}.`);
  }

  const text = extractGeminiText(data);
  logger.info('Gemini request completed', { model, textLength: text.length });
  return {
    text,
    model,
    usage: data?.usageMetadata ?? null,
    raw: data,
  };
};

export const callGeminiText = onCall(async (request) => {
  const {
    system,
    prompt,
    messages,
    maxTokens,
    temperature,
    responseFormat,
  } = request.data ?? {};

  const exerciseGenerationContext = request.data?.exerciseGenerationContext;
  if (exerciseGenerationContext) {
    await assertPaidExerciseGenerationAccess({
      authUid: request.auth?.uid,
      studentId: exerciseGenerationContext.studentId,
      subject: exerciseGenerationContext.subject,
    });
  }

  const normalizedMessages = normalizeMessages({ system, prompt, messages });
  return callGeminiGenerateContent({
    prompt: messagesToPrompt(normalizedMessages),
    maxTokens,
    temperature,
    responseFormat,
  });
});
