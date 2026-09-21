import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateRumor } from '../src/validate.js';

test('validateRumor accepts non-empty rumors regardless of length', () => {
  const longRumor = Array.from({ length: 60 }, (_, i) => `station${i}`).join(' ');
  assert.deepEqual(validateRumor(longRumor), { ok: true });
});

test('validateRumor rejects schema placeholder text', () => {
  assert.deepEqual(validateRumor('string'), { ok: false, reason: 'placeholder-text' });
});
