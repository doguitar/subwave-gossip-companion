import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, stat, utimes, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  appendOperationalLog,
  maintainLlmCallLog,
  maintainOperationalLog,
  shapeLlmCallRecord,
} from '../src/callLog.js';
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

const WEEK = 7 * DAY;

test('append past the maximum renames the active bytes and leaves the new line whole', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'oplog-'));
  const active = path.join(dir, 'gossip.log');
  const original = 'existing-bytes\n';
  const nowMs = 1_700_000_000_000;
  const mtime = nowMs - 2 * DAY;
  await writeFile(active, original);
  await utimes(active, new Date(mtime), new Date(mtime));
  await appendOperationalLog(active, 'fresh-line', {
    maxBytes: Buffer.byteLength(original),
    retentionMs: WEEK,
    nowMs,
  });
  assert.equal(await readFile(active, 'utf8'), 'fresh-line\n');
  const rolledPath = path.join(dir, `gossip.${nowMs}.log`);
  assert.equal(await readFile(rolledPath, 'utf8'), original);
  assert.ok(Math.abs((await stat(rolledPath)).mtimeMs - mtime) < 2000);
});

test('an append that lands exactly on the maximum keeps the active file', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'oplog-'));
  const active = path.join(dir, 'gossip.log');
  await writeFile(active, 'abcd');
  await appendOperationalLog(active, 'ef', { maxBytes: 7, retentionMs: WEEK, nowMs: 1_700_000_000_000 });
  assert.equal(await readFile(active, 'utf8'), 'abcdef\n');
  assert.deepEqual(await readdir(dir), ['gossip.log']);
});

test('a line under the maximum is stored as the message plus a newline', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'oplog-'));
  const active = path.join(dir, 'gossip.log');
  await appendOperationalLog(active, 'storage ready');
  assert.equal(await readFile(active, 'utf8'), 'storage ready\n');
});

test('a single line longer than the maximum is still written whole', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'oplog-'));
  const active = path.join(dir, 'gossip.log');
  await writeFile(active, '');
  await appendOperationalLog(active, '0123456789', {
    maxBytes: 4,
    retentionMs: WEEK,
    nowMs: 1_700_000_000_000,
  });
  assert.equal(await readFile(active, 'utf8'), '0123456789\n');
  assert.deepEqual(await readdir(dir), ['gossip.log']);

  const withHistory = path.join(dir, 'nested', 'gossip.log');
  await mkdir(path.dirname(withHistory), { recursive: true });
  await writeFile(withHistory, 'old\n');
  const nowMs = 1_700_000_000_000;
  await utimes(withHistory, new Date(nowMs), new Date(nowMs));
  await appendOperationalLog(withHistory, '0123456789', { maxBytes: 4, retentionMs: WEEK, nowMs });
  assert.equal(await readFile(withHistory, 'utf8'), '0123456789\n');
  assert.equal(await readFile(path.join(dir, 'nested', `gossip.${nowMs}.log`), 'utf8'), 'old\n');
});

test('operational rotation counts UTF-8 bytes', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'oplog-'));
  const active = path.join(dir, 'gossip.log');
  const nowMs = 1_700_000_000_000;
  await writeFile(active, 'ab');
  await utimes(active, new Date(nowMs), new Date(nowMs));
  await appendOperationalLog(active, 'é', { maxBytes: 4, retentionMs: WEEK, nowMs });
  assert.equal(await readFile(active, 'utf8'), 'é\n');
  assert.equal(await readFile(path.join(dir, `gossip.${nowMs}.log`), 'utf8'), 'ab');
});

test('appendOperationalLog rolls a full file at the default 524288 byte cap', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'oplog-'));
  const active = path.join(dir, 'gossip.log');
  await writeFile(active, 'x'.repeat(524288));
  await appendOperationalLog(active, 'next');
  assert.equal(await readFile(active, 'utf8'), 'next\n');
  const rolled = (await readdir(dir)).filter((name) => /^gossip\.\d+\.log$/.test(name));
  assert.equal(rolled.length, 1);
  assert.equal((await stat(path.join(dir, rolled[0]))).size, 524288);
});

