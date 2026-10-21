import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { createServer } from '../src/server.js';
import { GossipStore } from '../src/store.js';
import { SubwaveAdapter } from '../src/subwave.js';
import { stubAdapter, tempStore, tidbit } from './helpers.js';

const servers = [];
const dirs = [];

function captureLog() {
  const lines = [];
  const push = (level, message) => lines.push({ level, message: String(message) });
  return {
    lines,
    info: (message) => push('info', message),
    warn: (message) => push('warn', message),
    error: (message) => push('error', message),
  };
}

async function listen(store, adapter, { log = captureLog(), requestTimeoutMs = 30_000 } = {}) {
  const server = createServer({
    store,
    adapter,
    config: { host: '127.0.0.1', port: 0, requestTimeoutMs, feedBaseUrl: '' },
    log,
    watcher: { afterSkillFetch() {} },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return { base: `http://127.0.0.1:${server.address().port}`, log };
}

async function absentStore() {
  const dir = await mkdtemp(path.join(tmpdir(), 'gossip-probe-'));
  dirs.push(dir);
  const filePath = path.join(dir, 'state.json');
  return { store: new GossipStore(filePath), filePath };
}

function scheduleAdapter({
  apiUrl = 'http://subwave.test',
  apiToken = 'token',
  fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ timezone: 'UTC' }) }),
} = {}) {
  return new SubwaveAdapter({ apiUrl, apiToken, fetchImpl, log: { warn() {}, info() {}, error() {} } });
}

after(async () => {
  for (const server of servers) server.close();
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

test('liveness stays ok with no dependency work while state is unreadable and Subwave is down', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gossip-probe-'));
  dirs.push(dir);
  const filePath = path.join(dir, 'state');
  await writeFile(filePath, 'not-a-file-stand-in', 'utf8');
  await rm(filePath);
  const store = new GossipStore(dir);
  store.state = { tidbits: [tidbit({ text: 'live board' })], generatedGossipHistory: [], gossipComments: [] };
  let calls = 0;
  const adapter = scheduleAdapter({
    fetchImpl: async () => {
      calls += 1;
      throw new Error('schedule down');
    },
  });
  const { base, log } = await listen(store, adapter);
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/plain/);
  assert.equal(await res.text(), 'ok\n');
  assert.equal(calls, 0);
  assert.deepEqual(store.snapshot().tidbits.map((item) => item.text), ['live board']);
  await assert.rejects(stat(path.join(dir, 'state.json')), (err) => err.code === 'ENOENT');
  assert.deepEqual(log.lines, []);
});

test('readiness is ready when the state file is absent and the schedule check succeeds', async () => {
  const { store, filePath } = await absentStore();
  const before = store.snapshot();
  const { base, log } = await listen(store, scheduleAdapter());
  const started = Date.now();
  const res = await fetch(`${base}/ready`);
  assert.ok(Date.now() - started < 2000);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^application\/json/);
  assert.deepEqual(await res.json(), { ready: true });
  await assert.rejects(stat(filePath), (err) => err.code === 'ENOENT');
  assert.deepEqual(store.snapshot(), before);
  assert.deepEqual(log.lines, []);
});

test('readiness reports only the state check when the configured path cannot be read', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gossip-probe-'));
  dirs.push(dir);
  const store = new GossipStore(dir);
  const before = store.snapshot();
  const { base, log } = await listen(store, scheduleAdapter());
  const res = await fetch(`${base}/ready`);
  assert.equal(res.status, 503);
  assert.match(res.headers.get('content-type'), /^application\/json/);
  assert.deepEqual(await res.json(), { ready: false, checks: { state: 'error', subwave: 'ok' } });
  assert.deepEqual(store.snapshot(), before);
  const warnings = log.lines.filter((line) => line.level === 'warn');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].message, /^\[gossip\] lifecycle \{.*\}$/);
  assert.equal((warnings[0].message.match(/\n/g) || []).length, 0);
  const payload = JSON.parse(warnings[0].message.slice('[gossip] lifecycle '.length));
  assert.deepEqual(payload, { version: 1, kind: 'probe', check: 'state', ready: false, reason: 'not-a-file' });
  assert.deepEqual(log.lines.filter((line) => line.level === 'info'), []);
});


test('readiness reports access denied without creating or rewriting the state file', async () => {
  if (process.platform === 'win32') return;
  const dir = await mkdtemp(path.join(tmpdir(), 'gossip-probe-'));
  dirs.push(dir);
  const filePath = path.join(dir, 'state.json');
  await writeFile(filePath, '{\n', 'utf8');
  await chmod(filePath, 0);
  const store = new GossipStore(filePath);
  store.state = { tidbits: [tidbit({ text: 'untouched board' })], generatedGossipHistory: [], gossipComments: [] };
  const { base, log } = await listen(store, scheduleAdapter());
  const res = await fetch(`${base}/ready`);
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { ready: false, checks: { state: 'error', subwave: 'ok' } });
  assert.equal((await stat(filePath)).size, 2);
  assert.deepEqual(store.snapshot().tidbits.map((item) => item.text), ['untouched board']);
  const warnings = log.lines.filter((line) => line.level === 'warn');
  assert.equal(warnings.length, 1);
  assert.equal(JSON.parse(warnings[0].message.slice('[gossip] lifecycle '.length)).reason, 'access-denied');
  await chmod(filePath, 0o600);
});

