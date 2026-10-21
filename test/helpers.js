import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GossipStore, appendGeneratedGossipHistory, recordGossipComment, recordTidbitTelling } from '../src/store.js';

export const PERSONA_A = { id: 'p_a', name: 'Alpha' };
export const PERSONA_B = { id: 'p_b', name: 'Beta' };
export const PERSONA_C = { id: 'p_c', name: 'Gamma' };

export function stubAdapter({
  show = 'Test Show',
  personas = [PERSONA_A, PERSONA_B],
  events = [],
  failSchedule = false,
  session = { messages: [] },
} = {}) {
  return {
    async getSchedule() {
      if (failSchedule) throw new Error('schedule down');
      return {
        timezone: 'UTC',
        personas: [PERSONA_A, PERSONA_B, PERSONA_C],
        shows: [
          { name: show, personaId: PERSONA_A.id, guestPersonaIds: [PERSONA_B.id] },
          { name: 'Empty Show', personaId: null, guestPersonaIds: [] },
        ],
      };
    },
    async getRosterPersonas() {
      return personas.length ? personas : [PERSONA_A, PERSONA_B, PERSONA_C];
    },
    async getShowPersonas(title) {
      const wanted = String(title || '').trim();
      if (failSchedule) {
        const err = new Error('schedule down');
        err.status = 503;
        throw err;
      }
      if (wanted === 'Empty Show') return [];
      if (wanted !== show) return [];
      return personas;
    },
    async getSpokenEvents() {
      return { events, cursor: events.at(-1)?.sourceEventId || null };
    },
    async getSession() {
      return session;
    },
    async getDebug() {
      return { tts: { recentCalls: [] } };
    },
  };
}

export async function tempStore(state) {
  const dir = await mkdtemp(path.join(tmpdir(), 'gossip-'));
  const filePath = path.join(dir, 'state.json');
  const store = new GossipStore(filePath);
  await store.load();
  if (state) {
    await store.mutate((s) => {
      s.tidbits = state.tidbits || [];
      if (state.generatedGossipHistory !== undefined) {
        s.generatedGossipHistory = state.generatedGossipHistory;
      }
      if (state.gossipComments !== undefined) {
        s.gossipComments = state.gossipComments;
      }
      if (state.spokenEventCursor !== undefined) s.spokenEventCursor = state.spokenEventCursor;
    });
  }
  return { store, filePath, read: () => readFile(filePath, 'utf8').then(JSON.parse) };
}

export function tidbit(partial) {
  return {
    text: 'A only secret',
    createdAt: '2026-09-19T00:00:00.000Z',
    tellerPersonaId: PERSONA_A.id,
    hearerPersonaIds: [],
    ...partial,
  };
}

const quietLog = { info() {}, warn() {} };

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function barrier(dir, name, peers) {
  if (!dir || !name) return;
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, name), 'ready');
  const wanted = String(peers || '').split(',').map((peer) => peer.trim()).filter(Boolean);
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (wanted.every((peer) => existsSync(path.join(dir, peer)))) return;
    await delay(20);
  }
  throw new Error(`timed out waiting for ${wanted.join(',') || name}`);
}

async function waitForText(filePath, text) {
  if (!text) return;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      if ((await readFile(filePath, 'utf8')).includes(text)) return;
    } catch {
      // The first writer may not have created the file yet.
    }
    await delay(20);
  }
  throw new Error(`timed out waiting for ${text}`);
}

