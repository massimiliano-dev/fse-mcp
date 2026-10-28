/**
 * The default {@link CdaValidatorPort}: `@massimiliano-dev/fse-validator` against local copies of the official
 * rules. XSD runs with libxml2 compiled to WebAssembly; schematron runs with SaxonJS on a precompiled SEF.
 *
 * Levels run in the gateway's order: XSD first, schematron only when the XSD passes. The schematron is chosen
 * from the LOINC code in `ClinicalDocument/code`, with the document types of `data/sample-cda.ts`.
 *
 * Both packages are optional peer dependencies loaded with a dynamic `import()` on the first validation.
 * `saxon-js` has a proprietary Saxonica licence, so it is never installed by default. Whatever is missing (the
 * validator, the catalogs, a compiled schematron, saxon-js) resolves to a result that says which level was
 * skipped and how to enable it, instead of throwing. Loads are memoized once they succeed; failures are retried,
 * so installing a package or adding a file takes effect without a restart.
 *
 * No network: xmllint runs with `--nonet` in an in-memory file system, schemas and SEFs are read from local
 * folders, `xsi:schemaLocation` is never followed, and the SEF only calls `document()` when its
 * `initial-document-uri` parameter is set, which this module never does.
 */
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOCUMENT_TYPE_SPECS, SAMPLE_DOCUMENT_TYPES, type SampleDocumentType } from './data/sample-cda.js';
import { MAX_CDA_BYTES, MAX_ISSUE_MESSAGE_CHARS, MAX_SEF_BYTES, MAX_VALIDATION_ISSUES } from './limits.js';
import { redact } from './redact.js';
import {
  type CdaCheckState,
  type CdaValidationIssue,
  type CdaValidationResult,
  type CdaValidatorPort,
  unavailableValidator,
} from './validator-port.js';

export const CATALOGS_DIR_ENV = 'FSE_MCP_CATALOGS_DIR';
export const SCHEMATRON_DIR_ENV = 'FSE_MCP_SCHEMATRON_DIR';

/**
 * Development defaults: the folders filled by `pnpm sync:catalogs` and `pnpm compile:schematron` in a sibling
 * fse-client clone. Resolved from this file, which sits in `src/` or `dist/`, so `../..` is the folder that
 * contains this repository.
 */
export const DEV_CATALOGS_DIR = fileURLToPath(
  new URL('../../fse-client/vendor/it-fse-catalogs', import.meta.url),
);
export const DEV_SCHEMATRON_DIR = fileURLToPath(
  new URL('../../fse-client/vendor/schematron-sef', import.meta.url),
);

const PACKAGE_NAME = '@massimiliano-dev/fse-validator';
const LOINC_OID = '2.16.840.1.113883.6.1';

const SAXON_MISSING =
  'Schematron was not run: it needs the optional saxon-js package, which is not installed by default because ' +
  'it has a proprietary Saxonica licence. Review the licence and install saxon-js@^2.7.0 to enable this level.';

/** XSD rule identifiers in Xerces style. libxml2 does not print them today; they are kept if it ever does. */
const XSD_RULE_ID = /\bcvc-[A-Za-z0-9.-]*[A-Za-z0-9]/;

/**
 * The rule prefix of the official schematron messages, before the `|`. The files are not consistent
 * (`ERRORE-28`, `ERORE-b12`, `ERROR-49`, `ERRORE 8`, `ERRORE-b1.1`, `W002 `), so it is kept as written, trimmed.
 * Bounded and without nested repetition, so it runs in linear time. Matches every prefixed message of the
 * catalogs at the pinned commit; one message in schematron_PrS_v2.7 has no `|` and gets no rule id.
 */
const SCHEMATRON_RULE_ID = /^\s*([A-Za-z]{1,10}[- ]?[A-Za-z]?\d[A-Za-z0-9.]{0,6})\s*\|/;

interface RawIssue {
  severity: 'error' | 'warning';
  message: string;
  line?: number;
  location?: string;
}

interface CheckerLike {
  validate(xml: string): Promise<{ valid: boolean; issues: readonly RawIssue[] }>;
}

/**
 * The subset of `@massimiliano-dev/fse-validator` used here, typed locally so that the emitted declarations do
 * not depend on the optional package.
 */
