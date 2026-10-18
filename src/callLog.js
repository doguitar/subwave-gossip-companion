import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

export async function appendLlmCall(filePath = 'logs/llm-calls.jsonl', record) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await appendFile(filePath, `${JSON.stringify(record)}\n`, 'utf8');
}

export async function appendOperationalLog(filePath, line) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await appendFile(filePath, `${line}\n`, 'utf8');
}
