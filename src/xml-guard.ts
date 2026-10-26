/**
 * Pre-flight checks on an untrusted XML string, done with plain string inspection before any XML parser sees it.
 *
 * The goal is to refuse the constructs that turn an XML parser into an attack surface, independently of how the
 * downstream validator is configured:
 *
 * - `<!DOCTYPE` / `<!ENTITY`: external entities (XXE) read local files or make network requests; internal
 *   entities enable "billion laughs" memory exhaustion. A CDA2 document for FSE 2.0 never needs a DTD.
 * - XInclude: pulls other files into the document.
 * - `xml-stylesheet` processing instructions and `xsi:schemaLocation` hints are reported as warnings: they are
 *   common in real CDA files, but this server never follows them.
 *
 * This is not a well-formedness check and does not replace a parser hardened with the same settings: the real
 * validator must also disable DTDs, external entities and network access (see `CdaValidatorPort`).
 */

export type PreflightCode =
  | 'EMPTY_DOCUMENT'
  | 'DTD_FORBIDDEN'
  | 'ENTITY_FORBIDDEN'
  | 'XINCLUDE_FORBIDDEN'
  | 'NOT_XML'
  | 'UNEXPECTED_ROOT'
  | 'MISSING_HL7_NAMESPACE'
  | 'STYLESHEET_IGNORED'
  | 'SCHEMA_LOCATION_IGNORED';

export interface PreflightIssue {
  severity: 'error' | 'warning';
  code: PreflightCode;
  message: string;
}

export interface PreflightResult {
  ok: boolean;
  /** Local name of the root element, sanitized and truncated. Never contains document text beyond the name. */
  rootElement?: string;
  issues: PreflightIssue[];
}

const HL7_V3_NAMESPACE = 'urn:hl7-org:v3';
/**
 * Any namespace declaration (prefixed or default) bound to the XInclude namespace. Matching the declaration,
 * not a bare substring, means a comment or text mentioning the URI is not a false positive, and a default
 * namespace (`xmlns="…XInclude"` with an unprefixed `<include>`) is still caught.
 */
const XINCLUDE_NAMESPACE_DECLARATION =
  /\bxmlns(?::[\w.-]+)?\s*=\s*(["'])\s*http:\/\/www\.w3\.org\/2001\/XInclude\s*\1/i;
const NAME_SAFE = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;

/** Inspects `xml` and reports constructs that must not reach a parser. */
export function inspectUntrustedXml(xml: string): PreflightResult {
  const issues: PreflightIssue[] = [];
  const text = xml.charCodeAt(0) === 0xfeff ? xml.slice(1) : xml;

  if (text.trim().length === 0) {
    return { ok: false, issues: [error('EMPTY_DOCUMENT', 'The document is empty.')] };
  }
  if (/<!DOCTYPE/i.test(text)) {
    issues.push(
      error(
        'DTD_FORBIDDEN',
        'The document contains a DOCTYPE declaration. DTDs are refused because they enable external entity ' +
          '(XXE) and entity-expansion attacks; FSE 2.0 CDA documents do not use them.',
      ),
    );
  }
  if (/<!ENTITY/i.test(text)) {
    issues.push(error('ENTITY_FORBIDDEN', 'The document declares XML entities, which are refused.'));
  }
  if (XINCLUDE_NAMESPACE_DECLARATION.test(text) || /<[A-Za-z0-9_-]+:include[\s/>]/.test(text)) {
    issues.push(error('XINCLUDE_FORBIDDEN', 'The document uses XInclude, which is refused.'));
  }
  if (/<\?xml-stylesheet[\s?]/i.test(text)) {
    issues.push(
      warning(
        'STYLESHEET_IGNORED',
        'The document references an XSL stylesheet. It is ignored: this server never fetches or applies it.',
      ),
    );
  }
  if (/\bxsi:schemaLocation\s*=/.test(text)) {
    issues.push(
      warning(
        'SCHEMA_LOCATION_IGNORED',
        'The document has an xsi:schemaLocation hint. It is ignored: validation uses bundled schemas only.',
      ),
    );
  }

  const root = findRootElement(text);
  if (!root) {
    issues.push(error('NOT_XML', 'No root element was found. The input does not look like an XML document.'));
  } else {
    const localName = root.name.includes(':') ? root.name.slice(root.name.indexOf(':') + 1) : root.name;
    const safeName = NAME_SAFE.test(localName) ? localName : undefined;
    if (localName !== 'ClinicalDocument') {
      issues.push(
        error(
          'UNEXPECTED_ROOT',
          'The root element is not ClinicalDocument. FSE 2.0 accepts HL7 CDA R2 documents only.',
        ),
      );
    } else if (!declaresHl7Namespace(root.name, root.attributes)) {
      issues.push(
        error(
          'MISSING_HL7_NAMESPACE',
          `ClinicalDocument must be in the HL7 v3 namespace (xmlns="${HL7_V3_NAMESPACE}").`,
        ),
      );
    }
    return finish(issues, safeName);
  }
  return finish(issues, undefined);
}

function finish(issues: PreflightIssue[], rootElement: string | undefined): PreflightResult {
  const result: PreflightResult = { ok: !issues.some((i) => i.severity === 'error'), issues };
  if (rootElement) result.rootElement = rootElement;
  return result;
}

/** Skips the prolog (declaration, comments, processing instructions, DOCTYPE) and returns the first start tag. */
function findRootElement(text: string): { name: string; attributes: string } | undefined {
  let i = 0;
  // Bounded loop: every iteration consumes at least one construct or exits.
  while (i < text.length) {
    const lt = text.indexOf('<', i);
    if (lt === -1) return undefined;
    if (text.startsWith('<?', lt)) {
      const end = text.indexOf('?>', lt + 2);
      if (end === -1) return undefined;
      i = end + 2;
    } else if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt + 4);
      if (end === -1) return undefined;
      i = end + 3;
    } else if (text.startsWith('<!', lt)) {
      const end = text.indexOf('>', lt + 2);
      if (end === -1) return undefined;
      i = end + 1;
    } else {
      const end = text.indexOf('>', lt + 1);
      if (end === -1) return undefined;
      const tag = text.slice(lt + 1, end);
      const match = /^([A-Za-z_][\w.:-]*)([\s\S]*)$/.exec(tag);
      return match ? { name: match[1] ?? '', attributes: match[2] ?? '' } : undefined;
    }
  }
  return undefined;
}

function declaresHl7Namespace(qualifiedName: string, attributes: string): boolean {
  const prefix = qualifiedName.includes(':') ? qualifiedName.slice(0, qualifiedName.indexOf(':')) : undefined;
  const attr = prefix ? `xmlns:${prefix}` : 'xmlns';
  const pattern = new RegExp(
    `(?:^|\\s)${escapeRegExp(attr)}\\s*=\\s*(["'])${escapeRegExp(HL7_V3_NAMESPACE)}\\1`,
  );
  return pattern.test(attributes);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function error(code: PreflightCode, message: string): PreflightIssue {
  return { severity: 'error', code, message };
}

function warning(code: PreflightCode, message: string): PreflightIssue {
  return { severity: 'warning', code, message };
}
