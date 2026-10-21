import assert from 'node:assert/strict';
import { test } from 'node:test';
import { refreshCountOption, generateOptions } from '../src/cli.js';
import { loadConfig } from '../src/config.js';

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

test('refresh count uses the configured default or a validated CLI override', () => {
  assert.equal(refreshCountOption(['refresh', '--base-dir', '.', '1'], { refreshCount: 2 }), 1);
  assert.equal(refreshCountOption(['refresh', '--base-dir', '.'], { refreshCount: 2 }), 2);
  assert.throws(() => refreshCountOption(['refresh', '0'], { refreshCount: 2 }), /1-10/);
});

test('refresh count environment value is validated', () => {
  const { config, errors } = loadConfig({ GOSSIP_REFRESH_COUNT: '11' });
  assert.equal(config.refreshCount, 1);
  assert.ok(errors.includes('GOSSIP_REFRESH_COUNT must be an integer 1-10'));
});
