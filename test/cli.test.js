import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { refreshCountOption, generateOptions, applyCliOptions } from '../src/cli.js';
import { applyDotEnv, loadConfig } from '../src/config.js';
import { fileURLToPath } from 'node:url';

const config = { reviewRounds: 0 };

test('generateOptions passes reasoning through and overrides review steps', () => {
  const options = generateOptions(['generate', '--reasoning', 'none', '--review-steps', '2'], config);
  assert.equal(options.runConfig.llmThinkingLevel, 'none');
  assert.equal(options.reviewRounds, 2);
  assert.equal(config.reviewRounds, 0);
});

test('generateOptions keeps config review rounds when the flag is absent', () => {
  const options = generateOptions(['generate'], { reviewRounds: 1 });
  assert.equal(options.reviewRounds, 1);
  assert.equal(options.runConfig.llmThinkingLevel, undefined);
});

test('generateOptions rejects a review step outside 0-5', () => {
  assert.throws(() => generateOptions(['generate', '--review-steps', '9'], config), /0-5/);
});

test('refresh count uses the configured default or a validated CLI override', () => {
  assert.equal(refreshCountOption(['refresh', '--base-dir', '.', '1'], { refreshCount: 2 }), 1);
  assert.equal(refreshCountOption(['refresh', '--base-dir', '.'], { refreshCount: 2 }), 2);
  assert.throws(() => refreshCountOption(['refresh', '0'], { refreshCount: 2 }), /1-10/);
});

test('refresh count environment value is validated', () => {
  const { config, errors } = loadConfig({ GOSSIP_REFRESH_COUNT: '11' });
  assert.equal(config.refreshCount, 1);
  assert.ok(errors.includes('GOSSIP_REFRESH_COUNT must be an integer 1-10'));
});

test('refresh authentication and admission configuration are strict', () => {
  const missing = loadConfig({});
  assert.ok(missing.errors.includes('GOSSIP_REFRESH_SECRET is required'));

  const { config, errors } = loadConfig({
    GOSSIP_REFRESH_SECRET: 'operator-secret',
    GOSSIP_REFRESH_MAX_CONCURRENCY: '0',
    GOSSIP_REFRESH_MIN_INTERVAL_MS: '-1',
  });
  assert.equal(config.refreshSecret, 'operator-secret');
  assert.ok(errors.includes('GOSSIP_REFRESH_MAX_CONCURRENCY must be an integer 1-10'));
  assert.ok(errors.includes('GOSSIP_REFRESH_MIN_INTERVAL_MS must be an integer 0-3600000'));
});

test('dotenv path follows no flag, GOSSIP_BASE_DIR, then --base-dir', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dotenv-'));
  const flagged = path.join(root, 'flagged');
  const fromEnv = path.join(root, 'from-env');
  await writeFile(path.join(flagged, '.env'), 'FROM_DOTENV=flag\n', { flag: 'w' }).catch(async () => {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(flagged, { recursive: true });
    await mkdir(fromEnv, { recursive: true });
    await writeFile(path.join(flagged, '.env'), 'FROM_DOTENV=flag\n');
    await writeFile(path.join(fromEnv, '.env'), 'FROM_DOTENV=envdir\n');
  });
  const cwdFile = path.join(root, '.env');
  await writeFile(cwdFile, 'FROM_DOTENV=cwd\n');

  const noFlag = {};
  applyCliOptions(['serve'], noFlag);
  // no base dir: loader targets ./.env from the process cwd, which is not this fixture
  assert.equal(noFlag.FROM_DOTENV, undefined);

  const envDir = { GOSSIP_BASE_DIR: fromEnv };
  applyCliOptions(['serve'], envDir);
  assert.equal(envDir.FROM_DOTENV, 'envdir');

  const flaggedEnv = { GOSSIP_BASE_DIR: fromEnv };
  applyCliOptions(['serve', '--base-dir', flagged], flaggedEnv);
  assert.equal(flaggedEnv.GOSSIP_BASE_DIR, flagged);
  assert.equal(flaggedEnv.FROM_DOTENV, 'flag');

  const skipped = applyDotEnv(undefined, {});
  assert.equal(skipped.FROM_DOTENV, undefined);
  assert.throws(() => applyDotEnv(root, {}), /Cannot read env file/);
});

test('CLI process loads --base-dir .env before config failure', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dotenv-cli-'));
  await writeFile(path.join(root, '.env'), 'GOSSIP_REFRESH_SECRET=from-dotenv\n');
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const result = spawnSync(process.execPath, ['src/cli.js', 'refresh', '--base-dir', root], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, GOSSIP_BASE_DIR: '', PROVIDER_KEY: '', SUBWAVE_API_URL: '' },
  });
  const output = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.status === 0, false);
  assert.doesNotMatch(output, /Cannot read env file|The "path" argument/);
  assert.match(output, /Invalid configuration|SUBWAVE_API_URL|PROVIDER/);
});