test('readiness reports a schedule failure without waiting out the request timeout', async () => {
  const { store } = await tempStore({ tidbits: [tidbit()] });
  const before = store.snapshot();
  const cases = [
    {
      name: 'missing credentials',
      adapter: scheduleAdapter({ apiToken: '' }),
      reason: 'missing-credentials',
    },
    {
      name: 'non-success response',
      adapter: scheduleAdapter({
        fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({ token: 'secret-body' }) }),
      }),
      reason: 'http-error',
    },
    {
      name: 'stalled schedule',
      adapter: scheduleAdapter({
        fetchImpl: (_url, opts) => new Promise((_resolve, reject) => {
          opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        }),
      }),
      reason: 'timeout',
    },
  ];
  for (const item of cases) {
    const { base, log } = await listen(store, item.adapter, { requestTimeoutMs: 30_000 });
    const started = Date.now();
    const res = await fetch(`${base}/ready`);
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 5000, `${item.name} waited ${elapsed}ms`);
    assert.equal(res.status, 503, item.name);
    assert.deepEqual(await res.json(), { ready: false, checks: { state: 'ok', subwave: 'error' } });
    assert.deepEqual(store.snapshot(), before);
    const warnings = log.lines.filter((line) => line.level === 'warn');
    assert.equal(warnings.length, 1, item.name);
    const payload = JSON.parse(warnings[0].message.slice('[gossip] lifecycle '.length));
    assert.equal(payload.check, 'subwave');
    assert.equal(payload.reason, item.reason);
    assert.doesNotMatch(warnings[0].message, /secret|token|Authorization|secret-body/i);
    assert.deepEqual(log.lines.filter((line) => line.level === 'info'), []);
  }
});

test('readiness reports both checks when the state path and the schedule call fail', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gossip-probe-'));
  dirs.push(dir);
  const store = new GossipStore(dir);
  const { base, log } = await listen(store, scheduleAdapter({ apiToken: '' }));
  const res = await fetch(`${base}/ready`);
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { ready: false, checks: { state: 'error', subwave: 'error' } });
  const warnings = log.lines.filter((line) => line.level === 'warn');
  assert.deepEqual(warnings.map((line) => JSON.parse(line.message.slice('[gossip] lifecycle '.length)).check), ['state', 'subwave']);
  assert.deepEqual(log.lines.filter((line) => line.level !== 'warn'), []);
});

test('liveness stays 200 during shutdown and readiness is unchanged', async () => {
  const { store } = await tempStore();
  let release = () => {};
  const gate = new Promise((resolve) => { release = resolve; });
  let started = false;
  const server = createServer({
    store,
    adapter: stubAdapter(),
    config: {
      host: '127.0.0.1',
      port: 0,
      feedBaseUrl: '',
      refreshSecret: 'test-secret',
      refreshMinIntervalMs: 0,
      refreshMaxConcurrency: 1,
      refreshCount: 1,
      gossipHistoryGenerations: 7,
    },
    log: captureLog(),
    generate: () => {
      started = true;
      return gate.then(() => ({ rumor: 'word is the booth kettle whistled through the legal ID' }));
    },
    pickRoles: () => ({ teller: { id: 'p_a', name: 'Alpha' }, hearers: [], targets: [] }),
    summarizeSouls: async (roster) => roster,
    summarizeHouseRules: async (rules) => rules,
    watcher: { afterSkillFetch() {} },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  const admitted = fetch(`${base}/refresh`, {
    method: 'POST',
    headers: { Authorization: 'Bearer test-secret', 'Content-Type': 'application/json' },
    body: '{}',
  });
  while (!started) await new Promise((resolve) => setTimeout(resolve, 10));
  const draining = server.shutdown({ signal: 'SIGTERM', deadlineMs: 1500 });
  const health = await fetch(`${base}/health`);
  assert.equal(health.status, 200);
  assert.equal(await health.text(), 'ok\n');
  const ready = await fetch(`${base}/ready`);
  assert.equal(ready.status, 200);
  assert.deepEqual(await ready.json(), { ready: true });
  release();
  await admitted.catch(() => {});
  await draining;
});

test('a non-probe route still writes its access line', async () => {
  const { store } = await tempStore();
  const { base, log } = await listen(store, stubAdapter());
  const res = await fetch(`${base}/missing`);
  assert.equal(res.status, 404);
  assert.equal(log.lines.filter((line) => line.level === 'info').length, 1);
  assert.match(log.lines[0].message, /GET \/missing/);
});
