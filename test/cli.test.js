import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { chmod, mkdir, mkdtemp, readFile, readdir, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { refreshCountOption, generateOptions, applyCliOptions } from '../src/cli.js';
import { acquireMutationLock } from '../src/workspaceLock.js';
import { applyDotEnv, loadConfig, requireConfig } from '../src/config.js';
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

test('shutdown deadline defaults to 5000 and uses the bounded integer error', () => {
  const unset = loadConfig({ GOSSIP_REFRESH_SECRET: 'operator-secret' });
  assert.equal(unset.config.shutdownDeadlineMs, 5000);
  assert.equal(unset.errors.some((error) => error.includes('GOSSIP_SHUTDOWN_DEADLINE_MS')), false);

  const zero = loadConfig({ GOSSIP_REFRESH_SECRET: 'operator-secret', GOSSIP_SHUTDOWN_DEADLINE_MS: '0' });
  assert.equal(zero.config.shutdownDeadlineMs, 0);
  assert.equal(zero.errors.some((error) => error.includes('GOSSIP_SHUTDOWN_DEADLINE_MS')), false);

  for (const value of ['1.5', '-1', '3600001', 'nope']) {
    const { errors } = loadConfig({
      GOSSIP_REFRESH_SECRET: 'operator-secret',
      GOSSIP_SHUTDOWN_DEADLINE_MS: value,
    });
    assert.ok(errors.includes('GOSSIP_SHUTDOWN_DEADLINE_MS must be an integer 0-3600000'));
  }
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
  const cwdOnly = path.join(root, 'cwd');
  await mkdir(flagged, { recursive: true });
  await mkdir(fromEnv, { recursive: true });
  await mkdir(cwdOnly, { recursive: true });
  await writeFile(path.join(flagged, '.env'), 'FROM_DOTENV=flag\n');
  await writeFile(path.join(fromEnv, '.env'), 'FROM_DOTENV=envdir\n');
  await writeFile(path.join(flagged, 'config.yaml'), 'GOSSIP_FEED_BASE_URL: from-flag-yaml\n');
  await writeFile(path.join(fromEnv, 'config.yaml'), 'GOSSIP_FEED_BASE_URL: from-env-yaml\n');
  await writeFile(path.join(root, '.env'), 'FROM_DOTENV=cwd\n');

  const previous = process.cwd();
  try {
    process.chdir(cwdOnly);
    const noFlag = {};
    applyCliOptions(['serve'], noFlag);
    assert.equal(noFlag.FROM_DOTENV, undefined);
    assert.equal(noFlag.GOSSIP_FEED_BASE_URL, undefined);
    assert.match(await readFile(path.join(cwdOnly, 'config.yaml'), 'utf8'), /^# Missing config options$/m);
  } finally {
    process.chdir(previous);
  }

  const envDir = { GOSSIP_BASE_DIR: fromEnv };
  applyCliOptions(['serve'], envDir);
  assert.equal(envDir.FROM_DOTENV, 'envdir');
  assert.equal(envDir.GOSSIP_FEED_BASE_URL, 'from-env-yaml');

  const flaggedEnv = { GOSSIP_BASE_DIR: fromEnv };
  applyCliOptions(['serve', '--base-dir', flagged], flaggedEnv);
  assert.equal(flaggedEnv.GOSSIP_BASE_DIR, flagged);
  assert.equal(flaggedEnv.FROM_DOTENV, 'flag');
  assert.equal(flaggedEnv.GOSSIP_FEED_BASE_URL, 'from-flag-yaml');

  const skipped = applyDotEnv(undefined, {});
  assert.equal(skipped.FROM_DOTENV, undefined);
  assert.throws(() => applyDotEnv(root, {}), /Cannot read env file/);

  const blocked = path.join(root, 'blocked');
  await mkdir(path.join(blocked, '.env'), { recursive: true });
  assert.throws(() => applyCliOptions(['serve', '--base-dir', blocked], {}), /Cannot read env file/);
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
  assert.doesNotMatch(output, /Cannot read env file|Cannot read settings file|The "path" argument/);
  assert.match(output, /Invalid configuration|SUBWAVE_API_URL|PROVIDER/);
  assert.match(await readFile(path.join(root, 'config.yaml'), 'utf8'), /# Missing config options/);
});

test('YAML literals, references, and aliases follow settings precedence', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'yaml-settings-'));
  await writeFile(path.join(dir, '.env'), [
    'GOSSIP_HOST=from-dotenv',
    'GOSSIP_SEED_CAP=9',
    'GOSSIP_MIN_RUMOR_LENGTH=33',
    'GOSSIP_HISTORY_GENERATIONS=6',
    'PROVIDER_KEY=from-dotenv-key',
    'GOSSIP_REFRESH_SECRET=from-dotenv-secret',
    'OTHER_HOST=from-dotenv-host',
  ].join('\n'));
  await writeFile(path.join(dir, 'config.yaml'), [
    'GOSSIP_HOST: from-yaml',
    'SUBWAVE_API_USER: os.environ/GOSSIP_HOST',
    'GOSSIP_PORT: 8081',
    'GOSSIP_REVIEW_ROUNDS: 0',
    'GOSSIP_MIN_RUMOR_LENGTH: 40',
    'PROVIDER_THINKING: true',
    'GOSSIP_LLM_PROVIDER: google',
    'PROVIDER_KEY: os.environ/PROVIDER_KEY',
    'GOSSIP_REFRESH_SECRET: os.environ/ABSENT_SECRET',
    'SUBWAVE_API_URL: os.environ/EMPTY_URL',
    'OPENAI_BASE_URL: os.environ/OTHER_HOST',
    'nested:',
    '  GOSSIP_THREAD_MAX_TELLINGS: 9',
    'GOSSIP_TTS_POLL_MS:',
    '  ignored: 1',
    'NOT_A_SETTING: 1',
  ].join('\n'));
  const env = {
    GOSSIP_BASE_DIR: dir,
    GOSSIP_SEED_CAP: '4',
    GOSSIP_MIN_RUMOR_LENGTH: '21',
    GOSSIP_HISTORY_GENERATIONS: '',
    EMPTY_URL: '',
    GOSSIP_TYPES_PATH: path.join(repo, 'gossip-types.json'),
  };
  applyCliOptions(['serve', '--base-dir', dir], env);
  assert.equal(env.GOSSIP_SEED_CAP, '4');
  assert.equal(env.GOSSIP_MIN_RUMOR_LENGTH, '21');
  assert.equal(env.GOSSIP_HISTORY_GENERATIONS, '6');
  assert.equal(env.GOSSIP_HOST, 'from-yaml');
  assert.equal(env.SUBWAVE_API_USER, 'from-dotenv');
  assert.equal(env.GOSSIP_PORT, '8081');
  assert.equal(env.GOSSIP_REVIEW_ROUNDS, '0');
  assert.equal(env.PROVIDER_THINKING, 'true');
  assert.equal(env.PROVIDER_KEY, 'from-dotenv-key');
  assert.equal(env.GOSSIP_REFRESH_SECRET, undefined);
  assert.equal(env.SUBWAVE_API_URL, undefined);
  assert.equal(env.OPENAI_BASE_URL, 'from-dotenv-host');
  assert.equal(env.GOSSIP_THREAD_MAX_TELLINGS, undefined);
  assert.equal(env.GOSSIP_TTS_POLL_MS, undefined);
  assert.equal(env.NOT_A_SETTING, undefined);
  assert.equal(env.nested, undefined);
  const loaded = loadConfig(env);
  assert.equal(loaded.config.llmProvider, 'google');
  assert.equal(loaded.config.port, 8081);
  assert.equal(loaded.config.reviewRounds, 0);
  assert.equal(loaded.config.llmThinkingLevel, 'true');
  assert.ok(loaded.errors.includes('GOSSIP_REFRESH_SECRET is required'));
  assert.ok(loaded.errors.includes('SUBWAVE_API_URL is required'));
  assert.equal(loaded.errors.some((error) => error.includes('os.environ')), false);
  assert.throws(() => requireConfig(env), (err) => {
    assert.match(err.message, /GOSSIP_REFRESH_SECRET is required/);
    assert.doesNotMatch(err.message, /os\.environ/);
    return true;
  });
});

