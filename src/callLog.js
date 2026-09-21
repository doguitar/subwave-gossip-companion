import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

export async function appendLlmCall(filePath = 'logs/llm-calls.jsonl', record) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await appendFile(filePath, `${JSON.stringify(record)}\n`, 'utf8');
}
