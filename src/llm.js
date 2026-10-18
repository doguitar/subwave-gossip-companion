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

function withSoul(persona) {
  const soul = personaSoul(persona);
  const named = `${persona.name} (${persona.id})`;
  return soul ? `${named}\nSoul: ${soul}` : named;
}

export function seedUserPrompt({ houseRules = '', day, roles, register, existing = [], previousTidbit = '' }) {
  const hearers = roles.hearers.length
    ? roles.hearers.map(withSoul).join('\n')
    : '(none — this rumor is said on air by the teller; everyone at the station hears it)';
  const sharedBeat =
    roles.targets.length === 2
      ? ' The rumor MUST be one shared beat: both targets\' actions belong to the same moment (interaction, shared place, or clear cause-and-effect), not parallel unrelated vignettes.'
      : '';
  const targets = roles.targets.length
    ? `${roles.targets.map(withSoul).join('\n')} — the rumor MUST be about them, using these exact names: ${roles.targets.map((p) => p.name).join(', ')}.${sharedBeat}`
    : '(none — station-life only; name no persona)';
  const avoid = existing.length ? existing.map((t) => `- ${t}`).join('\n') : '(none)';
  const evolution = previousTidbit
    ? `\n## Telephone-chain source\nPreceding telling:\n${previousTidbit}\nRetell this same rumor as one telephone-game step: keep its core subject and thread, and add one believable distortion or embellishment.\n`
    : '';
  const registerBlock = register
    ? `## Rumor register for this rumor
${register.name} — ${register.guidance}
Write this rumor in that comic register only.

`
    : '';
  return `Station day: ${day}

Teller (already chosen): ${withSoul(roles.teller)}
Hearers (already chosen): ${hearers}
Rumor-targets (already chosen): ${targets}
${evolution}${registerBlock}Write one rumor in the teller's voice, about the rumor-targets when any are listed.

## DJ house rules
${String(houseRules || '(no house rules)').trim()}

Write a rumor whose subject, people, and comic beat are all new beside these:
${avoid}`;
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

export function buildLlmRequest({ provider, apiKey, model, openaiBaseUrl, system, user }) {
  if (provider === 'google') {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
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
        generationConfig: {
          temperature: 0.9,
          responseMimeType: 'application/json',
        },
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
      },
    };
  }

  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const official = /api\.openai\.com/i.test(String(openaiBaseUrl || ''));
  return {
    url: openaiChatUrl(openaiBaseUrl),
    headers,
    body: {
      model,
      temperature: 0.9,
      ...(official ? { response_format: { type: 'json_object' } } : {}),
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    },
  };
}

export function parseLlmResponse(provider, data) {
  if (data && (data.rumor || data.items || data.text)) return data;
  if (provider === 'google') {
    const parts = data?.candidates?.[0]?.content?.parts || [];
    const texts = parts.map((p) => p.text).filter(Boolean);
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

export async function generateSeed({
  config,
  houseRules,
  day,
  roles,
  register,
  existing = [],
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

  const user = seedUserPrompt({ houseRules, day, roles, register, existing, previousTidbit });
  log?.info?.(`[gossip] LLM prompt system:\n${systemPrompt}\n[gossip] LLM prompt user:\n${user}`);
  const request = buildLlmRequest({
    provider,
    apiKey,
    model,
    openaiBaseUrl,
    system: systemPrompt,
    user,
  });
  const res = await fetchImpl(request.url, {
    method: 'POST',
    headers: request.headers,
    body: JSON.stringify(request.body),
  });
  if (!res.ok) {
    const error = new Error(`LLM seed request failed: HTTP ${res.status}`);
    error.status = res.status;
    throw error;
  }
  const data = await res.json();
  await appendLlmCall(config.llmCallLogPath, {
    at: new Date().toISOString(),
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
    prompt: { system: systemPrompt, user },
    response: data,
  });
  return parseLlmResponse(provider, data);
}
