import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export function emptyState() {
  return { tidbits: [], generatedGossipHistory: [] };
}

function normalizeHistoryBatch(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.filter((text) => typeof text === 'string' && text.length > 0);
}

function normalizeGeneratedGossipHistory(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(normalizeHistoryBatch)
    .filter((batch) => batch.length > 0);
}

export function normalizeTidbit(raw) {
  if (!raw || typeof raw !== 'object') {
    return {
      text: '',
      createdAt: '',
      tellerPersonaId: '',
      hearerPersonaIds: [],
    };
  }
  return {
    text: typeof raw.text === 'string' ? raw.text : '',
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : '',
    tellerPersonaId: typeof raw.tellerPersonaId === 'string' ? raw.tellerPersonaId : '',
    hearerPersonaIds: raw.hearerPersonaIds === null
      ? null
      : Array.isArray(raw.hearerPersonaIds)
        ? raw.hearerPersonaIds.filter((id) => typeof id === 'string')
        : [],
  };
}

export function normalizeState(parsed) {
  const tidbits = Array.isArray(parsed?.tidbits) ? parsed.tidbits.map(normalizeTidbit) : [];
  const generatedGossipHistory = normalizeGeneratedGossipHistory(parsed?.generatedGossipHistory);
  return { tidbits, generatedGossipHistory };
}

function clone(value) {
  return structuredClone(value);
}

export class GossipStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.state = emptyState();
    this.queue = Promise.resolve();
  }

  #enqueue(fn) {
    const run = this.queue.then(fn, fn);
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  async #readFromDisk({ persistMissing = false } = {}) {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      this.state = normalizeState(JSON.parse(raw));
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        this.state = emptyState();
        if (persistMissing) await this.#persist(this.state);
      } else if (err instanceof SyntaxError) {
        console.warn(`[gossip] state file is not valid JSON; using empty store (${err.message})`);
        this.state = emptyState();
      } else {
        throw err;
      }
    }
    return this.snapshot();
  }

  load() {
    return this.#enqueue(() => this.#readFromDisk({ persistMissing: true }));
  }

  reload() {
    return this.#enqueue(() => this.#readFromDisk({ persistMissing: true }));
  }

  snapshot() {
    return clone(this.state);
  }

  mutate(fn) {
    return this.#enqueue(async () => {
      await this.#readFromDisk({ persistMissing: false });
      const next = clone(this.state);
      const result = await fn(next);
      this.state = normalizeState(next);
      await this.#persist(this.state);
      return result;
    });
  }

  async #persist(state) {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(tmp, `${JSON.stringify(normalizeState(state), null, 2)}\n`, 'utf8');
    await rename(tmp, this.filePath);
  }
}

export function currentTidbits(state) {
  return Array.isArray(state?.tidbits) ? state.tidbits : [];
}

export function generatedGossipHistory(state) {
  return normalizeGeneratedGossipHistory(state?.generatedGossipHistory);
}

export function appendGeneratedGossipHistory(state, generatedTexts, limit) {
  if (limit === 0) {
    state.generatedGossipHistory = [];
    return state.generatedGossipHistory;
  }
  const texts = normalizeHistoryBatch(generatedTexts);
  const history = generatedGossipHistory(state);
  if (texts.length) history.push(texts);
  state.generatedGossipHistory = Number.isInteger(limit) && limit > 0
    ? history.slice(-limit)
    : history;
  return state.generatedGossipHistory;
}

export function tidbitKey(t) {
  return `${t?.text || ''}\n${t?.createdAt || ''}`;
}

export function tidbitsKnownBy(state, personaIds) {
  const known = new Set(personaIds);
  return currentTidbits(state)
    .filter((t) => {
      if (t.hearerPersonaIds === null) return true;
      if (known.has(t.tellerPersonaId)) return true;
      return (t.hearerPersonaIds || []).some((id) => known.has(id));
    })
    .slice()
    .sort((a, b) => {
      if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
      if (a.text !== b.text) return a.text < b.text ? -1 : 1;
      return 0;
    });
}
