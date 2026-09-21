import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../src/config.js';
import { buildLlmRequest, extractJsonObject, generateSeed, parseLlmResponse } from '../src/llm.js';
import { PERSONA_A, PERSONA_B } from './helpers.js';

test('loadConfig maps PROVIDER / PROVIDER_KEY / PROVIDER_MODEL / OPENAI_BASE_URL', () => {
  const { config, errors } = loadConfig({
    SUBWAVE_API_URL: 'https://listen.example/api',
    SUBWAVE_API_USER: 'admin',
    SUBWAVE_API_PASSWORD: 'x',
    PROVIDER: 'anthro',
    PROVIDER_KEY: 'sk-ant-test',
    PROVIDER_MODEL: 'claude-sonnet-4-5',
    OPENAI_BASE_URL: 'https://llm.example/v1',
  });
  assert.deepEqual(errors, []);
  assert.equal(config.llmProvider, 'anthropic');
  assert.equal(config.llmApiKey, 'sk-ant-test');
  assert.equal(config.llmModel, 'claude-sonnet-4-5');
  assert.equal(config.openaiBaseUrl, 'https://llm.example/v1');
});

test('buildLlmRequest covers openai, google, and anthropic', () => {
  const openai = buildLlmRequest({
    provider: 'openai',
    apiKey: 'sk-test',
    model: 'gpt-4o-mini',
    openaiBaseUrl: 'https://api.openai.com/v1',
    system: 'sys',
    user: 'usr',
  });
  assert.equal(openai.url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(openai.headers.Authorization, 'Bearer sk-test');
  assert.equal(openai.body.messages[0].content, 'sys');

  const google = buildLlmRequest({
    provider: 'google',
    apiKey: 'goog',
    model: 'gemini-2.0-flash',
    system: 'sys',
    user: 'usr',
  });
  assert.equal(google.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent');
  assert.equal(google.headers['x-goog-api-key'], 'goog');
  assert.equal(google.body.systemInstruction.parts[0].text, 'sys');

  const anthropic = buildLlmRequest({
    provider: 'anthropic',
    apiKey: 'ant',
    model: 'claude-sonnet-4-5',
    system: 'sys',
    user: 'usr',
  });
  assert.equal(anthropic.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(anthropic.headers['x-api-key'], 'ant');
  assert.equal(anthropic.body.system, 'sys');
});

test('generateSeed posts OpenAI-compatible chat completions and parses rumor', async () => {
  const roles = { teller: PERSONA_A, hearers: [PERSONA_B], targets: [] };
  const result = await generateSeed({
    config: {
      llmProvider: 'openai',
      llmApiKey: 'sk-test',
      llmModel: 'gpt-4o-mini',
      openaiBaseUrl: 'https://openai.example/v1',
    },
    personas: [PERSONA_A, PERSONA_B],
    day: '2026-09-19',
    roles,
    fetchImpl: async (url, opts) => {
      assert.equal(url, 'https://openai.example/v1/chat/completions');
      assert.equal(opts.headers.Authorization, 'Bearer sk-test');
      const body = JSON.parse(opts.body);
      assert.equal(body.model, 'gpt-4o-mini');
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '{"rumor":"word is the booth kettle whistled through the legal ID"}' } }],
        }),
      };
    },
  });
  assert.equal(result.rumor, 'word is the booth kettle whistled through the legal ID');
});

test('parseLlmResponse reads Google and Anthropic payloads', () => {
  assert.equal(
    parseLlmResponse('google', {
      candidates: [{ content: { parts: [{ text: '{"rumor":"someone swears the neon blinked twice"}' }] } }],
    }).rumor,
    'someone swears the neon blinked twice',
  );
  assert.equal(
    parseLlmResponse('anthropic', {
      content: [{ type: 'text', text: '{"rumor":"unconfirmed the request line coughed static"}' }],
    }).rumor,
    'unconfirmed the request line coughed static',
  );
});

test('extractJsonObject keeps the first object when Gemma trails extra JSON', () => {
  const payload = extractJsonObject('{"rumor":"word is the kettle hissed twice"}\n{"note":"ignored"}');
  assert.equal(payload.rumor, 'word is the kettle hissed twice');
});
