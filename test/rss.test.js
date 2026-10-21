import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { createServer } from '../src/server.js';
import { PERSONA_A, PERSONA_B, stubAdapter, tempStore, tidbit } from './helpers.js';

const servers = [];

async function start(store, adapter, feedBaseUrl = '') {
  const config = { host: '127.0.0.1', port: 0, feedBaseUrl };
  const server = createServer({ store, adapter, config, log: { warn() {}, error() {}, info() {} }, watcher: { afterSkillFetch() {} } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}

after(() => {
  for (const s of servers) s.close();
});

test('RSS includes known and broadcast-null items, excludes unknown, and emits display-name relationships', async () => {
  const { store } = await tempStore({
    tidbits: [
      tidbit({ text: 'A only', tellerPersonaId: PERSONA_A.id, createdAt: '2026-09-19T02:00:00.000Z' }),
      tidbit({ text: 'B only', tellerPersonaId: PERSONA_B.id, hearerPersonaIds: [PERSONA_B.id], createdAt: '2026-09-19T01:00:00.000Z' }),
      tidbit({ text: 'Nobody knows', tellerPersonaId: 'p_z', hearerPersonaIds: ['p_z'] }),
      tidbit({
        text: 'Broadcast item',
        tellerPersonaId: PERSONA_A.id,
        hearerPersonaIds: null,
        createdAt: '2026-09-18T00:00:00.000Z',
      }),
    ],
  });
  const base = await start(store, stubAdapter());
  const res = await fetch(`${base}/gossip.rss?show=${encodeURIComponent('Test Show')}`);
  assert.equal(res.status, 200);
  const xml = await res.text();
  assert.match(xml, /<rss version="2.0">/);
  assert.match(xml, /A only/);
  assert.match(xml, /B only/);
  assert.match(xml, /Broadcast item/);
  assert.doesNotMatch(xml, /Nobody knows/);
  assert.match(xml, /<channel>[\s\S]*<title>Station Gossip<\/title>/);
  assert.match(xml, /<link>http:\/\/127\.0\.0\.1:\d+\/gossip\.rss\?show=Test%20Show<\/link>/);
  assert.doesNotMatch(xml, /tellerPersonaId|hearerPersonaIds/);
  assert.doesNotMatch(xml, />p_a<|>p_b</);
  assert.match(xml, /<gossipHearers>Beta<\/gossipHearers>/);
  const titles = [...xml.matchAll(/<item>[\s\S]*?<title>([^<]+)<\/title>/g)].map((m) => m[1]);
  assert.deepEqual(titles, ['Broadcast item', 'B only', 'A only']);
});

test('root page lists active tidbits in board order and escapes HTML', async () => {
  const { store } = await tempStore({
    tidbits: [
      tidbit({ text: '<first>' }),
      tidbit({ text: 'second & more' }),
    ],
  });
  const base = await start(store, stubAdapter());
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /<ol><li>&lt;first&gt;<\/li><li>second &amp; more<\/li><\/ol>/);
});

test('schedule unavailable returns JSON error instead of empty RSS', async () => {
  const { store } = await tempStore({
    tidbits: [tidbit({ text: 'Should not leak' })],
  });
  const base = await start(store, stubAdapter({ failSchedule: true }));
  const res = await fetch(`${base}/gossip.rss?show=${encodeURIComponent('Test Show')}`);
  assert.ok(res.status >= 400);
  const body = await res.text();
  assert.doesNotMatch(body, /<rss/i);
  const json = JSON.parse(body);
  assert.match(json.error, /schedule down/i);
});

test('corrupt state reload returns JSON error instead of an empty RSS feed', async () => {
  const { store, filePath } = await tempStore({
    tidbits: [tidbit({ text: 'Should not leak', hearerPersonaIds: null })],
  });
  const corrupt = '{"tidbits":';
  await writeFile(filePath, corrupt);
  const followCalls = [];
  const config = { host: '127.0.0.1', port: 0, feedBaseUrl: '' };
  const server = createServer({
    store,
    adapter: stubAdapter(),
    config,
    log: { warn() {}, error() {}, info() {} },
    watcher: {
      afterSkillFetch(args) {
        followCalls.push(args);
      },
    },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}/gossip.rss?show=${encodeURIComponent('Test Show')}`);
  assert.ok(res.status >= 400);
  const body = await res.text();
  assert.doesNotMatch(body, /<rss/i);
  assert.equal(JSON.parse(body).error, `${filePath} is not valid JSON`);
  assert.equal(await readFile(filePath, 'utf8'), corrupt);
  assert.equal(followCalls.length, 0);
});

test('missing show is 400; unknown and empty-persona shows are empty 200', async () => {
  const { store } = await tempStore({
    tidbits: [tidbit({ text: 'Secret global item' })],
  });
  const base = await start(store, stubAdapter());

  const missing = await fetch(`${base}/gossip.rss`);
  assert.equal(missing.status, 400);
  assert.match(await missing.text(), /show query parameter is required/);

  const unknown = await fetch(`${base}/gossip.rss?show=${encodeURIComponent('No Such Show')}`);
  assert.equal(unknown.status, 200);
  const unknownXml = await unknown.text();
  assert.match(unknownXml, /<rss version="2.0">/);
  assert.doesNotMatch(unknownXml, /Secret global item/);
  assert.doesNotMatch(unknownXml, /<item>/);

  const empty = await fetch(`${base}/gossip.rss?show=${encodeURIComponent('Empty Show')}`);
  assert.equal(empty.status, 200);
  assert.doesNotMatch(await empty.text(), /<item>/);
});

test('RSS reloads the JSON file on every request', async () => {
  const { store, filePath } = await tempStore({
    tidbits: [tidbit({ text: 'Before edit', hearerPersonaIds: null })],
  });
  const base = await start(store, stubAdapter());
  const first = await (await fetch(`${base}/gossip.rss?show=${encodeURIComponent('Test Show')}`)).text();
  assert.match(first, /Before edit/);

  await writeFile(filePath, `${JSON.stringify({
    tidbits: [tidbit({ text: 'After edit unique', hearerPersonaIds: null, createdAt: '2026-09-19T12:00:00.000Z' })],
  }, null, 2)}\n`);
  const second = await (await fetch(`${base}/gossip.rss?show=${encodeURIComponent('Test Show')}`)).text();
  assert.match(second, /After edit unique/);
  assert.doesNotMatch(second, /Before edit/);

  await writeFile(filePath, `${JSON.stringify({ tidbits: [] }, null, 2)}\n`);
  const third = await (await fetch(`${base}/gossip.rss?show=${encodeURIComponent('Test Show')}`)).text();
  assert.doesNotMatch(third, /<item>/);
});

test('RSS without actor starts TTS follow-up when the feed has items', async () => {
  const followCalls = [];
  const watcher = {
    afterSkillFetch(args) {
      followCalls.push(args);
    },
  };
  const { store } = await tempStore({
    tidbits: [tidbit({ text: 'Feed item', hearerPersonaIds: null })],
  });
  const config = { host: '127.0.0.1', port: 0, feedBaseUrl: '' };
  const server = createServer({
    store,
    adapter: stubAdapter(),
    config,
    log: { warn() {}, error() {}, info() {} },
    watcher,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  const res = await fetch(`${base}/gossip.rss?show=${encodeURIComponent('Test Show')}`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Feed item/);
  assert.equal(followCalls.length, 1);
  assert.equal(followCalls[0].show, 'Test Show');
  assert.ok(followCalls[0].since instanceof Date);
});

test('RSS with actor starts TTS follow-up when the feed has items', async () => {
  const followCalls = [];
  const watcher = {
    afterSkillFetch(args) {
      followCalls.push(args);
    },
  };
  const { store } = await tempStore({
    tidbits: [tidbit({ text: 'Skill item', hearerPersonaIds: null })],
  });
  const config = { host: '127.0.0.1', port: 0, feedBaseUrl: '' };
  const server = createServer({
    store,
    adapter: stubAdapter(),
    config,
    log: { warn() {}, error() {}, info() {} },
    watcher,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  const res = await fetch(`${base}/gossip.rss?show=${encodeURIComponent('Test Show')}&actor=${encodeURIComponent(PERSONA_A.id)}`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Skill item/);
  assert.equal(followCalls.length, 1);
  assert.equal(followCalls[0].show, 'Test Show');
  assert.ok(followCalls[0].since instanceof Date);
});

test('each item-bearing RSS request starts TTS follow-up regardless of actor', async () => {
  const followCalls = [];
  const watcher = {
    afterSkillFetch(args) {
      followCalls.push(args);
    },
  };
  const { store } = await tempStore({
    tidbits: [tidbit({ text: 'Shared item', hearerPersonaIds: null })],
  });
  const config = { host: '127.0.0.1', port: 0, feedBaseUrl: '' };
  const server = createServer({
    store,
    adapter: stubAdapter(),
    config,
    log: { warn() {}, error() {}, info() {} },
    watcher,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  await fetch(`${base}/gossip.rss?show=${encodeURIComponent('Test Show')}`);
  await fetch(`${base}/gossip.rss?show=${encodeURIComponent('Test Show')}&actor=${encodeURIComponent(PERSONA_A.id)}`);
  assert.equal(followCalls.length, 2);
  assert.equal(followCalls[0].show, 'Test Show');
  assert.equal(followCalls[1].show, 'Test Show');
});

test('empty RSS feed does not start TTS follow-up', async () => {
  let followCalls = 0;
  const watcher = {
    afterSkillFetch() {
      followCalls += 1;
    },
  };
  const { store } = await tempStore({
    tidbits: [tidbit({ text: 'Secret global item' })],
  });
  const config = { host: '127.0.0.1', port: 0, feedBaseUrl: '' };
  const server = createServer({
    store,
    adapter: stubAdapter(),
    config,
    log: { warn() {}, error() {}, info() {} },
    watcher,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  const res = await fetch(`${base}/gossip.rss?show=${encodeURIComponent('Empty Show')}`);
  assert.equal(res.status, 200);
  assert.doesNotMatch(await res.text(), /<item>/);
  assert.equal(followCalls, 0);
});

test('actor RSS separates told-shape rumor from escaped teller and hearer metadata', async () => {
  const { store } = await tempStore({
    tidbits: [
      tidbit({
        id: 'rumor-1',
        text: 'Alpha told Beta, "Alpha & Beta <heard> "news""',
        tellerPersonaId: PERSONA_A.id,
        hearerPersonaIds: [PERSONA_B.id],
        createdAt: '2026-09-19T02:00:00.000Z',
      }),
    ],
  });
  const base = await start(store, stubAdapter());
  const res = await fetch(`${base}/gossip.rss?show=${encodeURIComponent('Test Show')}&actor=persona-a`);
  assert.equal(res.status, 200);
  const xml = await res.text();
  assert.match(xml, /<description>Alpha &amp; Beta &lt;heard&gt; &quot;news&quot;<\/description>/);
  assert.doesNotMatch(xml, /Alpha told Beta/);
  assert.match(xml, /<guid isPermaLink="false">rumor-1<\/guid>/);
  assert.match(xml, /<pubDate>[^<]+<\/pubDate>/);
  assert.match(xml, /<gossipTeller>Alpha<\/gossipTeller>/);
  assert.match(xml, /<gossipHearers>Beta<\/gossipHearers>/);
  assert.doesNotMatch(xml, /p_a|p_b|PERSONA/);
});

test('feedBaseUrl self-link includes show and actor query params', async () => {
  const { store } = await tempStore({
    tidbits: [tidbit({ text: 'Rumor', tellerPersonaId: PERSONA_A.id, hearerPersonaIds: null })],
  });
  const base = await start(store, stubAdapter(), 'http://companion.test');
  const res = await fetch(
    `${base}/gossip.rss?show=${encodeURIComponent('Test Show')}&actor=${encodeURIComponent('persona-a')}`,
  );
  assert.equal(res.status, 200);
  const xml = await res.text();
  assert.match(
    xml,
    /<link>http:\/\/companion\.test\/gossip\.rss\?show=Test%20Show&amp;actor=persona-a<\/link>/,
  );
  const linkCount = [...xml.matchAll(/<link>[^<]+<\/link>/g)].length;
  assert.equal(linkCount, 2);
});

test('feedBaseUrl self-link omits actor when request has no actor', async () => {
  const { store } = await tempStore({
    tidbits: [tidbit({ text: 'Rumor', tellerPersonaId: PERSONA_A.id, hearerPersonaIds: null })],
  });
  const base = await start(store, stubAdapter(), 'http://companion.test');
  const res = await fetch(`${base}/gossip.rss?show=${encodeURIComponent('Test Show')}`);
  assert.equal(res.status, 200);
  const xml = await res.text();
  assert.match(xml, /<link>http:\/\/companion\.test\/gossip\.rss\?show=Test%20Show<\/link>/);
  assert.doesNotMatch(xml, /actor=/);
});
