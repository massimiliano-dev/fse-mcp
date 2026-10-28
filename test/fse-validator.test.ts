import { mkdir, mkdtemp, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSampleCda, SYNTHETIC_PATIENT_CF } from '../src/data/sample-cda.js';
import {
  CATALOGS_DIR_ENV,
  createFseValidator,
  DEV_SCHEMATRON_DIR,
  type FseValidatorModule,
  SCHEMATRON_DIR_ENV,
} from '../src/fse-validator.js';
import { MAX_ISSUE_MESSAGE_CHARS, MAX_SEF_BYTES, MAX_VALIDATION_ISSUES } from '../src/limits.js';
import { REDACTED } from '../src/redact.js';

type FakeValidate = Awaited<ReturnType<FseValidatorModule['createFseXsdValidator']>>['validate'];

const FAKE_COMMIT = 'abcdef0123456789abcdef0123456789abcdef01';

class FakeUnsafeXmlError extends Error {}

const LAB_SEF = 'schematronFSE_LAB_v27.1.sef.json';

/** A fake package: `validate` is the XSD level; the header says referto di laboratorio unless overridden. */
function fakeModule(validate: FakeValidate, overrides: Partial<FseValidatorModule> = {}): FseValidatorModule {
  return {
    FSE_CATALOGS_COMMIT: FAKE_COMMIT,
    UnsafeXmlError: FakeUnsafeXmlError,
    createFseXsdValidator: () => Promise.resolve({ validate }),
    extractCdaHeader: () =>
      Promise.resolve({ documentTypeCode: '11502-2', documentTypeCodeSystem: '2.16.840.1.113883.6.1' }),
    SaxonSchematronValidator: class {
      validate() {
        return Promise.resolve({ valid: true, issues: [] });
      }
    },
    ...overrides,
  };
}

const xsdPasses: FakeValidate = () => Promise.resolve({ valid: true, issues: [] });
const signal = () => new AbortController().signal;

let scratch: string;
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'fse-mcp-test-'));
});
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