export function runGossipAction(action, env = {}, timeoutMs = 15000) {
  const helper = fileURLToPath(new URL('./helpers.js', import.meta.url));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [helper], {
      env: { ...process.env, GOSSIP_LOCK_ACTION: action, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`gossip action ${action} timed out\n${stdout}\n${stderr}`));
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('exit', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

async function runLockAction() {
  const action = process.env.GOSSIP_LOCK_ACTION;
  const statePath = process.env.STATE_PATH;
  const store = new GossipStore(statePath);
  if (action === 'load') {
    await store.load();
    return;
  }
  if (action === 'mutate-append') {
    await store.mutate(async (state) => {
      await delay(Number(process.env.DELAY_MS || 0));
      state.tidbits.push(tidbit({
        id: process.env.TIDBIT_ID,
        text: process.env.TIDBIT_TEXT,
        createdAt: process.env.CREATED_AT || '2026-09-19T00:00:00.000Z',
        hearerPersonaIds: process.env.HEARERS === 'null' ? null : [],
      }));
      if (process.env.COMMENT_ID) {
        recordGossipComment(state, {
          id: process.env.COMMENT_ID,
          tidbitId: process.env.COMMENT_TIDBIT || process.env.TIDBIT_ID,
          actorPersonaId: process.env.ACTOR || PERSONA_A.id,
          show: process.env.SHOW || 'Test Show',
          commentedAt: process.env.TOLD_AT || '2026-09-19T01:00:00.000Z',
        });
      }
      if (process.env.TOLD_AT) recordTidbitTelling(state, process.env.TIDBIT_ID, process.env.TOLD_AT);
      if (process.env.HISTORY_LINE) appendGeneratedGossipHistory(state, [process.env.HISTORY_LINE], 7);
      if (process.env.PUBLIC_TIDBIT) {
        const existing = state.tidbits.find((item) => item.id === process.env.PUBLIC_TIDBIT);
        if (existing) existing.hearerPersonaIds = null;
      }
    });
    return;
  }
  if (action === 'seed' || action === 'refresh') {
    const { refreshGossip, seedGossip } = await import('../src/seed.js');
    const hallway = { teller: PERSONA_A, hearers: [PERSONA_B], targets: [PERSONA_C] };
    const onAir = { teller: PERSONA_A, hearers: [], targets: [] };
    const run = action === 'seed' ? seedGossip : refreshGossip;
    await run({
      store,
      adapter: stubAdapter({ personas: [PERSONA_A, PERSONA_B, PERSONA_C] }),
      pickRoles: () => (action === 'seed' ? hallway : onAir),
      cap: 1,
      historyGenerations: 7,
      timezone: 'UTC',
      generate: async () => {
        await barrier(process.env.BARRIER_DIR, process.env.BARRIER_NAME, process.env.BARRIER_PEERS);
        await waitForText(statePath, process.env.WAIT_FOR_TEXT || '');
        await delay(Number(process.env.DELAY_MS || 0));
        return { rumor: process.env.RUMOR };
      },
      log: quietLog,
    });
    return;
  }
  if (action === 'ingest') {
    const { ingestSpoken } = await import('../src/ingest.js');
    const result = await ingestSpoken({
      store,
      adapter: {
        ...stubAdapter(),
        async getSpokenEvents() {
          await barrier(process.env.BARRIER_DIR, process.env.BARRIER_NAME, process.env.BARRIER_PEERS);
          return {
            events: [{
              spokenText: process.env.SPOKEN_TEXT,
              spokenAt: process.env.SPOKEN_AT,
              actorPersonaId: process.env.ACTOR,
              show: process.env.SHOW || 'Test Show',
            }],
          };
        },
      },
      log: quietLog,
    });
    if (!result.ingested) throw new Error(`ingested nothing: ${JSON.stringify(result)}`);
    return;
  }
  if (action === 'follow-up') {
    const { appendGeneratedGossip } = await import('../src/followup.js');
    await barrier(process.env.BARRIER_DIR, process.env.BARRIER_NAME, process.env.BARRIER_PEERS);
    const result = await appendGeneratedGossip({
      store,
      roster: [PERSONA_A, PERSONA_B, PERSONA_C],
      showPersonas: [PERSONA_A],
      spoken: {
        kind: 'station-gossip',
        text: process.env.SPOKEN_TEXT,
        t: process.env.AIRED_AT,
        meta: { airedAt: process.env.AIRED_AT, personaId: PERSONA_A.id, personaName: PERSONA_A.name },
      },
      session: { session: { show: 'Test Show' } },
      log: quietLog,
    });
    if (!result.added) throw new Error(`follow-up added nothing: ${JSON.stringify(result)}`);
    return;
  }
  throw new Error(`unknown gossip action ${action}`);
}

const helperPath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(helperPath)) {
  runLockAction().then(() => {
    process.exit(0);
  }).catch((err) => {
    console.error(err?.message || String(err));
    process.exit(1);
  });
}
