/**
 * Regenerates `skill/fse-cda-triage/references/` from a local it-fse-catalogs checkout, so that the skill only
 * quotes text that is in the official catalogs.
 *
 *   node skill/scripts/generate-references.ts [--catalogs <dir>] [--check]
 *
 * The catalogs folder defaults to `FSE_MCP_CATALOGS_DIR`, then to `../fse-client/vendor/it-fse-catalogs` next to
 * this repository (made by `pnpm sync:catalogs` in fse-client). `--check` writes nothing and exits with 1 when
 * the files on disk differ from what the catalogs produce.
 *
 * Output is deterministic: no timestamps, files and rows in a fixed order. Official text is copied verbatim
 * except that runs of whitespace become one space and XML entities are decoded. Everything this script adds
 * around it (headings, notes, the "fse-mcp note" column) is labelled as ours.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const REFERENCES_DIR = join(REPO_ROOT, 'skill', 'fse-cda-triage', 'references');
export const DEFAULT_CATALOGS_DIR =
  process.env.FSE_MCP_CATALOGS_DIR || join(REPO_ROOT, '..', 'fse-client', 'vendor', 'it-fse-catalogs');

const LAB_SCHEMATRON = 'schematronFSE_LAB_v27.1.sch';
const LOINC_OID = '2.16.840.1.113883.6.1';
const GENERATED_BY = 'skill/scripts/generate-references.ts';

/** Same rule prefix as `src/fse-validator.ts`: `ERRORE-28|`, `ERORE-b12|`, `ERRORE 8|`, `W002 |`… */
const RULE_ID = /^\s*([A-Za-z]{1,10}[- ]?[A-Za-z]?\d[A-Za-z0-9.]{0,6})\s*\|/;

/**
 * Names of well-known international code systems, written by us and not taken from the catalogs. Only systems
 * whose OID we are certain of; everything else is left blank rather than guessed.
 */
const OUR_CODE_SYSTEM_NOTES: Record<string, string> = {
  '2.16.840.1.113883.6.1': 'LOINC',
  '2.16.840.1.113883.6.3': 'ICD-10',
  '2.16.840.1.113883.6.8': 'UCUM',
  '2.16.840.1.113883.6.73': 'WHO ATC',
  '2.16.840.1.113883.6.96': 'SNOMED CT',
  '2.16.840.1.113883.6.103': 'ICD-9-CM (diagnoses)',
  '2.16.840.1.113883.6.104': 'ICD-9-CM (procedures)',
  '2.16.840.1.113883.5.1': 'HL7 AdministrativeGender',
  '2.16.840.1.113883.5.4': 'HL7 ActCode',
  '2.16.840.1.113883.5.7': 'HL7 ActPriority',
  '2.16.840.1.113883.5.25': 'HL7 Confidentiality',
  '2.16.840.1.113883.5.83': 'HL7 ObservationInterpretation',
  '2.16.840.1.113883.5.111': 'HL7 RoleCode',
  '2.16.840.1.113883.5.139': 'HL7 TimingEvent',
  '2.16.840.1.113883.5.1063': 'HL7 ObservationValue',
};

interface Check {
  kind: 'assert' | 'report';
  ruleId: string | undefined;
  test: string;
  message: string;
}

interface Rule {
  context: string;
  lets: { name: string; value: string }[];
  checks: Check[];
}

interface Schematron {
  file: string;
  sha256: string;
  /** From the `<!-- schematron versione: … -->` comment, when present. */
  version: string | undefined;
  title: string | undefined;
  rules: Rule[];
}

const ATTRIBUTE = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
/** An element's attributes, allowing `>` inside quoted values (tests contain `>=`). */
const ATTRS = `((?:[^>"']|"[^"]*"|'[^']*')*)`;

function attributes(source: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of source.matchAll(ATTRIBUTE)) out[m[1] ?? ''] = decode(m[2] ?? m[3] ?? '');
  return out;
}

function decode(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');
}

const squash = (text: string) => text.replace(/\s+/g, ' ').trim();

