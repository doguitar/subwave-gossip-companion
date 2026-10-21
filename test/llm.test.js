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
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  appendLlmCall,
  LLM_CALL_LOG_MAX_BYTES,
  LLM_CALL_LOG_RETENTION_MS,
} from '../src/callLog.js';
import { loadConfig, requireConfig } from '../src/config.js';
import { createLog, formatRumorForOperationalLog } from '../src/log.js';
import { LLM_OUTPUT_BUDGET, buildLlmRequest, extractJsonObject, generateReview, generateSeed, parseLlmResponse, preflightProvider, reviewOutputBudget, soulSummaryUserPrompt, summarizeHouseRules, summarizePersonaSouls } from '../src/llm.js';
import { RUMOR_REGISTERS } from '../src/register.js';
import { PERSONA_A, PERSONA_B } from './helpers.js';

const repoGossipTypes = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'gossip-types.json');

test('loadConfig maps PROVIDER / PROVIDER_KEY / PROVIDER_MODEL / OPENAI_BASE_URL', () => {
  const { config, errors } = loadConfig({
    GOSSIP_BASE_DIR: '/workspace',
    GOSSIP_TYPES_PATH: repoGossipTypes,
    GOSSIP_STATE_PATH: '/outside/state.json',
    SUBWAVE_API_URL: 'https://listen.example/api',
    SUBWAVE_API_USER: 'admin',
    SUBWAVE_API_PASSWORD: 'x',
    GOSSIP_REFRESH_SECRET: 'test-secret',
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

test('loadConfig omits llmThinkingLevel when thinking env is unset or whitespace-only', () => {
  const base = {
    GOSSIP_BASE_DIR: '/workspace',
    GOSSIP_TYPES_PATH: repoGossipTypes,
    SUBWAVE_API_URL: 'https://listen.example/api',
    SUBWAVE_API_USER: 'admin',
    SUBWAVE_API_PASSWORD: 'x',
    GOSSIP_REFRESH_SECRET: 'test-secret',
  };
  assert.equal('llmThinkingLevel' in loadConfig(base).config, false);
  assert.equal('llmThinkingLevel' in loadConfig({ ...base, PROVIDER_THINKING: '   ' }).config, false);
  assert.equal('llmThinkingLevel' in loadConfig({ ...base, GOSSIP_LLM_THINKING: '\t' }).config, false);
});

test('loadConfig maps PROVIDER_THINKING and GOSSIP_LLM_THINKING alias with primary precedence', () => {
  const base = {
    GOSSIP_BASE_DIR: '/workspace',
    GOSSIP_TYPES_PATH: repoGossipTypes,
    SUBWAVE_API_URL: 'https://listen.example/api',
    SUBWAVE_API_USER: 'admin',
    SUBWAVE_API_PASSWORD: 'x',
    GOSSIP_REFRESH_SECRET: 'test-secret',
  };
  assert.equal(loadConfig({ ...base, PROVIDER_THINKING: 'medium' }).config.llmThinkingLevel, 'medium');
  assert.equal(loadConfig({ ...base, GOSSIP_LLM_THINKING: 'high' }).config.llmThinkingLevel, 'high');
  assert.equal(
    loadConfig({ ...base, PROVIDER_THINKING: 'low', GOSSIP_LLM_THINKING: 'max' }).config.llmThinkingLevel,
    'low',
  );
});

test('loadConfig accepts GOSSIP_REVIEW_ROUNDS 0-5 and rejects out-of-range values', () => {
  const base = {
    GOSSIP_BASE_DIR: '/workspace',
    GOSSIP_TYPES_PATH: repoGossipTypes,
    SUBWAVE_API_URL: 'https://listen.example/api',
    SUBWAVE_API_USER: 'admin',
    SUBWAVE_API_PASSWORD: 'x',
    GOSSIP_REFRESH_SECRET: 'test-secret',
  };
  assert.equal(loadConfig({ ...base, GOSSIP_REVIEW_ROUNDS: '0' }).config.reviewRounds, 0);
  assert.equal(loadConfig({ ...base, GOSSIP_REVIEW_ROUNDS: '5' }).config.reviewRounds, 5);
  assert.match(loadConfig({ ...base, GOSSIP_REVIEW_ROUNDS: '-1' }).errors.join('; '), /GOSSIP_REVIEW_ROUNDS/);
  assert.match(loadConfig({ ...base, GOSSIP_REVIEW_ROUNDS: '6' }).errors.join('; '), /GOSSIP_REVIEW_ROUNDS/);
  assert.match(loadConfig({ ...base, GOSSIP_REVIEW_ROUNDS: '1.5' }).errors.join('; '), /GOSSIP_REVIEW_ROUNDS/);
});

test('loadConfig resolves operational log path under GOSSIP_BASE_DIR', () => {
  const { config, errors } = loadConfig({
    GOSSIP_BASE_DIR: '/workspace',
    GOSSIP_TYPES_PATH: repoGossipTypes,
    SUBWAVE_API_URL: 'https://listen.example/api',
    SUBWAVE_API_USER: 'admin',
    SUBWAVE_API_PASSWORD: 'x',
    GOSSIP_REFRESH_SECRET: 'test-secret',
  });
  assert.deepEqual(errors, []);
  assert.equal(config.operationalLogPath, path.join(config.baseDir, 'logs', 'gossip.log'));

  const custom = loadConfig({
    GOSSIP_BASE_DIR: '/workspace',
    GOSSIP_TYPES_PATH: repoGossipTypes,
    GOSSIP_OPERATIONAL_LOG: 'var/run/gossip.log',
    SUBWAVE_API_URL: 'https://listen.example/api',
    SUBWAVE_API_USER: 'admin',
    SUBWAVE_API_PASSWORD: 'x',
    GOSSIP_REFRESH_SECRET: 'test-secret',
  }).config;
  assert.equal(custom.operationalLogPath, path.join(custom.baseDir, 'var', 'run', 'gossip.log'));

  const empty = loadConfig({
    GOSSIP_BASE_DIR: '/workspace',
    GOSSIP_TYPES_PATH: repoGossipTypes,
    GOSSIP_OPERATIONAL_LOG: '',
    SUBWAVE_API_URL: 'https://listen.example/api',
    SUBWAVE_API_USER: 'admin',
    SUBWAVE_API_PASSWORD: 'x',
    GOSSIP_REFRESH_SECRET: 'test-secret',
  });
  assert.deepEqual(empty.errors, []);
  assert.equal(empty.config.operationalLogPath, path.join(empty.config.baseDir, 'logs', 'gossip.log'));
});

test('loadConfig defaults operational log limits and rejects values outside the range', () => {
  const base = {
    GOSSIP_BASE_DIR: '/workspace',
    GOSSIP_TYPES_PATH: repoGossipTypes,
    SUBWAVE_API_URL: 'https://listen.example/api',
    SUBWAVE_API_USER: 'admin',
    SUBWAVE_API_PASSWORD: 'x',
    GOSSIP_REFRESH_SECRET: 'test-secret',
  };
  const unset = loadConfig(base);
  assert.deepEqual(unset.errors, []);
  assert.equal(unset.config.operationalLogMaxBytes, 524288);
  assert.equal(unset.config.operationalLogRetentionMs, 604800000);

  assert.equal(loadConfig({ ...base, GOSSIP_OPERATIONAL_LOG_MAX_BYTES: '1' }).config.operationalLogMaxBytes, 1);
  assert.equal(
    loadConfig({ ...base, GOSSIP_OPERATIONAL_LOG_MAX_BYTES: '1073741824' }).config.operationalLogMaxBytes,
    1073741824,
  );
  assert.equal(loadConfig({ ...base, GOSSIP_OPERATIONAL_LOG_RETENTION_MS: '1' }).config.operationalLogRetentionMs, 1);
  assert.equal(
    loadConfig({ ...base, GOSSIP_OPERATIONAL_LOG_RETENTION_MS: '31536000000' }).config.operationalLogRetentionMs,
    31536000000,
  );

  for (const value of ['0', '-1', '1.5', '1073741825', 'nope', '']) {
    const { errors } = loadConfig({ ...base, GOSSIP_OPERATIONAL_LOG_MAX_BYTES: value });
    assert.ok(errors.includes('GOSSIP_OPERATIONAL_LOG_MAX_BYTES must be an integer 1-1073741824'));
  }
  for (const value of ['0', '-1', '1.5', '31536000001', 'nope', '']) {
    const { errors } = loadConfig({ ...base, GOSSIP_OPERATIONAL_LOG_RETENTION_MS: value });
    assert.ok(errors.includes('GOSSIP_OPERATIONAL_LOG_RETENTION_MS must be an integer 1-31536000000'));
  }

  assert.throws(
    () => requireConfig({ ...base, GOSSIP_OPERATIONAL_LOG_MAX_BYTES: '0' }),
    (err) => err.code === 'CONFIG' && /GOSSIP_OPERATIONAL_LOG_MAX_BYTES/.test(err.message),
  );
  assert.throws(
    () => requireConfig({ ...base, GOSSIP_OPERATIONAL_LOG_RETENTION_MS: 'nope' }),
    (err) => err.code === 'CONFIG' && /GOSSIP_OPERATIONAL_LOG_RETENTION_MS/.test(err.message),
  );
});

test('formatRumorForOperationalLog collapses newlines and JSON-quotes', () => {
  assert.equal(formatRumorForOperationalLog('hello'), '"hello"');
  assert.equal(formatRumorForOperationalLog('line one\nline two'), '"line one line two"');
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
  const lines = [];
  const errors = [];
  const log = createLog(blocked, {
    log: (message) => lines.push(message),
    warn: (message) => lines.push(message),
    error: (message) => errors.push(message),
  });
  log.info('[gossip] still works');
  log.info('[gossip] still works again');
  const deadline = Date.now() + 1000;
  while (errors.length < 1 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(lines, ['[gossip] still works', '[gossip] still works again']);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^\[gossip\] operational log write failed:/);
});

test('createLog serializes rotation and passes the configured retention and clock', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gossip-log-'));
  const logPath = path.join(dir, 'gossip.log');
  const stale = path.join(dir, 'gossip.5.log');
  const fresh = path.join(dir, 'gossip.9.log');
  const wall = Date.now();
  const nowMs = wall + 10_000;
  await writeFile(logPath, 'x'.repeat(32));
  await utimes(logPath, new Date(nowMs - 100), new Date(nowMs - 100));
  await writeFile(stale, 'stale\n');
  await utimes(stale, new Date(wall), new Date(wall));
  await writeFile(fresh, 'fresh-bytes\n');
  await utimes(fresh, new Date(nowMs - 100), new Date(nowMs - 100));
  const lines = [];
  const errors = [];
  let clock = nowMs;
  const log = createLog(logPath, {
    log: (message) => lines.push(message),
    warn: (message) => lines.push(message),
    error: (message) => errors.push(message),
  }, {
    maxBytes: 32,
    retentionMs: 1000,
    now: () => {
      clock += 1;
      return clock;
    },
  });
  log.info('one');
  log.info('two');
  let active = '';
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      active = await readFile(logPath, 'utf8');
    } catch {
      active = '';
    }
    if (active === 'one\ntwo\n') break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.deepEqual(lines, ['one', 'two']);
  assert.deepEqual(errors, []);
  assert.equal(active, 'one\ntwo\n');
  const rolled = (await readdir(dir)).filter((name) => /^gossip\.\d+\.log$/.test(name) && name !== 'gossip.9.log');
  assert.deepEqual(rolled, [`gossip.${nowMs + 1}.log`]);
  assert.equal(await readFile(path.join(dir, rolled[0]), 'utf8'), 'x'.repeat(32));
  await assert.rejects(readFile(stale, 'utf8'));
  assert.equal(await readFile(fresh, 'utf8'), 'fresh-bytes\n');
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

test('output budgets cover seed, summary, and review for every provider', () => {
  const kinds = [
    ['seed', LLM_OUTPUT_BUDGET.seed],
    ['summary', LLM_OUTPUT_BUDGET.summary],
    ['review', reviewOutputBudget(10)],
  ];
  assert.equal(LLM_OUTPUT_BUDGET.summary, 2000);
  assert.equal(reviewOutputBudget(1), LLM_OUTPUT_BUDGET.seed);
  assert.ok(reviewOutputBudget(10) > reviewOutputBudget(1));
  assert.equal(reviewOutputBudget(50), reviewOutputBudget(80));
  for (const provider of ['openai', 'google', 'anthropic']) {
    for (const [, maxTokens] of kinds) {
      const request = buildLlmRequest({
        provider,
        apiKey: 'k',
        model: 'm',
        openaiBaseUrl: 'https://api.openai.com/v1',
        system: 'sys',
        user: 'usr',
        maxTokens,
      });
      const actual = provider === 'google' ? request.body.generationConfig.maxOutputTokens : request.body.max_tokens;
      assert.equal(actual, maxTokens);
    }
  }
});

test('a truncated review response fails instead of returning partial JSON', async () => {
  const config = {
    llmProvider: 'anthropic',
    llmApiKey: 'ant',
    llmModel: 'claude-sonnet-4-5',
    llmCallLogPath: '',
  };
  const bodies = {
    anthropic: { stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"rumors":' }] },
    openai: { choices: [{ finish_reason: 'length', message: { content: '{"rumors":' } }] },
    google: { candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: '{"rumors":' }] } }] },
  };
  for (const provider of ['anthropic', 'openai', 'google']) {
    await assert.rejects(
      () => generateReview({
        config: { ...config, llmProvider: provider, openaiBaseUrl: 'https://api.openai.com/v1' },
        day: '2026-09-19',
        tidbits: [{ id: 't1', text: 'Alpha told Beta, "word is Gamma hid a cart"' }, { id: 't2', text: 'Alpha told Beta, "word is Gamma hid a kettle"' }],
        round: 1,
        totalRounds: 1,
        fetchImpl: async (_url, init) => {
          const sent = JSON.parse(init.body);
          const budget = provider === 'google' ? sent.generationConfig.maxOutputTokens : sent.max_tokens;
          assert.equal(budget, reviewOutputBudget(2));
          return { ok: true, status: 200, json: async () => bodies[provider] };
        },
        log: { info() {}, warn() {} },
      }),
      /LLM review output truncated/,
    );
  }
});

