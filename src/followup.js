import { currentTidbits, tidbitKey } from './store.js';
import { waitForStationGossipTts } from './ttsWatch.js';

function messageTime(msg) {
  const raw = msg?.meta?.airedAt || msg?.t || 0;
  const when = new Date(raw);
  return Number.isNaN(when.getTime()) ? 0 : when.getTime();
}

export function speakerFromSession(session, spoken) {
  const spokenAt = messageTime(spoken);
  const messages = session?.messages || session?.events || [];
  let last = null;
  for (const msg of messages) {
    if (messageTime(msg) > spokenAt) continue;
    const id = msg.meta?.personaId || msg.personaId;
    const name = msg.meta?.personaName || msg.personaName;
    if (id || name) last = { id: id ? String(id).trim() : '', name: name ? String(name).trim() : '' };
  }
  return last;
}

export function formatOnAirTidbit(spoken, roster = [], showPersonas = [], session = null) {
  const gossip = String(spoken?.text || '').replace(/\s+/g, ' ').trim();
  if (!gossip) return null;

  const rosterById = new Map((roster || []).map((p) => [p.id, p]));
  const rosterByName = new Map((roster || []).map((p) => [String(p.name || '').toLowerCase(), p]));
  const fromSession = speakerFromSession(session, spoken);
  const showHost = showPersonas?.[0];

  let tellerPersonaId = typeof spoken?.meta?.personaId === 'string' ? spoken.meta.personaId.trim() : '';
  let broadcaster = typeof spoken?.meta?.personaName === 'string' ? spoken.meta.personaName.trim() : '';

  if (!tellerPersonaId && fromSession?.id) tellerPersonaId = fromSession.id;
  if (!broadcaster && fromSession?.name) broadcaster = fromSession.name;

  if (tellerPersonaId && rosterById.has(tellerPersonaId)) {
    broadcaster = rosterById.get(tellerPersonaId).name || broadcaster;
  } else if (broadcaster && rosterByName.has(broadcaster.toLowerCase())) {
    tellerPersonaId = tellerPersonaId || rosterByName.get(broadcaster.toLowerCase()).id;
    broadcaster = rosterByName.get(broadcaster.toLowerCase()).name;
  } else if (showHost) {
    tellerPersonaId = tellerPersonaId || showHost.id;
    broadcaster = broadcaster || showHost.name;
  }

  if (!tellerPersonaId || !broadcaster) return null;

  const createdAt = spoken.meta?.airedAt || spoken.t || new Date().toISOString();
  return {
    text: `${broadcaster} said on air, "${gossip}"`,
    createdAt,
    tellerPersonaId,
    hearerPersonaIds: null,
  };
}

export function inventFollowup({ spoken, roster, showPersonas, session }) {
  const item = formatOnAirTidbit(spoken, roster, showPersonas, session);
  return { items: item ? [item] : [] };
}

export async function appendGeneratedGossip({
  store,
  roster,
  showPersonas,
  spoken,
  session = null,
  log = console,
}) {
  const item = formatOnAirTidbit(spoken, roster, showPersonas, session);
  if (!item) {
    log.warn?.('[gossip] follow-up skipped; unresolved broadcaster');
    return { added: 0, skipped: true };
  }

  return store.mutate((state) => {
    const existing = currentTidbits(state);
    if (existing.some((t) => tidbitKey(t) === tidbitKey(item))) {
      log.info?.('[gossip] follow-up skipped; already stored');
      return { added: 0, skipped: true };
    }
    const sameGossip = existing.find((t) => {
      const quoted = t.text?.match(/ said on air, "([\s\S]*)"$/);
      return quoted && quoted[1] === String(spoken?.text || '').replace(/\s+/g, ' ').trim();
    });
    if (sameGossip) {
      sameGossip.text = item.text;
      sameGossip.tellerPersonaId = item.tellerPersonaId;
      sameGossip.hearerPersonaIds = null;
      log.info?.(`[gossip] follow-up corrected to ${item.tellerPersonaId}`);
      return { added: 0, skipped: false, corrected: true };
    }
    state.tidbits.push(item);
    log.info?.(`[gossip] follow-up added 1 from on-air ${item.createdAt}`);
    return { added: 1, skipped: false };
  });
}

export function createFollowupWatcher({ store, adapter, config, log = console }) {
  let inflight = null;

  async function run({ show, since }) {
    const timeoutMs = config.ttsTimeoutMs || 5 * 60 * 1000;
    const intervalMs = config.ttsPollMs || 3000;
    log.info?.(`[gossip] waiting up to ${timeoutMs}ms for station-gossip TTS after skill fetch show=${show}`);
    const spoken = await waitForStationGossipTts({
      adapter,
      since,
      timeoutMs,
      intervalMs,
      log,
    });
    if (!spoken) return { added: 0, timedOut: true };

    const [roster, sessionShowPersonas, session] = await Promise.all([
      adapter.getRosterPersonas(),
      (async () => {
        try {
          const sess = await adapter.getSession();
          const sessionShow = sess?.session?.show || sess?.show || '';
          const personas = sessionShow ? await adapter.getShowPersonas(sessionShow) : [];
          return { sess, personas };
        } catch {
          return { sess: null, personas: [] };
        }
      })(),
    ]);
    const requestedShowPersonas = await adapter.getShowPersonas(show);
    const showPersonas = sessionShowPersonas.personas.length
      ? sessionShowPersonas.personas
      : requestedShowPersonas;
    return appendGeneratedGossip({
      store,
      roster,
      showPersonas,
      spoken,
      session: sessionShowPersonas.sess,
      log,
    });
  }

  return {
    afterSkillFetch({ show, since }) {
      if (inflight) {
        log.info?.('[gossip] tts watch already in flight');
        return inflight;
      }
      inflight = run({ show, since }).finally(() => {
        inflight = null;
      });
      return inflight;
    },
  };
}
