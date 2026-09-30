export const getPaystackConfig = () => {
  return {
    paystackSecretKey: process.env.PAYSTACK_SECRET_KEY?.trim(),
    paystackBaseUrl: process.env.PAYSTACK_BASE_URL?.trim() || 'https://api.paystack.co',
    paystackCallbackUrl: process.env.PAYSTACK_CALLBACK_URL?.trim(),
  };
};

export const getAppConfig = () => {
  return {
    firestoreDatabaseId: process.env.FIRESTORE_DATABASE_ID?.trim() || '(default)',
  };
};

export const getKiloConfig = () => {
  return {
    baseUrl: process.env.KILO_BASE_URL?.trim() || 'https://api.kilo.ai/api/gateway',
    textModel: process.env.KILO_TEXT_MODEL?.trim() || 'thinkingmachines/inkling-small:free',
    fallbackTextModel: process.env.KILO_FALLBACK_TEXT_MODEL?.trim() || 'kilo-auto/free',
    visionModel: process.env.KILO_VISION_MODEL?.trim() || 'qwen/qwen3.8-27b:free',
    fallbackVisionModels: process.env.KILO_FALLBACK_VISION_MODELS?.trim() || 'dots-studio/dots-3-note-preview:free,stepfun/step-3.7-flash:free,kilo-auto/free',
  };
};

export const getGeminiConfig = () => {
  return {
    baseUrl: process.env.GEMINI_BASE_URL?.trim() || 'https://generativelanguage.googleapis.com/v1beta',
    model: process.env.GEMINI_MODEL?.trim() || 'gemini-3.5-flash-lite',
    hasApiKey: Boolean(process.env.GEMINI_API_KEY?.trim()),
  };
};
