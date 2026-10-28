import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { buildZip, checkSkill, parseFrontmatter, SKILL_DIR } from '../skill/scripts/build-zip.js';
import {
  DEFAULT_CATALOGS_DIR,
  generateReferences,
  REFERENCES_DIR,
} from '../skill/scripts/generate-references.js';

const skillMd = readFileSync(join(SKILL_DIR, 'SKILL.md'), 'utf8');
const catalogsAvailable = existsSync(join(DEFAULT_CATALOGS_DIR, '.fse-catalogs-commit'));

/** Entry names and contents of a ZIP, read from its central directory. */
function readZip(zip: Buffer): Map<string, Buffer> {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const entries = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    const method = zip.readUInt16LE(at + 10);
    const size = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    const offset = zip.readUInt32LE(at + 42);
    const name = zip.toString('utf8', at + 46, at + 46 + nameLength);
    const dataStart = offset + 30 + zip.readUInt16LE(offset + 26) + zip.readUInt16LE(offset + 28);
    const data = zip.subarray(dataStart, dataStart + size);
    entries.set(name, method === 8 ? inflateRawSync(data) : Buffer.from(data));
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

describe('skill package', () => {
  it('has a frontmatter that follows the Agensi rules', () => {
    expect(checkSkill(skillMd, basename(SKILL_DIR))).toEqual([]);
    const { fields } = parseFrontmatter(skillMd);
    expect(fields.name).toBe('fse-cda-triage');
    expect(Object.keys(fields).sort()).toEqual(['allowed-tools', 'description', 'name', 'when_to_use']);
  });

  it('rejects a name that differs from the folder or uses other characters', () => {
    const withName = (name: string) => skillMd.replace(/^name: .*$/m, `name: ${name}`);
    expect(checkSkill(withName('other-skill'), 'fse-cda-triage')).toContain(
      'name "other-skill" differs from the folder "fse-cda-triage"',
    );
    expect(checkSkill(withName('FSE_Triage'), 'FSE_Triage')).toContain(
      'name must use lowercase letters, digits and hyphens only',
    );
  });

  it('states what it is, how it treats health data and what it depends on', () => {
    expect(skillMd).toMatch(/Unofficial material/);
    expect(skillMd).toMatch(/GDPR/);
    expect(skillMd).toMatch(/art\.\s*9/);
    expect(skillMd).toMatch(/synthetic or anonymised/);
    expect(skillMd).toMatch(/makes no network calls/);
    expect(skillMd).toMatch(/proprietary licence from Saxonica/);
    expect(skillMd).toMatch(/does not validate documents by itself/);
  });

  it('links only to files that exist in the package', () => {
    const links = [...skillMd.matchAll(/\]\((?!https?:)([^)]+)\)/g)].map((m) => m[1] ?? '');
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) expect(existsSync(join(SKILL_DIR, link)), link).toBe(true);
  });

  it.skipIf(!catalogsAvailable)('has references identical to what the catalogs generate', () => {
    const generated = generateReferences(DEFAULT_CATALOGS_DIR);
    expect(readdirSync(REFERENCES_DIR).sort()).toEqual([...generated.keys()].sort());
    for (const [name, contents] of generated) {
      expect(readFileSync(join(REFERENCES_DIR, name), 'utf8'), name).toBe(contents);
    }
  });

  it('zips one folder with SKILL.md and the references, deterministically', () => {
    const zip = buildZip(SKILL_DIR);
    expect(buildZip(SKILL_DIR).equals(zip)).toBe(true);
    const entries = readZip(zip);
    expect([...entries.keys()].sort()).toEqual([
      'fse-cda-triage/',
      'fse-cda-triage/SKILL.md',
      'fse-cda-triage/references/',
      'fse-cda-triage/references/code-systems.md',
      'fse-cda-triage/references/document-types.md',
      'fse-cda-triage/references/lab-schematron-rules.md',
    ]);
    expect(entries.get('fse-cda-triage/SKILL.md')?.toString('utf8')).toBe(skillMd);
  });
});
