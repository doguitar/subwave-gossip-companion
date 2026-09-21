import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { createServer } from '../src/server.js';
import { PERSONA_A, PERSONA_B, stubAdapter, tempStore, tidbit } from './helpers.js';

const servers = [];

async function start(store, adapter) {
  const config = { host: '127.0.0.1', port: 0, feedBaseUrl: '' };
  const server = createServer({ store, adapter, config, log: { warn() {}, error() {}, info() {} }, watcher: { afterSkillFetch() {} } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}

after(() => {
  for (const s of servers) s.close();
});

test('RSS includes known and broadcast-null items, excludes unknown, omits relationships', async () => {
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
  const titles = [...xml.matchAll(/<item>[\s\S]*?<title>([^<]+)<\/title>/g)].map((m) => m[1]);
  assert.deepEqual(titles, ['A only', 'B only', 'Broadcast item']);
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
