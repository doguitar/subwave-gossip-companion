import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';

import { loadConfig } from '../src/config.js';
import {
  bundledPromptPath,
  ensurePromptWorkspace,
  PROMPT_DRIFT_WARN,
  warnIfPromptDrift,
  workspacePromptPaths,
} from '../src/promptWorkspace.js';

const apiEnv = {
  SUBWAVE_API_URL: 'https://listen.example/api',
  SUBWAVE_API_USER: 'admin',
  SUBWAVE_API_PASSWORD: 'x',
  GOSSIP_REFRESH_SECRET: 'test-secret',
};

test('ensurePromptWorkspace writes default snapshot and seeds missing live prompt', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gossip-prompt-'));
  const bundled = bundledPromptPath();
  const bundledText = await readFile(bundled, 'utf8');

  const { seededLive } = ensurePromptWorkspace(dir, bundled);
  assert.equal(seededLive, true);

  const { live, defaultSnapshot } = workspacePromptPaths(dir);
  const liveText = await readFile(live, 'utf8');
  const defaultText = await readFile(defaultSnapshot, 'utf8');
  assert.equal(liveText, bundledText);
  assert.equal(defaultText, bundledText);
});

test('ensurePromptWorkspace refreshes default without overwriting customized live prompt', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gossip-prompt-custom-'));
  const bundled = bundledPromptPath();
  ensurePromptWorkspace(dir, bundled);

  const { live, defaultSnapshot } = workspacePromptPaths(dir);
  await writeFile(live, 'operator custom prompt\n', 'utf8');
  await writeFile(defaultSnapshot, 'stale default\n', 'utf8');

  const { seededLive } = ensurePromptWorkspace(dir, bundled);
  assert.equal(seededLive, false);
  assert.equal(await readFile(live, 'utf8'), 'operator custom prompt\n');
  assert.equal(await readFile(defaultSnapshot, 'utf8'), await readFile(bundled, 'utf8'));
});

test('ensurePromptWorkspace seeds empty live prompt from default snapshot', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gossip-prompt-empty-'));
  const bundled = bundledPromptPath();
  ensurePromptWorkspace(dir, bundled);

  const { live } = workspacePromptPaths(dir);
  await writeFile(live, '   \n', 'utf8');

  const { seededLive } = ensurePromptWorkspace(dir, bundled);
  assert.equal(seededLive, true);
  assert.equal(await readFile(live, 'utf8'), await readFile(bundled, 'utf8'));
});

test('warnIfPromptDrift emits one warn line when trimmed contents differ', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gossip-drift-'));
  const { live } = workspacePromptPaths(dir);
  ensurePromptWorkspace(dir, bundledPromptPath());
  await writeFile(live, 'custom\n', 'utf8');

  const warnings = [];
  const log = { warn: (msg) => warnings.push(msg) };
  warnIfPromptDrift(dir, log);
  assert.deepEqual(warnings, [PROMPT_DRIFT_WARN]);
});

test('warnIfPromptDrift is silent when trimmed contents match', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gossip-drift-match-'));
  ensurePromptWorkspace(dir, bundledPromptPath());

  const warnings = [];
  warnIfPromptDrift(dir, { warn: (msg) => warnings.push(msg) });
  assert.deepEqual(warnings, []);
});

test('loadConfig resolves prompt only under GOSSIP_BASE_DIR and ignores GOSSIP_PROMPT_PATH', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gossip-prompt-config-'));
  const { live } = workspacePromptPaths(dir);
  await writeFile(live, 'workspace system rules\n', 'utf8');

  const { config, errors } = loadConfig({
    ...apiEnv,
    GOSSIP_BASE_DIR: dir,
    GOSSIP_PROMPT_PATH: '/other/prompt.md',
  });
  assert.deepEqual(errors, []);
  assert.equal(config.promptPath, live);
  assert.equal(config.systemPrompt, 'workspace system rules');
});