test('missing settings block is created once and updated in place', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'yaml-missing-'));
  const file = path.join(dir, 'config.yaml');
  const note = '# keep this note\nSUBWAVE_API_URL: "https://station.example/api"\nGOSSIP_TTS_POLL_MS:\n  ignored: 1\n';
  await writeFile(file, note);
  const opened = { GOSSIP_BASE_DIR: dir };
  applyCliOptions(['serve', '--base-dir', dir], opened);
  assert.equal(opened.GOSSIP_TTS_POLL_MS, undefined);
  const first = await readFile(file, 'utf8');
  assert.ok(first.startsWith(note));
  assert.equal(first.match(/# Missing config options/g).length, 1);
  assert.match(first, /^# GOSSIP_PORT: 8080$/m);
  assert.match(first, /^# GOSSIP_REFRESH_SECRET:$/m);
  assert.match(first, /^# PROVIDER_MODEL: gpt-4o-mini$/m);
  assert.doesNotMatch(first, /^# SUBWAVE_API_URL:/m);
  assert.match(first, /^# GOSSIP_TTS_POLL_MS: 3000$/m);
  applyCliOptions(['serve', '--base-dir', dir], { GOSSIP_BASE_DIR: dir });
  assert.equal(await readFile(file, 'utf8'), first);

  await writeFile(file, first.replace('# Missing config options', 'GOSSIP_HOST: "127.0.0.1"\n# Missing config options'));
  const env = { GOSSIP_BASE_DIR: dir };
  applyCliOptions(['serve', '--base-dir', dir], env);
  const next = await readFile(file, 'utf8');
  assert.ok(next.startsWith(note));
  assert.equal(next.match(/# Missing config options/g).length, 1);
  assert.match(next, /^GOSSIP_HOST: "127\.0\.0\.1"$/m);
  assert.doesNotMatch(next, /^# GOSSIP_HOST:/m);
  assert.equal(env.GOSSIP_HOST, '127.0.0.1');
  assert.equal(env.GOSSIP_PORT, undefined);
});

test('settings read errors name the path and unwritable files are left in place', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yaml-read-'));
  const broken = path.join(root, 'broken');
  await mkdir(broken, { recursive: true });
  await mkdir(path.join(broken, 'config.yaml'));
  assert.throws(() => applyCliOptions(['serve', '--base-dir', broken], {}), (err) => {
    assert.match(err.message, /Cannot read settings file/);
    assert.ok(err.message.includes(path.join(broken, 'config.yaml')));
    return true;
  });

  const readonlyFile = path.join(root, 'file');
  await mkdir(readonlyFile, { recursive: true });
  const yaml = path.join(readonlyFile, 'config.yaml');
  const body = '# keep this note\nGOSSIP_PORT: 8081\n';
  await writeFile(yaml, body);
  await chmod(yaml, 0o444);
  try {
    const env = { GOSSIP_BASE_DIR: readonlyFile };
    applyCliOptions(['serve', '--base-dir', readonlyFile], env);
    assert.equal(env.GOSSIP_PORT, '8081');
    assert.equal(await readFile(yaml, 'utf8'), body);
  } finally {
    await chmod(yaml, 0o644);
  }

  const readonlyDir = path.join(root, 'dir');
  await mkdir(readonlyDir, { recursive: true });
  const locked = path.join(readonlyDir, 'config.yaml');
  if (process.platform === 'win32') {
    const user = process.env.USERNAME;
    const deny = spawnSync('icacls', [readonlyDir, '/deny', `${user}:(W,M)`], { encoding: 'utf8' });
    assert.equal(deny.status, 0, deny.stderr);
    try {
      applyCliOptions(['serve', '--base-dir', readonlyDir], {});
      await assert.rejects(readFile(locked, 'utf8'));
    } finally {
      spawnSync('icacls', [readonlyDir, '/remove:d', user], { encoding: 'utf8' });
    }
  } else {
    await chmod(readonlyDir, 0o555);
    try {
      applyCliOptions(['serve', '--base-dir', readonlyDir], {});
      await assert.rejects(readFile(locked, 'utf8'));
    } finally {
      await chmod(readonlyDir, 0o755);
    }
  }
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

test('startup prunes expired operational segments when the call log is disabled', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gossip-oplog-'));
  const statePath = path.join(root, 'data', 'gossip-state.json');
  const logDir = path.join(root, 'logs');
  await mkdir(path.dirname(statePath), { recursive: true });
  const corrupt = '{"tidbits":';
  await writeFile(statePath, corrupt);
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const aged = async (name, text, mtimeMs) => {
    const file = path.join(logDir, name);
    await mkdir(logDir, { recursive: true });
    await writeFile(file, text);
    const when = new Date(mtimeMs);
    await utimes(file, when, when);
    return file;
  };
  const active = await aged('gossip.log', 'active-old\n', now - 8 * day);
  const stale = await aged('gossip.1000.log', 'rolled-old\n', now - 8 * day);
  const fresh = await aged('gossip.2000.log', 'rolled-fresh\n', now - day);
  const unrelated = await aged('llm-calls.jsonl', '{"at":"old"}\n', now - 8 * day);
  const result = spawnSync(process.execPath, ['src/cli.js', 'ingest-spoken', '--base-dir', root], {
    cwd: repo,
    encoding: 'utf8',
    timeout: 8000,
    env: {
      ...companionEnv(root, statePath, 18787),
      GOSSIP_LLM_CALL_LOG: '',
      GOSSIP_OPERATIONAL_LOG_MAX_BYTES: '524288',
      GOSSIP_OPERATIONAL_LOG_RETENTION_MS: '604800000',
    },
  });
  assert.equal(result.status, 1);
  assert.equal(result.stderr.trim(), `${statePath} is not valid JSON`);
  assert.equal(await readFile(statePath, 'utf8'), corrupt);
  await assert.rejects(readFile(active, 'utf8'));
  await assert.rejects(readFile(stale, 'utf8'));
  assert.equal(await readFile(fresh, 'utf8'), 'rolled-fresh\n');
  assert.equal(await readFile(unrelated, 'utf8'), '{"at":"old"}\n');
  assert.equal((await readdir(logDir)).includes('gossip.log'), false);
});

test('operational log maintenance failure aborts startup', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gossip-oplog-'));
  const logs = path.join(root, 'logs');
  await writeFile(logs, 'not-a-directory');
  const statePath = path.join(root, 'data', 'gossip-state.json');
  const result = spawnSync(process.execPath, ['src/cli.js', 'ingest-spoken', '--base-dir', root], {
    cwd: repo,
    encoding: 'utf8',
    timeout: 8000,
    env: {
      ...companionEnv(root, statePath, 18787),
      GOSSIP_LLM_CALL_LOG: '',
      GOSSIP_OPERATIONAL_LOG: path.join(logs, 'gossip.log'),
    },
  });
  const output = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.status, 1);
  assert.doesNotMatch(output, /storage ready/);
  assert.doesNotMatch(output, /listening/);
  assert.equal(await readFile(logs, 'utf8'), 'not-a-directory');
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

function spawnServe(root, statePath, port, extra = {}) {
  const child = spawn(process.execPath, ['src/cli.js', 'serve', '--base-dir', root], {
    cwd: repo,
    env: { ...companionEnv(root, statePath, port), ...extra },
    stdio: process.platform === 'win32'
      ? ['ignore', 'pipe', 'pipe', 'ipc']
      : ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.output = '';
  child.stdout.on('data', (chunk) => { child.output += chunk; });
  child.stderr.on('data', (chunk) => { child.output += chunk; });
  if (process.platform === 'win32') {
    const kill = child.kill.bind(child);
    child.kill = (signal = 'SIGTERM') => {
      if (signal === 'SIGKILL' || signal === 'SIGQUIT' || !child.connected) return kill(signal);
      if (signal === 'SIGTERM' || signal === 'SIGINT') {
        try {
          child.send(signal);
          return true;
        } catch {
          return kill(signal);
        }
      }
      return kill(signal);
    };
  }
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

function shutdownOutcome(output) {
  const matches = [...output.matchAll(/\[gossip\] shutdown (\{.*\})/g)];
  assert.equal(matches.length, 1, output);
  return JSON.parse(matches[0][1]);
}

function exitWithin(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`still running after ${timeoutMs}ms\n${child.output}`));
    }, timeoutMs);
    child.once('exit', (code) => {
      clearTimeout(timer);
      setImmediate(() => resolve(code));
    });
  });
}

function listenFakeStation() {
  const llmWaiters = [];
  let llmCalls = 0;
  let releaseSeed = null;
  const seedGate = new Promise((resolve) => { releaseSeed = resolve; });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (url.pathname === '/settings') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        values: {
          djHouseRules: '',
          personas: [
            { id: 'p_a', name: 'Alpha', soul: 'Alpha keeps a spare cart.' },
            { id: 'p_b', name: 'Beta', soul: 'Beta keeps a spare cart.' },
            { id: 'p_c', name: 'Gamma', soul: 'Gamma keeps a spare cart.' },
          ],
        },
      }));
      return;
    }
    if (url.pathname === '/schedule') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        timezone: 'UTC',
        personas: [
          { id: 'p_a', name: 'Alpha' },
          { id: 'p_b', name: 'Beta' },
          { id: 'p_c', name: 'Gamma' },
        ],
        shows: [{ name: 'Island Time', personaId: 'p_a', guestPersonaIds: [] }],
      }));
      return;
    }
    if (url.pathname === '/session') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ messages: [] }));
      return;
    }
    if (url.pathname === '/debug') {
      req.on('close', () => { if (!res.writableEnded) res.end(); });
      return;
    }
    if (url.pathname.endsWith('/chat/completions')) {
      llmCalls += 1;
      const call = llmCalls;
      llmWaiters.forEach((waiter) => waiter(call));
      const body = JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              summary: 'Keeps a spare cart in the booth.',
              rumor: 'word is Alpha, Beta, and Gamma left the booth kettle whistling through the legal ID',
            }),
          },
        }],
      });
      if (call >= 4) {
        seedGate.then(() => {
          if (res.writableEnded) return;
          res.setHeader('content-type', 'application/json');
          res.end(body);
        });
        req.on('close', () => { if (!res.writableEnded) res.end(); });
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.end(body);
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
  return {
    server,
    releaseSeed,
    whenLlmCall(count) {
      if (llmCalls >= count) return Promise.resolve(llmCalls);
      return new Promise((resolve) => {
        const waiter = (call) => {
          if (call >= count) {
            llmWaiters.splice(llmWaiters.indexOf(waiter), 1);
            resolve(call);
          }
        };
        llmWaiters.push(waiter);
      });
    },
  };
}