test('appendOperationalLog drops siblings older than the default seven days', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'oplog-'));
  const active = path.join(dir, 'gossip.log');
  const stale = path.join(dir, 'gossip.111.log');
  await writeFile(stale, 'stale\n');
  const old = new Date(Date.now() - 8 * DAY);
  await utimes(stale, old, old);
  await appendOperationalLog(active, 'kept');
  assert.equal(await readFile(active, 'utf8'), 'kept\n');
  await assert.rejects(readFile(stale, 'utf8'));
});

test('the same append expires an old sibling, keeps a fresh one, and leaves other files', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'oplog-'));
  const active = path.join(dir, 'gossip.log');
  const expired = path.join(dir, 'gossip.111.log');
  const fresh = path.join(dir, 'gossip.222.log');
  const callLog = path.join(dir, 'llm-calls.jsonl');
  const rolledCall = path.join(dir, 'llm-calls.333.jsonl');
  const notes = path.join(dir, 'notes.txt');
  const disguised = path.join(dir, 'gossip.not-a-time.log');
  const retentionMs = WEEK;
  const nowMs = Date.now() + retentionMs + 60_000;
  await writeFile(expired, 'expired-bytes\n');
  await utimes(expired, new Date(nowMs - retentionMs - 5000), new Date(nowMs - retentionMs - 5000));
  await writeFile(fresh, 'fresh-bytes\n');
  await utimes(fresh, new Date(nowMs - 1000), new Date(nowMs - 1000));
  await writeFile(callLog, '{"at":"old"}\n');
  await utimes(callLog, new Date(0), new Date(0));
  await writeFile(rolledCall, '{"at":"rolled"}\n');
  await utimes(rolledCall, new Date(0), new Date(0));
  await writeFile(notes, 'notes\n');
  await utimes(notes, new Date(0), new Date(0));
  await writeFile(disguised, 'leave-me\n');
  await utimes(disguised, new Date(0), new Date(0));
  await appendOperationalLog(active, 'active-line', { maxBytes: 100, retentionMs, nowMs });
  assert.equal(await readFile(active, 'utf8'), 'active-line\n');
  await assert.rejects(readFile(expired, 'utf8'));
  assert.equal(await readFile(fresh, 'utf8'), 'fresh-bytes\n');
  assert.equal(await readFile(callLog, 'utf8'), '{"at":"old"}\n');
  assert.equal(await readFile(rolledCall, 'utf8'), '{"at":"rolled"}\n');
  assert.equal(await readFile(notes, 'utf8'), 'notes\n');
  assert.equal(await readFile(disguised, 'utf8'), 'leave-me\n');
});

test('an expired active file is removed after it is renamed aside', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'oplog-'));
  const active = path.join(dir, 'gossip.log');
  const retentionMs = WEEK;
  const nowMs = Date.now() + retentionMs + 60_000;
  await writeFile(active, 'old-bytes');
  await utimes(active, new Date(nowMs - retentionMs - 5000), new Date(nowMs - retentionMs - 5000));
  await appendOperationalLog(active, 'fresh', { maxBytes: 1, retentionMs, nowMs });
  assert.equal(await readFile(active, 'utf8'), 'fresh\n');
  assert.deepEqual(await readdir(dir), ['gossip.log']);
});

test('a basename with no extension rolls to name.epoch', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'oplog-'));
  const active = path.join(dir, 'stationlog');
  const nowMs = 1_700_000_000_000;
  await writeFile(active, 'abcdef');
  await utimes(active, new Date(nowMs), new Date(nowMs));
  await appendOperationalLog(active, 'z', { maxBytes: 4, retentionMs: WEEK, nowMs });
  assert.equal(await readFile(active, 'utf8'), 'z\n');
  assert.equal(await readFile(path.join(dir, `stationlog.${nowMs}`), 'utf8'), 'abcdef');
});

