/**
 * Redaction of personal data and credentials from anything that is logged.
 *
 * Logs are the most common place where health data leaks: they are shipped to third-party services, kept for
 * months and read by people who never had access to the clinical system. Everything the logger writes goes
 * through {@link redact} first.
 */

export const REDACTED = '[REDACTED]';

/**
 * Italian codice fiscale (persons), including "omocodia" variants where digits are replaced by letters.
 * Case-insensitive because documents and logs are not always upper case.
 */
const CODICE_FISCALE =
  /\b[A-Z]{6}[0-9LMNPQRSTUV]{2}[ABCDEHLMPRST][0-9LMNPQRSTUV]{2}[A-Z][0-9LMNPQRSTUV]{3}[A-Z]\b/gi;

/** STP (Straniero Temporaneamente Presente) and ENI (Europeo Non Iscritto) codes: prefix plus 13 digits. */
const STP_ENI = /\b(?:STP|ENI)\d{13}\b/gi;

/** Anything shaped like a JWT/JWS: three base64url segments, the first one starting with `eyJ` ("{"). */
const JWT = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g;

/** `Authorization: Bearer <anything>`, whatever the token format. */
const BEARER = /\b(Bearer)\s+[^\s"',;]+/gi;

export interface Redactor {
  /** Registers a literal secret (for example the HTTP bearer token) so that it is never logged. */
  addSecret(secret: string): void;
  /** Returns `text` with personal identifiers, tokens and registered secrets replaced by `[REDACTED]`. */
  redact(text: string): string;
}

/** Creates a redactor with its own list of registered secrets. */
export function createRedactor(): Redactor {
  const secrets = new Set<string>();
  return {
    addSecret(secret) {
      // Very short values would redact random words; tokens are validated to be long elsewhere.
      if (secret.length >= 8) secrets.add(secret);
    },
    redact(text) {
      let out = text;
      for (const secret of secrets) out = out.split(secret).join(REDACTED);
      return out
        .replace(BEARER, `$1 ${REDACTED}`)
        .replace(JWT, REDACTED)
        .replace(CODICE_FISCALE, REDACTED)
        .replace(STP_ENI, REDACTED);
    },
  };
}

const defaultRedactor = createRedactor();

/** Redacts with the process-wide redactor. */
export function redact(text: string): string {
  return defaultRedactor.redact(text);
}

/** Registers a secret with the process-wide redactor. */
export function addSecret(secret: string): void {
  defaultRedactor.addSecret(secret);
}
