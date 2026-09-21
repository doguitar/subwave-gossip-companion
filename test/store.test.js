import assert from 'node:assert/strict';
import { test } from 'node:test';
import { currentTidbits, tidbitsKnownBy } from '../src/store.js';
import { PERSONA_A, PERSONA_B, tempStore, tidbit } from './helpers.js';

test('store loads reduced shape and persists a queued mutation atomically', async () => {
  const { store, read } = await tempStore();
  const snap = store.snapshot();
  assert.deepEqual(Object.keys(snap), ['tidbits']);
  await store.mutate((s) => {
    s.tidbits.push(tidbit());
  });
  const disk = await read();
  assert.deepEqual(Object.keys(disk), ['tidbits']);
  assert.equal(disk.tidbits.length, 1);
  assert.equal(currentTidbits(disk).length, 1);
  assert.equal(disk.tidbits[0].tellerPersonaId, PERSONA_A.id);
  assert.ok(!('id' in disk.tidbits[0]));
  assert.ok(!('status' in disk.tidbits[0]));
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
