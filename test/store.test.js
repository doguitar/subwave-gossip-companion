import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  appendGeneratedGossipHistory,
  currentTidbits,
  generatedGossipHistory,
  normalizeState,
  tidbitsKnownBy,
} from '../src/store.js';
import { PERSONA_A, PERSONA_B, tempStore, tidbit } from './helpers.js';

test('store loads reduced shape and persists a queued mutation atomically', async () => {
  const { store, read } = await tempStore();
  const snap = store.snapshot();
  assert.deepEqual(Object.keys(snap), ['tidbits', 'generatedGossipHistory']);
  assert.deepEqual(snap.generatedGossipHistory, []);
  await store.mutate((s) => {
    s.tidbits.push(tidbit());
  });
  const disk = await read();
  assert.deepEqual(Object.keys(disk), ['tidbits', 'generatedGossipHistory']);
  assert.equal(disk.tidbits.length, 1);
  assert.equal(currentTidbits(disk).length, 1);
  assert.equal(disk.tidbits[0].tellerPersonaId, PERSONA_A.id);
  assert.ok(!('id' in disk.tidbits[0]));
  assert.ok(!('status' in disk.tidbits[0]));
});

test('legacy tidbits-only state normalizes to empty generatedGossipHistory', () => {
  const state = normalizeState({
    tidbits: [tidbit({ text: 'legacy item' })],
  });
  assert.deepEqual(state.generatedGossipHistory, []);
  assert.equal(state.tidbits.length, 1);
  assert.equal(state.tidbits[0].text, 'legacy item');
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
