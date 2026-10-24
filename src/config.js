import { readFileSync, writeFileSync } from 'node:fs';

import path from 'node:path';

import { OPERATIONAL_LOG_MAX_BYTES, OPERATIONAL_LOG_RETENTION_MS } from './callLog.js';
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
const DEFAULT_SHUTDOWN_DEADLINE_MS = 5000;
const OPERATIONAL_LOG_MAX_BYTES_LIMIT = 1073741824;
const OPERATIONAL_LOG_RETENTION_MS_LIMIT = 31536000000;
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
  const shutdownDeadlineMs = Number(env.GOSSIP_SHUTDOWN_DEADLINE_MS ?? String(DEFAULT_SHUTDOWN_DEADLINE_MS));
  if (!Number.isInteger(shutdownDeadlineMs) || shutdownDeadlineMs < 0 || shutdownDeadlineMs > 3_600_000) {
    errors.push('GOSSIP_SHUTDOWN_DEADLINE_MS must be an integer 0-3600000');
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
  const llmCallLogPath = env.GOSSIP_LLM_CALL_LOG === ''
    ? ''
    : resolveBase(env.GOSSIP_LLM_CALL_LOG, path.join('logs', 'llm-calls.jsonl'));
  const llmLogContent = String(env.GOSSIP_LLM_LOG_CONTENT || 'metadata').trim().toLowerCase();
  if (!['off', 'metadata', 'full'].includes(llmLogContent)) {
    errors.push('GOSSIP_LLM_LOG_CONTENT must be off, metadata, or full');
  }
  const operationalLogPath = resolveBase(env.GOSSIP_OPERATIONAL_LOG, path.join('logs', 'gossip.log'));
  const operationalLogMaxBytes = Number(
    env.GOSSIP_OPERATIONAL_LOG_MAX_BYTES ?? String(OPERATIONAL_LOG_MAX_BYTES),
  );
  if (
    !Number.isInteger(operationalLogMaxBytes)
    || operationalLogMaxBytes < 1
    || operationalLogMaxBytes > OPERATIONAL_LOG_MAX_BYTES_LIMIT
  ) {
    errors.push(`GOSSIP_OPERATIONAL_LOG_MAX_BYTES must be an integer 1-${OPERATIONAL_LOG_MAX_BYTES_LIMIT}`);
  }
  const operationalLogRetentionMs = Number(
    env.GOSSIP_OPERATIONAL_LOG_RETENTION_MS ?? String(OPERATIONAL_LOG_RETENTION_MS),
  );
  if (
    !Number.isInteger(operationalLogRetentionMs)
    || operationalLogRetentionMs < 1
    || operationalLogRetentionMs > OPERATIONAL_LOG_RETENTION_MS_LIMIT
  ) {
    errors.push(`GOSSIP_OPERATIONAL_LOG_RETENTION_MS must be an integer 1-${OPERATIONAL_LOG_RETENTION_MS_LIMIT}`);
  }
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
    shutdownDeadlineMs: Number.isInteger(shutdownDeadlineMs) && shutdownDeadlineMs >= 0 && shutdownDeadlineMs <= 3_600_000
      ? shutdownDeadlineMs
      : DEFAULT_SHUTDOWN_DEADLINE_MS,
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
    llmLogContent,
    operationalLogPath,
    operationalLogMaxBytes: Number.isInteger(operationalLogMaxBytes)
      && operationalLogMaxBytes >= 1
      && operationalLogMaxBytes <= OPERATIONAL_LOG_MAX_BYTES_LIMIT
      ? operationalLogMaxBytes
      : OPERATIONAL_LOG_MAX_BYTES,
    operationalLogRetentionMs: Number.isInteger(operationalLogRetentionMs)
      && operationalLogRetentionMs >= 1
      && operationalLogRetentionMs <= OPERATIONAL_LOG_RETENTION_MS_LIMIT
      ? operationalLogRetentionMs
      : OPERATIONAL_LOG_RETENTION_MS,
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
  const target = path.resolve(filePath || '.env');
  try {
    const raw = readFileSync(target, 'utf8');
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
    if (err && err.code === 'ENOENT') return env;
    const failure = new Error(`Cannot read env file ${target}: ${err?.message || err}`);
    failure.code = err?.code;
    failure.cause = err;
    throw failure;
  }
  return env;
}

