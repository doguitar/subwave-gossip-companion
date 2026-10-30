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
const BUNDLED_REVIEW_PATH = fileURLToPath(new URL('../review.md', import.meta.url));

export const PROMPT_DRIFT_WARN =
  '[gossip] workspace prompt.md differs from shipped default (see prompt.md.default)';
export const REVIEW_DRIFT_WARN =
  '[gossip] workspace review.md differs from shipped default (see review.md.default)';

export function bundledPromptPath() {
  return BUNDLED_PROMPT_PATH;
}

export function bundledReviewPath() {
  return BUNDLED_REVIEW_PATH;
}

function workspaceTextPaths(baseDir, liveName) {
  const dir = path.resolve(baseDir);
  return {
    live: path.join(dir, liveName),
    defaultSnapshot: path.join(dir, `${liveName}.default`),
  };
}

export function workspacePromptPaths(baseDir) {
  return workspaceTextPaths(baseDir, 'prompt.md');
}

export function workspaceReviewPaths(baseDir) {
  return workspaceTextPaths(baseDir, 'review.md');
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

function ensureTextWorkspace(baseDir, liveName, bundledPath) {
  const resolvedBase = path.resolve(baseDir);
  mkdirSync(resolvedBase, { recursive: true });
  const { live, defaultSnapshot } = workspaceTextPaths(resolvedBase, liveName);

  copyFileSync(bundledPath, defaultSnapshot);

  let seededLive = false;
  if (isMissingOrEmpty(live)) {
    copyFileSync(defaultSnapshot, live);
    seededLive = true;
  }

  return { seededLive };
}

function warnIfTextDrift(baseDir, liveName, message, log) {
  const { live, defaultSnapshot } = workspaceTextPaths(baseDir, liveName);
  if (!existsSync(live) || !existsSync(defaultSnapshot)) return;
  const liveText = readFileSync(live, 'utf8').trim();
  const defaultText = readFileSync(defaultSnapshot, 'utf8').trim();
  if (liveText !== defaultText) {
    log.warn(message);
  }
}

/** Refresh default snapshot and seed live prompt when missing or empty. */
export function ensurePromptWorkspace(baseDir, bundledPath = BUNDLED_PROMPT_PATH) {
  return ensureTextWorkspace(baseDir, 'prompt.md', bundledPath);
}

/** Refresh default snapshot and seed live review prompt when missing or empty. */
export function ensureReviewWorkspace(baseDir, bundledPath = BUNDLED_REVIEW_PATH) {
  return ensureTextWorkspace(baseDir, 'review.md', bundledPath);
}

export function warnIfPromptDrift(baseDir, log) {
  warnIfTextDrift(baseDir, 'prompt.md', PROMPT_DRIFT_WARN, log);
}

export function warnIfReviewDrift(baseDir, log) {
  warnIfTextDrift(baseDir, 'review.md', REVIEW_DRIFT_WARN, log);
}
