import http from 'node:http';
import { tidbitsKnownBy } from './store.js';
import { buildRss } from './rss.js';
import { createFollowupWatcher } from './followup.js';
import { refreshGossip } from './seed.js';
import { generateSeed } from './llm.js';

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

export function createServer({ store, adapter, config, log = console, watcher, generate, pickRoles }) {
  const generateFn = generate || ((args) => generateSeed({ config, log, ...args }));
  return http.createServer(async (req, res) => {
    try {
      if (store?.reload) await store.reload();
      const url = new URL(req.url || '/', `http://${req.headers.host || `${config.host}:${config.port}`}`);
      const remote = req.socket?.remoteAddress || '-';
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
        let body = {};
        try {
          body = await readJsonBody(req);
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'invalid JSON body' }));
          return;
        }
        const cap = Number(url.searchParams.get('count') || body.count || config.refreshCount || 1);
        const result = await refreshGossip({
          store,
          adapter,
          generate: generateFn,
          cap: Number.isInteger(cap) && cap > 0 ? Math.min(cap, 10) : 1,
          timezone: config.timezone,
          log,
          pickRoles,
        });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(result));
        return;
      }
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
      const items = personas.length ? tidbitsKnownBy(store.snapshot(), personas.map((p) => p.id)) : [];
      if (!personas.length) {
        log.warn?.(`[gossip] empty RSS for show=${show} (no personas)`);
      }
      const requestLink = `${url.origin}${url.pathname}${url.search}`;
      const xml = buildRss({
        items,
        link: config.feedBaseUrl ? `${config.feedBaseUrl}/gossip.rss?show=${encodeURIComponent(show)}` : requestLink,
      });
      res.writeHead(200, { 'Content-Type': 'application/rss+xml; charset=utf-8' });
      res.end(xml);
      if (items.length) {
        const follow = watcher || createFollowupWatcher({ store, adapter, config, log });
        follow.afterSkillFetch({ show, since: new Date() });
      }
    } catch (err) {
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
