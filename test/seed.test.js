import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { createLog } from '../src/log.js';
import { RUMOR_REGISTERS } from '../src/register.js';
import { rumorTargetSetKey } from '../src/roles.js';
import { seedUserPrompt } from '../src/llm.js';
import { RATE_LIMIT_ATTEMPTS, rateLimitDelayMs, refreshGossip, seedGossip } from '../src/seed.js';
import { appendGeneratedGossipHistory, recordGossipComment, recordTidbitTelling } from '../src/store.js';
import { PERSONA_A, PERSONA_B, PERSONA_C, runGossipAction, stubAdapter, tempStore, tidbit } from './helpers.js';

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

test('seed refuses sensitive rumors and does not store them', async () => {
  const rumors = [
    'Gamma mailed the booth note to gamma@example.com before air',
    'Gamma called the booth from 415-555-0199 before air',
    'Gamma wrote 123-45-6789 on the booth form before air',
  ];
  for (const rumor of rumors) {
    const { store } = await tempStore();
    const reasons = [];
    const result = await seedGossip({
      store,
      adapter: stubAdapter({ personas: [PERSONA_A, PERSONA_B, PERSONA_C] }),
      pickRoles: () => hallway,
      cap: 1,
      historyGenerations: 0,
      timezone: 'UTC',
      generate: async () => ({ rumor }),
      log: { info() {}, warn(line) { reasons.push(line); } },
    });
    assert.equal(result.seeded, 0);
    assert.equal(result.rejected, 1);
    assert.equal(store.snapshot().tidbits.length, 0);
    assert.equal(reasons.filter((line) => line.includes('sensitive')).length, 3);
  }
});

test('seed never pairs constrained registers with mismatched rumor-target counts', async () => {
  const { store } = await tempStore();
  const rumorRegisters = [
    { id: 'station-life', name: 'station life', guidance: 'g0', targetCount: 0 },
    { id: 'feud', name: 'feud', guidance: 'g2', targetCount: 2 },
    { id: 'open', name: 'open', guidance: 'gany' },
  ];
  const pairs = [];
  let n = 0;
  const result = await seedGossip({
    store,
    adapter: stubAdapter({ personas: [PERSONA_A, PERSONA_B, PERSONA_C] }),
    rumorRegisters,
    pickRoles: () => hallway,
    cap: 3,
    historyGenerations: 0,
    timezone: 'UTC',
    generate: async ({ register, roles }) => {
      n += 1;
      pairs.push({ registerId: register.id, targetLen: roles.targets.length });
      const targetName = roles.targets[0]?.name || 'the cart';
      return { rumor: `unconfirmed ${targetName} and register ${register.id} rumor ${n} tonight` };
    },
    log: { info() {}, warn() {} },
  });
  assert.equal(result.seeded, 3);
  assert.equal(pairs.length, 3);
  for (const { registerId, targetLen } of pairs) {
    const reg = rumorRegisters.find((r) => r.id === registerId);
    if (reg.targetCount != null) assert.equal(targetLen, reg.targetCount);
  }
});

test('seed respects targetCount when roles are not injected', async () => {
  const { store } = await tempStore();
  const rumorRegisters = [
    { id: 'zero-only', name: 'z', guidance: 'g', targetCount: 0 },
  ];
  let attempts = 0;
  const result = await seedGossip({
    store,
    adapter: stubAdapter({ personas: [PERSONA_A, PERSONA_B, PERSONA_C] }),
    rumorRegisters,
    cap: 1,
    historyGenerations: 0,
    timezone: 'UTC',
    generate: async ({ roles, register }) => {
      attempts += 1;
      assert.equal(register.id, 'zero-only');
      assert.equal(roles.targets.length, 0);
      return { rumor: 'unconfirmed the booth kettle whistled through the legal ID twice' };
    },
    log: { info() {}, warn() {} },
  });
  assert.equal(result.seeded, 1);
  assert.ok(attempts >= 1);
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

test('rate limit delay uses jittered backoff or Retry-After inside the deadline', () => {
  assert.equal(rateLimitDelayMs({ attempt: 1, elapsedMs: 0, random: () => 0 }), 500);
  assert.equal(rateLimitDelayMs({ attempt: 1, elapsedMs: 0, random: () => 1 }), 1000);
  assert.equal(rateLimitDelayMs({ attempt: 2, retryAfterMs: 2500, elapsedMs: 0, random: () => 0 }), 2500);
  assert.equal(rateLimitDelayMs({ attempt: 1, retryAfterMs: 120_000, elapsedMs: 0 }), null);
  assert.equal(rateLimitDelayMs({ attempt: 1, elapsedMs: 60_000, random: () => 0 }), null);
});

test('seed recovers from a transient rate limit and keeps earlier tidbits', async () => {
  const { store } = await tempStore();
  let calls = 0;
  const delays = [];
  const result = await seedGossip({
    store,
    adapter: stubAdapter({ personas: [PERSONA_A, PERSONA_B] }),
    pickRoles: () => onAir,
    cap: 2,
    historyGenerations: 7,
    timezone: 'UTC',
    sleep: async (ms) => { delays.push(ms); },
    generate: async () => {
      calls += 1;
      if (calls === 2) {
        const error = new Error('rate limited');
        error.status = 429;
        error.retryAfterMs = 25;
        throw error;
      }
      return { rumor: `unconfirmed station item ${calls}` };
    },
    log: { info() {}, warn() {} },
  });
  assert.equal(result.seeded, 2);
  assert.equal(store.snapshot().tidbits.length, 2);
  assert.equal(calls, 3);
  assert.deepEqual(delays, [25]);
});

test('seed stops after bounded rate limits and preserves the existing board', async () => {
  const prior = tidbit({ id: 'kept', text: 'Alpha told Beta, "kept the old rumor intact"' });
  const { store, read } = await tempStore({ tidbits: [prior] });
  const delays = [];
  await assert.rejects(
    () => seedGossip({
      store,
      adapter: stubAdapter({ personas: [PERSONA_A, PERSONA_B] }),
      pickRoles: () => onAir,
      cap: 1,
      historyGenerations: 7,
      timezone: 'UTC',
      sleep: async (ms) => { delays.push(ms); },
      generate: async () => {
        const error = new Error('rate limited');
        error.status = 429;
        error.retryAfterMs = 0;
        throw error;
      },
      log: { info() {}, warn() {} },
    }),
    (err) => err.code === 'RATE_LIMIT' && err.status === 429,
  );
  assert.equal(delays.length, RATE_LIMIT_ATTEMPTS - 1);
  const state = await read();
  assert.equal(state.tidbits.length, 1);
  assert.equal(state.tidbits[0].id, 'kept');
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
    cap: 9,
    historyGenerations: 7,
    timezone: 'UTC',
    log: { info() {}, warn() {} },
  });
  assert.ok(result.refreshed >= 1);
  assert.deepEqual([...seen].sort(), ['p_a', 'p_b', 'p_c']);
  assert.deepEqual([...rumorTargets].sort(), ['p_a', 'p_b', 'p_c']);
});