/** Parses the parts of a schematron this script needs. Commented-out rules are ignored, as by the engine. */
export function parseSchematron(file: string, source: string): Schematron {
  const version = /<!--\s*schematron versione:\s*([^\s-][^-]*?)\s*-->/i.exec(source)?.[1];
  const live = source.replace(/<!--[\s\S]*?-->/g, '');
  const title = /<title>([\s\S]*?)<\/title>/.exec(live)?.[1];
  const rules: Rule[] = [];
  for (const rule of live.matchAll(new RegExp(`<rule\\b${ATTRS}>([\\s\\S]*?)</rule>`, 'g'))) {
    const body = rule[2] ?? '';
    const lets = [...body.matchAll(new RegExp(`<let\\b${ATTRS}/>`, 'g'))].map((m) => {
      const a = attributes(m[1] ?? '');
      return { name: a.name ?? '', value: squash(a.value ?? '') };
    });
    const checks = [...body.matchAll(new RegExp(`<(assert|report)\\b${ATTRS}>([\\s\\S]*?)</\\1>`, 'g'))].map(
      (m): Check => {
        const message = squash(decode(m[3] ?? ''));
        return {
          kind: m[1] === 'report' ? 'report' : 'assert',
          ruleId: RULE_ID.exec(message)?.[1],
          test: squash(attributes(m[2] ?? '').test ?? ''),
          message,
        };
      },
    );
    rules.push({ context: squash(attributes(rule[1] ?? '').context ?? ''), lets, checks });
  }
  return {
    file,
    sha256: createHash('sha256').update(source).digest('hex'),
    version,
    title: title === undefined ? undefined : squash(decode(title)),
    rules,
  };
}

/** A markdown table cell holding `text` verbatim as a code span. */
function code(text: string): string {
  if (text === '') return '';
  const fence = text.includes('`') ? '``' : '`';
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${text.replace(/\|/g, '\\|')}${pad}${fence}`;
}

function provenance(commit: string, files: string): string {
  return [
    `> Generated by \`${GENERATED_BY}\` in the fse-mcp repository. Do not edit by hand: run the script again.`,
    `> Source: [it-fse-catalogs](https://github.com/ministero-salute/it-fse-catalogs) at commit \`${commit}\`, ${files}.`,
    '> Official text is verbatim, except that runs of whitespace are collapsed to one space and XML entities',
    '> are decoded. Headings, notes and columns marked "fse-mcp note" are ours, not official.',
    '> This is unofficial material, not affiliated with the Italian Ministry of Health.',
  ].join('\n');
}

const LOINC_NOTICE = [
  '## LOINC notice',
  '',
  'Reproduced from `LOINC_short_license.txt` in it-fse-catalogs:',
  '',
  '> This material contains content from LOINC (http://loinc.org).',
  '> LOINC is copyright © 1995-2023, Regenstrief Institute, Inc.',
  '> and the Logical Observation Identifiers Names and Codes (LOINC) Committee',
  '> and is available at no cost under the license at http://loinc.org/license.',
  '> LOINC® is a registered United States trademark of Regenstrief Institute, Inc.',
].join('\n');

function labRules(lab: Schematron, commit: string): string {
  const out = [
    '# Referto di Laboratorio: official schematron rules',
    '',
    provenance(commit, `file \`schematron/${lab.file}\` (SHA-256 \`${lab.sha256}\`)`),
    '',
    `Schematron version (from its header comment): \`${lab.version ?? 'not stated'}\`. ` +
      `Title (verbatim): ${lab.title ? code(lab.title) : 'none'}.`,
    '',
    '## How to read this file (fse-mcp note)',
    '',
    '- Rules are grouped by their `context`: the XPath of the element they are evaluated on.',
    '- `assert` fails when its test is false; `report` fires when its test is true.',
    '- `Rule id` is the prefix before `|` in the official message; it is empty when the message has none.',
    '- `<name/>` and `<value-of …/>` inside a message are schematron markup: the gateway replaces them with the',
    '  name or a value of the failing node, so the message it returns differs from the text here in those spots.',
    '- `$name` in a test is a variable declared with `<let>` in the same rule, listed under the heading.',
    '- Messages prefixed `W` are reported as warnings by the fse-mcp validator; all others as errors.',
    '- Rule ids are local to this schematron: the same id means something else for another document type.',
  ];
  lab.rules.forEach((rule, index) => {
    out.push('', `## ${index + 1}. Context ${code(rule.context)}`, '');
    if (rule.lets.length > 0) {
      out.push('Variables:', '');
      for (const l of rule.lets) out.push(`- ${code(`$${l.name}`)} = ${code(l.value)}`);
      out.push('');
    }
    out.push('| Rule id | Type | Official message | Test |', '| --- | --- | --- | --- |');
    for (const c of rule.checks) {
      out.push(`| ${c.ruleId ?? ''} | ${c.kind} | ${code(c.message)} | ${code(c.test)} |`);
    }
  });
  out.push('', LOINC_NOTICE, '');
  return out.join('\n');
}

