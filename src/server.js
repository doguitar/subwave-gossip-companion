import { createHash, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { parseRefreshCount } from './config.js';
import { currentTidbits, gossipForActor, stateFileReadable } from './store.js';
import { buildRss } from './rss.js';
import { createFollowupWatcher } from './followup.js';
import { refreshGossip } from './seed.js';
import { generateReview, generateSeed, summarizeHouseRules, summarizePersonaSouls } from './llm.js';

class PayloadTooLargeError extends Error {
  constructor() {
    super('request body exceeds configured limit');
    this.status = 413;
  }
}

class RequestBodyTimeoutError extends Error {
  constructor() {
    super('request body timed out');
    this.status = 408;
  }
}

function readJsonBody(req, maxBytes, timeoutMs) {
  const contentLength = req.headers['content-length'];
  if (typeof contentLength === 'string' && /^\d+$/.test(contentLength) && Number(contentLength) > maxBytes) {
    return Promise.reject(new PayloadTooLargeError());
  }
  const chunks = [];
  let bytes = 0;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => fail(new RequestBodyTimeoutError()), timeoutMs);
    const finish = () => {
      cleanup();
      if (!chunks.length) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (err) {
        reject(err);
      }
    };
    const fail = (err) => {
      cleanup();
      reject(err);
    };
    const onData = (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        cleanup();
        req.resume();
        reject(new PayloadTooLargeError());
        return;
      }
      chunks.push(chunk);
    };
    const onAborted = () => fail(new Error('request aborted'));
    const cleanup = () => {
      clearTimeout(timer);
      req.off('data', onData);
      req.off('end', finish);
      req.off('error', fail);
      req.off('aborted', onAborted);
    };
    req.on('data', onData);
    req.once('end', finish);
    req.once('error', fail);
    req.once('aborted', onAborted);
  });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function gossipFeedSelfLink(feedBaseUrl, requestUrl, show, actor) {
  if (!feedBaseUrl) {
    return `${requestUrl.origin}${requestUrl.pathname}${requestUrl.search}`;
  }
  const root = feedBaseUrl.replace(/\/+$/, '');
  let link = `${root}/gossip.rss?show=${encodeURIComponent(show)}`;
  if (actor) link += `&actor=${encodeURIComponent(actor)}`;
  return link;
}

export function buildTidbitPage(tidbits) {
  const items = tidbits.map((tidbit) => `<li>${escapeHtml(tidbit.text)}</li>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Station Gossip</title></head><body><h1>Station Gossip</h1><ol>${items}</ol></body></html>`;
}
function secretDigest(value) {
  return createHash('sha256').update(value).digest();
}

function hasRefreshCredential(req, secret) {
  const credential = typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
  return timingSafeEqual(secretDigest(credential), secretDigest(`Bearer ${secret}`));
}


const READINESS_DEADLINE_MS = 2000;

function probeReason(err) {
  return String(err?.code === 'CONFIG' ? 'missing-credentials' : err?.name === 'TimeoutError' || err?.name === 'AbortError' ? 'timeout' : err?.status ? 'http-error' : 'unreachable')
    .replace(/[\r\n]+/g, ' ')
    .trim() || 'unreachable';
}

function warnProbe(log, check, reason) {
  const line = `[gossip] lifecycle ${JSON.stringify({
    version: 1,
    kind: 'probe',
    check,
    ready: false,
    reason: String(reason).replace(/[\r\n]+/g, ' ').trim(),
  })}`;
  log.warn?.(line);
}

function withDeadline(work, ms, controller) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(Object.assign(new Error('readiness deadline exceeded'), { name: 'TimeoutError' }));
    }, ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

