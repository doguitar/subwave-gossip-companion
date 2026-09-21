import { readFile } from 'node:fs/promises';
import { appendLlmCall } from './callLog.js';
import { joinNames, personaSoul } from './roles.js';

export const SEED_SYSTEM = `You invent one fictional radio-station rumor for a corkboard.

The teller, hearers, and rumor-targets are already chosen. You write ONLY the quoted rumor. Do not assign people. Do not write the wrapper sentence.

## Output
Return JSON only. No markdown.
{"rumor":"string"}

## Rumor
- Never use placeholder values such as "string", "text", "rumor", or "example".
- Do not reason aloud or emit analysis; return only the JSON object.
- No length restriction. Preserve the model's complete rumor text.
- Make it funny: use a sharp, specific, in-character comic beat rather than generic silliness.
- Adult themes are allowed, including bawdy humor, innuendo, flirtation, and embarrassing grown-up situations.
- Do not write "told" or "said on air". That wrapper is added after you.

## Targets
- If rumor-targets are listed, the rumor is ABOUT those people. Use their exact display names in the rumor.
- Write the rumor in a way that fits their souls (voice, habits, obsessions) and the teller's soul (how they would phrase a scrap of hallway talk).
- If there are no rumor-targets, the rumor is about station-life, not a person. Do not name any persona.`;

export const DEFAULT_MODELS = {
  openai: 'gpt-4o-mini',
  google: 'gemini-2.0-flash',
  anthropic: 'claude-sonnet-4-5',
};

export const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';

export function formatSouls(personas) {
  return (personas || []).map((p) => {
    const soul = personaSoul(p);
    return `### ${p.name} (${p.id})\n${soul || '(no soul on file — use the name and station role only)'}`;
  }).join('\n\n');
}
export function seedUserPrompt({ personas, day, roles, existing = [], previousTidbit = '' }) {
  const hearers = roles.hearers.length
    ? roles.hearers.map((p) => `${p.name} (${p.id})`).join(', ')
    : '(none — this rumor is said on air by the teller; everyone at the station hears it)';
  const targets = roles.targets.length
    ? `${joinNames(roles.targets.map((p) => p.name))} — the rumor MUST be about them, using these exact names: ${roles.targets.map((p) => p.name).join(', ')}`
    : '(none — rumor is about station-life, not a person; do not name a persona)';
  const avoid = existing.length ? existing.map((t) => `- ${t}`).join('\n') : '(none)';
  const evolution = previousTidbit
    ? `\n## Telephone-chain source\nThis is the immediately preceding telling:\n${previousTidbit}\nRetell this same rumor in a plausible telephone-game mutation. Preserve its core subject and thread, but introduce one believable distortion or embellishment. Do not start a new unrelated rumor.\n`
    : '';
  return `Station day: ${day}

Teller (already chosen): ${roles.teller.name} (${roles.teller.id})
Hearers (already chosen): ${hearers}
Rumor-targets (already chosen): ${targets}
${evolution}
Write one rumor in the teller's voice, about the rumor-targets when any are listed.

## Station souls
${formatSouls(personas) || '(no personas)'}

Do not retell:
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

  return {
    url: openaiChatUrl(openaiBaseUrl),
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: {
      model,
      temperature: 0.9,
      response_format: { type: 'json_object' },
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
  personas,
  day,
  roles,
  existing = [],
  previousTidbit = '',
  fetchImpl = fetch,
  log,
}) {
  if (config.llmFixturePath) {
    const raw = await readFile(config.llmFixturePath, 'utf8');
    return JSON.parse(raw);
  }
  const systemPrompt = config.systemPrompt || SEED_SYSTEM;

  const provider = config.llmProvider || 'openai';
  const apiKey = config.llmApiKey;
  const model = config.llmModel || DEFAULT_MODELS[provider] || DEFAULT_MODELS.openai;
  if (!apiKey) {
    throw Object.assign(new Error('PROVIDER_KEY (or GOSSIP_LLM_API_KEY) is required to generate gossip'), { code: 'CONFIG' });
  }

  const user = seedUserPrompt({ personas, day, roles, existing, previousTidbit });
  log?.info?.(`[gossip] LLM prompt system:\n${systemPrompt}\n[gossip] LLM prompt user:\n${user}`);
  const request = buildLlmRequest({
    provider,
    apiKey,
    model,
    openaiBaseUrl: config.openaiBaseUrl || config.llmUrl || DEFAULT_OPENAI_BASE_URL,
    system: systemPrompt,
    user,
  });
  const res = await fetchImpl(request.url, {
    method: 'POST',
    headers: request.headers,
    body: JSON.stringify(request.body),
  });
  if (!res.ok) throw new Error(`LLM seed request failed: HTTP ${res.status}`);
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
