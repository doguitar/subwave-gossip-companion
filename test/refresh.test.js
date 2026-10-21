import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createServer } from '../src/server.js';
import { parseRssItems } from '../src/rss.js';
import { PERSONA_A, PERSONA_B, PERSONA_C, stubAdapter, tempStore, tidbit } from './helpers.js';

const servers = [];

async function start(store, adapter, generate, pickRoles) {
  const config = {
    host: '127.0.0.1',
    port: 0,
    feedBaseUrl: '',
    refreshCount: 1,
    timezone: 'UTC',
    gossipHistoryGenerations: 7,
    threadMaxTellings: 3,
    threadMaxAgeMs: 24 * 60 * 60 * 1000,
  };
  const server = createServer({
    store,
    adapter,
    config,
    generate,
    pickRoles,
    summarizeSouls: async (roster) => roster,
    summarizeHouseRules: async (rules) => rules,
    log: { warn() {}, error() {}, info() {} },
    watcher: { afterSkillFetch() {} },
    now: () => new Date('2026-09-19T04:00:00.000Z'),
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

test('POST /gossip/refresh forwards one requested count without roster expansion', async () => {
  const { store } = await tempStore();
  let calls = 0;
  const base = await start(
    store,
    stubAdapter({ personas: [PERSONA_A, PERSONA_B, PERSONA_C] }),
    async () => {
      calls += 1;
      return { rumor: 'unconfirmed the booth kettle whistled through the legal ID' };
    },
  );
  const res = await fetch(`${base}/gossip/refresh?count=1`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ count: 2 }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(calls, 1);
  assert.equal(body.refreshed, 1);
  assert.equal(body.tidbits.length, 1);
});

test('POST /gossip/refresh rejects an explicit invalid count', async () => {
  const { store } = await tempStore();
  const base = await start(store, stubAdapter({ personas: [PERSONA_A] }), async () => ({ rumor: 'unused' }));
  const res = await fetch(`${base}/gossip/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ count: 11 }),
  });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'refresh count must be an integer 1-10' });
});

test('POST /gossip/refresh returns 502 and leaves prior board and history on disk', async () => {
  const staleText = 'stale item must survive refresh failure';
  const priorHistory = [['Beta told Alpha, "prior generated gossip line"']];
  const { store, read } = await tempStore({
    tidbits: [tidbit({ text: staleText, hearerPersonaIds: null })],
    generatedGossipHistory: priorHistory,
  });
  const onAirRoles = { teller: PERSONA_A, hearers: [], targets: [] };
  const base = await start(
    store,
    stubAdapter({ personas: [PERSONA_A, PERSONA_B, PERSONA_C] }),
    async () => ({ rumor: 'short' }),
    () => onAirRoles,
  );
  const res = await fetch(`${base}/gossip/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ count: 1 }),
  });
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.match(body.error, /no complete station-wide hallway chain/);
  assert.ok(Array.isArray(body.rejected));
  const disk = await read();
  assert.equal(disk.tidbits.length, 1);
  assert.equal(disk.tidbits[0].text, staleText);
  assert.deepEqual(disk.generatedGossipHistory, priorHistory);
});

test('refresh penalizes recently used target pairs and distinctive props with deterministic role picks', async () => {
  const { store } = await tempStore({
    tidbits: [tidbit({
      id: 'old',
      canonicalTargetPersonaIds: [PERSONA_C.id],
      canonicalAnchors: { location: 'green room', ownerPersonaId: PERSONA_C.id, props: ['violet microphone'] },
    })],
  });
  const repeated = { teller: PERSONA_A, hearers: [], targets: [PERSONA_C] };
  const fresh = { teller: PERSONA_A, hearers: [], targets: [PERSONA_B] };
  let picks = 0;
  const base = await start(
    store,
    stubAdapter({ personas: [PERSONA_A, PERSONA_B, PERSONA_C] }),
    async ({ roles }) => ({
      rumor: roles.targets[0].id === PERSONA_B.id
        ? 'unconfirmed Beta moved a new cart into the green room'
        : 'unconfirmed Gamma moved a violet microphone into the green room',
      anchors: { props: roles.targets[0].id === PERSONA_B.id ? ['new cart'] : ['violet microphone'] },
    }),
    () => {
      picks += 1;
      return picks < 3 ? repeated : fresh;
    },
  );
  const res = await fetch(`${base}/gossip/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ count: 1 }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.tidbits[0].canonicalTargetPersonaIds, [PERSONA_B.id]);
  assert.deepEqual(body.tidbits[0].canonicalAnchors.props, ['new cart']);
});

test('RSS leaves a saturated thread out of the first item without changing its wire shape', async () => {
  const { store } = await tempStore({
    tidbits: [
      tidbit({ id: 'saturated', threadId: 'saturated', text: 'Saturated rumor', hearerPersonaIds: null, toldAt: ['2026-09-19T01:00:00.000Z', '2026-09-19T02:00:00.000Z', '2026-09-19T03:00:00.000Z'] }),
      tidbit({ id: 'fresh', threadId: 'fresh', text: 'Fresh rumor', hearerPersonaIds: null }),
    ],
  });
  const base = await start(store, stubAdapter({ personas: [PERSONA_A] }), async () => ({ rumor: 'unused' }), () => null);
  const res = await fetch(`${base}/gossip.rss?show=Test%20Show`);
  assert.equal(res.status, 200);
  const items = parseRssItems(await res.text());
  assert.deepEqual(items, [{ id: 'fresh', text: 'Fresh rumor' }]);
});
