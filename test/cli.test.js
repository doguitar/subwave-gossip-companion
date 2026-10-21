import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { refreshCountOption, generateOptions, applyCliOptions } from '../src/cli.js';
import { acquireMutationLock } from '../src/workspaceLock.js';
import { applyDotEnv, loadConfig } from '../src/config.js';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

async function spawnWithCorruptState(command) {
  const root = await mkdtemp(path.join(tmpdir(), 'gossip-cli-'));
  const statePath = path.join(root, 'data', 'gossip-state.json');
  await mkdir(path.dirname(statePath), { recursive: true });
  const corrupt = '{"tidbits":';
  await writeFile(statePath, corrupt);
  const result = spawnSync(process.execPath, ['src/cli.js', command, '--base-dir', root], {
    cwd: repo,
    encoding: 'utf8',
    timeout: 8000,
    env: companionEnv(root, statePath, 18787),
  });
  return { result, statePath, corrupt, after: await readFile(statePath, 'utf8') };
}

function assertCorruptStateFailure({ result, statePath, corrupt, after }) {
  assert.equal(result.status, 1);
  assert.equal(result.stderr.trim(), `${statePath} is not valid JSON`);
  assert.equal(after, corrupt);
}

test('serve exits before listening when the state file is corrupt', async () => {
  const spawned = await spawnWithCorruptState('serve');
  assertCorruptStateFailure(spawned);
  assert.doesNotMatch(`${spawned.result.stdout}\n${spawned.result.stderr}`, /listening/);
});

test('provider commands exit with the state-file error when preflight would also fail', async () => {
  for (const command of ['generate', 'seed', 'refresh', 'summarize-souls']) {
    const spawned = await spawnWithCorruptState(command);
    assertCorruptStateFailure(spawned);
  }
});

test('ingest-spoken exits without rewriting a corrupt state file', async () => {
  assertCorruptStateFailure(await spawnWithCorruptState('ingest-spoken'));
});

