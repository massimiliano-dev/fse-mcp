import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildSampleCda, SYNTHETIC_PATIENT_CF } from '../src/data/sample-cda.js';
import { CATALOGS_DIR_ENV, createFseValidator, type FseValidatorModule } from '../src/fse-validator.js';
import { MAX_ISSUE_MESSAGE_CHARS, MAX_VALIDATION_ISSUES } from '../src/limits.js';
import { REDACTED } from '../src/redact.js';

type FakeValidate = Awaited<ReturnType<FseValidatorModule['createFseXsdValidator']>>['validate'];

const FAKE_COMMIT = 'abcdef0123456789abcdef0123456789abcdef01';

class FakeUnsafeXmlError extends Error {}

function fakeModule(validate: FakeValidate): FseValidatorModule {
  return {
    FSE_CATALOGS_COMMIT: FAKE_COMMIT,
    UnsafeXmlError: FakeUnsafeXmlError,
    createFseXsdValidator: () => Promise.resolve({ validate }),
  };
}

const signal = () => new AbortController().signal;

describe('createFseValidator', () => {
  it('returns only the first issues and says so', async () => {
    const section = '<component><section><title foo="x">T</title></section></component>';
    const xml = buildSampleCda('referto_laboratorio').replace(
      '<structuredBody>',
      `<structuredBody>${section.repeat(MAX_VALIDATION_ISSUES + 10)}`,
    );
    const result = await createFseValidator().validate(xml, { signal: signal() });
    expect(result.status).toBe('invalid');
    expect(result.issues).toHaveLength(MAX_VALIDATION_ISSUES);
    expect(result.issues[0]).toMatchObject({ source: 'xsd', line: expect.any(Number) });
    expect(result.detail).toContain(`Only the first ${MAX_VALIDATION_ISSUES} XSD issues are returned.`);
  });

  it('redacts, truncates and keeps the rule id of every message', async () => {
    const message = `cvc-complex-type.2.4.a: Invalid content near ${SYNTHETIC_PATIENT_CF}. ${'x'.repeat(2_000)}`;
    const validator = createFseValidator({
      importModule: () =>
        Promise.resolve(
          fakeModule(() =>
            Promise.resolve({ valid: false, issues: [{ severity: 'error', message, line: 12 }] }),
          ),
        ),
    });
    const result = await validator.validate('<x/>', { signal: signal() });
    const [issue] = result.issues;
    expect(issue).toMatchObject({ source: 'xsd', ruleId: 'cvc-complex-type.2.4.a', line: 12 });
    expect(issue?.message).toHaveLength(MAX_ISSUE_MESSAGE_CHARS);
    expect(issue?.message).toContain(REDACTED);
    expect(issue?.message).not.toContain(SYNTHETIC_PATIENT_CF);
    expect(result.detail).toContain(`1 message(s) were cut at ${MAX_ISSUE_MESSAGE_CHARS} characters.`);
    expect(validator.name).toContain(`it-fse-catalogs ${FAKE_COMMIT.slice(0, 7)}`);
  });

  it('maps the package input guard to a refused document', async () => {
    const module = fakeModule(() =>
      Promise.reject(new FakeUnsafeXmlError('XML document is not valid UTF-8')),
    );
    const validator = createFseValidator({ importModule: () => Promise.resolve(module) });
    const result = await validator.validate('<x/>', { signal: signal() });
    expect(result).toMatchObject({
      status: 'invalid',
      valid: false,
      checks: { xsd: 'not_run_preflight_rejected' },
      issues: [{ source: 'preflight' }],
    });
  });

  it('reports missing catalogs without throwing or disclosing the path', async () => {
    const catalogsDir = join(tmpdir(), `fse-mcp-no-catalogs-${process.pid}`);
    const result = await createFseValidator({ catalogsDir }).validate(buildSampleCda('referto_laboratorio'), {
      signal: signal(),
    });
    expect(result).toMatchObject({
      status: 'validator_unavailable',
      valid: null,
      checks: { xsd: 'skipped_catalogs_missing', schematron: 'skipped_catalogs_missing' },
      issues: [],
    });
    expect(result.detail).toContain(CATALOGS_DIR_ENV);
    expect(result.detail).not.toContain(catalogsDir);
  });

  it('tells a broken install apart from a missing one', async () => {
    const result = await createFseValidator({
      importModule: () => Promise.reject(new SyntaxError('Unexpected token')),
    }).validate('<x/>', { signal: signal() });
    expect(result).toMatchObject({
      status: 'validator_unavailable',
      checks: { xsd: 'skipped_validator_missing' },
    });
    expect(result.detail).toMatch(/could not be loaded/);
  });

  it('loads the package once and retries after a failure', async () => {
    let imports = 0;
    let fail = true;
    const validator = createFseValidator({
      importModule: () => {
        imports++;
        if (fail)
          return Promise.reject(Object.assign(new Error('missing'), { code: 'ERR_MODULE_NOT_FOUND' }));
        return Promise.resolve(fakeModule(() => Promise.resolve({ valid: true, issues: [] })));
      },
    });
    expect((await validator.validate('<x/>', { signal: signal() })).status).toBe('validator_unavailable');
    fail = false;
    await Promise.all([1, 2, 3].map(() => validator.validate('<x/>', { signal: signal() })));
    expect((await validator.validate('<x/>', { signal: signal() })).status).toBe('valid');
    expect(imports).toBe(2);
  });

  it('rejects with the abort reason when the signal fires', async () => {
    const validator = createFseValidator({
      importModule: () => Promise.resolve(fakeModule(() => new Promise(() => {}))),
    });
    const controller = new AbortController();
    const pending = validator.validate('<x/>', { signal: controller.signal });
    const reason = new Error('timeout');
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    await expect(validator.validate('<x/>', { signal: AbortSignal.abort(reason) })).rejects.toBe(reason);
  });
});
