import { redact as defaultRedact } from './redact.js';

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

const ORDER: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };
const MAX_LINE_CHARS = 2_000;

export interface Logger {
  error(message: string, detail?: unknown): void;
  warn(message: string, detail?: unknown): void;
  info(message: string, detail?: unknown): void;
  debug(message: string, detail?: unknown): void;
}

export interface LoggerOptions {
  level?: LogLevel;
  /**
   * Where log lines go. Defaults to `process.stderr`. Never point this at stdout: in stdio mode stdout is the
   * MCP protocol channel and any stray byte corrupts the session.
   */
  stream?: { write(chunk: string): unknown };
  redact?: (text: string) => string;
}

/**
 * A minimal JSON-lines logger. Every line is redacted (codice fiscale, STP/ENI, JWTs, bearer tokens, registered
 * secrets) and truncated. Callers must still never pass document contents or tool inputs: redaction is a safety
 * net, not a licence to log clinical data.
 */
export function createLogger(options: LoggerOptions = {}): Logger {
  const threshold = ORDER[options.level ?? 'info'];
  const stream = options.stream ?? process.stderr;
  const redact = options.redact ?? defaultRedact;

  const write = (level: LogLevel, message: string, detail?: unknown): void => {
    if (ORDER[level] > threshold) return;
    const entry: Record<string, string> = { time: new Date().toISOString(), level, msg: message };
    if (detail !== undefined) entry.detail = describe(detail);
    let line = redact(JSON.stringify(entry));
    if (line.length > MAX_LINE_CHARS) line = `${line.slice(0, MAX_LINE_CHARS)}…[truncated]`;
    stream.write(`${line}\n`);
  };

  return {
    error: (m, d) => write('error', m, d),
    warn: (m, d) => write('warn', m, d),
    info: (m, d) => write('info', m, d),
    debug: (m, d) => write('debug', m, d),
  };
}

/** Errors are reduced to name and message: stacks and `cause` chains can carry request data. */
function describe(detail: unknown): string {
  if (detail instanceof Error) return `${detail.name}: ${detail.message}`;
  if (typeof detail === 'string') return detail;
  try {
    return JSON.stringify(detail);
  } catch {
    return String(detail);
  }
}

/** A logger that discards everything, for tests and embedding. */
export const silentLogger: Logger = { error() {}, warn() {}, info() {}, debug() {} };
