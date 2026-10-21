const SENSITIVE = /\b(ssn|social security|home address|passport|credit card)\b|\b\d{3}-\d{2}-\d{4}\b|\b\d{3}[-.]?\d{3}[-.]?\d{4}\b|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

/** Pivot phrases that start a distinct second narrative beat (not stunt + immediate target reaction). */
function hasSecondBeat(text) {
  if (/(?:^|[.!?]\s+)now\b/i.test(text)) return true;
  if (/\band (?:now|get this)\b/i.test(text)) return true;
  if (/\bget this[,:]/i.test(text)) return true;
  if (/[,:;]\s*now\b/i.test(text)) return true;
  return false;
}

function normalizedName(persona) {
  return String(persona?.name || '').trim().toLowerCase();
}

function mentionsName(text, name) {
  const escaped = String(name).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`, 'iu').test(text);
}

export function parseToldShape(text) {
  const m = String(text || '').trim().match(/^(.+?) (?:told|said on air)(?: (.+?))?, "([\s\S]*)"$/);
  if (!m) return null;
  return { tellerName: m[1].trim(), hearerName: (m[2] || '').trim(), rumor: m[3] };
}

export function retellableRumor(text) {
  let rumor = String(text || '').trim();
  let told = parseToldShape(rumor);
  while (told && told.rumor.trim() !== rumor) {
    rumor = told.rumor.trim();
    told = parseToldShape(rumor);
  }
  return rumor;
}

export function validateRumor(rumor, { targets = [], minLength = 20, maxLength = 240 } = {}) {
  const text = String(rumor || '').trim();
  if (SENSITIVE.test(text)) return { ok: false, reason: 'sensitive' };
  if (/^(?:string|text|rumor|example)$/i.test(text)) return { ok: false, reason: 'placeholder-text' };
  if (text.length < minLength) return { ok: false, reason: 'too-short' };
  if (text.length > maxLength) return { ok: false, reason: 'too-long' };
  if (hasSecondBeat(text)) return { ok: false, reason: 'second-beat' };
  for (const target of targets) {
    if (target?.name && !mentionsName(text, target.name)) {
      return { ok: false, reason: 'missing-target-name' };
    }
  }
  return { ok: true };
}

export function validateReviewRumor(rumor, {
  roles,
  register,
  minLength = 20,
  maxLength = 240,
} = {}) {
  if (!roles?.teller || !Array.isArray(roles.hearers) || !Array.isArray(roles.targets) || !register) {
    return { ok: false, reason: 'missing-canonical-roles' };
  }
  const excluded = new Set([normalizedName(roles.teller), ...roles.hearers.map(normalizedName)]);
  const targets = roles.targets.filter((target) => target?.id && normalizedName(target) && !excluded.has(normalizedName(target)));
  if (targets.length !== roles.targets.length) return { ok: false, reason: 'invalid-canonical-target' };

  const check = validateRumor(rumor, { targets, minLength, maxLength });
  if (!check.ok) return check;

  const text = String(rumor).trim();
  if (/\b(?:i|we)\s+(?:walked|was walking|saw|heard|watched|caught|found|noticed)\b/i.test(text)) {
    return { ok: false, reason: 'generic-eyewitness-pov' };
  }
  return { ok: true };
}

