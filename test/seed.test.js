import assert from 'node:assert/strict';
import { test } from 'node:test';
import { refreshGossip, seedGossip } from '../src/seed.js';
import { PERSONA_A, PERSONA_B, PERSONA_C, stubAdapter, tempStore, tidbit } from './helpers.js';

const hallway = {
  teller: PERSONA_A,
  hearers: [PERSONA_B],
  targets: [PERSONA_C],
};

const onAir = {
  teller: PERSONA_A,
  hearers: [],
  targets: [],
};

test('seed uses pre-picked roles and skips duplicate rumor wraps', async () => {
  const { store, read } = await tempStore();
  const adapter = stubAdapter({ personas: [PERSONA_A, PERSONA_B, PERSONA_C] });
  const generate = async ({ roles }) => {
    assert.equal(roles.teller.id, PERSONA_A.id);
    return { rumor: 'word is Gamma hid a cart behind the legal ID again' };
  };

  const first = await seedGossip({
    store,
    adapter,
    generate,
    pickRoles: () => hallway,
    cap: 2,
    now: new Date('2026-09-19T08:00:00.000Z'),
    timezone: 'UTC',
    log: { info() {}, warn() {} },
  });
  assert.equal(first.seeded, 1);
  const state = await read();
  assert.equal(state.tidbits.length, 1);
  assert.equal(
    state.tidbits[0].text,
    'Alpha told Beta, "word is Gamma hid a cart behind the legal ID again"',
  );
  assert.deepEqual(state.tidbits[0].hearerPersonaIds, [PERSONA_B.id]);
});

test('refresh replaces the board; zero hearers become said-on-air', async () => {
  const { store, read } = await tempStore({
    tidbits: [tidbit({ text: 'old news', hearerPersonaIds: null })],
  });
  const adapter = stubAdapter({ personas: [PERSONA_A, PERSONA_B, PERSONA_C] });
  const result = await refreshGossip({
    store,
    adapter,
    pickRoles: () => onAir,
    generate: async ({ roles }) => {
      assert.equal(roles.hearers.length, 0);
      return { rumor: 'unconfirmed the booth kettle whistled through the legal ID' };
    },
    cap: 1,
    now: new Date('2026-09-19T18:00:00.000Z'),
    timezone: 'UTC',
    log: { info() {}, warn() {} },
  });
  assert.equal(result.refreshed, 1);
  const state = await read();
  assert.equal(state.tidbits.length, 1);
  assert.equal(
    state.tidbits[0].text,
    'Alpha said on air, "unconfirmed the booth kettle whistled through the legal ID"',
  );
  assert.equal(state.tidbits[0].hearerPersonaIds, null);
  assert.ok(!state.tidbits.some((t) => t.text === 'old news'));
});

test('refresh retries rejected model output before failing', async () => {
  const { store } = await tempStore();
  let attempts = 0;
  const result = await refreshGossip({
    store,
    adapter: stubAdapter({ personas: [PERSONA_A, PERSONA_B, PERSONA_C] }),
    pickRoles: () => onAir,
    generate: async () => {
      attempts += 1;
      return { rumor: attempts === 1 ? 'string' : 'unconfirmed the booth kettle whistled twice' };
    },
    cap: 1,
    timezone: 'UTC',
    log: { info() {}, warn() {} },
  });
  assert.equal(attempts, 2);
  assert.equal(result.refreshed, 1);
});

test('seed retries rate limits indefinitely and preserves earlier tidbits', async () => {
  const { store } = await tempStore();
  let calls = 0;
  const result = await seedGossip({
    store,
    adapter: stubAdapter({ personas: [PERSONA_A, PERSONA_B] }),
    pickRoles: () => onAir,
    cap: 2,
    timezone: 'UTC',
    sleep: async () => {},
    generate: async () => {
      calls += 1;
      if (calls === 2) {
        const error = new Error('rate limited');
        error.status = 429;
        throw error;
      }
      return { rumor: `unconfirmed station item ${calls}` };
    },
    log: { info() {}, warn() {} },
  });
  assert.equal(result.seeded, 2);
  assert.equal(store.snapshot().tidbits.length, 2);
  assert.equal(calls, 3);
});

test('default refresh chains until every persona participates', async () => {
  const { store } = await tempStore();
  const adapter = stubAdapter({ personas: [PERSONA_A, PERSONA_B, PERSONA_C] });
  let priorHearers = [];
  const seen = new Set();
  const result = await refreshGossip({
    store,
    adapter,
    generate: async ({ roles }) => {
      assert.equal(roles.hearers.some((p) => priorHearers.includes(p.id)), false);
      priorHearers = roles.hearers.map((p) => p.id);
      seen.add(roles.teller.id);
      roles.hearers.forEach((p) => seen.add(p.id));
      const targets = roles.targets.map((p) => p.name).join(' ');
      return { rumor: `unconfirmed station kettle remembers ${targets || 'the cart'} tonight` };
    },
    cap: 1,
    timezone: 'UTC',
    log: { info() {}, warn() {} },
  });
  assert.ok(result.refreshed >= 1);
  assert.deepEqual([...seen].sort(), ['p_a', 'p_b', 'p_c']);
});
