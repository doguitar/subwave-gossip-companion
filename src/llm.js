import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { appendLlmCall, shapeLlmCallRecord } from './callLog.js';
import { personaSoul } from './roles.js';

export const SEED_SYSTEM = readFileSync(new URL('../prompt.md', import.meta.url), 'utf8').trim();

export const DEFAULT_MODELS = {
  openai: 'gpt-4o-mini',
  google: 'gemini-2.0-flash',
  anthropic: 'claude-sonnet-4-5',
};

export const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';

function promptPersona(persona) {
  const named = `${persona.name} (${persona.id})`;
  const summary = String(persona?.rumorSummary || '').trim();
  if (summary) return `${named}\nSummary: ${summary}`;
  const soul = personaSoul(persona);
  return soul ? `${named}\nSoul: ${soul}` : named;
}

export const SOUL_SUMMARY_SYSTEM = `You compress a radio persona soul into the parts a rumor generator needs.
Return JSON only: {"summary":"<one short paragraph>"}
Keep the identity, one speech tic, physical booth habits, props they touch, and relationships that would show up in a hallway rumor.
Drop musical essays, broadcast rules, avoidances, and instructions about how to host a show.`;

export const HOUSE_RULES_SUMMARY_SYSTEM = `You compress radio-station house rules into the parts a rumor generator needs.
Return JSON only: {"summary":"<one short paragraph>"}
Keep the station setting, the audience, and the language limits that change what a hallway rumor can say.
Drop show-transition instructions, vocal-event markup, and rules about how to host a song.`;

export function houseRulesSummaryUserPrompt(houseRules) {
  return `House rules:\n${String(houseRules || '').trim() || '(no house rules)'}`;
}

export function soulSummaryUserPrompt(persona) {
  const soul = personaSoul(persona);
  return `Name: ${persona?.name || 'unknown'}\nSoul:\n${soul || '(no soul)'}`;
}

export function quotedRumorFromTidbit(tidbitText) {
  const match = String(tidbitText || '').match(/,\s*"([\s\S]*)"\s*$/);
  return match ? match[1] : '';
}

export function sessionBeatSummary() {
  return '';
}

export function seedUserPrompt({
  houseRules = '',
  day,
  roles,
  register,
}) {
  const targets = roles.targets.length
    ? `${roles.targets.map(promptPersona).join('\n')} — the rumor MUST be about them, using these exact names: ${roles.targets.map((p) => p.name).join(', ')}.`
    : '(none — station-life only; name no persona)';
  const registerBlock = register
    ? `## Rumor register for this rumor
${register.name} — ${register.guidance}
Write this rumor in that comic register only.

`
    : '';
  return `## DJ house rules
${String(houseRules || '(no house rules)').trim()}

Station day: ${day}

Teller (already chosen): ${promptPersona(roles.teller)}
Rumor-targets (already chosen): ${targets}
${registerBlock}Write one rumor in the teller's voice, about the rumor-targets when any are listed.`;
}

export function extractJsonObject(raw) {
  if (raw && typeof raw === 'object') return raw;
  const text = String(raw || '').trim();
  if (!text) throw new Error('empty LLM response');
  const candidates = [];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidates.push(fenced[1].trim());
  candidates.push(text);
  const firstBrace = text.indexOf('{');
  if (firstBrace >= 0) {
    const sliced = firstBalancedObject(text, firstBrace);
    if (sliced) candidates.push(sliced);
  }
  let lastErr;
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('LLM response was not JSON');
}