const MISSING_HEADER = '# Missing config options';
const ENV_REFERENCE = /^os\.environ\/([A-Za-z_][A-Za-z0-9_]*)$/;
// shortcut: copied from loadConfig, update both when a reader default changes.
const SETTINGS = [
  ['GOSSIP_BASE_DIR', '.'],
  ['GOSSIP_TYPES_PATH', 'gossip-types.json'],
  ['SUBWAVE_API_URL', null],
  ['SUBWAVE_API_USER', null],
  ['SUBWAVE_API_PASSWORD', null],
  ['SUBWAVE_API_TOKEN', null],
  ['PROVIDER', 'openai'],
  ['GOSSIP_LLM_PROVIDER', 'openai'],
  ['PROVIDER_KEY', null],
  ['GOSSIP_LLM_API_KEY', null],
  ['OPENAI_API_KEY', null],
  ['ANTHROPIC_API_KEY', null],
  ['GOOGLE_API_KEY', null],
  ['PROVIDER_MODEL', DEFAULT_MODELS.openai],
  ['GOSSIP_LLM_MODEL', DEFAULT_MODELS.openai],
  ['PROVIDER_THINKING', null],
  ['GOSSIP_LLM_THINKING', null],
  ['OPENAI_BASE_URL', DEFAULT_OPENAI_BASE_URL],
  ['GOSSIP_LLM_URL', DEFAULT_OPENAI_BASE_URL],
  ['GOSSIP_REFRESH_COUNT', '1'],
  ['GOSSIP_REFRESH_SECRET', null],
  ['GOSSIP_REFRESH_MAX_CONCURRENCY', String(DEFAULT_REFRESH_MAX_CONCURRENCY)],
  ['GOSSIP_REFRESH_MIN_INTERVAL_MS', String(DEFAULT_REFRESH_MIN_INTERVAL_MS)],
  ['GOSSIP_REFRESH_BODY_MAX_BYTES', String(DEFAULT_REFRESH_BODY_MAX_BYTES)],
  ['GOSSIP_HEADERS_TIMEOUT_MS', String(DEFAULT_HTTP_HEADERS_TIMEOUT_MS)],
  ['GOSSIP_REQUEST_TIMEOUT_MS', String(DEFAULT_HTTP_REQUEST_TIMEOUT_MS)],
  ['GOSSIP_SHUTDOWN_DEADLINE_MS', String(DEFAULT_SHUTDOWN_DEADLINE_MS)],
  ['GOSSIP_HOST', '0.0.0.0'],
  ['GOSSIP_PORT', String(DEFAULT_PORT)],
  ['GOSSIP_STATE_PATH', 'data/gossip-state.json'],
  ['GOSSIP_SEED_CAP', String(DEFAULT_SEED_CAP)],
  ['GOSSIP_HISTORY_GENERATIONS', String(DEFAULT_GOSSIP_HISTORY_GENERATIONS)],
  ['GOSSIP_REVIEW_ROUNDS', String(DEFAULT_GOSSIP_REVIEW_ROUNDS)],
  ['GOSSIP_THREAD_MAX_TELLINGS', String(DEFAULT_THREAD_MAX_TELLINGS)],
  ['GOSSIP_THREAD_MAX_AGE_MS', String(DEFAULT_THREAD_MAX_AGE_MS)],
  ['GOSSIP_FEED_BASE_URL', null],
  ['GOSSIP_MIN_RUMOR_LENGTH', '20'],
  ['GOSSIP_TIMEZONE', null],
  ['GOSSIP_LLM_FIXTURE', null],
  ['GOSSIP_LLM_CALL_LOG', 'logs/llm-calls.jsonl'],
  ['GOSSIP_LLM_LOG_CONTENT', 'metadata'],
  ['GOSSIP_TTS_TIMEOUT_MS', String(5 * 60 * 1000)],
  ['GOSSIP_TTS_POLL_MS', '3000'],
  ['GOSSIP_OPERATIONAL_LOG', 'logs/gossip.log'],
  ['GOSSIP_OPERATIONAL_LOG_MAX_BYTES', String(OPERATIONAL_LOG_MAX_BYTES)],
  ['GOSSIP_OPERATIONAL_LOG_RETENTION_MS', String(OPERATIONAL_LOG_RETENTION_MS)],
];
const SETTING_KEYS = new Set(SETTINGS.map(([key]) => key));

export function applySettings(dir, env = process.env) {
  const preset = new Set(Object.keys(env).filter((key) => env[key] != null && env[key] !== ''));
  applyDotEnv(path.join(dir, '.env'), env);
  applyYamlSettings(path.join(dir, 'config.yaml'), env, preset);
  return env;
}

