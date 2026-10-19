import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { createLog } from '../src/log.js';
import { RUMOR_REGISTERS } from '../src/register.js';
import { rumorTargetSetKey } from '../src/roles.js';
import { seedUserPrompt } from '../src/llm.js';
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

test('seed attaches rumor summaries before generation', async () => {
  const { store } = await tempStore();
  const adapter = stubAdapter({ personas: [PERSONA_A, PERSONA_B, PERSONA_C] });
  let seenSoul = '';
  await seedGossip({
    store,
    adapter,
    pickRoles: () => hallway,
    summarizeSouls: async (personas) => {
      assert.equal(personas.length, 3);
      return personas.map((persona) => ({ id: persona.id, name: persona.name, summary: `${persona.name} pockets a fader` }));
    },
    generate: async ({ roles }) => {
      seenSoul = roles.teller.soul || '';
      assert.equal(roles.teller.rumorSummary, 'Alpha pockets a fader');
      assert.equal(roles.targets[0].rumorSummary, 'Gamma pockets a fader');
      const prompt = seedUserPrompt({ day: '2026-09-19', roles, register: RUMOR_REGISTERS[0] });
      assert.match(prompt, /Summary: Alpha pockets a fader/);
      assert.doesNotMatch(prompt, /Soul:/);
      return { rumor: 'word is Gamma hid a cart behind the legal ID again' };
    },
    cap: 1,
    historyGenerations: 0,
    now: new Date('2026-09-19T08:00:00.000Z'),
    timezone: 'UTC',
    log: { info() {}, warn() {} },
  });
  assert.equal(seenSoul.includes('pockets a fader'), false);
});

