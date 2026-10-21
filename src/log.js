import { appendOperationalLog } from './callLog.js';

/** Collapse internal newlines and JSON-quote for single-line operational log fields. */
export function formatRumorForOperationalLog(text) {
  const singleLine = String(text ?? '').replace(/\r\n|\r|\n/g, ' ').trim();
  return JSON.stringify(singleLine);
}

export function createLog(operationalLogPath, consoleSink = console) {
  let reportedWriteError = false;
  let appendQueue = Promise.resolve();

  const tee = (writeFn, message) => {
    writeFn(message);
    if (!operationalLogPath) return;
    appendQueue = appendQueue
      .then(() => appendOperationalLog(operationalLogPath, String(message)))
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
