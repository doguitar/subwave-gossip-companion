import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { matchVoicedTidbit } from './spoken.js';

const COMMENT_LIMIT = 1000;

export function emptyState() {
  return { tidbits: [], generatedGossipHistory: [], gossipComments: [] };
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

export function tidbitKey(t) {
  return `${t?.text || ''}\n${t?.createdAt || ''}`;
}

export function legacyTidbitId(raw) {
  return createHash('sha1').update(tidbitKey(raw)).digest('hex');
}

export function normalizeTidbit(raw) {
  const base = !raw || typeof raw !== 'object'
    ? { text: '', createdAt: '', tellerPersonaId: '', hearerPersonaIds: [] }
    : {
      text: typeof raw.text === 'string' ? raw.text : '',
      createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : '',
      tellerPersonaId: typeof raw.tellerPersonaId === 'string' ? raw.tellerPersonaId : '',
      hearerPersonaIds: raw.hearerPersonaIds === null
        ? null
        : Array.isArray(raw.hearerPersonaIds)
          ? raw.hearerPersonaIds.filter((id) => typeof id === 'string')
          : [],
    };
  const supplied = typeof raw?.id === 'string' ? raw.id.trim() : '';
  return { ...base, id: supplied || legacyTidbitId(base) };
}

function normalizeComment(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  const tidbitId = typeof raw.tidbitId === 'string' ? raw.tidbitId.trim() : '';
  const actorPersonaId = typeof raw.actorPersonaId === 'string' ? raw.actorPersonaId.trim() : '';
  const commentedAt = typeof raw.commentedAt === 'string' ? raw.commentedAt.trim() : '';
  if (!id || !tidbitId || !actorPersonaId || !commentedAt) return null;
  const show = typeof raw.show === 'string' ? raw.show : '';
  return { id, tidbitId, actorPersonaId, show, commentedAt };
}

export function gossipComments(state) {
  const comments = (Array.isArray(state?.gossipComments) ? state.gossipComments : [])
    .map(normalizeComment)
    .filter(Boolean);
  comments.sort((a, b) => {
    if (a.commentedAt !== b.commentedAt) return a.commentedAt < b.commentedAt ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return comments;
}

export function recordGossipComment(state, record) {
  const comments = gossipComments(state);
  const next = normalizeComment({
    id: typeof record?.id === 'string' && record.id.trim() ? record.id.trim() : randomUUID(),
    tidbitId: record?.tidbitId,
    actorPersonaId: record?.actorPersonaId,
    show: record?.show || '',
    commentedAt: record?.commentedAt,
  });
  if (!next) return comments;
  const duplicate = comments.some((c) => c.tidbitId === next.tidbitId
    && c.actorPersonaId === next.actorPersonaId
    && c.commentedAt === next.commentedAt
    && c.show === next.show);
  if (!duplicate) comments.push(next);
  comments.sort((a, b) => {
    if (a.commentedAt !== b.commentedAt) return a.commentedAt < b.commentedAt ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  state.gossipComments = comments.slice(-COMMENT_LIMIT);
  return state.gossipComments;
}

export function normalizeState(parsed) {
  const tidbits = Array.isArray(parsed?.tidbits) ? parsed.tidbits.map(normalizeTidbit) : [];
  const generatedGossipHistory = normalizeGeneratedGossipHistory(parsed?.generatedGossipHistory);
  const gossipCommentsList = gossipComments(parsed).slice(-COMMENT_LIMIT);
  return { tidbits, generatedGossipHistory, gossipComments: gossipCommentsList };
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

function knownTidbits(state, personaIds) {
  const known = new Set(personaIds);
  return currentTidbits(state).filter((t) => {
    if (t.hearerPersonaIds === null) return true;
    if (known.has(t.tellerPersonaId)) return true;
    return (t.hearerPersonaIds || []).some((id) => known.has(id));
  });
}

function compareShowKnown(a, b) {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  if (a.text !== b.text) return a.text < b.text ? -1 : 1;
  return 0;
}

function compareOldestFirst(a, b) {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  if (a.text !== b.text) return a.text < b.text ? -1 : 1;
  return 0;
}

function sameRumorSubject(a, b) {
  if (!a || !b || a.id === b.id) return Boolean(a && b && a.id === b.id);
  return Boolean(matchVoicedTidbit([a], b.text) || matchVoicedTidbit([b], a.text));
}

function rumorSubjectGroups(tidbits) {
  const groups = [];
  for (const tidbit of tidbits) {
    let group = groups.find((g) => g.some((t) => sameRumorSubject(t, tidbit)));
    if (!group) {
      group = [];
      groups.push(group);
    }
    group.push(tidbit);
  }
  return groups.map((group) => {
    const root = group.slice().sort(compareOldestFirst)[0];
    return { representative: root, root, members: group };
  });
}

export function tidbitsKnownBy(state, personaIds) {
  return knownTidbits(state, personaIds).slice().sort(compareShowKnown);
}

function newestComment(comments, tidbit, show) {
  const showKey = typeof show === 'string' ? show.trim() : '';
  const matches = comments.filter((c) => c.tidbitId === tidbit.id && (!showKey || !c.show || c.show === showKey));
  if (!matches.length) return null;
  return matches.reduce((best, c) => (c.commentedAt > best.commentedAt ? c : best));
}

function gossipRepresentatives(tidbits, actor, show, comments) {
  const groups = rumorSubjectGroups(tidbits);
  const selected = groups.filter(({ representative }) => {
    const latest = newestComment(comments, representative, show);
    return !(latest && latest.actorPersonaId === actor);
  });
  const never = [];
  const prior = [];
  for (const group of selected) {
    const latest = newestComment(comments, group.representative, show);
    if (!latest) never.push(group);
    else prior.push({ group, commentedAt: latest.commentedAt });
  }
  never.sort((a, b) => compareShowKnown(a.representative, b.representative));
  prior.sort((a, b) => {
    if (a.commentedAt !== b.commentedAt) return a.commentedAt < b.commentedAt ? -1 : 1;
    return compareShowKnown(a.group.representative, b.group.representative);
  });
  return [...never, ...prior].map((row) => row.group || row).map((group) => group.representative);
}

export function gossipForActor(state, personaIds, actorPersonaId, show) {
  const known = knownTidbits(state, personaIds);
  const actor = typeof actorPersonaId === 'string' ? actorPersonaId.trim() : '';
  const comments = gossipComments(state);
  if (!actor) {
    const groups = rumorSubjectGroups(known);
    return groups
      .slice()
      .sort((a, b) => compareOldestFirst(a.root, b.root))
      .map((group) => group.representative);
  }
  return gossipRepresentatives(known, actor, show, comments);
}
