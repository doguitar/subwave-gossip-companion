import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export const description = 'Ingest spoken gossip events. Never returns airable data.';

export default async function (_ctx, _state, services) {
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['src/cli.js', 'ingest-spoken'], { cwd: root, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', resolve);
  });
  services?.log?.(`gossip ingest exit=${code}`);
  return { available: false, exit: code };
}
