import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createServer } from '../src/server.js';
import { PERSONA_A, PERSONA_B, PERSONA_C, stubAdapter, tempStore, tidbit } from './helpers.js';

const servers = [];

async function start(store, adapter, generate, pickRoles) {
  const config = { host: '127.0.0.1', port: 0, feedBaseUrl: '', refreshCount: 1, timezone: 'UTC' };
  const server = createServer({
    store,
    adapter,
    config,
    generate,
    pickRoles,
    log: { warn() {}, error() {}, info() {} },
    watcher: { afterSkillFetch() {} },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}

after(() => {
  for (const s of servers) s.close();
});

test('POST /gossip/refresh clears the board and writes one told-shape rumor', async () => {
  const { store, read } = await tempStore({
    tidbits: [tidbit({ text: 'stale item', hearerPersonaIds: [PERSONA_B.id] })],
  });
  const roles = { teller: PERSONA_B, hearers: [PERSONA_A], targets: [PERSONA_C] };
  const base = await start(
    store,
    stubAdapter({ personas: [PERSONA_A, PERSONA_B, PERSONA_C] }),
    async ({ roles: r }) => {
      assert.equal(r.teller.id, PERSONA_B.id);
      return { rumor: 'unconfirmed Gamma coughed a cart that was only static' };
    },
    () => roles,
  );
  const res = await fetch(`${base}/gossip/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ count: 1 }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.refreshed, 1);
  assert.equal(
    body.tidbits[0].text,
    'Beta told Alpha, "unconfirmed Gamma coughed a cart that was only static"',
  );
  const disk = await read();
  assert.equal(disk.tidbits.length, 1);
  assert.equal(disk.tidbits[0].text, body.tidbits[0].text);
});
