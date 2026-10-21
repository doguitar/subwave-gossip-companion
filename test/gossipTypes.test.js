import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';

import { loadConfig, requireConfig } from '../src/config.js';
import {
  defaultGossipTypesFileEntries,
  ensureGossipTypesFile,
  loadGossipTypesFromPath,
  parseGossipTypesJson,
} from '../src/gossipTypes.js';
import { DEFAULT_RUMOR_REGISTERS, pickRumorRegister } from '../src/register.js';
import { seedUserPrompt } from '../src/llm.js';
import { PERSONA_A, PERSONA_B } from './helpers.js';

const apiEnv = {
  SUBWAVE_API_URL: 'https://listen.example/api',
  SUBWAVE_API_USER: 'admin',
  SUBWAVE_API_PASSWORD: 'x',
  GOSSIP_REFRESH_SECRET: 'test-secret',
};

function seq(values) {
  let i = 0;
  return () => {
    const v = values[Math.min(i, values.length - 1)];
    i += 1;
    return v;
  };
}

test('parseGossipTypesJson rejects empty catalog and duplicate slugs', () => {
  assert.match(
    parseGossipTypesJson('[]').errors.join('; '),
    /at least one entry/,
  );
  const dup = JSON.stringify([
    { slug: 'a', guidance: 'one' },
    { slug: 'a', guidance: 'two' },
  ]);
  assert.match(parseGossipTypesJson(dup).errors.join('; '), /duplicate gossip type slug: a/);
});

test('ensureGossipTypesFile seeds the packaged catalog', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gossip-types-'));
  const typesPath = path.join(dir, 'gossip-types.json');
  const packaged = JSON.parse(await readFile(new URL('../gossip-types.json', import.meta.url), 'utf8'));
  assert.deepEqual(defaultGossipTypesFileEntries(), packaged);
  assert.deepEqual(
    DEFAULT_RUMOR_REGISTERS.map((register) => register.id),
    packaged.map((entry) => entry.slug),
  );
  assert.equal(ensureGossipTypesFile(typesPath), true);
  const onDisk = JSON.parse(await readFile(typesPath, 'utf8'));
  assert.deepEqual(onDisk, packaged);
  await writeFile(typesPath, '   \n');
  assert.equal(ensureGossipTypesFile(typesPath), true);
  assert.deepEqual(JSON.parse(await readFile(typesPath, 'utf8')), packaged);
  await writeFile(typesPath, `${JSON.stringify([{ slug: 'kept', guidance: 'stay' }])}\n`);
  assert.equal(ensureGossipTypesFile(typesPath), false);
});

test('loadConfig resolves default gossip types path and loads catalog', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gossip-config-'));
  const { config, errors } = loadConfig({ ...apiEnv, GOSSIP_BASE_DIR: dir });
  assert.deepEqual(errors, []);
  assert.equal(config.gossipTypesPath, path.join(dir, 'gossip-types.json'));
  assert.equal(config.rumorRegisters.length, DEFAULT_RUMOR_REGISTERS.length);
  assert.equal(config.rumorRegisters[0].id, DEFAULT_RUMOR_REGISTERS[0].id);
});

test('loadConfig honors GOSSIP_TYPES_PATH for custom catalog', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gossip-custom-'));
  const customPath = path.join(dir, 'custom-types.json');
  await writeFile(
    customPath,
    `${JSON.stringify([{ slug: 'extra-bit', name: 'extra bit', guidance: 'Only this guidance.' }])}\n`,
    'utf8',
  );
  const { config, errors } = loadConfig({
    ...apiEnv,
    GOSSIP_BASE_DIR: dir,
    GOSSIP_TYPES_PATH: customPath,
  });
  assert.deepEqual(errors, []);
  assert.equal(config.rumorRegisters.length, 1);
  assert.equal(config.rumorRegisters[0].id, 'extra-bit');
});

test('requireConfig fails on invalid gossip types catalog', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gossip-bad-'));
  const typesPath = path.join(dir, 'gossip-types.json');
  await writeFile(typesPath, '[]\n', 'utf8');
  assert.throws(
    () => requireConfig({ ...apiEnv, GOSSIP_BASE_DIR: dir, GOSSIP_TYPES_PATH: typesPath }),
    (err) => err.code === 'CONFIG' && /at least one entry/.test(err.message),
  );
});

