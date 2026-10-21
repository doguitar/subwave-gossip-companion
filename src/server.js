import { createHash, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { parseRefreshCount } from './config.js';
import { currentTidbits, gossipForActor } from './store.js';
import { buildRss } from './rss.js';
import { createFollowupWatcher } from './followup.js';
import { refreshGossip } from './seed.js';
import { generateReview, generateSeed, summarizeHouseRules, summarizePersonaSouls } from './llm.js';
async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
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
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || `${config.host}:${config.port}`}`);
      const remote = req.socket?.remoteAddress || '-';
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(buildTidbitPage(currentTidbits(store.snapshot())));
        return;
      }
      log.info?.(`[gossip] ${req.method} ${url.pathname}${url.search} from ${remote}`);
      if (req.method === 'GET' && url.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('ok\n');
        return;
      }
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
            body = await readJsonBody(req);
          } catch {
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