function companionEnv(root, statePath, port) {
  return {
    ...process.env,
    GOSSIP_BASE_DIR: root,
    GOSSIP_STATE_PATH: statePath,
    GOSSIP_TYPES_PATH: path.join(repo, 'gossip-types.json'),
    GOSSIP_OPERATIONAL_LOG: path.join(root, 'logs', 'gossip.log'),
    GOSSIP_LLM_CALL_LOG: '',
    GOSSIP_LLM_LOG_CONTENT: 'off',
    GOSSIP_LLM_FIXTURE: '',
    GOSSIP_REFRESH_SECRET: 'operator-secret',
    GOSSIP_REFRESH_COUNT: '1',
    GOSSIP_REFRESH_MAX_CONCURRENCY: '1',
    GOSSIP_REFRESH_MIN_INTERVAL_MS: '0',
    GOSSIP_REFRESH_BODY_MAX_BYTES: '16384',
    GOSSIP_HEADERS_TIMEOUT_MS: '10000',
    GOSSIP_REQUEST_TIMEOUT_MS: '30000',
    GOSSIP_SEED_CAP: '5',
    GOSSIP_HISTORY_GENERATIONS: '7',
    GOSSIP_REVIEW_ROUNDS: '0',
    GOSSIP_THREAD_MAX_TELLINGS: '3',
    GOSSIP_THREAD_MAX_AGE_MS: '86400000',
    GOSSIP_HOST: '127.0.0.1',
    GOSSIP_PORT: String(port),
    SUBWAVE_API_URL: 'http://127.0.0.1:9',
    SUBWAVE_API_TOKEN: 'token',
    SUBWAVE_API_USER: '',
    SUBWAVE_API_PASSWORD: '',
    PROVIDER: 'openai',
    PROVIDER_KEY: '',
    PROVIDER_MODEL: 'gpt-4o-mini',
    PROVIDER_THINKING: '',
    GOSSIP_LLM_API_KEY: '',
    GOSSIP_LLM_THINKING: '',
    GOSSIP_LLM_URL: '',
    OPENAI_API_KEY: '',
    ANTHROPIC_API_KEY: '',
    GOOGLE_API_KEY: '',
    OPENAI_BASE_URL: 'https://api.openai.com/v1',
  };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function spawnServe(root, statePath, port) {
  const child = spawn(process.execPath, ['src/cli.js', 'serve', '--base-dir', root], {
    cwd: repo,
    env: companionEnv(root, statePath, port),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.output = '';
  child.stdout.on('data', (chunk) => { child.output += chunk; });
  child.stderr.on('data', (chunk) => { child.output += chunk; });
  return child;
}

function waitForOutput(child, pattern, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    if (pattern.test(child.output)) {
      resolve(child.output);
      return;
    }
    const timer = setTimeout(() => {
      finish(new Error(`timed out waiting for ${pattern}: ${child.output}`));
    }, timeoutMs);
    const onExit = (code) => finish(new Error(`exited ${code} before ${pattern}: ${child.output}`));
    const onData = () => {
      if (pattern.test(child.output)) finish();
    };
    const finish = (err) => {
      clearTimeout(timer);
      child.stdout.off('data', onData);
      child.stderr.off('data', onData);
      child.off('exit', onExit);
      if (err) reject(err);
      else resolve(child.output);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', onExit);
  });
}

function stopped(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once('exit', () => resolve()));
}

test('a second serve on the same state file exits before listening and a replacement can start', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gossip-serve-'));
  const statePath = path.join(root, 'data', 'gossip-state.json');
  await mkdir(path.dirname(statePath), { recursive: true });
  const initial = `${JSON.stringify({ tidbits: [], generatedGossipHistory: [], gossipComments: [] })}\n`;
  await writeFile(statePath, initial);
  const firstPort = await freePort();
  const first = spawnServe(root, statePath, firstPort);
  let replacement;
  try {
    await waitForOutput(first, /listening/);
    const secondPort = await freePort();
    const second = spawnSync(process.execPath, ['src/cli.js', 'serve', '--base-dir', root], {
      cwd: repo,
      encoding: 'utf8',
      timeout: 8000,
      env: companionEnv(root, statePath, secondPort),
    });
    const secondOutput = `${second.stdout}\n${second.stderr}`;
    assert.equal(second.status, 1);
    assert.equal(second.stderr.includes(statePath), true);
    assert.match(second.stderr, /another server already owns the workspace/);
    assert.doesNotMatch(secondOutput, /listening/);
    assert.equal(await readFile(statePath, 'utf8'), initial);
    assert.equal(first.exitCode, null);
    const health = await fetch(`http://127.0.0.1:${firstPort}/health`);
    assert.equal(health.status, 200);
    assert.equal(await health.text(), 'ok\n');
    first.kill('SIGKILL');
    await stopped(first);
    const nextPort = await freePort();
    replacement = spawnServe(root, statePath, nextPort);
    await waitForOutput(replacement, /listening/);
    assert.equal(await readFile(statePath, 'utf8'), initial);
    const again = await fetch(`http://127.0.0.1:${nextPort}/health`);
    assert.equal(again.status, 200);
  } finally {
    first.kill('SIGKILL');
    replacement?.kill('SIGKILL');
    await stopped(first);
    if (replacement) await stopped(replacement);
  }
});

test('ingest-spoken exits non-zero and leaves the state file unchanged when the update lock is held', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gossip-lock-'));
  const statePath = path.join(root, 'data', 'gossip-state.json');
  await mkdir(path.dirname(statePath), { recursive: true });
  const initial = `${JSON.stringify({
    tidbits: [{ id: 'kept', text: 'kept rumor', createdAt: '2026-09-19T00:00:00.000Z', tellerPersonaId: 'p_a', hearerPersonaIds: [] }],
    generatedGossipHistory: [],
    gossipComments: [],
  })}\n`;
  await writeFile(statePath, initial);
  const release = await acquireMutationLock(statePath);
  try {
    const result = spawnSync(process.execPath, ['src/cli.js', 'ingest-spoken', '--base-dir', root], {
      cwd: repo,
      encoding: 'utf8',
      timeout: 15000,
      env: companionEnv(root, statePath, 18787),
    });
    assert.equal(result.status, 1);
    assert.equal(result.stderr.includes(statePath), true);
    assert.match(result.stderr, /could not be locked for an exclusive update/);
    assert.equal(await readFile(statePath, 'utf8'), initial);
  } finally {
    release();
  }
});