export interface FseValidatorModule {
  FSE_CATALOGS_COMMIT: string;
  /** Catalogs shipped inside the published package (since 0.1.0). */
  bundledCatalogsDir?: () => string;
  /** Compiled schematrons shipped inside the published package (since 0.1.0). */
  bundledSchematronSefDir?: () => string;
  UnsafeXmlError: abstract new (...args: never[]) => Error;
  createFseXsdValidator(
    catalogsDir: string,
    options?: { maxIssues?: number; maxInputBytes?: number },
  ): Promise<CheckerLike>;
  /** Only the document type is read; the patient fiscal code it also returns is never touched. */
  extractCdaHeader(
    xml: string,
    options?: { maxInputBytes?: number },
  ): Promise<{ documentTypeCode: string | undefined; documentTypeCodeSystem: string | undefined }>;
  SaxonSchematronValidator: new (options: {
    schematronName: string;
    sef: string;
    maxInputBytes?: number;
    loadSaxon?: () => Promise<object>;
  }) => CheckerLike;
}

export interface FseValidatorOptions {
  /**
   * it-fse-catalogs checkout. Defaults to `FSE_MCP_CATALOGS_DIR`, then to the catalogs bundled in
   * `@massimiliano-dev/fse-validator`, then to {@link DEV_CATALOGS_DIR}.
   */
  catalogsDir?: string;
  /**
   * Folder of compiled schematrons (`<name>.sef.json`). Defaults to `FSE_MCP_SCHEMATRON_DIR`, then to the
   * folder bundled in `@massimiliano-dev/fse-validator`, then to {@link DEV_SCHEMATRON_DIR}.
   */
  schematronDir?: string;
  /** Loads the validator package. Replaced in tests to simulate a missing install. */
  importModule?: () => Promise<FseValidatorModule>;
  /** Loads saxon-js. Replaced in tests to simulate a missing install. */
  importSaxon?: () => Promise<object>;
}

type Loaded =
  | { ok: true; module: FseValidatorModule; xsd: CheckerLike; commit: string }
  | { ok: false; missing: 'package'; loadFailed: boolean }
  | { ok: false; missing: 'catalogs'; commit: string };

type SefLoaded = { ok: true; sef: string } | { ok: false; tooLarge: boolean };
type SaxonLoaded = { ok: true; saxon: object } | { ok: false };

interface LevelOutcome {
  state: CdaCheckState;
  valid?: boolean;
  issues: CdaValidationIssue[];
  documentType?: SampleDocumentType;
  schematron?: string;
  detail: string[];
}

