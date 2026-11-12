/**
 * genoffice#2337 (move-range half): Accept/Reject All used to leave the range markers
 * of a whole-paragraph move in the untouched neighbouring paragraph. The
 * editor rebuilds the moved paragraph from its model (which does not carry
 * the markers), while the neighbour keeps its original bytes — including the
 * w:moveFromRangeEnd / w:moveToRangeEnd of the same range. The final save
 * drops markers whose partner is gone; a still-pending range is untouched.
 */
import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import {
  applyTrackedChangesXml,
  cleanMoveRangeMarkers,
  parseDocx,
  saveDocx,
  type ParsedDocFull,
  type SaveBlock,
} from '../src/index'
import { buildDocx } from './helpers/build-docx'

const ISSUE_BODY =
  '<w:p><w:r><w:t>P0 intro</w:t></w:r></w:p>' +
  '<w:p><w:moveFromRangeStart w:id="1" w:author="X" w:date="2026-01-01T00:00:00Z" w:name="move1"/>' +
  '<w:moveFrom w:id="2" w:author="X" w:date="2026-01-01T00:00:00Z"><w:r><w:t>P1 moved paragraph</w:t></w:r></w:moveFrom></w:p>' +
  '<w:p><w:moveFromRangeEnd w:id="1"/><w:r><w:t>P2 stays</w:t></w:r></w:p>' +
  '<w:p><w:moveToRangeStart w:id="3" w:author="X" w:date="2026-01-01T00:00:00Z" w:name="move1"/>' +
  '<w:moveTo w:id="4" w:author="X" w:date="2026-01-01T00:00:00Z"><w:r><w:t>P1 moved paragraph</w:t></w:r></w:moveTo></w:p>' +
  '<w:p><w:moveToRangeEnd w:id="3"/><w:r><w:t>P4 tail</w:t></w:r></w:p>'

const DOCUMENT_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
  ISSUE_BODY +
  '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>' +
  '<w:pgMar w:top="1440" w:right="1800" w:bottom="1440" w:left="1800" w:header="720" w:footer="720" w:gutter="0"/>' +
  '</w:sectPr></w:body></w:document>'

async function issueDocx(): Promise<Uint8Array> {
  const zip = new JSZip()
  const decl = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  zip.file(
    '[Content_Types].xml',
    decl +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      '</Types>',
  )
  zip.file(
    '_rels/.rels',
    decl +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      '</Relationships>',
  )
  zip.file('word/document.xml', DOCUMENT_XML)
  zip.forEach((_path, entry) => {
    entry.date = new Date(Date.UTC(2026, 0, 1))
  })
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
}

async function documentXmlOf(bytes: Uint8Array): Promise<string> {
  const zip = await JSZip.loadAsync(bytes)
  return zip.file('word/document.xml')!.async('string')
}

/** the save blocks of an accepted (or rejected) body: the two moved paragraphs are rewritten from the model */
function resolvedBlocks(mode: 'accept' | 'reject'): SaveBlock[] {
  const movedFrom =
    mode === 'accept' ? '<w:p/>' : '<w:p><w:r><w:t>P1 moved paragraph</w:t></w:r></w:p>'
  const movedTo =
    mode === 'reject' ? '<w:p/>' : '<w:p><w:r><w:t>P1 moved paragraph</w:t></w:r></w:p>'
  return [
    { kind: 'original', docxIndex: 0 },
    { kind: 'xml', xml: movedFrom },
    { kind: 'original', docxIndex: 2 },
    { kind: 'xml', xml: movedTo },
    { kind: 'original', docxIndex: 4 },
  ]
}

