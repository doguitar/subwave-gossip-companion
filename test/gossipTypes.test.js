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

test('ensureGossipTypesFile seeds four legacy registers', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gossip-types-'));
  const typesPath = path.join(dir, 'gossip-types.json');
  assert.equal(ensureGossipTypesFile(typesPath), true);
  const onDisk = JSON.parse(await readFile(typesPath, 'utf8'));
  assert.equal(onDisk.length, 4);
  const expected = defaultGossipTypesFileEntries();
  assert.deepEqual(
    onDisk.map((e) => e.slug),
    expected.map((e) => e.slug),
  );
  assert.deepEqual(
    onDisk.map((e) => e.guidance),
    DEFAULT_RUMOR_REGISTERS.map((r) => r.guidance),
  );
});

test('loadConfig resolves default gossip types path and loads catalog', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gossip-config-'));
  const { config, errors } = loadConfig({ ...apiEnv, GOSSIP_BASE_DIR: dir });
  assert.deepEqual(errors, []);
  assert.equal(config.gossipTypesPath, path.join(dir, 'gossip-types.json'));
  assert.equal(config.rumorRegisters.length, 4);
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
