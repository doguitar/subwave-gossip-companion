import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RUMOR_REGISTERS } from '../src/register.js';
import { rumorTargetSetKey } from '../src/roles.js';
import { classifyStuntMotif, STUNT_MOTIF_ATTACHED_SIGNAGE } from '../src/validate.js';
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

test('seed accepts at most one attached-signage rumor per session when mocks repeat motifs', async () => {
  const { store, read } = await tempStore();
  const adapter = stubAdapter({ personas: [PERSONA_A, PERSONA_B, PERSONA_C] });
  const signage =
    'word is Gamma laminated a fake compliance sticker on the legal ID cart';
  const neutralA = 'word is Gamma hid the booth kettle behind the legal ID cart again tonight';
  const neutralB = 'word is Gamma coughed a dead cart over the legal ID during the weather break';
  let calls = 0;
  const warns = [];
  const result = await seedGossip({
    store,
    adapter,
    pickRoles: () => hallway,
    cap: 3,
    historyGenerations: 7,
    timezone: 'UTC',
    generate: async () => {
      calls += 1;
      if (calls === 1 || calls === 2) return { rumor: signage };
      if (calls === 3) return { rumor: neutralA };
      return { rumor: neutralB };
    },
    log: { info() {}, warn: (msg) => warns.push(msg) },
  });
  assert.equal(result.seeded, 3);
  const state = await read();
  const quotes = state.tidbits.map((t) => t.text.match(/"([^"]*)"/)?.[1] ?? '');
  const signageCount = quotes.filter((q) => classifyStuntMotif(q) === STUNT_MOTIF_ATTACHED_SIGNAGE).length;
  assert.equal(signageCount, 1);
  assert.ok(warns.some((w) => /duplicate-stunt-motif/.test(w)));
});

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
    historyGenerations: 7,
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
    historyGenerations: 7,
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
  const registers = [];
  const fixedRegister = RUMOR_REGISTERS[2];
  const result = await refreshGossip({
    store,
    adapter: stubAdapter({ personas: [PERSONA_A, PERSONA_B, PERSONA_C] }),
    pickRoles: () => onAir,
    pickRegister: () => fixedRegister,
    generate: async ({ register }) => {
      attempts += 1;
      registers.push(register);
      return { rumor: attempts === 1 ? 'string' : 'unconfirmed the booth kettle whistled twice' };
    },
    cap: 1,
    historyGenerations: 7,
    timezone: 'UTC',
    log: { info() {}, warn() {} },
  });
  assert.equal(attempts, 2);
  assert.equal(result.refreshed, 1);
  assert.deepEqual(registers, [fixedRegister, fixedRegister]);
});

test('seed passes a register on every generate call for each new rumor', async () => {
  const { store } = await tempStore();
  const seenRegisters = [];
  const pickRegister = (() => {
    let i = 0;
    return () => RUMOR_REGISTERS[i++ % RUMOR_REGISTERS.length];
  })();
  const result = await seedGossip({
    store,
    adapter: stubAdapter({ personas: [PERSONA_A, PERSONA_B, PERSONA_C] }),
    pickRoles: () => onAir,
    pickRegister,
    cap: 2,
    historyGenerations: 7,
    timezone: 'UTC',
    generate: async ({ register }) => {
      seenRegisters.push(register.id);
      return { rumor: `unconfirmed station kettle remembers register ${register.id} tonight` };
    },
    log: { info() {}, warn() {} },
  });
  assert.equal(result.seeded, 2);
  assert.equal(seenRegisters.length, 2);
  assert.notEqual(seenRegisters[0], seenRegisters[1]);
});