describe('move-range marker cleanup', () => {
  it('drops end markers whose start is gone (the accepted-move shape)', () => {
    const cleaned = cleanMoveRangeMarkers(
      '<w:p><w:moveFromRangeEnd w:id="1"/><w:r><w:t>x</w:t></w:r></w:p>' +
        '<w:p><w:moveToRangeEnd w:id="3"/></w:p>',
    )
    expect(cleaned.removed).toBe(2)
    expect(cleaned.xml).not.toContain('RangeEnd')
  })

  it('drops a start marker whose end is gone (defensive)', () => {
    const cleaned = cleanMoveRangeMarkers(
      '<w:p><w:moveFromRangeStart w:id="1" w:name="move1"/></w:p>',
    )
    expect(cleaned.removed).toBe(1)
    expect(cleaned.xml).not.toContain('RangeStart')
  })

  it('keeps a still-pending move range intact', () => {
    const xml =
      '<w:p><w:moveFromRangeStart w:id="1" w:name="move1"/></w:p><w:p><w:moveFromRangeEnd w:id="1"/></w:p>'
    const cleaned = cleanMoveRangeMarkers(xml)
    expect(cleaned.removed).toBe(0)
    expect(cleaned.xml).toBe(xml)
  })

  it('ignores unrelated range markers and documents without them', () => {
    const bookmark = '<w:p><w:bookmarkStart w:id="1" w:name="a"/><w:bookmarkEnd w:id="1"/></w:p>'
    expect(cleanMoveRangeMarkers(bookmark)).toEqual({ xml: bookmark, removed: 0 })
  })

  it('pairs sides independently: a shared id across moveFrom and moveTo is two broken ranges', () => {
    const xml =
      '<w:p><w:moveFromRangeStart w:id="1" w:name="m"/><w:r><w:t>a</w:t></w:r></w:p>' +
      '<w:p><w:moveToRangeEnd w:id="1"/><w:r><w:t>b</w:t></w:r></w:p>'
    const cleaned = cleanMoveRangeMarkers(xml)
    expect(cleaned.removed).toBe(2)
    expect(cleaned.xml).not.toMatch(/<w:move(?:From|To)Range(?:Start|End)\b/)
    expect(cleaned.xml).toContain('<w:t>a</w:t>')
    expect(cleaned.xml).toContain('<w:t>b</w:t>')
  })

  it('resolves interleaved ranges, keeping only the complete pair', () => {
    const xml =
      '<w:p><w:moveFromRangeStart w:id="1" w:name="m1"/>' +
      '<w:moveToRangeStart w:id="2" w:name="m2"/><w:r><w:t>a</w:t></w:r></w:p>' +
      '<w:p><w:moveFromRangeEnd w:id="1"/><w:r><w:t>b</w:t></w:r><w:moveToRangeEnd w:id="9"/></w:p>'
    const cleaned = cleanMoveRangeMarkers(xml)
    expect(cleaned.xml).toContain('<w:moveFromRangeStart w:id="1"')
    expect(cleaned.xml).toContain('<w:moveFromRangeEnd w:id="1"/>')
    expect(cleaned.xml).not.toContain('<w:moveToRangeStart ')
    expect(cleaned.xml).not.toContain('<w:moveToRangeEnd ')
  })

  it('a part whose only move markup is an orphan end is cleaned even with no revisions to apply', () => {
    const header =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      '<w:p><w:moveFromRangeEnd w:id="1"/><w:r><w:t>H stays</w:t></w:r></w:p>' +
      '</w:hdr>'
    const cleaned = applyTrackedChangesXml(header, 'accept')
    expect(cleaned.applied).toBe(0)
    expect(cleaned.remaining).toBe(0)
    expect(cleaned.xml).not.toMatch(/<w:move(?:From|To)Range(?:Start|End)\b/)
    expect(cleaned.xml).toContain('H stays')
  })
})

describe('applyTrackedChangesXml move ranges', () => {
  it('accept: moved text stays at the destination and no range marker survives', () => {
    const accepted = applyTrackedChangesXml(DOCUMENT_XML, 'accept')
    expect(accepted.applied).toBe(2)
    expect(accepted.remaining).toBe(0)
    expect(accepted.xml).not.toMatch(/<w:move(?:From|To)?[A-Za-z]*[\s/>]/)
    expect(accepted.xml).toContain('P2 stays')
    expect(accepted.xml).toContain('P4 tail')
    expect(accepted.xml.match(/P1 moved paragraph/g)).toHaveLength(1)
  })

  it('reject: moved text returns to the source and no range marker survives', () => {
    const rejected = applyTrackedChangesXml(DOCUMENT_XML, 'reject')
    expect(rejected.applied).toBe(2)
    expect(rejected.remaining).toBe(0)
    expect(rejected.xml).not.toMatch(/<w:move(?:From|To)?[A-Za-z]*[\s/>]/)
    expect(rejected.xml).toContain('P2 stays')
    expect(rejected.xml).toContain('P4 tail')
    expect(rejected.xml.match(/P1 moved paragraph/g)).toHaveLength(1)
  })
})

