import { closeSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';

import path from 'node:path';

import { isMap, isScalar, parseDocument } from 'yaml';

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
const DEFAULT_PROVIDER = 'openai';
const DEFAULT_HOST = '0.0.0.0';
const DEFAULT_BASE_DIR = '.';
const DEFAULT_STATE_PATH = path.join('data', 'gossip-state.json');
const DEFAULT_CALL_LOG = path.join('logs', 'llm-calls.jsonl');
const DEFAULT_OPERATIONAL_LOG_PATH = path.join('logs', 'gossip.log');
const DEFAULT_TYPES_PATH = 'gossip-types.json';
const DEFAULT_LOG_CONTENT = 'metadata';
const DEFAULT_REFRESH_COUNT = '1';
const DEFAULT_TTS_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_TTS_POLL_MS = 3000;
const DEFAULT_MIN_RUMOR_LENGTH = 20;

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
  const baseDir = path.resolve(env.GOSSIP_BASE_DIR || DEFAULT_BASE_DIR);
  const resolveBase = (value, fallback) => path.resolve(baseDir, value || fallback);
  const resolveState = (value) => {
    const candidate = path.resolve(baseDir, value || DEFAULT_STATE_PATH);
    const relative = path.relative(baseDir, candidate);
    return relative && !relative.startsWith('..') && !path.isAbsolute(relative)
      ? candidate
      : path.join(baseDir, DEFAULT_STATE_PATH);
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

  const host = (env.GOSSIP_HOST || DEFAULT_HOST).trim();
  const statePath = resolveState(env.GOSSIP_STATE_PATH);
  const feedBaseUrl = (env.GOSSIP_FEED_BASE_URL || '').trim();
  const timezone = (env.GOSSIP_TIMEZONE || '').trim();

  const llmProvider = normalizeProvider(env.PROVIDER || env.GOSSIP_LLM_PROVIDER || DEFAULT_PROVIDER);
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
    : resolveBase(env.GOSSIP_LLM_CALL_LOG, DEFAULT_CALL_LOG);
  const llmLogContent = String(env.GOSSIP_LLM_LOG_CONTENT || DEFAULT_LOG_CONTENT).trim().toLowerCase();
  if (!['off', 'metadata', 'full'].includes(llmLogContent)) {
    errors.push('GOSSIP_LLM_LOG_CONTENT must be off, metadata, or full');
  }
  const operationalLogPath = resolveBase(env.GOSSIP_OPERATIONAL_LOG, DEFAULT_OPERATIONAL_LOG_PATH);
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
  const gossipTypesPath = resolveBase(env.GOSSIP_TYPES_PATH, DEFAULT_TYPES_PATH);
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
  const refreshCountRaw = env.GOSSIP_REFRESH_COUNT ?? DEFAULT_REFRESH_COUNT;
  let refreshCount = 1;
  try {
    refreshCount = parseRefreshCount(refreshCountRaw, 'GOSSIP_REFRESH_COUNT');
  } catch (err) {
    errors.push(err.message);
  }
  const ttsTimeoutMs = Number(env.GOSSIP_TTS_TIMEOUT_MS ?? String(DEFAULT_TTS_TIMEOUT_MS));
  const ttsPollMs = Number(env.GOSSIP_TTS_POLL_MS ?? String(DEFAULT_TTS_POLL_MS));
  const minRumorLength = Number(env.GOSSIP_MIN_RUMOR_LENGTH ?? String(DEFAULT_MIN_RUMOR_LENGTH));
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
    ttsTimeoutMs: Number.isFinite(ttsTimeoutMs) && ttsTimeoutMs > 0 ? ttsTimeoutMs : DEFAULT_TTS_TIMEOUT_MS,
    minRumorLength: Number.isInteger(minRumorLength) && minRumorLength > 0 ? minRumorLength : DEFAULT_MIN_RUMOR_LENGTH,
    ttsPollMs: Number.isFinite(ttsPollMs) && ttsPollMs >= 250 ? ttsPollMs : DEFAULT_TTS_POLL_MS,
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

const REFERENCE = /^os\.environ\/([A-Za-z_][A-Za-z0-9_]*)$/;

const SETTINGS_KEYS = [
  ['GOSSIP_BASE_DIR', () => DEFAULT_BASE_DIR],
  ['SUBWAVE_API_URL', null],
  ['SUBWAVE_API_USER', null],
  ['SUBWAVE_API_PASSWORD', null],
  ['SUBWAVE_API_TOKEN', null],
  ['GOSSIP_PORT', () => DEFAULT_PORT],
  ['GOSSIP_SEED_CAP', () => DEFAULT_SEED_CAP],
  ['GOSSIP_HISTORY_GENERATIONS', () => DEFAULT_GOSSIP_HISTORY_GENERATIONS],
  ['GOSSIP_REVIEW_ROUNDS', () => DEFAULT_GOSSIP_REVIEW_ROUNDS],
  ['GOSSIP_THREAD_MAX_TELLINGS', () => DEFAULT_THREAD_MAX_TELLINGS],
  ['GOSSIP_THREAD_MAX_AGE_MS', () => DEFAULT_THREAD_MAX_AGE_MS],
  ['GOSSIP_REFRESH_SECRET', null],
  ['GOSSIP_REFRESH_MAX_CONCURRENCY', () => DEFAULT_REFRESH_MAX_CONCURRENCY],
  ['GOSSIP_REFRESH_MIN_INTERVAL_MS', () => DEFAULT_REFRESH_MIN_INTERVAL_MS],
  ['GOSSIP_REFRESH_BODY_MAX_BYTES', () => DEFAULT_REFRESH_BODY_MAX_BYTES],
  ['GOSSIP_HEADERS_TIMEOUT_MS', () => DEFAULT_HTTP_HEADERS_TIMEOUT_MS],
  ['GOSSIP_REQUEST_TIMEOUT_MS', () => DEFAULT_HTTP_REQUEST_TIMEOUT_MS],
  ['GOSSIP_SHUTDOWN_DEADLINE_MS', () => DEFAULT_SHUTDOWN_DEADLINE_MS],
  ['GOSSIP_HOST', () => DEFAULT_HOST],
  ['GOSSIP_STATE_PATH', () => DEFAULT_STATE_PATH],
  ['GOSSIP_FEED_BASE_URL', null],
  ['GOSSIP_TIMEZONE', null],
  ['PROVIDER', () => DEFAULT_PROVIDER],
  ['GOSSIP_LLM_PROVIDER', null],
  ['PROVIDER_KEY', null],
  ['GOSSIP_LLM_API_KEY', null],
  ['OPENAI_API_KEY', null],
  ['ANTHROPIC_API_KEY', null],
  ['GOOGLE_API_KEY', null],
  ['PROVIDER_MODEL', (env) => DEFAULT_MODELS[normalizeProvider(env.PROVIDER || env.GOSSIP_LLM_PROVIDER || DEFAULT_PROVIDER)] || DEFAULT_MODELS.openai],
  ['GOSSIP_LLM_MODEL', null],
  ['PROVIDER_THINKING', null],
  ['GOSSIP_LLM_THINKING', null],
  ['OPENAI_BASE_URL', () => DEFAULT_OPENAI_BASE_URL],
  ['GOSSIP_LLM_URL', null],
  ['GOSSIP_LLM_FIXTURE', null],
  ['GOSSIP_LLM_CALL_LOG', () => DEFAULT_CALL_LOG],
  ['GOSSIP_LLM_LOG_CONTENT', () => DEFAULT_LOG_CONTENT],
  ['GOSSIP_OPERATIONAL_LOG', () => DEFAULT_OPERATIONAL_LOG_PATH],
  ['GOSSIP_OPERATIONAL_LOG_MAX_BYTES', () => OPERATIONAL_LOG_MAX_BYTES],
  ['GOSSIP_OPERATIONAL_LOG_RETENTION_MS', () => OPERATIONAL_LOG_RETENTION_MS],
  ['GOSSIP_TYPES_PATH', () => DEFAULT_TYPES_PATH],
  ['GOSSIP_REFRESH_COUNT', () => DEFAULT_REFRESH_COUNT],
  ['GOSSIP_TTS_TIMEOUT_MS', () => DEFAULT_TTS_TIMEOUT_MS],
  ['GOSSIP_TTS_POLL_MS', () => DEFAULT_TTS_POLL_MS],
  ['GOSSIP_MIN_RUMOR_LENGTH', () => DEFAULT_MIN_RUMOR_LENGTH],
];

const KNOWN_SETTING_KEYS = new Set(SETTINGS_KEYS.map(([key]) => key));
const KNOWN_KEY_COMMENT = new RegExp(`^(?:${SETTINGS_KEYS.map(([key]) => key).join('|')})(?::.*)?$`);

function explicitEnvKeys(env) {
  const keys = new Set();
  for (const key of Object.keys(env)) {
    if (typeof env[key] === 'string' && env[key] !== '') keys.add(key);
  }
  return keys;
}

function stringifySetting(value) {
  if (value == null) return '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('non-finite number');
    return String(value);
  }
  if (typeof value === 'string') return value;
  throw new Error('non-scalar value');
}

function formatDefault(value) {
  const text = String(value);
  if (/^-?(?:0|[1-9][0-9]*)$/.test(text)) return text;
  return `'${text.replaceAll("'", "''")}'`;
}

function parseSettings(raw) {
  const doc = parseDocument(raw, { version: '1.2', schema: 'core' });
  if (doc.errors.length) throw new Error(doc.errors.map((error) => error.message).join('; '));
  if (doc.contents == null) return new Map();
  if (!isMap(doc.contents)) throw new Error('settings file must be a mapping');
  const entries = new Map();
  for (const item of doc.contents.items) {
    if (!isScalar(item.key)) throw new Error('non-scalar key');
    const key = stringifySetting(item.key.value);
    if (item.value == null) {
      entries.set(key, null);
      continue;
    }
    if (!isScalar(item.value)) throw new Error('non-scalar value');
    entries.set(key, item.value.value);
    stringifySetting(item.value.value);
  }
  return entries;
}

function applySettingEntries(entries, env, explicit) {
  const prior = { ...env };
  for (const [key, value] of entries) {
    if (!KNOWN_SETTING_KEYS.has(key) || explicit.has(key)) continue;
    const reference = typeof value === 'string' ? REFERENCE.exec(value) : null;
    if (reference) {
      if (Object.hasOwn(prior, reference[1]) && prior[reference[1]] != null) {
        env[key] = String(prior[reference[1]]);
      }
      continue;
    }
    env[key] = stringifySetting(value);
  }
}

function lineText(line) {
  if (line.endsWith('\r\n')) return line.slice(0, -2);
  if (line.endsWith('\n')) return line.slice(0, -1);
  return line;
}

function commentBody(line) {
  const match = /^\s*#(.*)$/.exec(lineText(line));
  return match ? match[1].trim() : null;
}

function lineSpans(raw) {
  const spans = [];
  let start = 0;
  for (let index = 0; index < raw.length; index += 1) {
    if (raw[index] === '\n') {
      spans.push([start, index + 1]);
      start = index + 1;
    }
  }
  if (start < raw.length) spans.push([start, raw.length]);
  return spans;
}

function missingBlock(active, env, nl) {
  const lines = ['# Missing config options'];
  for (const [key, fallback] of SETTINGS_KEYS) {
    if (active.has(key)) continue;
    const value = fallback ? fallback(env) : null;
    lines.push(value == null || value === '' ? `# ${key}:` : `# ${key}: ${formatDefault(value)}`);
  }
  return `${lines.join(nl)}${nl}`;
}

function spliceMissingBlock(raw, active, env) {
  const nl = raw.includes('\r\n') ? '\r\n' : '\n';
  const block = missingBlock(active, env, nl);
  const spans = lineSpans(raw);
  let header = -1;
  for (let index = 0; index < spans.length; index += 1) {
    const [start, end] = spans[index];
    if (commentBody(raw.slice(start, end)) === 'Missing config options') {
      header = index;
      break;
    }
  }
  if (header < 0) {
    const needsBreak = !raw.endsWith('\n');
    return `${raw}${needsBreak ? nl : ''}${block}`;
  }
  let end = header + 1;
  while (end < spans.length) {
    const line = raw.slice(spans[end][0], spans[end][1]);
    const text = commentBody(line);
    if (lineText(line).trim() === '' || (text != null && KNOWN_KEY_COMMENT.test(text))) {
      end += 1;
      continue;
    }
    break;
  }
  const start = spans[header][0];
  const stop = end < spans.length ? spans[end][0] : raw.length;
  return `${raw.slice(0, start)}${block}${raw.slice(stop)}`;
}

function settingsReadError(target, err) {
  const failure = new Error(`Cannot read settings file ${target}: ${err?.message || err}`);
  failure.code = err?.code;
  failure.cause = err;
  return failure;
}

function writeExistingSettings(target, text) {
  // Opening r+ fails before any rename when the file is not writable.
  const probe = openSync(target, 'r+');
  closeSync(probe);
  const suffix = `${process.pid}-${Date.now()}`;
  const tmp = `${target}.${suffix}.tmp`;
  const backup = `${target}.${suffix}.bak`;
  writeFileSync(tmp, text);
  try {
    renameSync(target, backup);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* temp is disposable */ }
    throw err;
  }
  try {
    renameSync(tmp, target);
  } catch (err) {
    try { renameSync(backup, target); } catch { /* backup still holds the previous bytes */ }
    try { unlinkSync(tmp); } catch { /* temp is disposable */ }
    throw err;
  }
  try { unlinkSync(backup); } catch { /* new bytes are already in place */ }
}

