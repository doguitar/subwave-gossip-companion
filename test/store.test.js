import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  appendGeneratedGossipHistory,
  currentTidbits,
  generatedGossipHistory,
  GossipStore,
  gossipComments,
  gossipForActor,
  legacyTidbitId,
  normalizeState,
  pruneGossipCommentsToTidbits,
  recordGossipComment,
  recordTidbitTelling,
  tidbitsKnownBy,
} from '../src/store.js';
import { acquireMutationLock, acquireServerOwnership } from '../src/workspaceLock.js';
import { PERSONA_A, PERSONA_B, runGossipAction, tempStore, tidbit } from './helpers.js';

const EMPTY_BOARD = { tidbits: [], generatedGossipHistory: [], gossipComments: [], boardRevision: 0, spokenEventCursor: '' };

async function storeWithBytes(contents) {
  const dir = await mkdtemp(path.join(tmpdir(), 'gossip-'));
  const filePath = path.join(dir, 'state.json');
  await writeFile(filePath, contents);
  return { store: new GossipStore(filePath), filePath };
}

test('store loads reduced shape and persists a queued mutation atomically', async () => {
  const { store, read } = await tempStore();
  const snap = store.snapshot();
  assert.deepEqual(Object.keys(snap), ['tidbits', 'generatedGossipHistory', 'gossipComments', 'boardRevision', 'spokenEventCursor']);
  assert.deepEqual(snap.generatedGossipHistory, []);
  assert.deepEqual(snap.gossipComments, []);
  await store.mutate((s) => {
    s.tidbits.push(tidbit());
  });
  const disk = await read();
  assert.deepEqual(Object.keys(disk), ['tidbits', 'generatedGossipHistory', 'gossipComments', 'boardRevision', 'spokenEventCursor']);
  assert.equal(disk.tidbits.length, 1);
  assert.equal(currentTidbits(disk).length, 1);
  assert.equal(disk.tidbits[0].tellerPersonaId, PERSONA_A.id);
  assert.equal(disk.tidbits[0].id, legacyTidbitId(disk.tidbits[0]));
  assert.ok(!('status' in disk.tidbits[0]));
});

test('legacy tidbits-only state normalizes to empty generatedGossipHistory', () => {
  const state = normalizeState({
    tidbits: [tidbit({ text: 'legacy item' })],
  });
  assert.deepEqual(state.generatedGossipHistory, []);
  assert.equal(state.tidbits.length, 1);
  assert.equal(state.tidbits[0].text, 'legacy item');
  assert.equal(state.tidbits[0].id, legacyTidbitId({ text: 'legacy item', createdAt: '2026-09-19T00:00:00.000Z' }));
  assert.deepEqual(state.gossipComments, []);
  assert.equal(state.boardRevision, 0);
  assert.equal(normalizeState({ ...state, boardRevision: 3 }).boardRevision, 3);
});

test('legacy tidbits receive stable thread metadata and persisted tellings retire deterministically', async () => {
  const { store, read } = await tempStore({
    tidbits: [tidbit({ id: 'legacy', createdAt: '2026-09-19T00:00:00.000Z' })],
  });
  await store.mutate((state) => {
    recordTidbitTelling(state, 'legacy', '2026-09-19T01:00:00.000Z');
    recordTidbitTelling(state, 'legacy', '2026-09-19T02:00:00.000Z');
  });
  const disk = await read();
  assert.equal(disk.tidbits[0].threadId, 'legacy');
  assert.deepEqual(disk.tidbits[0].canonicalAnchors, { location: '', ownerPersonaId: '', props: [] });
  assert.deepEqual(disk.tidbits[0].toldAt, ['2026-09-19T01:00:00.000Z', '2026-09-19T02:00:00.000Z']);
  assert.deepEqual(
    gossipForActor(disk, [PERSONA_A.id], '', 'Test', {
      now: new Date('2026-09-19T03:00:00.000Z'),
      policy: { maxTellings: 2 },
    }),
    [],
  );
});