const TEMPLATE_ROOT = /hl7:templateId\[@root\s*=\s*'([0-9.]+)'\]/g;
const DOCUMENT_CODE = /hl7:code\[@code\s*=\s*'([^']+)'\]\[@codeSystem\s*=\s*'([0-9.]+)'\]/g;

function documentTypes(schematrons: Schematron[], commit: string): string {
  const out = [
    '# Document types: templateId, document code and schematron',
    '',
    provenance(commit, `every file in \`schematron/\``),
    '',
    '## How to read this file (fse-mcp note)',
    '',
    '- Values are extracted mechanically from the tests of the rule whose context is `hl7:ClinicalDocument`:',
    '  `hl7:templateId[@root=…]` gives the templateId roots, `hl7:code[@code=…][@codeSystem=…]` the document',
    '  code. The rule ids they come from are listed so that each value can be checked in the `.sch`.',
    `- A code with codeSystem \`${LOINC_OID}\` is a LOINC code.`,
    '- An empty cell means the extractor found nothing in that shape: read the `.sch`, do not guess.',
    '- The version in the file name and the one in the header comment can differ; both are shown as found.',
    '- Match a document by both its `ClinicalDocument/templateId/@root` and `ClinicalDocument/code/@code`.',
    '',
    '| Schematron | Version (header comment) | Title (verbatim) | templateId root | Document code (codeSystem) | From rules |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  for (const sch of schematrons) {
    const roots = new Set<string>();
    const codes = new Set<string>();
    const ids = new Set<string>();
    for (const rule of sch.rules.filter((r) => r.context === 'hl7:ClinicalDocument')) {
      for (const c of rule.checks) {
        let used = false;
        for (const m of c.test.matchAll(TEMPLATE_ROOT)) {
          roots.add(m[1] ?? '');
          used = true;
        }
        for (const m of c.test.matchAll(DOCUMENT_CODE)) {
          codes.add(`${m[1]} (${m[2]})`);
          used = true;
        }
        if (used && c.ruleId) ids.add(c.ruleId);
      }
    }
    out.push(
      `| \`${sch.file}\` | ${sch.version ? code(sch.version) : ''} | ${sch.title ? code(sch.title) : ''} | ` +
        `${[...roots].map(code).join('<br>')} | ${[...codes].map(code).join('<br>')} | ${[...ids].join(', ')} |`,
    );
  }
  out.push('', LOINC_NOTICE, '');
  return out.join('\n');
}

const CODE_SYSTEM_IN_TEST = /@codeSystem\s*=\s*'([0-9]+(?:\.[0-9]+)+)'/gi;

