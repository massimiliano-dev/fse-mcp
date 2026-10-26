/**
 * EXAMPLE EXPLANATIONS, TO BE REPLACED.
 *
 * Hand-written plain-language explanations for a few common rejections. The original messages are quoted from
 * `schematron/schematronFSE_LAB_v27.1.sch` in https://github.com/ministero-salute/it-fse-catalogs
 * (retrieved 2026-10-26). Rule numbers (`ERRORE-n`) are local to each schematron: `ERRORE-5` of the laboratory
 * report is not `ERRORE-5` of the discharge letter, which is why every entry names its schematron.
 *
 * TODO(data): generate the rule table from all schematron files in it-fse-catalogs (rule id, test, official
 * message, schematron name and version), and keep only the explanation and fix hand-written.
 */

export interface SchematronExplanation {
  /** Stable identifier of this explanation. */
  id: string;
  /** Schematron (or `XSD`) the rule belongs to. */
  schematron: string;
  /** Rule identifier as it appears in gateway responses, when there is one. */
  ruleId?: string;
  /** Official message, verbatim, in Italian. */
  officialMessage: string;
  explanation: string;
  fix: string;
  /** Patterns matched against the submitted error message. Keep them simple and linear (no nested quantifiers). */
  patterns: readonly RegExp[];
}

const LAB = 'schematronFSE_LAB_v27.1 (Referto di Laboratorio)';

export const SCHEMATRON_EXPLANATIONS: readonly SchematronExplanation[] = [
  {
    id: 'lab-realmcode-it',
    schematron: LAB,
    ruleId: 'ERRORE-2',
    officialMessage: "Almeno un elemento 'realmCode' DEVE avere l'attributo @root valorizzato come 'IT'",
    explanation:
      'The document has no <realmCode code="IT"/>. Note that the official message says @root, but the rule ' +
      'actually checks the @code attribute.',
    fix: 'Add <realmCode code="IT"/> as the first child of ClinicalDocument.',
    patterns: [/realmCode/i],
  },
  {
    id: 'lab-templateid-national',
    schematron: LAB,
    ruleId: 'ERRORE-4',
    officialMessage:
      "Almeno un elemento 'templateId' DEVE essere valorizzato attraverso l'attributo @root='2.16.840.1.113883.2.9.10.1.1' " +
      "(id del template nazionale) associato all'attributo @extension che indica la versione a cui il templateId fa riferimento",
    explanation:
      'The gateway recognises the document type from the national templateId. For a laboratory report it must ' +
      'have root 2.16.840.1.113883.2.9.10.1.1 and an @extension with the implementation-guide version.',
    fix:
      'Add <templateId root="2.16.840.1.113883.2.9.10.1.1" extension="..."/> after typeId, with the version ' +
      'of the implementation guide you follow. TODO(verify): which extension values the gateway accepts.',
    patterns: [/2\.16\.840\.1\.113883\.2\.9\.10\.1\.1(?![.\d])/],
  },
  {
    id: 'lab-document-code',
    schematron: LAB,
    ruleId: 'ERRORE-5',
    officialMessage:
      "L'elemento ClinicalDocument/code deve essere valorizzato con l'attributo @code='11502-2' e il @codeSystem='2.16.840.1.113883.6.1'",
    explanation:
      'The document type code does not say "laboratory report". Both the LOINC code and the LOINC code system ' +
      'OID must match; a correct code with a wrong or missing codeSystem fails too.',
    fix: 'Use <code code="11502-2" codeSystem="2.16.840.1.113883.6.1" codeSystemName="LOINC" displayName="Referto di laboratorio"/>.',
    patterns: [/11502-2/],
  },
  {
    id: 'lab-legal-authenticator-cf',
    schematron: LAB,
    ruleId: 'ERRORE-28',
    officialMessage:
      "L'elemento legalAuthenticator/assignedEntity DEVE contenere almeno un elemento id valorizzato con l'attributo @root '2.16.840.1.113883.2.9.4.3.2'",
    explanation:
      'The signing physician must be identified by codice fiscale. 2.16.840.1.113883.2.9.4.3.2 is the OID of ' +
      'the codice fiscale namespace; an internal staff id or a regional id alone is not enough.',
    fix:
      'Add <id root="2.16.840.1.113883.2.9.4.3.2" extension="<codice fiscale of the signer>"/> inside ' +
      'legalAuthenticator/assignedEntity. Keep any internal id as an additional <id>.',
    patterns: [/legalAuthenticator/i],
  },
  {
    id: 'xsd-unexpected-element',
    schematron: 'XSD (CDA R2 schema, any document type)',
    ruleId: 'cvc-complex-type.2.4.a',
    officialMessage:
      "cvc-complex-type.2.4.a: Invalid content was found starting with element '...'. One of '{...}' is expected.",
    explanation:
      'This is an XML Schema error, raised before any schematron rule runs. CDA R2 is order-sensitive: an ' +
      'element is in the wrong position, misspelled, or in the wrong namespace (for example missing ' +
      'xmlns="urn:hl7-org:v3"). The element in quotes is where the parser gave up; the list after "One of" is ' +
      'what it expected there.',
    fix:
      'Move the element to the position required by the CDA R2 schema (header order: realmCode, typeId, ' +
      'templateId, id, code, title, effectiveTime, confidentialityCode, languageCode, setId, versionNumber, ' +
      'recordTarget, author, ...) and check the namespace. TODO(verify): exact wording of gateway XSD messages.',
    patterns: [/cvc-complex-type\.2\.4\.a/i],
  },
];
