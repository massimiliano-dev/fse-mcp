/**
 * Hard limits applied to every input. They are deliberately small: this server explains errors and looks up
 * codes, it is not a bulk-processing service.
 */

/** Maximum size of a CDA document passed to `validate_cda`, in UTF-8 bytes (2 MiB). */
export const MAX_CDA_BYTES = 2 * 1024 * 1024;

/** Maximum length of an error message passed to `explain_schematron_error`. */
export const MAX_ERROR_MESSAGE_CHARS = 4_000;

/** Maximum length of a `lookup_code` query. */
export const MAX_LOOKUP_QUERY_CHARS = 200;

/** Maximum number of `lookup_code` results. */
export const MAX_LOOKUP_RESULTS = 25;

/**
 * Maximum HTTP request body in bytes. A 2 MiB CDA can grow when JSON-escaped (quotes, newlines), so the body
 * limit leaves headroom above {@link MAX_CDA_BYTES}; the tool schema still enforces the document limit.
 */
export const MAX_HTTP_BODY_BYTES = 5 * 1024 * 1024;

/** Upper bound for a single validator run. */
export const VALIDATION_TIMEOUT_MS = 30_000;

/**
 * Maximum number of validation issues returned per level. libxml2 and the schematrons can report hundreds of
 * consequences of one mistake; the first few are what a developer acts on.
 */
export const MAX_VALIDATION_ISSUES = 50;

/** Maximum length of a single validation message. XSD errors list every expected element and get long. */
export const MAX_ISSUE_MESSAGE_CHARS = 1_000;

/** Maximum size of a compiled schematron (SaxonJS SEF). The largest official one is a few MiB. */
export const MAX_SEF_BYTES = 32 * 1024 * 1024;

/** Minimum length of the HTTP bearer token. */
export const MIN_TOKEN_LENGTH = 32;

/** Returns the size of a string in UTF-8 bytes. */
export function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}