async function writeReadiness(res, { store, adapter, log }) {
  const controller = new AbortController();
  const checks = { state: 'error', subwave: 'error' };
  const pending = new Set(['state', 'subwave']);
  const failures = [];
  const record = (name, ok, reason) => {
    if (!pending.has(name)) return;
    pending.delete(name);
    if (ok) checks[name] = 'ok';
    else failures.push({ name, reason });
  };
  const stateWork = stateFileReadable(store.configuredPath()).then(
    (result) => record('state', result.readable, result.reason),
    (err) => record('state', false, probeReason(err)),
  );
  const subwaveWork = adapter.getSchedule({ signal: controller.signal }).then(
    () => record('subwave', true),
    (err) => record('subwave', false, probeReason(err)),
  );
  try {
    await withDeadline(Promise.allSettled([stateWork, subwaveWork]), READINESS_DEADLINE_MS, controller);
  } catch (err) {
    controller.abort();
    for (const name of [...pending]) record(name, false, probeReason(err));
  }
  for (const name of ['state', 'subwave']) {
    const failure = failures.find((item) => item.name === name);
    if (failure) warnProbe(log, failure.name, failure.reason);
  }
  const ready = checks.state === 'ok' && checks.subwave === 'ok';
  res.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(ready ? { ready: true } : { ready: false, checks }));
}

