import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions';
import { jsonrepair } from 'jsonrepair';
import { assertPaidExerciseGenerationAccess } from './exerciseAccess.js';

const kiloBaseUrl = () => process.env.KILO_BASE_URL?.trim() || 'https://api.kilo.ai/api/gateway';
const kiloTextModel = () => process.env.KILO_TEXT_MODEL?.trim() || 'thinkingmachines/inkling-small:free';
const kiloExerciseTextModels = () => (process.env.KILO_EXERCISE_MODELS?.trim() || 'qwen/qwen3.8-27b:free,dots-studio/dots-3-note-preview:free,thinkingmachines/inkling-small:free')
  .split(',')
  .map((model) => model.trim())
  .filter(Boolean);
const kiloFallbackTextModel = () => process.env.KILO_FALLBACK_TEXT_MODEL?.trim() || 'kilo-auto/free';
const kiloExerciseFallbackTextModel = () => process.env.KILO_EXERCISE_FALLBACK_MODEL?.trim() || 'kilo-auto/free';
const kiloVisionModel = () => process.env.KILO_VISION_MODEL?.trim() || 'qwen/qwen3.8-27b:free';
const kiloFallbackVisionModels = () => (process.env.KILO_FALLBACK_VISION_MODELS?.trim() || 'dots-studio/dots-3-note-preview:free,stepfun/step-3.7-flash:free,kilo-auto/free')
  .split(',')
  .map((model) => model.trim())
  .filter(Boolean);

export const normalizeMessages = ({ system, prompt, messages = [] }) => {
  const normalized = [];

  if (system) {
    normalized.push({ role: 'system', content: String(system) });
  }

  if (Array.isArray(messages) && messages.length) {
    messages.forEach((message) => {
      if (message?.role && message?.content) {
        normalized.push({
          role: message.role,
          content: message.content,
        });
      }
    });
  }

  if (prompt) {
    normalized.push({ role: 'user', content: String(prompt) });
  }

  if (!normalized.length) {
    throw new HttpsError('invalid-argument', 'A prompt or messages array is required.');
  }

  return normalized;
};

const parseKiloResponse = (data) => {
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => part?.text ?? '')
      .filter(Boolean)
      .join('\n')
      .trim();
  }
  return '';
};