async function emptyWorkspace() {
  const root = await mkdtemp(path.join(tmpdir(), 'gossip-shutdown-'));
  const statePath = path.join(root, 'data', 'gossip-state.json');
  await mkdir(path.dirname(statePath), { recursive: true });
  await writeFile(statePath, `${JSON.stringify({ tidbits: [], generatedGossipHistory: [], gossipComments: [], boardRevision: 0 })}\n`);
  return { root, statePath };
}

test('idle SIGTERM and SIGINT exit 0 without waiting out the deadline', async () => {
  for (const signal of ['SIGTERM', 'SIGINT']) {
    const { root, statePath } = await emptyWorkspace();
    const port = await freePort();
    const child = spawnServe(root, statePath, port, { GOSSIP_SHUTDOWN_DEADLINE_MS: '30000' });
    try {
      await waitForOutput(child, /listening/);
      const started = Date.now();
      child.kill(signal);
      child.kill(signal);
      assert.equal(await exitWithin(child, 2500), 0);
      assert.ok(Date.now() - started < 2500);
      const outcome = shutdownOutcome(child.output);
      assert.equal(outcome.signal, signal);
      assert.equal(outcome.deadlineMs, 30000);
      assert.equal(outcome.forced, false);
      assert.deepEqual(outcome.refreshes, { drained: 0, aborted: 0 });
      assert.deepEqual(outcome.watchers, { drained: 0, aborted: 0 });
      assert.match(child.output, new RegExp(`\\[gossip\\] received ${signal}; shutting down`));
    } finally {
      child.kill('SIGKILL');
      await stopped(child);
    }
  }
});

