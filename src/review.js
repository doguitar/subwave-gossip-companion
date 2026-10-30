import { quotedRumorFromTidbit } from './llm.js';
import { formatRumorForOperationalLog } from './log.js';
import { wrapRumor } from './roles.js';
import { tidbitKey } from './store.js';
import { MAX_RUMOR_LENGTH, validateReviewRumor } from './validate.js';

function revisionEntry(value) {
  if (typeof value === 'string') return { rumor: value, why: '' };
  if (!value || typeof value !== 'object') return { rumor: '', why: '' };
  const rumor = typeof value.rumor === 'string'
    ? value.rumor
    : typeof value.quotedRumor === 'string'
      ? value.quotedRumor
      : '';
  const why = typeof value.why === 'string'
    ? value.why.trim()
    : typeof value.reason === 'string'
      ? value.reason.trim()
      : '';
  return { rumor, why };
}

export function applyReviewRevisions(tidbits, revisions, rolesById, { minLength = 20, log, round } = {}) {
  const keys = new Set();
  let accepted = 0;
  let rejected = 0;
  let stale = 0;
  const changes = [];
  const next = tidbits.map((tidbit) => {
    const { rumor, why } = revisionEntry(revisions.get(tidbit.id));
    if (!rumor.trim()) {
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
    const check = validateReviewRumor(rumor, { roles: meta.roles, register: meta.register, minLength, maxLength: MAX_RUMOR_LENGTH });
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
      changes.push({ id: tidbit.id, round, from: before, to: rumor, why });
      log?.info?.(
        `[gossip] review revised tidbit=${tidbit.id}${roundSuffix} rumor=${formatRumorForOperationalLog(before)} -> ${formatRumorForOperationalLog(rumor)} why=${formatRumorForOperationalLog(why)}`,
      );
    }
    return candidate;
  });
  return { tidbits: next, accepted, rejected, stale, changes };
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
  signal,
}) {
  if (!reviewRounds || reviewRounds <= 0 || !tidbits.length || !generateReview) {
    return { tidbits, roundsCompleted: 0, accepted: 0, rejected: 0, stale: 0 };
  }
  let current = tidbits;
  let roundsCompleted = 0;
  let failed = false;
  const outcomes = { accepted: 0, rejected: 0, stale: 0 };
  const trace = new Map(tidbits.map((tidbit) => [tidbit.id, []]));
  log.info?.(`[gossip] review starting tidbits=${current.length} rounds=${reviewRounds}`);
  for (let round = 1; round <= reviewRounds; round += 1) {
    if (signal?.aborted) {
      const reason = signal.reason === 'shutdown' ? 'shutdown' : undefined;
      throw Object.assign(
        new Error(reason === 'shutdown' ? 'shutting down' : 'gossip generation aborted'),
        { name: 'AbortError', ...(reason ? { reason, status: 503 } : {}) },
      );
    }
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
        signal,
      });
      const revisions = reviewRumorsFromPayload(payload, current);
      const merged = applyReviewRevisions(current, revisions, rolesById, { minLength, log, round });
      current = merged.tidbits;
      for (const change of merged.changes) {
        trace.get(change.id)?.push(change);
      }
      roundsCompleted = round;
      outcomes.accepted += merged.accepted;
      outcomes.rejected += merged.rejected;
      outcomes.stale += merged.stale;
      log.info?.(
        `[gossip] review round ${round}/${reviewRounds} accepted=${merged.accepted} rejected=${merged.rejected} stale=${merged.stale}`,
      );
    } catch (err) {
      if (err?.name === 'AbortError' || signal?.aborted) {
        if (signal?.aborted && err?.name !== 'AbortError') {
          const shutdown = signal.reason === 'shutdown';
          throw Object.assign(
            new Error(shutdown ? 'shutting down' : 'gossip generation aborted'),
            { name: 'AbortError', ...(shutdown ? { reason: 'shutdown', status: 503 } : {}) },
          );
        }
        throw err;
      }
      failed = true;
      log.warn?.(`[gossip] review round ${round} failed: ${err.message}`);
      break;
    }
  }
  log.info?.(`[gossip] review finished roundsCompleted=${roundsCompleted} accepted=${outcomes.accepted} rejected=${outcomes.rejected} stale=${outcomes.stale}`);
  logReviewTrace(log, tidbits, trace);
  return { tidbits: current, roundsCompleted, failed, ...outcomes };
}

function logReviewTrace(log, originals, trace) {
  for (const tidbit of originals) {
    const steps = trace.get(tidbit.id) || [];
    if (!steps.length) continue;
    const start = quotedRumorFromTidbit(tidbit.text);
    log.info?.(`[gossip] review trace tidbit=${tidbit.id} start=${formatRumorForOperationalLog(start)}`);
    for (const step of steps) {
      const roundSuffix = step.round != null ? ` round=${step.round}` : '';
      log.info?.(
        `[gossip] review trace tidbit=${tidbit.id}${roundSuffix} from=${formatRumorForOperationalLog(step.from)} to=${formatRumorForOperationalLog(step.to)} why=${formatRumorForOperationalLog(step.why)}`,
      );
    }
  }
}

export function reviewRumorsFromPayload(payload, tidbits) {
  const map = new Map();
  const put = (id, value) => {
    const entry = revisionEntry(value);
    if (id && entry.rumor) map.set(id, entry);
  };
  if (!payload || typeof payload !== 'object') return map;
  if (payload.rumors && typeof payload.rumors === 'object' && !Array.isArray(payload.rumors)) {
    for (const [id, rumor] of Object.entries(payload.rumors)) put(id, rumor);
    return map;
  }
  const items = Array.isArray(payload.items) ? payload.items : Array.isArray(payload.tidbits) ? payload.tidbits : [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const id = typeof item.id === 'string' ? item.id : '';
    put(id, item);
  }
  if (!map.size && tidbits?.length === 1 && typeof payload.rumor === 'string') {
    put(tidbits[0].id, payload.rumor);
  }
  return map;
}