test('default refresh honors a low cap without expanding for roster coverage', async () => {
  const { store } = await tempStore();
  let calls = 0;
  const result = await refreshGossip({
    store,
    adapter: stubAdapter({ personas: [PERSONA_A, PERSONA_B, PERSONA_C] }),
    cap: 1,
    strictCap: true,
    generate: async ({ roles }) => {
      calls += 1;
      const targets = roles.targets.map((persona) => persona.name).join(' ');
      return { rumor: `unconfirmed ${targets || 'the booth kettle'} whistled through the legal ID twice` };
    },
    historyGenerations: 7,
    timezone: 'UTC',
    log: { info() {}, warn() {} },
  });
  assert.equal(calls, 1);
  assert.equal(result.refreshed, 1);
  assert.equal(result.tidbits.length, 1);
});

test('strict refresh returns the requested count after rejected slots', async () => {
  const { store, read } = await tempStore({
    tidbits: [tidbit({
      id: 'old',
      text: 'stale board item',
      hearerPersonaIds: null,
      canonicalAnchors: { props: ['kettle'] },
    })],
  });
  const cap = 2;
  let registerPicks = 0;
  let generateCalls = 0;
  const result = await refreshGossip({
    store,
    adapter: stubAdapter({ personas: [PERSONA_A, PERSONA_B, PERSONA_C] }),
    pickRoles: () => onAir,
    pickRegister: () => {
      registerPicks += 1;
      if (registerPicks <= 24) return null;
      return { id: 'booth', name: 'Booth', guidance: 'g', targetCount: 0 };
    },
    cap,
    strictCap: true,
    historyGenerations: 0,
    timezone: 'UTC',
    generate: async () => {
      generateCalls += 1;
      if (generateCalls <= 3) return { rumor: 'short' };
      if (generateCalls === 4) {
        return {
          rumor: 'unconfirmed the booth kettle whistled through the legal ID',
          anchors: { props: ['Kettle'] },
        };
      }
      return { rumor: `unconfirmed the booth cart rattled through legal ID take ${generateCalls}` };
    },
    log: { info() {}, warn() {} },
  });
  const slots = result.rejected + result.refreshed;
  assert.equal(result.refreshed, cap);
  assert.equal(result.tidbits.length, cap);
  assert.equal(result.rejected, 3);
  assert.ok(slots > cap);
  assert.ok(slots <= cap * 3);
  assert.equal(generateCalls, 6);
  const state = await read();
  assert.equal(state.tidbits.length, cap);
  assert.ok(state.tidbits.every((item) => item.id !== 'old'));
});

test('strict refresh throws before review when accepted tidbits stay short of the count', async () => {
  const stale = tidbit({ id: 'old', text: 'stale board item', hearerPersonaIds: null });
  const comments = [{ id: 'keep-me', tidbitId: 'old', actorPersonaId: 'p_a', commentedAt: '2026-09-18T10:00:00.000Z' }];
  const { store, read } = await tempStore({ tidbits: [stale], gossipComments: comments });
  const before = await read();
  let generateCalls = 0;
  let reviewCalls = 0;
  await assert.rejects(
    () => refreshGossip({
      store,
      adapter: stubAdapter({ personas: [PERSONA_A, PERSONA_B, PERSONA_C] }),
      pickRoles: () => onAir,
      cap: 2,
      strictCap: true,
      reviewRounds: 1,
      historyGenerations: 0,
      timezone: 'UTC',
      generate: async () => {
        generateCalls += 1;
        if (generateCalls === 1) return { rumor: 'unconfirmed the booth kettle whistled through the legal ID' };
        return { rumor: 'short' };
      },
      generateReview: async () => {
        reviewCalls += 1;
        return { rumors: {} };
      },
      log: { info() {}, warn() {} },
    }),
    (err) => err.status === 502 && err.message === 'LLM produced no complete station-wide hallway chain',
  );
  assert.equal(generateCalls, 16);
  assert.equal(reviewCalls, 0);
  const state = await read();
  assert.deepEqual(state.tidbits, before.tidbits);
  assert.deepEqual(state.gossipComments, before.gossipComments);
});

