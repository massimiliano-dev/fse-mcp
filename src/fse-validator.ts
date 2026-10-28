/**
 * The default {@link CdaValidatorPort}: XSD validation with `@massimiliano-dev/fse-validator` (libxml2 compiled to
 * WebAssembly) against a local it-fse-catalogs checkout.
 *
 * The package is an optional peer dependency. It is loaded with a dynamic `import()` on the first validation, and
 * the loaded schema set is memoized. When the package or the catalogs are missing, `validate` resolves to
 * `validator_unavailable` with a detail on how to enable it instead of throwing; failures are not memoized, so
 * installing the package or syncing the catalogs takes effect without a restart.
 *
 * No network: xmllint runs with `--nonet` in an in-memory file system, the schemas are read from the local
 * checkout and `xsi:schemaLocation` is never followed. Schematron is not run yet.
 */
import { fileURLToPath } from 'node:url';
import { MAX_CDA_BYTES, MAX_ISSUE_MESSAGE_CHARS, MAX_VALIDATION_ISSUES } from './limits.js';
import { redact } from './redact.js';
import {
  type CdaValidationIssue,
  type CdaValidationResult,
  type CdaValidatorPort,
  unavailableValidator,
} from './validator-port.js';

export const CATALOGS_DIR_ENV = 'FSE_MCP_CATALOGS_DIR';

/**
 * Development default: the checkout made by `pnpm sync:catalogs` in a sibling fse-client clone. Resolved from this
 * file, which sits in `src/` or `dist/`, so `../..` is the folder that contains this repository.
 */
export const DEV_CATALOGS_DIR = fileURLToPath(
  new URL('../../fse-client/vendor/it-fse-catalogs', import.meta.url),
);

const PACKAGE_NAME = '@massimiliano-dev/fse-validator';

const SCHEMATRON_PENDING =
  'Schematron was not run: that level arrives in a later release, so the gateway may still reject the document.';

/** XSD rule identifiers in Xerces style. libxml2 does not print them today; they are kept if it ever does. */
const XSD_RULE_ID = /\bcvc-[A-Za-z0-9.-]*[A-Za-z0-9]/;

interface XsdValidatorLike {
  validate(xml: string): Promise<{
    valid: boolean;
    issues: readonly { severity: 'error' | 'warning'; message: string; line?: number }[];
  }>;
}

/**
 * The subset of `@massimiliano-dev/fse-validator` used here, typed locally so that the emitted declarations do
 * not depend on the optional package.
 */
export interface FseValidatorModule {
  FSE_CATALOGS_COMMIT: string;
  UnsafeXmlError: abstract new (...args: never[]) => Error;
  createFseXsdValidator(
    catalogsDir: string,
    options?: { maxIssues?: number; maxInputBytes?: number },
  ): Promise<XsdValidatorLike>;
}

export interface FseValidatorOptions {
  /** it-fse-catalogs checkout. Defaults to `FSE_MCP_CATALOGS_DIR`, then {@link DEV_CATALOGS_DIR}. */
  catalogsDir?: string;
  /** Loads the validator package. Replaced in tests to simulate a missing install. */
  importModule?: () => Promise<FseValidatorModule>;
}

type Loaded =
  | { ok: true; module: FseValidatorModule; xsd: XsdValidatorLike; commit: string }
  | { ok: false; missing: 'package'; loadFailed: boolean }
  | { ok: false; missing: 'catalogs'; commit: string };

/** Creates the default validator. Never throws: problems surface as `validator_unavailable` results. */
export function createFseValidator(options: FseValidatorOptions = {}): CdaValidatorPort {
  const catalogsDir = options.catalogsDir || process.env[CATALOGS_DIR_ENV] || DEV_CATALOGS_DIR;
  const importModule =
    options.importModule ?? (() => import('@massimiliano-dev/fse-validator') as Promise<FseValidatorModule>);

  let loading: Promise<Loaded> | undefined;
  let commit: string | undefined;
  const load = () => {
    loading ??= loadXsd(importModule, catalogsDir).then((loaded) => {
      if (loaded.ok) commit = loaded.commit;
      else loading = undefined;
      return loaded;
    });
    return loading;
  };

  return {
    get name() {
      return commit
        ? `${PACKAGE_NAME} (XSD, it-fse-catalogs ${commit.slice(0, 7)})`
        : `${PACKAGE_NAME} (XSD)`;
    },
    async validate(xml, { signal }) {
      const loaded = await abortable(load(), signal);
      if (!loaded.ok && loaded.missing === 'package') {
        const result = await unavailableValidator.validate(xml, { signal });
        if (loaded.loadFailed) {
          result.detail = `${PACKAGE_NAME} is installed but could not be loaded; reinstall it to enable XSD validation.`;
        }
        return result;
      }
      if (!loaded.ok) return catalogsMissing(loaded.commit);

      let raw: Awaited<ReturnType<XsdValidatorLike['validate']>>;
      try {
        raw = await abortable(loaded.xsd.validate(xml), signal);
      } catch (error) {
        // The package's own input guard (size, encoding, DTD). Its messages are fixed text, not document content.
        if (error instanceof loaded.module.UnsafeXmlError) return refusedByValidator(error.message);
        throw error;
      }

      let cutMessages = 0;
      const issues = raw.issues.slice(0, MAX_VALIDATION_ISSUES).map((issue): CdaValidationIssue => {
        // Redact before truncating, so a cut cannot leave half an identifier that the patterns no longer match.
        const redacted = redact(issue.message);
        const message = truncate(redacted, MAX_ISSUE_MESSAGE_CHARS);
        if (message !== redacted) cutMessages++;
        const ruleId = XSD_RULE_ID.exec(issue.message)?.[0];
        return {
          severity: issue.severity,
          source: 'xsd',
          ...(ruleId ? { ruleId } : {}),
          message,
          ...(issue.line === undefined ? {} : { line: issue.line }),
        };
      });

      const detail = [
        `XSD validation ${raw.valid ? 'passed' : 'failed'} (it-fse-catalogs ${loaded.commit.slice(0, 7)}).`,
      ];
      if (raw.issues.length > MAX_VALIDATION_ISSUES) {
        detail.push(`Only the first ${MAX_VALIDATION_ISSUES} XSD issues are returned.`);
      }
      if (cutMessages > 0) {
        detail.push(`${cutMessages} message(s) were cut at ${MAX_ISSUE_MESSAGE_CHARS} characters.`);
      }
      detail.push(SCHEMATRON_PENDING);

      return {
        status: raw.valid ? 'valid' : 'invalid',
        valid: raw.valid,
        checks: { xsd: 'run', schematron: 'skipped_schematron_missing' },
        issues,
        detail: detail.join(' '),
      };
    },
  };
}

async function loadXsd(
  importModule: () => Promise<FseValidatorModule>,
  catalogsDir: string,
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

/**
 * Settles with `promise`, or rejects with `signal.reason` as soon as the signal aborts. xmllint runs in a worker
 * that cannot be cancelled from here: an aborted run is abandoned and finishes within its memory ceiling.
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
