import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod';
import { CODE_SYSTEM_NAMES, CODE_SYSTEMS, SAMPLE_CODES } from '../data/sample-dictionary.js';
import { MAX_LOOKUP_QUERY_CHARS, MAX_LOOKUP_RESULTS } from '../limits.js';
import { type Logger } from '../log.js';
import { READ_ONLY_ANNOTATIONS, safeHandler, toolResult } from './common.js';

export const lookupInput = z.object({
  system: z.enum(CODE_SYSTEM_NAMES).describe('Code system to search.'),
  query: z
    .string()
    .trim()
    .min(1)
    .max(MAX_LOOKUP_QUERY_CHARS)
    .describe('An exact code (for example "11502-2") or words to search in the display name.'),
  limit: z.number().int().min(1).max(MAX_LOOKUP_RESULTS).default(10).describe('Maximum number of results.'),
});

export const lookupOutput = z.object({
  system: z.string(),
  codeSystemOid: z.string(),
  results: z.array(z.object({ code: z.string(), display: z.string(), match: z.enum(['code', 'text']) })),
  totalMatches: z.number().int(),
  sampleData: z.boolean(),
  note: z.string(),
});

export type LookupOutput = z.infer<typeof lookupOutput>;

export function registerLookupCode(server: McpServer, deps: { logger: Logger }) {
  server.registerTool(
    'lookup_code',
    {
      title: 'Look up a code in the FSE dictionaries',
      description:
        'Looks up a code, or searches display names, in the terminologies used by FSE 2.0 CDA2 documents ' +
        `(${CODE_SYSTEM_NAMES.join(', ')}) and returns the code system OID to use in @codeSystem.`,
      inputSchema: lookupInput,
      outputSchema: lookupOutput,
      annotations: { title: 'Look up a code', ...READ_ONLY_ANNOTATIONS },
    },
    safeHandler('lookup_code', deps.logger, ({ system, query, limit }) => {
      const info = CODE_SYSTEMS[system];
      const entries = SAMPLE_CODES[system];
      const needle = query.toLowerCase();
      const byCode = entries.filter((e) => e.code.toLowerCase() === needle);
      const words = needle.split(/\s+/).filter(Boolean);
      const byText = entries.filter(
        (e) => !byCode.includes(e) && words.every((w) => e.display.toLowerCase().includes(w)),
      );
      const all = [
        ...byCode.map((e) => ({ ...e, match: 'code' as const })),
        ...byText.map((e) => ({ ...e, match: 'text' as const })),
      ];
      return toolResult<LookupOutput>({
        system: info.name,
        codeSystemOid: info.oid,
        results: all.slice(0, limit),
        totalMatches: all.length,
        sampleData: true,
        note:
          'Searched a small bundled SAMPLE of the dictionary, not the full catalog: a missing code does not mean ' +
          'the code is invalid. Full dictionaries from it-fse-catalogs are on the roadmap.',
      });
    }),
  );
}
