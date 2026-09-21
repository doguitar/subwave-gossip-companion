const SENSITIVE = /\b(ssn|social security|home address|passport|credit card)\b|\b\d{3}-\d{2}-\d{4}\b|\b\d{3}[-.]?\d{3}[-.]?\d{4}\b|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

export function parseToldShape(text) {
  const m = String(text || '').trim().match(/^(.+?) (?:told|said on air)(?: (.+?))?, "([\s\S]*)"$/);
  if (!m) return null;
  return { tellerName: m[1].trim(), hearerName: (m[2] || '').trim(), rumor: m[3] };
}

export function validateRumor(rumor, { targets = [], minLength = 20 } = {}) {
  const text = String(rumor || '').trim();
  if (/^(?:string|text|rumor|example)$/i.test(text)) return { ok: false, reason: 'placeholder-text' };
  if (text.length < minLength) return { ok: false, reason: 'too-short' };
  for (const target of targets) {
    if (target?.name && !text.toLowerCase().includes(String(target.name).toLowerCase())) {
      return { ok: false, reason: 'missing-target-name' };
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
