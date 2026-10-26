import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { type AddressInfo } from 'node:net';
import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { MAX_HTTP_BODY_BYTES, MIN_TOKEN_LENGTH } from './limits.js';
import { type Logger, silentLogger } from './log.js';

export const MCP_PATH = '/mcp';
export const LOOPBACK_HOSTNAMES = ['localhost', '127.0.0.1', '[::1]'] as const;

export interface HttpServerOptions {
  /** Builds a fresh MCP server for each request (stateless mode). */
  createMcpServer: () => McpServer;
  /** Bearer token clients must send. Required, at least {@link MIN_TOKEN_LENGTH} characters. */
  token: string;
  /** Interface to bind. Defaults to `127.0.0.1`. */
  host?: string;
  /** Port to bind. `0` picks a free port. Defaults to `3333`. */
  port?: number;
  /**
   * Hostnames accepted in the `Host` and `Origin` headers (DNS rebinding protection), without port. Defaults to
   * the loopback names. Required when binding to a non-loopback interface.
   */
  allowedHostnames?: string[];
  /** Maximum request body in bytes. Defaults to {@link MAX_HTTP_BODY_BYTES}. */
  maxBodyBytes?: number;
  logger?: Logger;
}

export interface RunningHttpServer {
  server: Server;
  /** Base URL of the MCP endpoint, for example `http://127.0.0.1:3333/mcp`. */
  url: string;
  close(): Promise<void>;
}

/** Thrown when the options are unsafe. The server does not start. */
export class HttpConfigError extends Error {
  override name = 'HttpConfigError';
}

/** Returns true for interfaces only reachable from this machine. */
export function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '::1' || host === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(host);
}

/** Validates the options and returns them with defaults applied. Throws {@link HttpConfigError}. */
export function resolveHttpOptions(options: HttpServerOptions) {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 3333;
  if (typeof options.token !== 'string' || options.token.length < MIN_TOKEN_LENGTH) {
    throw new HttpConfigError(
      `HTTP mode requires an access token of at least ${MIN_TOKEN_LENGTH} characters in FSE_MCP_TOKEN ` +
        '(for example: openssl rand -hex 32).',
    );
  }
  if (/\s/.test(options.token)) throw new HttpConfigError('FSE_MCP_TOKEN must not contain whitespace.');
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new HttpConfigError('Invalid port.');

  const allowedHostnames = (options.allowedHostnames ?? [])
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  if (!isLoopbackHost(host) && allowedHostnames.length === 0) {
    throw new HttpConfigError(
      `Binding to ${host} exposes the server beyond this machine. Pass --allowed-host with the hostname ` +
        'clients will use, and put a TLS-terminating reverse proxy in front.',
    );
  }
  const hostnames = allowedHostnames.length > 0 ? allowedHostnames : [...LOOPBACK_HOSTNAMES];
  const maxBodyBytes = options.maxBodyBytes ?? MAX_HTTP_BODY_BYTES;
  return { host, port, hostnames, maxBodyBytes, token: options.token };
}

/**
 * Starts the Streamable HTTP transport in stateless mode. Each request is checked in this order, and refused
 * before any MCP processing:
 *
 * 1. path is {@link MCP_PATH}, method is POST;
 * 2. `Host` (and `Origin`, when present) is an allowed hostname: DNS rebinding protection;
 * 3. `Authorization: Bearer <token>` matches, compared in constant time;
 * 4. declared body size is within the limit (the SDK also enforces it while streaming).
 *
 * No CORS headers are ever sent, so browsers on other origins cannot read responses.
 */
export async function startHttpServer(options: HttpServerOptions): Promise<RunningHttpServer> {
  const config = resolveHttpOptions(options);
  const logger = options.logger ?? silentLogger;
  const expectedDigest = digest(config.token);
  let boundPort = config.port;

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const path = (req.url ?? '').split('?')[0];
    if (path !== MCP_PATH) return reject(res, 404, 'Not found');

    if (!isAllowedHost(req.headers.host, config.hostnames)) return reject(res, 403, 'Forbidden host');
    const origin = req.headers.origin;
    if (origin !== undefined && !isAllowedOrigin(origin, config.hostnames)) {
      return reject(res, 403, 'Forbidden origin');
    }

    if (!isAuthorized(req.headers.authorization, expectedDigest)) {
      res.setHeader('WWW-Authenticate', 'Bearer');
      return reject(res, 401, 'Unauthorized');
    }

    if (req.method !== 'POST') {
      // Stateless mode: no standalone SSE stream (GET) and no sessions to delete (DELETE).
      res.setHeader('Allow', 'POST');
      return reject(res, 405, 'Method not allowed');
    }

    const declared = Number(req.headers['content-length'] ?? 0);
    if (Number.isFinite(declared) && declared > config.maxBodyBytes) {
      return reject(res, 413, 'Payload too large');
    }

    const mcp = options.createMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      maxRequestBodySize: config.maxBodyBytes,
      // Second layer of DNS rebinding protection inside the SDK (exact Host match, with and without port).
      enableDnsRebindingProtection: true,
      allowedHosts: config.hostnames.flatMap((h) => [h, `${h}:${boundPort}`]),
    });
    res.on('close', () => {
      void transport.close();
      void mcp.close();
    });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      logger.error('HTTP request failed', error);
      if (!res.headersSent) reject(res, 500, 'Internal error');
    }
  };

  const server = createServer((req, res) => {
    handler(req, res).catch((error: unknown) => {
      logger.error('HTTP handler crashed', error);
      if (!res.headersSent) reject(res, 500, 'Internal error');
    });
  });
  // Slow-client protection.
  server.headersTimeout = 10_000;
  server.requestTimeout = 60_000;

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  boundPort = (server.address() as AddressInfo).port;
  const displayHost = config.host.includes(':') ? `[${config.host}]` : config.host;
  const url = `http://${displayHost}:${boundPort}${MCP_PATH}`;
  logger.info(`fse-mcp listening on ${url} (allowed hosts: ${config.hostnames.join(', ')})`);

  return {
    server,
    url,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/**
 * Constant-time token check. Both sides are hashed first so that `timingSafeEqual` always compares equal-length
 * buffers and the comparison time does not reveal the token length.
 */
export function isAuthorized(header: string | undefined, expectedDigest: Buffer): boolean {
  if (typeof header !== 'string') return false;
  const match = /^Bearer ([^\s]+)$/i.exec(header.trim());
  const presented = digest(match?.[1] ?? '');
  return timingSafeEqual(presented, expectedDigest) && match !== null;
}

/** Port-agnostic `Host` header check. */
export function isAllowedHost(hostHeader: string | undefined, allowed: readonly string[]): boolean {
  if (!hostHeader) return false;
  const hostname = hostnameOf(`http://${hostHeader}`);
  return hostname !== undefined && allowed.includes(hostname);
}

function isAllowedOrigin(origin: string, allowed: readonly string[]): boolean {
  const hostname = hostnameOf(origin);
  return hostname !== undefined && allowed.includes(hostname);
}

function hostnameOf(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password || (parsed.pathname !== '/' && parsed.pathname !== ''))
      return undefined;
    return parsed.hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * Fixed error bodies: request data is never echoed. The connection is closed because the request body may not
 * have been read, and a refused client gets no keep-alive socket to reuse.
 */
function reject(res: ServerResponse, status: number, message: string): void {
  res.statusCode = status;
  res.setHeader('Connection', 'close');
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }));
}
