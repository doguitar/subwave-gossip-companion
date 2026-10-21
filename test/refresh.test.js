import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import net from 'node:net';
import { createServer } from '../src/server.js';
import { parseRssItems } from '../src/rss.js';
import { acquireMutationLock } from '../src/workspaceLock.js';
import { PERSONA_A, PERSONA_B, PERSONA_C, stubAdapter, tempStore, tidbit } from './helpers.js';

const servers = [];

async function start(store, adapter, generate, pickRoles, configOverrides = {}) {
  const config = {
    host: '127.0.0.1',
    port: 0,
    feedBaseUrl: '',
    refreshCount: 1,
    timezone: 'UTC',
    gossipHistoryGenerations: 7,
    threadMaxTellings: 3,
    threadMaxAgeMs: 24 * 60 * 60 * 1000,
    refreshSecret: 'test-secret',
    refreshMaxConcurrency: 1,
    refreshMinIntervalMs: 0,
    refreshBodyMaxBytes: 16 * 1024,
    headersTimeoutMs: 10_000,
    requestTimeoutMs: 30_000,
    ...configOverrides,
  };
  const server = createServer({
    store,
    adapter,
    config,
    generate,
    pickRoles,
    summarizeSouls: async (roster) => roster,
    summarizeHouseRules: async (rules) => rules,
    log: { warn() {}, error() {}, info() {} },
    watcher: { afterSkillFetch() {} },
    now: () => new Date('2026-09-19T04:00:00.000Z'),
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}

after(() => {
  for (const s of servers) s.close();
});
test('refresh aliases reject unauthorized bodies before reload or generation', async () => {
  for (const path of ['/refresh', '/gossip/refresh']) {
    let reloads = 0;
    let generations = 0;
    const { store } = await tempStore();
    const originalReload = store.reload.bind(store);
    store.reload = async () => { reloads += 1; await originalReload(); };
    const base = await start(store, stubAdapter({ personas: [PERSONA_A] }), async () => {
      generations += 1;
      return { rumor: 'unused' };
    });
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{',
    });
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: 'unauthorized' });
    assert.equal(reloads, 0);
    assert.equal(generations, 0);
  }
});

test('refresh aliases bound declared and streamed JSON bodies before reload or generation', async () => {
  for (const path of ['/refresh', '/gossip/refresh']) {
    let reloads = 0;
    let generations = 0;
    const { store } = await tempStore();
    const originalReload = store.reload.bind(store);
    store.reload = async () => { reloads += 1; await originalReload(); };
    const base = await start(
      store,
      stubAdapter({ personas: [PERSONA_A, PERSONA_B, PERSONA_C] }),
      async () => {
        generations += 1;
        return { rumor: 'unconfirmed Gamma moved a kettle through the green room' };
      },
      () => ({ teller: PERSONA_A, hearers: [PERSONA_B], targets: [PERSONA_C] }),
      { refreshBodyMaxBytes: 32 },
    );
    const headers = {
      Authorization: 'Bearer test-secret',
      'Content-Type': 'application/json',
    };
    const exactLimitBody = `{"padding":"${'x'.repeat(18)}"}`;
    assert.equal(Buffer.byteLength(exactLimitBody), 32);
    const exactLimit = await fetch(`${base}${path}`, {
      method: 'POST',
      headers,
      body: exactLimitBody,
    });
    assert.equal(exactLimit.status, 200);
    const admittedReloads = reloads;
    const admittedGenerations = generations;
    const oversized = `{"padding":"${'x'.repeat(19)}"}`;
    const declared = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { ...headers, 'Content-Length': String(Buffer.byteLength(oversized)) },
      body: oversized,
    });
    assert.equal(declared.status, 413);
    assert.equal(reloads, admittedReloads);
    assert.equal(generations, admittedGenerations);
    const chunked = await fetch(`${base}${path}`, {
      method: 'POST',
      headers,
      duplex: 'half',
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(oversized.slice(0, 16)));
          controller.enqueue(new TextEncoder().encode(oversized.slice(16)));
          controller.close();
        },
      }),
    });
    assert.equal(chunked.status, 413);
    assert.equal(reloads, admittedReloads);
    assert.equal(generations, admittedGenerations);
  }
});