test('buildLlmRequest omits thinking fields when level is off', () => {
  const common = { apiKey: 'k', model: 'm', system: 'sys', user: 'usr' };
  const openai = buildLlmRequest({
    ...common,
    provider: 'openai',
    openaiBaseUrl: 'https://api.openai.com/v1',
  });
  assert.equal(openai.body.reasoning_effort, undefined);
  assert.equal(openai.body.thinking, undefined);

  const local = buildLlmRequest({
    ...common,
    provider: 'openai',
    openaiBaseUrl: 'http://10.10.1.50:1234/v1',
  });
  assert.equal(local.body.reasoning_effort, undefined);
  assert.equal(local.body.thinking, undefined);

  const google = buildLlmRequest({ ...common, provider: 'google' });
  assert.equal(google.body.generationConfig.thinkingConfig, undefined);

  const anthropic = buildLlmRequest({ ...common, provider: 'anthropic' });
  assert.equal(anthropic.body.output_config, undefined);
});

test('buildLlmRequest maps openai on and off to supported reasoning_effort values', () => {
  const on = buildLlmRequest({
    provider: 'openai',
    apiKey: 'k',
    model: 'm',
    openaiBaseUrl: 'http://127.0.0.1:11234/v1',
    system: 'sys',
    user: 'usr',
    thinkingLevel: 'on',
  });
  assert.equal(on.body.reasoning_effort, 'high');
  assert.deepEqual(on.body.thinking, { type: 'enabled', level: 'high' });

  const off = buildLlmRequest({
    provider: 'openai',
    apiKey: 'k',
    model: 'm',
    openaiBaseUrl: 'http://127.0.0.1:11234/v1',
    system: 'sys',
    user: 'usr',
    thinkingLevel: 'off',
  });
  assert.equal(off.body.reasoning_effort, 'none');
  assert.equal(off.body.thinking, undefined);
});

