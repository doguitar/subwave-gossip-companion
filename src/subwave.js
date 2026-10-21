export function encodeHttpAuth(user, password) {
  return Buffer.from(`${user}:${password}`, 'utf8').toString('base64');
}

export function authorizationHeader({ apiUser = '', apiPassword = '', apiToken = '' } = {}) {
  const user = String(apiUser || '').trim();
  const password = String(apiPassword || '').trim();
  if (user && password) {
    return `Basic ${encodeHttpAuth(user, password)}`;
  }
  const token = String(apiToken || '').trim();
  if (!token) return '';
  if (token.includes(':')) {
    const cut = token.indexOf(':');
    return `Basic ${encodeHttpAuth(token.slice(0, cut), token.slice(cut + 1))}`;
  }
  try {
    const decoded = Buffer.from(token, 'base64').toString('utf8');
    if (decoded.includes(':')) return `Basic ${token}`;
  } catch {
    // keep Bearer fallback
  }
  return `Bearer ${token}`;
}

function abortError(signal) {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  return Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
}

function cancelResponseBody(res, signal) {
  const cancel = res?.body?.cancel;
  if (typeof cancel !== 'function') return;
  Promise.resolve(cancel.call(res.body, signal?.reason)).catch(() => {});
}

function readJson(res, signal) {
  if (!signal) return res.json();
  if (signal.aborted) {
    cancelResponseBody(res, signal);
    return Promise.reject(abortError(signal));
  }
  const parsed = res.json();
  parsed.catch(() => {});
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      cancelResponseBody(res, signal);
      reject(abortError(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    parsed.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

export class SubwaveAdapter {
  constructor({ apiUrl, apiToken, apiUser, apiPassword, fetchImpl = fetch, log = console }) {
    this.apiUrl = apiUrl;
    this.apiToken = apiToken;
    this.apiUser = apiUser;
    this.apiPassword = apiPassword;
    this.fetchImpl = fetchImpl;
    this.log = log;
  }

  async request(pathname, { query, signal } = {}) {
    const authorization = authorizationHeader({
      apiUser: this.apiUser,
      apiPassword: this.apiPassword || this.apiToken,
      apiToken: this.apiToken,
    });
    if (!this.apiUrl || !authorization) {
      throw Object.assign(new Error('Subwave API credentials are missing'), { code: 'CONFIG' });
    }
    const url = new URL(pathname.replace(/^\//, ''), `${this.apiUrl}/`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value != null && value !== '') url.searchParams.set(key, String(value));
      }
    }
    const res = await this.fetchImpl(url, {
      headers: {
        Authorization: authorization,
        Accept: 'application/json',
      },
      ...(signal ? { signal } : {}),
    });
    if (signal?.aborted) {
      cancelResponseBody(res, signal);
      throw abortError(signal);
    }
    if (!res.ok) {
      cancelResponseBody(res, signal);
      const err = new Error(`Subwave API ${pathname} failed: HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return readJson(res, signal);
  }

  async getSchedule({ signal } = {}) {
    return this.request('/schedule', { signal });
  }

  async getSession({ signal } = {}) {
    return this.request('/session', { signal });
  }

  async getDebug({ signal } = {}) {
    return this.request('/debug', { signal });
  }

  async getSettings({ signal } = {}) {
    return this.request('/settings', { signal });
  }
  async getHouseRules({ signal } = {}) {
    const settings = await this.getSettings({ signal });
    return settings?.values?.djHouseRules ?? settings?.djHouseRules ?? '';
  }


  async getSpokenEvents({ cursor } = {}) {
    try {
      return await this.request('/events', { query: { cursor: cursor || '', kind: 'gossip-spoken' } });
    } catch (err) {
      if (err.status === 404) {
        const session = await this.getSession();
        return eventsFromSession(session, cursor);
      }
      throw err;
    }
  }

  async getRosterPersonas({ signal } = {}) {
    try {
      const settings = await this.getSettings({ signal });
      const admin = settings?.values?.personas || settings?.personas;
      if (Array.isArray(admin) && admin.length) {
        return normalizePersonas(admin);
      }
    } catch (err) {
      if (signal?.aborted || err?.name === 'AbortError') throw err;
      this.log.warn?.(`[gossip] admin /settings roster failed: ${err.message}`);
    }
    if (signal?.aborted) {
      throw Object.assign(new Error(signal.reason === 'shutdown' ? 'shutting down' : 'This operation was aborted'), {
        name: 'AbortError',
        ...(signal.reason === 'shutdown' ? { reason: 'shutdown', status: 503 } : {}),
      });
    }
    try {
      const schedule = await this.getSchedule({ signal });
      return normalizePersonas(schedule.personas || []);
    } catch (err) {
      if (signal?.aborted || err?.name === 'AbortError') throw err;
      this.log.warn?.(`[gossip] roster fetch failed: ${err.message}`);
      return [];
    }
  }

  async getShowPersonas(showTitle, { signal } = {}) {
    const wanted = String(showTitle || '').trim();
    if (!wanted) return [];
    let schedule;
    try {
      schedule = await this.getSchedule({ signal });
    } catch (err) {
      this.log.warn?.(`[gossip] schedule load failed: ${err.message}`);
      if (signal?.aborted || err?.name === 'AbortError') throw err;
      if (!err.status || !Number.isInteger(err.status)) err.status = 503;
      throw err;
    }
    const fromSchedule = personasForShow(schedule, wanted, this.log);
    if (fromSchedule.matched) return fromSchedule.personas;
    try {
      const session = await this.getSession({ signal });
      const sessionTitle = String(session?.session?.show || session?.show || '').trim();
      if (sessionTitle === wanted) {
        const retry = personasForShow(schedule, sessionTitle, this.log);
        if (retry.matched) return retry.personas;
        return personasFromSession(session);
      }
    } catch (err) {
      if (signal?.aborted || err?.name === 'AbortError') throw err;
      this.log.warn?.(`[gossip] session fallback failed: ${err.message}`);
    }
    this.log.warn?.(`[gossip] show not found: ${wanted}`);
    return [];
  }
}

export function personasForShow(schedule, wanted, log) {
  const shows = Array.isArray(schedule?.shows) ? schedule.shows : [];
  const show = shows.find((s) => String(s.name || s.title || '').trim() === wanted);
  if (!show) return { matched: false, personas: [] };
  const personaById = new Map(normalizePersonas(schedule.personas || []).map((p) => [p.id, p]));
  const ids = [show.personaId, ...(show.guestPersonaIds || [])].filter(Boolean);
  const out = [];
  const seen = new Set();
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const persona = personaById.get(id);
    if (persona) out.push(persona);
    else out.push({ id, name: id });
  }
  if (!out.length) log?.warn?.(`[gossip] show has zero personas: ${wanted}`);
  return { matched: true, personas: out };
}

function personasFromSession(session) {
  const ids = [];
  for (const msg of session?.messages || session?.events || []) {
    const id = msg.meta?.personaId || msg.personaId;
    if (id) ids.push({ id, name: msg.meta?.personaName || id });
  }
  return normalizePersonas(ids);
}

export function normalizePersonas(personas) {
  const out = [];
  const seen = new Set();
  for (const p of personas || []) {
    const id = String(p.id || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      name: String(p.name || id),
      tagline: p.tagline ? String(p.tagline) : '',
      soul: p.soul || p.soulMd || p.soulText || p.system || p.systemPrompt || p.prompt || '',
    });
  }
  return out;
}

export function eventsFromSession(session, cursor) {
  const messages = session?.messages || session?.events || [];
  const events = [];
  for (const msg of messages) {
    const meta = msg.meta || {};
    const kind = String(msg.kind || '');
    const gossipKind = !kind || kind === 'gossip-spoken' || kind === 'gossip' || kind === 'station-gossip';
    if (!gossipKind) continue;
    const spokenAt = meta.spoken_at || meta.spokenAt || meta.airedAt || msg.t || msg.airedAt;
    const sourceEventId = meta.source_event_id || meta.sourceEventId || msg.id || (spokenAt ? `${kind}:${spokenAt}` : '');
    let tidbitId = meta.tidbit_id || meta.tidbitId || '';
    if (!tidbitId) {
      const idMatch = String(msg.text || '').match(/\b(g_[A-Za-z0-9-]+)\b/);
      if (idMatch) tidbitId = idMatch[1];
    }
    if (!sourceEventId || !spokenAt) continue;
    const actorPersonaId = String(meta.actorPersonaId || meta.actor_persona_id || '').trim();
    const show = String(meta.show || meta.showTitle || meta.show_title || '').trim();
    events.push({
      tidbitId: tidbitId ? String(tidbitId) : '',
      spokenAt: String(spokenAt),
      sourceEventId: String(sourceEventId),
      spokenText: String(msg.text || ''),
      ...(actorPersonaId ? { actorPersonaId } : {}),
      ...(show ? { show } : {}),
    });
  }
  const tip = lastCursor(events);
  if (!cursor) return { events, cursor: tip, cursorStatus: 'start' };
  const start = events.findIndex((e) => e.sourceEventId === cursor);
  if (start < 0) return { events: [], cursor: tip, cursorStatus: 'unknown' };
  return { events: events.slice(start + 1), cursor: tip, cursorStatus: 'advanced' };
}

function lastCursor(events) {
  return events.length ? events[events.length - 1].sourceEventId : null;
}
