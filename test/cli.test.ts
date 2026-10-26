import { describe, expect, it } from 'vitest';
import { main, parseCliArgs, TOKEN_ENV } from '../src/cli.js';

describe('parseCliArgs', () => {
  it('defaults to stdio on loopback', () => {
    expect(parseCliArgs([])).toMatchObject({
      mode: 'stdio',
      host: '127.0.0.1',
      port: 3333,
      allowedHosts: [],
    });
  });

  it('parses HTTP options', () => {
    expect(
      parseCliArgs([
        '--http',
        '--port',
        '8080',
        '--allowed-host',
        'a.example',
        '--allowed-host',
        'b.example',
      ]),
    ).toMatchObject({ mode: 'http', port: 8080, allowedHosts: ['a.example', 'b.example'] });
  });

  it('rejects unknown options, positionals and bad values', () => {
    expect(() => parseCliArgs(['--token', 'x'])).toThrow();
    expect(() => parseCliArgs(['file.xml'])).toThrow();
    expect(() => parseCliArgs(['--port', '99999'])).toThrow();
    expect(() => parseCliArgs(['--log-level', 'trace'])).toThrow();
  });
});

describe('main', () => {
  it('refuses to start HTTP mode without a token', async () => {
    const out: string[] = [];
    const code = await main(['--http', '--port', '0'], {}, { write: (c: string) => out.push(c) });
    expect(code).toBe(1);
    expect(out.join('')).toContain(TOKEN_ENV);
  });

  it('removes the token from the environment and never prints it', async () => {
    const token = 'short-but-secret-token';
    const env: NodeJS.ProcessEnv = { [TOKEN_ENV]: token };
    const out: string[] = [];
    const code = await main(['--http', '--port', '0'], env, { write: (c: string) => out.push(c) });
    expect(code).toBe(1);
    expect(env[TOKEN_ENV]).toBeUndefined();
    expect(out.join('')).not.toContain(token);
  });
});
