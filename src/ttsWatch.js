export function ttsSourceId(message) {
  const airedAt = message?.meta?.airedAt || message?.t || '';
  const kind = message?.kind || 'station-gossip';
  const text = normalizedText(message?.text);
  return `tts:${kind}:${airedAt}:${text}`;
}

export function normalizeTtsCall(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const kind = String(raw.kind || raw.skill || raw.skillName || '').trim();
  const text = String(raw.text || raw.spoken || raw.spokenText || raw.content || '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const personaRaw = raw.persona ?? raw.personaName ?? raw.voice ?? raw.speaker ?? raw.meta?.persona;
  const personaName = typeof personaRaw === 'string'
    ? personaRaw.trim()
    : String(personaRaw?.name || personaRaw?.personaName || '').trim();
  const personaId = String(raw.personaId || raw.meta?.personaId || '').trim();
  const airedAt = raw.airedAt || raw.at || raw.t || raw.ts || raw.createdAt || raw.when || '';
  return {
    kind: kind || 'station-gossip',
    text,
    t: airedAt || undefined,
    meta: {
      airedAt: airedAt || undefined,
      personaId: personaId || undefined,
      personaName: personaName || undefined,
    },
    raw,
  };
}

function normalizedText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function stationLlmLines(debug) {
  const calls = debug?.llm?.recentCalls || debug?.llm?.recentcalls || [];
  const lines = [];
  for (const call of Array.isArray(calls) ? calls : []) {
    const response = call?.response;
    for (const line of Array.isArray(response?.lines) ? response.lines : []) {
      const speaker = String(line?.speaker || '').trim();
      const text = normalizedText(line?.text);
      if (speaker && text) lines.push({ speaker, text });
    }
  }
  return lines;
}

function attachStationSpeakers(calls, debug) {

  const lines = stationLlmLines(debug);
  return calls.map((call) => {
    const text = normalizedText(call.text);
    const match = lines
      .filter((line) => line.text === text || text.includes(line.text) || line.text.includes(text))
      .sort((a, b) => b.text.length - a.text.length)[0];
    return match
      ? { ...call, meta: { ...call.meta, personaId: match.speaker } }
      : call;
  });
}
export function relatedStationLlmLines(debug, spoken) {
  const target = normalizedText(spoken?.text);
  if (!target) return [];
  const calls = debug?.llm?.recentCalls || debug?.llm?.recentcalls || [];
  for (const call of Array.isArray(calls) ? calls : []) {
    const lines = Array.isArray(call?.response?.lines) ? call.response.lines : [];
    if (lines.some((line) => {
      const text = normalizedText(line?.text);
      return text === target || target.includes(text) || text.includes(target);
    })) {
      return lines
        .map((line) => ({ speaker: String(line?.speaker || '').trim(), text: normalizedText(line?.text) }))
        .filter((line) => line.speaker && line.text);
    }
  }
  return [];
}

export function recentCallsFromDebug(debug) {
  const tts = debug?.tts || debug?.TTS || {};
  const calls = tts.recentCalls || tts.recentcalls || tts.recent_calls || debug?.recentCalls || [];
  return Array.isArray(calls)
    ? attachStationSpeakers(calls.map(normalizeTtsCall).filter(Boolean), debug)
    : [];
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

export async function waitForStationGossipTts({
  adapter,
  since,
  timeoutMs = 5 * 60 * 1000,
  intervalMs = 3000,
  settleMs = 60000,
  onLines,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  log = console,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  const found = new Map();
  let settleDeadline = null;
  while (Date.now() <= (settleDeadline || deadline)) {
    try {
      let hits = [];
      let debug = null;
      if (adapter.getDebug) {
        try {
          debug = await adapter.getDebug();
          hits = findStationGossipTts(debug, since);
        } catch (err) {
          log.warn?.(`[gossip] /debug tts poll failed: ${err.message}`);
        }
      }
      if (!hits.length && adapter.getSession) hits = findStationGossipTts(await adapter.getSession(), since);
      const correlated = [];
      for (const spoken of hits) {
        const lines = debug ? relatedStationLlmLines(debug, spoken) : [];
        if (lines.length) {
          for (const line of lines) {
            correlated.push({
              ...spoken,
              text: line.text,
              meta: { ...spoken.meta, personaId: line.speaker },
            });
          }
        } else {
          correlated.push(spoken);
        }
      }
      const newLines = [];
      for (const spoken of correlated) {
        const key = ttsSourceId(spoken);
        if (found.has(key)) continue;
        found.set(key, spoken);
        newLines.push(spoken);
      }
      if (newLines.length && onLines) await onLines(newLines);
      if (newLines.length && !settleDeadline) {
        settleDeadline = Date.now() + settleMs;
        log.info?.(`[gossip] first station-gossip line detected; collecting follow-up lines for ${settleMs}ms`);
      }
    } catch (err) {
      log.warn?.(`[gossip] tts poll failed: ${err.message}`);
    }
    const activeDeadline = settleDeadline || deadline;
    const wait = Math.min(intervalMs, Math.max(0, activeDeadline - Date.now()));
    if (wait <= 0) break;
    await sleep(wait);
  }
  const result = [...found.values()].sort((a, b) => new Date(a.meta?.airedAt || a.t || 0) - new Date(b.meta?.airedAt || b.t || 0));
  log.info?.(`[gossip] tts watcher collected ${result.length} station-gossip line(s)`);
  if (!result.length) return null;
  if (result.length === 1) Object.assign(result, result[0]);
  return result;
}
