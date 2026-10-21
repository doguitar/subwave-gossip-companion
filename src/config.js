import { readFileSync } from 'node:fs';

import path from 'node:path';

import { loadGossipTypesFromPath } from './gossipTypes.js';

const DEFAULT_PORT = 8080;
const DEFAULT_SEED_CAP = 5;
const DEFAULT_GOSSIP_HISTORY_GENERATIONS = 7;
const DEFAULT_GOSSIP_REVIEW_ROUNDS = 0;
const DEFAULT_THREAD_MAX_TELLINGS = 3;
const DEFAULT_THREAD_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_REFRESH_MAX_CONCURRENCY = 1;
const DEFAULT_REFRESH_MIN_INTERVAL_MS = 60_000;
const DEFAULT_REFRESH_BODY_MAX_BYTES = 16 * 1024;
const DEFAULT_HTTP_HEADERS_TIMEOUT_MS = 10_000;
const DEFAULT_HTTP_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MODELS = {
  openai: 'gpt-4o-mini',
  google: 'gemini-2.0-flash',
  anthropic: 'claude-sonnet-4-5',
};

export function parseRefreshCount(value, name = 'count') {
  const count = Number(value);
  if (!Number.isInteger(count) || count < 1 || count > 10) {
    throw new Error(`${name} must be an integer 1-10`);
  }
  return count;
}

export function normalizeProvider(raw) {
  const value = String(raw || '').trim().toLowerCase();
  if (!value) return 'openai';
  if (value === 'anthro' || value === 'claude') return 'anthropic';
  if (value === 'gemini' || value === 'google') return 'google';
  if (value === 'openai' || value === 'openai-compatible' || value === 'openai_compatible') return 'openai';
  return value;
}