test('strict refresh fails without replacing the board when roles run out', async () => {
  const stale = tidbit({ id: 'old', text: 'stale board item', hearerPersonaIds: null });
  const comments = [{ id: 'keep-me', tidbitId: 'old', actorPersonaId: 'p_a', commentedAt: '2026-09-18T10:00:00.000Z' }];
  const { store, read } = await tempStore({ tidbits: [stale], gossipComments: comments });
  const before = await read();
  let picks = 0;
  await assert.rejects(
    () => refreshGossip({
      store,
      adapter: stubAdapter({ personas: [PERSONA_A, PERSONA_B, PERSONA_C] }),
      pickRoles: () => {
        picks += 1;
        return picks === 1 ? onAir : null;
      },
      cap: 3,
      strictCap: true,
      historyGenerations: 0,
      timezone: 'UTC',
      generate: async () => ({ rumor: 'unconfirmed the booth kettle whistled through the legal ID' }),
      log: { info() {}, warn() {} },
    }),
    (err) => err.status === 502 && err.message === 'LLM produced no complete station-wide hallway chain',
  );
  assert.equal(picks, 2);
  const state = await read();
  assert.deepEqual(state.tidbits, before.tidbits);
  assert.deepEqual(state.gossipComments, before.gossipComments);
});

test('strict refresh does not stop once roster coverage is complete', async () => {
  const { store } = await tempStore();
  let calls = 0;
  const result = await refreshGossip({
    store,
    adapter: stubAdapter({ personas: [PERSONA_A, PERSONA_B] }),
    cap: 4,
    strictCap: true,
    historyGenerations: 0,
    timezone: 'UTC',
    generate: async () => {
      calls += 1;
      return { rumor: 'unconfirmed Alpha and Beta left the booth kettle on the legal ID' };
    },
    log: { info() {}, warn() {} },
  });
  assert.equal(result.refreshed, 4);
  assert.equal(result.tidbits.length, 4);
  assert.equal(calls, 4);
});

test('strict refresh keeps the count when review rejects a revision', async () => {
  const { store, read } = await tempStore();
  let generateCalls = 0;
  let reviewCalls = 0;
  const result = await refreshGossip({
    store,
    adapter: stubAdapter({ personas: [PERSONA_A, PERSONA_B, PERSONA_C] }),
    pickRoles: () => onAir,
    cap: 2,
    strictCap: true,
    reviewRounds: 1,
    historyGenerations: 0,
    timezone: 'UTC',
    generate: async () => {
      generateCalls += 1;
      return { rumor: `unconfirmed the booth kettle whistled through legal ID take ${generateCalls}` };
    },
    generateReview: async ({ tidbits }) => {
      reviewCalls += 1;
      return {
        rumors: {
          [tidbits[0].id]: 'string',
          [tidbits[1].id]: 'string',
        },
      };
    },
    log: { info() {}, warn() {} },
  });
  assert.equal(result.refreshed, 2);
  assert.equal(result.tidbits.length, 2);
  assert.equal(generateCalls, 2);
  assert.equal(reviewCalls, 1);
  assert.equal(result.review.rejected, 2);
  const state = await read();
  assert.equal(state.tidbits.length, 2);
  assert.match(state.tidbits[0].text, /legal ID take 1/);
  assert.match(state.tidbits[1].text, /legal ID take 2/);
});

test('strict refresh aborts on a provider error instead of counting a rejected slot', async () => {
  const stale = tidbit({ text: 'board before throw', hearerPersonaIds: null });
  const { store, read } = await tempStore({ tidbits: [stale] });
  const before = await read();
  let calls = 0;
  await assert.rejects(
    () => refreshGossip({
      store,
      adapter: stubAdapter({ personas: [PERSONA_A, PERSONA_B, PERSONA_C] }),
      pickRoles: () => onAir,
      strictCap: true,
      cap: 2,
      historyGenerations: 0,
      timezone: 'UTC',
      generate: async () => {
        calls += 1;
        if (calls === 1) return { rumor: 'unconfirmed the booth kettle whistled through the legal ID' };
        throw new Error('fetch failed');
      },
      log: { info() {}, warn() {} },
    }),
    (err) => err.message === 'fetch failed' && err.status !== 502,
  );
  assert.equal(calls, 2);
  const state = await read();
  assert.deepEqual(state.tidbits, before.tidbits);
});

test('strict refresh aborts when rate limit retries are exhausted', async () => {
  const stale = tidbit({ id: 'kept', text: 'board before rate limit', hearerPersonaIds: null });
  const { store, read } = await tempStore({ tidbits: [stale] });
  const before = await read();
  await assert.rejects(
    () => refreshGossip({
      store,
      adapter: stubAdapter({ personas: [PERSONA_A, PERSONA_B, PERSONA_C] }),
      pickRoles: () => onAir,
      strictCap: true,
      cap: 1,
      historyGenerations: 0,
      timezone: 'UTC',
      sleep: async () => {},
      generate: async () => {
        const error = new Error('rate limited');
        error.status = 429;
        error.retryAfterMs = 0;
        throw error;
      },
      log: { info() {}, warn() {} },
    }),
    (err) => err.code === 'RATE_LIMIT' && err.status === 429 && !err.rejected,
  );
  const state = await read();
  assert.deepEqual(state.tidbits, before.tidbits);
});

