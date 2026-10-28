/**
 * Synthetic CDA2 skeletons. Every value that identifies a person or an organisation is fictional.
 *
 * The codici fiscali are format-valid (correct check character) so that the skeleton exercises the same code
 * paths as a real document, but they were built from the fictional names below ("Paziente Sintetico", "Medico
 * Test"); they are not meant to identify anyone.
 *
 * The national templateId roots and document codes come from the schematron files in it-fse-catalogs
 * (ERRORE-4 / ERRORE-5 of each).
 *
 * Only the laboratory report is checked: it passes the CDA XSD and schematronFSE_LAB_v27.1 (it-fse-catalogs
 * d8c766a), asserted by the tests. The other types have no compiled schematron to check against, so they are
 * unverified skeletons: a starting point to fill in, not a conformant document. Passing the schematron does not
 * make a document clinically complete; the TODOs in each document still apply.
 */

export const SYNTHETIC_MARKER = 'SYNTHETIC - NOT REAL PATIENT DATA';

export const SAMPLE_DOCUMENT_TYPES = [
  'referto_laboratorio',
  'lettera_dimissione',
  'referto_radiologia',
  'verbale_pronto_soccorso',
] as const;
export type SampleDocumentType = (typeof SAMPLE_DOCUMENT_TYPES)[number];

interface DocumentTypeSpec {
  label: string;
  /** National templateId root (verified against the schematron). */
  templateRoot: string;
  /** TODO(verify): the implementation-guide version the gateway expects in @extension. */
  templateExtension: string;
  loinc: string;
  displayName: string;
  title: string;
  schematron: string;
  /**
   * Parts the type's schematron requires that the generic skeleton lacks. Set only where the result has been
   * checked against the compiled schematron. Every value comes from the schematron messages or the catalogs XSD.
   */
  schematronRequirements?: {
    /** ERRORE-31: at least one `inFulfillmentOf`. */
    inFulfillmentOf: true;
    /** ERRORE-38: `author/assignedAuthor` needs a `telecom`; ERRORE-44: with `@use`. */
    authorTelecom: true;
    /** ERRORE-b1 / ERRORE-b2: a section code from the listed LOINC specialties. */
    sectionCode: { code: string; displayName: string };
  };
}

export const DOCUMENT_TYPE_SPECS: Record<SampleDocumentType, DocumentTypeSpec> = {
  referto_laboratorio: {
    label: 'Referto di Laboratorio (LAB)',
    templateRoot: '2.16.840.1.113883.2.9.10.1.1',
    templateExtension: '1.2',
    loinc: '11502-2',
    displayName: 'Referto di laboratorio',
    title: 'Referto di Laboratorio',
    schematron: 'schematronFSE_LAB_v27.1.sch',
    schematronRequirements: {
      inFulfillmentOf: true,
      authorTelecom: true,
      // First entry of the ERRORE-b1 list, spelled as in the message.
      sectionCode: { code: '18719-5', displayName: 'CHIMICA' },
    },
  },
  lettera_dimissione: {
    label: 'Lettera di Dimissione Ospedaliera (LDO)',
    templateRoot: '2.16.840.1.113883.2.9.10.1.5',
    templateExtension: '1.2',
    loinc: '34105-7',
    displayName: 'Lettera di dimissione ospedaliera',
    title: 'Lettera di Dimissione Ospedaliera',
    schematron: 'schematronFSE_LDO_v5.5.sch',
  },
  referto_radiologia: {
    label: 'Referto di Radiologia (RAD)',
    templateRoot: '2.16.840.1.113883.2.9.10.1.7.1',
    templateExtension: '1.2',
    loinc: '68604-8',
    displayName: 'Referto radiologico',
    title: 'Referto di Radiologia',
    schematron: 'schematronFSE_RAD_v4.1.sch',
  },
  verbale_pronto_soccorso: {
    label: 'Verbale di Pronto Soccorso (VPS)',
    templateRoot: '2.16.840.1.113883.2.9.10.1.6.1',
    templateExtension: '1.2',
    loinc: '59258-4',
    displayName: 'Verbale di pronto soccorso',
    title: 'Verbale di Pronto Soccorso',
    schematron: 'schematron_VPS_v3.8.sch',
  },
};

/** Fictional codice fiscale of "Paziente Sintetico", born 1980-01-01. */
export const SYNTHETIC_PATIENT_CF = 'SNTPNT80A01H501D';
/** Fictional codice fiscale of "Medico Test", born 1970-01-01. */
export const SYNTHETIC_DOCTOR_CF = 'TSTMDC70A41F205I';