test('refresh request deadline ends slow alias bodies before reload or generation', async () => {
  for (const path of ['/refresh', '/gossip/refresh']) {
    let reloads = 0;
    let generations = 0;
    const { store } = await tempStore();
    const originalReload = store.reload.bind(store);
    store.reload = async () => { reloads += 1; await originalReload(); };
    await start(
      store,
      stubAdapter({ personas: [PERSONA_A] }),
      async () => {
        generations += 1;
        return { rumor: 'unused' };
      },
      undefined,
      { requestTimeoutMs: 1_000 },
    );
    const server = servers.at(-1);
    const response = await new Promise((resolve, reject) => {
      const socket = net.connect(server.address().port, '127.0.0.1');
      let received = '';
      socket.setEncoding('utf8');
      socket.setTimeout(3_000, () => {
        socket.destroy();
        reject(new Error('server did not time out slow refresh body'));
      });
      socket.on('connect', () => {
        socket.write(
          `POST ${path} HTTP/1.1\r\n`
          + 'Host: 127.0.0.1\r\n'
          + 'Authorization: Bearer test-secret\r\n'
          + 'Content-Type: application/json\r\n'
          + 'Content-Length: 2\r\n\r\n{',
        );
      });
      socket.on('data', (chunk) => { received += chunk; });
      socket.on('end', () => resolve(received));
      socket.on('error', reject);
    });
    assert.match(response, /^HTTP\/1\.1 408 /);
    assert.equal(reloads, 0);
    assert.equal(generations, 0);
  }
});

test('refresh admission rejects overlapping authenticated work', async () => {
  const { store } = await tempStore();
  let release;
  const generationStarted = new Promise((resolve) => {
    release = resolve;
  });
  let entered;
  const enteredGeneration = new Promise((resolve) => {
    entered = resolve;
  });
  const base = await start(store, stubAdapter({ personas: [PERSONA_A] }), async () => {
    entered();
    await generationStarted;
    return { rumor: 'unconfirmed the booth kettle whistled through the legal ID' };
  });
  const headers = { Authorization: 'Bearer test-secret', 'Content-Type': 'application/json' };
  const first = fetch(`${base}/refresh`, { method: 'POST', headers, body: '{}' });
  await enteredGeneration;
  const second = await fetch(`${base}/gossip/refresh`, { method: 'POST', headers, body: '{}' });
  assert.equal(second.status, 429);
  release();
  assert.equal((await first).status, 200);
});