test('thread tellings count distinct airings when every member stores the same list', () => {
  const state = normalizeState({
    tidbits: [
      tidbit({ id: 'root', threadId: 'thread', text: 'Root rumor', hearerPersonaIds: null, toldAt: ['2026-09-19T01:00:00.000Z'] }),
      tidbit({ id: 'follow', threadId: 'thread', text: 'Follow rumor', hearerPersonaIds: null, toldAt: ['2026-09-19T01:00:00.000Z'] }),
    ],
  });
  recordTidbitTelling(state, 'follow', '2026-09-19T02:00:00.000Z');
  assert.deepEqual(state.tidbits[0].toldAt, ['2026-09-19T01:00:00.000Z', '2026-09-19T02:00:00.000Z']);
  assert.equal(
    gossipForActor(state, [PERSONA_A.id], '', 'Neon Time Machine', {
      now: new Date('2026-09-19T03:00:00.000Z'),
      policy: { maxTellings: 3 },
    }).length,
    1,
  );
  const inflated = normalizeState({
    tidbits: [tidbit({
      id: 'aired',
      hearerPersonaIds: null,
      toldAt: ['2026-09-19T01:00:00.000Z', '2026-09-19T01:00:00.000Z', '2026-09-19T01:00:00.000Z'],
    })],
  });
  assert.deepEqual(inflated.tidbits[0].toldAt, ['2026-09-19T01:00:00.000Z']);
  assert.equal(gossipForActor(inflated, [PERSONA_A.id], '', 'Neon Time Machine', {
    now: new Date('2026-09-19T03:00:00.000Z'),
    policy: { maxTellings: 3 },
  }).length, 1);
});

test('thread policy retires age-expired representatives while preserving an eligible rotation', () => {
  const state = normalizeState({
    tidbits: [
      tidbit({ id: 'expired', threadId: 'expired', createdAt: '2026-09-19T00:00:00.000Z', hearerPersonaIds: null }),
      tidbit({ id: 'fresh', threadId: 'fresh', createdAt: '2026-09-19T02:00:00.000Z', hearerPersonaIds: null }),
    ],
  });
  assert.deepEqual(
    gossipForActor(state, [PERSONA_A.id], '', 'Test', {
      now: new Date('2026-09-19T03:00:00.000Z'),
      policy: { maxAgeMs: 2 * 60 * 60 * 1000 },
    }).map((item) => item.id),
    ['fresh'],
  );
});

test('appendGeneratedGossipHistory keeps only the newest batches across persist/reload', async () => {
  const { store, filePath, read } = await tempStore();
  await store.mutate((s) => {
    appendGeneratedGossipHistory(s, ['gen-1a', 'gen-1b'], 2);
    appendGeneratedGossipHistory(s, ['gen-2'], 2);
    appendGeneratedGossipHistory(s, ['gen-3'], 2);
  });
  const disk = await read();
  assert.deepEqual(disk.generatedGossipHistory, [['gen-2'], ['gen-3']]);

  await writeFile(filePath, JSON.stringify({ tidbits: disk.tidbits, generatedGossipHistory: disk.generatedGossipHistory }), 'utf8');
  await store.reload();
  assert.deepEqual(generatedGossipHistory(store.snapshot()), [['gen-2'], ['gen-3']]);
});

test('null hearers are visible to every persona; specific hearers are not', () => {
  const state = {
    tidbits: [
      tidbit({ text: 'On air', hearerPersonaIds: null, tellerPersonaId: PERSONA_A.id }),
      tidbit({ text: 'Private', hearerPersonaIds: [PERSONA_A.id], tellerPersonaId: PERSONA_A.id }),
    ],
  };
  const a = tidbitsKnownBy(state, [PERSONA_A.id]).map((t) => t.text);
  const b = tidbitsKnownBy(state, [PERSONA_B.id]).map((t) => t.text);
  assert.deepEqual(a.sort(), ['On air', 'Private']);
  assert.deepEqual(b, ['On air']);
});

test('pruneGossipCommentsToTidbits drops orphans and keeps valid comments in order', () => {
  const board = [
    tidbit({ id: 'on-board-a', text: 'A' }),
    tidbit({ id: 'on-board-b', text: 'B' }),
  ];
  const comments = [
    { id: 'c1', tidbitId: 'stale', actorPersonaId: 'p_a', commentedAt: '2026-09-01T00:00:00.000Z' },
    { id: 'c2', tidbitId: 'on-board-a', actorPersonaId: 'p_b', show: 'Night', commentedAt: '2026-09-02T00:00:00.000Z' },
    { id: 'c3', tidbitId: 'gone', actorPersonaId: 'p_a', commentedAt: '2026-09-03T00:00:00.000Z' },
    { id: 'c4', tidbitId: 'on-board-b', actorPersonaId: 'p_c', commentedAt: '2026-09-04T00:00:00.000Z' },
  ];
  assert.deepEqual(pruneGossipCommentsToTidbits(board, comments), [
    {
      id: 'c2',
      tidbitId: 'on-board-a',
      actorPersonaId: 'p_b',
      show: 'Night',
      commentedAt: '2026-09-02T00:00:00.000Z',
    },
    {
      id: 'c4',
      tidbitId: 'on-board-b',
      actorPersonaId: 'p_c',
      show: '',
      commentedAt: '2026-09-04T00:00:00.000Z',
    },
  ]);
  assert.deepEqual(pruneGossipCommentsToTidbits(board, []), []);
  assert.deepEqual(pruneGossipCommentsToTidbits(board, comments.slice(0, 3)), [
    {
      id: 'c2',
      tidbitId: 'on-board-a',
      actorPersonaId: 'p_b',
      show: 'Night',
      commentedAt: '2026-09-02T00:00:00.000Z',
    },
  ]);
});