/** A schematron folder holding `files` (name to contents) under the scratch directory. */
async function sefDir(name: string, files: Record<string, string>): Promise<string> {
  const dir = join(scratch, name);
  await mkdir(dir);
  for (const [file, contents] of Object.entries(files)) await writeFile(join(dir, file), contents);
  return dir;
}

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
    expect(result.detail).toContain(`1 XSD message(s) were cut at ${MAX_ISSUE_MESSAGE_CHARS} characters.`);
    expect(result.checks.schematron).toBe('not_run_xsd_failed');
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

  it('maps schematron issues with rule id, location and severity, redacted and capped', async () => {
    const issues = [
      {
        severity: 'error' as const,
        message: `ERRORE-28| Il codice fiscale ${SYNTHETIC_PATIENT_CF} non corrisponde`,
        location: '/Q{urn:hl7-org:v3}ClinicalDocument[1]/Q{urn:hl7-org:v3}legalAuthenticator[1]',
      },
      { severity: 'warning' as const, message: 'W002 | Attenzione' },
      { severity: 'error' as const, message: 'Messaggio senza prefisso' },
      ...Array.from({ length: MAX_VALIDATION_ISSUES }, () => ({
        severity: 'error' as const,
        message: 'ERRORE-1| x',
      })),
    ];
    let sefSeen: string | undefined;
    const module = fakeModule(xsdPasses, {
      SaxonSchematronValidator: class {
        constructor(options: { sef: string }) {
          sefSeen = options.sef;
        }
        validate() {
          return Promise.resolve({ valid: false, issues });
        }
      },
    });
    const validator = createFseValidator({
      importModule: () => Promise.resolve(module),
      importSaxon: () => Promise.resolve({}),
      schematronDir: await sefDir('mapping', { [LAB_SEF]: '{"fake":true}' }),
    });
    const result = await validator.validate('<x/>', { signal: signal() });
    expect(sefSeen).toBe('{"fake":true}');
    expect(result).toMatchObject({
      status: 'invalid',
      valid: false,
      documentType: 'referto_laboratorio',
      schematron: 'schematronFSE_LAB_v27.1.sch',
      checks: { xsd: 'run', schematron: 'run' },
    });
    expect(result.issues).toHaveLength(MAX_VALIDATION_ISSUES);
    expect(result.issues[0]).toMatchObject({
      source: 'schematron',
      severity: 'error',
      ruleId: 'ERRORE-28',
      location: '/Q{urn:hl7-org:v3}ClinicalDocument[1]/Q{urn:hl7-org:v3}legalAuthenticator[1]',
    });
    expect(result.issues[0]?.message).toContain(REDACTED);
    expect(result.issues[0]?.message).not.toContain(SYNTHETIC_PATIENT_CF);
    expect(result.issues[1]).toMatchObject({ severity: 'warning', ruleId: 'W002' });
    expect(result.issues[2]).not.toHaveProperty('ruleId');
    expect(result.detail).toContain(`failed with more than ${MAX_VALIDATION_ISSUES} issue(s).`);
    expect(result.detail).toContain(
      `Only the first ${MAX_VALIDATION_ISSUES} schematron issues are returned.`,
    );
  });

  it('skips schematron for an unrecognised document type instead of guessing', async () => {
    let schematronBuilt = false;
    const headers = [
      { documentTypeCode: '11488-4', documentTypeCodeSystem: '2.16.840.1.113883.6.1' },
      // The LAB code under another code system is not a LAB report.
      { documentTypeCode: '11502-2', documentTypeCodeSystem: '2.16.840.1.113883.6.96' },
      { documentTypeCode: undefined, documentTypeCodeSystem: undefined },
    ];
    for (const header of headers) {
      const module = fakeModule(xsdPasses, {
        extractCdaHeader: () => Promise.resolve(header),
        SaxonSchematronValidator: class {
          constructor() {
            schematronBuilt = true;
          }
          validate() {
            return Promise.resolve({ valid: true, issues: [] });
          }
        },
      });
      const result = await createFseValidator({
        importModule: () => Promise.resolve(module),
        importSaxon: () => Promise.resolve({}),
      }).validate('<x/>', { signal: signal() });
      expect(result).toMatchObject({
        status: 'valid',
        valid: true,
        checks: { xsd: 'run', schematron: 'skipped_unknown_document_type' },
      });
      expect(result).not.toHaveProperty('documentType');
    }
    expect(schematronBuilt).toBe(false);
  });

  it('recognises the type from the real header and skips when its SEF is missing', async () => {
    const result = await createFseValidator().validate(buildSampleCda('lettera_dimissione'), {
      signal: signal(),
    });
    expect(result).toMatchObject({
      status: 'valid',
      valid: true,
      documentType: 'lettera_dimissione',
      checks: { xsd: 'run', schematron: 'skipped_schematron_missing' },
    });
    expect(result).not.toHaveProperty('schematron');
    expect(result.detail).toContain(
      `no compiled schematronFSE_LDO_v5.5.sef.json for lettera_dimissione in ${SCHEMATRON_DIR_ENV}`,
    );
    expect(result.detail).not.toContain(DEV_SCHEMATRON_DIR);
  });

  it('refuses a SEF over the size limit or behind a symlink', async () => {
    const tooLarge = await sefDir('too-large', { [LAB_SEF]: '' });
    await truncate(join(tooLarge, LAB_SEF), MAX_SEF_BYTES + 1);
    const linked = await sefDir('linked', { 'target.json': '{}' });
    await symlink(join(linked, 'target.json'), join(linked, LAB_SEF));

    for (const [schematronDir, detail] of [
      [tooLarge, `exceeds ${MAX_SEF_BYTES} bytes`],
      [linked, 'no compiled'],
    ] as const) {
      const result = await createFseValidator({
        importModule: () => Promise.resolve(fakeModule(xsdPasses)),
        importSaxon: () => Promise.resolve({}),
        schematronDir,
      }).validate('<x/>', { signal: signal() });
      expect(result.checks.schematron).toBe('skipped_schematron_missing');
      expect(result.detail).toContain(detail);
    }
  });

  it('skips schematron when saxon-js is missing and names its licence', async () => {
    const result = await createFseValidator({
      importSaxon: () =>
        Promise.reject(Object.assign(new Error('missing'), { code: 'ERR_MODULE_NOT_FOUND' })),
    }).validate(buildSampleCda('referto_laboratorio'), { signal: signal() });
    expect(result).toMatchObject({
      status: 'valid',
      valid: true,
      documentType: 'referto_laboratorio',
      checks: { xsd: 'run', schematron: 'skipped_saxon_missing' },
    });
    expect(result.detail).toMatch(/saxon-js.*proprietary Saxonica licence/);
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
