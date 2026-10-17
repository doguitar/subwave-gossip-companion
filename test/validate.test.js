import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateRumor } from '../src/validate.js';

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