function firstBalancedObject(text, start) {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

export const REVIEW_SYSTEM = `You edit quoted hallway rumors for a fictional radio station.
Return JSON only. Each value is only the inner quoted rumor, not the "told" / "said on air" wrapper.
Make the rumor coherent. A listener must be able to follow who did what, and the result must follow from that action.
Remove non-sequiturs: a second image, a punchline, or a clause that does not follow from the cause.
Keep the same people, the same prop, and the same event. Do not add facts to fill a gap; cut the part that does not connect.
One sentence, 20 to 240 characters.
The teller's name stays out of the quote. Keep every listed rumor-target's exact display name.
Done when every clause follows from the one before it.`;

export function reviewUserPrompt({ houseRules = '', day, tidbits = [], round = 1, totalRounds = 1 }) {
  const lines = tidbits.map((t, index) => {
    const roles = t.roles;
    const targets = roles?.targets?.length
      ? roles.targets.map((p) => `${p.name} (${p.id})`).join(', ')
      : '(station-life — no persona targets)';
    const register = t.register
      ? `Register: ${t.register.name} — ${t.register.guidance}`
      : 'Register: (not recorded)';
    return `### Tidbit ${index + 1}
id: ${t.id}
Teller: ${roles?.teller?.name ?? '?'} (${roles?.teller?.id ?? '?'})
Rumor-targets: ${targets}
${register}
Current quoted rumor: ${t.quotedRumor || quotedRumorFromTidbit(t.text)}`;
  });
  return `Station day: ${day}
Review round: ${round} of ${totalRounds}

Edit every quoted rumor so it is one coherent scene. Remove non-sequiturs. Keep its facts. Do not add people, props, events, or explanations.
Return JSON shaped as { "rumors": { "<tidbit id>": "<revised quoted rumor>" } } with one entry per id.

## DJ house rules
${String(houseRules || '(no house rules)').trim()}

## Batch tidbits
${lines.join('\n\n')}`;
}

export function rumorFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return '';
  if (typeof payload.rumor === 'string') return payload.rumor;
  const first = Array.isArray(payload.items) ? payload.items[0] : null;
  if (typeof first?.rumor === 'string') return first.rumor;
  if (typeof first?.text === 'string') {
    const quoted = first.text.match(/["“]([\s\S]*)["”]\s*$/);
    return quoted ? quoted[1] : first.text;
  }
  if (typeof payload.text === 'string') return payload.text;
  return '';
}

function openaiChatUrl(baseUrl) {
  const root = String(baseUrl || DEFAULT_OPENAI_BASE_URL).replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(root)) return root;
  return `${root}/chat/completions`;
}

function normalizedThinkingLevel(thinkingLevel) {
  const value = typeof thinkingLevel === 'string' ? thinkingLevel.trim() : '';
  return value.length ? value : undefined;
}

function openaiReasoningEffort(thinkingLevel) {
  const value = normalizedThinkingLevel(thinkingLevel);
  if (!value) return undefined;
  const lowered = value.toLowerCase();
  if (lowered === 'on' || lowered === 'enabled' || lowered === 'true') return 'high';
  if (lowered === 'off' || lowered === 'false') return 'none';
  return value;
}

export const LLM_OUTPUT_BUDGET = {
  seed: 512,
  summary: 2000,
};

const REVIEW_BATCH_LIMIT = 50;
const REVIEW_OUTPUT_CAP = 8192;

export function reviewOutputBudget(tidbitCount) {
  const count = Math.min(REVIEW_BATCH_LIMIT, Math.max(1, Math.trunc(Number(tidbitCount) || 1)));
  return Math.min(REVIEW_OUTPUT_CAP, LLM_OUTPUT_BUDGET.seed + (count - 1) * 400);
}

export function buildLlmRequest({ provider, apiKey, model, openaiBaseUrl, system, user, thinkingLevel, maxTokens = LLM_OUTPUT_BUDGET.seed }) {
  const thinking = normalizedThinkingLevel(thinkingLevel);
  const outputBudget = Math.max(1, Math.trunc(Number(maxTokens) || LLM_OUTPUT_BUDGET.seed));

  if (provider === 'google') {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    const generationConfig = {
      temperature: 0.9,
      maxOutputTokens: outputBudget,
      responseMimeType: 'application/json',
      ...(thinking ? { thinkingConfig: { thinkingLevel: thinking } } : {}),
    };
    return {
      url,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: {
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig,
      },
    };
  }

  if (provider === 'anthropic') {
    return {
      url: 'https://api.anthropic.com/v1/messages',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: {
        max_tokens: outputBudget,
        temperature: 0.9,
        system,
        messages: [{ role: 'user', content: user }],
        ...(thinking ? { output_config: { effort: thinking } } : {}),
      },
    };
  }

  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const official = /api\.openai\.com/i.test(String(openaiBaseUrl || ''));
  const openaiBody = {
    model,
    max_tokens: outputBudget,
    temperature: 0.9,
    ...(official ? { response_format: { type: 'json_object' } } : {}),
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  };
  const effort = openaiReasoningEffort(thinking);
  if (effort) {
    openaiBody.reasoning_effort = effort;
    if (!official && effort !== 'none') {
      openaiBody.thinking = { type: 'enabled', level: effort };
    }
  }
  return {
    url: openaiChatUrl(openaiBaseUrl),
    headers,
    body: openaiBody,
  };
}