test('pruneGossipCommentsToTidbits enforces the comment cap after filtering orphans', () => {
  const board = [tidbit({ id: 'live' })];
  const comments = [];
  for (let i = 0; i < 1005; i += 1) {
    comments.push({
      id: `c${String(i).padStart(4, '0')}`,
      tidbitId: i < 5 ? 'orphan' : 'live',
      actorPersonaId: 'p_a',
      commentedAt: `2026-01-01T00:00:${String(i).padStart(4, '0')}Z`,
    });
  }
  const kept = pruneGossipCommentsToTidbits(board, comments);
  assert.equal(kept.length, 1000);
  assert.equal(kept[0].id, 'c0005');
  assert.equal(kept.at(-1).id, 'c1004');
  assert.ok(kept.every((c) => c.tidbitId === 'live'));
});

test('comment records normalize and keep the newest 1000', () => {
  const state = normalizeState({
    tidbits: [tidbit({ id: 't1', text: 'rumor on board' })],
    gossipComments: [
      { tidbitId: 't1', actorPersonaId: 'p_a', commentedAt: '2026-09-01T00:00:00.000Z' },
      { id: 'keep', tidbitId: 't1', actorPersonaId: 'p_b', show: 'Night', commentedAt: '2026-09-02T00:00:00.000Z', extra: 'no' },
      { id: 'bad', actorPersonaId: 'p_a', commentedAt: '2026-09-03T00:00:00.000Z' },
    ],
  });
  assert.equal(gossipComments(state).length, 1);
  assert.deepEqual(gossipComments(state)[0], {
    id: 'keep',
    tidbitId: 't1',
    actorPersonaId: 'p_b',
    show: 'Night',
    commentedAt: '2026-09-02T00:00:00.000Z',
  });

  const many = normalizeState({ tidbits: [] });
  for (let i = 0; i < 1005; i += 1) {
    recordGossipComment(many, {
      id: `c${String(i).padStart(4, '0')}`,
      tidbitId: 't1',
      actorPersonaId: 'p_a',
      commentedAt: `2026-01-01T00:00:${String(i).padStart(4, '0')}Z`,
    });
  }
  const kept = gossipComments(many);
  assert.equal(kept.length, 1000);
  assert.equal(kept[0].id, 'c0005');
  assert.equal(kept.at(-1).id, 'c1004');
});

test('actor feed excludes the newest commentor and restores the rumor after someone else speaks', () => {
  const fresh = tidbit({ id: 'fresh', text: 'Fresh rumor', createdAt: '2026-09-19T03:00:00.000Z', hearerPersonaIds: null });
  const older = tidbit({ id: 'older', text: 'Older rumor', createdAt: '2026-09-19T01:00:00.000Z', hearerPersonaIds: null });
  const state = normalizeState({ tidbits: [older, fresh] });
  const ids = [PERSONA_A.id, PERSONA_B.id];

  assert.deepEqual(gossipForActor(state, ids, 'persona-a', 'Test Show').map((t) => t.id), ['older', 'fresh']);

  recordGossipComment(state, {
    tidbitId: 'older',
    actorPersonaId: 'persona-a',
    show: 'Test Show',
    commentedAt: '2026-09-19T04:00:00.000Z',
  });
  assert.deepEqual(gossipForActor(state, ids, 'persona-a', 'Test Show').map((t) => t.id), ['fresh']);

  recordGossipComment(state, {
    tidbitId: 'older',
    actorPersonaId: 'persona-b',
    show: 'Test Show',
    commentedAt: '2026-09-19T05:00:00.000Z',
  });
  assert.deepEqual(gossipForActor(state, ids, 'persona-a', 'Test Show').map((t) => t.id), ['fresh', 'older']);
});