export function createServer({
  store,
  adapter,
  config,
  log = console,
  watcher,
  generate,
  pickRoles,
  summarizeSouls: summarizeSoulsHook,
  summarizeHouseRules: summarizeHouseRulesHook,
  now = () => new Date(),
}) {
  const generateFn = generate || ((args) => generateSeed({ config, log, ...args }));
  const generateReviewFn = (args) => generateReview({ config, log, ...args });
  const summarizeSoulsFn = summarizeSoulsHook
    || ((personas) => summarizePersonaSouls({ config, personas, log }));
  const summarizeHouseRulesFn = summarizeHouseRulesHook
    || ((rules) => summarizeHouseRules({ config, houseRules: rules, log }));
  let activeRefreshes = 0;
  let lastRefreshAdmissionAt = -Infinity;
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || `${config.host}:${config.port}`}`);
      const remote = req.socket?.remoteAddress || '-';
      if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/ready')) {
        if (url.pathname === '/health') {
          res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('ok\n');
          return;
        }
        await writeReadiness(res, { store, adapter, log });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(buildTidbitPage(currentTidbits(store.snapshot())));
        return;
      }
      log.info?.(`[gossip] ${req.method} ${url.pathname}${url.search} from ${remote}`);
      if ((req.method === 'POST' || req.method === 'GET') && (url.pathname === '/gossip/refresh' || url.pathname === '/refresh')) {
        if (req.method === 'GET') {
          res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8', Allow: 'POST' });
          res.end('POST to generate a fresh rumor and replace the board\n');
          return;
        }
        if (!config.refreshSecret || !hasRefreshCredential(req, config.refreshSecret)) {
          res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8', 'WWW-Authenticate': 'Bearer' });
          res.end(JSON.stringify({ error: 'unauthorized' }));
          return;
        }
        const refreshMaxConcurrency = config.refreshMaxConcurrency ?? 1;
        const refreshMinIntervalMs = config.refreshMinIntervalMs ?? 60_000;
        const admittedAt = Date.now();
        if (activeRefreshes >= refreshMaxConcurrency || admittedAt - lastRefreshAdmissionAt < refreshMinIntervalMs) {
          res.writeHead(429, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'refresh admission limit exceeded' }));
          return;
        }
        activeRefreshes += 1;
        lastRefreshAdmissionAt = admittedAt;
        try {
          let body = {};
          try {
            body = await readJsonBody(
              req,
              config.refreshBodyMaxBytes ?? 16 * 1024,
              config.requestTimeoutMs ?? 30_000,
            );
          } catch (err) {
            if (err instanceof PayloadTooLargeError) {
              res.writeHead(413, {
                'Content-Type': 'application/json; charset=utf-8',
                Connection: 'close',
              });
              res.end(JSON.stringify({ error: 'request body too large' }));
              return;
            }
            if (err instanceof RequestBodyTimeoutError) {
              res.once('finish', () => req.destroy());
              res.writeHead(408, {
                'Content-Type': 'application/json; charset=utf-8',
                Connection: 'close',
              });
              res.end(JSON.stringify({ error: 'request body timed out' }));
              return;
            }
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: 'invalid JSON body' }));
            return;
          }
          const rawCount = url.searchParams.has('count')
            ? url.searchParams.get('count')
            : Object.hasOwn(body, 'count')
              ? body.count
              : config.refreshCount;
          let cap;
          try {
            cap = parseRefreshCount(rawCount, 'refresh count');
          } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: err.message }));
            return;
          }
          await store.reload?.();
          const controller = new AbortController();
          req.once('aborted', () => controller.abort());
          const result = await refreshGossip({
            store,
            adapter,
            generate: generateFn,
            generateReview: generateReviewFn,
            summarizeSouls: summarizeSoulsFn,
            summarizeHouseRules: summarizeHouseRulesFn,
            reviewRounds: config.reviewRounds,
            cap,
            strictCap: true,
            historyGenerations: config.gossipHistoryGenerations,
            timezone: config.timezone,
            minLength: config.minRumorLength,
            log,
            pickRoles,
            rumorRegisters: config.rumorRegisters,
            signal: controller.signal,
          });
          if (res.destroyed) return;
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(result));
          return;
        } finally {
          activeRefreshes -= 1;
        }
      }
      await store.reload?.();
      if (req.method !== 'GET' || url.pathname !== '/gossip.rss') {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('not found\n');
        return;
      }
      const show = (url.searchParams.get('show') || '').trim();
      if (!show) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('show query parameter is required\n');
        return;
      }
      const personas = await adapter.getShowPersonas(show);
      const actor = (url.searchParams.get('actor') || '').trim();
      const policy = {
        maxTellings: config.threadMaxTellings,
        maxAgeMs: config.threadMaxAgeMs,
      };
      const ordered = personas.length
        ? gossipForActor(store.snapshot(), personas.map((p) => p.id), actor, show, { now: now(), policy })
        : [];
      const personaById = new Map(personas.map((p) => [p.id, p]));
      const items = ordered.map((item) => {
        const persona = personaById.get(item.tellerPersonaId);
        const tellerName = persona && typeof persona.name === 'string' && persona.name.trim() && persona.name !== persona.id
          ? persona.name.trim()
          : '';
        const hearerNames = (item.hearerPersonaIds || [])
          .map((id) => personaById.get(id))
          .map((hearer) => (typeof hearer?.name === 'string' && hearer.name.trim() && hearer.name !== hearer.id
            ? hearer.name.trim()
            : ''))
          .filter(Boolean)
          .join(', ');
        return { ...item, ...(tellerName ? { tellerName } : {}), ...(hearerNames ? { hearerNames } : {}) };
      });
      if (!personas.length) {
        log.warn?.(`[gossip] empty RSS for show=${show} (no personas)`);
      }
      const xml = buildRss({
        items,
        link: gossipFeedSelfLink(config.feedBaseUrl, url, show, actor),
      });
      res.writeHead(200, { 'Content-Type': 'application/rss+xml; charset=utf-8' });
      res.end(xml);
      if (items.length) {
        const follow = watcher || createFollowupWatcher({ store, adapter, config, log });
        follow.afterSkillFetch({ show, since: new Date() });
      }
    } catch (err) {
      if (res.destroyed) return;
      log.error?.(`[gossip] request failed: ${err.message}`);
      const status = err.status && Number.isInteger(err.status) ? err.status : 500;
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err.message, rejected: err.rejected || undefined }));
    }
  });
  server.headersTimeout = config.headersTimeoutMs ?? 10_000;
  server.requestTimeout = config.requestTimeoutMs ?? 30_000;
  return server;
}

export function listen(server, config, log = console) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => {
      log.info?.(`[gossip] listening on http://${config.host}:${config.port}`);
      resolve(server);
    });
  });
}