test('pickRumorRegister chooses uniformly from custom catalog', () => {
  const catalog = [
    { id: 'a', name: 'a', guidance: 'ga' },
    { id: 'b', name: 'b', guidance: 'gb' },
    { id: 'c', name: 'c', guidance: 'gc' },
  ];
  const first = pickRumorRegister({ catalog, rng: seq([0, 0.99, 0.5]) });
  const second = pickRumorRegister({ catalog, rng: seq([0.34, 0.34]) });
  const third = pickRumorRegister({ catalog, rng: seq([0.99]) });
  assert.equal(first.id, 'a');
  assert.equal(second.id, 'b');
  assert.equal(third.id, 'c');
});

test('parseGossipTypesJson carries optional targetCount on registers', () => {
  const payload = JSON.stringify([
    { slug: 'station-life', guidance: 'no targets', targetCount: 0 },
    { slug: 'feud', guidance: 'two targets', targetCount: 2 },
    { slug: 'any', guidance: 'any count' },
  ]);
  const { registers, errors } = parseGossipTypesJson(payload);
  assert.deepEqual(errors, undefined);
  assert.equal(registers[0].targetCount, 0);
  assert.equal(registers[1].targetCount, 2);
  assert.equal(registers[2].targetCount, undefined);
});

test('parseGossipTypesJson rejects invalid targetCount values', () => {
  const badType = JSON.stringify([{ slug: 'x', guidance: 'g', targetCount: 'two' }]);
  assert.match(parseGossipTypesJson(badType).errors.join('; '), /non-negative integer/);
  const negative = JSON.stringify([{ slug: 'x', guidance: 'g', targetCount: -1 }]);
  assert.match(parseGossipTypesJson(negative).errors.join('; '), /non-negative integer/);
  const tooHigh = JSON.stringify([{ slug: 'x', guidance: 'g', targetCount: 3 }]);
  assert.match(parseGossipTypesJson(tooHigh).errors.join('; '), /exceeds the maximum/);
});

test('requireConfig fails when gossip types targetCount is out of range', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gossip-tc-'));
  const typesPath = path.join(dir, 'gossip-types.json');
  await writeFile(
    typesPath,
    `${JSON.stringify([{ slug: 'only-two', guidance: 'needs two targets', targetCount: 9 }])}\n`,
    'utf8',
  );
  assert.throws(
    () => requireConfig({ ...apiEnv, GOSSIP_BASE_DIR: dir, GOSSIP_TYPES_PATH: typesPath }),
    (err) => err.code === 'CONFIG' && /exceeds the maximum/.test(err.message),
  );
});

test('pickRumorRegister filters by targetCount and returns null when none match', () => {
  const constrained = [
    { id: 'zero-only', name: 'z', guidance: 'g', targetCount: 0 },
    { id: 'pair', name: 'p', guidance: 'g', targetCount: 2 },
  ];
  assert.equal(pickRumorRegister({ catalog: constrained, targetCount: 1 }), null);
  assert.equal(pickRumorRegister({ catalog: constrained, targetCount: 0, rng: seq([0]) }).id, 'zero-only');
  const catalog = [
    ...constrained,
    { id: 'open', name: 'o', guidance: 'g' },
  ];
  const twoEligible = pickRumorRegister({ catalog, targetCount: 2, rng: seq([0.99]) });
  assert.ok(['open', 'pair'].includes(twoEligible.id));
});

test('seedUserPrompt reflects edited guidance from loaded register', () => {
  const roles = { teller: PERSONA_A, hearers: [PERSONA_B], targets: [] };
  const register = { id: 'custom', name: 'custom', guidance: 'Operator-only guidance text.' };
  const prompt = seedUserPrompt({ day: '2026-09-19', roles, register });
  assert.match(prompt, /custom — Operator-only guidance text\./);
});

test('loadGossipTypesFromPath reads existing file without re-seeding', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gossip-existing-'));
  const typesPath = path.join(dir, 'gossip-types.json');
  await writeFile(
    typesPath,
    `${JSON.stringify([{ slug: 'solo', guidance: 'solo guidance' }])}\n`,
    'utf8',
  );
  const { registers, errors } = loadGossipTypesFromPath(typesPath);
  assert.deepEqual(errors, undefined);
  assert.equal(registers.length, 1);
  assert.equal(registers[0].name, 'solo');
});
