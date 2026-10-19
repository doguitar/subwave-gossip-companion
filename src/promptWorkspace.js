import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BUNDLED_PROMPT_PATH = fileURLToPath(new URL('../prompt.md', import.meta.url));

export const PROMPT_DRIFT_WARN =
  '[gossip] workspace prompt.md differs from shipped default (see prompt.md.default)';

export function bundledPromptPath() {
  return BUNDLED_PROMPT_PATH;
}

export function workspacePromptPaths(baseDir) {
  const dir = path.resolve(baseDir);
  return {
    live: path.join(dir, 'prompt.md'),
    defaultSnapshot: path.join(dir, 'prompt.md.default'),
  };
}

function isMissingOrEmpty(filePath) {
  if (!existsSync(filePath)) return true;
  try {
    const st = statSync(filePath);
    if (!st.isFile() || st.size === 0) return true;
    return readFileSync(filePath, 'utf8').trim() === '';
  } catch {
    return true;
  }
}

/** Refresh default snapshot and seed live prompt when missing or empty. */
export function ensurePromptWorkspace(baseDir, bundledPath = BUNDLED_PROMPT_PATH) {
  const resolvedBase = path.resolve(baseDir);
  mkdirSync(resolvedBase, { recursive: true });
  const { live, defaultSnapshot } = workspacePromptPaths(resolvedBase);

  copyFileSync(bundledPath, defaultSnapshot);

  let seededLive = false;
  if (isMissingOrEmpty(live)) {
    copyFileSync(defaultSnapshot, live);
    seededLive = true;
  }

  return { seededLive };
}

export function warnIfPromptDrift(baseDir, log) {
  const { live, defaultSnapshot } = workspacePromptPaths(baseDir);
  if (!existsSync(live) || !existsSync(defaultSnapshot)) return;
  const liveText = readFileSync(live, 'utf8').trim();
  const defaultText = readFileSync(defaultSnapshot, 'utf8').trim();
  if (liveText !== defaultText) {
    log.warn(PROMPT_DRIFT_WARN);
  }
}
