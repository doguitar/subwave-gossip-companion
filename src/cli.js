import { applyDotEnv, requireConfig } from './config.js';
import { GossipStore } from './store.js';
import { SubwaveAdapter } from './subwave.js';
import { createServer, listen } from './server.js';
import { refreshGossip, seedGossip } from './seed.js';
import { ingestSpoken } from './ingest.js';
import { generateSeed } from './llm.js';
import { createFollowupWatcher } from './followup.js';

const log = {
  info: (m) => console.log(m),
  warn: (m) => console.warn(m),
  error: (m) => console.error(m),
};

function baseDirFromArgs(argv) {
  const index = argv.findIndex((arg) => arg === '--base-dir' || arg === '--base');
  return index >= 0 ? argv[index + 1] : '';
}

function applyCliOptions(argv, env) {
  const baseDir = baseDirFromArgs(argv);
  if (baseDir) env.GOSSIP_BASE_DIR = baseDir;
  applyDotEnv(baseDir ? `${baseDir}/.env` : undefined, env);
}
export async function main(argv = process.argv.slice(2), env = process.env) {
  applyCliOptions(argv, env);
  const command = argv[0] || 'serve';
  const config = requireConfig(env);
  const store = new GossipStore(config.statePath);
  await store.load();
  log.info(`[gossip] storage ready path=${config.statePath} tidbits=${store.snapshot().tidbits.length}`);
  const adapter = new SubwaveAdapter({
    apiUrl: config.apiUrl,
    apiUser: config.apiUser,
    apiPassword: config.apiPassword,
    apiToken: config.apiToken,
    log,
  });

  if (command === 'serve') {
    try {
      await adapter.getSchedule();
      log.info('[gossip] Subwave API reachable');
    } catch (err) {
      log.warn(`[gossip] Subwave API check failed: ${err.message}`);
    }
    const watcher = createFollowupWatcher({ store, adapter, config, log });
    const server = createServer({ store, adapter, config, log, watcher });
    await listen(server, config, log);
    return { server, store, adapter, config };
  }

  if (command === 'seed' || command === 'gossip:seed') {
    const result = await seedGossip({
      store,
      adapter,
      cap: config.seedCap,
      timezone: config.timezone,
      log,
      generate: (args) => generateSeed({ config, log, ...args }),
    });
    log.info(`[gossip] seed result ${JSON.stringify(result)}`);
    return result;
  }

  if (command === 'refresh' || command === 'gossip:refresh') {
    const result = await refreshGossip({
      store,
      adapter,
      cap: Number(argv[1]) || config.refreshCount || 1,
      timezone: config.timezone,
      log,
      generate: (args) => generateSeed({ config, log, ...args }),
    });
    log.info(`[gossip] refresh result ${JSON.stringify(result)}`);
    return result;
  }

  if (command === 'ingest-spoken' || command === 'gossip:ingest-spoken') {
    const result = await ingestSpoken({ store, adapter, log });
    log.info(`[gossip] ingest result ${JSON.stringify(result)}`);
    return result;
  }

  throw new Error(`Unknown command: ${command}. Use serve | seed | refresh | ingest-spoken`);
}

if (import.meta.url === `file://${process.argv[1].replaceAll('\\', '/')}` || process.argv[1]?.endsWith('cli.js')) {
  main().catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}