test('seed retries rate limits indefinitely and preserves earlier tidbits', async () => {
  const { store } = await tempStore();
  let calls = 0;
  const result = await seedGossip({
    store,
    adapter: stubAdapter({ personas: [PERSONA_A, PERSONA_B] }),
    pickRoles: () => onAir,
    cap: 2,
    historyGenerations: 7,
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
  const seen = new Set();
  const rumorTargets = new Set();
  const result = await refreshGossip({
    store,
    adapter,
    generate: async ({ roles }) => {
      seen.add(roles.teller.id);
      roles.hearers.forEach((p) => seen.add(p.id));
      roles.targets.forEach((p) => rumorTargets.add(p.id));
      const targets = roles.targets.map((p) => p.name).join(' ');
      return { rumor: `unconfirmed station kettle remembers ${targets || 'the cart'} tonight` };
    },
    cap: 1,
    historyGenerations: 7,
    timezone: 'UTC',
    log: { info() {}, warn() {} },
  });
  assert.ok(result.refreshed >= 1);
  assert.deepEqual([...seen].sort(), ['p_a', 'p_b', 'p_c']);
  assert.deepEqual([...rumorTargets].sort(), ['p_a', 'p_b', 'p_c']);
});

test('default refresh fails when rumor targets never cover the roster', async () => {
  const { store } = await tempStore();
  await assert.rejects(
    () => refreshGossip({
      store,
      adapter: stubAdapter({ personas: [PERSONA_A] }),
      generate: async () => ({ rumor: 'unconfirmed the booth kettle whistled through the legal ID twice' }),
      cap: 1,
      historyGenerations: 7,
      timezone: 'UTC',
      log: { info() {}, warn() {} },
    }),
    (err) => err.status === 502 && err.targetCovered === 0 && err.roster === 1 && err.targetIncomplete === true,
  );
});

test('injected pickRoles refresh does not require rumor-target coverage', async () => {
  const { store } = await tempStore();
  const result = await refreshGossip({
    store,
    adapter: stubAdapter({ personas: [PERSONA_A, PERSONA_B, PERSONA_C] }),
    pickRoles: () => onAir,
    cap: 1,
    historyGenerations: 7,
    timezone: 'UTC',
    generate: async () => ({ rumor: 'unconfirmed the booth kettle whistled through the legal ID' }),
    log: { info() {}, warn() {} },
  });
  assert.equal(result.refreshed, 1);
});

test('seed prompts with generated history only and appends a new batch', async () => {
  const priorGenerated = 'Alpha told Beta, "word is Gamma hid a cart behind the legal ID again"';
  const onAirText = 'Alpha said on air, "booth whisper that must not enter the prompt"';
  const { store, read } = await tempStore({
    tidbits: [tidbit({ text: onAirText, hearerPersonaIds: null })],
    generatedGossipHistory: [[priorGenerated]],
  });
  const seenExisting = [];
  const result = await seedGossip({
    store,
    adapter: stubAdapter({ personas: [PERSONA_A, PERSONA_B, PERSONA_C] }),
    pickRoles: () => hallway,
    cap: 1,
    historyGenerations: 7,
    now: new Date('2026-09-20T08:00:00.000Z'),
    timezone: 'UTC',
    generate: async ({ existing }) => {
      seenExisting.push([...existing]);
      return { rumor: 'word is Gamma taped a dead cart over the legal ID' };
    },
    log: { info() {}, warn() {} },
  });
  assert.equal(result.seeded, 1);
  assert.deepEqual(seenExisting, [[priorGenerated]]);
  assert.ok(!seenExisting[0].includes(onAirText));
  const state = await read();
  const wrapped = 'Alpha told Beta, "word is Gamma taped a dead cart over the legal ID"';
  assert.deepEqual(state.generatedGossipHistory, [[priorGenerated], [wrapped]]);
  assert.ok(state.tidbits.some((t) => t.text === onAirText));
  assert.ok(state.tidbits.some((t) => t.text === wrapped));
});

test('refresh clears tidbits but preserves history until the new batch appends', async () => {
  const priorGenerated = 'Beta told Alpha, "unconfirmed Gamma coughed a cart that was only static"';
  const { store, read } = await tempStore({
    tidbits: [tidbit({ text: 'stale board item', hearerPersonaIds: null })],
    generatedGossipHistory: [[priorGenerated]],
  });
  const seenExisting = [];
  const result = await refreshGossip({
    store,
    adapter: stubAdapter({ personas: [PERSONA_A, PERSONA_B, PERSONA_C] }),
    pickRoles: () => onAir,
    cap: 1,
    historyGenerations: 7,
    timezone: 'UTC',
    generate: async ({ existing }) => {
      seenExisting.push([...existing]);
      return { rumor: 'unconfirmed the booth kettle whistled through the legal ID' };
    },
    log: { info() {}, warn() {} },
  });
  assert.equal(result.refreshed, 1);
  assert.deepEqual(seenExisting, [[priorGenerated]]);
  const state = await read();
  assert.equal(state.tidbits.length, 1);
  assert.ok(!state.tidbits.some((t) => t.text === 'stale board item'));
  const wrapped = 'Alpha said on air, "unconfirmed the booth kettle whistled through the legal ID"';
  assert.deepEqual(state.generatedGossipHistory, [[priorGenerated], [wrapped]]);
});

test('successful refresh prunes gossip comments that reference removed tidbits', async () => {
  const priorGenerated = 'Beta told Alpha, "unconfirmed Gamma coughed a cart that was only static"';
  const { store, read } = await tempStore({
    tidbits: [
      tidbit({ id: 'stale-a', text: 'stale board item', hearerPersonaIds: null }),
      tidbit({ id: 'stale-b', text: 'another stale item', hearerPersonaIds: null }),
    ],
    generatedGossipHistory: [[priorGenerated]],
    gossipComments: [
      { id: 'orphan-1', tidbitId: 'stale-a', actorPersonaId: 'p_a', commentedAt: '2026-09-18T10:00:00.000Z' },
      { id: 'orphan-2', tidbitId: 'stale-b', actorPersonaId: 'p_b', show: 'Test Show', commentedAt: '2026-09-18T11:00:00.000Z' },
      { id: 'orphan-3', tidbitId: 'missing', actorPersonaId: 'p_c', commentedAt: '2026-09-18T12:00:00.000Z' },
    ],
  });
  const result = await refreshGossip({
    store,
    adapter: stubAdapter({ personas: [PERSONA_A, PERSONA_B, PERSONA_C] }),
    pickRoles: () => onAir,
    cap: 1,
    historyGenerations: 7,
    timezone: 'UTC',
    generate: async () => ({ rumor: 'unconfirmed the booth kettle whistled through the legal ID' }),
    log: { info() {}, warn() {} },
  });
  assert.equal(result.refreshed, 1);
  const state = await read();
  assert.deepEqual(state.gossipComments, []);
  const wrapped = 'Alpha said on air, "unconfirmed the booth kettle whistled through the legal ID"';
  assert.deepEqual(state.generatedGossipHistory, [[priorGenerated], [wrapped]]);
});

test('failed refresh leaves gossip comments unchanged', async () => {
  const { store, read } = await tempStore({
    tidbits: [tidbit({ id: 'old', text: 'old news', hearerPersonaIds: null })],
    gossipComments: [
      { id: 'keep-me', tidbitId: 'old', actorPersonaId: 'p_a', commentedAt: '2026-09-19T00:00:00.000Z' },
    ],
  });
  await assert.rejects(
    () => refreshGossip({
      store,
      adapter: stubAdapter({ personas: [PERSONA_A, PERSONA_B, PERSONA_C] }),
      pickRoles: () => onAir,
      generate: async () => ({ rumor: 'short' }),
      cap: 1,
      historyGenerations: 7,
      timezone: 'UTC',
      log: { info() {}, warn() {} },
    }),
    (err) => err.status === 502,
  );
  const state = await read();
  assert.equal(state.gossipComments.length, 1);
  assert.equal(state.gossipComments[0].id, 'keep-me');
  assert.equal(state.gossipComments[0].tidbitId, 'old');
});

test('refresh resamples when an accepted rumor would repeat the same target set', async () => {
  const { store } = await tempStore();
  const targetPair = {
    teller: PERSONA_A,
    hearers: [PERSONA_B],
    targets: [PERSONA_C],
  };
  const otherTarget = {
    teller: PERSONA_A,
    hearers: [PERSONA_B],
    targets: [],
  };
  const pickQueue = [targetPair, targetPair, otherTarget];
  let pickIndex = 0;
  const acceptedTargetKeys = [];
  const result = await refreshGossip({
    store,
    adapter: stubAdapter({ personas: [PERSONA_A, PERSONA_B, PERSONA_C] }),
    pickRoles: () => pickQueue[Math.min(pickIndex++, pickQueue.length - 1)],
    cap: 2,
    historyGenerations: 7,
    timezone: 'UTC',
    generate: async ({ roles }) => {
      const key = rumorTargetSetKey(roles.targets);
      acceptedTargetKeys.push(key);
      const names = roles.targets.map((p) => p.name).join(' ');
      const rumor = names
        ? `unconfirmed ${names} hid a cart behind the legal ID twice`
        : 'unconfirmed the booth kettle whistled through the legal ID';
      return { rumor };
    },
    log: { info() {}, warn() {} },
  });
  assert.equal(result.refreshed, 2);
  assert.deepEqual(acceptedTargetKeys, ['p_c', '(empty)']);
});

test('refresh treats target sets as order-independent', async () => {
  const { store } = await tempStore();
  const pairOne = {
    teller: PERSONA_A,
    hearers: [],
    targets: [PERSONA_B, PERSONA_C],
  };
  const pairTwo = {
    teller: PERSONA_A,
    hearers: [],
    targets: [PERSONA_C, PERSONA_B],
  };
  const singleton = {
    teller: PERSONA_A,
    hearers: [],
    targets: [PERSONA_B],
  };
  const pickQueue = [pairOne, pairTwo, singleton];
  let pickIndex = 0;
  const acceptedTargetKeys = [];
  await refreshGossip({
    store,
    adapter: stubAdapter({ personas: [PERSONA_A, PERSONA_B, PERSONA_C] }),
    pickRoles: () => pickQueue[Math.min(pickIndex++, pickQueue.length - 1)],
    cap: 2,
    historyGenerations: 7,
    timezone: 'UTC',
    generate: async ({ roles }) => {
      const key = rumorTargetSetKey(roles.targets);
      acceptedTargetKeys.push(key);
      const names = roles.targets.map((p) => p.name).join(' and ');
      return { rumor: `unconfirmed ${names} hid a cart behind the legal ID twice` };
    },
    log: { info() {}, warn() {} },
  });
  assert.deepEqual(acceptedTargetKeys, ['p_b,p_c', 'p_b']);
});

test('refresh allows at most one empty-target rumor when alternatives exist', async () => {
  const { store } = await tempStore();
  const pickQueue = [onAir, onAir, hallway];
  let pickIndex = 0;
  const acceptedTargetKeys = [];
  await refreshGossip({
    store,
    adapter: stubAdapter({ personas: [PERSONA_A, PERSONA_B, PERSONA_C] }),
    pickRoles: () => pickQueue[Math.min(pickIndex++, pickQueue.length - 1)],
    cap: 2,
    historyGenerations: 7,
    timezone: 'UTC',
    generate: async ({ roles }) => {
      const key = rumorTargetSetKey(roles.targets);
      acceptedTargetKeys.push(key);
      const names = roles.targets.map((p) => p.name).join(' ');
      const rumor = names
        ? `unconfirmed ${names} hid a cart behind the legal ID twice`
        : 'unconfirmed the booth kettle whistled through the legal ID';
      return { rumor };
    },
    log: { info() {}, warn() {} },
  });
  assert.deepEqual(acceptedTargetKeys, ['(empty)', 'p_c']);
});

test('refresh does not reserve a target set when generation fails', async () => {
  const { store } = await tempStore();
  let generateCalls = 0;
  const acceptedTargetKeys = [];
  const result = await refreshGossip({
    store,
    adapter: stubAdapter({ personas: [PERSONA_A, PERSONA_B, PERSONA_C] }),
    pickRoles: () => hallway,
    cap: 2,
    historyGenerations: 7,
    timezone: 'UTC',
    generate: async ({ roles }) => {
      generateCalls += 1;
      if (generateCalls === 1) return { rumor: 'short' };
      acceptedTargetKeys.push(rumorTargetSetKey(roles.targets));
      return { rumor: 'unconfirmed Gamma hid a cart behind the legal ID twice' };
    },
    log: { info() {}, warn() {} },
  });
  assert.equal(result.refreshed, 2);
  assert.deepEqual(acceptedTargetKeys, ['p_c', 'p_c']);
});

test('historyGenerations 0 sends empty existing history and clears persisted history', async () => {
  const priorGenerated = 'Alpha told Beta, "word is Gamma hid a cart behind the legal ID again"';
  const { store, read } = await tempStore({
    generatedGossipHistory: [[priorGenerated]],
  });
  const seenExisting = [];
  const result = await refreshGossip({
    store,
    adapter: stubAdapter({ personas: [PERSONA_A, PERSONA_B, PERSONA_C] }),
    pickRoles: () => onAir,
    cap: 1,
    historyGenerations: 0,
    timezone: 'UTC',
    generate: async ({ existing }) => {
      seenExisting.push([...existing]);
      return { rumor: 'unconfirmed the booth kettle whistled twice tonight' };
    },
    log: { info() {}, warn() {} },
  });
  assert.equal(result.refreshed, 1);
  assert.deepEqual(seenExisting, [[]]);
  const state = await read();
  assert.deepEqual(state.generatedGossipHistory, []);
});