export function parseLlmResponse(provider, data) {
  if (data && (data.rumor || data.items || data.text)) return data;
  if (provider === 'google') {
    const parts = data?.candidates?.[0]?.content?.parts || [];
    const texts = parts.filter((p) => p.text && !p.thought).map((p) => p.text);
    let lastErr;
    for (const text of texts) {
      try {
        return extractJsonObject(text);
      } catch (err) {
        lastErr = err;
      }
    }
    try {
      return extractJsonObject(texts.join('\n'));
    } catch (err) {
      throw lastErr || err;
    }
  }
  if (provider === 'anthropic') {
    const text = (data?.content || []).filter((p) => p.type === 'text').map((p) => p.text).join('\n');
    return extractJsonObject(text || data);
  }
  const content = data?.choices?.[0]?.message?.content;
  return extractJsonObject(content ?? data);
}

const DIAGNOSTIC_VERSION = 1;
const PROVIDER_DETAIL_LIMIT = 300;

function redactProviderDetail(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return text
    .replace(/(authorization|x-api-key|x-goog-api-key)\s*[:=]\s*["']?[^,\s"'}]+/gi, '$1=[redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]+|AIza[A-Za-z0-9_-]+)/g, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, PROVIDER_DETAIL_LIMIT);
}

function usageFromResponse(provider, data) {
  const usage = provider === 'google' ? data?.usageMetadata : data?.usage;
  if (!usage || typeof usage !== 'object') return undefined;
  const inputTokens = usage.prompt_tokens ?? usage.input_tokens ?? usage.promptTokenCount;
  const outputTokens = usage.completion_tokens ?? usage.output_tokens ?? usage.candidatesTokenCount;
  const totalTokens = usage.total_tokens ?? usage.totalTokenCount;
  return {
    ...(Number.isFinite(inputTokens) ? { inputTokens } : {}),
    ...(Number.isFinite(outputTokens) ? { outputTokens } : {}),
    ...(Number.isFinite(totalTokens) ? { totalTokens } : {}),
  };
}

async function recordLlmCall(config, record) {
  if (!config.llmCallLogPath) return;
  const shaped = shapeLlmCallRecord({
    version: DIAGNOSTIC_VERSION,
    at: new Date().toISOString(),
    ...record,
  }, config.llmLogContent || 'metadata');
  if (!shaped) return;
  await appendLlmCall(config.llmCallLogPath, shaped);
}

function outputTruncated(provider, data) {
  if (provider === 'anthropic') return data?.stop_reason === 'max_tokens';
  if (provider === 'google') return data?.candidates?.[0]?.finishReason === 'MAX_TOKENS';
  return data?.choices?.[0]?.finish_reason === 'length';
}

function throwIfLlmAborted(signal) {
  if (!signal?.aborted) return;
  const shutdown = signal.reason === 'shutdown' || signal.reason?.reason === 'shutdown';
  throw Object.assign(
    new Error(shutdown ? 'shutting down' : 'gossip generation aborted'),
    { name: 'AbortError', ...(shutdown ? { reason: 'shutdown', status: 503 } : {}) },
  );
}

async function invokeLlm({ config, kind, provider, model, request, fetchImpl, lifecycleId, retry = 0, signal }) {
  const invocationId = randomUUID();
  const startedAt = Date.now();
  const base = { lifecycleId, invocationId, kind, provider, model, retry };
  await recordLlmCall(config, { ...base, stage: 'start' });
  let res;
  try {
    throwIfLlmAborted(signal);
    res = await fetchImpl(request.url, {
      method: 'POST',
      headers: request.headers,
      body: JSON.stringify(request.body),
      ...(signal ? { signal } : {}),
    });
  } catch (err) {
    await recordLlmCall(config, {
      ...base, stage: 'transport-failure', elapsedMs: Date.now() - startedAt,
      detail: redactProviderDetail(err?.message),
    });
    throw err;
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    await recordLlmCall(config, {
      ...base, stage: 'http-failure', elapsedMs: Date.now() - startedAt,
      status: res.status, detail: redactProviderDetail(detail),
    });
    const error = new Error(`LLM ${kind} request failed: HTTP ${res.status}${detail ? ` ${redactProviderDetail(detail)}` : ''}`);
    error.status = res.status;
    throw error;
  }
  let data;
  try {
    data = await res.json();
    if (kind === 'review' && outputTruncated(provider, data)) {
      throw new Error('LLM review output truncated');
    }
    const payload = parseLlmResponse(provider, data);
    await recordLlmCall(config, {
      ...base, stage: 'success', elapsedMs: Date.now() - startedAt, status: res.status,
      usage: usageFromResponse(provider, data),
    });
    return payload;
  } catch (err) {
    await recordLlmCall(config, {
      ...base, stage: 'parse-failure', elapsedMs: Date.now() - startedAt,
      status: res.status, detail: redactProviderDetail(err?.message),
    });
    throw err;
  }
}