test('actor feed rotates to another subject after escalating one rumor', () => {
  const rumorA = tidbit({
    id: 'rumor-a',
    text: 'Word is the cart machine threw itself through the booth wall behind Alpha.',
    createdAt: '2026-09-19T01:00:00.000Z',
    hearerPersonaIds: null,
  });
  const rumorB = tidbit({
    id: 'rumor-b',
    text: 'Someone swears the neon sign in the lobby blinked a secret code twice at midnight.',
    createdAt: '2026-09-19T02:00:00.000Z',
    hearerPersonaIds: null,
  });
  const rumorC = tidbit({
    id: 'rumor-c',
    text: 'Unconfirmed the overnight engineer left a rubber duck on the transmitter.',
    createdAt: '2026-09-19T03:00:00.000Z',
    hearerPersonaIds: null,
  });
  const state = normalizeState({ tidbits: [rumorA, rumorB, rumorC] });
  const ids = [PERSONA_A.id, PERSONA_B.id];
  const show = 'Test Show';

  assert.equal(gossipForActor(state, ids, 'persona-a', show).map((t) => t.id)[0], 'rumor-a');

  recordGossipComment(state, {
    tidbitId: 'rumor-a',
    actorPersonaId: 'persona-a',
    show,
    commentedAt: '2026-09-19T04:00:00.000Z',
  });
  const escalationA = tidbit({
    id: 'rumor-a-esc',
    text: 'Alpha said on air, "Word is the cart machine threw itself through the booth wall and took the transmitter with it."',
    createdAt: '2026-09-19T04:30:00.000Z',
    hearerPersonaIds: null,
    tellerPersonaId: 'persona-a',
  });
  state.tidbits.push(escalationA);
  recordGossipComment(state, {
    tidbitId: 'rumor-a-esc',
    actorPersonaId: 'persona-a',
    show,
    commentedAt: '2026-09-19T04:30:00.000Z',
  });

  const next = gossipForActor(state, ids, 'persona-a', show).map((t) => t.id);
  assert.equal(next[0], 'rumor-b');
  assert.ok(!next.includes('rumor-a'));
  assert.ok(!next.includes('rumor-a-esc'));
});

test('missing actor feed surfaces each subject once and does not pin escalations at the front', () => {
  const rumorA = tidbit({
    id: 'rumor-a',
    text: 'Word is the cart machine threw itself through the booth wall behind Alpha.',
    createdAt: '2026-09-19T01:00:00.000Z',
    hearerPersonaIds: null,
  });
  const rumorB = tidbit({
    id: 'rumor-b',
    text: 'Someone swears the neon sign in the lobby blinked a secret code twice at midnight.',
    createdAt: '2026-09-19T02:00:00.000Z',
    hearerPersonaIds: null,
  });
  const state = normalizeState({ tidbits: [rumorA, rumorB] });
  const ids = [PERSONA_A.id];

  const escalationA = tidbit({
    id: 'rumor-a-esc',
    text: 'Alpha said on air, "Word is the cart machine threw itself through the booth wall and took the transmitter with it."',
    createdAt: '2026-09-19T05:00:00.000Z',
    hearerPersonaIds: null,
  });
  state.tidbits.push(escalationA);

  const feed = gossipForActor(state, ids, '', 'Test Show').map((t) => t.id);
  assert.deepEqual(feed, ['rumor-a-esc', 'rumor-b']);
});

test('excluding the only known rumor yields an empty list; a missing actor keeps show order', () => {
  const only = tidbit({ id: 'only', text: 'Only rumor', hearerPersonaIds: null, createdAt: '2026-09-19T02:00:00.000Z' });
  const state = normalizeState({ tidbits: [only] });
  recordGossipComment(state, {
    tidbitId: 'only',
    actorPersonaId: 'persona-a',
    show: 'Test Show',
    commentedAt: '2026-09-19T06:00:00.000Z',
  });
  assert.deepEqual(gossipForActor(state, [PERSONA_A.id], 'persona-a', 'Test Show'), []);
  const noActor = gossipForActor(state, [PERSONA_A.id], '', 'Test Show').map((t) => t.text);
  assert.deepEqual(noActor, ['Only rumor']);
});

