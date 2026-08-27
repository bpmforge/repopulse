import pino, { type Logger as PinoLogger } from 'pino';
import { redactLine } from './redact.js';

export type Logger = PinoLogger;

export interface CreateLoggerOptions {
  /** Explicit level. Defaults to LOG_LEVEL, then pino's own default. */
  level?: string;
  name?: string;
  /** Injectable so the test does not depend on the ambient environment. */
  env?: NodeJS.ProcessEnv;
}

// SC-2: the redaction hook runs on every line this logger ever writes,
// independent of any caller-supplied structure - see redact.ts for why a
// pino `redact` path list alone isn't sufficient.
export function createLogger(opts: CreateLoggerOptions = {}): Logger {
  // LOG_LEVEL IS READ HERE, and until W16-18 it was read NOWHERE — it sat in
  // deploy/.env and docs/CONFIG.md as a documented knob that did nothing, so an
  // operator turning it up to debug a production incident got exactly the same
  // output as before. A config option that silently does nothing is worse than
  // one that does not exist: it costs someone the time they spent trusting it.
  const level = opts.level ?? (opts.env ?? process.env).LOG_LEVEL;

  return pino({
    ...(level ? { level } : {}),
    ...(opts.name ? { name: opts.name } : {}),
    hooks: {
      streamWrite(line: string): string {
        return redactLine(line);
      },
    },
  });
}

export * from './redact.js';
export * from './audit.js';
