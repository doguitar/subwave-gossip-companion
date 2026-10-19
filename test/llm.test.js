import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import {
  appendLlmCall,
  LLM_CALL_LOG_MAX_BYTES,
  LLM_CALL_LOG_RETENTION_MS,
} from '../src/callLog.js';
import { loadConfig } from '../src/config.js';
import { createLog } from '../src/log.js';
import { buildLlmRequest, extractJsonObject, generateSeed, parseLlmResponse } from '../src/llm.js';
import { RUMOR_REGISTERS } from '../src/register.js';
import { PERSONA_A, PERSONA_B } from './helpers.js';

test('loadConfig maps PROVIDER / PROVIDER_KEY / PROVIDER_MODEL / OPENAI_BASE_URL', () => {
  const { config, errors } = loadConfig({
    GOSSIP_BASE_DIR: '/workspace',
    GOSSIP_STATE_PATH: '/outside/state.json',
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
  assert.equal(config.statePath, path.join(config.baseDir, 'data', 'gossip-state.json'));
});

test('loadConfig resolves operational log path under GOSSIP_BASE_DIR', () => {
  const { config, errors } = loadConfig({
    GOSSIP_BASE_DIR: '/workspace',
    SUBWAVE_API_URL: 'https://listen.example/api',
    SUBWAVE_API_USER: 'admin',
    SUBWAVE_API_PASSWORD: 'x',
  });
  assert.deepEqual(errors, []);
  assert.equal(config.operationalLogPath, path.join(config.baseDir, 'logs', 'gossip.log'));

  const custom = loadConfig({
    GOSSIP_BASE_DIR: '/workspace',
    GOSSIP_OPERATIONAL_LOG: 'var/run/gossip.log',
    SUBWAVE_API_URL: 'https://listen.example/api',
    SUBWAVE_API_USER: 'admin',
    SUBWAVE_API_PASSWORD: 'x',
  }).config;
  assert.equal(custom.operationalLogPath, path.join(custom.baseDir, 'var', 'run', 'gossip.log'));
});

test('createLog tees messages to console and the operational log file', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'gossip-log-'));
  const logPath = path.join(base, 'logs', 'gossip.log');
  const lines = [];
  const log = createLog(logPath, {
    log: (m) => lines.push(m),
    warn: (m) => lines.push(m),
    error: (m) => lines.push(m),
  });
  log.info('[gossip] storage ready');
  log.warn('[gossip] Subwave API check failed: offline');
  await new Promise((resolve) => setTimeout(resolve, 30));
  const file = await readFile(logPath, 'utf8');
  assert.deepEqual(lines, [
    '[gossip] storage ready',
    '[gossip] Subwave API check failed: offline',
  ]);
  assert.equal(file, '[gossip] storage ready\n[gossip] Subwave API check failed: offline\n');
});

