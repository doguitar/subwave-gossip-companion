import assert from 'node:assert/strict';
import { test } from 'node:test';
import { seedUserPrompt } from '../src/llm.js';
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

test('seed prompt includes house rules and pre-picked rumor targets', () => {
  const roles = { teller: roster[0], hearers: [roster[1]], targets: [roster[2]] };
  const prompt = seedUserPrompt({ houseRules: 'Adult language is allowed after 10 PM.', day: '2026-09-19', roles });
  assert.match(prompt, /Adult language is allowed after 10 PM/);
  assert.doesNotMatch(prompt, /Dry, short sentences/);
  assert.doesNotMatch(prompt, /Collects unused jingles/);
  assert.match(prompt, /Rumor-targets[\s\S]*Gamma/);
  assert.match(prompt, /Teller \(already chosen\): Alpha/);
});

test('telephone prompt carries the immediately previous telling', () => {
  const roles = { teller: roster[0], hearers: [roster[1]], targets: [] };
  const prompt = seedUserPrompt({
    personas: roster,
    day: '2026-09-19',
    roles,
    previousTidbit: 'Alpha told Beta, "word is the kettle moved"',
  });
  assert.match(prompt, /Telephone-chain source/);
  assert.match(prompt, /word is the kettle moved/);
  assert.match(prompt, /plausible telephone-game mutation/);
});
