import { quotedRumorFromTidbit } from './llm.js';
import { formatRumorForOperationalLog } from './log.js';
import { wrapRumor } from './roles.js';
import { tidbitKey } from './store.js';
import { validateReviewRumor } from './validate.js';

export function applyReviewRevisions(tidbits, revisions, rolesById, { minLength = 20, log, round } = {}) {
  const keys = new Set();
  let accepted = 0;
  let rejected = 0;
  let stale = 0;
  const next = tidbits.map((tidbit) => {
    const rumor = revisions.get(tidbit.id);
    if (typeof rumor !== 'string' || !rumor.trim()) {
      keys.add(tidbitKey(tidbit));
      return tidbit;
    }
    const meta = rolesById.get(tidbit.id);
    if (!meta?.roles || !meta?.register) {
      stale += 1;
      log?.warn?.(`[gossip] review stale tidbit=${tidbit.id}: missing-canonical-roles`);
      keys.add(tidbitKey(tidbit));
      return tidbit;
    }
    const check = validateReviewRumor(rumor, { roles: meta.roles, register: meta.register, minLength, maxLength: 240 });
    if (!check.ok) {
      rejected += 1;
      log?.warn?.(`[gossip] review rejected tidbit=${tidbit.id}: ${check.reason}`);
      if (!meta.acceptedText) stale += 1;
      keys.add(tidbitKey(tidbit));
      return tidbit;
    }
    const text = wrapRumor(meta.roles, rumor);
    const candidate = { ...tidbit, text };
    const key = tidbitKey(candidate);
    if (keys.has(key)) {
      rejected += 1;
      log?.warn?.(`[gossip] review rejected tidbit=${tidbit.id}: duplicate-text`);
      keys.add(tidbitKey(tidbit));
      return tidbit;
    }
    accepted += 1;
    meta.acceptedText = text;
    keys.add(key);
    if (tidbit.text !== text) {
      const before = quotedRumorFromTidbit(tidbit.text);
      const roundSuffix = round != null ? ` round=${round}` : '';
      log?.info?.(
        `[gossip] review revised tidbit=${tidbit.id}${roundSuffix} rumor=${formatRumorForOperationalLog(before)} -> ${formatRumorForOperationalLog(rumor)}`,
      );
    }
    return candidate;
  });
  return { tidbits: next, accepted, rejected, stale };
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
  lifecycleId,
}) {
  if (!reviewRounds || reviewRounds <= 0 || !tidbits.length || !generateReview) {
    return { tidbits, roundsCompleted: 0, accepted: 0, rejected: 0, stale: 0 };
  }
  let current = tidbits;
  let roundsCompleted = 0;
  const outcomes = { accepted: 0, rejected: 0, stale: 0 };
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
          roles: rolesById.get(t.id)?.roles,
          register: rolesById.get(t.id)?.register,
        })),
        round,
        totalRounds: reviewRounds,
        lifecycleId,
      });
      const revisions = reviewRumorsFromPayload(payload, current);
      const merged = applyReviewRevisions(current, revisions, rolesById, { minLength, log, round });
      current = merged.tidbits;
      roundsCompleted = round;
      outcomes.accepted += merged.accepted;
      outcomes.rejected += merged.rejected;
      outcomes.stale += merged.stale;
      log.info?.(
        `[gossip] review round ${round}/${reviewRounds} accepted=${merged.accepted} rejected=${merged.rejected} stale=${merged.stale}`,
      );
    } catch (err) {
      log.warn?.(`[gossip] review round ${round} failed: ${err.message}`);
      break;
    }
  }
  log.info?.(`[gossip] review finished roundsCompleted=${roundsCompleted} accepted=${outcomes.accepted} rejected=${outcomes.rejected} stale=${outcomes.stale}`);
  return { tidbits: current, roundsCompleted, ...outcomes };
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
