import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateRumor } from '../src/validate.js';

test('validateRumor accepts a single short beat', () => {
  assert.deepEqual(validateRumor('Heard Reed Silver laminated a fake inspection sticker in the galley.'), { ok: true });
});

test('validateRumor accepts two sentences that state the cause and the result', () => {
  const rumor = 'Reed Silver laminated a fake inspection sticker onto the galley cutter. The cutter waved the sticker at the next shift and cleared the whole rack.';
  assert.equal(rumor.length <= 420, true);
  assert.deepEqual(validateRumor(rumor), { ok: true });
});

test('validateRumor rejects a second and-now beat and overlong text', () => {
  assert.deepEqual(
    validateRumor('Heard Reed Silver laminated a fake sticker, and now the cutter is waving back.'),
    { ok: false, reason: 'second-beat' },
  );
  const longRumor = Array.from({ length: 60 }, (_, i) => `station${i}`).join(' ');
  assert.deepEqual(validateRumor(longRumor), { ok: false, reason: 'too-long' });
});

test('validateRumor rejects email, phone, and SSN-like text', () => {
  for (const rumor of [
    'Gamma mailed the booth note to gamma@example.com before air',
    'Gamma called the booth from 415-555-0199 before air',
    'Gamma wrote 123-45-6789 on the booth form before air',
  ]) {
    assert.deepEqual(validateRumor(rumor, { targets: [{ name: 'Gamma' }] }), { ok: false, reason: 'sensitive' });
  }
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
