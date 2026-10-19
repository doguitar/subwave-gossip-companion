import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  classifyStuntMotif,
  STUNT_MOTIF_ATTACHED_SIGNAGE,
  STUNT_MOTIF_OTHER,
  validateRumor,
} from '../src/validate.js';

test('validateRumor accepts a single short beat', () => {
  assert.deepEqual(validateRumor('Heard Reed Silver laminated a fake inspection sticker in the galley.'), { ok: true });
});

test('validateRumor rejects a second and-now beat and overlong text', () => {
  assert.deepEqual(
    validateRumor('Heard Reed Silver laminated a fake sticker, and now the cutter is waving back.'),
    { ok: false, reason: 'second-beat' },
  );
  const longRumor = Array.from({ length: 60 }, (_, i) => `station${i}`).join(' ');
  assert.deepEqual(validateRumor(longRumor), { ok: false, reason: 'too-long' });
});

test('validateRumor rejects schema placeholder text', () => {
  assert.deepEqual(validateRumor('string'), { ok: false, reason: 'placeholder-text' });
});

test('validateRumor accepts stunt plus immediate named-target reaction in one beat', () => {
  const targets = [{ name: 'Roxy' }];
  const rumor =
    'Walked in on Roxy testing neon leg warmers on a power strip and Roxy shrieked when the fuse popped.';
  assert.deepEqual(validateRumor(rumor, { targets }), { ok: true });
});

test('validateRumor accepts and-linked stunt and reaction without pivot phrases', () => {
  const targets = [{ name: 'Gamma' }];
  const rumor =
    'Gamma taped a dead cart over the legal ID and Gamma jumped when the booth light flickered red.';
  assert.deepEqual(validateRumor(rumor, { targets }), { ok: true });
});

test('classifyStuntMotif maps attached-signage reporter beats and spares unrelated stunts', () => {
  assert.equal(
    classifyStuntMotif('Heard Reed Silver laminated a fake inspection sticker in the galley.'),
    STUNT_MOTIF_ATTACHED_SIGNAGE,
  );
  assert.equal(
    classifyStuntMotif('word is Beta slapped a kapu tag on Gamma\'s mic cart'),
    STUNT_MOTIF_ATTACHED_SIGNAGE,
  );
  assert.equal(
    classifyStuntMotif('Gamma taped a dead cart over the legal ID and Gamma jumped when the booth light flickered red.'),
    STUNT_MOTIF_OTHER,
  );
  assert.equal(
    classifyStuntMotif('Walked in on Roxy testing neon leg warmers on a power strip and Roxy shrieked when the fuse popped.'),
    STUNT_MOTIF_OTHER,
  );
  assert.equal(
    classifyStuntMotif('unconfirmed the booth kettle whistled through the legal ID'),
    STUNT_MOTIF_OTHER,
  );
});

test('validateRumor rejects a second attached-signage rumor in the same session', () => {
  const first = 'Heard Reed Silver laminated a fake inspection sticker in the galley.';
  const second = 'word is Beta welded a compliance sticker onto Gamma\'s headphones';
  assert.deepEqual(validateRumor(first, { sessionRumors: [] }), { ok: true });
  assert.deepEqual(validateRumor(second, { sessionRumors: [first] }), {
    ok: false,
    reason: 'duplicate-stunt-motif',
  });
  assert.deepEqual(
    validateRumor('unconfirmed the booth kettle whistled through the legal ID twice', { sessionRumors: [first] }),
    { ok: true },
  );
});

test('validateRumor without sessionRumors stays backward compatible', () => {
  assert.deepEqual(validateRumor('Heard Reed Silver laminated a fake inspection sticker in the galley.'), { ok: true });
});

test('validateRumor still rejects get-this and and-now second beats', () => {
  assert.deepEqual(
    validateRumor('Heard Reed laminated a sticker, and get this, the whole hallway smells like glue.'),
    { ok: false, reason: 'second-beat' },
  );
  assert.deepEqual(
    validateRumor('Beta hid the kettle, get this: Gamma believed it was a smoke alarm.'),
    { ok: false, reason: 'second-beat' },
  );
});
