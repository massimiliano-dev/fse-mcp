import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod';
import {
  buildSampleCda,
  DOCUMENT_TYPE_SPECS,
  SAMPLE_DOCUMENT_TYPES,
  SYNTHETIC_MARKER,
} from '../data/sample-cda.js';
import { type Logger } from '../log.js';
import { READ_ONLY_ANNOTATIONS, safeHandler, toolResult } from './common.js';

export const generateInput = z.object({
  documentType: z
    .enum(SAMPLE_DOCUMENT_TYPES)
    .describe(
      'Document type: ' +
        SAMPLE_DOCUMENT_TYPES.map((t) => `${t} = ${DOCUMENT_TYPE_SPECS[t].label}`).join('; ') +
        '.',
    ),
});

export const generateOutput = z.object({
  documentType: z.string(),
  label: z.string(),
  templateId: z.string(),
  loincCode: z.string(),
  schematron: z.string(),
  synthetic: z.literal(true),
  xml: z.string(),
  note: z.string(),
});

export type GenerateOutput = z.infer<typeof generateOutput>;

export function registerGenerateSampleCda(server: McpServer, deps: { logger: Logger }) {
  server.registerTool(
    'generate_sample_cda',
    {
      title: 'Generate a synthetic CDA2 skeleton',
      description:
        'Returns a SYNTHETIC CDA2 document skeleton for the chosen FSE 2.0 document type, with fictional ' +
        'patient, doctor and organisation data, to use as a starting point or as a test fixture.',
      inputSchema: generateInput,
      outputSchema: generateOutput,
      annotations: { title: 'Generate a synthetic CDA2 skeleton', ...READ_ONLY_ANNOTATIONS },
    },
    safeHandler('generate_sample_cda', deps.logger, ({ documentType }) => {
      const spec = DOCUMENT_TYPE_SPECS[documentType];
      return toolResult<GenerateOutput>({
        documentType,
        label: spec.label,
        templateId: spec.templateRoot,
        loincCode: spec.loinc,
        schematron: spec.schematron,
        synthetic: true,
        xml: buildSampleCda(documentType),
        note:
          `${SYNTHETIC_MARKER}. A skeleton, not a conformant document: complete the TODOs and the body ` +
          'sections required by the schematron. Never replace the fictional values with real patient data ' +
          'while working with a hosted LLM.',
      });
    }),
  );
}
