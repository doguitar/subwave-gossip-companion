import { currentTidbits, recordGossipComment, tidbitKey } from './store.js';
import { matchSpokenTidbits } from './spoken.js';

export function normalizeSpokenEvent(raw, candidates = []) {
  if (!raw || typeof raw !== 'object') return null;
  const spokenAt = String(raw.spokenAt || raw.spoken_at || '').trim();
  const spokenText = String(raw.spokenText || raw.text || '').trim();
  const tidbitId = String(raw.tidbitId || raw.tidbit_id || '').trim();
  if (!spokenAt && !spokenText && !tidbitId) return null;
  if (spokenAt && Number.isNaN(new Date(spokenAt).getTime())) return null;
  let match = null;
  let reason = '';
  if (tidbitId) {
    match = candidates.find((item) => item.id === tidbitId) || null;
    if (!match) reason = 'unknown-tidbit-id';
  } else {
    const hits = matchSpokenTidbits(candidates, spokenText);
    const exact = spokenText ? candidates.filter((item) => item.text === spokenText) : [];
    const chosen = hits.length ? hits : exact;
    if (chosen.length === 1) match = chosen[0];
    else if (chosen.length > 1) reason = 'ambiguous-text';
    else reason = 'unmatched';
  }
  const actorPersonaId = String(raw.actorPersonaId || raw.actor_persona_id || '').trim();
  const show = String(raw.show || raw.showTitle || raw.show_title || '').trim();
  return {
    spokenAt: spokenAt || match?.createdAt || '',
    spokenText,
    sourceEventId: String(raw.sourceEventId || raw.source_event_id || '').trim(),
    match,
    reason,
    ...(actorPersonaId ? { actorPersonaId } : {}),
    ...(show ? { show } : {}),
  };
}

export async function ingestSpoken({ store, adapter, log = console }) {
  await store.reload();
  const snapshot = store.snapshot();
  const payload = await adapter.getSpokenEvents({ cursor: snapshot.spokenEventCursor || '' });
  const incoming = Array.isArray(payload?.events) ? payload.events : Array.isArray(payload) ? payload : [];
  const candidates = currentTidbits(snapshot);
  if (payload?.cursorStatus === 'unknown') {
    log.warn?.('[gossip] spoken cursor unknown; not replaying the session');
  }

  return store.mutate((state) => {
    let ingested = 0;
    let skipped = 0;
    const seen = new Set(currentTidbits(state).map(tidbitKey));
    for (const raw of incoming) {
      const event = normalizeSpokenEvent(raw, candidates);
      if (event?.reason === 'ambiguous-text') {
        log.warn?.('[gossip] skip spoken event: ambiguous-text');
        skipped += 1;
        continue;
      }
      if (!event?.match) {
        log.warn?.(`[gossip] skip malformed or unmatched spoken event${event?.reason ? `: ${event.reason}` : ''}`);
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
    if (typeof payload?.cursor === 'string') state.spokenEventCursor = payload.cursor;
    log.info?.(`[gossip] ingest-spoken ingested=${ingested} skipped=${skipped}`);
    return { ingested, skipped };
  });
}
