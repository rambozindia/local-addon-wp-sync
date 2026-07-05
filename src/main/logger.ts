import * as fs from 'fs';
import * as path from 'path';

let logFile: string | null = null;

function getLogFile(): string {
  if (!logFile) {
    logFile = path.join(require('electron').app.getPath('userData'), 'wp-sync.log');
  }
  return logFile;
}

/**
 * Append a line to the add-on's log file ({Local userData}/wp-sync.log)
 * and mirror it to Local's main-process console. Logging must never
 * break a sync, so all failures are swallowed.
 */
export function wpSyncLog(level: 'info' | 'error' | 'debug', message: string): void {
  const line = `[${new Date().toISOString()}] ${level.toUpperCase()}: ${message}\n`;
  try {
    fs.appendFileSync(getLogFile(), line);
  } catch {
    // ignore
  }
  try {
    // eslint-disable-next-line no-console
    console.log(`[wp-sync] ${level}: ${message}`);
  } catch {
    // ignore
  }
}
