import { currentTidbits, recordGossipComment, tidbitKey } from './store.js';
import { matchSpokenTidbit } from './spoken.js';

export function normalizeSpokenEvent(raw, candidates = []) {
  if (!raw || typeof raw !== 'object') return null;
  const spokenAt = String(raw.spokenAt || raw.spoken_at || '').trim();
  const spokenText = String(raw.spokenText || raw.text || '').trim();
  if (!spokenAt && !spokenText) return null;
  if (spokenAt && Number.isNaN(new Date(spokenAt).getTime())) return null;
  const hit = matchSpokenTidbit(candidates, spokenText) || (spokenText
    ? candidates.find((t) => t.text === spokenText)
    : null);
  const actorPersonaId = String(raw.actorPersonaId || raw.actor_persona_id || '').trim();
  const show = String(raw.show || raw.showTitle || raw.show_title || '').trim();
  return {
    spokenAt: spokenAt || hit?.createdAt || '',
    spokenText,
    match: hit || null,
    ...(actorPersonaId ? { actorPersonaId } : {}),
    ...(show ? { show } : {}),
  };
}

export async function ingestSpoken({ store, adapter, log = console }) {
  await store.reload();
  const snapshot = store.snapshot();
  const payload = await adapter.getSpokenEvents({});
  const incoming = Array.isArray(payload?.events) ? payload.events : Array.isArray(payload) ? payload : [];
  const candidates = currentTidbits(snapshot);

  return store.mutate((state) => {
    let ingested = 0;
    let skipped = 0;
    const seen = new Set(currentTidbits(state).map(tidbitKey));
    for (const raw of incoming) {
      const event = normalizeSpokenEvent(raw, candidates);
      if (!event?.match) {
        log.warn?.('[gossip] skip malformed or unmatched spoken event');
        skipped += 1;
        continue;
      }
      const tidbit = state.tidbits.find((t) => tidbitKey(t) === tidbitKey(event.match));
      if (!tidbit) {
        skipped += 1;
        continue;
      }
      if (event.actorPersonaId) {
        recordGossipComment(state, {
          tidbitId: tidbit.id,
          actorPersonaId: event.actorPersonaId,
          show: event.show || '',
          commentedAt: event.spokenAt,
        });
      }
      if (tidbit.hearerPersonaIds === null) {
        skipped += 1;
        continue;
      }
      tidbit.hearerPersonaIds = null;
      seen.add(tidbitKey(tidbit));
      ingested += 1;
    }
    log.info?.(`[gossip] ingest-spoken ingested=${ingested} skipped=${skipped}`);
    return { ingested, skipped };
  });
}