test('buildLlmRequest maps thinking level per provider when on', () => {
  const level = 'medium';
  const common = { apiKey: 'k', model: 'm', system: 'sys', user: 'usr', thinkingLevel: level };

  const anthropic = buildLlmRequest({ ...common, provider: 'anthropic' });
  assert.deepEqual(anthropic.body.output_config, { effort: level });
  assert.equal(anthropic.body.temperature, 0.9);

  const openai = buildLlmRequest({
    ...common,
    provider: 'openai',
    openaiBaseUrl: 'https://api.openai.com/v1',
  });
  assert.equal(openai.body.reasoning_effort, level);
  assert.equal(openai.body.thinking, undefined);
  assert.equal(openai.body.response_format.type, 'json_object');

  const local = buildLlmRequest({
    ...common,
    provider: 'openai',
    openaiBaseUrl: 'http://proxy.local/v1',
  });
  assert.equal(local.body.reasoning_effort, level);
  assert.deepEqual(local.body.thinking, { type: 'enabled', level });

  const google = buildLlmRequest({ ...common, provider: 'google', model: 'gemini-2.0-flash' });
  assert.deepEqual(google.body.generationConfig.thinkingConfig, { thinkingLevel: level });
  assert.equal(google.body.generationConfig.responseMimeType, 'application/json');
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

test('generateSeed forwards configured thinking level into the posted JSON body', async () => {
  const roles = { teller: PERSONA_A, hearers: [PERSONA_B], targets: [] };
  const register = RUMOR_REGISTERS.find((r) => r.id === 'deadpan-absurdity');
  const baseConfig = {
    llmProvider: 'openai',
    llmApiKey: 'sk-test',
    llmModel: 'gpt-4o-mini',
    openaiBaseUrl: 'https://openai.example/v1',
  };

  await generateSeed({
    config: baseConfig,
    day: '2026-09-19',
    roles,
    register,
    fetchImpl: async (_url, opts) => {
      const body = JSON.parse(opts.body);
      assert.equal(body.reasoning_effort, undefined);
      assert.equal(body.thinking, undefined);
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '{"rumor":"no steering"}' } }],
        }),
      };
    },
  });

  await generateSeed({
    config: { ...baseConfig, llmThinkingLevel: 'high' },
    day: '2026-09-19',
    roles,
    register,
    fetchImpl: async (_url, opts) => {
      const body = JSON.parse(opts.body);
      assert.equal(body.reasoning_effort, 'high');
      assert.deepEqual(body.thinking, { type: 'enabled', level: 'high' });
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '{"rumor":"with steering"}' } }],
        }),
      };
    },
  });
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
  const records = llmLog.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(records.length, 2);
  assert.equal(records[0].stage, 'start');
  assert.equal(records[1].stage, 'success');
  assert.equal(records[0].lifecycleId, records[1].lifecycleId);
  assert.equal(llmLog.includes('anti-repeat'), false);
  assert.equal(llmLog.includes('System soul'), false);
});

