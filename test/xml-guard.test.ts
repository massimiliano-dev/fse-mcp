import { describe, expect, it } from 'vitest';
import { inspectUntrustedXml } from '../src/xml-guard.js';
import { MINIMAL_CDA } from './helpers.js';

const codes = (xml: string) => inspectUntrustedXml(xml).issues.map((i) => i.code);

describe('inspectUntrustedXml', () => {
  it('accepts a minimal ClinicalDocument in the HL7 v3 namespace', () => {
    const result = inspectUntrustedXml(MINIMAL_CDA);
    expect(result).toEqual({ ok: true, rootElement: 'ClinicalDocument', issues: [] });
  });

  it('accepts a prefixed root and a BOM', () => {
    const xml = '﻿<hl7:ClinicalDocument xmlns:hl7="urn:hl7-org:v3"/>';
    expect(inspectUntrustedXml(xml).ok).toBe(true);
  });

  it('refuses DTDs and external entities (XXE)', () => {
    const xxe = `<?xml version="1.0"?>
<!DOCTYPE ClinicalDocument [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>
<ClinicalDocument xmlns="urn:hl7-org:v3"><title>&xxe;</title></ClinicalDocument>`;
    const result = inspectUntrustedXml(xxe);
    expect(result.ok).toBe(false);
    expect(codes(xxe)).toEqual(expect.arrayContaining(['DTD_FORBIDDEN', 'ENTITY_FORBIDDEN']));
  });

  it('refuses a lowercase doctype and parameter entities', () => {
    expect(codes('<!doctype x><ClinicalDocument xmlns="urn:hl7-org:v3"/>')).toContain('DTD_FORBIDDEN');
    expect(codes('<!ENTITY % p SYSTEM "http://evil/x"><ClinicalDocument/>')).toContain('ENTITY_FORBIDDEN');
  });

  it('refuses XInclude', () => {
    const xml =
      '<ClinicalDocument xmlns="urn:hl7-org:v3" xmlns:xi="http://www.w3.org/2001/XInclude">' +
      '<xi:include href="file:///etc/passwd"/></ClinicalDocument>';
    expect(codes(xml)).toContain('XINCLUDE_FORBIDDEN');
  });

  it('warns about stylesheets and schemaLocation without failing', () => {
    const xml =
      '<?xml-stylesheet type="text/xsl" href="http://example.invalid/x.xsl"?>' +
      '<ClinicalDocument xmlns="urn:hl7-org:v3" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ' +
      'xsi:schemaLocation="urn:hl7-org:v3 http://example.invalid/CDA.xsd"/>';
    const result = inspectUntrustedXml(xml);
    expect(result.ok).toBe(true);
    expect(codes(xml)).toEqual(['STYLESHEET_IGNORED', 'SCHEMA_LOCATION_IGNORED']);
  });

  it('rejects empty input, non-XML, other roots and a missing namespace', () => {
    expect(codes('   ')).toEqual(['EMPTY_DOCUMENT']);
    expect(codes('hello')).toEqual(['NOT_XML']);
    expect(codes('<Bundle xmlns="http://hl7.org/fhir"/>')).toEqual(['UNEXPECTED_ROOT']);
    expect(codes('<ClinicalDocument/>')).toEqual(['MISSING_HL7_NAMESPACE']);
    expect(codes('<ClinicalDocument xmlns="urn:evil"/>')).toEqual(['MISSING_HL7_NAMESPACE']);
  });

  it('never reports an unsafe root element name', () => {
    const result = inspectUntrustedXml(`<${'a'.repeat(500)}/>`);
    expect(result.rootElement).toBeUndefined();
  });
});
