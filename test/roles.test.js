import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SEED_SYSTEM, seedUserPrompt } from '../src/llm.js';
import { pickRumorRegister, RUMOR_REGISTERS } from '../src/register.js';
import { hearerIdsForRoles, pickGossipRoles, wrapRumor } from '../src/roles.js';
import { PERSONA_A, PERSONA_B, PERSONA_C } from './helpers.js';

const roster = [
  { ...PERSONA_A, tagline: 'First chair', soul: 'Dry, short sentences. Notices clocks.' },
  { ...PERSONA_B, tagline: 'Second chair', soul: 'Warm, over-explains the kettle.' },
  { ...PERSONA_C, tagline: 'Third chair', soul: 'Collects unused jingles.' },
];

function seq(values) {
  let i = 0;
  return () => {
    const v = values[Math.min(i, values.length - 1)];
    i += 1;
    return v;
  };
}

test('pickGossipRoles keeps one teller, 0-3 hearers, 0-2 disjoint targets', () => {
  const roles = pickGossipRoles(roster, { rng: seq([0, 0.9, 0.9, 0.9, 0.9, 0.9]) });
  assert.ok(roles.teller.id);
  assert.ok(roles.hearers.length <= 3);
  assert.ok(roles.targets.length <= 2);
  const used = new Set([roles.teller.id, ...roles.hearers.map((p) => p.id), ...roles.targets.map((p) => p.id)]);
  assert.equal(used.size, 1 + roles.hearers.length + roles.targets.length);
});

test('zero hearers wrap as said on air and store null hearers', () => {
  const roles = {
    teller: PERSONA_A,
    hearers: [],
    targets: [PERSONA_C],
  };
  assert.equal(
    wrapRumor(roles, 'word is Gamma taped a dead cart over the legal ID'),
    'Alpha said on air, "word is Gamma taped a dead cart over the legal ID"',
  );
  assert.equal(hearerIdsForRoles(roles), null);
});

test('multiple hearers use and-list wrap', () => {
  const roles = { teller: PERSONA_A, hearers: [PERSONA_B, PERSONA_C], targets: [] };
  assert.equal(
    wrapRumor(roles, 'unconfirmed the booth kettle whistled through the legal ID'),
    'Alpha told Beta and Gamma, "unconfirmed the booth kettle whistled through the legal ID"',
  );
});

test('pickRumorRegister chooses deterministically from catalog ids', () => {
  const first = pickRumorRegister({ rng: seq([0, 0.99, 0.5]) });
  const second = pickRumorRegister({ rng: seq([0.25, 0.25]) });
  const third = pickRumorRegister({ rng: seq([0.99]) });
  assert.equal(first.id, RUMOR_REGISTERS[0].id);
  assert.equal(second.id, RUMOR_REGISTERS[1].id);
  assert.equal(third.id, RUMOR_REGISTERS[RUMOR_REGISTERS.length - 1].id);
});

test('seed prompt injects register id and guidance', () => {
  const roles = { teller: roster[0], hearers: [roster[1]], targets: [] };
  const register = RUMOR_REGISTERS.find((r) => r.id === 'petty-feud');
  const prompt = seedUserPrompt({ day: '2026-09-19', roles, register });
  assert.match(prompt, /Rumor register for this rumor/);
  assert.match(prompt, /petty feud/);
  assert.match(prompt, /passive-aggressive notes/);
  assert.match(prompt, /Write this rumor in that comic register only/);
  assert.match(prompt, /Write a rumor whose subject, people, and comic beat are all new beside these:/);
});

test('SEED_SYSTEM defers register choice to the user message', () => {
  assert.doesNotMatch(SEED_SYSTEM, /Pick whichever/i);
  assert.doesNotMatch(SEED_SYSTEM, /fresh draw every rumor/i);
  assert.match(SEED_SYSTEM, /supplied in the user message/i);
});

test('seed prompt includes house rules and pre-picked rumor targets', () => {
  const roles = { teller: roster[0], hearers: [roster[1]], targets: [roster[2]] };
  const prompt = seedUserPrompt({ houseRules: 'Adult language is allowed after 10 PM.', day: '2026-09-19', roles, register: RUMOR_REGISTERS[0] });
  assert.match(prompt, /Adult language is allowed after 10 PM/);
  assert.match(prompt, /Dry, short sentences/);
  assert.match(prompt, /Collects unused jingles/);
  assert.match(prompt, /Rumor-targets[\s\S]*Gamma/);
  assert.match(prompt, /Teller \(already chosen\): Alpha/);
});

test('seed prompt names a soulless persona without inventing a soul', () => {
  const roles = {
    teller: { id: 'p_a', name: 'Alpha' },
    hearers: [],
    targets: [{ id: 'p_c', name: 'Gamma', soul: 'Collects unused jingles.' }],
  };
  const prompt = seedUserPrompt({ day: '2026-09-19', roles, register: RUMOR_REGISTERS[0] });
  assert.match(prompt, /Teller \(already chosen\): Alpha \(p_a\)/);
  assert.doesNotMatch(prompt, /Teller \(already chosen\): Alpha \(p_a\)\nSoul:/);
  assert.match(prompt, /Collects unused jingles/);
});

test('seed prompt includes each hearer soul', () => {
  const roles = { teller: roster[0], hearers: [roster[1]], targets: [] };
  const prompt = seedUserPrompt({ day: '2026-09-19', roles, register: RUMOR_REGISTERS[0] });
  assert.match(prompt, /Warm, over-explains the kettle/);
});

test('telephone prompt carries the immediately previous telling', () => {
  const roles = { teller: roster[0], hearers: [roster[1]], targets: [] };
  const prompt = seedUserPrompt({
    personas: roster,
    day: '2026-09-19',
    roles,
    register: RUMOR_REGISTERS[0],
    previousTidbit: 'Alpha told Beta, "word is the kettle moved"',
  });
  assert.match(prompt, /Telephone-chain source/);
  assert.match(prompt, /word is the kettle moved/);
  assert.match(prompt, /one telephone-game step/);
  assert.match(prompt, /Dry, short sentences/);
  assert.match(prompt, /Warm, over-explains the kettle/);
});