test('createLog does not throw when the operational log path is not writable', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'gossip-log-ro-'));
  const blocked = path.join(base, 'blocked');
  await mkdir(blocked, { recursive: true });
  const log = createLog(blocked);
  log.info('[gossip] still works');
  await new Promise((resolve) => setTimeout(resolve, 30));
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
  assert.equal(openai.body.response_format.type, 'json_object');
  assert.equal(openai.body.messages[0].content, 'sys');

  const local = buildLlmRequest({
    provider: 'openai',
    apiKey: '',
    model: 'gemma-4-e4b-it-heretic',
    openaiBaseUrl: 'http://10.10.1.50:1234/v1',
    system: 'sys',
    user: 'usr',
  });
  assert.equal(local.url, 'http://10.10.1.50:1234/v1/chat/completions');
  assert.equal(local.headers.Authorization, undefined);
  assert.equal(local.body.response_format, undefined);
  assert.equal(local.body.model, 'gemma-4-e4b-it-heretic');

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
  const register = RUMOR_REGISTERS.find((r) => r.id === 'deadpan-absurdity');
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
    register,
    fetchImpl: async (url, opts) => {
      assert.equal(url, 'https://openai.example/v1/chat/completions');
      assert.equal(opts.headers.Authorization, 'Bearer sk-test');
      const body = JSON.parse(opts.body);
      assert.equal(body.model, 'gpt-4o-mini');
      assert.match(body.messages[1].content, /deadpan absurdity/);
      assert.match(body.messages[1].content, /Rumor register for this rumor/);
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

test('generateSeed does not write multi-line prompt bodies to the operational log', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'gossip-seed-log-'));
  const operationalLogPath = path.join(base, 'logs', 'gossip.log');
  const llmCallLogPath = path.join(base, 'logs', 'llm-calls.jsonl');
  const log = createLog(operationalLogPath);
  const roles = { teller: PERSONA_A, hearers: [PERSONA_B], targets: [] };
  const register = RUMOR_REGISTERS.find((r) => r.id === 'deadpan-absurdity');
  const houseRules = 'House rules:\n- no real listener names\n- anti-repeat: do not echo prior rumors';
  const systemPrompt = 'System soul\nwith multiple\nlines';

  await generateSeed({
    config: {
      llmProvider: 'openai',
      llmApiKey: 'sk-test',
      llmModel: 'gpt-4o-mini',
      openaiBaseUrl: 'https://openai.example/v1',
      systemPrompt,
      llmCallLogPath,
    },
    houseRules,
    day: '2026-09-19',
    roles,
    register,
    log,
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '{"rumor":"word is the neon blinked twice"}' } }],
      }),
    }),
  });

  await new Promise((resolve) => setTimeout(resolve, 30));
  const operational = await readFile(operationalLogPath, 'utf8');
  const physicalLines = operational.split('\n').filter((line) => line.length > 0);
  for (const line of physicalLines) {
    assert.match(line, /^\[gossip\]/);
    assert.equal(line.includes('\n'), false);
  }
  assert.ok(physicalLines.length >= 1);
  assert.ok(!physicalLines.some((line) => line.includes('anti-repeat')));
  assert.ok(!physicalLines.some((line) => line.includes('System soul')));

  const llmLog = await readFile(llmCallLogPath, 'utf8');
  const record = JSON.parse(llmLog.trim().split('\n').at(-1));
  assert.equal(record.prompt.system, systemPrompt);
  assert.match(record.prompt.user, /anti-repeat/);
  assert.match(record.prompt.user, /House rules/);
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

test('appendLlmCall rolls the active log when the next line would exceed 512 KiB', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gossip-llm-log-'));
  const logPath = path.join(dir, 'llm-calls.jsonl');
  await writeFile(logPath, 'x'.repeat(LLM_CALL_LOG_MAX_BYTES), 'utf8');
  const record = { at: '2026-10-17T00:00:00.000Z', response: { text: 'rolled' } };
  await appendLlmCall(logPath, record);

  const active = await readFile(logPath, 'utf8');
  assert.equal(active, `${JSON.stringify(record)}\n`);
  assert.ok((await stat(logPath)).size < LLM_CALL_LOG_MAX_BYTES);

  const rolled = (await readdir(dir)).filter((name) => /^llm-calls\.\d+\.jsonl$/.test(name));
  assert.equal(rolled.length, 1);
  assert.equal((await stat(path.join(dir, rolled[0]))).size, LLM_CALL_LOG_MAX_BYTES);
});

test('appendLlmCall deletes rolled segments older than seven days', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gossip-llm-log-'));
  const logPath = path.join(dir, 'llm-calls.jsonl');
  const stalePath = path.join(dir, 'llm-calls.1111111111111.jsonl');
  await writeFile(stalePath, '{"at":"old"}\n', 'utf8');
  const eightDaysAgo = new Date(Date.now() - LLM_CALL_LOG_RETENTION_MS - 24 * 60 * 60 * 1000);
  await utimes(stalePath, eightDaysAgo, eightDaysAgo);

  await appendLlmCall(logPath, { at: '2026-10-17T00:00:00.000Z', response: { text: 'fresh' } });

  const names = await readdir(dir);
  assert.equal(names.includes('llm-calls.1111111111111.jsonl'), false);
  assert.equal(names.includes('llm-calls.jsonl'), true);
});