export async function preflightProvider({ config, fetchImpl = fetch, log }) {
  const provider = config.llmProvider || 'openai';
  const model = String(config.llmModel || DEFAULT_MODELS[provider] || '').trim();
  if (!model) throw Object.assign(new Error('LLM model is required'), { code: 'CONFIG' });
  const apiKey = config.llmApiKey;
  const openaiBaseUrl = config.openaiBaseUrl || config.llmUrl || DEFAULT_OPENAI_BASE_URL;
  const localOpenAI = provider === 'openai' && !/api\.openai\.com/i.test(openaiBaseUrl);
  if (!apiKey && !localOpenAI) throw Object.assign(new Error('PROVIDER_KEY (or GOSSIP_LLM_API_KEY) is required'), { code: 'CONFIG' });
  if (provider === 'anthropic' || localOpenAI) {
    log?.info?.(`[gossip] LLM preflight provider=${provider} model=${model} capability=unsupported`);
    return { provider, model, capability: 'unsupported' };
  }
  const url = provider === 'google'
    ? `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}`
    : `${String(openaiBaseUrl).replace(/\/+$/, '')}/models/${encodeURIComponent(model)}`;
  const headers = provider === 'google'
    ? { 'x-goog-api-key': apiKey }
    : { Authorization: `Bearer ${apiKey}` };
  let response;
  try {
    response = await fetchImpl(url, { headers });
  } catch (err) {
    throw Object.assign(new Error(`LLM preflight failed: ${redactProviderDetail(err?.message)}`), { cause: err });
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw Object.assign(new Error(`LLM preflight failed: HTTP ${response.status}${detail ? ` ${redactProviderDetail(detail)}` : ''}`), { status: response.status });
  }
  log?.info?.(`[gossip] LLM preflight provider=${provider} model=${model} capability=validated`);
  return { provider, model, capability: 'validated' };
}

export async function summarizePersonaSouls({
  config,
  personas = [],
  fetchImpl = fetch,
  log,
  signal,
}) {
  const provider = config.llmProvider || 'openai';
  const apiKey = config.llmApiKey;
  const model = config.llmModel || DEFAULT_MODELS[provider] || DEFAULT_MODELS.openai;
  const openaiBaseUrl = config.openaiBaseUrl || config.llmUrl || DEFAULT_OPENAI_BASE_URL;
  const localOpenAI = provider === 'openai' && !/api\.openai\.com/i.test(openaiBaseUrl);
  if (!apiKey && !localOpenAI) {
    throw Object.assign(new Error('PROVIDER_KEY (or GOSSIP_LLM_API_KEY) is required to summarize souls'), { code: 'CONFIG' });
  }
  const summaries = [];
  for (const persona of personas) {
    throwIfLlmAborted(signal);
    log?.info?.(`[gossip] soul summary starting name=${persona?.name || persona?.id}`);
    const request = buildLlmRequest({
      provider,
      apiKey,
      model,
      openaiBaseUrl,
      system: SOUL_SUMMARY_SYSTEM,
      user: soulSummaryUserPrompt(persona),
      thinkingLevel: config.llmThinkingLevel,
      maxTokens: LLM_OUTPUT_BUDGET.summary,
    });
    const payload = await invokeLlm({
      config, kind: 'soul-summary', provider, model, request, fetchImpl,
      lifecycleId: `soul-summary:${persona?.id || persona?.name || randomUUID()}`,
      signal,
    });
    const summary = String(payload?.summary || '').trim();
    if (!summary) throw new Error(`LLM soul summary for ${persona?.name || persona?.id} was empty`);
    summaries.push({ id: persona.id, name: persona.name, summary });
  }
  return summaries;
}

