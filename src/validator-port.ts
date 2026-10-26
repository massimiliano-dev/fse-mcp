/**
 * The boundary between this MCP server and the real CDA2 validator.
 *
 * TODO(wiring): implement this port with `@massimiliano-dev/fse-validator` from the `fse-client` repository once
 * it is published, and inject it in `bin.ts` (`createFseMcpServer({ validator })`). Do not add the dependency
 * before it is published. Requirements for the implementation, which the tests of this repository will assert:
 *
 * - Offline only: bundled XSD, schematron and terminology from it-fse-catalogs, no network access at runtime.
 *   `xsi:schemaLocation`, `xml-stylesheet` and any other URL in the document are never fetched.
 * - XML parser hardened: DTDs disabled, no external entities, no XInclude, bounded entity expansion. The
 *   pre-flight guard in `xml-guard.ts` already refuses these, the parser must refuse them too.
 * - Bounded: honours the `AbortSignal` (the server aborts after `VALIDATION_TIMEOUT_MS`).
 * - Messages may quote the document. They are returned to the client labelled as untrusted data and must never
 *   be logged.
 */

export type CdaIssueSeverity = 'error' | 'warning' | 'info';
export type CdaIssueSource = 'xsd' | 'schematron' | 'terminology' | 'preflight';

export interface CdaValidationIssue {
  severity: CdaIssueSeverity;
  source: CdaIssueSource;
  /** Rule identifier, for example `ERRORE-4` for schematron or `cvc-complex-type.2.4.a` for XSD. */
  ruleId?: string;
  message: string;
  /** XPath or line/column of the failing node, when known. */
  location?: string;
}

export interface CdaValidationResult {
  status: 'valid' | 'invalid' | 'not_implemented';
  /** Detected document type, for example `LAB` (referto di laboratorio). */
  documentType?: string;
  issues: CdaValidationIssue[];
}

export interface CdaValidatorPort {
  /** Human-readable name and version of the validator, reported to the client. */
  readonly name: string;
  validate(xml: string, options: { signal: AbortSignal }): Promise<CdaValidationResult>;
}

/** The validator used until the real one is wired. It never inspects the document. */
export const notImplementedValidator: CdaValidatorPort = {
  name: 'stub (not implemented)',
  validate() {
    return Promise.resolve({ status: 'not_implemented', issues: [] });
  },
};
