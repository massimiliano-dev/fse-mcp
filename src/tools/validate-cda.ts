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
  location: z.string().optional(),
});

export const validateCdaOutput = z.object({
  status: z.enum(['valid', 'invalid', 'rejected_preflight', 'not_implemented']),
  validator: z.string(),
  documentType: z.string().optional(),
  rootElement: z.string().optional(),
  issues: z.array(issueSchema),
  note: z.string(),
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
        'returns XSD, schematron and terminology issues. Documents with a DOCTYPE, entity declarations or ' +
        'XInclude are refused. Preview: only the pre-flight checks run until the full validator is wired; ' +
        'the result status says so. Use only synthetic or anonymised documents.',
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
      const base = {
        validator: deps.validator.name,
        notice: UNTRUSTED_DATA_NOTICE,
        ...(preflight.rootElement ? { rootElement: preflight.rootElement } : {}),
      };

      if (!preflight.ok) {
        return toolResult<ValidateCdaOutput>({
          ...base,
          status: 'rejected_preflight',
          issues: preflightIssues,
          note: 'The document was refused before parsing. Fix the preflight errors and validate again.',
        });
      }

      const result = await deps.validator.validate(xml, {
        signal: AbortSignal.timeout(VALIDATION_TIMEOUT_MS),
      });
      deps.logger.info('validate_cda completed', { status: result.status, issues: result.issues.length });

      return toolResult<ValidateCdaOutput>({
        ...base,
        status: result.status,
        ...(result.documentType ? { documentType: result.documentType } : {}),
        issues: [...preflightIssues, ...result.issues],
        note:
          result.status === 'not_implemented'
            ? 'Full XSD/schematron validation is not implemented yet: only the pre-flight checks ran. ' +
              'Use explain_schematron_error with the gateway error message in the meantime.'
            : 'Validation ran locally with bundled rules.',
      });
    }),
  );
}