function codeSystems(schematrons: Schematron[], commit: string): string {
  const usage = new Map<string, Set<string>>();
  for (const sch of schematrons) {
    for (const rule of sch.rules) {
      for (const c of rule.checks) {
        for (const m of c.test.matchAll(CODE_SYSTEM_IN_TEST)) {
          const oid = m[1] ?? '';
          if (!usage.has(oid)) usage.set(oid, new Set());
          usage.get(oid)?.add(sch.file);
        }
      }
    }
  }
  const named = (oid: string) => {
    // A name written in an official message right before this OID, e.g. "LOINC @codeSystem='2.16…'".
    const pattern = new RegExp(
      `\\b([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*)\\s*\\(?\\s*@?code[Ss]ystem\\s*=\\s*['"]?${oid.replace(/\./g, '\\.')}(?![0-9.])`,
    );
    for (const sch of schematrons) {
      for (const rule of sch.rules) {
        for (const c of rule.checks) {
          const m = pattern.exec(c.message);
          if (m) return `${code(m[1] ?? '')} (${sch.file}${c.ruleId ? ` ${c.ruleId}` : ''})`;
        }
      }
    }
    return '';
  };
  const shortestMessage = (oid: string) => {
    const mentions = new RegExp(`${oid.replace(/\./g, '\\.')}(?![0-9.])`);
    let best: { text: string; ref: string } | undefined;
    for (const sch of schematrons) {
      for (const rule of sch.rules) {
        for (const c of rule.checks) {
          if (mentions.test(c.message) && (!best || c.message.length < best.text.length)) {
            best = { text: c.message, ref: `${sch.file}${c.ruleId ? ` ${c.ruleId}` : ''}` };
          }
        }
      }
    }
    return best ? `${code(best.text)} (${best.ref})` : '';
  };
  const oids = [...usage.keys()].sort((a, b) => {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pa[i] ?? -1) - (pb[i] ?? -1);
      if (d !== 0) return d;
    }
    return 0;
  });
  const out = [
    '# Code systems referenced by the schematrons',
    '',
    provenance(commit, `every file in \`schematron/\``),
    '',
    '## How to read this file (fse-mcp note)',
    '',
    "- One row per OID found as `@codeSystem='…'` in a rule test of any schematron, in OID order.",
    '- "Name in an official message" is the word written right before that OID in a schematron message, with',
    '  the file and rule it comes from. Empty when no message names the system that way.',
    '- "Shortest official message" is the shortest schematron message that mentions the OID, verbatim, with',
    '  its file and rule: it shows what the rules use the system for. Empty when only tests mention it.',
    `- "LAB" says whether \`${LAB_SCHEMATRON}\` uses the system in a test.`,
    '- "fse-mcp note" is our own label for well-known international systems. It is not from the catalogs and',
    '  is left empty where we are not certain.',
    '- The it-fse-catalogs checkout used here contains no terminology files: this table says which systems the',
    '  rules expect, not which codes they contain.',
    '',
    '| OID | Name in an official message | fse-mcp note (unofficial) | LAB | Used by | Shortest official message |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  for (const oid of oids) {
    const files = [...(usage.get(oid) ?? [])].sort();
    const usedBy = files.length > 3 ? `${files.length} schematrons` : files.map((f) => `\`${f}\``).join(', ');
    const lab = files.includes(LAB_SCHEMATRON) ? 'yes' : '';
    out.push(
      `| \`${oid}\` | ${named(oid)} | ${OUR_CODE_SYSTEM_NOTES[oid] ?? ''} | ${lab} | ${usedBy} | ${shortestMessage(oid)} |`,
    );
  }
  out.push('', LOINC_NOTICE, '');
  return out.join('\n');
}

/** Builds the reference files (name to contents) from a catalogs checkout. */
export function generateReferences(catalogsDir: string): Map<string, string> {
  const commit = readFileSync(join(catalogsDir, '.fse-catalogs-commit'), 'utf8').trim();
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('Invalid .fse-catalogs-commit marker');
  const dir = join(catalogsDir, 'schematron');
  const schematrons = readdirSync(dir)
    .filter((f) => f.endsWith('.sch'))
    .sort()
    .map((f) => parseSchematron(f, readFileSync(join(dir, f), 'utf8')));
  const lab = schematrons.find((s) => s.file === LAB_SCHEMATRON);
  if (!lab) throw new Error(`${LAB_SCHEMATRON} not found in ${dir}`);
  return new Map([
    ['lab-schematron-rules.md', labRules(lab, commit)],
    ['document-types.md', documentTypes(schematrons, commit)],
    ['code-systems.md', codeSystems(schematrons, commit)],
  ]);
}

function main(): number {
  const { values } = parseArgs({
    options: { catalogs: { type: 'string' }, check: { type: 'boolean', default: false } },
    strict: true,
  });
  const files = generateReferences(values.catalogs ?? DEFAULT_CATALOGS_DIR);
  let stale = 0;
  for (const [name, contents] of files) {
    const path = join(REFERENCES_DIR, name);
    if (values.check) {
      let current: string | undefined;
      try {
        current = readFileSync(path, 'utf8');
      } catch {
        current = undefined;
      }
      if (current !== contents) {
        stale++;
        process.stderr.write(`out of date: ${path}\n`);
      }
    } else {
      writeFileSync(path, contents);
      process.stdout.write(`wrote ${path}\n`);
    }
  }
  return stale === 0 ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = main();
