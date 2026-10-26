import { request } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpConfigError, resolveHttpOptions, type RunningHttpServer, startHttpServer } from '../src/http.js';
import { createFseMcpServer } from '../src/server.js';

const TOKEN = 'test-token-0123456789abcdef0123456789abcdef';
const SMALL_BODY_LIMIT = 64 * 1024;

const INIT = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '0' } },
};

let running: RunningHttpServer;
let port: number;

beforeAll(async () => {
  running = await startHttpServer({
    createMcpServer: () => createFseMcpServer(),
    token: TOKEN,
    port: 0,
    maxBodyBytes: SMALL_BODY_LIMIT,
  });
  port = Number(new URL(running.url).port);
});
afterAll(() => running.close());

/** Raw request with full control over headers, including Host. */
function send(options: { method?: string; headers?: Record<string, string>; body?: string; path?: string }) {
  return new Promise<{ status: number; body: string; headers: Record<string, unknown> }>(
    (resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port,
          method: options.method ?? 'POST',
          path: options.path ?? '/mcp',
          headers: {
            host: `127.0.0.1:${port}`,
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            ...options.headers,
          },
        },
        (res) => {
          let body = '';
          res.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
        },
      );
      req.on('error', reject);
      req.end(options.body ?? JSON.stringify(INIT));
    },
  );
}

describe('HTTP transport', () => {
  it('binds to loopback by default', () => {
    expect(running.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  });

  it('refuses requests without a token', async () => {
    const res = await send({});
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toBe('Bearer');
  });

  it('refuses a wrong token, a token with a different length and a non-bearer scheme', async () => {
    for (const authorization of [`Bearer ${TOKEN.slice(0, -1)}x`, 'Bearer short', `Basic ${TOKEN}`, TOKEN]) {
      expect((await send({ headers: { authorization } })).status).toBe(401);
    }
  });

  it('refuses a Host header that is not allowed (DNS rebinding), before checking the token', async () => {
    const res = await send({ headers: { host: `evil.example:${port}`, authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(403);
    expect(res.body).not.toContain('evil.example');
  });

  it('refuses a cross-site Origin', async () => {
    const res = await send({ headers: { origin: 'http://evil.example', authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(403);
  });

  it('accepts a valid request and sends no CORS headers', async () => {
    const res = await send({ headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ result: { serverInfo: { name: 'fse-mcp' } } });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('accepts localhost as Host', async () => {
    const res = await send({ headers: { host: `localhost:${port}`, authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(200);
  });

  it('enforces the body size limit', async () => {
    const body = JSON.stringify({ ...INIT, padding: 'x'.repeat(SMALL_BODY_LIMIT) });
    const res = await send({ headers: { authorization: `Bearer ${TOKEN}` }, body });
    expect(res.status).toBe(413);
  });

  it('enforces the body size limit on chunked bodies without Content-Length', async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: '/mcp',
          headers: {
            host: `127.0.0.1:${port}`,
            authorization: `Bearer ${TOKEN}`,
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            'transfer-encoding': 'chunked',
          },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      for (let i = 0; i < 4; i++) req.write('x'.repeat(SMALL_BODY_LIMIT / 2));
      req.end();
    });
    expect(status).toBe(413);
  });

  it('rejects GET (no standalone SSE stream in stateless mode) and unknown paths', async () => {
    expect((await send({ method: 'GET', headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(405);
    expect((await send({ path: '/other', headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(404);
  });

  it('works end to end with the SDK client', async () => {
    const client = new Client({ name: 'http-test', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(running.url), {
      requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
    });
    await client.connect(transport);
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(4);
    const result = await client.callTool({
      name: 'lookup_code',
      arguments: { system: 'LOINC', query: '718-7' },
    });
    expect(result.structuredContent).toMatchObject({ results: [{ code: '718-7' }] });
    await client.close();
  });
});

describe('HTTP configuration', () => {
  const createMcpServer = () => createFseMcpServer();

  it('refuses to start without a token or with a short one', async () => {
    await expect(startHttpServer({ createMcpServer, token: '', port: 0 })).rejects.toBeInstanceOf(
      HttpConfigError,
    );
    expect(() => resolveHttpOptions({ createMcpServer, token: 'short' })).toThrow(HttpConfigError);
    expect(() => resolveHttpOptions({ createMcpServer, token: `${TOKEN} x` })).toThrow(HttpConfigError);
  });

  it('refuses a non-loopback bind without an explicit allowed host', () => {
    expect(() => resolveHttpOptions({ createMcpServer, token: TOKEN, host: '0.0.0.0' })).toThrow(
      /allowed-host/,
    );
    expect(
      resolveHttpOptions({
        createMcpServer,
        token: TOKEN,
        host: '0.0.0.0',
        allowedHostnames: ['mcp.example'],
      }).hostnames,
    ).toEqual(['mcp.example']);
  });
});