test('strict refresh abort is not recorded as a rejected slot', async () => {
  const stale = tidbit({ text: 'stay', hearerPersonaIds: null });
  const { store, read } = await tempStore({ tidbits: [stale] });
  const before = await read();
  const controller = new AbortController();
  await assert.rejects(() => refreshGossip({
    store,
    adapter: stubAdapter({ personas: [PERSONA_A, PERSONA_B, PERSONA_C] }),
    signal: controller.signal,
    pickRoles: () => onAir,
    strictCap: true,
    cap: 2,
    historyGenerations: 0,
    generate: async () => {
      controller.abort();
      return { rumor: 'unconfirmed the booth kettle whistled through the legal ID' };
    },
    log: { info() {}, warn() {} },
  }), (err) => err.name === 'AbortError' && err.status !== 502);
  const state = await read();
  assert.deepEqual(state.tidbits, before.tidbits);
});

test('non-strict refresh uses the roster slot ceiling while coverage stays open', async () => {
  const { store } = await tempStore();
  let calls = 0;
  await assert.rejects(
    () => refreshGossip({
      store,
      adapter: stubAdapter({ personas: [PERSONA_A, PERSONA_B] }),
      cap: 1,
      historyGenerations: 0,
      timezone: 'UTC',
      generate: async () => {
        calls += 1;
        return { rumor: 'short' };
      },
      log: { info() {}, warn() {} },
    }),
    (err) => err.status === 502,
  );
  assert.equal(calls, 18);
});

test('non-strict custom role picker lets a rejection consume the count', async () => {
  const { store } = await tempStore();
  let calls = 0;
  const result = await refreshGossip({
    store,
    adapter: stubAdapter({ personas: [PERSONA_A, PERSONA_B, PERSONA_C] }),
    pickRoles: () => onAir,
    cap: 2,
    historyGenerations: 0,
    timezone: 'UTC',
    generate: async () => {
      calls += 1;
      if (calls <= 3) return { rumor: 'short' };
      return { rumor: 'unconfirmed the booth kettle whistled through the legal ID' };
    },
    log: { info() {}, warn() {} },
  });
  assert.equal(calls, 4);
  assert.equal(result.refreshed, 1);
  assert.equal(result.rejected, 1);
  assert.equal(result.tidbits.length, 1);
});

test('default refresh fails when rumor targets never cover the roster', async () => {
  const stale = tidbit({ text: 'stale board survives 502', hearerPersonaIds: null });
  const { store, read } = await tempStore({ tidbits: [stale] });
  const before = await read();
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
  const state = await read();
  assert.deepEqual(state.tidbits, before.tidbits);
});

