import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { matchVoicedTidbit } from './spoken.js';
import { acquireMutationLock } from './workspaceLock.js';

const COMMENT_LIMIT = 1000;

export function emptyState() {
  return { tidbits: [], generatedGossipHistory: [], gossipComments: [], boardRevision: 0, spokenEventCursor: '' };
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

function stringList(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim()) : [];
}

function normalizeAnchors(raw) {
  if (!raw || typeof raw !== 'object') return { location: '', ownerPersonaId: '', props: [] };
  return {
    location: typeof raw.location === 'string' ? raw.location.trim() : '',
    ownerPersonaId: typeof raw.ownerPersonaId === 'string' ? raw.ownerPersonaId.trim() : '',
    props: stringList(raw.props),
  };
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
  const id = supplied || legacyTidbitId(base);
  const threadId = typeof raw?.threadId === 'string' && raw.threadId.trim() ? raw.threadId.trim() : id;
  const canonicalTargetPersonaIds = stringList(raw?.canonicalTargetPersonaIds);
  const canonicalSubjectPersonaId = typeof raw?.canonicalSubjectPersonaId === 'string' && raw.canonicalSubjectPersonaId.trim()
    ? raw.canonicalSubjectPersonaId.trim()
    : canonicalTargetPersonaIds[0] || '';
  const toldAt = [...new Set(stringList(raw?.toldAt).filter((value) => !Number.isNaN(new Date(value).getTime())))];
  return {
    ...base,
    id,
    threadId,
    canonicalSubjectPersonaId,
    canonicalTargetPersonaIds,
    canonicalAnchors: normalizeAnchors(raw?.canonicalAnchors),
    toldAt,
  };
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

export function pruneGossipCommentsToTidbits(tidbits, rawComments) {
  const boardIds = new Set(
    (Array.isArray(tidbits) ? tidbits : []).map((t) => normalizeTidbit(t).id),
  );
  const comments = gossipComments({ gossipComments: rawComments });
  return comments.filter((c) => boardIds.has(c.tidbitId)).slice(-COMMENT_LIMIT);
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

export function recordTidbitTelling(state, tidbitId, toldAt) {
  const when = typeof toldAt === 'string' && !Number.isNaN(new Date(toldAt).getTime()) ? toldAt : '';
  if (!when) return [];
  const tidbit = currentTidbits(state).find((item) => item.id === tidbitId);
  if (!tidbit) return [];
  const threadId = tidbit.threadId || tidbit.id;
  const members = currentTidbits(state).filter((item) => (item.threadId || item.id) === threadId);
  // Each member stores the same thread list; concatenating copies counts one airing N times.
  const existing = [...new Set(members.flatMap((item) => item.toldAt || []))];
  if (existing.includes(when)) return existing;
  const toldAtList = [...existing, when].sort();
  for (const member of members) member.toldAt = toldAtList;
  return toldAtList;
}

function normalizeBoardRevision(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

export function normalizeState(parsed) {
  const tidbits = Array.isArray(parsed?.tidbits) ? parsed.tidbits.map(normalizeTidbit) : [];
  const generatedGossipHistory = normalizeGeneratedGossipHistory(parsed?.generatedGossipHistory);
  const gossipCommentsList = gossipComments(parsed).slice(-COMMENT_LIMIT);
  return {
    tidbits,
    generatedGossipHistory,
    gossipComments: gossipCommentsList,
    boardRevision: normalizeBoardRevision(parsed?.boardRevision),
    spokenEventCursor: typeof parsed?.spokenEventCursor === 'string' ? parsed.spokenEventCursor : '',
  };
}

function clone(value) {
  return structuredClone(value);
}


export async function stateFileReadable(filePath) {
  try {
    const info = await stat(filePath);
    if (!info.isFile()) return { readable: false, reason: 'not-a-file' };
    await readFile(filePath);
    return { readable: true };
  } catch (err) {
    if (err && err.code === 'ENOENT') return { readable: true };
    return { readable: false, reason: err?.code === 'EACCES' ? 'access-denied' : 'unreadable' };
  }
}

export class GossipStore {
  #mtimeMs = null;
  stateReads = 0;

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

  async #withExclusiveDisk(fn) {
    const release = await acquireMutationLock(this.filePath);
    try {
      return await fn();
    } finally {
      await release();
    }
  }

  async #noteMtime() {
    try {
      const info = await stat(this.filePath);
      this.#mtimeMs = info.mtimeMs;
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
      this.#mtimeMs = null;
    }
  }

  async #readFromDisk({ persistMissing = false } = {}) {
    this.stateReads += 1;
    let raw;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        this.state = emptyState();
        if (persistMissing) await this.#persist(this.state);
        await this.#noteMtime();
        return this.snapshot();
      }
      throw err;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      if (err instanceof SyntaxError) {
        throw new Error(`${this.filePath} is not valid JSON`);
      }
      throw err;
    }
    this.state = normalizeState(parsed);
    await this.#noteMtime();
    return this.snapshot();
  }

  load() {
    return this.#enqueue(() => this.#withExclusiveDisk(() => this.#readFromDisk({ persistMissing: true })));
  }

  reload() {
    return this.#enqueue(() => this.#withExclusiveDisk(() => this.#readFromDisk({ persistMissing: true })));
  }

  reloadIfStale() {
    return this.#enqueue(() => this.#withExclusiveDisk(async () => {
      let mtimeMs = null;
      try {
        mtimeMs = (await stat(this.filePath)).mtimeMs;
      } catch (err) {
        if (err?.code !== 'ENOENT') throw err;
      }
      if (this.state && mtimeMs != null && mtimeMs === this.#mtimeMs) return this.snapshot();
      return this.#readFromDisk({ persistMissing: true });
    }));
  }

  snapshot() {
    return clone(this.state);
  }

  configuredPath() {
    return this.filePath;
  }

  mutate(fn) {
    return this.#enqueue(() => this.#withExclusiveDisk(async () => {
      await this.#readFromDisk({ persistMissing: false });
      const next = clone(this.state);
      const result = await fn(next);
      this.state = normalizeState(next);
      await this.#persist(this.state);
      await this.#noteMtime();
      return result;
    }));
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
  if (String(a.text || '').length < 40 || String(b.text || '').length < 40) return false;
  return Boolean(matchVoicedTidbit([a], b.text) || matchVoicedTidbit([b], a.text));
}

