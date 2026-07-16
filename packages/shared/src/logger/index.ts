import pino, { type Logger as PinoLogger } from 'pino';
import { redactLine } from './redact.js';

export type Logger = PinoLogger;

export interface CreateLoggerOptions {
  level?: string;
  name?: string;
}

// SC-2: the redaction hook runs on every line this logger ever writes,
// independent of any caller-supplied structure - see redact.ts for why a
// pino `redact` path list alone isn't sufficient.
export function createLogger(opts: CreateLoggerOptions = {}): Logger {
  return pino({
    ...(opts.level ? { level: opts.level } : {}),
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
