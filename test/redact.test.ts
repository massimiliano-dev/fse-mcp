import { describe, expect, it } from 'vitest';
import { createLogger } from '../src/log.js';
import { createRedactor, REDACTED } from '../src/redact.js';

describe('redact', () => {
  const r = createRedactor();

  it('redacts codice fiscale in any case, including omocodia', () => {
    expect(r.redact('patient SNTPNT80A01H501D admitted')).toBe(`patient ${REDACTED} admitted`);
    expect(r.redact('cf=sntpnt80a01h501d')).toBe(`cf=${REDACTED}`);
    expect(r.redact('SNTPNT80A01H5LMD')).toBe(REDACTED);
  });

  it('redacts STP and ENI codes', () => {
    expect(r.redact('STP1234567890123 and ENI1234567890123')).toBe(`${REDACTED} and ${REDACTED}`);
  });

  it('redacts JWT-looking strings and bearer tokens', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl';
    expect(r.redact(`token ${jwt} end`)).toBe(`token ${REDACTED} end`);
    expect(r.redact('Authorization: Bearer abc.def-123')).toBe(`Authorization: Bearer ${REDACTED}`);
  });

  it('redacts registered secrets', () => {
    const local = createRedactor();
    local.addSecret('super-secret-value-1234');
    expect(local.redact('x super-secret-value-1234 y')).toBe(`x ${REDACTED} y`);
  });

  it('leaves ordinary text, codes and OIDs alone', () => {
    const text = 'ERRORE-5 code 11502-2 root 2.16.840.1.113883.2.9.4.3.2 LOINC';
    expect(r.redact(text)).toBe(text);
  });
});

describe('logger', () => {
  it('writes redacted JSON lines to the given stream only', () => {
    const lines: string[] = [];
    const logger = createLogger({ stream: { write: (c: string) => lines.push(c) } });
    logger.info('patient SNTPNT80A01H501D', new Error('Bearer abcdef123456'));
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0] ?? '') as Record<string, string>;
    expect(entry.msg).toBe(`patient ${REDACTED}`);
    expect(entry.detail).toBe(`Error: Bearer ${REDACTED}`);
  });

  it('respects the level and truncates long lines', () => {
    const lines: string[] = [];
    const logger = createLogger({ level: 'warn', stream: { write: (c: string) => lines.push(c) } });
    logger.info('hidden');
    logger.warn('x'.repeat(10_000));
    expect(lines).toHaveLength(1);
    expect(lines[0]!.length).toBeLessThan(2_100);
  });
});
