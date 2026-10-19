const SENSITIVE = /\b(ssn|social security|home address|passport|credit card)\b|\b\d{3}-\d{2}-\d{4}\b|\b\d{3}[-.]?\d{3}[-.]?\d{4}\b|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

/** Pivot phrases that start a distinct second narrative beat (not stunt + immediate target reaction). */
function hasSecondBeat(text) {
  if (/\band (?:now|get this)\b/i.test(text)) return true;
  if (/\bget this[,:]/i.test(text)) return true;
  return false;
}

export function parseToldShape(text) {
  const m = String(text || '').trim().match(/^(.+?) (?:told|said on air)(?: (.+?))?, "([\s\S]*)"$/);
  if (!m) return null;
  return { tellerName: m[1].trim(), hearerName: (m[2] || '').trim(), rumor: m[3] };
}

export const STUNT_MOTIF_ATTACHED_SIGNAGE = 'attached-signage';
export const STUNT_MOTIF_OTHER = 'other';

/** Labels, signs, stickers, kapu tags, and notes taped onto gear — not taping unrelated objects. */
const ATTACHED_SIGNAGE_PATTERNS = [
  /\b(?:sticker|stickers|label|labels)\b/i,
  /\bkapu\s+tag\b/i,
  /\bcompliance\s+(?:sticker|plaque|sign)\b/i,
  /\blaminated\b/i,
  /\b(?:fake|forged|phony|inspection)\s+sticker\b/i,
  /\bduct[- ]?tape[d]?\s+(?:note|sign|label|sticker|tag)\b/i,
  /\btaped\s+(?:a\s+)?(?:note|sign|label|sticker|tag|warning|plaque)\b/i,
  /\b(?:passive[- ]aggressive|sticky)\s+note\b/i,
  /\bwelded\b.*\b(?:sticker|tag|sign|plaque|label)\b/i,
  /\b(?:slap(?:ped)?|stuck|affix(?:ed)?|post(?:ed)?)\b[^.]{0,40}\b(?:label|sign|sticker|note)\b/i,
  /\b(?:sign|signs)\s+(?:on|onto|over|to)\b/i,
];

function isAttachedSignageMotif(text) {
  return ATTACHED_SIGNAGE_PATTERNS.some((pattern) => pattern.test(text));
}

export function classifyStuntMotif(rumorText) {
  const text = String(rumorText || '').trim();
  if (!text) return STUNT_MOTIF_OTHER;
  return isAttachedSignageMotif(text) ? STUNT_MOTIF_ATTACHED_SIGNAGE : STUNT_MOTIF_OTHER;
}

export function rumorQuoteFromWrapped(text) {
  const parsed = parseToldShape(String(text || '').trim());
  return parsed?.rumor ?? String(text || '').trim();
}

export function validateRumor(rumor, { targets = [], minLength = 20, maxLength = 240, sessionRumors = [] } = {}) {
  const text = String(rumor || '').trim();
  if (/^(?:string|text|rumor|example)$/i.test(text)) return { ok: false, reason: 'placeholder-text' };
  if (text.length < minLength) return { ok: false, reason: 'too-short' };
  if (text.length > maxLength) return { ok: false, reason: 'too-long' };
  if (hasSecondBeat(text)) return { ok: false, reason: 'second-beat' };
  for (const target of targets) {
    if (target?.name && !text.toLowerCase().includes(String(target.name).toLowerCase())) {
      return { ok: false, reason: 'missing-target-name' };
    }
  }
  if (classifyStuntMotif(text) === STUNT_MOTIF_ATTACHED_SIGNAGE) {
    for (const prior of sessionRumors) {
      if (classifyStuntMotif(prior) === STUNT_MOTIF_ATTACHED_SIGNAGE) {
        return { ok: false, reason: 'duplicate-stunt-motif' };
      }
    }
  }
  return { ok: true };
}

export function validateSeedPayload(payload, {
  personaIds,
  personas = [],
  existingTexts,
  cap,
  requireToldShape = false,
}) {
  const accepted = [];
  const rejected = [];
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.items)) {
    return { accepted: [], rejected: [{ reason: 'invalid-shape' }] };
  }

  const known = new Set(personaIds);
  const byId = new Map((personas || []).map((p) => [p.id, p]));
  const seenText = new Set(existingTexts);

  for (const raw of payload.items) {
    const result = validateItem(raw, {
      known,
      byId,
      seenText,
      remaining: cap - accepted.length,
      requireToldShape,
    });
    if (result.ok) {
      accepted.push(result.item);
      seenText.add(result.item.text);
    } else {
      rejected.push({ item: raw, reason: result.reason });
    }
  }
  return { accepted, rejected };
}

function validateItem(raw, { known, byId, seenText, remaining, requireToldShape }) {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'invalid-item' };
  const text = typeof raw.text === 'string' ? raw.text.trim() : '';
  if (!text) return { ok: false, reason: 'empty-text' };
  if (seenText.has(text)) return { ok: false, reason: 'duplicate-text' };
  if (SENSITIVE.test(text)) return { ok: false, reason: 'sensitive' };

  const tellerPersonaId = typeof raw.tellerPersonaId === 'string' ? raw.tellerPersonaId.trim() : '';
  if (!tellerPersonaId) return { ok: false, reason: 'missing-teller' };
  if (!known.has(tellerPersonaId)) return { ok: false, reason: 'unknown-teller' };

  if (raw.hearerPersonaIds === null) {
    if (remaining <= 0) return { ok: false, reason: 'over-cap' };
    return { ok: true, item: { text, tellerPersonaId, hearerPersonaIds: null } };
  }

  if (!Array.isArray(raw.hearerPersonaIds)) return { ok: false, reason: 'invalid-hearers' };
  const hearerPersonaIds = [];
  const seenHearer = new Set();
  for (const hid of raw.hearerPersonaIds) {
    if (typeof hid !== 'string' || !hid.trim()) return { ok: false, reason: 'invalid-hearer' };
    const id = hid.trim();
    if (!known.has(id)) return { ok: false, reason: 'unknown-hearer' };
    if (id === tellerPersonaId) return { ok: false, reason: 'self-hearer' };
    if (seenHearer.has(id)) return { ok: false, reason: 'inconsistent-relationship' };
    seenHearer.add(id);
    hearerPersonaIds.push(id);
  }

  if (requireToldShape) {
    const told = parseToldShape(text);
    if (!told) return { ok: false, reason: 'bad-told-shape' };
    const teller = byId.get(tellerPersonaId);
    if (!told.rumor.trim()) return { ok: false, reason: 'empty-text' };
  }

  if (remaining <= 0) return { ok: false, reason: 'over-cap' };
  return { ok: true, item: { text, tellerPersonaId, hearerPersonaIds } };
}
