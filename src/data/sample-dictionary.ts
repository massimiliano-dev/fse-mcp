/**
 * SAMPLE DATA, NOT THE REAL DICTIONARIES.
 *
 * A handful of entries copied from `terminology/terminology.csv` in
 * https://github.com/ministero-salute/it-fse-catalogs (retrieved 2026-10-26), only to make `lookup_code` usable
 * while the scaffold is built.
 *
 * TODO(data): replace with dictionaries generated at build time from it-fse-catalogs (pinned commit, checksum
 * verified, shipped inside the package so that lookups stay offline). Check the catalogs' licence first: the
 * repository declares no SPDX licence, and LOINC, ICD9-CM, ATC and AIC each have their own terms.
 *
 * This material contains content from LOINC (http://loinc.org). LOINC is copyright © 1995-2023, Regenstrief
 * Institute, Inc. and the Logical Observation Identifiers Names and Codes (LOINC) Committee and is available at
 * no cost under the license at http://loinc.org/license. LOINC® is a registered United States trademark of
 * Regenstrief Institute, Inc.
 */

export interface CodeSystemInfo {
  /** Short name used in tool input. */
  name: CodeSystemName;
  /** HL7 OID used as `@codeSystem` in CDA documents. */
  oid: string;
  description: string;
}

export interface CodeEntry {
  code: string;
  display: string;
}

export const CODE_SYSTEM_NAMES = ['LOINC', 'ICD9-CM', 'ATC', 'AIC', 'AdministrativeGender'] as const;
export type CodeSystemName = (typeof CODE_SYSTEM_NAMES)[number];

export const CODE_SYSTEMS: Record<CodeSystemName, CodeSystemInfo> = {
  LOINC: {
    name: 'LOINC',
    oid: '2.16.840.1.113883.6.1',
    description: 'Document types, sections and laboratory tests.',
  },
  'ICD9-CM': {
    name: 'ICD9-CM',
    oid: '2.16.840.1.113883.6.103',
    description: 'Diagnoses (Italian ICD9-CM edition).',
  },
  ATC: {
    name: 'ATC',
    oid: '2.16.840.1.113883.6.73',
    description: 'Anatomical Therapeutic Chemical classification of active substances.',
  },
  AIC: {
    name: 'AIC',
    oid: '2.16.840.1.113883.2.9.6.1.5',
    description:
      'Italian marketing authorisation codes (Autorizzazione all’Immissione in Commercio) of medicines.',
  },
  AdministrativeGender: {
    name: 'AdministrativeGender',
    oid: '2.16.840.1.113883.5.1',
    description: 'HL7 administrative gender, used in recordTarget/patientRole/patient.',
  },
};

export const SAMPLE_CODES: Record<CodeSystemName, readonly CodeEntry[]> = {
  LOINC: [
    { code: '11502-2', display: 'Laboratory report' },
    { code: '34105-7', display: 'Discharge summary note' },
    { code: '59258-4', display: 'Discharge summary note' },
    { code: '68604-8', display: 'Diagnostic study note' },
    { code: '718-7', display: 'Hemoglobin (Bld) [Mass/Vol]' },
    { code: '2345-7', display: 'Glucose [Mass/Vol]' },
    { code: '2160-0', display: 'Creatinine [Mass/Vol]' },
    { code: '6690-2', display: 'WBC Auto (Bld) [#/Vol]' },
  ],
  'ICD9-CM': [
    {
      code: '250.00',
      display:
        'Diabete mellito, tipo II o non specificato; non definito se scompensato; senza menzione di complicazioni',
    },
    { code: '401.9', display: 'Ipertensione essenziale non specificata' },
    { code: '486', display: 'Polmonite, agente non specificato' },
    { code: 'V70.0', display: 'Esame medico generale di routine in un servizio di cura' },
  ],
  ATC: [
    { code: 'N02BE01', display: 'PARACETAMOLO' },
    { code: 'A10BA02', display: 'METFORMINA' },
    { code: 'C09AA02', display: 'ENALAPRIL' },
    { code: 'J01CA04', display: 'AMOXICILLINA' },
  ],
  AIC: [
    { code: '012745016', display: 'TACHIPIRINA*120 MG/5 ML SCIROPPO-FLACONE 120 ML' },
    { code: '012745028', display: 'TACHIPIRINA*500 MG COMPRESSE-10 COMPRESSE' },
    { code: '012745042', display: 'TACHIPIRINA*BAMBINI 250 MG SUPPOSTE- 10 SUPPOSTE' },
  ],
  AdministrativeGender: [
    { code: 'F', display: 'Female' },
    { code: 'M', display: 'Male' },
    { code: 'UN', display: 'Undifferentiated' },
  ],
};
