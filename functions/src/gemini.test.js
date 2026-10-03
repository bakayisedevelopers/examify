import assert from 'node:assert/strict';
import test from 'node:test';
import { callGeminiGenerateContent } from './gemini.js';

const withMockGemini = async (callback) => {
  const originalApiKey = process.env.GEMINI_API_KEY;
  const originalFetch = globalThis.fetch;
  let requestBody;
  process.env.GEMINI_API_KEY = 'test-gemini-key';
  globalThis.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '[]' }] } }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  try {
    await callback(() => requestBody);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = originalApiKey;
  }
};

test('Gemini requests can omit the hard output-token limit', async () => {
  await withMockGemini(async (getRequestBody) => {
    await callGeminiGenerateContent({ prompt: 'resolve these topics', maxTokens: 0, thinkingLevel: 'low' });
    const { generationConfig } = getRequestBody();
    assert.equal(Object.hasOwn(generationConfig, 'maxOutputTokens'), false);
    assert.equal(generationConfig.thinkingConfig.thinkingLevel, 'low');
  });
});

test('positive Gemini output-token limits remain available to callers that request them', async () => {
  await withMockGemini(async (getRequestBody) => {
    await callGeminiGenerateContent({ prompt: 'generate text', maxTokens: 128 });
    assert.equal(getRequestBody().generationConfig.maxOutputTokens, 128);
  });
});
