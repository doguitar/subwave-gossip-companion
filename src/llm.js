import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { appendLlmCall } from './callLog.js';
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
  previousTidbit = '',
}) {
  const targets = roles.targets.length
    ? `${roles.targets.map(promptPersona).join('\n')} — the rumor MUST be about them, using these exact names: ${roles.targets.map((p) => p.name).join(', ')}.`
    : '(none — station-life only; name no persona)';
  const evolution = previousTidbit
    ? `\n## Telephone-chain source\nPreceding telling:\n${previousTidbit}\nRetell this same rumor as one telephone-game step: keep its core subject and thread, and add one believable distortion or embellishment.\n`
    : '';
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
${evolution}${registerBlock}Write one rumor in the teller's voice, about the rumor-targets when any are listed.`;
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

export function buildLlmRequest({ provider, apiKey, model, openaiBaseUrl, system, user, thinkingLevel }) {
  const thinking = normalizedThinkingLevel(thinkingLevel);

  if (provider === 'google') {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    const generationConfig = {
      temperature: 0.9,
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
        max_tokens: 512,
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

async function recordLlmCall(config, { kind, provider, model, request, prompt, response }) {
  await appendLlmCall(config.llmCallLogPath, {
    at: new Date().toISOString(),
    kind,
    provider,
    model,
    url: request.url,
    request: {
      headers: {
        ...request.headers,
        'x-goog-api-key': request.headers['x-goog-api-key'] ? '[redacted]' : undefined,
        Authorization: request.headers.Authorization ? '[redacted]' : undefined,
        'x-api-key': request.headers['x-api-key'] ? '[redacted]' : undefined,
      },
      body: request.body,
    },
    prompt,
    response,
  });
}

export async function summarizePersonaSouls({
  config,
  personas = [],
  fetchImpl = fetch,
  log,
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
    log?.info?.(`[gossip] soul summary starting name=${persona?.name || persona?.id}`);
    const request = buildLlmRequest({
      provider,
      apiKey,
      model,
      openaiBaseUrl,
      system: SOUL_SUMMARY_SYSTEM,
      user: soulSummaryUserPrompt(persona),
      thinkingLevel: config.llmThinkingLevel,
    });
    if (request.body && provider === 'openai') request.body.max_tokens = 2000;
    const res = await fetchImpl(request.url, {
      method: 'POST',
      headers: request.headers,
      body: JSON.stringify(request.body),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      const error = new Error(`LLM soul summary failed: HTTP ${res.status}${detail ? ` ${detail.slice(0, 300)}` : ''}`);
      error.status = res.status;
      throw error;
    }
    const data = await res.json();
    await recordLlmCall(config, {
      kind: 'soul-summary',
      provider,
      model,
      request,
      prompt: { system: SOUL_SUMMARY_SYSTEM, user: soulSummaryUserPrompt(persona) },
      response: data,
    });
    const payload = parseLlmResponse(provider, data);
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
  });
  if (request.body && provider === 'openai') request.body.max_tokens = 2000;
  const res = await fetchImpl(request.url, {
    method: 'POST',
    headers: request.headers,
    body: JSON.stringify(request.body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    const error = new Error(`LLM house rules summary failed: HTTP ${res.status}${detail ? ` ${detail.slice(0, 300)}` : ''}`);
    error.status = res.status;
    throw error;
  }
  const data = await res.json();
  await recordLlmCall(config, {
    kind: 'house-rules-summary',
    provider,
    model,
    request,
    prompt: { system: HOUSE_RULES_SUMMARY_SYSTEM, user: houseRulesSummaryUserPrompt(text) },
    response: data,
  });
  const payload = parseLlmResponse(provider, data);
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
  previousTidbit = '',
  fetchImpl = fetch,
  log,
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
    previousTidbit,
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
  });
  const res = await fetchImpl(request.url, {
    method: 'POST',
    headers: request.headers,
    body: JSON.stringify(request.body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    const error = new Error(`LLM seed request failed: HTTP ${res.status}${detail ? ` ${detail.slice(0, 300)}` : ''}`);
    error.status = res.status;
    throw error;
  }
  const data = await res.json();
  await recordLlmCall(config, {
    kind: 'seed',
    provider,
    model,
    request,
    prompt: { system: systemPrompt, user },
    response: data,
  });
  return parseLlmResponse(provider, data);
}

export async function generateReview({
  config,
  houseRules,
  day,
  tidbits,
  round,
  totalRounds,
  fetchImpl = fetch,
  log,
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
  });
  const res = await fetchImpl(request.url, {
    method: 'POST',
    headers: request.headers,
    body: JSON.stringify(request.body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    const error = new Error(`LLM review request failed: HTTP ${res.status}${detail ? ` ${detail.slice(0, 300)}` : ''}`);
    error.status = res.status;
    throw error;
  }
  const data = await res.json();
  await recordLlmCall(config, {
    kind: 'review',
    provider,
    model,
    request,
    prompt: { system: systemPrompt, user },
    response: data,
  });
  return parseLlmResponse(provider, data);
}
