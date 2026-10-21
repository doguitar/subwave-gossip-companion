import { spawn } from 'node:child_process';
import { closeSync, constants, openSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const MUTATION_LOCK_TIMEOUT_MS = 5000;
// A killed server drops its flock when the kernel closes the pipe. The
// replacement serve starts as soon as the exit event fires, so give the
// helper a moment to leave before reporting that the workspace is owned.
const FLOCK_SERVER_TIMEOUT_MS = 1000;

// libuv UV_FS_O_EXLOCK on Windows. Node does not export it on fs.constants.
// Combined with the CRT read/write and create flags, CreateFile uses share
// mode 0: a second open fails with EBUSY until this handle closes, including
// when the process is killed. Delete-on-close is not used; Windows would
// allow a new file at the same path while the original handle was still open.
const WINDOWS_EXCLUSIVE_OPEN = 0x10000000 | 0x0002 | 0x0100;

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isContention(err) {
  return err?.code === 'EBUSY'
    || err?.code === 'EAGAIN'
    || err?.code === 'EWOULDBLOCK'
    || err?.flockStatus === 1;
}

function mutationLockError(statePath, cause) {
  const error = new Error(`${statePath} could not be locked for an exclusive update`);
  error.status = 503;
  error.code = 'GOSSIP_LOCK';
  error.cause = cause;
  return error;
}

export function mutationLockPath(statePath) {
  return `${statePath}.rmw.lock`;
}

export function serverLockPath(statePath) {
  return `${statePath}.serve.lock`;
}

function exclusiveOpenFlags() {
  if (process.platform === 'win32') return WINDOWS_EXCLUSIVE_OPEN;
  const exlock = constants.O_EXLOCK;
  if (!exlock) return 0;
  return exlock | constants.O_RDWR | constants.O_CREAT | (constants.O_NONBLOCK || 0);
}

function holdByExclusiveOpen(lockPath) {
  let fd;
  try {
    fd = openSync(lockPath, exclusiveOpenFlags());
  } catch (err) {
    if (isContention(err)) err.flockStatus = 1;
    throw err;
  }
  let released = false;
  return () => {
    if (released) return Promise.resolve();
    released = true;
    try {
      closeSync(fd);
    } catch {
      // The process is dropping the handle.
    }
    return Promise.resolve();
  };
}

function holdByFlock(lockPath, { keepAlive }) {
  return new Promise((resolve, reject) => {
    const child = spawn('flock', [
      '-n',
      '-x',
      lockPath,
      '-c',
      'printf READY; exec cat >/dev/null',
    ], { stdio: ['pipe', 'pipe', 'pipe'] });
    let settled = false;
    let stdout = '';
    let stderr = '';
    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    child.stdin.on('error', () => {});
    child.stdout.on('error', () => {});
    child.stderr.on('error', () => {});
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (!stdout.includes('READY') || settled) return;
      settled = true;
      // Keep the helper referenced until the lock is actually held so a
      // server can wait for it. After that, an ownership lock must not keep
      // the process alive: a corrupt state file has to exit non-zero.
      if (!keepAlive) {
        child.unref();
        child.stdin.unref();
        child.stdout.unref();
        child.stderr.unref();
      }
      let released = false;
      resolve(() => {
        if (released) return Promise.resolve();
        released = true;
        return new Promise((done) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            done();
            return;
          }
          child.once('exit', () => done());
          try { child.stdin.end(); } catch { /* already closed */ }
          try { child.kill(); } catch { /* already gone */ }
        });
      });
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (err) => fail(err));
    child.on('exit', (code, signal) => {
      const err = new Error((stderr || '').trim() || `lock helper exited ${code ?? signal}`);
      err.flockStatus = code;
      if (code === 1) err.code = 'EBUSY';
      fail(err);
    });
  });
}

async function hold(lockPath, options) {
  if (exclusiveOpenFlags()) return holdByExclusiveOpen(lockPath);
  return holdByFlock(lockPath, options);
}

async function acquireHeldLock(lockPath, timeoutMs, options) {
  await mkdir(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await hold(lockPath, options);
    } catch (err) {
      if (!isContention(err) || Date.now() >= deadline) throw err;
      await delay(20);
    }
  }
}

export async function acquireMutationLock(statePath, { timeoutMs = MUTATION_LOCK_TIMEOUT_MS } = {}) {
  const timeout = Number(timeoutMs);
  if (!Number.isInteger(timeout) || timeout < 0 || timeout > 60_000) {
    throw mutationLockError(statePath, new Error('mutation lock timeout is out of range'));
  }
  try {
    return await acquireHeldLock(mutationLockPath(statePath), timeout, { keepAlive: true });
  } catch (err) {
    throw mutationLockError(statePath, err);
  }
}

const serverLockReleases = [];

export async function acquireServerOwnership(statePath) {
  const timeoutMs = exclusiveOpenFlags() ? 0 : FLOCK_SERVER_TIMEOUT_MS;
  try {
    const release = await acquireHeldLock(serverLockPath(statePath), timeoutMs, { keepAlive: false });
    serverLockReleases.push(release);
    return release;
  } catch (err) {
    if (isContention(err)) {
      const error = new Error(`${statePath}: another server already owns the workspace`);
      error.code = 'GOSSIP_SERVER_OWNED';
      throw error;
    }
    const error = new Error(`${statePath}: could not take exclusive ownership of the workspace`);
    error.code = 'GOSSIP_SERVER_LOCK';
    error.cause = err;
    throw error;
  }
}
