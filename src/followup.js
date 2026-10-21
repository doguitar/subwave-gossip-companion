import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { listLlmCallLogSegments } from './callLog.js';
import { currentTidbits, legacyTidbitId, recordGossipComment, recordTidbitTelling, tidbitKey } from './store.js';
import { matchVoicedTidbit } from './spoken.js';
import { waitForStationGossipTts } from './ttsWatch.js';
import { retellableRumor } from './validate.js';

function responseStrings(value, out = []) {
  if (typeof value === 'string') out.push(value.replace(/\s+/g, ' ').trim());
  else if (Array.isArray(value)) value.forEach((item) => responseStrings(item, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((item) => responseStrings(item, out));
  return out;
}

export async function recoverFullSpokenText(spoken, logPath, log = console) {
  const short = String(spoken?.text || '').replace(/\s+/g, ' ').trim();
  if (!short || !logPath) return spoken;
  try {
    for (const segmentPath of await listLlmCallLogSegments(logPath)) {
      let raw;
      try {
        raw = await readFile(segmentPath, 'utf8');
      } catch (err) {
        if (err.code === 'ENOENT') continue;
        throw err;
      }
      const lines = raw.trim().split(/\r?\n/).reverse();
      for (const line of lines) {
        let entry;
        try { entry = JSON.parse(line); } catch { continue; }
        const candidates = responseStrings(entry.response).filter((text) => text.length > 20);
        const full = candidates
          .filter((text) => short.includes(text) || text.includes(short))
          .sort((a, b) => b.length - a.length)[0];
        if (full && full.length > short.length) {
          log.info?.('[gossip] recovered full spoken text from LLM call log');
          return { ...spoken, text: full };
        }
      }
    }
  } catch (err) {
    if (err.code !== 'ENOENT') log.warn?.(`[gossip] LLM call-log recovery failed: ${err.message}`);
  }
  return spoken;
}

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
  const gossip = retellableRumor(String(spoken?.text || '').replace(/\s+/g, ' ').trim());
  if (!gossip) return null;

  const rosterById = new Map((roster || []).map((p) => [p.id, p]));
  const rosterByName = new Map((roster || []).map((p) => [String(p.name || '').toLowerCase(), p]));
  const fromSession = speakerFromSession(session, spoken);
  const showHost = showPersonas?.[0];
  const cohosted = /^station-gossip-cohosted$/i.test(String(spoken?.kind || ''));

  const rawPersonaId = typeof spoken?.meta?.personaId === 'string' ? spoken.meta.personaId.trim() : '';
  const rawPersonaName = typeof spoken?.meta?.personaName === 'string' ? spoken.meta.personaName.trim() : '';
  const explicitSpeaker = Boolean(rawPersonaId || rawPersonaName);
  const namedPersona = (rawPersonaId && rosterById.get(rawPersonaId))
    || rosterByName.get(rawPersonaId.toLowerCase())
    || rosterByName.get(rawPersonaName.toLowerCase())
    || null;

  let tellerPersonaId = namedPersona?.id || (rosterById.has(rawPersonaId) ? rawPersonaId : '');
  let broadcaster = namedPersona?.name || rawPersonaName;

  if (namedPersona) {
    tellerPersonaId = namedPersona.id;
    broadcaster = namedPersona.name || broadcaster;
  } else if (!cohosted) {
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
  }

  if (cohosted && !explicitSpeaker) return null;

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
  const lifecycleId = randomUUID();
  const startedAt = Date.now();
  const item = formatOnAirTidbit(spoken, roster, showPersonas, session);
  if (!item) {
    log.warn?.('[gossip] follow-up skipped; unresolved broadcaster');
    log.info?.(`[gossip] lifecycle ${JSON.stringify({ version: 1, lifecycleId, kind: 'follow-up', stage: 'rejected', elapsedMs: Date.now() - startedAt, reason: 'unresolved-broadcaster' })}`);
    return { added: 0, skipped: true };
  }

  const result = await store.mutate((state) => {
    const existing = currentTidbits(state);
    const already = existing.find((t) => tidbitKey(t) === tidbitKey(item));
    if (already) {
      log.info?.('[gossip] follow-up skipped; already stored');
      attributeVoicedTidbits(state, { ...item, id: already.id }, spoken, session, log);
      return { added: 0, skipped: true };
    }
    const sameGossip = existing.find((t) => {
      const quoted = t.text?.match(/ said on air, "([\s\S]*)"$/);
      return quoted && retellableRumor(quoted[1]) === retellableRumor(String(spoken?.text || '').replace(/\s+/g, ' ').trim());
    });
    if (sameGossip) {
      sameGossip.text = item.text;
      sameGossip.tellerPersonaId = item.tellerPersonaId;
      sameGossip.hearerPersonaIds = null;
      log.info?.(`[gossip] follow-up corrected to ${item.tellerPersonaId}`);
      attributeVoicedTidbits(state, { ...item, id: sameGossip.id }, spoken, session, log);
      return { added: 0, skipped: false, corrected: true };
    }
    item.id = legacyTidbitId(item);
    const source = matchVoicedTidbit(existing, retellableRumor(spoken?.text));
    if (source) {
      item.threadId = source.threadId;
      item.canonicalSubjectPersonaId = source.canonicalSubjectPersonaId;
      item.canonicalTargetPersonaIds = source.canonicalTargetPersonaIds;
      item.canonicalAnchors = source.canonicalAnchors;
      item.toldAt = source.toldAt;
    }
    state.tidbits.push(item);
    log.info?.(`[gossip] follow-up added 1 from on-air ${item.createdAt}`);
    attributeVoicedTidbits(state, item, spoken, session, log);
    return { added: 1, skipped: false };
  });
  log.info?.(`[gossip] lifecycle ${JSON.stringify({ version: 1, lifecycleId, kind: 'follow-up', stage: 'complete', elapsedMs: Date.now() - startedAt, ...result })}`);
  return result;
}

function attributeVoicedTidbits(state, item, spoken, session, log) {
  const show = String(session?.session?.show || session?.show || '').trim();
  const commentedAt = item.createdAt;
  const actorPersonaId = item.tellerPersonaId;
  const targets = new Map();
  const source = matchVoicedTidbit(
    currentTidbits(state).filter((tidbit) => tidbit.id !== item.id),
    retellableRumor(spoken?.text),
  );
  if (source?.id) targets.set(source.id, source);
  if (item.id) targets.set(item.id, item);
  for (const target of targets.values()) {
    recordGossipComment(state, {
      tidbitId: target.id,
      actorPersonaId,
      show,
      commentedAt,
    });
    recordTidbitTelling(state, target.id, commentedAt);
  }
  log.info?.(`[gossip] attributed on-air line to ${actorPersonaId} across ${targets.size} tidbit(s)`);
}

function followupAbortError(signal) {
  const shutdown = signal?.reason === 'shutdown' || signal?.reason?.reason === 'shutdown';
  return Object.assign(new Error(shutdown ? 'shutting down' : 'This operation was aborted'), {
    name: 'AbortError',
    ...(shutdown ? { reason: 'shutdown', status: 503 } : {}),
  });
}

async function withFollowupSignal(promise, signal) {
  const work = Promise.resolve(promise);
  if (!signal) return work;
  if (signal.aborted) throw followupAbortError(signal);
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(followupAbortError(signal));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([work, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

export function createFollowupWatcher({ store, adapter, config, log = console }) {
  let accepting = true;
  const jobs = new Set();
  const tally = { drained: 0, aborted: 0 };

  async function run({ show, since, signal, state }) {
    const timeoutMs = config.ttsTimeoutMs || 5 * 60 * 1000;
    const intervalMs = config.ttsPollMs || 3000;
    let roster = [];
    let sessionShowPersonas = { sess: null, personas: [] };
    let requestedShowPersonas = [];
    try {
      [roster, sessionShowPersonas] = await Promise.all([
        withFollowupSignal(adapter.getRosterPersonas({ signal }), signal),
        (async () => {
          try {
            const sess = await withFollowupSignal(adapter.getSession({ signal }), signal);
            const sessionShow = sess?.session?.show || sess?.show || '';
            const personas = sessionShow
              ? await withFollowupSignal(adapter.getShowPersonas(sessionShow, { signal }), signal)
              : [];
            return { sess, personas };
          } catch (err) {
            if (signal?.aborted || err?.name === 'AbortError') throw err;
            return { sess: null, personas: [] };
          }
        })(),
      ]);
      requestedShowPersonas = await withFollowupSignal(adapter.getShowPersonas(show, { signal }), signal);
    } catch (err) {
      if (!(signal?.aborted || err?.name === 'AbortError')) throw err;
    }
    const showPersonas = sessionShowPersonas.personas.length ? sessionShowPersonas.personas : requestedShowPersonas;
    const outcomes = {};
    let watch = null;
    const onOutcome = (result) => {
      watch = result;
      outcomes[result.outcome] = (outcomes[result.outcome] || 0) + 1;
    };
    let added = 0;
    let lines = 0;
    const onLines = async (spokenLines) => {
      for (const spoken of spokenLines) {
        const fullSpoken = await recoverFullSpokenText(spoken, config.llmCallLogPath, log);
        if (signal?.aborted) break;
        state.commitDepth += 1;
        try {
          const result = await appendGeneratedGossip({
            store,
            roster,
            showPersonas,
            spoken: fullSpoken,
            session: sessionShowPersonas.sess,
            log,
          });
          added += result.added || 0;
          lines += 1;
        } finally {
          state.commitDepth -= 1;
        }
      }
    };
    log.info?.(`[gossip] watching station-gossip and station-gossip-cohosted TTS after skill fetch show=${show}`);
    await waitForStationGossipTts({ adapter, since, timeoutMs, intervalMs, onLines, onOutcome, log, signal });
    log.info?.(`[gossip] follow-up watcher outcomes ${JSON.stringify(outcomes)}`);
    const disposition = watch?.outcome === 'shutdown' && !state.protectedCommit ? 'aborted' : 'drained';
    return { added, lines, timedOut: watch?.outcome === 'timeout', watch, outcomes, disposition };
  }

  return {
    afterSkillFetch({ show, since }) {
      if (!accepting) {
        return Promise.resolve({ added: 0, lines: 0, outcomes: {}, started: false });
      }
      const controller = new AbortController();
      const state = { commitDepth: 0, protectedCommit: false };
      const job = { controller, state, promise: null };
      const promise = run({ show, since, signal: controller.signal, state }).then(
        (result) => {
          if (!accepting) tally[result.disposition] += 1;
          return result;
        },
        (err) => {
          if (!accepting) {
            const abandoned = err?.name === 'AbortError' || err?.reason === 'shutdown';
            tally[abandoned ? 'aborted' : 'drained'] += 1;
          }
          throw err;
        },
      );
      job.promise = promise;
      jobs.add(job);
      promise.finally(() => jobs.delete(job));
      return promise;
    },
    inFlight() {
      return [...jobs];
    },
    outcomeTally() {
      return { drained: tally.drained, aborted: tally.aborted };
    },
    beginShutdown() {
      accepting = false;
    },
    abandon() {
      for (const job of jobs) {
        if (job.state.commitDepth > 0) job.state.protectedCommit = true;
        if (!job.controller.signal.aborted) job.controller.abort('shutdown');
      }
    },
  };
}
