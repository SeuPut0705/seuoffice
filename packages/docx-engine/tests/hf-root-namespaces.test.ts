import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { parseDocx, saveDocx, withheldLabelOf, type SaveBlock } from '../src/index'
import {
  hiddenStoriesDocx,
  LABEL,
  OWN_REDACT_NS,
  PLAIN_PICTURE_ALT,
  SECRET,
} from './helpers/hidden-stories'

/** every prefix the part uses on an element or an attribute is declared in it */
function unboundPrefixes(xml: string): string[] {
  const declared = new Set([...xml.matchAll(/\sxmlns:([\w.-]+)\s*=/g)].map((m) => m[1]!))
  declared.add('xml')
  const used = new Set<string>()
  for (const tag of xml.match(/<[^!?/][^>]*>/g) ?? []) {
    const name = /^<([\w.-]+):/.exec(tag)?.[1]
    if (name) used.add(name)
    for (const m of tag.matchAll(/\s([\w.-]+):[\w.-]+\s*=/g)) if (m[1] !== 'xmlns') used.add(m[1]!)
  }
  return [...used].filter((prefix) => !declared.has(prefix))
}

async function editedHeader(edit: (xml: string) => string = (xml) => xml) {
  const dir = mkdtempSync(join(tmpdir(), 'hf-root-'))
  const file = await hiddenStoriesDocx(dir, OWN_REDACT_NS, 'h.docx', 'go', { pictures: true })
  const parsed = await parseDocx(new Uint8Array(readFileSync(file)))
  const paras = parsed.headerParas!.map((p) => ({
    ...p,
    runs: p.runs.map((r) => (r.text === 'Head ' ? { ...r, text: 'Report ' } : r)),
  }))
  const saved = await saveDocx(
    parsed,
    parsed.blocks
      .filter((b) => !b.hidden)
      .map((b): SaveBlock => ({ kind: 'original', docxIndex: b.docxIndex! })),
    { header: { text: 'Report ', paras } },
  )
  const zip = await JSZip.loadAsync(saved)
  const header = edit(await zip.file('word/header1.xml')!.async('string'))
  return { header, saved }
}

describe('a header rewritten around its pictures', () => {
  it('declares every prefix its kept content uses', async () => {
    const { header } = await editedHeader()
    expect(header).toContain('Report ')
    expect(unboundPrefixes(header)).toEqual([])
  })

  it('keeps the plain picture, and the hidden one once, still marked', async () => {
    const { header, saved } = await editedHeader()
    // docPr name, descr, title and cNvPr name, descr: five times each, once per picture
    expect(header.split(PLAIN_PICTURE_ALT).length - 1).toBe(5)
    expect(header.split('<w:drawing>').length - 1).toBe(2)
    expect(header.split(`${SECRET}PH`).length - 1).toBe(5)
    const reparsed = await parseDocx(saved)
    const pictures = reparsed.headerParas!.flatMap((p) => p.runs).filter((r) => r.image)
    expect(pictures.map((r) => withheldLabelOf(r.rawRPr))).toEqual([LABEL, null])
  })
})