test('parseLlmResponse ignores Google thought parts and Anthropic non-text blocks', () => {
  assert.equal(
    parseLlmResponse('google', {
      candidates: [{
        content: {
          parts: [
            { thought: true, text: '{"rumor":"ignored thought"}' },
            { text: '{"rumor":"someone swears the neon blinked twice"}' },
          ],
        },
      }],
    }).rumor,
    'someone swears the neon blinked twice',
  );
  assert.equal(
    parseLlmResponse('anthropic', {
      content: [
        { type: 'thinking', thinking: 'internal reasoning' },
        { type: 'text', text: '{"rumor":"unconfirmed the request line coughed static"}' },
      ],
    }).rumor,
    'unconfirmed the request line coughed static',
  );
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

test('summarizePersonaSouls asks for rumor-relevant compression and returns each summary', async () => {
  const persona = { ...PERSONA_A, soul: 'Long musical essay. Speech tic: stoked. Habit: pockets the spare headphones.' };
  const seen = [];
  const summaries = await summarizePersonaSouls({
    config: {
      llmProvider: 'openai',
      llmApiKey: 'sk-test',
      llmModel: 'gpt-4o-mini',
      openaiBaseUrl: 'https://openai.example/v1',
    },
    personas: [persona],
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      seen.push(body);
      assert.equal(url, 'https://openai.example/v1/chat/completions');
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: '{"summary":"Pockets the spare headphones. Says stoked."}' } }] }),
      };
    },
  });
  assert.match(seen[0].messages[0].content, /rumor generator/);
  assert.match(seen[0].messages[1].content, /pockets the spare headphones/i);
  assert.equal(soulSummaryUserPrompt(persona).includes(PERSONA_A.name), true);
  assert.deepEqual(summaries, [{ id: persona.id, name: persona.name, summary: 'Pockets the spare headphones. Says stoked.' }]);
});