/** Creates the default validator. Never throws for missing pieces: they surface as skipped levels. */
export function createFseValidator(options: FseValidatorOptions = {}): CdaValidatorPort {
  // Resolved lazily: without an explicit folder the catalogs bundled in the validator package win, and they
  // are only known once that package is loaded.
  const explicitCatalogsDir = options.catalogsDir || process.env[CATALOGS_DIR_ENV];
  const explicitSchematronDir = options.schematronDir || process.env[SCHEMATRON_DIR_ENV];
  const importModule =
    options.importModule ?? (() => import('@massimiliano-dev/fse-validator') as Promise<FseValidatorModule>);
  const importSaxon = options.importSaxon ?? importSaxonJs;

  let commit: string | undefined;
  const loadXsd = retryUntilOk(async () => {
    const loaded = await loadXsdValidator(importModule, explicitCatalogsDir);
    if (loaded.ok) commit = loaded.commit;
    return loaded;
  });
  const loadSaxon = retryUntilOk((): Promise<SaxonLoaded> =>
    importSaxon().then(
      (saxon) => ({ ok: true, saxon }),
      () => ({ ok: false }),
    ),
  );
  const sefLoaders = new Map<string, () => Promise<SefLoaded>>();
  const schematrons = new Map<string, CheckerLike>();

  async function runSchematron(
    module: FseValidatorModule,
    xml: string,
    signal: AbortSignal,
  ): Promise<LevelOutcome> {
    const header = await abortable(module.extractCdaHeader(xml, { maxInputBytes: MAX_CDA_BYTES }), signal);
    const documentType = documentTypeFor(header.documentTypeCode, header.documentTypeCodeSystem);
    if (!documentType) {
      return {
        state: 'skipped_unknown_document_type',
        issues: [],
        detail: [
          'Schematron was not run: ClinicalDocument/code is not the LOINC code of a supported document type ' +
            `(${SAMPLE_DOCUMENT_TYPES.join(', ')}).`,
        ],
      };
    }
    const schematron = DOCUMENT_TYPE_SPECS[documentType].schematron;
    const sefFile = schematron.replace(/\.sch$/, '.sef.json');

    const schematronDir = explicitSchematronDir ?? module.bundledSchematronSefDir?.() ?? DEV_SCHEMATRON_DIR;
    const sefPath = join(schematronDir, sefFile);
    let loadSef = sefLoaders.get(sefPath);
    if (!loadSef) {
      loadSef = retryUntilOk(() => readSef(sefPath));
      sefLoaders.set(sefPath, loadSef);
    }
    const sef = await abortable(loadSef(), signal);
    if (!sef.ok) {
      return {
        state: 'skipped_schematron_missing',
        documentType,
        issues: [],
        detail: [
          sef.tooLarge
            ? `Schematron was not run: ${sefFile} exceeds ${MAX_SEF_BYTES} bytes.`
            : `Schematron was not run: no compiled ${sefFile} for ${documentType} in ${SCHEMATRON_DIR_ENV} ` +
              '(pnpm compile:schematron in fse-client).',
        ],
      };
    }

    const saxon = await abortable(loadSaxon(), signal);
    if (!saxon.ok)
      return { state: 'skipped_saxon_missing', documentType, issues: [], detail: [SAXON_MISSING] };

    let checker = schematrons.get(sefFile);
    if (!checker) {
      checker = new module.SaxonSchematronValidator({
        schematronName: schematron,
        sef: sef.sef,
        maxInputBytes: MAX_CDA_BYTES,
        loadSaxon: () => Promise.resolve(saxon.saxon),
      });
      schematrons.set(sefFile, checker);
    }
    const raw = await abortable(checker.validate(xml), signal);
    const level = boundIssues(raw.issues, 'schematron');
    const count =
      raw.issues.length > MAX_VALIDATION_ISSUES
        ? `more than ${MAX_VALIDATION_ISSUES}`
        : `${raw.issues.length}`;
    return {
      state: 'run',
      valid: raw.valid,
      documentType,
      schematron,
      issues: level.issues,
      detail: [
        raw.valid
          ? `Schematron ${schematron} passed.`
          : `Schematron ${schematron} failed with ${count} issue(s).`,
        ...level.notes,
      ],
    };
  }

  return {
    get name() {
      return commit ? `${PACKAGE_NAME} (it-fse-catalogs ${commit.slice(0, 7)})` : PACKAGE_NAME;
    },
    async validate(xml, { signal }) {
      const loaded = await abortable(loadXsd(), signal);
      if (!loaded.ok && loaded.missing === 'package') {
        const result = await unavailableValidator.validate(xml, { signal });
        if (loaded.loadFailed) {
          result.detail = `${PACKAGE_NAME} is installed but could not be loaded; reinstall it to enable validation.`;
        }
        return result;
      }
      if (!loaded.ok) return catalogsMissing(loaded.commit);

      let raw: Awaited<ReturnType<CheckerLike['validate']>>;
      try {
        raw = await abortable(loaded.xsd.validate(xml), signal);
      } catch (error) {
        // The package's own input guard (size, encoding, DTD). Its messages are fixed text, not document content.
        if (error instanceof loaded.module.UnsafeXmlError) return refusedByValidator(error.message);
        throw error;
      }
      const xsd = boundIssues(raw.issues, 'xsd');

      // The gateway stops at the first failing level.
      const schematron: LevelOutcome = raw.valid
        ? await runSchematron(loaded.module, xml, signal)
        : {
            state: 'not_run_xsd_failed',
            issues: [],
            detail: ['Schematron was not run because the XSD failed, as on the gateway.'],
          };

      const valid = raw.valid && schematron.valid !== false;
      return {
        status: valid ? 'valid' : 'invalid',
        valid,
        ...(schematron.documentType ? { documentType: schematron.documentType } : {}),
        ...(schematron.schematron ? { schematron: schematron.schematron } : {}),
        checks: { xsd: 'run', schematron: schematron.state },
        issues: [...xsd.issues, ...schematron.issues],
        detail: [
          `XSD validation ${raw.valid ? 'passed' : 'failed'} (it-fse-catalogs ${loaded.commit.slice(0, 7)}).`,
          ...xsd.notes,
          ...schematron.detail,
        ].join(' '),
      };
    },
  };
}

/** Caps, redacts and truncates the issues of one level, and says what was cut. */
function boundIssues(
  raw: readonly RawIssue[],
  source: 'xsd' | 'schematron',
): { issues: CdaValidationIssue[]; notes: string[] } {
  let cutMessages = 0;
  const issues = raw.slice(0, MAX_VALIDATION_ISSUES).map((issue): CdaValidationIssue => {
    // Redact before truncating, so a cut cannot leave half an identifier that the patterns no longer match.
    const redacted = redact(issue.message);
    const message = truncate(redacted, MAX_ISSUE_MESSAGE_CHARS);
    if (message !== redacted) cutMessages++;
    const ruleId =
      source === 'xsd' ? XSD_RULE_ID.exec(issue.message)?.[0] : SCHEMATRON_RULE_ID.exec(issue.message)?.[1];
    return {
      severity: issue.severity,
      source,
      ...(ruleId ? { ruleId } : {}),
      message,
      ...(issue.line === undefined ? {} : { line: issue.line }),
      ...(issue.location ? { location: truncate(issue.location, MAX_ISSUE_MESSAGE_CHARS) } : {}),
    };
  });
  const label = source === 'xsd' ? 'XSD' : 'schematron';
  const notes: string[] = [];
  if (raw.length > MAX_VALIDATION_ISSUES)
    notes.push(`Only the first ${MAX_VALIDATION_ISSUES} ${label} issues are returned.`);
  if (cutMessages > 0) {
    notes.push(`${cutMessages} ${label} message(s) were cut at ${MAX_ISSUE_MESSAGE_CHARS} characters.`);
  }
  return { issues, notes };
}