describe('saveDocx final package: move-range leftovers', () => {
  it('accept all leaves no move range marker behind', async () => {
    const parsed = await parseDocx(await issueDocx())
    const saved = await saveDocx(parsed, resolvedBlocks('accept'))
    const xml = await documentXmlOf(saved)
    expect(xml).not.toMatch(/<w:move(?:From|To)?[A-Za-z]*[\s/>]/)
    expect(xml.match(/P1 moved paragraph/g)).toHaveLength(1)
    expect(xml).toContain('P2 stays')
    expect(xml).toContain('P4 tail')
  })

  it('reject all leaves no move range marker behind', async () => {
    const parsed = await parseDocx(await issueDocx())
    const saved = await saveDocx(parsed, resolvedBlocks('reject'))
    const xml = await documentXmlOf(saved)
    expect(xml).not.toMatch(/<w:move(?:From|To)?[A-Za-z]*[\s/>]/)
    expect(xml.match(/P1 moved paragraph/g)).toHaveLength(1)
    expect(xml).toContain('P2 stays')
    expect(xml).toContain('P4 tail')
  })

  it('keeps a pending move range on an untouched save', async () => {
    const parsed = await parseDocx(await issueDocx())
    const blocks = parsed.blocks
      .filter((b) => !b.hidden && b.docxIndex !== null)
      .map((b) => ({ kind: 'original' as const, docxIndex: b.docxIndex! }))
    const saved = await saveDocx(parsed, blocks, { removePersonalInfo: false })
    const xml = await documentXmlOf(saved)
    expect(xml).toContain('<w:moveFromRangeStart w:id="1"')
    expect(xml).toContain('<w:moveFromRangeEnd w:id="1"/>')
    expect(xml).toContain('<w:moveToRangeStart w:id="3"')
    expect(xml).toContain('<w:moveToRangeEnd w:id="3"/>')
  })
})

/**
 * An unedited save returns the file it was given, whatever is malformed in it
 * (docx-engine AGENTS.md). The orphan sweep rides on a save that rewrites the
 * package anyway, or on an accept / reject that asks for it.
 */
