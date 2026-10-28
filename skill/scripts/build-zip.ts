/**
 * Builds the ZIP to upload to Agensi: one folder named like the skill, with SKILL.md and references/.
 *
 *   node skill/scripts/build-zip.ts
 *
 * Writes `skill/dist/fse-cda-triage.zip`. Before zipping it checks the SKILL.md frontmatter against the Agensi
 * rules (`name` in lowercase letters, digits and hyphens and equal to the folder name, a `description` of one
 * to three sentences). The archive is deterministic: entries in a fixed order with a fixed timestamp, so the
 * same files always give the same bytes. Only Node built-ins are used; nothing is downloaded.
 */
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { crc32, deflateRawSync } from 'node:zlib';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const SKILL_DIR = join(REPO_ROOT, 'skill', 'fse-cda-triage');
export const ZIP_PATH = join(REPO_ROOT, 'skill', 'dist', 'fse-cda-triage.zip');

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface Frontmatter {
  fields: Record<string, string>;
  body: string;
}

/** Parses the YAML frontmatter of SKILL.md: plain `key: value` lines, values optionally quoted. */
export function parseFrontmatter(text: string): Frontmatter {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (!match) throw new Error('SKILL.md must start with a frontmatter block between --- lines');
  const fields: Record<string, string> = {};
  for (const line of (match[1] ?? '').split('\n')) {
    if (line.trim() === '') continue;
    const field = /^([a-z][a-z_-]*):\s*(.*)$/.exec(line);
    if (!field) throw new Error(`Unsupported frontmatter line: ${line}`);
    const raw = (field[2] ?? '').trim();
    const quoted = /^(["'])(.*)\1$/.exec(raw);
    fields[field[1] ?? ''] = quoted ? (quoted[2] ?? '') : raw;
  }
  return { fields, body: match[2] ?? '' };
}

/** Returns the problems of a SKILL.md for the folder `folderName`; empty when it follows the rules. */
export function checkSkill(text: string, folderName: string): string[] {
  const problems: string[] = [];
  let parsed: Frontmatter;
  try {
    parsed = parseFrontmatter(text);
  } catch (error) {
    return [(error as Error).message];
  }
  const { name, description } = parsed.fields;
  if (!name) problems.push('missing name');
  else if (!NAME.test(name)) problems.push('name must use lowercase letters, digits and hyphens only');
  else if (name !== folderName) problems.push(`name "${name}" differs from the folder "${folderName}"`);
  if (!description) problems.push('missing description');
  else {
    const sentences = description.split(/(?<=[.!?])\s+(?=[A-Z"'“])/).filter((s) => s.trim() !== '');
    if (sentences.length > 3) problems.push(`description has ${sentences.length} sentences, at most 3`);
  }
  if (parsed.body.trim() === '') problems.push('empty body');
  return problems;
}

function listFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => !name.startsWith('.'))
    .sort()
    .flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? [path + sep, ...listFiles(path)] : [path];
    });
}

// 1980-01-01 00:00:00 in MS-DOS format: the earliest representable time, used for every entry.
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;

/** Builds the archive in memory. Entries are `<folder>/…`, directories included. */
export function buildZip(skillDir: string): Buffer {
  const folder = basename(skillDir);
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  // The folder itself comes first, so that every unzip tool recreates it even before any file.
  for (const path of [skillDir + sep, ...listFiles(skillDir)]) {
    const isDir = path.endsWith(sep);
    const inner = relative(skillDir, path).split(sep).join('/');
    const name = Buffer.from(inner === '' ? `${folder}/` : `${folder}/${inner}${isDir ? '/' : ''}`);
    const data = isDir ? Buffer.alloc(0) : readFileSync(path);
    const packed = isDir ? data : deflateRawSync(data, { level: 9 });
    const method = isDir ? 0 : 8;
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed: 2.0
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, packed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // made by: Unix, 2.0 (keeps the permissions below)
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    // Unix mode in the high 16 bits: 0755 directories (plus the MS-DOS directory flag), 0644 files.
    central.writeUInt32LE((isDir ? (0o040755 << 16) | 0x10 : 0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + packed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(centrals.length / 2, 8);
  end.writeUInt16LE(centrals.length / 2, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

function main(): number {
  const problems = checkSkill(readFileSync(join(SKILL_DIR, 'SKILL.md'), 'utf8'), basename(SKILL_DIR));
  if (problems.length > 0) {
    process.stderr.write(`SKILL.md does not follow the Agensi rules:\n- ${problems.join('\n- ')}\n`);
    return 1;
  }
  const zip = buildZip(SKILL_DIR);
  mkdirSync(join(ZIP_PATH, '..'), { recursive: true });
  writeFileSync(ZIP_PATH, zip);
  process.stdout.write(`wrote ${ZIP_PATH} (${zip.length} bytes)\n`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = main();