test('an idle keep-alive connection does not delay shutdown', async () => {
  const { root, statePath } = await emptyWorkspace();
  const port = await freePort();
  const child = spawnServe(root, statePath, port, { GOSSIP_SHUTDOWN_DEADLINE_MS: '30000' });
  let socket;
  try {
    await waitForOutput(child, /listening/);
    socket = await new Promise((resolve, reject) => {
      const connection = net.connect(port, '127.0.0.1');
      let received = '';
      connection.setEncoding('utf8');
      connection.on('data', (chunk) => {
        received += chunk;
        if (received.includes('\r\n\r\n')) resolve(connection);
      });
      connection.on('error', reject);
      connection.on('connect', () => {
        connection.write('GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n');
      });
    });
    const started = Date.now();
    child.kill('SIGTERM');
    assert.equal(await exitWithin(child, 2500), 0);
    assert.ok(Date.now() - started < 2500);
    const outcome = shutdownOutcome(child.output);
    assert.equal(outcome.forced, false);
  } finally {
    socket?.destroy();
    child.kill('SIGKILL');
    await stopped(child);
  }
});

test('deadline 0 abandons an in-flight refresh and a second signal does not skip a started commit', async () => {
  const fake = listenFakeStation();
  await new Promise((resolve) => fake.server.listen(0, '127.0.0.1', resolve));
  const api = `http://127.0.0.1:${fake.server.address().port}`;
  const { root, statePath } = await emptyWorkspace();
  const port = await freePort();
  const child = spawnServe(root, statePath, port, {
    GOSSIP_SHUTDOWN_DEADLINE_MS: '0',
    SUBWAVE_API_URL: api,
    OPENAI_BASE_URL: `${api}/v1`,
    PROVIDER_KEY: 'test-key',
  });
  let release;
  try {
    await waitForOutput(child, /listening/);
    const hung = fetch(`http://127.0.0.1:${port}/refresh`, {
      method: 'POST',
      headers: { Authorization: 'Bearer operator-secret', 'Content-Type': 'application/json' },
      body: '{}',
    });
    await fake.whenLlmCall(1);
    child.kill('SIGTERM');
    assert.equal(await exitWithin(child, 4000), 0);
    const hungResponse = await hung;
    assert.equal(hungResponse.status, 503);
    assert.deepEqual(await hungResponse.json(), { error: 'shutting down' });
    const abandoned = shutdownOutcome(child.output);
    assert.equal(abandoned.deadlineMs, 0);
    assert.equal(abandoned.forced, true);
    assert.equal(abandoned.refreshes.aborted, 1);
    assert.equal(abandoned.refreshes.drained, 0);
    assert.match(child.output, /"stage":"aborted"/);
    assert.match(child.output, /"reason":"shutdown"/);
    assert.equal(JSON.parse(await readFile(statePath, 'utf8')).tidbits.length, 0);
  } finally {
    child.kill('SIGKILL');
    await stopped(child);
    await new Promise((resolve) => fake.server.close(resolve));
  }

  const commitFake = listenFakeStation();
  await new Promise((resolve) => commitFake.server.listen(0, '127.0.0.1', resolve));
  const commitApi = `http://127.0.0.1:${commitFake.server.address().port}`;
  const commitWorkspace = await emptyWorkspace();
  const commitPort = await freePort();
  const commitChild = spawnServe(commitWorkspace.root, commitWorkspace.statePath, commitPort, {
    GOSSIP_SHUTDOWN_DEADLINE_MS: '0',
    SUBWAVE_API_URL: commitApi,
    OPENAI_BASE_URL: `${commitApi}/v1`,
    PROVIDER_KEY: 'test-key',
  });
  try {
    await waitForOutput(commitChild, /listening/);
    const pending = fetch(`http://127.0.0.1:${commitPort}/refresh`, {
      method: 'POST',
      headers: { Authorization: 'Bearer operator-secret', 'Content-Type': 'application/json' },
      body: '{}',
    });
    await commitFake.whenLlmCall(4);
    release = await acquireMutationLock(commitWorkspace.statePath);
    commitFake.releaseSeed();
    await waitForOutput(commitChild, /tidbit accepted/, 8000);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(commitChild.exitCode, null);
    commitChild.kill('SIGTERM');
    commitChild.kill('SIGINT');
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(commitChild.exitCode, null);
    release();
    release = null;
    const response = await pending;
    assert.equal(response.status, 200);
    assert.equal(await exitWithin(commitChild, 4000), 0);
    const disk = JSON.parse(await readFile(commitWorkspace.statePath, 'utf8'));
    assert.equal(disk.tidbits.length, 1);
    const outcome = shutdownOutcome(commitChild.output);
    assert.equal(outcome.forced, false);
    assert.deepEqual(outcome.refreshes, { drained: 1, aborted: 0 });
    assert.match(commitChild.output, /"stage":"complete"/);
    assert.doesNotMatch(commitChild.output, /"stage":"aborted"/);
  } finally {
    if (release) release();
    commitChild.kill('SIGKILL');
    await stopped(commitChild);
    await new Promise((resolve) => commitFake.server.close(resolve));
  }
});

