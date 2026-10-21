import path from 'node:path';

import { applyDotEnv, parseRefreshCount, requireConfig } from './config.js';
import { ensurePromptWorkspace, warnIfPromptDrift } from './promptWorkspace.js';
import { GossipStore } from './store.js';
import { SubwaveAdapter } from './subwave.js';
import { createServer, listen } from './server.js';
import { refreshGossip, seedGossip } from './seed.js';
import { ingestSpoken } from './ingest.js';
import { generateReview, generateSeed, preflightProvider, summarizeHouseRules, summarizePersonaSouls } from './llm.js';
import { createFollowupWatcher } from './followup.js';
import { maintainLlmCallLog } from './callLog.js';
import { createLog } from './log.js';

function baseDirFromArgs(argv) {
  const index = argv.findIndex((arg) => arg === '--base-dir' || arg === '--base');
  return index >= 0 ? argv[index + 1] : '';
}

export function applyCliOptions(argv, env) {
  const baseDir = baseDirFromArgs(argv);
  if (baseDir) env.GOSSIP_BASE_DIR = baseDir;
  const envDir = baseDir || env.GOSSIP_BASE_DIR || '.';
  applyDotEnv(path.resolve(envDir, '.env'), env);
}

function flagValue(argv, name) {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${name} needs a value`);
  }
  return value;
}

export function generateOptions(argv, config) {
  const reasoning = flagValue(argv, '--reasoning');
  const reviewSteps = flagValue(argv, '--review-steps');
  const runConfig = reasoning === undefined ? config : { ...config, llmThinkingLevel: reasoning };
  let reviewRounds = config.reviewRounds;
  if (reviewSteps !== undefined) {
    const rounds = Number(reviewSteps);
    if (!Number.isInteger(rounds) || rounds < 0 || rounds > 5) {
      throw new Error('--review-steps must be an integer 0-5');
    }
    reviewRounds = rounds;
  }
  return { runConfig, reviewRounds };
}

export function refreshCountOption(argv, config) {
  const values = [];
  for (let index = 1; index < argv.length; index += 1) {
    if (argv[index] === '--base-dir' || argv[index] === '--base') {
      index += 1;
      continue;
    }
    if (argv[index].startsWith('--')) throw new Error(`Unknown refresh option: ${argv[index]}`);
    values.push(argv[index]);
  }
  if (values.length > 1) throw new Error('refresh accepts at most one count');
  const explicit = values[0];
  return explicit === undefined
    ? config.refreshCount
    : parseRefreshCount(explicit, 'refresh count');
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  applyCliOptions(argv, env);
  const baseDir = path.resolve(env.GOSSIP_BASE_DIR || '.');
  const command = argv[0] || 'serve';
  let config = requireConfig(env);
  const log = createLog(config.operationalLogPath);
  ensurePromptWorkspace(baseDir);
  config = requireConfig(env);
  warnIfPromptDrift(config.baseDir, log);
  if (config.llmCallLogPath) await maintainLlmCallLog(config.llmCallLogPath);
  const store = new GossipStore(config.statePath);
  await store.load();
  if (['generate', 'seed', 'gossip:seed', 'refresh', 'gossip:refresh', 'summarize-souls'].includes(command)) {
    await preflightProvider({ config, log });
  }
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
    const maintenance = config.llmCallLogPath
      ? setInterval(() => {
        maintainLlmCallLog(config.llmCallLogPath).catch((err) => {
          log.warn?.(`[gossip] LLM call log retention failed: ${err.message}`);
        });
      }, 60 * 60 * 1000)
      : null;
    maintenance?.unref?.();
    const shutdown = (signal) => {
      clearInterval(maintenance);
      log.info(`[gossip] received ${signal}; shutting down`);
      server.close(() => process.exit(0));
    };
    process.once('SIGTERM', () => shutdown('SIGTERM'));
    process.once('SIGINT', () => shutdown('SIGINT'));
    return { server, store, adapter, config };
  }

  if (command === 'generate') {
    const { runConfig, reviewRounds } = generateOptions(argv, config);
    const before = new Set(store.snapshot().tidbits.map((tidbit) => tidbit.id));
    const result = await seedGossip({
      store,
      adapter,
      cap: config.seedCap,
      historyGenerations: config.gossipHistoryGenerations,
      timezone: config.timezone,
      minLength: config.minRumorLength,
      log,
      reviewRounds,
      rumorRegisters: config.rumorRegisters,
      generate: (args) => generateSeed({ config: runConfig, log, ...args }),
      generateReview: (args) => generateReview({ config: runConfig, log, ...args }),
      summarizeSouls: (personas) => summarizePersonaSouls({ config: runConfig, personas, log }),
      summarizeHouseRules: (rules) => summarizeHouseRules({ config: runConfig, houseRules: rules, log }),
    });
    const fresh = store.snapshot().tidbits.filter((tidbit) => !before.has(tidbit.id));
    for (const tidbit of fresh) {
      console.log(tidbit.text);
    }
    log.info(`[gossip] generate result ${JSON.stringify({ ...result, reviewRounds, reasoning: runConfig.llmThinkingLevel || '' })}`);
    return result;
  }

  if (command === 'seed' || command === 'gossip:seed') {
    const result = await seedGossip({
      store,
      adapter,
      cap: config.seedCap,
      historyGenerations: config.gossipHistoryGenerations,
      timezone: config.timezone,
      minLength: config.minRumorLength,
      log,
      reviewRounds: config.reviewRounds,
      rumorRegisters: config.rumorRegisters,
      generate: (args) => generateSeed({ config, log, ...args }),
      generateReview: (args) => generateReview({ config, log, ...args }),
      summarizeSouls: (personas) => summarizePersonaSouls({ config, personas, log }),
      summarizeHouseRules: (rules) => summarizeHouseRules({ config, houseRules: rules, log }),
    });
    log.info(`[gossip] seed result ${JSON.stringify(result)}`);
    return result;
  }

  if (command === 'refresh' || command === 'gossip:refresh') {
    const cap = refreshCountOption(argv, config);
    const result = await refreshGossip({
      store,
      adapter,
      cap,
      strictCap: true,
      historyGenerations: config.gossipHistoryGenerations,
      timezone: config.timezone,
      minLength: config.minRumorLength,
      log,
      reviewRounds: config.reviewRounds,
      rumorRegisters: config.rumorRegisters,
      generate: (args) => generateSeed({ config, log, ...args }),
      generateReview: (args) => generateReview({ config, log, ...args }),
      summarizeSouls: (personas) => summarizePersonaSouls({ config, personas, log }),
      summarizeHouseRules: (rules) => summarizeHouseRules({ config, houseRules: rules, log }),
    });
    log.info(`[gossip] refresh result ${JSON.stringify(result)}`);
    return result;
  }

  if (command === 'summarize-souls') {
    const { runConfig } = generateOptions(argv, config);
    const roster = await adapter.getRosterPersonas();
    const houseRules = adapter.getHouseRules ? await adapter.getHouseRules() : '';
    const rulesSummary = await summarizeHouseRules({ config: runConfig, houseRules, log });
    if (rulesSummary) console.log(`House rules\n${rulesSummary}\n`);
    const summaries = await summarizePersonaSouls({ config: runConfig, personas: roster, log });
    for (const item of summaries) {
      console.log(`${item.name}\n${item.summary}\n`);
    }
    return summaries;
  }

  if (command === 'ingest-spoken' || command === 'gossip:ingest-spoken') {
    const result = await ingestSpoken({ store, adapter, log });
    log.info(`[gossip] ingest result ${JSON.stringify(result)}`);
    return result;
  }

  throw new Error(`Unknown command: ${command}. Use serve | generate | summarize-souls | seed | refresh [count] | ingest-spoken`);
}

if (import.meta.url === `file://${process.argv[1].replaceAll('\\', '/')}` || process.argv[1]?.endsWith('cli.js')) {
  main().catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}