test('refresh respects targetCount on rumor registers', async () => {
  const { store } = await tempStore();
  const rumorRegisters = [
    { id: 'zero-only', name: 'z', guidance: 'g', targetCount: 0 },
  ];
  await refreshGossip({
    store,
    adapter: stubAdapter({ personas: [PERSONA_A, PERSONA_B, PERSONA_C] }),
    rumorRegisters,
    pickRoles: () => onAir,
    cap: 1,
    historyGenerations: 0,
    timezone: 'UTC',
    generate: async ({ roles, register }) => {
      assert.equal(register.id, 'zero-only');
      assert.equal(roles.targets.length, 0);
      return { rumor: 'unconfirmed the booth kettle whistled through the legal ID twice' };
    },
    log: { info() {}, warn() {} },
  });
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

test('refresh keeps stale board on disk during generation and commits only on success', async () => {
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
      const mid = await read();
      assert.ok(mid.tidbits.some((t) => t.text === 'stale board item'));
      assert.ok(!existing.some((line) => line.includes('stale board item')));
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
  const stale = tidbit({ id: 'old', text: 'old news', hearerPersonaIds: null });
  const priorHistory = [['Beta told Alpha, "prior generated line"']];
  const { store, read } = await tempStore({
    tidbits: [stale],
    generatedGossipHistory: priorHistory,
    gossipComments: [
      { id: 'keep-me', tidbitId: 'old', actorPersonaId: 'p_a', commentedAt: '2026-09-19T00:00:00.000Z' },
    ],
  });
  const before = await read();
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
  assert.deepEqual(state.tidbits, before.tidbits);
  assert.deepEqual(state.generatedGossipHistory, before.generatedGossipHistory);
});

test('failed refresh preserves board when generation throws on first call', async () => {
  const stale = tidbit({ text: 'board before throw', hearerPersonaIds: null });
  const { store, read } = await tempStore({ tidbits: [stale] });
  const before = await read();
  await assert.rejects(
    () => refreshGossip({
      store,
      adapter: stubAdapter({ personas: [PERSONA_A, PERSONA_B, PERSONA_C] }),
      pickRoles: () => onAir,
      generate: async () => {
        throw new Error('fetch failed');
      },
      cap: 1,
      historyGenerations: 7,
      timezone: 'UTC',
      log: { info() {}, warn() {} },
    }),
    (err) => err.message === 'fetch failed',
  );
  const state = await read();
  assert.deepEqual(state.tidbits, before.tidbits);
});

test('failed refresh preserves board when generation throws mid-batch', async () => {
  const stale = tidbit({ text: 'board before mid throw', hearerPersonaIds: null });
  const { store, read } = await tempStore({ tidbits: [stale] });
  const before = await read();
  let calls = 0;
  await assert.rejects(
    () => refreshGossip({
      store,
      adapter: stubAdapter({ personas: [PERSONA_A, PERSONA_B, PERSONA_C] }),
      pickRoles: () => hallway,
      generate: async () => {
        calls += 1;
        if (calls === 2) throw new Error('fetch failed');
        return { rumor: 'unconfirmed Gamma hid a cart behind the legal ID twice' };
      },
      cap: 2,
      historyGenerations: 7,
      timezone: 'UTC',
      log: { info() {}, warn() {} },
    }),
    (err) => err.message === 'fetch failed',
  );
  assert.equal(calls, 2);
  const state = await read();
  assert.deepEqual(state.tidbits, before.tidbits);
});

test('refresh still commits when batch review throws without mutating mid-review', async () => {
  const stale = tidbit({ text: 'stale before review throw', hearerPersonaIds: null });
  const { store, read } = await tempStore({ tidbits: [stale] });
  const result = await refreshGossip({
    store,
    adapter: stubAdapter({ personas: [PERSONA_A, PERSONA_B, PERSONA_C] }),
    pickRoles: () => onAir,
    cap: 1,
    historyGenerations: 7,
    reviewRounds: 1,
    timezone: 'UTC',
    generate: async () => ({ rumor: 'unconfirmed the booth kettle whistled through the legal ID' }),
    generateReview: async () => {
      throw new Error('review failed');
    },
    log: { info() {}, warn() {} },
  });
  assert.equal(result.refreshed, 1);
  const state = await read();
  assert.ok(!state.tidbits.some((t) => t.text === 'stale before review throw'));
  assert.equal(
    state.tidbits[0].text,
    'Alpha said on air, "unconfirmed the booth kettle whistled through the legal ID"',
  );
});

test('failed refresh preserves board when generation throws before default chain completes', async () => {
  const stale = tidbit({ text: 'board before incomplete default refresh', hearerPersonaIds: null });
  const { store, read } = await tempStore({ tidbits: [stale] });
  const before = await read();
  let calls = 0;
  await assert.rejects(
    () => refreshGossip({
      store,
      adapter: stubAdapter({ personas: [PERSONA_A, PERSONA_B, PERSONA_C] }),
      generate: async ({ roles }) => {
        calls += 1;
        if (calls >= 2) throw new Error('fetch failed');
        const targets = roles.targets.map((p) => p.name).join(' ');
        return { rumor: `unconfirmed station kettle remembers ${targets || 'the cart'} tonight` };
      },
      historyGenerations: 7,
      timezone: 'UTC',
      log: { info() {}, warn() {} },
    }),
    (err) => err.message === 'fetch failed',
  );
  assert.equal(calls, 2);
  const state = await read();
  assert.deepEqual(state.tidbits, before.tidbits);
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

test('a failed review is not reported as a completed review', async () => {
  const { store } = await tempStore();
  const result = await refreshGossip({
    store,
    adapter: stubAdapter({ personas: [PERSONA_A, PERSONA_B, PERSONA_C] }),
    pickRoles: () => onAir,
    cap: 1,
    historyGenerations: 7,
    timezone: 'UTC',
    reviewRounds: 1,
    generate: async () => ({ rumor: 'unconfirmed the booth kettle whistled through the legal ID' }),
    generateReview: async () => {
      throw new Error('LLM review output truncated');
    },
    log: { info() {}, warn() {} },
  });
  assert.equal(result.refreshed, 1);
  assert.equal(result.review.failed, true);
  assert.equal(result.review.roundsCompleted, 0);
  assert.equal(result.review.accepted, 0);
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

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('seed and refresh generation lifecycles execute in process-local FIFO order', async () => {
  const { store } = await tempStore();
  const adapter = stubAdapter({ personas: [PERSONA_A, PERSONA_B, PERSONA_C] });
  const firstGeneration = deferred();
  const firstStarted = deferred();
  const calls = [];
  const refresh = refreshGossip({
    store,
    adapter,
    pickRoles: () => onAir,
    cap: 1,
    historyGenerations: 7,
    generate: async () => {
      calls.push('refresh-1');
      firstStarted.resolve();
      await firstGeneration.promise;
      return { rumor: 'unconfirmed the first refresh held the legal ID' };
    },
    log: { info() {}, warn() {} },
  });
  await firstStarted.promise;
  const seed = seedGossip({
    store,
    adapter,
    pickRoles: () => hallway,
    cap: 1,
    historyGenerations: 7,
    generate: async () => {
      calls.push('seed');
      return { rumor: 'word is Gamma queued behind the legal ID' };
    },
    log: { info() {}, warn() {} },
  });
  const secondRefresh = refreshGossip({
    store,
    adapter,
    pickRoles: () => onAir,
    cap: 1,
    historyGenerations: 7,
    generate: async () => {
      calls.push('refresh-2');
      return { rumor: 'unconfirmed the second refresh replaced the legal ID' };
    },
    log: { info() {}, warn() {} },
  });
  assert.deepEqual(calls, ['refresh-1']);
  firstGeneration.resolve();
  await Promise.all([refresh, seed, secondRefresh]);
  assert.deepEqual(calls, ['refresh-1', 'seed', 'refresh-2']);
  assert.equal(store.snapshot().tidbits.length, 1);
  assert.match(store.snapshot().tidbits[0].text, /second refresh/);
  assert.deepEqual(store.snapshot().generatedGossipHistory.at(-1), [store.snapshot().tidbits[0].text]);
});

test('queued validation failure and abort release later gossip generation', async () => {
  const { store } = await tempStore();
  const controller = new AbortController();
  const failed = refreshGossip({
    store,
    adapter: { ...stubAdapter(), getRosterPersonas: async () => [] },
    cap: 1,
    historyGenerations: 7,
    generate: async () => ({ rumor: 'unused' }),
    log: { info() {}, warn() {} },
  });
  const aborted = seedGossip({
    store,
    adapter: stubAdapter({ personas: [PERSONA_A, PERSONA_B, PERSONA_C] }),
    signal: controller.signal,
    pickRoles: () => hallway,
    cap: 1,
    historyGenerations: 7,
    generate: async () => ({ rumor: 'unused' }),
    log: { info() {}, warn() {} },
  });
  controller.abort();
  const later = seedGossip({
    store,
    adapter: stubAdapter({ personas: [PERSONA_A, PERSONA_B, PERSONA_C] }),
    pickRoles: () => hallway,
    cap: 1,
    historyGenerations: 7,
    generate: async () => ({ rumor: 'word is Gamma reached the board after failures' }),
    log: { info() {}, warn() {} },
  });
  await assert.rejects(failed, /cannot refresh gossip without a persona roster/);
  await assert.rejects(aborted, { name: 'AbortError' });
  const result = await later;
  assert.equal(result.seeded, 1);
});

test('two seed processes append both tidbits while generation overlaps', async () => {
  const { filePath, read } = await tempStore();
  const barrier = await mkdtemp(path.join(tmpdir(), 'gossip-barrier-'));
  const rumorA = 'word is Gamma hid a cart behind the legal ID again';
  const rumorB = 'word is Gamma taped a spare cart over the legal ID';
  const [first, second] = await Promise.all([
    runGossipAction('seed', {
      STATE_PATH: filePath,
      RUMOR: rumorA,
      BARRIER_DIR: barrier,
      BARRIER_NAME: 'a',
      BARRIER_PEERS: 'a,b',
    }),
    runGossipAction('seed', {
      STATE_PATH: filePath,
      RUMOR: rumorB,
      BARRIER_DIR: barrier,
      BARRIER_NAME: 'b',
      BARRIER_PEERS: 'a,b',
    }),
  ]);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  const disk = await read();
  const texts = disk.tidbits.map((item) => item.text).join('\n');
  assert.equal(texts.includes(rumorA), true);
  assert.equal(texts.includes(rumorB), true);
  assert.equal(disk.tidbits.length, 2);
});

test('refresh does not commit over a board replaced during generation', async () => {
  const { store, filePath, read } = await tempStore({
    tidbits: [tidbit({ id: 'baseline', text: 'baseline rumor', hearerPersonaIds: null })],
    generatedGossipHistory: [['prior generated line']],
  });
  await assert.rejects(() => refreshGossip({
    store,
    adapter: stubAdapter({ personas: [PERSONA_A, PERSONA_B, PERSONA_C] }),
    pickRoles: () => onAir,
    cap: 1,
    historyGenerations: 7,
    timezone: 'UTC',
    generate: async () => {
      await store.mutate((state) => {
        state.tidbits = [tidbit({ id: 'other-refresh', text: 'already committed refresh', hearerPersonaIds: null })];
        appendGeneratedGossipHistory(state, ['other refresh history'], 7);
      });
      return { rumor: 'unconfirmed the late refresh must not land tonight' };
    },
    log: { info() {}, warn() {} },
  }), (err) => {
    assert.equal(err.status, 409);
    assert.match(err.message, /another refresh already committed/);
    assert.equal(err.message.includes(filePath), true);
    return true;
  });
  const disk = await read();
  assert.equal(disk.tidbits.length, 1);
  assert.equal(disk.tidbits[0].id, 'other-refresh');
  assert.equal(disk.generatedGossipHistory.flat().includes('other refresh history'), true);
  assert.equal(disk.generatedGossipHistory.flat().some((line) => line.includes('late refresh')), false);
});

test('refresh commit keeps incremental history written during generation', async () => {
  const { store, read } = await tempStore({
    tidbits: [tidbit({ id: 'baseline', text: 'baseline rumor', hearerPersonaIds: null })],
    generatedGossipHistory: [['prior generated line']],
  });
  const result = await refreshGossip({
    store,
    adapter: stubAdapter({ personas: [PERSONA_A, PERSONA_B, PERSONA_C] }),
    pickRoles: () => onAir,
    cap: 1,
    historyGenerations: 7,
    timezone: 'UTC',
    generate: async () => {
      await store.mutate((state) => {
        state.tidbits.push(tidbit({
          id: 'during',
          text: 'appended during generation',
          hearerPersonaIds: null,
          toldAt: ['2026-09-19T05:00:00.000Z'],
        }));
        appendGeneratedGossipHistory(state, ['incremental history beside refresh'], 7);
        recordGossipComment(state, {
          id: 'during-comment',
          tidbitId: 'during',
          actorPersonaId: PERSONA_A.id,
          commentedAt: '2026-09-19T05:00:00.000Z',
        });
        recordTidbitTelling(state, 'during', '2026-09-19T05:00:00.000Z');
      });
      return { rumor: 'unconfirmed the booth kettle whistled through the legal ID' };
    },
    log: { info() {}, warn() {} },
  });
  assert.equal(result.refreshed, 1);
  const disk = await read();
  assert.equal(disk.tidbits.some((item) => item.id === 'during'), false);
  assert.equal(disk.tidbits.some((item) => item.id === 'baseline'), false);
  assert.equal(disk.gossipComments.some((item) => item.id === 'during-comment'), false);
  const history = disk.generatedGossipHistory.flat();
  assert.equal(history.includes('prior generated line'), true);
  assert.equal(history.includes('incremental history beside refresh'), true);
  assert.equal(history.some((line) => line.includes('booth kettle')), true);
});

test('a second refresh does not commit over a refresh that already committed', async () => {
  const { filePath, read } = await tempStore({
    tidbits: [tidbit({ id: 'baseline', text: 'baseline rumor', hearerPersonaIds: null })],
    generatedGossipHistory: [['prior generated line']],
  });
  const barrier = await mkdtemp(path.join(tmpdir(), 'gossip-barrier-'));
  const late = 'unconfirmed the late refresh must not land tonight';
  const early = 'unconfirmed the booth kettle whistled through the legal ID';
  const [slow, fast] = await Promise.all([
    runGossipAction('refresh', {
      STATE_PATH: filePath,
      RUMOR: late,
      BARRIER_DIR: barrier,
      BARRIER_NAME: 'slow',
      BARRIER_PEERS: 'slow,fast',
      DELAY_MS: '700',
    }),
    runGossipAction('refresh', {
      STATE_PATH: filePath,
      RUMOR: early,
      BARRIER_DIR: barrier,
      BARRIER_NAME: 'fast',
      BARRIER_PEERS: 'slow,fast',
    }),
  ]);
  assert.equal(fast.status, 0, fast.stderr);
  assert.equal(slow.status, 1);
  assert.equal(slow.stderr.includes(filePath), true);
  assert.match(slow.stderr, /another refresh already committed/);
  const disk = await read();
  assert.equal(disk.tidbits.length, 1);
  assert.equal(disk.tidbits[0].text.includes(early), true);
  assert.equal(disk.tidbits[0].text.includes(late), false);
  assert.equal(disk.generatedGossipHistory.flat().includes('prior generated line'), true);
  assert.equal(disk.generatedGossipHistory.flat().some((line) => line.includes(late)), false);
});

test('two refreshes starting from an empty board keep only the first commit', async () => {
  const { filePath, read } = await tempStore();
  const barrier = await mkdtemp(path.join(tmpdir(), 'gossip-barrier-'));
  const late = 'unconfirmed the late refresh must not land tonight';
  const early = 'unconfirmed the booth kettle whistled through the legal ID';
  const [slow, fast] = await Promise.all([
    runGossipAction('refresh', {
      STATE_PATH: filePath,
      RUMOR: late,
      BARRIER_DIR: barrier,
      BARRIER_NAME: 'slow',
      BARRIER_PEERS: 'slow,fast',
      DELAY_MS: '700',
    }),
    runGossipAction('refresh', {
      STATE_PATH: filePath,
      RUMOR: early,
      BARRIER_DIR: barrier,
      BARRIER_NAME: 'fast',
      BARRIER_PEERS: 'slow,fast',
    }),
  ]);
  assert.equal(fast.status, 0, fast.stderr);
  assert.equal(slow.status, 1);
  assert.equal(slow.stderr.includes(filePath), true);
  assert.match(slow.stderr, /another refresh already committed/);
  const disk = await read();
  assert.equal(disk.boardRevision, 1);
  assert.equal(disk.tidbits.length, 1);
  assert.equal(disk.tidbits[0].text.includes(early), true);
  assert.equal(disk.tidbits[0].text.includes(late), false);
  assert.equal(disk.generatedGossipHistory.flat().some((line) => line.includes(late)), false);
});

test('refresh keeps an incremental commit made during generation in another process', async () => {
  const { filePath, read } = await tempStore({
    tidbits: [tidbit({ id: 'baseline', text: 'baseline rumor', hearerPersonaIds: null })],
    generatedGossipHistory: [['prior generated line']],
  });
  const barrier = await mkdtemp(path.join(tmpdir(), 'gossip-barrier-'));
  const marker = 'incremental history beside refresh';
  const refresh = runGossipAction('refresh', {
    STATE_PATH: filePath,
    RUMOR: 'unconfirmed the booth kettle whistled through the legal ID',
    BARRIER_DIR: barrier,
    BARRIER_NAME: 'refresh',
    BARRIER_PEERS: 'refresh',
    WAIT_FOR_TEXT: marker,
  });
  const ready = path.join(barrier, 'refresh');
  const deadline = Date.now() + 8000;
  while (!existsSync(ready)) {
    if (Date.now() > deadline) throw new Error('refresh did not reach generation');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const wrote = await runGossipAction('mutate-append', {
    STATE_PATH: filePath,
    TIDBIT_ID: 'during',
    TIDBIT_TEXT: 'appended during generation',
    HISTORY_LINE: marker,
    COMMENT_ID: 'during-comment',
    TOLD_AT: '2026-09-19T05:00:00.000Z',
  });
  const committed = await refresh;
  assert.equal(wrote.status, 0, wrote.stderr);
  assert.equal(committed.status, 0, committed.stderr);
  const disk = await read();
  assert.equal(disk.tidbits.some((item) => item.id === 'during'), false);
  const history = disk.generatedGossipHistory.flat();
  assert.equal(history.includes('prior generated line'), true);
  assert.equal(history.includes(marker), true);
  assert.equal(history.some((line) => line.includes('booth kettle')), true);
});

test('abort between refresh model calls releases the queue and skips the commit', async () => {
  const { store } = await tempStore();
  const controller = new AbortController();
  const logs = [];
  const log = { info(message) { logs.push(String(message)); }, warn() {} };
  let firstCalls = 0;
  const aborted = refreshGossip({
    store,
    adapter: stubAdapter({ personas: [PERSONA_A, PERSONA_B, PERSONA_C] }),
    signal: controller.signal,
    pickRoles: () => onAir,
    cap: 2,
    historyGenerations: 7,
    generate: async () => {
      firstCalls += 1;
      if (firstCalls === 1) controller.abort('shutdown');
      return { rumor: 'word is the booth kettle whistled through the legal ID' };
    },
    log,
  });
  const later = refreshGossip({
    store,
    adapter: stubAdapter({ personas: [PERSONA_A, PERSONA_B, PERSONA_C] }),
    pickRoles: () => onAir,
    cap: 1,
    historyGenerations: 7,
    generate: async () => ({ rumor: 'word is the second kettle whistled after the abort' }),
    log,
  });
  await assert.rejects(aborted, { name: 'AbortError' });
  const result = await later;
  assert.equal(firstCalls, 1);
  assert.equal(result.refreshed, 1);
  assert.match(store.snapshot().tidbits[0].text, /second kettle/);
  const abortedLogs = logs.filter((line) => line.includes('"stage":"aborted"'));
  assert.equal(abortedLogs.length, 1);
  assert.match(abortedLogs[0], /"version":1/);
  assert.match(abortedLogs[0], /"kind":"refresh"/);
  assert.match(abortedLogs[0], /"reason":"shutdown"/);
  assert.equal(logs.filter((line) => line.includes('"stage":"complete"') && line.includes('"kind":"refresh"')).length, 1);
});

test('client disconnect aborts a refresh with AbortError and skips the commit', async () => {
  const { store } = await tempStore();
  const controller = new AbortController();
  const logs = [];
  const log = { info(message) { logs.push(String(message)); }, warn() {} };
  let release = () => {};
  const gate = new Promise((resolve) => { release = resolve; });
  const aborted = refreshGossip({
    store,
    adapter: stubAdapter({ personas: [PERSONA_A, PERSONA_B, PERSONA_C] }),
    signal: controller.signal,
    pickRoles: () => onAir,
    cap: 1,
    historyGenerations: 7,
    generate: async () => {
      controller.abort();
      await gate;
      return { rumor: 'word is the booth kettle whistled through the legal ID' };
    },
    log,
  });
  const later = refreshGossip({
    store,
    adapter: stubAdapter({ personas: [PERSONA_A, PERSONA_B, PERSONA_C] }),
    pickRoles: () => onAir,
    cap: 1,
    historyGenerations: 7,
    generate: async () => ({ rumor: 'word is the second kettle whistled after the disconnect' }),
    log,
  });
  await assert.rejects(aborted, { name: 'AbortError' });
  release();
  const result = await later;
  assert.equal(result.refreshed, 1);
  assert.match(store.snapshot().tidbits[0].text, /after the disconnect/);
  assert.equal(logs.some((line) => line.includes('"stage":"aborted"')), false);
});

test('abort before a refresh lifecycle does not log or commit', async () => {
  const { store } = await tempStore();
  const controller = new AbortController();
  controller.abort('shutdown');
  const logs = [];
  let calls = 0;
  await assert.rejects(() => refreshGossip({
    store,
    adapter: stubAdapter({ personas: [PERSONA_A, PERSONA_B, PERSONA_C] }),
    signal: controller.signal,
    pickRoles: () => onAir,
    cap: 1,
    historyGenerations: 7,
    generate: async () => {
      calls += 1;
      return { rumor: 'word is the booth kettle whistled through the legal ID' };
    },
    log: { info(message) { logs.push(String(message)); }, warn() {} },
  }), { name: 'AbortError' });
  assert.equal(calls, 0);
  assert.equal(store.snapshot().tidbits.length, 0);
  assert.equal(logs.some((line) => line.includes('"stage":"aborted"')), false);
});

test('a refresh commit already started finishes after the shutdown abort', async () => {
  const { store, read } = await tempStore();
  const controller = new AbortController();
  const logs = [];
  const original = store.mutate.bind(store);
  let entered = () => {};
  const started = new Promise((resolve) => { entered = resolve; });
  let release = () => {};
  const gate = new Promise((resolve) => { release = resolve; });
  store.mutate = (fn) => {
    entered();
    return gate.then(() => original(fn));
  };
  const pending = refreshGossip({
    store,
    adapter: stubAdapter({ personas: [PERSONA_A, PERSONA_B, PERSONA_C] }),
    signal: controller.signal,
    pickRoles: () => onAir,
    cap: 1,
    historyGenerations: 7,
    generate: async () => ({ rumor: 'word is the booth kettle whistled through the legal ID' }),
    log: { info(message) { logs.push(String(message)); }, warn() {} },
  });
  await started;
  controller.abort('shutdown');
  release();
  const result = await pending;
  assert.equal(result.refreshed, 1);
  assert.match((await read()).tidbits[0].text, /booth kettle/);
  assert.equal(logs.some((line) => line.includes('"stage":"aborted"')), false);
  assert.equal(logs.some((line) => line.includes('"stage":"complete"') && line.includes('"kind":"refresh"')), true);
});
