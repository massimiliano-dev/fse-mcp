import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod';
import { SCHEMATRON_EXPLANATIONS, type SchematronExplanation } from '../data/schematron-explanations.js';
import { MAX_ERROR_MESSAGE_CHARS } from '../limits.js';
import { type Logger } from '../log.js';
import { READ_ONLY_ANNOTATIONS, safeHandler, toolResult } from './common.js';

export const explainInput = z.object({
  error: z
    .string()
    .min(1)
    .max(MAX_ERROR_MESSAGE_CHARS)
    .describe(
      'The error message or rule id returned by the FSE gateway or a validator, for example ' +
        '"ERRORE-4| Almeno un elemento \'templateId\' ..." or "cvc-complex-type.2.4.a". Do not include patient data.',
    ),
});

const matchSchema = z.object({
  id: z.string(),
  schematron: z.string(),
  ruleId: z.string().optional(),
  officialMessage: z.string(),
  explanation: z.string(),
  fix: z.string(),
  matchedBy: z.enum(['ruleId', 'pattern']),
});

export const explainOutput = z.object({
  matched: z.boolean(),
  matches: z.array(matchSchema),
  note: z.string(),
});

export type ExplainOutput = z.infer<typeof explainOutput>;

const RULE_ID = /\b(ERRORE-[0-9]+[a-z]?|cvc-[a-z-]+(?:\.[0-9a-z]+)+)/i;
const MAX_MATCHES = 5;

/** Finds the explanations that apply to `message`. Exported for tests. */
export function findExplanations(
  message: string,
): Array<{ entry: SchematronExplanation; matchedBy: 'ruleId' | 'pattern' }> {
  const ruleId = RULE_ID.exec(message)?.[1]?.toLowerCase();
  const results: Array<{ entry: SchematronExplanation; matchedBy: 'ruleId' | 'pattern' }> = [];
  for (const entry of SCHEMATRON_EXPLANATIONS) {
    if (entry.patterns.some((p) => p.test(message))) results.push({ entry, matchedBy: 'pattern' });
    else if (ruleId && entry.ruleId?.toLowerCase() === ruleId) results.push({ entry, matchedBy: 'ruleId' });
  }
  // Pattern matches are more specific than a bare rule number, which is ambiguous across schematrons.
  results.sort((a, b) => (a.matchedBy === b.matchedBy ? 0 : a.matchedBy === 'pattern' ? -1 : 1));
  return results.slice(0, MAX_MATCHES);
}

export function registerExplainSchematronError(server: McpServer, deps: { logger: Logger }) {
  server.registerTool(
    'explain_schematron_error',
    {
      title: 'Explain an FSE validation error',
      description:
        'Explains in plain language an XSD or schematron error returned by the FSE 2.0 gateway for a CDA2 ' +
        'document, and suggests how to fix it. Input is the error message or rule id, not the document.',
      inputSchema: explainInput,
      outputSchema: explainOutput,
      annotations: { title: 'Explain an FSE validation error', ...READ_ONLY_ANNOTATIONS },
    },
    safeHandler('explain_schematron_error', deps.logger, ({ error }) => {
      const found = findExplanations(error);
      const ambiguous = found.length > 0 && found.every((f) => f.matchedBy === 'ruleId');
      // The submitted message is not echoed back: the client already has it.
      return toolResult<ExplainOutput>({
        matched: found.length > 0,
        matches: found.map(({ entry, matchedBy }) => ({
          id: entry.id,
          schematron: entry.schematron,
          ...(entry.ruleId ? { ruleId: entry.ruleId } : {}),
          officialMessage: entry.officialMessage,
          explanation: entry.explanation,
          fix: entry.fix,
          matchedBy,
        })),
        note:
          (found.length === 0
            ? 'No explanation is available for this message yet. '
            : ambiguous
              ? 'Matched by rule number only. ERRORE-n numbers differ between document types: check that the ' +
                'schematron named here is the one for your document. '
              : '') +
          'Explanations are a small hand-written example set, to be replaced by data derived from ' +
          'it-fse-catalogs.',
      });
    }),
  );
}