function rumorSubjectGroups(tidbits) {
  const groups = [];
  for (const tidbit of tidbits) {
    let group = groups.find((g) => g.some((t) => t.threadId === tidbit.threadId || sameRumorSubject(t, tidbit)));
    if (!group) {
      group = [];
      groups.push(group);
    }
    group.push(tidbit);
  }
  return groups.map((group) => {
    const ordered = group.slice().sort(compareOldestFirst);
    return { representative: ordered[ordered.length - 1], root: ordered[0], members: group };
  });
}

export function tidbitsKnownBy(state, personaIds) {
  return knownTidbits(state, personaIds).slice().sort(compareShowKnown);
}

function newestComment(comments, members, show) {
  const ids = new Set(members.map((tidbit) => tidbit.id));
  const showKey = typeof show === 'string' ? show.trim() : '';
  const matches = comments.filter((c) => ids.has(c.tidbitId) && (!showKey || !c.show || c.show === showKey));
  if (!matches.length) return null;
  return matches.reduce((best, c) => (c.commentedAt > best.commentedAt ? c : best));
}

function retirementState(tidbit, now, policy) {
  const toldAt = [...new Set(tidbit.toldAt || [])];
  const count = Number.isInteger(policy?.maxTellings) && policy.maxTellings > 0 ? policy.maxTellings : Infinity;
  const ageMs = Number.isFinite(policy?.maxAgeMs) && policy.maxAgeMs > 0 ? policy.maxAgeMs : Infinity;
  const created = new Date(tidbit.createdAt).getTime();
  return toldAt.length >= count || (Number.isFinite(created) && now.getTime() - created >= ageMs);
}

function gossipRepresentatives(tidbits, actor, show, comments, { now = new Date(), policy = {} } = {}) {
  const groups = rumorSubjectGroups(tidbits);
  const selected = groups.filter((group) => {
    if (retirementState(group.representative, now, policy)) return false;
    const latest = newestComment(comments, group.members, show);
    return !(latest && latest.actorPersonaId === actor);
  });
  const never = [];
  const prior = [];
  for (const group of selected) {
    const latest = newestComment(comments, group.members, show);
    if (!latest) never.push(group);
    else prior.push({ group, commentedAt: latest.commentedAt });
  }
  never.sort((a, b) => compareOldestFirst(a.root, b.root));
  prior.sort((a, b) => {
    if (a.commentedAt !== b.commentedAt) return a.commentedAt < b.commentedAt ? -1 : 1;
    return compareOldestFirst(a.group.root, b.group.root);
  });
  return [...never, ...prior].map((row) => row.group || row).map((group) => group.representative);
}

export function gossipForActor(state, personaIds, actorPersonaId, show, options = {}) {
  const known = knownTidbits(state, personaIds);
  const actor = typeof actorPersonaId === 'string' ? actorPersonaId.trim() : '';
  const comments = gossipComments(state);
  return gossipRepresentatives(known, actor, show, comments, options);
}
