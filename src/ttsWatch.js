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
  const personaName = typeof personaRaw === 'string' ? personaRaw.trim() : String(personaRaw?.name || personaRaw?.personaName || '').trim();
  const personaId = String(raw.personaId || raw.meta?.personaId || '').trim();
  const airedAt = raw.airedAt || raw.at || raw.t || raw.ts || raw.createdAt || raw.when || '';
  return { kind: kind || 'station-gossip', text, t: airedAt || undefined, meta: { airedAt: airedAt || undefined, personaId: personaId || undefined, personaName: personaName || undefined }, raw };
}

function normalizedText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}
function parseStationResponse(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  try {
    const start = value.indexOf('{');
    const end = value.lastIndexOf('}');
    return start >= 0 && end > start ? JSON.parse(value.slice(start, end + 1)) : null;
  } catch {
    return null;
  }
}
function stationLlmLines(debug) {
  const calls = debug?.llm?.recentCalls || debug?.llm?.recentcalls || [];
  const lines = [];
  for (const call of Array.isArray(calls) ? calls : []) {
    const response = parseStationResponse(call?.response);
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
    const match = lines.filter((line) => line.text === text || text.includes(line.text) || line.text.includes(text)).sort((a, b) => b.text.length - a.text.length)[0];
    return match ? { ...call, meta: { ...call.meta, personaId: match.speaker } } : call;
  });
}
export function relatedStationLlmLines(debug, spoken) {
  const target = normalizedText(spoken?.text);
  if (!target) return [];
  const calls = debug?.llm?.recentCalls || debug?.llm?.recentcalls || [];
  for (const call of Array.isArray(calls) ? calls : []) {
    const response = parseStationResponse(call?.response);
    const lines = Array.isArray(response?.lines) ? response.lines : response?.segment?.text ? [{ speaker: spoken?.meta?.personaId || '', text: response.segment.text }] : response?.text ? [{ speaker: spoken?.meta?.personaId || '', text: response.text }] : [];
    if (lines.some((line) => {
      const text = normalizedText(line?.text);
      return text === target || target.includes(text) || text.includes(target);
    })) {
      return lines.map((line) => ({ speaker: String(line?.speaker || spoken?.meta?.personaId || '').trim(), text: normalizedText(line?.text) })).filter((line) => line.text);
    }
  }
  return [];
}
export function recentCallsFromDebug(debug) {
  const tts = debug?.tts || debug?.TTS || {};
  const calls = tts.recentCalls || tts.recentcalls || tts.recent_calls || debug?.recentCalls || [];
  return Array.isArray(calls) ? attachStationSpeakers(calls.map(normalizeTtsCall).filter(Boolean), debug) : [];
}
export function findStationGossipTts(source, since) {
  const sinceMs = since instanceof Date ? since.getTime() : new Date(since).getTime();
  const calls = Array.isArray(source) ? source.map(normalizeTtsCall).filter(Boolean) : recentCallsFromDebug(source).length ? recentCallsFromDebug(source) : (source?.messages || source?.events || []).map((msg) => ({ kind: msg.kind, text: msg.text, t: msg.t, meta: msg.meta || {} }));
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

function hasRecentSpeech(source, since) {
  const sinceMs = since instanceof Date ? since.getTime() : new Date(since).getTime();
  const calls = recentCallsFromDebug(source);
  const messages = source?.messages || source?.events || [];
  return [...calls, ...messages].some((entry) => {
    const when = new Date(entry?.meta?.airedAt || entry?.t || entry?.at || 0).getTime();
    return String(entry?.text || entry?.spoken || '').trim() && (!Number.isFinite(when) || when >= sinceMs);
  });
}

function terminalOutcome({ found, successfulPolls, fetchErrors, sawSpeech, adapter }) {
  if (found) return 'matched-speech';
  if (!successfulPolls && fetchErrors) return 'endpoint-unavailable';
  if (sawSpeech) return 'unmatched-speech';
  if (!adapter.getDebug && !adapter.getSession) return 'timeout';
  return 'no-segment';
}

export async function waitForStationGossipTts({
  adapter,
  since,
  timeoutMs = 5 * 60 * 1000,
  intervalMs = 3000,
  settleMs = 60000,
  onLines,
  onOutcome,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  log = console,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  const found = new Map();
  const counters = { polls: 0, debugPolls: 0, sessionPolls: 0, fetchErrors: 0, retryAttempts: 0 };
  let settleDeadline = null;
  let consecutiveFailures = 0;
  let successfulPolls = 0;
  let sawSpeech = false;
  while (Date.now() <= (settleDeadline || deadline)) {
    counters.polls += 1;
    let hits = [];
    let debug = null;
    let pollFailed = false;
    if (adapter.getDebug) {
      counters.debugPolls += 1;
      try {
        debug = await adapter.getDebug();
        successfulPolls += 1;
        sawSpeech ||= hasRecentSpeech(debug, since);
        hits = findStationGossipTts(debug, since);
      } catch {
        counters.fetchErrors += 1;
        pollFailed = true;
      }
    }
    if (!hits.length && adapter.getSession) {
      counters.sessionPolls += 1;
      try {
        const session = await adapter.getSession();
        successfulPolls += 1;
        sawSpeech ||= hasRecentSpeech(session, since);
        hits = findStationGossipTts(session, since);
      } catch {
        counters.fetchErrors += 1;
        pollFailed = true;
      }
    }
    const correlated = [];
    for (const spoken of hits) {
      const lines = debug ? relatedStationLlmLines(debug, spoken) : [];
      if (lines.length) for (const line of lines) correlated.push({ ...spoken, text: line.text, meta: { ...spoken.meta, personaId: line.speaker || spoken.meta?.personaId } });
      else correlated.push(spoken);
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
    const activeDeadline = settleDeadline || deadline;
    if (Date.now() >= activeDeadline) break;
    if (pollFailed) {
      consecutiveFailures += 1;
      counters.retryAttempts += 1;
    } else {
      consecutiveFailures = 0;
    }
    const delay = pollFailed ? Math.min(intervalMs * (2 ** Math.min(consecutiveFailures, 4)), 30000) : intervalMs;
    const wait = Math.min(delay, Math.max(0, activeDeadline - Date.now()));
    if (wait <= 0) break;
    await sleep(wait);
  }
  const result = [...found.values()].sort((a, b) => new Date(a.meta?.airedAt || a.t || 0) - new Date(b.meta?.airedAt || b.t || 0));
  const watch = { outcome: terminalOutcome({ found: result.length, successfulPolls, fetchErrors: counters.fetchErrors, sawSpeech, adapter }), ...counters };
  result.watch = watch;
  if (result.length === 1) Object.assign(result, result[0]);
  const terminal = `[gossip] tts watcher ${JSON.stringify({ outcome: watch.outcome, ...counters, lines: result.length })}`;
  if (watch.outcome === 'matched-speech') log.info?.(terminal);
  else log.warn?.(terminal);
  if (onOutcome) await onOutcome(watch);
  return result.length ? result : null;
}
