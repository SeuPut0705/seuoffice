/**
 * Exporting a skill as `<name>.zip`: the folder as it is under a top folder
 * named after the skill, without the GitHub source record, with the template
 * warning flag, and readable again by the zip import.
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import JSZip from 'jszip'
import { afterEach, describe, expect, it } from 'vitest'
import {
  IEUM_SOURCE_FILE,
  SkillImportError,
  disposeSkillImport,
  exportSkillZip,
  prepareZipImport,
  skillExportInfo,
} from '../src/user-skills'

const roots: string[] = []
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'user-skills-export-'))
  roots.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function writeTree(base: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    const path = join(base, ...rel.split('/'))
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, text)
  }
}

function skill(template?: string): Record<string, string> {
  const meta = template ? `metadata:\n  ieum-template: ${template}\n` : ''
  return {
    'SKILL.md': `---\nname: report\ndescription: Weekly report\n${meta}---\nFill it.\n`,
    'ref/notes.md': 'notes',
    [IEUM_SOURCE_FILE]: '{"kind":"github"}',
  }
}

describe('exportSkillZip', () => {
  it('writes the folder under the skill name, leaving out the source record', async () => {
    const dir = join(temp(), 'report')
    writeTree(dir, skill())
    const out = join(temp(), 'report.zip')
    const info = await exportSkillZip(dir, out)
    expect(info).toMatchObject({
      name: 'report',
      fileName: 'report.zip',
      includesTemplate: false,
      files: 2,
    })
    const zip = await JSZip.loadAsync(readFileSync(out))
    const names = Object.values(zip.files)
      .filter((file) => !file.dir)
      .map((file) => file.name)
      .sort()
    expect(names).toEqual(['report/SKILL.md', 'report/ref/notes.md'])
    expect(readdirSync(dirname(out))).toEqual(['report.zip'])
  })

  it('says when a template document goes in', async () => {
    const dir = join(temp(), 'report')
    writeTree(dir, { ...skill('assets/form.docx'), 'assets/form.docx': 'doc' })
    expect((await skillExportInfo(dir)).includesTemplate).toBe(true)
    const missing = join(temp(), 'report')
    writeTree(missing, skill('assets/form.docx'))
    expect((await skillExportInfo(missing)).includesTemplate).toBe(false)
  })

  it('is read back by the zip import', async () => {
    const dir = join(temp(), 'report')
    writeTree(dir, skill())
    const out = join(temp(), 'report.zip')
    await exportSkillZip(dir, out)
    const app = join(temp(), 'skills')
    const imported = await prepareZipImport({ file: out, appSkillsDir: app, tempDir: temp() })
    expect(imported.candidates.map((c) => [c.key, c.name, c.files])).toEqual([
      ['report', 'report', 2],
    ])
    await disposeSkillImport(imported)
  })

  it('refuses a folder over the size limit and leaves no file', async () => {
    const dir = join(temp(), 'report')
    writeTree(dir, { ...skill(), 'big.txt': 'x'.repeat(5000) })
    const out = join(temp(), 'report.zip')
    await expect(exportSkillZip(dir, out, { files: 100, bytes: 1000 })).rejects.toBeInstanceOf(
      SkillImportError,
    )
    expect(readdirSync(dirname(out))).toEqual([])
  })
})