/** Returns a synthetic CDA2 skeleton for `type`. Deterministic: the same type always gives the same document. */
export function buildSampleCda(type: SampleDocumentType): string {
  const spec = DOCUMENT_TYPE_SPECS[type];
  const required = spec.schematronRequirements;
  // Empty for types without requirements, so their output is unchanged.
  const requiredTodo = required
    ? `
     Checked against ${spec.schematron}. Placeholders it does not constrain, to replace: the inFulfillmentOf/order/id
     (nullFlavor NI: no catalog fixes its root), the author telecom (example.org is a reserved, unreachable domain),
     and the section code (${required.sectionCode.code} ${required.sectionCode.displayName}) with the specialty of each section.`
    : '';
  const authorTelecom = required?.authorTelecom
    ? `
      <!-- ${SYNTHETIC_MARKER}: fictional contact on a reserved domain (ERRORE-38, ERRORE-44) -->
      <telecom use="WP" value="mailto:medico.test@example.org"/>`
    : '';
  const inFulfillmentOf = required?.inFulfillmentOf
    ? `
  <!-- ERRORE-31: the request this report answers. TODO: the order identifier issued by your system. -->
  <inFulfillmentOf>
    <order>
      <id nullFlavor="NI"/>
    </order>
  </inFulfillmentOf>`
    : '';
  const sectionCode = required
    ? `
          <code code="${required.sectionCode.code}" codeSystem="2.16.840.1.113883.6.1" codeSystemName="LOINC" displayName="${required.sectionCode.displayName}"/>`
    : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- ${SYNTHETIC_MARKER} -->
<!-- Generated by fse-mcp as a skeleton for ${spec.label}. Every person, organisation and identifier is fictional.
     TODO before use: set templateId/@extension to the guide version you implement, replace the 999 placeholder
     region/organisation OIDs with your own, and complete the body as required by ${spec.schematron}.${requiredTodo} -->
<ClinicalDocument xmlns="urn:hl7-org:v3" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <realmCode code="IT"/>
  <typeId root="2.16.840.1.113883.1.3" extension="POCD_HD000040"/>
  <templateId root="${spec.templateRoot}" extension="${spec.templateExtension}"/>
  <id root="2.16.840.1.113883.2.9.2.999.4.4" extension="SYNTHETIC-DOC-0001" assigningAuthorityName="SYNTHETIC"/>
  <code code="${spec.loinc}" codeSystem="2.16.840.1.113883.6.1" codeSystemName="LOINC" displayName="${spec.displayName}"/>
  <title>${spec.title} (SYNTHETIC)</title>
  <effectiveTime value="20260101120000+0100"/>
  <confidentialityCode code="N" codeSystem="2.16.840.1.113883.5.25"/>
  <languageCode code="it-IT"/>
  <setId root="2.16.840.1.113883.2.9.2.999.4.4" extension="SYNTHETIC-DOC-0001" assigningAuthorityName="SYNTHETIC"/>
  <versionNumber value="1"/>
  <recordTarget>
    <patientRole>
      <!-- ${SYNTHETIC_MARKER}: fictional codice fiscale -->
      <id root="2.16.840.1.113883.2.9.4.3.2" extension="${SYNTHETIC_PATIENT_CF}" assigningAuthorityName="MEF"/>
      <patient>
        <name>
          <family>SINTETICO</family>
          <given>PAZIENTE</given>
        </name>
        <administrativeGenderCode code="M" codeSystem="2.16.840.1.113883.5.1"/>
        <birthTime value="19800101"/>
      </patient>
    </patientRole>
  </recordTarget>
  <author>
    <time value="20260101120000+0100"/>
    <assignedAuthor>
      <id root="2.16.840.1.113883.2.9.4.3.2" extension="${SYNTHETIC_DOCTOR_CF}" assigningAuthorityName="MEF"/>${authorTelecom}
      <assignedPerson>
        <name>
          <family>TEST</family>
          <given>MEDICO</given>
        </name>
      </assignedPerson>
    </assignedAuthor>
  </author>
  <custodian>
    <assignedCustodian>
      <representedCustodianOrganization>
        <!-- TODO(verify): custodian id root and extension for your organisation type -->
        <id root="2.16.840.1.113883.2.9.4.1.2" extension="999999" assigningAuthorityName="SYNTHETIC"/>
        <name>Struttura Sanitaria Sintetica</name>
      </representedCustodianOrganization>
    </assignedCustodian>
  </custodian>
  <legalAuthenticator>
    <time value="20260101120000+0100"/>
    <signatureCode code="S"/>
    <assignedEntity>
      <id root="2.16.840.1.113883.2.9.4.3.2" extension="${SYNTHETIC_DOCTOR_CF}" assigningAuthorityName="MEF"/>
      <assignedPerson>
        <name>
          <family>TEST</family>
          <given>MEDICO</given>
        </name>
      </assignedPerson>
    </assignedEntity>
  </legalAuthenticator>${inFulfillmentOf}
  <component>
    <structuredBody>
      <component>
        <section>
          <!-- TODO: sections, codes and entries required by ${spec.schematron} -->${sectionCode}
          <title>${SYNTHETIC_MARKER}</title>
          <text>Contenuto sintetico di esempio. Nessun dato reale.</text>
        </section>
      </component>
    </structuredBody>
  </component>
</ClinicalDocument>
`;
}