export async function summarizeHouseRules({
  config,
  houseRules = '',
  fetchImpl = fetch,
  log,
  signal,
}) {
  const text = String(houseRules || '').trim();
  if (!text) return '';
  const provider = config.llmProvider || 'openai';
  const apiKey = config.llmApiKey;
  const model = config.llmModel || DEFAULT_MODELS[provider] || DEFAULT_MODELS.openai;
  const openaiBaseUrl = config.openaiBaseUrl || config.llmUrl || DEFAULT_OPENAI_BASE_URL;
  const localOpenAI = provider === 'openai' && !/api\.openai\.com/i.test(openaiBaseUrl);
  if (!apiKey && !localOpenAI) {
    throw Object.assign(new Error('PROVIDER_KEY (or GOSSIP_LLM_API_KEY) is required to summarize house rules'), { code: 'CONFIG' });
  }
  log?.info?.('[gossip] house rules summary starting');
  const request = buildLlmRequest({
    provider,
    apiKey,
    model,
    openaiBaseUrl,
    system: HOUSE_RULES_SUMMARY_SYSTEM,
    user: houseRulesSummaryUserPrompt(text),
    thinkingLevel: config.llmThinkingLevel,
    maxTokens: LLM_OUTPUT_BUDGET.summary,
  });
  throwIfLlmAborted(signal);
  const payload = await invokeLlm({
    config, kind: 'house-rules-summary', provider, model, request, fetchImpl,
    lifecycleId: 'house-rules-summary',
    signal,
  });
  const summary = String(payload?.summary || '').trim();
  if (!summary) throw new Error('LLM house rules summary was empty');
  return summary;
}

export async function generateSeed({
  config,
  houseRules,
  day,
  roles,
  register,
  existing = [],
  sessionTidbits = [],
  lifecycleId,
  fetchImpl = fetch,
  log,
  signal,
}) {
  const systemPrompt = config.systemPrompt || SEED_SYSTEM;

  const provider = config.llmProvider || 'openai';
  const apiKey = config.llmApiKey;
  const model = config.llmModel || DEFAULT_MODELS[provider] || DEFAULT_MODELS.openai;
  const openaiBaseUrl = config.openaiBaseUrl || config.llmUrl || DEFAULT_OPENAI_BASE_URL;
  const localOpenAI = provider === 'openai' && !/api\.openai\.com/i.test(openaiBaseUrl);
  if (!apiKey && !localOpenAI) {
    throw Object.assign(new Error('PROVIDER_KEY (or GOSSIP_LLM_API_KEY) is required to generate gossip'), { code: 'CONFIG' });
  }

  const user = seedUserPrompt({
    houseRules,
    day,
    roles,
    register,
    existing,
    sessionTidbits,
  });
  log?.info?.(
    `[gossip] LLM seed call starting provider=${provider} model=${model} day=${day} register=${register?.id ?? 'none'}`,
  );
  const request = buildLlmRequest({
    provider,
    apiKey,
    model,
    openaiBaseUrl,
    system: systemPrompt,
    user,
    thinkingLevel: config.llmThinkingLevel,
    maxTokens: LLM_OUTPUT_BUDGET.seed,
  });
  throwIfLlmAborted(signal);
  return invokeLlm({
    config, kind: 'seed', provider, model, request, fetchImpl,
    lifecycleId: lifecycleId || `seed:${day}:${roles?.teller?.id || 'unknown'}`,
    signal,
  });
}

export async function generateReview({
  config,
  houseRules,
  day,
  tidbits,
  round,
  totalRounds,
  lifecycleId,
  fetchImpl = fetch,
  log,
  signal,
}) {
  const systemPrompt = REVIEW_SYSTEM;
  const provider = config.llmProvider || 'openai';
  const apiKey = config.llmApiKey;
  const model = config.llmModel || DEFAULT_MODELS[provider] || DEFAULT_MODELS.openai;
  const openaiBaseUrl = config.openaiBaseUrl || config.llmUrl || DEFAULT_OPENAI_BASE_URL;
  const localOpenAI = provider === 'openai' && !/api\.openai\.com/i.test(openaiBaseUrl);
  if (!apiKey && !localOpenAI) {
    throw Object.assign(new Error('PROVIDER_KEY (or GOSSIP_LLM_API_KEY) is required to review gossip'), { code: 'CONFIG' });
  }

  const user = reviewUserPrompt({
    houseRules,
    day,
    tidbits,
    round,
    totalRounds,
  });
  log?.info?.(
    `[gossip] LLM review call starting provider=${provider} model=${model} day=${day} round=${round}/${totalRounds} tidbits=${tidbits.length}`,
  );
  const request = buildLlmRequest({
    provider,
    apiKey,
    model,
    openaiBaseUrl,
    system: systemPrompt,
    user,
    thinkingLevel: config.llmThinkingLevel,
    maxTokens: reviewOutputBudget(tidbits?.length),
  });
  throwIfLlmAborted(signal);
  return invokeLlm({
    config, kind: 'review', provider, model, request, fetchImpl,
    lifecycleId: lifecycleId || `review:${day}:${round}`,
    signal,
  });
}
