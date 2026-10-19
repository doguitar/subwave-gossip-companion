import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateOptions } from '../src/cli.js';

const config = { reviewRounds: 0 };

test('generateOptions passes reasoning through and overrides review steps', () => {
  const options = generateOptions(['generate', '--reasoning', 'none', '--review-steps', '2'], config);
  assert.equal(options.runConfig.llmThinkingLevel, 'none');
  assert.equal(options.reviewRounds, 2);
  assert.equal(config.reviewRounds, 0);
});

test('generateOptions keeps config review rounds when the flag is absent', () => {
  const options = generateOptions(['generate'], { reviewRounds: 1 });
  assert.equal(options.reviewRounds, 1);
  assert.equal(options.runConfig.llmThinkingLevel, undefined);
});

test('generateOptions rejects a review step outside 0-5', () => {
  assert.throws(() => generateOptions(['generate', '--review-steps', '9'], config), /0-5/);
});
