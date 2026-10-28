/**
 * The boundary between this MCP server and the real CDA2 validator.
 *
 * `createFseValidator` in `fse-validator.ts` is the implementation used by default; this module only holds the
 * contract, so that embedders can inject their own and the tool stays testable without a catalogs checkout.
 *
 * Requirements every implementation must keep:
 *
 * - Offline only: bundled XSD, schematron and terminology from it-fse-catalogs, no network access at runtime.
 *   `xsi:schemaLocation`, `xml-stylesheet` and any other URL in the document are never fetched.
 * - XML parser hardened: DTDs disabled, no external entities, no XInclude, bounded entity expansion. The
 *   pre-flight guard in `xml-guard.ts` already refuses these, the parser must refuse them too.
 * - Bounded: honours the `AbortSignal` (the server aborts after `VALIDATION_TIMEOUT_MS`).
 * - Messages may quote the document. They are returned to the client labelled as untrusted data, are passed
 *   through `redact()` and must never be logged.
 */

export type CdaIssueSeverity = 'error' | 'warning' | 'info';
export type CdaIssueSource = 'xsd' | 'schematron' | 'terminology' | 'preflight';

export interface CdaValidationIssue {
  severity: CdaIssueSeverity;
  source: CdaIssueSource;
  /** Rule identifier, for example `ERRORE-4` for schematron or `cvc-complex-type.2.4.a` for XSD. */
  ruleId?: string;
  message: string;
  /** Line in the submitted document, when the check reports one. */
  line?: number;
  /** XPath of the failing node (schematron SVRL `@location`), when known. */
  location?: string;
}

/**
 * Whether a validation level actually ran. Everything other than `run` means the level produced no issues
 * because it could not be executed, not because the document is clean.
 */
export type CdaCheckState =
  /** The level ran against the document. */
  | 'run'
  /** The document was refused by the pre-flight guard, nothing was parsed. */
  | 'not_run_preflight_rejected'
  /** XSD validation failed, so schematron was not attempted (the gateway stops at the first failing level). */
  | 'not_run_xsd_failed'
  /** The optional `@massimiliano-dev/fse-validator` package is not installed. */
  | 'skipped_validator_missing'
  /** No usable it-fse-catalogs checkout was found. */
  | 'skipped_catalogs_missing'
  /** The optional `saxon-js` peer dependency is not installed. */
  | 'skipped_saxon_missing'
  /** No compiled schematron is available for the detected document type. */
  | 'skipped_schematron_missing'
  /** The document type could not be derived from the header, so no schematron could be chosen. */
  | 'skipped_unknown_document_type';

/** Which validation levels ran. */
export interface CdaChecks {
  xsd: CdaCheckState;
  schematron: CdaCheckState;
}

export interface CdaValidationResult {
  /** `validator_unavailable` means no level could run: the result says nothing about the document. */
  status: 'valid' | 'invalid' | 'validator_unavailable';
  /** True only when every executed level passed. `null` when no level ran, so validity is unknown. */
  valid: boolean | null;
  /** Detected document type, for example `referto_laboratorio`. */
  documentType?: string;
  /** File name of the schematron that was applied, when one was. */
  schematron?: string;
  checks: CdaChecks;
  issues: CdaValidationIssue[];
  /** One line about a degraded or partial result, including how to enable the missing level. */
  detail?: string;
}

export interface CdaValidatorPort {
  /** Human-readable name and version of the validator, reported to the client. */
  readonly name: string;
  validate(xml: string, options: { signal: AbortSignal }): Promise<CdaValidationResult>;
}

/**
 * The validator used when `@massimiliano-dev/fse-validator` cannot be loaded. It never inspects the document and
 * says so: `valid` is `null` and both levels are reported as skipped.
 */
export const unavailableValidator: CdaValidatorPort = {
  name: 'unavailable',
  validate() {
    return Promise.resolve({
      status: 'validator_unavailable',
      valid: null,
      checks: { xsd: 'skipped_validator_missing', schematron: 'skipped_validator_missing' },
      issues: [],
      detail:
        'No CDA validator is installed: add the optional @massimiliano-dev/fse-validator package to enable XSD validation.',
    });
  },
};
