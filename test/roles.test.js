import assert from 'node:assert/strict';
import { test } from 'node:test';
import { REVIEW_SYSTEM, SEED_SYSTEM, reviewUserPrompt, seedUserPrompt, sessionBeatSummary } from '../src/llm.js';
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
  const catalog = RUMOR_REGISTERS;
  const first = pickRumorRegister({ catalog, rng: seq([0, 0.99, 0.5]) });
  const second = pickRumorRegister({ catalog, rng: seq([0.25, 0.25]) });
  const third = pickRumorRegister({ catalog, rng: seq([0.99]) });
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
  assert.match(prompt, /Write this rumor in that comic register only/);
  assert.doesNotMatch(prompt, /beside these/);
});

test('petty-feud register suggests varied small-stakes stunts without anchoring on notes', () => {
  const register = RUMOR_REGISTERS.find((r) => r.id === 'petty-feud');
  assert.ok(register);
  assert.doesNotMatch(register.guidance, /passive-aggressive notes/i);
  assert.match(register.guidance, /grudge|feud|stake/i);
  const flavors = [/mug|mic|gear|prop|locker|swap|hog/i];
  assert.ok(flavors.some((re) => re.test(register.guidance)));
});

test('SEED_SYSTEM does not prescribe a shared beat', () => {
  assert.doesNotMatch(SEED_SYSTEM, /one shared beat|the same prop/i);
  assert.doesNotMatch(SEED_SYSTEM, /attached.?signage|labels?, signs, stickers|taped notes/i);
  assert.doesNotMatch(SEED_SYSTEM, /earlier rumors/i);
});

test('sessionBeatSummary stays empty so prior rumors are not pasted back', () => {
  const wrapped = 'Alpha told Beta, "word is Gamma superglued the booth kettle shut"';
  assert.equal(sessionBeatSummary([]), '');
  assert.equal(sessionBeatSummary([wrapped]), '');
});

test('seedUserPrompt omits prior rumors even when the session already has tidbits', () => {
  const roles = { teller: roster[0], hearers: [roster[1]], targets: [roster[2]] };
  const sessionTidbits = ['Alpha told Beta, "word is Gamma hid glitter in Beta\'s mic windscreen"'];
  const prompt = seedUserPrompt({
    day: '2026-09-19',
    roles,
    register: RUMOR_REGISTERS[0],
    existing: sessionTidbits,
    sessionTidbits,
  });
  assert.doesNotMatch(prompt, /Session beat variety/i);
  assert.doesNotMatch(prompt, /glitter in Beta's mic windscreen/i);
  assert.doesNotMatch(prompt, /beside these/);
});

test('seedUserPrompt omits session beat block when session is still empty', () => {
  const roles = { teller: roster[0], hearers: [roster[1]], targets: [] };
  const prompt = seedUserPrompt({ day: '2026-09-19', roles, register: RUMOR_REGISTERS[0] });
  assert.doesNotMatch(prompt, /Session beat variety/i);
});

test('SEED_SYSTEM defers register choice to the user message', () => {
  assert.doesNotMatch(SEED_SYSTEM, /Pick whichever/i);
  assert.doesNotMatch(SEED_SYSTEM, /fresh draw every rumor/i);
  assert.match(SEED_SYSTEM, /supplied in the user message/i);
});

test('seed prompt uses a rumor summary instead of the full soul', () => {
  const roles = {
    teller: { ...roster[0], rumorSummary: 'Notices clocks. Short sentences.' },
    hearers: [],
    targets: [{ ...roster[2], rumorSummary: 'Hides unused jingles in the rack.' }],
  };
  const prompt = seedUserPrompt({ day: '2026-09-19', roles, register: RUMOR_REGISTERS[0] });
  assert.match(prompt, /Summary: Notices clocks/);
  assert.match(prompt, /Summary: Hides unused jingles/);
  assert.doesNotMatch(prompt, /Soul:|Dry, short sentences|Collects unused jingles/);
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

test('seed prompt omits hearers', () => {
  const roles = { teller: roster[0], hearers: [roster[1]], targets: [] };
  const prompt = seedUserPrompt({ day: '2026-09-19', roles, register: RUMOR_REGISTERS[0] });
  assert.doesNotMatch(prompt, /Hearers|Beta|Warm, over-explains the kettle/);
});

test('seed prompt names both targets without repeating the shared-beat rule', () => {
  const roles = { teller: roster[0], hearers: [roster[1]], targets: [roster[1], roster[2]] };
  const prompt = seedUserPrompt({ day: '2026-09-19', roles, register: RUMOR_REGISTERS[0] });
  assert.match(prompt, /Beta[\s\S]*Gamma/);
  assert.doesNotMatch(prompt, /one shared beat|Working together counts|Finish on that same prop/i);
});

test('seed prompt omits multi-target-only guidance for zero or one rumor-target', () => {
  const zero = seedUserPrompt({
    day: '2026-09-19',
    roles: { teller: roster[0], hearers: [roster[1]], targets: [] },
    register: RUMOR_REGISTERS[0],
  });
  const one = seedUserPrompt({
    day: '2026-09-19',
    roles: { teller: roster[0], hearers: [roster[1]], targets: [roster[2]] },
    register: RUMOR_REGISTERS[0],
  });
  assert.doesNotMatch(zero, /one shared beat/i);
  assert.doesNotMatch(one, /one shared beat/i);
});

test('SEED_SYSTEM does not prescribe a two-target sentence shape', () => {
  assert.match(SEED_SYSTEM, /One sentence/);
  assert.doesNotMatch(SEED_SYSTEM, /one action they share|working the prop together/);
});

test('REVIEW_SYSTEM edits for coherence and drops non-sequiturs', () => {
  assert.match(REVIEW_SYSTEM, /One sentence, 20 to 240 characters/);
  assert.match(REVIEW_SYSTEM, /coherent/);
  assert.match(REVIEW_SYSTEM, /non-sequiturs/i);
  assert.match(REVIEW_SYSTEM, /same people, the same prop, and the same event/);
  assert.match(reviewUserPrompt({ day: '2026-09-19', tidbits: [] }), /Remove non-sequiturs/);
  assert.doesNotMatch(REVIEW_SYSTEM, /sharper laugh|punch-up|cross-rumor continuity|clearer and funnier/i);
});

test('SEED_SYSTEM allows credible provenance while rumor-targets stay the subject', () => {
  assert.match(SEED_SYSTEM, /provenance|how the teller learned|overheard|walked in/i);
  assert.match(SEED_SYSTEM, /rumor-targets|the subject/i);
  assert.doesNotMatch(SEED_SYSTEM, /only about the subject\.?\s*$/m);
  assert.match(SEED_SYSTEM, /20 to 240/);
});

test('SEED_SYSTEM does not require a reaction menu', () => {
  assert.doesNotMatch(SEED_SYSTEM, /flinch, shriek, blurt|hands meet|same second/);
});

test('seedUserPrompt does not repeat the beat or sourcing rules', () => {
  for (const targets of [[], [roster[2]], [roster[1], roster[2]]]) {
    const prompt = seedUserPrompt({
      day: '2026-09-19',
      roles: { teller: roster[0], hearers: [roster[1]], targets },
      register: RUMOR_REGISTERS[0],
    });
    assert.doesNotMatch(prompt, /plausibly repeat|credible sourcing|Working together counts|Finish on that same prop|one shared beat/i);
  }
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
  assert.doesNotMatch(prompt, /Warm, over-explains the kettle/);
});