export function loadConfig(env = process.env) {
  const errors = [];
  const baseDir = path.resolve(env.GOSSIP_BASE_DIR || '.');
  const resolveBase = (value, fallback) => path.resolve(baseDir, value || fallback);
  const resolveState = (value) => {
    const candidate = path.resolve(baseDir, value || path.join('data', 'gossip-state.json'));
    const relative = path.relative(baseDir, candidate);
    return relative && !relative.startsWith('..') && !path.isAbsolute(relative)
      ? candidate
      : path.join(baseDir, 'data', 'gossip-state.json');
  };
  const apiUrl = (env.SUBWAVE_API_URL || '').trim().replace(/\/+$/, '');
  const apiUser = (env.SUBWAVE_API_USER || '').trim();
  const apiPassword = (env.SUBWAVE_API_PASSWORD || env.SUBWAVE_API_TOKEN || '').trim();
  const apiToken = (env.SUBWAVE_API_TOKEN || '').trim();
  if (!apiUrl) errors.push('SUBWAVE_API_URL is required');
  if (!apiUser && !apiToken) errors.push('SUBWAVE_API_USER or SUBWAVE_API_TOKEN is required');
  if (apiUser && !apiPassword) errors.push('SUBWAVE_API_PASSWORD is required when SUBWAVE_API_USER is set');

  const portRaw = env.GOSSIP_PORT ?? String(DEFAULT_PORT);
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    errors.push('GOSSIP_PORT must be an integer 1-65535');
  }

  const seedCapRaw = env.GOSSIP_SEED_CAP ?? String(DEFAULT_SEED_CAP);
  const seedCap = Number(seedCapRaw);
  if (!Number.isInteger(seedCap) || seedCap < 1 || seedCap > 50) {
    errors.push('GOSSIP_SEED_CAP must be an integer 1-50');
  }

  const historyGenerationsRaw = env.GOSSIP_HISTORY_GENERATIONS ?? String(DEFAULT_GOSSIP_HISTORY_GENERATIONS);
  const gossipHistoryGenerations = Number(historyGenerationsRaw);
  if (!Number.isInteger(gossipHistoryGenerations) || gossipHistoryGenerations < 0 || gossipHistoryGenerations > 50) {
    errors.push('GOSSIP_HISTORY_GENERATIONS must be an integer 0-50');
  }

  const reviewRoundsRaw = env.GOSSIP_REVIEW_ROUNDS ?? String(DEFAULT_GOSSIP_REVIEW_ROUNDS);
  const reviewRounds = Number(reviewRoundsRaw);
  if (!Number.isInteger(reviewRounds) || reviewRounds < 0 || reviewRounds > 5) {
    errors.push('GOSSIP_REVIEW_ROUNDS must be an integer 0-5');
  }
  const threadMaxTellings = Number(env.GOSSIP_THREAD_MAX_TELLINGS ?? String(DEFAULT_THREAD_MAX_TELLINGS));
  if (!Number.isInteger(threadMaxTellings) || threadMaxTellings < 1 || threadMaxTellings > 100) {
    errors.push('GOSSIP_THREAD_MAX_TELLINGS must be an integer 1-100');
  }
  const threadMaxAgeMs = Number(env.GOSSIP_THREAD_MAX_AGE_MS ?? String(DEFAULT_THREAD_MAX_AGE_MS));
  if (!Number.isFinite(threadMaxAgeMs) || threadMaxAgeMs < 1) {
    errors.push('GOSSIP_THREAD_MAX_AGE_MS must be a positive number');
  }
  const refreshSecret = (env.GOSSIP_REFRESH_SECRET || '').trim();
  if (!refreshSecret) errors.push('GOSSIP_REFRESH_SECRET is required');
  const refreshMaxConcurrency = Number(env.GOSSIP_REFRESH_MAX_CONCURRENCY ?? String(DEFAULT_REFRESH_MAX_CONCURRENCY));
  if (!Number.isInteger(refreshMaxConcurrency) || refreshMaxConcurrency < 1 || refreshMaxConcurrency > 10) {
    errors.push('GOSSIP_REFRESH_MAX_CONCURRENCY must be an integer 1-10');
  }
  const refreshMinIntervalMs = Number(env.GOSSIP_REFRESH_MIN_INTERVAL_MS ?? String(DEFAULT_REFRESH_MIN_INTERVAL_MS));
  if (!Number.isInteger(refreshMinIntervalMs) || refreshMinIntervalMs < 0 || refreshMinIntervalMs > 3_600_000) {
    errors.push('GOSSIP_REFRESH_MIN_INTERVAL_MS must be an integer 0-3600000');
  }
  const refreshBodyMaxBytes = Number(
    env.GOSSIP_REFRESH_BODY_MAX_BYTES ?? String(DEFAULT_REFRESH_BODY_MAX_BYTES),
  );
  if (!Number.isInteger(refreshBodyMaxBytes) || refreshBodyMaxBytes < 1 || refreshBodyMaxBytes > 1_048_576) {
    errors.push('GOSSIP_REFRESH_BODY_MAX_BYTES must be an integer 1-1048576');
  }
  const headersTimeoutMs = Number(
    env.GOSSIP_HEADERS_TIMEOUT_MS ?? String(DEFAULT_HTTP_HEADERS_TIMEOUT_MS),
  );
  if (!Number.isInteger(headersTimeoutMs) || headersTimeoutMs < 1_000 || headersTimeoutMs > 300_000) {
    errors.push('GOSSIP_HEADERS_TIMEOUT_MS must be an integer 1000-300000');
  }
  const requestTimeoutMs = Number(
    env.GOSSIP_REQUEST_TIMEOUT_MS ?? String(DEFAULT_HTTP_REQUEST_TIMEOUT_MS),
  );
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1_000 || requestTimeoutMs > 300_000) {
    errors.push('GOSSIP_REQUEST_TIMEOUT_MS must be an integer 1000-300000');
  }

  const host = (env.GOSSIP_HOST || '0.0.0.0').trim();
  const statePath = resolveState(env.GOSSIP_STATE_PATH);
  const feedBaseUrl = (env.GOSSIP_FEED_BASE_URL || '').trim();
  const timezone = (env.GOSSIP_TIMEZONE || '').trim();

  const llmProvider = normalizeProvider(env.PROVIDER || env.GOSSIP_LLM_PROVIDER || 'openai');
  if (!['openai', 'google', 'anthropic'].includes(llmProvider)) {
    errors.push('PROVIDER must be openai, google, or anthropic');
  }
  const llmApiKey = (
    env.PROVIDER_KEY
    || env.GOSSIP_LLM_API_KEY
    || env.OPENAI_API_KEY
    || env.ANTHROPIC_API_KEY
    || env.GOOGLE_API_KEY
    || ''
  ).trim();
  const llmModel = (
    env.PROVIDER_MODEL
    || env.GOSSIP_LLM_MODEL
    || DEFAULT_MODELS[llmProvider]
    || DEFAULT_MODELS.openai
  ).trim();
  const llmThinkingLevel = (
    env.PROVIDER_THINKING
    || env.GOSSIP_LLM_THINKING
    || ''
  ).trim();
  const openaiBaseUrl = (
    env.OPENAI_BASE_URL
    || env.GOSSIP_LLM_URL
    || DEFAULT_OPENAI_BASE_URL
  ).trim().replace(/\/+$/, '');
  const llmUrl = openaiBaseUrl;
  const llmFixturePath = env.GOSSIP_LLM_FIXTURE ? resolveBase(env.GOSSIP_LLM_FIXTURE, '') : '';
  const llmCallLogPath = resolveBase(env.GOSSIP_LLM_CALL_LOG, path.join('logs', 'llm-calls.jsonl'));
  const operationalLogPath = resolveBase(env.GOSSIP_OPERATIONAL_LOG, path.join('logs', 'gossip.log'));
  const promptPath = path.join(baseDir, 'prompt.md');
  const gossipTypesPath = resolveBase(env.GOSSIP_TYPES_PATH, 'gossip-types.json');
  let systemPrompt = '';
  try {
    systemPrompt = readFileSync(promptPath, 'utf8').trim();
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const gossipTypesResult = loadGossipTypesFromPath(gossipTypesPath);
  if (gossipTypesResult.errors?.length) {
    errors.push(...gossipTypesResult.errors);
  }
  const refreshCountRaw = env.GOSSIP_REFRESH_COUNT ?? '1';
  let refreshCount = 1;
  try {
    refreshCount = parseRefreshCount(refreshCountRaw, 'GOSSIP_REFRESH_COUNT');
  } catch (err) {
    errors.push(err.message);
  }
  const ttsTimeoutMs = Number(env.GOSSIP_TTS_TIMEOUT_MS ?? String(5 * 60 * 1000));
  const ttsPollMs = Number(env.GOSSIP_TTS_POLL_MS ?? '3000');
  const minRumorLength = Number(env.GOSSIP_MIN_RUMOR_LENGTH ?? '20');
  const config = {
    baseDir,
    promptPath,
    gossipTypesPath,
    rumorRegisters: gossipTypesResult.registers ?? [],
    systemPrompt,
    apiUrl,
    apiUser,
    apiPassword,
    apiToken,
    host,
    port,
    seedCap,
    gossipHistoryGenerations,
    reviewRounds: Number.isInteger(reviewRounds) ? reviewRounds : DEFAULT_GOSSIP_REVIEW_ROUNDS,
    threadMaxTellings: Number.isInteger(threadMaxTellings) ? threadMaxTellings : DEFAULT_THREAD_MAX_TELLINGS,
    threadMaxAgeMs: Number.isFinite(threadMaxAgeMs) && threadMaxAgeMs > 0 ? threadMaxAgeMs : DEFAULT_THREAD_MAX_AGE_MS,
    refreshSecret,
    refreshMaxConcurrency: Number.isInteger(refreshMaxConcurrency) && refreshMaxConcurrency >= 1 && refreshMaxConcurrency <= 10
      ? refreshMaxConcurrency
      : DEFAULT_REFRESH_MAX_CONCURRENCY,
    refreshMinIntervalMs: Number.isInteger(refreshMinIntervalMs) && refreshMinIntervalMs >= 0 && refreshMinIntervalMs <= 3_600_000
      ? refreshMinIntervalMs
      : DEFAULT_REFRESH_MIN_INTERVAL_MS,
    refreshBodyMaxBytes: Number.isInteger(refreshBodyMaxBytes) && refreshBodyMaxBytes >= 1 && refreshBodyMaxBytes <= 1_048_576
      ? refreshBodyMaxBytes
      : DEFAULT_REFRESH_BODY_MAX_BYTES,
    headersTimeoutMs: Number.isInteger(headersTimeoutMs) && headersTimeoutMs >= 1_000 && headersTimeoutMs <= 300_000
      ? headersTimeoutMs
      : DEFAULT_HTTP_HEADERS_TIMEOUT_MS,
    requestTimeoutMs: Number.isInteger(requestTimeoutMs) && requestTimeoutMs >= 1_000 && requestTimeoutMs <= 300_000
      ? requestTimeoutMs
      : DEFAULT_HTTP_REQUEST_TIMEOUT_MS,
    statePath,
    feedBaseUrl,
    timezone,
    llmProvider,
    llmApiKey,
    llmModel,
    ...(llmThinkingLevel ? { llmThinkingLevel } : {}),
    openaiBaseUrl,
    llmUrl,
    llmFixturePath,
    llmCallLogPath,
    operationalLogPath,
    refreshCount,
    ttsTimeoutMs: Number.isFinite(ttsTimeoutMs) && ttsTimeoutMs > 0 ? ttsTimeoutMs : 5 * 60 * 1000,
    minRumorLength: Number.isInteger(minRumorLength) && minRumorLength > 0 ? minRumorLength : 20,
    ttsPollMs: Number.isFinite(ttsPollMs) && ttsPollMs >= 250 ? ttsPollMs : 3000,
  };

  return { config, errors };
}

export function requireConfig(env = process.env) {
  const { config, errors } = loadConfig(env);
  if (errors.length) {
    const err = new Error(`Invalid configuration: ${errors.join('; ')}`);
    err.code = 'CONFIG';
    throw err;
  }
  return config;
}

export function applyDotEnv(filePath = path.resolve('.env'), env = process.env) {
  try {
    const raw = readFileSync(filePath, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 1) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim();
      if (env[key] == null || env[key] === '') env[key] = value;
    }
  } catch (err) {
    if (err && err.code !== 'ENOENT') throw err;
  }
  return env;
}