test('POST /gossip/refresh clears the board and writes one told-shape rumor', async () => {
  const { store, read } = await tempStore({
    tidbits: [tidbit({ text: 'stale item', hearerPersonaIds: [PERSONA_B.id] })],
  });
  const roles = { teller: PERSONA_B, hearers: [PERSONA_A], targets: [PERSONA_C] };
  const base = await start(
    store,
    stubAdapter({ personas: [PERSONA_A, PERSONA_B, PERSONA_C] }),
    async ({ roles: r }) => {
      assert.equal(r.teller.id, PERSONA_B.id);
      return { rumor: 'unconfirmed Gamma coughed a cart that was only static' };
    },
    () => roles,
  );
  const res = await fetch(`${base}/gossip/refresh`, {
    method: 'POST',
    headers: { Authorization: 'Bearer test-secret', 'Content-Type': 'application/json' },
    body: JSON.stringify({ count: 1 }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.refreshed, 1);
  assert.equal(
    body.tidbits[0].text,
    'Beta told Alpha, "unconfirmed Gamma coughed a cart that was only static"',
  );
  const disk = await read();
  assert.equal(disk.tidbits.length, 1);
  assert.equal(disk.tidbits[0].text, body.tidbits[0].text);
});

test('POST /gossip/refresh forwards one requested count without roster expansion', async () => {
  const { store } = await tempStore();
  let calls = 0;
  const base = await start(
    store,
    stubAdapter({ personas: [PERSONA_A, PERSONA_B, PERSONA_C] }),
    async () => {
      calls += 1;
      return { rumor: 'unconfirmed the booth kettle whistled through the legal ID' };
    },
    () => ({ teller: PERSONA_A, hearers: [PERSONA_B], targets: [] }),
  );
  const res = await fetch(`${base}/gossip/refresh?count=1`, {
    method: 'POST',
    headers: { Authorization: 'Bearer test-secret', 'Content-Type': 'application/json' },
    body: JSON.stringify({ count: 2 }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(calls, 1);
  assert.equal(body.refreshed, 1);
  assert.equal(body.tidbits.length, 1);
});

test('POST /gossip/refresh rejects an explicit invalid count', async () => {
  const { store } = await tempStore();
  const base = await start(store, stubAdapter({ personas: [PERSONA_A] }), async () => ({ rumor: 'unused' }));
  const res = await fetch(`${base}/gossip/refresh`, {
    method: 'POST',
    headers: { Authorization: 'Bearer test-secret', 'Content-Type': 'application/json' },
    body: JSON.stringify({ count: 11 }),
  });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'refresh count must be an integer 1-10' });
});

test('POST /gossip/refresh returns 502 and leaves prior board and history on disk', async () => {
  const staleText = 'stale item must survive refresh failure';
  const priorHistory = [['Beta told Alpha, "prior generated gossip line"']];
  const { store, read } = await tempStore({
    tidbits: [tidbit({ text: staleText, hearerPersonaIds: null })],
    generatedGossipHistory: priorHistory,
  });
  const onAirRoles = { teller: PERSONA_A, hearers: [], targets: [] };
  const base = await start(
    store,
    stubAdapter({ personas: [PERSONA_A, PERSONA_B, PERSONA_C] }),
    async () => ({ rumor: 'short' }),
    () => onAirRoles,
  );
  const res = await fetch(`${base}/gossip/refresh`, {
    method: 'POST',
    headers: { Authorization: 'Bearer test-secret', 'Content-Type': 'application/json' },
    body: JSON.stringify({ count: 1 }),
  });
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.match(body.error, /no complete station-wide hallway chain/);
  assert.ok(Array.isArray(body.rejected));
  const disk = await read();
  assert.equal(disk.tidbits.length, 1);
  assert.equal(disk.tidbits[0].text, staleText);
  assert.deepEqual(disk.generatedGossipHistory, priorHistory);
});

test('refresh penalizes recently used target pairs and distinctive props with deterministic role picks', async () => {
  const { store } = await tempStore({
    tidbits: [tidbit({
      id: 'old',
      canonicalTargetPersonaIds: [PERSONA_C.id],
      canonicalAnchors: { location: 'green room', ownerPersonaId: PERSONA_C.id, props: ['violet microphone'] },
    })],
  });
  const repeated = { teller: PERSONA_A, hearers: [], targets: [PERSONA_C] };
  const fresh = { teller: PERSONA_A, hearers: [], targets: [PERSONA_B] };
  let picks = 0;
  const base = await start(
    store,
    stubAdapter({ personas: [PERSONA_A, PERSONA_B, PERSONA_C] }),
    async ({ roles }) => ({
      rumor: roles.targets[0].id === PERSONA_B.id
        ? 'unconfirmed Beta moved a new cart into the green room'
        : 'unconfirmed Gamma moved a violet microphone into the green room',
      anchors: { props: roles.targets[0].id === PERSONA_B.id ? ['new cart'] : ['violet microphone'] },
    }),
    () => {
      picks += 1;
      return picks < 3 ? repeated : fresh;
    },
  );
  const res = await fetch(`${base}/gossip/refresh`, {
    method: 'POST',
    headers: { Authorization: 'Bearer test-secret', 'Content-Type': 'application/json' },
    body: JSON.stringify({ count: 1 }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.tidbits[0].canonicalTargetPersonaIds, [PERSONA_B.id]);
  assert.deepEqual(body.tidbits[0].canonicalAnchors.props, ['new cart']);
});

test('RSS leaves a saturated thread out of the first item without changing its wire shape', async () => {
  const { store } = await tempStore({
    tidbits: [
      tidbit({ id: 'saturated', threadId: 'saturated', text: 'Saturated rumor', hearerPersonaIds: null, toldAt: ['2026-09-19T01:00:00.000Z', '2026-09-19T02:00:00.000Z', '2026-09-19T03:00:00.000Z'] }),
      tidbit({ id: 'fresh', threadId: 'fresh', text: 'Fresh rumor', hearerPersonaIds: null }),
    ],
  });
  const base = await start(store, stubAdapter({ personas: [PERSONA_A] }), async () => ({ rumor: 'unused' }), () => null);
  const res = await fetch(`${base}/gossip.rss?show=Test%20Show`);
  assert.equal(res.status, 200);
  const items = parseRssItems(await res.text());
  assert.deepEqual(items, [{ id: 'fresh', text: 'Fresh rumor' }]);
});

test('refresh routes return the store JSON error when the state file is corrupt', async () => {
  for (const route of ['/refresh', '/gossip/refresh']) {
    const { store, filePath } = await tempStore({
      tidbits: [tidbit({ text: 'kept on disk' })],
    });
    const corrupt = '{"tidbits":';
    await writeFile(filePath, corrupt);
    let generations = 0;
    const base = await start(
      store,
      stubAdapter({ personas: [PERSONA_A, PERSONA_B, PERSONA_C] }),
      async () => {
        generations += 1;
        return { rumor: 'unconfirmed the booth kettle whistled through the legal ID' };
      },
    );
    const res = await fetch(`${base}${route}`, {
      method: 'POST',
      headers: { Authorization: 'Bearer test-secret', 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.ok(res.status >= 400);
    const body = await res.json();
    assert.equal(body.error, `${filePath} is not valid JSON`);
    assert.equal(body.tidbits, undefined);
    assert.equal(body.refreshed, undefined);
    assert.equal(generations, 0);
    assert.equal(await readFile(filePath, 'utf8'), corrupt);
  }
});

test('HTTP refresh returns an error and does not persist when the state lock is held', async () => {
  const { store, filePath, read } = await tempStore({
    tidbits: [tidbit({ id: 'kept', text: 'kept rumor', hearerPersonaIds: null })],
  });
  const before = await readFile(filePath, 'utf8');
  const release = await acquireMutationLock(filePath);
  try {
    let generations = 0;
    const base = await start(
      store,
      stubAdapter({ personas: [PERSONA_A, PERSONA_B, PERSONA_C] }),
      async () => {
        generations += 1;
        return { rumor: 'unconfirmed the booth kettle whistled through the legal ID' };
      },
      () => ({ teller: PERSONA_A, hearers: [], targets: [] }),
    );
    const res = await fetch(`${base}/gossip/refresh`, {
      method: 'POST',
      headers: { Authorization: 'Bearer test-secret', 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.ok(res.status >= 400);
    const body = await res.json();
    assert.match(body.error, /could not be locked for an exclusive update/);
    assert.equal(body.error.includes(filePath), true);
    assert.equal(body.tidbits, undefined);
    assert.equal(generations, 0);
    assert.equal(await readFile(filePath, 'utf8'), before);
    assert.equal((await read()).tidbits[0].id, 'kept');
  } finally {
    release();
  }
});

function captureLines() {
  const lines = [];
  return {
    lines,
    info(message) { lines.push(String(message)); },
    warn(message) { lines.push(String(message)); },
    error(message) { lines.push(String(message)); },
  };
}

function shutdownPayload(lines) {
  const line = lines.find((entry) => entry.startsWith('[gossip] shutdown '));
  assert.ok(line, lines.join('\n'));
  return JSON.parse(line.slice('[gossip] shutdown '.length));
}

const refreshRoles = () => ({ teller: PERSONA_A, hearers: [], targets: [] });
const refreshRumor = 'word is the booth kettle whistled through the legal ID';

async function openRefreshServer(store, { generate, log = captureLines(), watcher } = {}) {
  const server = createServer({
    store,
    adapter: stubAdapter({ personas: [PERSONA_A, PERSONA_B, PERSONA_C] }),
    config: {
      host: '127.0.0.1',
      port: 0,
      feedBaseUrl: '',
      refreshCount: 1,
      timezone: 'UTC',
      gossipHistoryGenerations: 7,
      threadMaxTellings: 3,
      threadMaxAgeMs: 24 * 60 * 60 * 1000,
      refreshSecret: 'test-secret',
      refreshMaxConcurrency: 2,
      refreshMinIntervalMs: 0,
      refreshBodyMaxBytes: 16 * 1024,
      headersTimeoutMs: 10_000,
      requestTimeoutMs: 30_000,
      shutdownDeadlineMs: 5000,
    },
    generate,
    pickRoles: refreshRoles,
    summarizeSouls: async (roster) => roster,
    summarizeHouseRules: async (rules) => rules,
    log,
    watcher,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return { server, base: `http://127.0.0.1:${server.address().port}`, log };
}

test('shutdown rejects an authorized refresh that is not yet admitted', async () => {
  let generations = 0;
  const { store } = await tempStore();
  const { server, base, log } = await openRefreshServer(store, {
    generate: async ({ signal }) => {
      generations += 1;
      await new Promise((resolve, reject) => {
        const finish = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        if (signal?.aborted) finish();
        else signal?.addEventListener('abort', finish, { once: true });
      });
      return { rumor: refreshRumor };
    },
  });
  const headers = { Authorization: 'Bearer test-secret', 'Content-Type': 'application/json' };
  let entered = () => {};
  const started = new Promise((resolve) => { entered = resolve; });
  const admitted = fetch(`${base}/refresh`, { method: 'POST', headers, body: '{}' });
  const original = generations;
  const waitForAdmit = (async () => {
    while (generations === original) await new Promise((resolve) => setTimeout(resolve, 10));
    entered();
  })();
  await waitForAdmit;
  const draining = server.shutdown({ signal: 'SIGTERM', deadlineMs: 1500 });
  const [lateRefresh, lateAlias, missing, wrong, getRefresh] = await Promise.all([
    fetch(`${base}/refresh`, { method: 'POST', headers, body: '{}' }),
    fetch(`${base}/gossip/refresh`, { method: 'POST', headers, body: '{}' }),
    fetch(`${base}/refresh`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }),
    fetch(`${base}/gossip/refresh`, {
      method: 'POST',
      headers: { Authorization: 'Bearer wrong', 'Content-Type': 'application/json' },
      body: '{}',
    }),
    fetch(`${base}/refresh`),
  ]);
  assert.equal(lateRefresh.status, 503);
  assert.deepEqual(await lateRefresh.json(), { error: 'shutting down' });
  assert.equal(lateAlias.status, 503);
  assert.deepEqual(await lateAlias.json(), { error: 'shutting down' });
  assert.equal(missing.status, 401);
  assert.equal(wrong.status, 401);
  assert.equal(getRefresh.status, 405);
  assert.equal(generations, 1);
  assert.equal((await admitted).status, 503);
  const outcome = await draining;
  assert.equal(outcome.refreshes.aborted, 1);
  assert.equal(outcome.refreshes.drained, 0);
  assert.equal(outcome.forced, true);
  assert.equal(store.snapshot().tidbits.length, 0);
  assert.equal(log.lines.filter((line) => line.includes('"stage":"aborted"') && line.includes('"reason":"shutdown"')).length, 1);
  assert.equal(log.lines.some((line) => line.includes('"stage":"complete"')), false);
});

test('an admitted refresh that finishes before the deadline counts as drained', async () => {
  let release = () => {};
  const gate = new Promise((resolve) => { release = resolve; });
  const { store, read } = await tempStore();
  let started = false;
  const { server, base, log } = await openRefreshServer(store, {
    generate: () => {
      started = true;
      return gate.then(() => ({ rumor: refreshRumor }));
    },
  });
  const headers = { Authorization: 'Bearer test-secret', 'Content-Type': 'application/json' };
  const admitted = fetch(`${base}/refresh`, { method: 'POST', headers, body: '{}' });
  while (!started) await new Promise((resolve) => setTimeout(resolve, 10));
  const draining = server.shutdown({ signal: 'SIGINT', deadlineMs: 2000 });
  const health = await fetch(`${base}/health`);
  assert.equal(health.status, 200);
  assert.equal(await health.text(), 'ok\n');
  const ready = await fetch(`${base}/ready`);
  assert.equal(ready.status, 200);
  assert.deepEqual(await ready.json(), { ready: true });
  release();
  const res = await admitted;
  assert.equal(res.status, 200);
  const outcome = await draining;
  assert.equal(outcome.signal, 'SIGINT');
  assert.equal(outcome.deadlineMs, 2000);
  assert.equal(outcome.forced, false);
  assert.deepEqual(outcome.refreshes, { drained: 1, aborted: 0 });
  assert.match((await read()).tidbits[0].text, /booth kettle/);
  assert.equal(log.lines.some((line) => line.startsWith('[gossip] received SIGINT; shutting down')), true);
});

test('a refresh inside GossipStore.mutate at the deadline finishes and counts as drained', async () => {
  const { store, read } = await tempStore();
  const original = store.mutate.bind(store);
  let entered = () => {};
  const started = new Promise((resolve) => { entered = resolve; });
  let release = () => {};
  const gate = new Promise((resolve) => { release = resolve; });
  store.mutate = (fn) => {
    entered();
    return gate.then(() => original(fn));
  };
  const { server, base, log } = await openRefreshServer(store, {
    generate: async () => ({ rumor: refreshRumor }),
  });
  const admitted = fetch(`http://127.0.0.1:${server.address().port}/gossip/refresh`, {
    method: 'POST',
    headers: { Authorization: 'Bearer test-secret', 'Content-Type': 'application/json' },
    body: '{}',
  });
  await started;
  const draining = server.shutdown({ signal: 'SIGTERM', deadlineMs: 0 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(log.lines.some((line) => line.startsWith('[gossip] shutdown ')), false);
  release();
  assert.equal((await admitted).status, 200);
  const outcome = await draining;
  assert.equal(outcome.deadlineMs, 0);
  assert.equal(outcome.forced, false);
  assert.deepEqual(outcome.refreshes, { drained: 1, aborted: 0 });
  assert.match((await read()).tidbits[0].text, /booth kettle/);
  assert.equal(log.lines.some((line) => line.includes('"stage":"complete"')), true);
  assert.equal(log.lines.some((line) => line.includes('"stage":"aborted"')), false);
});

test('a refresh abandoned before its lifecycle exists counts only as aborted', async () => {
  const { store } = await tempStore();
  const { server, log } = await openRefreshServer(store, {
    generate: async () => {
      throw new Error('generate should not run');
    },
  });
  const received = new Promise((resolve, reject) => {
    const socket = net.connect(server.address().port, '127.0.0.1');
    let text = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      text += chunk;
      if (text.includes('\r\n\r\n')) resolve(text);
    });
    socket.on('error', reject);
    socket.on('connect', () => {
      socket.write(
        'POST /refresh HTTP/1.1\r\n'
        + 'Host: 127.0.0.1\r\n'
        + 'Authorization: Bearer test-secret\r\n'
        + 'Content-Type: application/json\r\n'
        + 'Content-Length: 2\r\n\r\n',
      );
    });
  });
  while (!log.lines.some((line) => line.includes('POST /refresh'))) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const outcome = await server.shutdown({ signal: 'SIGTERM', deadlineMs: 0 });
  const response = await received;
  assert.match(response, /^HTTP\/1\.1 503 /);
  assert.match(response, /"error":"shutting down"/);
  assert.deepEqual(outcome.refreshes, { drained: 0, aborted: 1 });
  assert.equal(outcome.forced, true);
  assert.equal(log.lines.some((line) => line.includes('"stage":"aborted"')), false);
  assert.equal(store.snapshot().tidbits.length, 0);
});