function maintainSettings(target, raw, active, env) {
  try {
    if (raw == null) {
      writeFileSync(target, missingBlock(active, env, '\n'), { flag: 'wx' });
      return;
    }
    const next = spliceMissingBlock(raw, active, env);
    if (next !== raw) writeExistingSettings(target, next);
  } catch {
    // a failed write is not a startup failure and leaves any previous bytes alone
  }
}

function applySettingsFile(filePath, env = process.env, explicit = explicitEnvKeys(env)) {
  const target = path.resolve(filePath || 'config.yaml');
  let raw;
  try {
    raw = readFileSync(target, 'utf8');
  } catch (err) {
    if (err?.code !== 'ENOENT') throw settingsReadError(target, err);
    maintainSettings(target, null, new Set(), env);
    return env;
  }
  let entries;
  try {
    entries = parseSettings(raw);
  } catch (err) {
    throw settingsReadError(target, err);
  }
  applySettingEntries(entries, env, explicit);
  maintainSettings(target, raw, new Set(entries.keys()), env);
  return env;
}

export function applyBaseEnv(dir, env = process.env) {
  const explicit = explicitEnvKeys(env);
  const root = path.resolve(dir || '.');
  applyDotEnv(path.join(root, '.env'), env);
  return applySettingsFile(path.join(root, 'config.yaml'), env, explicit);
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
