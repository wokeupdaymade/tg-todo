// Minimal structured logger.
type Level = 'debug' | 'info' | 'warn' | 'error';
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const min = order[(process.env.LOG_LEVEL as Level) || 'info'] ?? 20;

function out(level: Level, msg: string, extra?: unknown) {
  if (order[level] < min) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${msg}`;
  const tail = extra === undefined ? '' : ' ' + (extra instanceof Error ? (extra.stack || extra.message) : JSON.stringify(extra));
  (level === 'error' || level === 'warn' ? console.error : console.log)(line + tail);
}

export const log = {
  debug: (m: string, e?: unknown) => out('debug', m, e),
  info: (m: string, e?: unknown) => out('info', m, e),
  warn: (m: string, e?: unknown) => out('warn', m, e),
  error: (m: string, e?: unknown) => out('error', m, e),
};
