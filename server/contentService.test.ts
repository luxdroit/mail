import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generateContextualReply,
  generateInitialWarmupEmail,
  testGeminiConnection,
  type GenAiCaller,
} from './contentService';

test('generateInitialWarmupEmail uses Gemini output and strips any artificial warmup tags', async () => {
  const mockCaller: GenAiCaller = {
    async generateJson() {
      return JSON.stringify({
        subject: '[WARMUP-123] Ustalenie terminu krótkiego spotkania',
        body: 'Cześć, czy jutro o 10:00 możemy krótko omówić plan prac na kolejny tydzień?',
      });
    },
  };

  const plain = await generateInitialWarmupEmail({
    model: 'gemini-3.1-flash-lite',
    format: 'plain',
    caller: mockCaller,
  });
  assert.equal(plain.usedFallback, false);
  assert.equal(plain.subject, 'Ustalenie terminu krótkiego spotkania');
  assert.equal(plain.html, undefined);

  const html = await generateInitialWarmupEmail({
    model: 'gemini-3.1-flash-lite',
    format: 'light_html',
    caller: mockCaller,
  });
  assert.equal(html.usedFallback, false);
  assert.ok(html.html && html.html.includes('<p'));
  assert.equal(html.html.includes('<img'), false);
});

test('automatic fallback on HTTP 429 rate-limit error from Gemini API', async () => {
  const rateLimitedCaller: GenAiCaller = {
    async generateJson() {
      const err = new Error('429 RESOURCE_EXHAUSTED: Quota exceeded') as Error & { status?: number };
      err.status = 429;
      throw err;
    },
  };

  const email = await generateInitialWarmupEmail({
    model: 'gemini-3.1-flash-lite',
    format: 'plain',
    caller: rateLimitedCaller,
    rng: () => 0.2,
  });
  assert.equal(email.usedFallback, true);
  assert.match(email.fallbackReason ?? '', /429/);
  assert.ok(email.subject.length > 5);
  assert.ok(email.text.length > 20);

  const reply = await generateContextualReply({
    model: 'gemini-3.1-flash-lite',
    format: 'light_html',
    originalSubject: 'Termin spotkania',
    originalSnippet: 'Czy wtorek pasuje?',
    caller: rateLimitedCaller,
    rng: () => 0.1,
  });
  assert.equal(reply.usedFallback, true);
  assert.match(reply.fallbackReason ?? '', /429/);
  assert.ok(reply.html && reply.html.includes('<p'));

  const testResult = await testGeminiConnection({
    model: 'gemini-3.1-flash-lite',
    caller: rateLimitedCaller,
  });
  assert.equal(testResult.ok, false);
  assert.equal(testResult.status, 'fallback_rate_limit');
  assert.equal(testResult.fallbackReady, true);
});

test('automatic fallback when GEMINI_API_KEY is missing', async () => {
  const email = await generateInitialWarmupEmail({
    model: 'gemini-3.1-flash-lite',
    format: 'plain',
    caller: null,
    rng: () => 0,
  });
  assert.equal(email.usedFallback, true);
  assert.match(email.fallbackReason ?? '', /GEMINI_API_KEY/);

  const testResult = await testGeminiConnection({
    model: 'gemini-3.1-flash-lite',
    caller: null,
  });
  assert.equal(testResult.ok, false);
  assert.equal(testResult.status, 'fallback_missing_key');
  assert.equal(testResult.fallbackReady, true);
});