test('an in-flight follow-up watch stops on shutdown and logs outcome shutdown', async () => {
  const fake = listenFakeStation();
  await new Promise((resolve) => fake.server.listen(0, '127.0.0.1', resolve));
  const api = `http://127.0.0.1:${fake.server.address().port}`;
  const { root, statePath } = await emptyWorkspace();
  const aired = 'Alpha said on air, "word is the booth kettle whistled through the legal ID"';
  await writeFile(statePath, `${JSON.stringify({
    tidbits: [{
      id: 't1',
      threadId: 't1',
      text: aired,
      createdAt: new Date().toISOString(),
      tellerPersonaId: 'p_a',
      hearerPersonaIds: null,
      toldAt: [],
    }],
    generatedGossipHistory: [],
    gossipComments: [],
    boardRevision: 1,
  })}\n`);
  const port = await freePort();
  const child = spawnServe(root, statePath, port, {
    GOSSIP_SHUTDOWN_DEADLINE_MS: '0',
    SUBWAVE_API_URL: api,
    OPENAI_BASE_URL: `${api}/v1`,
  });
  try {
    await waitForOutput(child, /listening/);
    const rss = await fetch(`http://127.0.0.1:${port}/gossip.rss?show=${encodeURIComponent('Island Time')}`);
    assert.equal(rss.status, 200);
    assert.match(await rss.text(), /booth kettle/);
    await waitForOutput(child, /watching station-gossip/, 8000);
    const started = Date.now();
    child.kill('SIGTERM');
    assert.equal(await exitWithin(child, 4000), 0);
    assert.ok(Date.now() - started < 4000);
    const outcome = shutdownOutcome(child.output);
    assert.equal(outcome.forced, true);
    assert.equal(outcome.watchers.aborted, 1);
    assert.equal(outcome.watchers.drained, 0);
    assert.match(child.output, /\[gossip\] tts watcher \{.*"outcome":"shutdown"/);
  } finally {
    child.kill('SIGKILL');
    await stopped(child);
    await new Promise((resolve) => fake.server.close(resolve));
  }
});
