import { quotedRumorFromTidbit } from './llm.js';
import { wrapRumor } from './roles.js';
import { tidbitKey } from './store.js';
import { validateRumor } from './validate.js';

export function rolesFromTidbit(tidbit, roster) {
  const byId = new Map((roster || []).map((p) => [p.id, p]));
  const teller = byId.get(tidbit.tellerPersonaId);
  if (!teller) return null;
  const hearerIds = tidbit.hearerPersonaIds === null ? [] : (tidbit.hearerPersonaIds || []);
  const hearers = hearerIds.map((id) => byId.get(id)).filter(Boolean);
  const quoted = quotedRumorFromTidbit(tidbit.text);
  const blocked = new Set([teller.id, ...hearers.map((p) => p.id)]);
  const targets = (roster || []).filter(
    (p) => p?.id && !blocked.has(p.id) && quoted.toLowerCase().includes(String(p.name).toLowerCase()),
  );
  return { teller, hearers, targets };
}

export function applyReviewRevisions(tidbits, revisions, rolesById, roster, { minLength = 20, log } = {}) {
  const keys = new Set();
  let accepted = 0;
  let rejected = 0;
  const next = tidbits.map((tidbit) => {
    const rumor = revisions.get(tidbit.id);
    if (typeof rumor !== 'string' || !rumor.trim()) {
      keys.add(tidbitKey(tidbit));
      return tidbit;
    }
    const meta = rolesById.get(tidbit.id);
    const roles = meta?.roles || rolesFromTidbit(tidbit, roster);
    if (!roles) {
      rejected += 1;
      log?.warn?.(`[gossip] review rejected tidbit=${tidbit.id}: missing-roles`);
      keys.add(tidbitKey(tidbit));
      return tidbit;
    }
    const check = validateRumor(rumor, { targets: roles.targets, minLength, maxLength: 240 });
    if (!check.ok) {
      rejected += 1;
      log?.warn?.(`[gossip] review rejected tidbit=${tidbit.id}: ${check.reason}`);
      keys.add(tidbitKey(tidbit));
      return tidbit;
    }
    const text = wrapRumor(roles, rumor);
    const candidate = { ...tidbit, text };
    const key = tidbitKey(candidate);
    if (keys.has(key)) {
      rejected += 1;
      log?.warn?.(`[gossip] review rejected tidbit=${tidbit.id}: duplicate-text`);
      keys.add(tidbitKey(tidbit));
      return tidbit;
    }
    accepted += 1;
    keys.add(key);
    return candidate;
  });
  return { tidbits: next, accepted, rejected };
}

export async function reviewGossipBatch({
  tidbits,
  rolesById,
  roster,
  houseRules = '',
  day,
  reviewRounds = 0,
  generateReview,
  log = console,
  minLength = 20,
}) {
  if (!reviewRounds || reviewRounds <= 0 || !tidbits.length || !generateReview) {
    return { tidbits, roundsCompleted: 0 };
  }
  let current = tidbits;
  let roundsCompleted = 0;
  log.info?.(`[gossip] review starting tidbits=${current.length} rounds=${reviewRounds}`);
  for (let round = 1; round <= reviewRounds; round += 1) {
    try {
      const payload = await generateReview({
        personas: roster,
        houseRules,
        day,
        tidbits: current.map((t) => ({
          id: t.id,
          text: t.text,
          quotedRumor: quotedRumorFromTidbit(t.text),
          roles: rolesById.get(t.id)?.roles || rolesFromTidbit(t, roster),
          register: rolesById.get(t.id)?.register,
        })),
        round,
        totalRounds: reviewRounds,
      });
      const revisions = reviewRumorsFromPayload(payload, current);
      const merged = applyReviewRevisions(current, revisions, rolesById, roster, { minLength, log });
      current = merged.tidbits;
      roundsCompleted = round;
      log.info?.(
        `[gossip] review round ${round}/${reviewRounds} accepted=${merged.accepted} rejected=${merged.rejected}`,
      );
    } catch (err) {
      log.warn?.(`[gossip] review round ${round} failed: ${err.message}`);
      break;
    }
  }
  log.info?.(`[gossip] review finished roundsCompleted=${roundsCompleted}`);
  return { tidbits: current, roundsCompleted };
}

export function reviewRumorsFromPayload(payload, tidbits) {
  const map = new Map();
  if (!payload || typeof payload !== 'object') return map;
  if (payload.rumors && typeof payload.rumors === 'object' && !Array.isArray(payload.rumors)) {
    for (const [id, rumor] of Object.entries(payload.rumors)) {
      if (typeof rumor === 'string') map.set(id, rumor);
    }
    return map;
  }
  const items = Array.isArray(payload.items) ? payload.items : Array.isArray(payload.tidbits) ? payload.tidbits : [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const id = typeof item.id === 'string' ? item.id : '';
    const rumor = typeof item.rumor === 'string' ? item.rumor : typeof item.quotedRumor === 'string' ? item.quotedRumor : '';
    if (id && rumor) map.set(id, rumor);
  }
  if (!map.size && tidbits?.length === 1 && typeof payload.rumor === 'string') {
    map.set(tidbits[0].id, payload.rumor);
  }
  return map;
}
