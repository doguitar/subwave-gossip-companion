export function ttsSourceId(message) {
  const airedAt = message?.meta?.airedAt || message?.t || '';
  const kind = message?.kind || 'station-gossip';
  return `tts:${kind}:${airedAt}`;
}

export function normalizeTtsCall(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const kind = String(raw.kind || raw.skill || raw.skillName || '').trim();
  const text = String(raw.text || raw.spoken || raw.spokenText || raw.content || '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const personaRaw = raw.persona ?? raw.personaName ?? raw.voice ?? raw.speaker;
  const personaName = typeof personaRaw === 'string'
    ? personaRaw.trim()
    : String(personaRaw?.name || personaRaw?.personaName || '').trim();
  const airedAt = raw.airedAt || raw.at || raw.t || raw.ts || raw.createdAt || raw.when || '';
  return { kind: kind || 'station-gossip', text, t: airedAt || undefined, meta: { airedAt: airedAt || undefined, personaName: personaName || undefined }, raw };
}

export function recentCallsFromDebug(debug) {
  const tts = debug?.tts || debug?.TTS || {};
  const calls = tts.recentCalls || tts.recentcalls || tts.recent_calls || debug?.recentCalls || [];
  return Array.isArray(calls) ? calls.map(normalizeTtsCall).filter(Boolean) : [];
}

export function findStationGossipTts(source, since) {
  const sinceMs = since instanceof Date ? since.getTime() : new Date(since).getTime();
  const calls = Array.isArray(source)
    ? source.map(normalizeTtsCall).filter(Boolean)
    : recentCallsFromDebug(source).length
      ? recentCallsFromDebug(source)
      : (source?.messages || source?.events || []).map((msg) => ({ kind: msg.kind, text: msg.text, t: msg.t, meta: msg.meta || {} }));
  const hits = [];
  for (const msg of calls) {
    if (!/^station-gossip(?:-cohosted)?$/i.test(String(msg.kind || ''))) continue;
    const when = new Date(msg.meta?.airedAt || msg.t || 0);
    if (Number.isNaN(when.getTime())) {
      if (sinceMs && !msg.meta?.airedAt && !msg.t) hits.push(msg);
      continue;
    }
    if (when.getTime() < sinceMs || !String(msg.text || '').trim()) continue;
    hits.push(msg);
  }
  return hits;
}

export async function waitForStationGossipTts({ adapter, since, timeoutMs = 5 * 60 * 1000, intervalMs = 3000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = console } = {}) {
  const deadline = Date.now() + timeoutMs;
  const found = new Map();
  while (Date.now() <= deadline) {
    try {
      let hits = [];
      if (adapter.getDebug) {
        try {
          hits = findStationGossipTts(await adapter.getDebug(), since);
        } catch (err) {
          log.warn?.(`[gossip] /debug tts poll failed: ${err.message}`);
        }
      }
      if (!hits.length && adapter.getSession) hits = findStationGossipTts(await adapter.getSession(), since);
      for (const spoken of hits) found.set(ttsSourceId(spoken), spoken);
    } catch (err) {
      log.warn?.(`[gossip] tts poll failed: ${err.message}`);
    }
    const wait = Math.min(intervalMs, Math.max(0, deadline - Date.now()));
    if (wait <= 0) break;
    await sleep(wait);
  }
  const result = [...found.values()].sort((a, b) => new Date(a.meta?.airedAt || a.t || 0) - new Date(b.meta?.airedAt || b.t || 0));
  log.info?.(`[gossip] tts watcher collected ${result.length} station-gossip line(s)`);
  if (!result.length) return null;
  if (result.length === 1) Object.assign(result, result[0]);
  return result;
}
