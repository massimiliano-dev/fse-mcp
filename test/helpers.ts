import { createRequire } from 'node:module';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { buildSampleCda } from '../src/data/sample-cda.js';
import { createFseMcpServer, type FseMcpServerOptions } from '../src/server.js';

/** Connects an SDK client to a fresh server over the in-memory transport pair. */
export async function connectInMemory(options: FseMcpServerOptions = {}) {
  const server = createFseMcpServer(options);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    server,
    async call(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
      return (await client.callTool({ name, arguments: args })) as CallToolResult;
    },
    async close() {
      await client.close();
      await server.close();
    },
  };
}

export function textOf(result: CallToolResult): string {
  return result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
}

export const MINIMAL_CDA = `<?xml version="1.0" encoding="UTF-8"?>
<!-- SYNTHETIC -->
<ClinicalDocument xmlns="urn:hl7-org:v3"><realmCode code="IT"/></ClinicalDocument>`;

/** Whether the optional saxon-js peer is installed; schematron tests are skipped without it. */
export const SAXON_INSTALLED = (() => {
  try {
    createRequire(import.meta.url).resolve('saxon-js');
    return true;
  } catch {
    return false;
  }
})();

/**
 * The synthetic laboratory report completed with the three things the skeleton leaves to fill in and that
 * schematronFSE_LAB_v27.1 requires, so that it passes XSD and schematron:
 *
 * - ERRORE-31: `ClinicalDocument` needs at least one `inFulfillmentOf` (the order the report answers).
 * - ERRORE-38: `author/assignedAuthor` needs at least one `telecom`.
 * - ERRORE-b1 / ERRORE-b2: every body `section` needs a `code` from the LAB specialty list (LOINC).
 *
 * Elements are inserted where the CDA XSD sequence expects them. All values are fictional.
 */
export function completedLabCda(): string {
  return buildSampleCda('referto_laboratorio')
    .replace(
      '  <component>\n    <structuredBody>',
      '  <inFulfillmentOf>\n    <order>\n' +
        '      <id root="2.16.840.1.113883.2.9.2.999.4.6" extension="SYNTHETIC-ORDER-0001" assigningAuthorityName="SYNTHETIC"/>\n' +
        '    </order>\n  </inFulfillmentOf>\n  <component>\n    <structuredBody>',
    )
    .replace(/(<assignedAuthor>\n\s*<id [^>]*\/>)/, '$1\n      <telecom use="WP" value="tel:+390000000000"/>')
    .replace(
      '<title>SYNTHETIC',
      '<code code="18719-5" codeSystem="2.16.840.1.113883.6.1" codeSystemName="LOINC" displayName="CHIMICA"/>\n' +
        '          <title>SYNTHETIC',
    );
}

/** {@link completedLabCda} with a templateId root other than the national LAB one: schematron ERRORE-4. */
export function brokenLabCda(): string {
  return completedLabCda().replace(
    'root="2.16.840.1.113883.2.9.10.1.1"',
    'root="2.16.840.1.113883.2.9.10.1.999"',
  );
}
