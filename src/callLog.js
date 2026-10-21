import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

export const LLM_CALL_LOG_MAX_BYTES = 512 * 1024;
export const LLM_CALL_LOG_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const LLM_LOG_CONTENT_MODES = ['off', 'metadata', 'full'];
const CONTENT_KEYS = ['prompt', 'system', 'user', 'messages', 'response', 'content', 'request', 'raw', 'soul', 'houseRules'];

function logStem(filePath) {
  const base = path.basename(filePath);
  return base.endsWith('.jsonl') ? base.slice(0, -'.jsonl'.length) : base;
}

function isRolledSegmentName(stem, name) {
  if (!name.endsWith('.jsonl') || name === `${stem}.jsonl`) return false;
  const prefix = `${stem}.`;
  if (!name.startsWith(prefix)) return false;
  const middle = name.slice(prefix.length, -'.jsonl'.length);
  return /^\d+$/.test(middle);
}

export async function listLlmCallLogSegments(filePath) {
  const dir = path.dirname(filePath);
  const stem = logStem(filePath);
  const activeName = path.basename(filePath);
  let names = [];
  try {
    names = await readdir(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return [filePath];
    throw err;
  }
  const paths = [];
  for (const name of names) {
    if (name === activeName || isRolledSegmentName(stem, name)) {
      paths.push(path.join(dir, name));
    }
  }
  if (!paths.length) paths.push(filePath);
  const withMtime = await Promise.all(
    paths.map(async (segmentPath) => {
      try {
        const { mtimeMs } = await stat(segmentPath);
        return { segmentPath, mtimeMs };
      } catch (err) {
        if (err.code === 'ENOENT') return null;
        throw err;
      }
    }),
  );
  return withMtime
    .filter(Boolean)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .map((entry) => entry.segmentPath);
}

async function rotateIfNeeded(filePath, nextLineBytes) {
  let size = 0;
  try {
    ({ size } = await stat(filePath));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    return;
  }
  if (size + nextLineBytes <= LLM_CALL_LOG_MAX_BYTES) return;
  const dir = path.dirname(filePath);
  const stem = logStem(filePath);
  const rolledPath = path.join(dir, `${stem}.${Date.now()}.jsonl`);
  await rename(filePath, rolledPath);
}

function recordTimeMs(record, fallbackMs) {
  const parsed = Date.parse(record?.at);
  return Number.isFinite(parsed) ? parsed : fallbackMs;
}

async function rewriteSegment(segmentPath, nowMs) {
  let text;
  let mtimeMs = nowMs;
  try {
    const fileStat = await stat(segmentPath);
    mtimeMs = fileStat.mtimeMs;
    text = await readFile(segmentPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
  const cutoff = nowMs - LLM_CALL_LOG_RETENTION_MS;
  const kept = [];
  let dropped = false;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      if (mtimeMs >= cutoff) kept.push(line);
      else dropped = true;
      continue;
    }
    if (recordTimeMs(record, mtimeMs) >= cutoff) kept.push(line);
    else dropped = true;
  }
  if (!dropped) return;
  if (!kept.length) {
    await unlink(segmentPath).catch((err) => {
      if (err.code !== 'ENOENT') throw err;
    });
    return;
  }
  const next = `${kept.join('\n')}\n`;
  if (next === text) return;
  const tempPath = `${segmentPath}.tmp`;
  await writeFile(tempPath, next, 'utf8');
  await rename(tempPath, segmentPath);
}

export async function maintainLlmCallLog(filePath, nowMs = Date.now()) {
  if (!filePath) return;
  for (const segmentPath of await listLlmCallLogSegments(filePath)) {
    await rewriteSegment(segmentPath, nowMs);
  }
}

export function shapeLlmCallRecord(record, mode = 'metadata') {
  const normalized = LLM_LOG_CONTENT_MODES.includes(mode) ? mode : 'metadata';
  if (normalized === 'off') return null;
  if (normalized === 'full') return record;
  const shaped = { ...record };
  for (const key of CONTENT_KEYS) delete shaped[key];
  return shaped;
}

export async function appendLlmCall(filePath = 'logs/llm-calls.jsonl', record) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const line = `${JSON.stringify(record)}\n`;
  const nextLineBytes = Buffer.byteLength(line, 'utf8');
  await rotateIfNeeded(filePath, nextLineBytes);
  await appendFile(filePath, line, 'utf8');
  await maintainLlmCallLog(filePath);
}

export async function appendOperationalLog(filePath, line) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await appendFile(filePath, `${line}\n`, 'utf8');
}
