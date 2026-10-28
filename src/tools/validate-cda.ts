import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod';
import { MAX_CDA_BYTES, utf8Bytes, VALIDATION_TIMEOUT_MS } from '../limits.js';
import { type Logger } from '../log.js';
import { type CdaValidatorPort } from '../validator-port.js';
import { inspectUntrustedXml } from '../xml-guard.js';
import { READ_ONLY_ANNOTATIONS, safeHandler, toolResult, UNTRUSTED_DATA_NOTICE } from './common.js';

export const validateCdaInput = z.object({
  xml: z
    .string()
    .min(1)
    .max(MAX_CDA_BYTES)
    .refine((value) => utf8Bytes(value) <= MAX_CDA_BYTES, {
      message: `The document exceeds ${MAX_CDA_BYTES} bytes.`,
    })
    .describe(`The CDA2 document as an XML string, at most ${MAX_CDA_BYTES} bytes (UTF-8).`),
});

const issueSchema = z.object({
  severity: z.enum(['error', 'warning', 'info']),
  source: z.enum(['xsd', 'schematron', 'terminology', 'preflight']),
  ruleId: z.string().optional(),
  message: z.string().describe('Document-derived: may quote the submitted document.'),
  line: z.number().int().optional(),
  location: z.string().optional(),
});

const checkState = z.enum([
  'run',
  'not_run_preflight_rejected',
  'not_run_xsd_failed',
  'skipped_validator_missing',
  'skipped_catalogs_missing',
  'skipped_saxon_missing',
  'skipped_schematron_missing',
  'skipped_unknown_document_type',
]);

export const validateCdaOutput = z.object({
  status: z.enum(['valid', 'invalid', 'rejected_preflight', 'validator_unavailable']),
  valid: z.boolean().nullable().describe('null when no validation level ran: validity is unknown.'),
  validator: z.string(),
  documentType: z.string().optional(),
  schematron: z.string().optional(),
  rootElement: z.string().optional(),
  checks: z
    .object({ xsd: checkState, schematron: checkState })
    .describe('Which levels ran. A level that did not run reports no issues, which says nothing about it.'),
  issues: z.array(issueSchema),
  detail: z.string().optional(),
  notice: z.string(),
});

export type ValidateCdaOutput = z.infer<typeof validateCdaOutput>;

export function registerValidateCda(
  server: McpServer,
  deps: { validator: CdaValidatorPort; logger: Logger },
) {
  server.registerTool(
    'validate_cda',
    {
      title: 'Validate a CDA2 document',
      description:
        'Checks an HL7 CDA R2 document for the FSE 2.0 gateway locally, without sending it anywhere, and ' +
        'returns XSD issues with their line and, when the XSD passes, schematron issues with their rule id ' +
        'and location. Documents with a DOCTYPE, entity declarations or XInclude are refused. Needs the ' +
        'optional @massimiliano-dev/fse-validator package and an it-fse-catalogs checkout; schematron also ' +
        'needs the optional saxon-js package (proprietary Saxonica licence) and a compiled schematron for the ' +
        'document type. The checks field says which levels ran. Use only synthetic or anonymised documents.',
      inputSchema: validateCdaInput,
      outputSchema: validateCdaOutput,
      annotations: { title: 'Validate a CDA2 document', ...READ_ONLY_ANNOTATIONS },
    },
    safeHandler('validate_cda', deps.logger, async ({ xml }) => {
      const preflight = inspectUntrustedXml(xml);
      const preflightIssues = preflight.issues.map((issue) => ({
        severity: issue.severity,
        source: 'preflight' as const,
        ruleId: issue.code,
        message: issue.message,
      }));
      const rootElement = preflight.rootElement ? { rootElement: preflight.rootElement } : {};

      if (!preflight.ok) {
        return toolResult<ValidateCdaOutput>({
          status: 'rejected_preflight',
          valid: false,
          validator: deps.validator.name,
          ...rootElement,
          checks: { xsd: 'not_run_preflight_rejected', schematron: 'not_run_preflight_rejected' },
          issues: preflightIssues,
          detail: 'The document was refused before parsing. Fix the preflight errors and validate again.',
          notice: UNTRUSTED_DATA_NOTICE,
        });
      }

      const result = await deps.validator.validate(xml, {
        signal: AbortSignal.timeout(VALIDATION_TIMEOUT_MS),
      });
      deps.logger.info('validate_cda completed', { status: result.status, issues: result.issues.length });

      return toolResult<ValidateCdaOutput>({
        status: result.status,
        valid: result.valid,
        // Read after the run: the default validator names the catalogs commit once it has loaded them.
        validator: deps.validator.name,
        ...(result.documentType ? { documentType: result.documentType } : {}),
        ...(result.schematron ? { schematron: result.schematron } : {}),
        ...rootElement,
        checks: result.checks,
        issues: [...preflightIssues, ...result.issues],
        ...(result.detail ? { detail: result.detail } : {}),
        notice: UNTRUSTED_DATA_NOTICE,
      });
    }),
  );
}
