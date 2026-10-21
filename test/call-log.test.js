import assert from 'node:assert/strict';
import { mkdtemp, readFile, utimes, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { maintainLlmCallLog, shapeLlmCallRecord } from '../src/callLog.js';
import { loadConfig } from '../src/config.js';

const DAY = 24 * 60 * 60 * 1000;

async function writeSegment(file, lines, mtimeMs) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${lines.join('\n')}\n`);
  const when = new Date(mtimeMs);
  await utimes(file, when, when);
}

test('retention rewrites a stale active log without a later append', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'call-log-'));
  const active = path.join(dir, 'llm-calls.jsonl');
  const now = Date.now();
  await writeSegment(active, [
    JSON.stringify({ at: new Date(now - 8 * DAY).toISOString(), stage: 'old', prompt: 'secret' }),
  ], now);
  await maintainLlmCallLog(active, now);
  await assert.rejects(readFile(active, 'utf8'));
});

test('retention removes a stale rolled segment and leaves a fresh active log', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'call-log-'));
  const active = path.join(dir, 'llm-calls.jsonl');
  const rolled = path.join(dir, `llm-calls.${Date.now() - 1000}.jsonl`);
  const now = Date.now();
  await writeSegment(rolled, [
    JSON.stringify({ at: new Date(now - 9 * DAY).toISOString(), stage: 'old' }),
  ], now - 9 * DAY);
  await writeSegment(active, [
    JSON.stringify({ at: new Date(now - 1000).toISOString(), stage: 'new' }),
  ], now);
  await maintainLlmCallLog(active, now);
  await assert.rejects(readFile(rolled, 'utf8'));
  const kept = await readFile(active, 'utf8');
  assert.match(kept, /"stage":"new"/);
});

test('mixed-age active log keeps only fresh records', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'call-log-'));
  const active = path.join(dir, 'llm-calls.jsonl');
  const now = Date.now();
  await writeSegment(active, [
    JSON.stringify({ at: new Date(now - 10 * DAY).toISOString(), stage: 'old' }),
    JSON.stringify({ at: new Date(now - DAY).toISOString(), stage: 'new', prompt: 'keep-me' }),
  ], now);
  await maintainLlmCallLog(active, now);
  const kept = await readFile(active, 'utf8');
  assert.doesNotMatch(kept, /old/);
  assert.match(kept, /new/);
});

test('content mode can disable or minimize prompt logging', () => {
  const record = { stage: 'success', prompt: 'soul', response: 'rumor' };
  assert.equal(shapeLlmCallRecord(record, 'off'), null);
  const metadata = shapeLlmCallRecord(record, 'metadata');
  assert.equal(metadata.stage, 'success');
  assert.equal(metadata.prompt, undefined);
  assert.equal(metadata.response, undefined);
  assert.equal(shapeLlmCallRecord(record, 'full').prompt, 'soul');
});

test('empty call log path disables logging and content mode is parsed', () => {
  const disabled = loadConfig({ GOSSIP_LLM_CALL_LOG: '', GOSSIP_BASE_DIR: '/tmp/gossip-cfg' });
  assert.equal(disabled.config.llmCallLogPath, '');
  const full = loadConfig({ GOSSIP_LLM_LOG_CONTENT: 'full', GOSSIP_BASE_DIR: '/tmp/gossip-cfg' });
  assert.equal(full.config.llmLogContent, 'full');
  const bad = loadConfig({ GOSSIP_LLM_LOG_CONTENT: 'verbose', GOSSIP_BASE_DIR: '/tmp/gossip-cfg' });
  assert.ok(bad.errors.some((error) => error.includes('GOSSIP_LLM_LOG_CONTENT')));
});