function applyYamlSettings(filePath, env, preset) {
  let raw;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') {
      writeMissingSection(filePath, '');
      return;
    }
    throw settingsReadError(filePath, err);
  }
  const splitAt = missingHeaderIndex(raw);
  const body = splitAt < 0 ? raw : raw.slice(0, splitAt);
  applyYamlValues(parseFlatSettings(body).values, env, preset);
  writeMissingSection(filePath, body);
}

function applyYamlValues(values, env, preset) {
  const fromEnv = { ...env };
  for (const [key, value] of values) {
    if (!SETTING_KEYS.has(key)) continue;
    if (typeof value === 'string') {
      const ref = ENV_REFERENCE.exec(value);
      if (ref) {
        const resolved = fromEnv[ref[1]];
        if (resolved == null || resolved === '') delete env[key];
        else env[key] = String(resolved);
        continue;
      }
    }
    if (preset.has(key)) continue;
    env[key] = value == null ? '' : String(value);
  }
}

function settingsReadError(filePath, err) {
  const failure = new Error(`Cannot read settings file ${filePath}: ${err?.message || err}`);
  failure.code = err?.code;
  failure.cause = err;
  return failure;
}

function missingHeaderIndex(raw) {
  const match = /(?:^|\r?\n)(# Missing config options)(?=\r?\n|$)/.exec(raw);
  if (!match) return -1;
  return match.index + match[0].length - match[1].length;
}

function missingSection(active) {
  const lines = [MISSING_HEADER];
  for (const [key, fallback] of SETTINGS) {
    if (active.has(key)) continue;
    lines.push(fallback == null ? `# ${key}:` : `# ${key}: ${fallback}`);
  }
  return `${lines.join('\n')}\n`;
}

function writeMissingSection(filePath, body) {
  const section = missingSection(parseFlatSettings(body).active);
  const prefix = body && !body.endsWith('\n') ? `${body}\n` : body;
  try {
    writeFileSync(filePath, `${prefix}${section}`);
  } catch {
    // A failed write must not stop startup.
  }
}

function parseFlatSettings(raw) {
  const active = new Set();
  const values = new Map();
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line || line[0] === ' ' || line[0] === '\t') continue;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const colon = trimmed.indexOf(':');
    if (colon <= 0) continue;
    const key = trimmed.slice(0, colon).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    const parsed = parseYamlScalar(trimmed.slice(colon + 1));
    // shortcut: single-line scalars only, upgrade if operators need block scalars.
    if (parsed.skip || (parsed.value == null && followingLineIndented(lines, index))) continue;
    active.add(key);
    values.set(key, parsed.value);
  }
  return { active, values };
}

function followingLineIndented(lines, index) {
  for (let i = index + 1; i < lines.length; i += 1) {
    if (!lines[i].trim()) continue;
    return lines[i][0] === ' ' || lines[i][0] === '\t';
  }
  return false;
}

function parseYamlScalar(raw) {
  const text = raw.trim();
  if (!text) return { value: null };
  if (text.startsWith('"')) return { value: parseDoubleQuoted(text) };
  if (text.startsWith("'")) return { value: parseSingleQuoted(text) };
  if (text.startsWith('{') || text.startsWith('[') || text.startsWith('|') || text.startsWith('>')) {
    return { skip: true };
  }
  const comment = text.search(/(?:^|\s)#/);
  const plain = (comment < 0 ? text : text.slice(0, comment)).trim();
  if (!plain) return { value: null };
  if (/^(?:true|True|TRUE)$/.test(plain)) return { value: true };
  if (/^(?:false|False|FALSE)$/.test(plain)) return { value: false };
  if (/^(?:null|Null|NULL|~)$/.test(plain)) return { value: null };
  if (/^[+-]?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(plain)) return { value: Number(plain) };
  return { value: plain };
}

function parseDoubleQuoted(text) {
  let out = '';
  for (let i = 1; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '\\') {
      const next = text[i + 1];
      const map = { n: '\n', t: '\t', r: '\r', '\\': '\\', '"': '"' };
      out += map[next] ?? next ?? '';
      i += 1;
      continue;
    }
    if (ch === '"') return out;
    out += ch;
  }
  return out;
}

function parseSingleQuoted(text) {
  let out = '';
  for (let i = 1; i < text.length; i += 1) {
    if (text[i] === "'" && text[i + 1] === "'") {
      out += "'";
      i += 1;
      continue;
    }
    if (text[i] === "'") return out;
    out += text[i];
  }
  return out;
}
