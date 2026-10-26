import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { HttpConfigError, startHttpServer } from './http.js';
import { createLogger, type Logger, type LogLevel } from './log.js';
import { addSecret, redact } from './redact.js';
import { createFseMcpServer } from './server.js';
import { VERSION } from './version.js';

export const TOKEN_ENV = 'FSE_MCP_TOKEN';

export interface CliOptions {
  mode: 'stdio' | 'http';
  host: string;
  port: number;
  allowedHosts: string[];
  logLevel: LogLevel;
  help: boolean;
  version: boolean;
}

export const USAGE = `Usage: fse-mcp [options]

Unofficial MCP server for FSE 2.0 CDA2 integration. Not affiliated with the Italian Ministry of Health.

Options:
  --http                 Serve Streamable HTTP instead of stdio. Requires ${TOKEN_ENV}.
  --host <address>       Interface to bind in HTTP mode (default 127.0.0.1).
  --port <port>          Port in HTTP mode (default 3333).
  --allowed-host <name>  Hostname accepted in the Host header (repeatable). Defaults to localhost names.
  --log-level <level>    error | warn | info | debug (default info). Logs go to stderr only.
  -v, --version          Print the version.
  -h, --help             Print this help.

Environment:
  ${TOKEN_ENV}          Bearer token for HTTP mode, at least 32 characters (openssl rand -hex 32).
`;

const LOG_LEVELS: readonly LogLevel[] = ['error', 'warn', 'info', 'debug'];

/** Thrown for invalid command-line arguments. */
export class CliError extends Error {
  override name = 'CliError';
}

/** Parses command-line arguments strictly: unknown options are an error. */
export function parseCliArgs(argv: string[]): CliOptions {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        http: { type: 'boolean', default: false },
        host: { type: 'string', default: '127.0.0.1' },
        port: { type: 'string', default: '3333' },
        'allowed-host': { type: 'string', multiple: true, default: [] },
        'log-level': { type: 'string', default: 'info' },
        version: { type: 'boolean', short: 'v', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    }));
  } catch (error) {
    throw new CliError(error instanceof Error ? error.message : 'Invalid arguments');
  }

  if (!/^\d{1,5}$/.test(values.port) || Number(values.port) > 65_535) {
    throw new CliError('--port must be an integer between 0 and 65535');
  }
  const logLevel = values['log-level'] as LogLevel;
  if (!LOG_LEVELS.includes(logLevel))
    throw new CliError(`--log-level must be one of ${LOG_LEVELS.join(', ')}`);

  return {
    mode: values.http ? 'http' : 'stdio',
    host: values.host,
    port: Number(values.port),
    allowedHosts: values['allowed-host'],
    logLevel,
    help: values.help,
    version: values.version,
  };
}

/**
 * Entry point. Returns the process exit code for immediate failures; in server mode the promise resolves once
 * the server is running and the process stays alive on its open handles.
 */
export async function main(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  stderr: { write(chunk: string): unknown } = process.stderr,
): Promise<number> {
  let options: CliOptions;
  try {
    options = parseCliArgs(argv);
  } catch (error) {
    stderr.write(`${redact(error instanceof Error ? error.message : String(error))}\n\n${USAGE}`);
    return 2;
  }
  if (options.help) {
    stderr.write(USAGE);
    return 0;
  }
  if (options.version) {
    stderr.write(`${VERSION}\n`);
    return 0;
  }

  const logger = createLogger({ level: options.logLevel, stream: stderr });

  // Read the token once and remove it from the environment so that nothing else in the process (or a child
  // process) can read it later.
  const token = env[TOKEN_ENV];
  delete env[TOKEN_ENV];
  if (token) addSecret(token);

  if (options.mode === 'stdio') {
    guardStdout(logger);
    const server = createFseMcpServer({ logger });
    await server.connect(new StdioServerTransport());
    logger.info(`fse-mcp ${VERSION} running on stdio`);
    return 0;
  }

  if (!token) {
    logger.error(`Refusing to start: HTTP mode requires the ${TOKEN_ENV} environment variable.`);
    return 1;
  }
  try {
    const running = await startHttpServer({
      createMcpServer: () => createFseMcpServer({ logger }),
      token,
      host: options.host,
      port: options.port,
      allowedHostnames: options.allowedHosts,
      logger,
    });
    const shutdown = () => {
      void running.close().finally(() => process.exit(0));
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    return 0;
  } catch (error) {
    if (error instanceof HttpConfigError) {
      logger.error(`Refusing to start: ${error.message}`);
      return 1;
    }
    throw error;
  }
}

/**
 * In stdio mode stdout carries the protocol. Route `console.log` and friends to the stderr logger so that a
 * stray log line from a dependency cannot corrupt the session or leak data into the protocol stream.
 */
function guardStdout(logger: Logger): void {
  const toLogger = (...args: unknown[]) => logger.info(args.map((a) => String(a)).join(' '));
  /* eslint-disable no-console -- reassigning, not calling: this is the guard the rule exists for. */
  console.log = toLogger;
  console.info = toLogger;
  console.debug = toLogger;
  /* eslint-enable no-console */
}