test('seed uses the summarized house rules in generation', async () => {
  const { store } = await tempStore();
  const adapter = stubAdapter({ personas: [PERSONA_A, PERSONA_B, PERSONA_C] });
  adapter.getHouseRules = async () => 'Full house rules about song transitions and the garbage boat.';
  let seenRules = '';
  await seedGossip({
    store,
    adapter,
    pickRoles: () => onAir,
    summarizeHouseRules: async (rules) => {
      assert.match(rules, /garbage boat/);
      return 'Garbage-boat station. Adult audience.';
    },
    generate: async ({ houseRules }) => {
      seenRules = houseRules;
      return { rumor: 'unconfirmed the booth kettle whistled through the legal ID' };
    },
    cap: 1,
    historyGenerations: 0,
    now: new Date('2026-09-19T08:00:00.000Z'),
    timezone: 'UTC',
    log: { info() {}, warn() {} },
  });
  assert.equal(seenRules, 'Garbage-boat station. Adult audience.');
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

test('seed threads session tidbits into generate for later rumors in the batch', async () => {
  const { store } = await tempStore();
  const sessionAtCall = [];
  await seedGossip({
    store,
    adapter: stubAdapter({ personas: [PERSONA_A, PERSONA_B, PERSONA_C] }),
    pickRoles: () => hallway,
    cap: 2,
    historyGenerations: 7,
    timezone: 'UTC',
    generate: async ({ sessionTidbits }) => {
      sessionAtCall.push([...sessionTidbits]);
      const n = sessionAtCall.length;
      return { rumor: `word is Gamma swapped booth prop number ${n} behind the legal ID` };
    },
    log: { info() {}, warn() {} },
  });
  assert.deepEqual(sessionAtCall[0], []);
  assert.equal(sessionAtCall[1].length, 1);
  assert.match(sessionAtCall[1][0], /prop number 1/);
});

test('seed adds stronger beat-variety steering when mocks repeat the same stunt shape', async () => {
  const { store } = await tempStore();
  let calls = 0;
  const roles = hallway;
  const register = RUMOR_REGISTERS[0];
  await seedGossip({
    store,
    adapter: stubAdapter({ personas: [PERSONA_A, PERSONA_B, PERSONA_C] }),
    pickRoles: () => roles,
    pickRegister: () => register,
    cap: 2,
    historyGenerations: 7,
    timezone: 'UTC',
    generate: async ({ existing, sessionTidbits, day }) => {
      calls += 1;
      if (sessionTidbits.length > 0) {
        const prompt = seedUserPrompt({ day, roles, register, existing, sessionTidbits });
        assert.doesNotMatch(prompt, /Session beat variety/i);
        assert.doesNotMatch(prompt, /superglued the kettle shut/i);
      }
      const rumor = calls === 1
        ? 'word is Gamma superglued the kettle shut'
        : 'word is Gamma also epoxied the kettle lid for good measure';
      return { rumor };
    },
    log: { info() {}, warn() {} },
  });
  assert.equal(calls, 2);
});

test('reviewRounds 0 does not call generateReview', async () => {
  const { store } = await tempStore();
  let reviewCalls = 0;
  await seedGossip({
    store,
    adapter: stubAdapter({ personas: [PERSONA_A, PERSONA_B, PERSONA_C] }),
    pickRoles: () => hallway,
    cap: 1,
    historyGenerations: 7,
    reviewRounds: 0,
    generateReview: async () => {
      reviewCalls += 1;
      return { rumors: {} };
    },
    generate: async () => ({ rumor: 'word is Gamma hid a cart behind the legal ID again' }),
    log: { info() {}, warn() {} },
  });
  assert.equal(reviewCalls, 0);
});

test('seed review updates quoted rumor while preserving teller and hearer ids', async () => {
  const { store, read } = await tempStore();
  const revised = 'word is Gamma stashed a dead cart behind the legal ID for laughs';
  await seedGossip({
    store,
    adapter: stubAdapter({ personas: [PERSONA_A, PERSONA_B, PERSONA_C] }),
    pickRoles: () => hallway,
    cap: 1,
    historyGenerations: 7,
    reviewRounds: 1,
    generate: async () => ({ rumor: 'word is Gamma hid a cart behind the legal ID again' }),
    generateReview: async ({ tidbits }) => ({
      rumors: { [tidbits[0].id]: revised },
    }),
    log: { info() {}, warn() {} },
  });
  const state = await read();
  assert.equal(state.tidbits[0].tellerPersonaId, PERSONA_A.id);
  assert.deepEqual(state.tidbits[0].hearerPersonaIds, [PERSONA_B.id]);
  assert.equal(state.tidbits[0].text, `Alpha told Beta, "${revised}"`);
});

test('seed review keeps prior rumor when validation rejects a revision', async () => {
  const { store, read } = await tempStore();
  const original = 'word is Gamma hid a cart behind the legal ID again';
  await seedGossip({
    store,
    adapter: stubAdapter({ personas: [PERSONA_A, PERSONA_B, PERSONA_C] }),
    pickRoles: () => hallway,
    cap: 1,
    historyGenerations: 7,
    reviewRounds: 1,
    generate: async () => ({ rumor: original }),
    generateReview: async ({ tidbits }) => ({
      rumors: { [tidbits[0].id]: 'string' },
    }),
    log: { info() {}, warn() {} },
  });
  const state = await read();
  assert.equal(state.tidbits[0].text, `Alpha told Beta, "${original}"`);
});

test('seed review chains multiple rounds on accepted text', async () => {
  const { store, read } = await tempStore();
  const roundTwo = 'word is Gamma rerouted the legal ID through a dead cart loop';
  let round = 0;
  await seedGossip({
    store,
    adapter: stubAdapter({ personas: [PERSONA_A, PERSONA_B, PERSONA_C] }),
    pickRoles: () => hallway,
    cap: 1,
    historyGenerations: 7,
    reviewRounds: 2,
    generate: async () => ({ rumor: 'word is Gamma hid a cart behind the legal ID again' }),
    generateReview: async ({ tidbits }) => {
      round += 1;
      if (round === 1) {
        return { rumors: { [tidbits[0].id]: 'word is Gamma stashed a dead cart behind the legal ID for laughs' } };
      }
      return { rumors: { [tidbits[0].id]: roundTwo } };
    },
    log: { info() {}, warn() {} },
  });
  assert.equal(round, 2);
  const state = await read();
  assert.equal(state.tidbits[0].text, `Alpha told Beta, "${roundTwo}"`);
});

test('refresh review updates board text before history and comment pruning', async () => {
  const priorGenerated = 'Beta told Alpha, "unconfirmed Gamma coughed a cart that was only static"';
  const revised = 'unconfirmed the booth kettle whistled through a revised legal ID slot';
  const { store, read } = await tempStore({
    tidbits: [tidbit({ id: 'stale', text: 'stale board item', hearerPersonaIds: null })],
    generatedGossipHistory: [[priorGenerated]],
    gossipComments: [
      { id: 'orphan', tidbitId: 'stale', actorPersonaId: 'p_a', commentedAt: '2026-09-18T10:00:00.000Z' },
    ],
  });
  await refreshGossip({
    store,
    adapter: stubAdapter({ personas: [PERSONA_A, PERSONA_B, PERSONA_C] }),
    pickRoles: () => onAir,
    cap: 1,
    historyGenerations: 7,
    reviewRounds: 1,
    generate: async () => ({ rumor: 'unconfirmed the booth kettle whistled through the legal ID' }),
    generateReview: async ({ tidbits }) => ({
      rumors: { [tidbits[0].id]: revised },
    }),
    log: { info() {}, warn() {} },
  });
  const state = await read();
  assert.deepEqual(state.gossipComments, []);
  assert.equal(state.tidbits[0].text, `Alpha said on air, "${revised}"`);
  assert.deepEqual(state.generatedGossipHistory.at(-1), [`Alpha said on air, "${revised}"`]);
});

test('review stops further rounds when generateReview throws', async () => {
  const { store, read } = await tempStore();
  let round = 0;
  const kept = 'word is Gamma hid a cart behind the legal ID again';
  await seedGossip({
    store,
    adapter: stubAdapter({ personas: [PERSONA_A, PERSONA_B, PERSONA_C] }),
    pickRoles: () => hallway,
    cap: 1,
    historyGenerations: 7,
    reviewRounds: 3,
    generate: async () => ({ rumor: kept }),
    generateReview: async () => {
      round += 1;
      if (round === 1) {
        return { rumors: { __missing__: 'word is Gamma stashed a dead cart behind the legal ID for laughs' } };
      }
      throw new Error('network down');
    },
    log: { info() {}, warn() {} },
  });
  assert.equal(round, 2);
  const state = await read();
  assert.equal(state.tidbits[0].text, `Alpha told Beta, "${kept}"`);
});

test('review rejects revisions that collapse two tidbits to identical text', async () => {
  const { store, read } = await tempStore();
  const rumorA = 'word is Gamma hid a cart behind the legal ID again';
  const rumorB = 'word is Gamma taped a dead cart over the legal ID bumper';
  let ids = [];
  let generates = 0;
  await seedGossip({
    store,
    adapter: stubAdapter({ personas: [PERSONA_A, PERSONA_B, PERSONA_C] }),
    pickRoles: () => hallway,
    cap: 2,
    historyGenerations: 7,
    reviewRounds: 1,
    generate: async () => {
      generates += 1;
      return { rumor: generates === 1 ? rumorA : rumorB };
    },
    generateReview: async ({ tidbits }) => {
      ids = tidbits.map((t) => t.id);
      const shared = 'word is Gamma rerouted the legal ID through a shared dead cart loop';
      return { rumors: { [ids[0]]: shared, [ids[1]]: shared } };
    },
    log: { info() {}, warn() {} },
  });
  const shared = 'word is Gamma rerouted the legal ID through a shared dead cart loop';
  const state = await read();
  assert.equal(state.tidbits.length, 2);
  assert.equal(state.tidbits[0].text, `Alpha told Beta, "${shared}"`);
  assert.equal(state.tidbits[1].text, `Alpha told Beta, "${rumorB}"`);
});

test('seed appends generated history from post-review tidbit text', async () => {
  const { store, read } = await tempStore();
  const revised = 'word is Gamma stashed a dead cart behind the legal ID for laughs';
  await seedGossip({
    store,
    adapter: stubAdapter({ personas: [PERSONA_A, PERSONA_B, PERSONA_C] }),
    pickRoles: () => hallway,
    cap: 1,
    historyGenerations: 7,
    reviewRounds: 1,
    generate: async () => ({ rumor: 'word is Gamma hid a cart behind the legal ID again' }),
    generateReview: async ({ tidbits }) => ({
      rumors: { [tidbits[0].id]: revised },
    }),
    log: { info() {}, warn() {} },
  });
  const state = await read();
  assert.deepEqual(state.generatedGossipHistory.at(-1), [`Alpha told Beta, "${revised}"`]);
});

test('refresh threads session tidbits the same way as seed', async () => {
  const { store } = await tempStore();
  const sessionAtCall = [];
  await refreshGossip({
    store,
    adapter: stubAdapter({ personas: [PERSONA_A, PERSONA_B, PERSONA_C] }),
    pickRoles: () => hallway,
    cap: 2,
    historyGenerations: 7,
    timezone: 'UTC',
    generate: async ({ sessionTidbits }) => {
      sessionAtCall.push([...sessionTidbits]);
      const n = sessionAtCall.length;
      return { rumor: `word is Gamma rerouted cart ${n} through the legal ID` };
    },
    log: { info() {}, warn() {} },
  });
  assert.equal(sessionAtCall.length, 2);
  assert.deepEqual(sessionAtCall[0], []);
  assert.equal(sessionAtCall[1].length, 1);
});

function assertSingleLineGossipOperationalLog(operational) {
  const physicalLines = operational.split('\n').filter((line) => line.length > 0);
  for (const line of physicalLines) {
    assert.match(line, /^\[gossip\]/);
    assert.equal(line.includes('\n'), false);
  }
  return physicalLines;
}

test('seedGossip echoes accepted tidbit text to the operational log', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'gossip-seed-echo-'));
  const operationalLogPath = path.join(base, 'logs', 'gossip.log');
  const log = createLog(operationalLogPath);
  const rumor = 'word is Gamma hid a cart behind the legal ID again';
  const { store } = await tempStore();
  await seedGossip({
    store,
    adapter: stubAdapter({ personas: [PERSONA_A, PERSONA_B, PERSONA_C] }),
    pickRoles: () => hallway,
    cap: 1,
    historyGenerations: 7,
    generate: async () => ({ rumor }),
    log,
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  const physicalLines = assertSingleLineGossipOperationalLog(await readFile(operationalLogPath, 'utf8'));
  assert.ok(physicalLines.some((line) => line.includes('tidbit accepted') && line.includes(rumor)));
  assert.ok(!physicalLines.some((line) => line.includes('House rules')));
});

test('seed review echoes rumor before and after when revision changes text', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'gossip-review-echo-'));
  const operationalLogPath = path.join(base, 'logs', 'gossip.log');
  const log = createLog(operationalLogPath);
  const original = 'word is Gamma hid a cart behind the legal ID again';
  const revised = 'word is Gamma stashed a dead cart behind the legal ID for laughs';
  const { store } = await tempStore();
  await seedGossip({
    store,
    adapter: stubAdapter({ personas: [PERSONA_A, PERSONA_B, PERSONA_C] }),
    pickRoles: () => hallway,
    cap: 1,
    historyGenerations: 7,
    reviewRounds: 1,
    generate: async () => ({ rumor: original }),
    generateReview: async ({ tidbits }) => ({
      rumors: { [tidbits[0].id]: revised },
    }),
    log,
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  const physicalLines = assertSingleLineGossipOperationalLog(await readFile(operationalLogPath, 'utf8'));
  assert.ok(
    physicalLines.some(
      (line) => line.includes('review revised') && line.includes(original) && line.includes(revised) && line.includes('round=1'),
    ),
  );
});

test('seed review does not echo per-tidbit line when revision leaves text unchanged', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'gossip-review-unchanged-'));
  const operationalLogPath = path.join(base, 'logs', 'gossip.log');
  const log = createLog(operationalLogPath);
  const rumor = 'word is Gamma hid a cart behind the legal ID again';
  const { store } = await tempStore();
  await seedGossip({
    store,
    adapter: stubAdapter({ personas: [PERSONA_A, PERSONA_B, PERSONA_C] }),
    pickRoles: () => hallway,
    cap: 1,
    historyGenerations: 7,
    reviewRounds: 1,
    generate: async () => ({ rumor }),
    generateReview: async ({ tidbits }) => ({
      rumors: { [tidbits[0].id]: rumor },
    }),
    log,
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  const physicalLines = assertSingleLineGossipOperationalLog(await readFile(operationalLogPath, 'utf8'));
  assert.ok(physicalLines.some((line) => line.includes('tidbit accepted')));
  assert.ok(!physicalLines.some((line) => line.includes('review revised')));
});