test('corrupt state bytes survive a failed load, reload, and mutate', async () => {
  const corruptDocuments = [
    ['truncated JSON', '{"tidbits":'],
    ['an empty file', ''],
    ['a trailing comma', '{"tidbits":[],}'],
  ];
  for (const [label, corrupt] of corruptDocuments) {
    const loaded = await storeWithBytes(corrupt);
    await assert.rejects(loaded.store.load(), (err) => {
      assert.equal(err.message, `${loaded.filePath} is not valid JSON`);
      return true;
    });
    assert.equal(await readFile(loaded.filePath, 'utf8'), corrupt, label);
    assert.deepEqual(loaded.store.snapshot(), EMPTY_BOARD);

    const reloaded = await tempStore({ tidbits: [tidbit({ id: 'kept', text: 'kept rumor' })] });
    const snapshot = reloaded.store.snapshot();
    await writeFile(reloaded.filePath, corrupt);
    await assert.rejects(reloaded.store.reload(), (err) => {
      assert.equal(err.message, `${reloaded.filePath} is not valid JSON`);
      return true;
    });
    assert.equal(await readFile(reloaded.filePath, 'utf8'), corrupt, label);
    assert.deepEqual(reloaded.store.snapshot(), snapshot);

    let mutated = false;
    await assert.rejects(reloaded.store.mutate(() => {
      mutated = true;
    }), (err) => {
      assert.equal(err.message, `${reloaded.filePath} is not valid JSON`);
      return true;
    });
    assert.equal(mutated, false);
    assert.equal(await readFile(reloaded.filePath, 'utf8'), corrupt, label);
    assert.deepEqual(reloaded.store.snapshot(), snapshot);
  }
});

test('a missing state file loads and reloads as a persisted empty board', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gossip-'));
  const filePath = path.join(dir, 'state.json');
  const loaded = await new GossipStore(filePath).load();
  assert.deepEqual(loaded, EMPTY_BOARD);
  assert.deepEqual(JSON.parse(await readFile(filePath, 'utf8')), EMPTY_BOARD);

  await rm(filePath);
  const reloaded = await new GossipStore(filePath).reload();
  assert.deepEqual(reloaded, EMPTY_BOARD);
  assert.deepEqual(JSON.parse(await readFile(filePath, 'utf8')), EMPTY_BOARD);
});

test('parseable empty and legacy documents still normalize on load', async () => {
  for (const raw of ['{}', 'null']) {
    const { store, filePath } = await storeWithBytes(raw);
    assert.deepEqual(await store.load(), EMPTY_BOARD);
    assert.equal(await readFile(filePath, 'utf8'), raw);
  }

  const legacy = JSON.stringify({ tidbits: [tidbit({ text: 'legacy item' })] });
  const { store, filePath } = await storeWithBytes(legacy);
  const snap = await store.load();
  assert.equal(snap.tidbits.length, 1);
  assert.equal(snap.tidbits[0].text, 'legacy item');
  assert.equal(
    snap.tidbits[0].id,
    legacyTidbitId({ text: 'legacy item', createdAt: '2026-09-19T00:00:00.000Z' }),
  );
  assert.deepEqual(snap.generatedGossipHistory, []);
  assert.deepEqual(snap.gossipComments, []);
  assert.equal(await readFile(filePath, 'utf8'), legacy);
});

test('one-process mutate re-reads the latest queued document', async () => {
  const { store, read } = await tempStore();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const first = store.mutate(async (state) => {
    state.tidbits.push(tidbit({ id: 'first', text: 'first queued rumor' }));
    await gate;
  });
  const second = store.mutate((state) => {
    assert.equal(state.tidbits.some((item) => item.id === 'first'), true);
    state.tidbits.push(tidbit({ id: 'second', text: 'second queued rumor' }));
  });
  release();
  await Promise.all([first, second]);
  const disk = await read();
  assert.deepEqual(disk.tidbits.map((item) => item.id), ['first', 'second']);
});

