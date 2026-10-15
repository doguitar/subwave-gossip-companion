import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  appendGeneratedGossipHistory,
  currentTidbits,
  generatedGossipHistory,
  gossipComments,
  gossipForActor,
  legacyTidbitId,
  normalizeState,
  recordGossipComment,
  tidbitsKnownBy,
} from '../src/store.js';
import { PERSONA_A, PERSONA_B, tempStore, tidbit } from './helpers.js';

test('store loads reduced shape and persists a queued mutation atomically', async () => {
  const { store, read } = await tempStore();
  const snap = store.snapshot();
  assert.deepEqual(Object.keys(snap), ['tidbits', 'generatedGossipHistory', 'gossipComments']);
  assert.deepEqual(snap.generatedGossipHistory, []);
  assert.deepEqual(snap.gossipComments, []);
  await store.mutate((s) => {
    s.tidbits.push(tidbit());
  });
  const disk = await read();
  assert.deepEqual(Object.keys(disk), ['tidbits', 'generatedGossipHistory', 'gossipComments']);
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

test('comment records normalize and keep the newest 1000', () => {
  const state = normalizeState({
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

  assert.deepEqual(gossipForActor(state, ids, 'persona-a', 'Test Show').map((t) => t.id), ['fresh', 'older']);

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
  assert.deepEqual(
    gossipForActor(state, [PERSONA_A.id], '', 'Test Show').map((t) => t.text),
    tidbitsKnownBy(state, [PERSONA_A.id]).map((t) => t.text),
  );
});