/** The document type whose LOINC code is in the header, or `undefined`: no guess from anything else. */
function documentTypeFor(
  code: string | undefined,
  codeSystem: string | undefined,
): SampleDocumentType | undefined {
  if (codeSystem !== LOINC_OID) return undefined;
  return SAMPLE_DOCUMENT_TYPES.find((type) => DOCUMENT_TYPE_SPECS[type].loinc === code);
}

async function loadXsdValidator(
  importModule: () => Promise<FseValidatorModule>,
  explicitCatalogsDir: string | undefined,
): Promise<Loaded> {
  let module: FseValidatorModule;
  try {
    module = await importModule();
  } catch (error) {
    return {
      ok: false,
      missing: 'package',
      loadFailed: (error as { code?: unknown }).code !== 'ERR_MODULE_NOT_FOUND',
    };
  }
  const catalogsDir = explicitCatalogsDir ?? module.bundledCatalogsDir?.() ?? DEV_CATALOGS_DIR;
  try {
    // One more issue than returned, so that truncation can be detected and reported.
    const xsd = await module.createFseXsdValidator(catalogsDir, {
      maxIssues: MAX_VALIDATION_ISSUES + 1,
      maxInputBytes: MAX_CDA_BYTES,
    });
    return { ok: true, module, xsd, commit: module.FSE_CATALOGS_COMMIT };
  } catch {
    return { ok: false, missing: 'catalogs', commit: module.FSE_CATALOGS_COMMIT };
  }
}

/**
 * Loads saxon-js from this package's dependencies. It is not resolved through the validator package, whose own
 * development copy would hide a missing install here. Variable specifier: saxon-js is optional and has no types.
 */
async function importSaxonJs(): Promise<object> {
  const specifier = 'saxon-js';
  const mod = (await import(specifier)) as { default?: object };
  return mod.default ?? mod;
}

/** Reads a compiled schematron: a regular file, not followed through a symlink, at most {@link MAX_SEF_BYTES}. */
async function readSef(path: string): Promise<SefLoaded> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch {
    return { ok: false, tooLarge: false };
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return { ok: false, tooLarge: false };
    if (stat.size > MAX_SEF_BYTES) return { ok: false, tooLarge: true };
    const sef = await handle.readFile({ encoding: 'utf8' });
    // The file can grow between stat and read.
    if (Buffer.byteLength(sef, 'utf8') > MAX_SEF_BYTES) return { ok: false, tooLarge: true };
    return { ok: true, sef };
  } finally {
    await handle.close();
  }
}

/** The package's error names local paths; the client only needs to know what to fix. */
function catalogsMissing(commit: string): CdaValidationResult {
  return {
    status: 'validator_unavailable',
    valid: null,
    checks: { xsd: 'skipped_catalogs_missing', schematron: 'skipped_catalogs_missing' },
    issues: [],
    detail:
      `No usable it-fse-catalogs checkout at commit ${commit.slice(0, 7)}: set ${CATALOGS_DIR_ENV} to a checkout ` +
      'that contains the .fse-catalogs-commit marker (pnpm sync:catalogs in fse-client).',
  };
}

function refusedByValidator(message: string): CdaValidationResult {
  return {
    status: 'invalid',
    valid: false,
    checks: { xsd: 'not_run_preflight_rejected', schematron: 'not_run_preflight_rejected' },
    issues: [
      { severity: 'error', source: 'preflight', message: truncate(redact(message), MAX_ISSUE_MESSAGE_CHARS) },
    ],
    detail: 'The validator refused the document before parsing it.',
  };
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Memoizes `load` while its outcome is ok; a failed outcome or an exception is retried on the next call. */
function retryUntilOk<T extends { ok: boolean }>(load: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined;
  return () => {
    pending ??= load().then(
      (outcome) => {
        if (!outcome.ok) pending = undefined;
        return outcome;
      },
      (error: unknown) => {
        pending = undefined;
        throw error;
      },
    );
    return pending;
  };
}

/**
 * Settles with `promise`, or rejects with `signal.reason` as soon as the signal aborts. Neither xmllint (a
 * worker) nor SaxonJS can be cancelled from here: an aborted run is abandoned and finishes on its own.
 */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason as Error);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason as Error);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error as Error);
      },
    );
  });
}