test('summarizeHouseRules keeps setting and language limits', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gossip-llm-'));
  const logPath = path.join(dir, 'llm-calls.jsonl');
  const summary = await summarizeHouseRules({
    config: {
      llmProvider: 'openai',
      llmApiKey: 'sk-test',
      llmModel: 'gpt-4o-mini',
      openaiBaseUrl: 'https://openai.example/v1',
      llmCallLogPath: logPath,
    },
    houseRules: 'Pirate station on a garbage boat. Adult audience. Spell out numbers. Show transitions should be abrupt.',
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.match(body.messages[0].content, /hallway rumor/);
      assert.match(body.messages[1].content, /garbage boat/);
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: '{"summary":"Garbage-boat pirate station. Adult language is allowed."}' } }] }),
      };
    },
  });
  assert.equal(summary, 'Garbage-boat pirate station. Adult language is allowed.');
  const logged = (await readFile(logPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(logged.at(-1).kind, 'house-rules-summary');
  assert.equal(logged.at(-1).stage, 'success');
  assert.equal(await summarizeHouseRules({ config: {}, houseRules: '   ' }), '');
});

test('generateSeed records correlated, redacted terminal failures', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gossip-llm-'));
  const logPath = path.join(dir, 'llm-calls.jsonl');
  const roles = { teller: PERSONA_A, hearers: [PERSONA_B], targets: [] };
  const register = RUMOR_REGISTERS.find((r) => r.id === 'deadpan-absurdity');
  await assert.rejects(
    generateSeed({
      config: { llmProvider: 'openai', llmApiKey: 'sk-secret', llmModel: 'm', openaiBaseUrl: 'https://llm.example/v1', llmCallLogPath: logPath },
      day: '2026-09-19', roles, register,
      fetchImpl: async () => ({ ok: false, status: 400, text: async () => 'authorization: Bearer sk-secret invalid' }),
    }),
    /HTTP 400/,
  );
  const records = (await readFile(logPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(records.length, 2);
  assert.equal(records[0].stage, 'start');
  assert.equal(records[1].stage, 'http-failure');
  assert.equal(records[0].invocationId, records[1].invocationId);
  assert.equal(records[1].status, 400);
  assert.equal(JSON.stringify(records).includes('sk-secret'), false);
});

test('generateSeed records thrown transport failures', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gossip-llm-'));
  const logPath = path.join(dir, 'llm-calls.jsonl');
  const roles = { teller: PERSONA_A, hearers: [PERSONA_B], targets: [] };
  const register = RUMOR_REGISTERS.find((r) => r.id === 'deadpan-absurdity');
  await assert.rejects(generateSeed({
    config: { llmProvider: 'openai', llmApiKey: 'sk-test', llmModel: 'm', openaiBaseUrl: 'https://llm.example/v1', llmCallLogPath: logPath },
    day: '2026-09-19', roles, register,
    fetchImpl: async () => { throw new Error('connection reset'); },
  }), /connection reset/);
  const records = (await readFile(logPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(records.at(-1).stage, 'transport-failure');
  assert.equal(records[0].lifecycleId, records[1].lifecycleId);
});

test('preflight validates supported provider models and preserves unsupported paths', async () => {
  const validated = await preflightProvider({
    config: { llmProvider: 'openai', llmApiKey: 'sk-test', llmModel: 'gpt-test', openaiBaseUrl: 'https://api.openai.com/v1' },
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://api.openai.com/v1/models/gpt-test');
      assert.equal(options.headers.Authorization, 'Bearer sk-test');
      return { ok: true };
    },
  });
  assert.equal(validated.capability, 'validated');
  const unsupported = await preflightProvider({
    config: { llmProvider: 'anthropic', llmApiKey: 'ant-test', llmModel: 'claude-test' },
    fetchImpl: async () => { throw new Error('must not fetch'); },
  });
  assert.equal(unsupported.capability, 'unsupported');
});