export const callKiloChat = async ({
  model,
  messages,
  maxTokens = 2000,
  temperature = 0.2,
  responseFormat,
  mode,
}) => {
  const response = await fetch(`${kiloBaseUrl()}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(mode ? { 'x-kilocode-mode': mode } : {}),
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: maxTokens,
      temperature,
      ...(responseFormat ? { response_format: responseFormat } : {}),
    }),
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    logger.error('Kilo request failed', {
      status: response.status,
      error: data?.error,
      model,
    });
    throw new HttpsError(
      'unavailable',
      data?.error?.message || `Kilo request failed with status ${response.status}.`
    );
  }

  return {
    text: parseKiloResponse(data),
    model: data?.model ?? model,
    usage: data?.usage ?? null,
    raw: data,
  };
};

const isUsefulVisionText = (text = '') => {
  const normalized = String(text ?? '').trim();
  if (normalized.length < 40) return false;
  if (/^```(?:json)?\s*\{\s*"?subjects"?\s*:\s*\[\s*\]\s*\}\s*```?$/i.test(normalized)) return false;
  if (/^\{\s*"?subjects"?\s*:\s*\[\s*\]\s*\}$/i.test(normalized)) return false;
  return true;
};

export const callKiloVisionWithFallback = async ({ messages, maxTokens, temperature, responseFormat, mode }) => {
  const models = [kiloVisionModel(), ...kiloFallbackVisionModels()].filter((model, index, list) => model && list.indexOf(model) === index);
  let lastError = null;

  for (const model of models) {
    try {
      const result = await callKiloChat({ model, messages, maxTokens, temperature, responseFormat, mode });
      const responseText = String(result?.text ?? '').trim();
      const textLength = responseText.length;
      const useful = isUsefulVisionText(responseText);
      logger.info('Kilo vision request completed', { model, textLength, useful, preview: responseText.slice(0, 80) });

      if (useful) {
        return model === models[0]
          ? result
          : { ...result, fallbackUsed: true, fallbackFrom: models[0] };
      }

      lastError = new HttpsError('unavailable', `Kilo vision model ${model} returned an unusable response.`);
      logger.warn('Kilo vision model returned unusable response, trying next model', { model, textLength });
    } catch (error) {
      lastError = error;
      logger.warn('Kilo vision model failed, trying next model', { model, message: error?.message });
    }
  }

  throw lastError ?? new HttpsError('unavailable', 'Kilo vision extraction failed.');
};

const buildVisionContent = ({ prompt, url, imageUrls = [] }) => {
  if (!prompt) {
    throw new HttpsError('invalid-argument', 'prompt is required.');
  }

  const urls = [url, ...imageUrls].filter(Boolean);
  if (!urls.length) {
    throw new HttpsError('invalid-argument', 'A URL, data URL, or image list is required.');
  }

  return [
    { type: 'text', text: String(prompt) },
    ...urls.map((imageUrl) => ({ type: 'image_url', image_url: { url: imageUrl } })),
  ];
};


export const callKiloTextWithFallback = async ({ messages, maxTokens = 3000, temperature = 0.2, responseFormat, validateText } = {}) => {
  const primaryModel = kiloTextModel();
  const fallbackModel = kiloFallbackTextModel();
  try {
    const primaryResult = await callKiloChat({ model: primaryModel, messages, maxTokens, temperature, responseFormat, mode: 'general' });
    if (validateText && !validateText(primaryResult.text)) throw new HttpsError('unavailable', `Kilo text model ${primaryModel} returned an unusable response.`);
    return primaryResult;
  } catch (error) {
    if (primaryModel === fallbackModel) throw error;
    logger.warn('Kilo text model failed, retrying fallback text model', { primaryModel, fallbackModel, message: error?.message });
    const fallbackResult = await callKiloChat({ model: fallbackModel, messages, maxTokens, temperature, responseFormat, mode: 'general' });
    if (validateText && !validateText(fallbackResult.text)) throw new HttpsError('unavailable', `Kilo text model ${fallbackModel} returned an unusable response.`);
    return { ...fallbackResult, fallbackUsed: true, fallbackFrom: primaryModel };
  }
};

const validateJsonArrayKey = (requiredJsonKey) => (text) => {
  try {
    const content = String(text ?? '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    const first = content.indexOf('{');
    const last = content.lastIndexOf('}');
    const candidate = first >= 0 ? content.slice(first, last > first ? last + 1 : undefined) : content;
    let parsed;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      parsed = JSON.parse(jsonrepair(candidate));
    }
    const entries = parsed?.[requiredJsonKey];
    return Array.isArray(entries) && entries.length > 0 && entries.every((entry) =>
      Array.isArray(entry?.questionReferences) && entry.questionReferences.length > 0
      || Array.isArray(entry?.topicBreakdown) && entry.topicBreakdown.some((topic) => topic?.questionReference || topic?.reference)
      || Boolean(entry?.questionReference && entry?.topic && entry?.paperId)
      || Boolean(entry?.title)
    );
  } catch {
    return false;
  }
};

export const callKiloExerciseTextWithFallback = async ({ messages, maxTokens = 3000, temperature = 0.2, responseFormat, requiredJsonKey = 'recommendations' } = {}) => {
  const models = [...new Set([...kiloExerciseTextModels(), kiloExerciseFallbackTextModel()])];
  const validateText = validateJsonArrayKey(requiredJsonKey);
  let lastError = null;
  for (const [index, model] of models.entries()) {
    try {
      const result = await callKiloChat({ model, messages, maxTokens, temperature, responseFormat, mode: 'general' });
      if (!validateText(result.text)) throw new HttpsError('unavailable', `Kilo exercise model ${model} returned invalid recommendations.`);
      logger.info('Exercise generation used Kilo text model', { model, attempt: index + 1, fallbackUsed: index > 0 });
      return { ...result, fallbackUsed: index > 0, fallbackFrom: index > 0 ? models[index - 1] : '' };
    } catch (error) {
      lastError = error;
      logger.warn('Kilo exercise model failed; trying next model', { model, attempt: index + 1, message: error?.message });
    }
  }
  throw lastError ?? new HttpsError('unavailable', 'All Kilo exercise models failed.');
};

export const callKiloText = onCall(async (request) => {
  const {
    system,
    prompt,
    messages,
    maxTokens,
    temperature,
    responseFormat,
  } = request.data ?? {};

  const normalizedMessages = normalizeMessages({ system, prompt, messages });
  return callKiloTextWithFallback({
    messages: normalizedMessages,
    maxTokens,
    temperature,
    responseFormat,
  });
});

export const callExerciseGenerationText = onCall({ timeoutSeconds: 300 }, async (request) => {
  const { system, prompt, messages, maxTokens, temperature, responseFormat, requiredJsonKey, exerciseGenerationContext } = request.data ?? {};
  await assertPaidExerciseGenerationAccess({
    authUid: request.auth?.uid,
    studentId: exerciseGenerationContext?.studentId,
    subject: exerciseGenerationContext?.subject,
  });
  const normalizedMessages = normalizeMessages({ system, prompt, messages });
  return callKiloExerciseTextWithFallback({
    messages: normalizedMessages,
    maxTokens,
    temperature,
    responseFormat,
    requiredJsonKey,
  });
});

export const callKiloImage = onCall(async (request) => {
  const {
    prompt,
    imageUrl,
    imageDataUrl,
    imageUrls,
    maxTokens,
    temperature,
    responseFormat,
  } = request.data ?? {};

  const result = await callKiloVisionWithFallback({
    messages: [
      {
        role: 'user',
        content: buildVisionContent({
          prompt,
          url: imageDataUrl || imageUrl,
          imageUrls,
        }),
      },
    ],
    maxTokens,
    temperature,
    responseFormat,
    mode: 'general',
  });

  return result;
});

export const callKiloDocument = onCall(async (request) => {
  const {
    prompt,
    documentUrl,
    documentDataUrl,
    documentImages,
    documentMimeType,
    fileName,
    extractedText,
    maxTokens,
    temperature,
    responseFormat,
  } = request.data ?? {};

  const url = documentDataUrl || documentUrl;
  const imageList = Array.isArray(documentImages) ? documentImages.filter(Boolean) : [];
  const content = [];

  if (!prompt) {
    throw new HttpsError('invalid-argument', 'prompt is required.');
  }

  content.push({ type: 'text', text: String(prompt) });

  if (extractedText) {
    content.push({
      type: 'text',
      text: `Extracted document text, if available:\n${String(extractedText)}`,
    });
  }

  imageList.forEach((imageUrl) => {
    content.push({ type: 'image_url', image_url: { url: imageUrl } });
  });

  if (url) {
    const mimeType = String(documentMimeType || '').toLowerCase();
    const isPdf = mimeType.includes('pdf') || String(fileName || documentUrl || documentDataUrl || '').toLowerCase().includes('.pdf') || String(url).startsWith('data:application/pdf');

    if (isPdf && String(url).startsWith('data:') && !imageList.length) {
      content.push({
        type: 'file',
        file: {
          filename: fileName || 'document.pdf',
          file_data: url,
        },
      });
    } else if (!isPdf) {
      content.push({ type: 'image_url', image_url: { url } });
    }
  }

  if (!url && !imageList.length && !extractedText) {
    throw new HttpsError('invalid-argument', 'documentUrl, documentDataUrl, documentImages, or extractedText is required.');
  }

  const result = await callKiloVisionWithFallback({
    messages: [{ role: 'user', content }],
    maxTokens,
    temperature,
    responseFormat,
    mode: 'general',
  });

  return result;
});
