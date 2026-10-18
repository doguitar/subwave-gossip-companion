import {
  appendFile,
  mkdir,
  readdir,
  rename,
  stat,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';

export const LLM_CALL_LOG_MAX_BYTES = 512 * 1024;
export const LLM_CALL_LOG_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

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

async function purgeExpiredSegments(filePath, nowMs = Date.now()) {
  const cutoff = nowMs - LLM_CALL_LOG_RETENTION_MS;
  for (const segmentPath of await listLlmCallLogSegments(filePath)) {
    if (segmentPath === filePath) continue;
    try {
      const { mtimeMs } = await stat(segmentPath);
      if (mtimeMs < cutoff) await unlink(segmentPath);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
}

export async function appendLlmCall(filePath = 'logs/llm-calls.jsonl', record) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const line = `${JSON.stringify(record)}\n`;
  const nextLineBytes = Buffer.byteLength(line, 'utf8');
  await rotateIfNeeded(filePath, nextLineBytes);
  await appendFile(filePath, line, 'utf8');
  await purgeExpiredSegments(filePath);
}