describe('saveDocx: orphan move-range markers and the unedited save', () => {
  const MOVE_RANGE_MARKER = /<w:move(?:From|To)Range(?:Start|End)\b/
  const ORPHAN_BODY =
    '<w:p><w:r><w:t>P0 intro</w:t></w:r></w:p>' +
    '<w:p><w:moveFromRangeEnd w:id="1"/><w:r><w:t>P1 stays</w:t></w:r></w:p>' +
    '<w:p><w:moveToRangeStart w:id="7" w:author="X" w:date="2026-01-01T00:00:00Z" w:name="move7"/>' +
    '<w:r><w:t>P2 tail</w:t></w:r></w:p>'
  const ORPHAN_HEADER = '<w:p><w:moveFromRangeEnd w:id="1"/><w:r><w:t>H stays</w:t></w:r></w:p>'

  const untouched = (parsed: ParsedDocFull): SaveBlock[] =>
    parsed.blocks
      .filter((b) => !b.hidden && b.docxIndex !== null)
      .map((b) => ({ kind: 'original' as const, docxIndex: b.docxIndex! }))

  /** one real edit: the first paragraph is rewritten from the model */
  const firstParagraphEdited = (parsed: ParsedDocFull): SaveBlock[] =>
    untouched(parsed).map((block, i) =>
      i === 0
        ? { kind: 'generated', block: { type: 'paragraph', runs: [{ text: 'P0 edited' }] } }
        : block,
    )

  async function partsOf(bytes: Uint8Array): Promise<Map<string, string>> {
    const zip = await JSZip.loadAsync(bytes)
    const out = new Map<string, string>()
    for (const [name, entry] of Object.entries(zip.files)) {
      if (!entry.dir) out.set(name, await entry.async('string'))
    }
    return out
  }

  it('an unedited document that holds orphan markers saves to its original bytes', async () => {
    const bytes = await buildDocx({ bodyXml: ORPHAN_BODY, headerXml: ORPHAN_HEADER })
    const parsed = await parseDocx(bytes)
    expect(await saveDocx(parsed, untouched(parsed))).toBe(bytes)
  })

  it('one real edit strips the orphans and the result still opens', async () => {
    const bytes = await buildDocx({ bodyXml: ORPHAN_BODY, headerXml: ORPHAN_HEADER })
    const parsed = await parseDocx(bytes)
    const saved = await saveDocx(parsed, firstParagraphEdited(parsed))
    const parts = await partsOf(saved)
    const body = parts.get('word/document.xml')!
    expect(body).not.toMatch(MOVE_RANGE_MARKER)
    expect(body).toContain('<w:p><w:r><w:t>P1 stays</w:t></w:r></w:p>')
    expect(body).toContain('<w:p><w:r><w:t>P2 tail</w:t></w:r></w:p>')
    expect(parts.get('word/header1.xml')).not.toMatch(MOVE_RANGE_MARKER)
    expect(parts.get('word/header1.xml')).toContain('H stays')
    const reopened = await parseDocx(saved)
    expect(
      reopened.blocks.filter((b) => !b.hidden).map((b) => b.runs?.map((r) => r.text).join('')),
    ).toEqual(['P0 edited', 'P1 stays', 'P2 tail'])
  })

  it('a properly paired range is untouched, edited or not', async () => {
    const bytes = await buildDocx({ bodyXml: ISSUE_BODY })
    const parsed = await parseDocx(bytes)
    expect(await saveDocx(parsed, untouched(parsed))).toBe(bytes)

    const body = (await partsOf(await saveDocx(parsed, firstParagraphEdited(parsed)))).get(
      'word/document.xml',
    )!
    expect(body).toContain('P0 edited')
    for (const block of parsed.blocks.slice(1)) expect(body).toContain(block.originalXml!)
  })

  it('dropOrphanMoveRanges strips the orphans of a save that changes nothing else', async () => {
    const bytes = await buildDocx({ bodyXml: ORPHAN_BODY, headerXml: ORPHAN_HEADER })
    const parsed = await parseDocx(bytes)
    const saved = await saveDocx(parsed, untouched(parsed), { dropOrphanMoveRanges: true })
    const before = await partsOf(bytes)
    const after = await partsOf(saved)
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort())
    for (const [name, xml] of after) {
      expect(xml, name).not.toMatch(MOVE_RANGE_MARKER)
      if (name !== 'word/document.xml' && name !== 'word/header1.xml') {
        expect(xml, name).toBe(before.get(name))
      }
    }
    expect(after.get('word/document.xml')).toContain('<w:p><w:r><w:t>P0 intro</w:t></w:r></w:p>')
    expect(after.get('word/document.xml')).toContain('<w:p><w:r><w:t>P1 stays</w:t></w:r></w:p>')
    expect(after.get('word/header1.xml')).toContain('<w:p><w:r><w:t>H stays</w:t></w:r></w:p>')
  })

  it('dropOrphanMoveRanges reaches an orphan that only a header carries', async () => {
    const bytes = await buildDocx({
      bodyXml: '<w:p><w:r><w:t>P0 intro</w:t></w:r></w:p>',
      headerXml: ORPHAN_HEADER,
    })
    const parsed = await parseDocx(bytes)
    const saved = await saveDocx(parsed, untouched(parsed), { dropOrphanMoveRanges: true })
    const before = await partsOf(bytes)
    const after = await partsOf(saved)
    expect(after.get('word/header1.xml')).not.toMatch(MOVE_RANGE_MARKER)
    expect(after.get('word/document.xml')).toBe(before.get('word/document.xml'))
  })

  it('dropOrphanMoveRanges with nothing to drop returns the original bytes', async () => {
    const bytes = await buildDocx({ bodyXml: ISSUE_BODY })
    const parsed = await parseDocx(bytes)
    expect(await saveDocx(parsed, untouched(parsed), { dropOrphanMoveRanges: true })).toBe(bytes)
  })
})