test('startup prune deletes stale operational segments and leaves a fresh one', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'oplog-'));
  const active = path.join(dir, 'gossip.log');
  const stale = path.join(dir, 'gossip.111.log');
  const fresh = path.join(dir, 'gossip.222.log');
  const unrelated = path.join(dir, 'llm-calls.jsonl');
  const nowMs = 1_700_000_000_000;
  await writeSegment(active, ['active-old'], nowMs - 8 * DAY);
  await writeSegment(stale, ['rolled-old'], nowMs - 8 * DAY);
  await writeSegment(fresh, ['rolled-fresh', 'still-here'], nowMs - DAY);
  await writeSegment(unrelated, ['{"at":"old"}'], nowMs - 8 * DAY);
  await maintainOperationalLog(active, { nowMs, retentionMs: WEEK });
  await assert.rejects(readFile(active, 'utf8'));
  await assert.rejects(readFile(stale, 'utf8'));
  assert.equal(await readFile(fresh, 'utf8'), 'rolled-fresh\nstill-here\n');
  assert.equal(await readFile(unrelated, 'utf8'), '{"at":"old"}\n');
});

test('operational retention keeps a segment at the cutoff and deletes an older one', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'oplog-'));
  const active = path.join(dir, 'gossip.log');
  const atCutoff = path.join(dir, 'gossip.1.log');
  const older = path.join(dir, 'gossip.2.log');
  const retentionMs = DAY;
  await writeSegment(atCutoff, ['keep'], 1_700_000_000_000);
  await writeSegment(active, ['active'], 1_700_000_000_000);
  await writeSegment(older, ['drop'], 1_700_000_000_000 - retentionMs - 5000);
  const cutoffMs = (await stat(atCutoff)).mtimeMs;
  const nowMs = cutoffMs + retentionMs;
  assert.equal((await stat(active)).mtimeMs, cutoffMs);
  assert.ok((await stat(older)).mtimeMs < nowMs - retentionMs);
  await maintainOperationalLog(active, { nowMs, retentionMs });
  assert.equal(await readFile(atCutoff, 'utf8'), 'keep\n');
  assert.equal(await readFile(active, 'utf8'), 'active\n');
  await assert.rejects(readFile(older, 'utf8'));
});

test('operational prune treats a missing directory and an empty directory as empty', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'oplog-'));
  await maintainOperationalLog(path.join(dir, 'missing', 'gossip.log'), {
    nowMs: 1_700_000_000_000,
    retentionMs: 1,
  });
  await maintainOperationalLog(path.join(dir, 'gossip.log'), {
    nowMs: 1_700_000_000_000,
    retentionMs: 1,
  });
  assert.deepEqual(await readdir(dir), []);
  await appendOperationalLog(path.join(dir, 'gone', 'gossip.log'), 'hello', {
    maxBytes: 4,
    retentionMs: WEEK,
    nowMs: 1_700_000_000_000,
  });
  assert.equal(await readFile(path.join(dir, 'gone', 'gossip.log'), 'utf8'), 'hello\n');
});

test('empty call log path disables logging and content mode is parsed', () => {
  const disabled = loadConfig({ GOSSIP_LLM_CALL_LOG: '', GOSSIP_BASE_DIR: '/tmp/gossip-cfg' });
  assert.equal(disabled.config.llmCallLogPath, '');
  const full = loadConfig({ GOSSIP_LLM_LOG_CONTENT: 'full', GOSSIP_BASE_DIR: '/tmp/gossip-cfg' });
  assert.equal(full.config.llmLogContent, 'full');
  const bad = loadConfig({ GOSSIP_LLM_LOG_CONTENT: 'verbose', GOSSIP_BASE_DIR: '/tmp/gossip-cfg' });
  assert.ok(bad.errors.some((error) => error.includes('GOSSIP_LLM_LOG_CONTENT')));
});
