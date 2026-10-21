import { writeSync } from 'node:fs';
import {
  appendOperationalLog,
  OPERATIONAL_LOG_MAX_BYTES,
  OPERATIONAL_LOG_RETENTION_MS,
} from './callLog.js';

/** Collapse internal newlines and JSON-quote for single-line operational log fields. */
export function formatRumorForOperationalLog(text) {
  const singleLine = String(text ?? '').replace(/\r\n|\r|\n/g, ' ').trim();
  return JSON.stringify(singleLine);
}

export function createLog(operationalLogPath, consoleSink = console, options = {}) {
  const maxBytes = options.maxBytes ?? OPERATIONAL_LOG_MAX_BYTES;
  const retentionMs = options.retentionMs ?? OPERATIONAL_LOG_RETENTION_MS;
  const now = options.now ?? Date.now;
  let reportedWriteError = false;
  let appendQueue = Promise.resolve();

  const tee = (writeFn, message) => {
    if (consoleSink === console) {
      const fd = writeFn === consoleSink.log ? 1 : 2;
      try {
        writeSync(fd, `${message}\n`);
      } catch {
        writeFn(message);
      }
    } else {
      writeFn(message);
    }
    if (!operationalLogPath) return;
    appendQueue = appendQueue
      .then(() => appendOperationalLog(operationalLogPath, String(message), {
        maxBytes,
        retentionMs,
        nowMs: now(),
      }))
      .catch((err) => {
        if (!reportedWriteError) {
          reportedWriteError = true;
          consoleSink.error(`[gossip] operational log write failed: ${err.message}`);
        }
      });
  };

  return {
    info: (message) => tee(consoleSink.log, message),
    warn: (message) => tee(consoleSink.warn, message),
    error: (message) => tee(consoleSink.error, message),
  };
}