test('overlapping processes keep incremental tidbits, comments, and tellings', async () => {
  const { filePath, read } = await tempStore({
    tidbits: [tidbit({ id: 'existing', text: 'existing rumor', hearerPersonaIds: [PERSONA_B.id] })],
  });
  const common = { STATE_PATH: filePath, DELAY_MS: '200' };
  const [seeded, spoken, followed] = await Promise.all([
    runGossipAction('mutate-append', {
      ...common,
      TIDBIT_ID: 'seed-bit',
      TIDBIT_TEXT: 'seed append rumor',
      COMMENT_ID: 'seed-comment',
      TOLD_AT: '2026-09-19T02:00:00.000Z',
      HISTORY_LINE: 'seed history line',
    }),
    runGossipAction('mutate-append', {
      ...common,
      TIDBIT_ID: 'spoken-bit',
      TIDBIT_TEXT: 'spoken ingest rumor',
      COMMENT_ID: 'spoken-comment',
      COMMENT_TIDBIT: 'existing',
      PUBLIC_TIDBIT: 'existing',
      TOLD_AT: '2026-09-19T03:00:00.000Z',
      HISTORY_LINE: 'spoken history line',
    }),
    runGossipAction('mutate-append', {
      ...common,
      TIDBIT_ID: 'follow-bit',
      TIDBIT_TEXT: 'on-air follow-up rumor',
      COMMENT_ID: 'follow-comment',
      TOLD_AT: '2026-09-19T04:00:00.000Z',
      HISTORY_LINE: 'follow history line',
    }),
  ]);
  for (const result of [seeded, spoken, followed]) {
    assert.equal(result.status, 0, result.stderr);
  }
  const disk = await read();
  assert.deepEqual(
    disk.tidbits.map((item) => item.id).sort(),
    ['existing', 'follow-bit', 'seed-bit', 'spoken-bit'],
  );
  assert.deepEqual(
    disk.gossipComments.map((item) => item.id).sort(),
    ['follow-comment', 'seed-comment', 'spoken-comment'],
  );
  assert.equal(disk.gossipComments.find((item) => item.id === 'spoken-comment').tidbitId, 'existing');
  assert.equal(disk.tidbits.find((item) => item.id === 'existing').hearerPersonaIds, null);
  assert.deepEqual(disk.tidbits.find((item) => item.id === 'seed-bit').toldAt, ['2026-09-19T02:00:00.000Z']);
  assert.deepEqual(disk.tidbits.find((item) => item.id === 'spoken-bit').toldAt, ['2026-09-19T03:00:00.000Z']);
  assert.deepEqual(disk.tidbits.find((item) => item.id === 'follow-bit').toldAt, ['2026-09-19T04:00:00.000Z']);
  const history = disk.generatedGossipHistory.flat();
  assert.equal(history.includes('seed history line'), true);
  assert.equal(history.includes('spoken history line'), true);
  assert.equal(history.includes('follow history line'), true);
});

test('a later empty load does not overwrite a board another process already wrote', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gossip-'));
  const filePath = path.join(dir, 'state.json');
  const [wrote, loaded] = await Promise.all([
    runGossipAction('mutate-append', {
      STATE_PATH: filePath,
      DELAY_MS: '250',
      TIDBIT_ID: 'kept',
      TIDBIT_TEXT: 'kept rumor',
    }),
    runGossipAction('load', { STATE_PATH: filePath }),
  ]);
  assert.equal(wrote.status, 0, wrote.stderr);
  assert.equal(loaded.status, 0, loaded.stderr);
  assert.equal(JSON.parse(await readFile(filePath, 'utf8')).tidbits[0].id, 'kept');
  const later = await runGossipAction('load', { STATE_PATH: filePath });
  assert.equal(later.status, 0, later.stderr);
  const after = JSON.parse(await readFile(filePath, 'utf8'));
  assert.equal(after.tidbits.length, 1);
  assert.equal(after.tidbits[0].id, 'kept');
  assert.deepEqual(after.generatedGossipHistory, []);
  assert.deepEqual(after.gossipComments, []);
});

test('a mutate that cannot obtain the exclusive lock leaves the committed bytes unchanged', async () => {
  const { store, filePath } = await tempStore({
    tidbits: [tidbit({ id: 'kept', text: 'kept rumor' })],
  });
  const before = await readFile(filePath, 'utf8');
  const release = await acquireMutationLock(filePath);
  try {
    let ran = false;
    await assert.rejects(store.mutate(() => {
      ran = true;
    }), (err) => {
      assert.equal(err.message.includes(filePath), true);
      assert.match(err.message, /could not be locked for an exclusive update/);
      return true;
    });
    assert.equal(ran, false);
    assert.equal(await readFile(filePath, 'utf8'), before);
  } finally {
    release();
  }
});

test('server ownership does not block an incremental mutate', async () => {
  const { store, filePath, read } = await tempStore();
  await acquireServerOwnership(filePath);
  await store.mutate((state) => {
    state.tidbits.push(tidbit({ id: 'while-serving', text: 'committed while serve owns the workspace' }));
  });
  const disk = await read();
  assert.equal(disk.tidbits[0].id, 'while-serving');
});
