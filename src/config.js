import { readFileSync } from 'node:fs';

import path from 'node:path';

const DEFAULT_PORT = 8080;
const DEFAULT_SEED_CAP = 5;
const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MODELS = {
  openai: 'gpt-4o-mini',
  google: 'gemini-2.0-flash',
  anthropic: 'claude-sonnet-4-5',
};

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

  const host = (env.GOSSIP_HOST || '0.0.0.0').trim();
  const statePath = resolveBase(env.GOSSIP_STATE_PATH, path.join('data', 'gossip-state.json'));
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
  const openaiBaseUrl = (
    env.OPENAI_BASE_URL
    || env.GOSSIP_LLM_URL
    || DEFAULT_OPENAI_BASE_URL
  ).trim().replace(/\/+$/, '');
  const llmUrl = openaiBaseUrl;
  const llmFixturePath = env.GOSSIP_LLM_FIXTURE ? resolveBase(env.GOSSIP_LLM_FIXTURE, '') : '';
  const llmCallLogPath = resolveBase(env.GOSSIP_LLM_CALL_LOG, path.join('logs', 'llm-calls.jsonl'));
  const promptPath = resolveBase(env.GOSSIP_PROMPT_PATH, 'prompt.md');
  let systemPrompt = '';
  try {
    systemPrompt = readFileSync(promptPath, 'utf8').trim();
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const refreshCountRaw = env.GOSSIP_REFRESH_COUNT ?? '1';
  const refreshCount = Number(refreshCountRaw);
  if (!Number.isInteger(refreshCount) || refreshCount < 1 || refreshCount > 10) {
    errors.push('GOSSIP_REFRESH_COUNT must be an integer 1-10');
  }
  const ttsTimeoutMs = Number(env.GOSSIP_TTS_TIMEOUT_MS ?? String(5 * 60 * 1000));
  const ttsPollMs = Number(env.GOSSIP_TTS_POLL_MS ?? '3000');
  const config = {
    baseDir,
    promptPath,
    systemPrompt,
    apiUrl,
    apiUser,
    apiPassword,
    apiToken,
    host,
    port,
    seedCap,
    statePath,
    feedBaseUrl,
    timezone,
    llmProvider,
    llmApiKey,
    llmModel,
    openaiBaseUrl,
    llmUrl,
    llmFixturePath,
    llmCallLogPath,
    refreshCount: Number.isInteger(refreshCount) ? refreshCount : 1,
    ttsTimeoutMs: Number.isFinite(ttsTimeoutMs) && ttsTimeoutMs > 0 ? ttsTimeoutMs : 5 * 60 * 1000,
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
