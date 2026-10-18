import { appendOperationalLog } from './callLog.js';

export function createLog(operationalLogPath, consoleSink = console) {
  let reportedWriteError = false;

  const tee = (writeFn, message) => {
    writeFn(message);
    if (!operationalLogPath) return;
    appendOperationalLog(operationalLogPath, String(message)).catch((err) => {
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
