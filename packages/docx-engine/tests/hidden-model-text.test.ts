import { readFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { editedCommentModelText, parseDocx, saveDocx, type SaveBlock } from '../src'
import { withheldDrawingLabel } from '../src/withheld'
import {
  hiddenStoriesDocx,
  mutatedStoriesDocx,
  OWN_REDACT_NS,
  PLACEHOLDER,
  SECRET,
  TAG_MUTATION_NAMES,
} from './helpers/hidden-stories'

async function parsed(options: { pictures?: boolean; literal?: boolean }, mutation?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'hidden-model-text-'))
  const file = mutation
    ? await mutatedStoriesDocx(dir, mutation as never, options)
    : await hiddenStoriesDocx(dir, OWN_REDACT_NS, 'stories.docx', 'go', options)
  return parseDocx(new Uint8Array(readFileSync(file)))
}

/**
 * An entry that carries a mark has a model text, also when what a model reads
 * is the same as what the entry says: a hidden run whose words are the
 * placeholder. Readers take the model text's presence for "this hides
 * something", so dropping it as redundant opens what they withhold.
 */
describe('a hidden run whose words are the placeholder', () => {
  it.each(['none', ...TAG_MUTATION_NAMES.filter((m) => m !== 'namespace prefix')] as const)(
    'gives a comment, a note and a control a model text (tags: %s)',
    async (mutation) => {
      const doc = await parsed({ literal: true }, mutation === 'none' ? undefined : mutation)
      expect(doc.comments.map((c) => [c.text, c.modelText])).toContainEqual([
        `Note: ${PLACEHOLDER}`,
        `Note: ${PLACEHOLDER}`,
      ])
      expect(doc.footnotes.map((n) => [n.text, n.modelText])).toContainEqual([
        ` See ${PLACEHOLDER}`.trimStart(),
        ` See ${PLACEHOLDER}`.trimStart(),
      ])
      const controls = doc.blocks.flatMap((b) => b.inlineContentControls ?? [])
      expect(controls.length).toBeGreaterThan(0)
      for (const control of controls) expect(control.modelText).toBe(PLACEHOLDER)
    },
  )

  it('gives an unmarked comment, note and control none', async () => {
    const doc = await parsed({ pictures: true })
    const plain = doc.comments.find((c) => c.id === '2')!
    expect(plain.modelText).toBeUndefined()
  })

  it('keeps the model text of a comment a person edits', () => {
    const marked =
      '<w:comment w:id="1" w:author="K"><w:p><w:r><w:t xml:space="preserve">Note: </w:t></w:r>' +
      `<w:r><w:rPr><go:redact xmlns:go="${OWN_REDACT_NS}" w:label="client phone"/></w:rPr><w:t>${PLACEHOLDER}</w:t></w:r></w:p></w:comment>`
    expect(editedCommentModelText(marked, `Note 2: ${PLACEHOLDER}`)).toBe(`Note 2: ${PLACEHOLDER}`)
  })
})

describe('a picture in a hidden run', () => {
  it('marks the whole-unit block that holds it, never a plain one', async () => {
    const doc = await parsed({ pictures: true })
    const unit = doc.blocks.filter((b) => b.label === 'Image')
    // the picture alone in its paragraph, the one whose media is missing, the plain one
    expect(unit.map((b) => b.redact)).toEqual(['client phone', 'client phone', undefined])
    for (const block of unit.filter((b) => b.redact)) {
      // the block still holds its words for the person; the marker tells readers to withhold them
      expect(JSON.stringify(block.redact)).not.toContain(SECRET)
    }
  })

  it.each([
    ['a picture', '<w:drawing/>'],
    ['a picture of the old kind', '<w:pict/>'],
    ['an embedded object', '<w:object/>'],
  ])('finds %s in a marked run, in any spelling of the mark', (_name, drawing) => {
    const spellings = [
      `<w:rPr><go:redact w:label="id card"/></w:rPr>`,
      `<w:rPr><redact xmlns="${OWN_REDACT_NS}" w:label="id card"/></w:rPr>`,
    ]
    for (const rPr of spellings) {
      expect(withheldDrawingLabel(`<w:p><w:r>${rPr}${drawing}</w:r></w:p>`)).toBe('id card')
    }
    expect(withheldDrawingLabel(`<w:p><w:r>${drawing}</w:r></w:p>`)).toBeNull()
    expect(
      withheldDrawingLabel(
        `<w:p><w:r><w:rPr><go:redact w:label="id card"/></w:rPr><w:t>words</w:t></w:r><w:r>${drawing}</w:r></w:p>`,
      ),
    ).toBeNull()
  })

  it('withholds a drawing in a marked run that sits inside a hyperlink, a field or a control', () => {
    const run = '<w:r><w:rPr><go:redact w:label="id card"/></w:rPr><w:drawing/></w:r>'
    for (const wrap of ['w:hyperlink', 'w:fldSimple', 'w:smartTag', 'w:sdt', 'w:ins']) {
      expect(withheldDrawingLabel(`<w:p><${wrap}>${run}</${wrap}></w:p>`)).toBe('id card')
    }
  })
})

describe('a comment edited so that its hidden runs cannot be patched around', () => {
  it.each([
    ['a paragraph added', (text: string) => `${text}\nmore`],
    ['words changed across the hidden and plain ones', () => 'Different words'],
  ])('keeps its hidden picture in a marked run (%s)', async (_name, edit) => {
    const doc = await parsed({ pictures: true })
    const comment = doc.comments.find((c) => c.id === '1')!
    expect(comment.image).toBeDefined()
    const blocks = doc.blocks
      .filter((block) => !block.hidden)
      .map((block): SaveBlock => ({ kind: 'original', docxIndex: block.docxIndex! }))
    const saved = await saveDocx(doc, blocks, {
      comments: doc.comments.map((c) => (c.id === '1' ? { ...c, text: edit(c.text) } : c)),
    })
    const xml = await (await JSZip.loadAsync(saved)).file('word/comments.xml')!.async('string')
    const entry = /<w:comment\b[^>]*\bw:id="1"[\s\S]*?<\/w:comment>/.exec(xml)![0]
    const pictureRuns = entry.match(/<w:r>(?:(?!<\/w:r>)[\s\S])*<w:drawing[\s\S]*?<\/w:r>/g) ?? []
    expect(pictureRuns).toHaveLength(1)
    expect(pictureRuns[0]).toMatch(/<(?:\w+:)?redact[\s/>]/)
    // reopened: the comment still hides something, so no reader lists its picture
    const reopened = (await parseDocx(saved)).comments.find((c) => c.id === '1')!
    expect(reopened.modelText).toBeDefined()
    expect(reopened.markedXml).toBeDefined()
  })
})

describe('a note edited so that its hidden runs cannot be patched around', () => {
  it.each([
    ['a paragraph added', (text: string) => `${text}\nmore`],
    ['words changed across the hidden and plain ones', () => 'Different words'],
  ])('keeps both its pictures, each in a marked run (%s)', async (_name, edit) => {
    const doc = await parsed({ pictures: true })
    const note = doc.footnotes.find((n) => n.id === '1')!
    const blocks = doc.blocks
      .filter((block) => !block.hidden)
      .map((block): SaveBlock => ({ kind: 'original', docxIndex: block.docxIndex! }))
    const saved = await saveDocx(doc, blocks, {
      // an edit of the text drops the display runs, as the editor's own edit does
      footnotes: doc.footnotes.map((n) => (n.id === '1' ? { id: n.id, text: edit(n.text) } : n)),
    })
    const zip = await JSZip.loadAsync(saved)
    const xml = await zip.file('word/footnotes.xml')!.async('string')
    expect(xml).toMatch(/<w:footnotes\b[^>]*xmlns:wp=/)
    const entry = /<w:footnote\b[^>]*\bw:id="1"[\s\S]*?<\/w:footnote>/.exec(xml)![0]
    const pictureRuns = entry.match(/<w:r>(?:(?!<\/w:r>)[\s\S])*<w:drawing[\s\S]*?<\/w:r>/g) ?? []
    expect(pictureRuns).toHaveLength(2)
    for (const run of pictureRuns) expect(run).toMatch(/<(?:\w+:)?redact[\s/>]/)
    expect(entry).toContain(`${SECRET}PN`)
    expect(entry).toContain('Company logo')
    expect(entry).toContain(edit(note.text).split('\n').pop()!)
    // the rels of the part still hold both pictures' targets
    const rels = await zip.file('word/_rels/footnotes.xml.rels')!.async('string')
    for (const id of ['rId10', 'rIdPicN']) expect(rels).toContain(`Id="${id}"`)
    const reopened = (await parseDocx(saved)).footnotes.find((n) => n.id === '1')!
    expect(reopened.modelText).toBeDefined()
    expect(reopened.modelText).not.toContain(SECRET)
  })

  it('an unmarked note keeps its pictures too, unmarked', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'plain-note-'))
    const file = await hiddenStoriesDocx(dir, OWN_REDACT_NS, 'n.docx', 'go', { pictures: true })
    const zip = await JSZip.loadAsync(readFileSync(file))
    const notes = (await zip.file('word/footnotes.xml')!.async('string')).replace(
      /<w:r><w:rPr>(?:(?!<\/w:rPr>)[\s\S])*redact[\s\S]*?<\/w:rPr>(?:<w:t>[^<]*<\/w:t>|(?=<w:drawing))/g,
      '<w:r>',
    )
    zip.file('word/footnotes.xml', notes)
    const doc = await parseDocx(await zip.generateAsync({ type: 'uint8array' }))
    const blocks = doc.blocks
      .filter((block) => !block.hidden)
      .map((block): SaveBlock => ({ kind: 'original', docxIndex: block.docxIndex! }))
    const saved = await saveDocx(doc, blocks, {
      footnotes: doc.footnotes.map((n) =>
        n.id === '1' ? { id: n.id, text: `${n.text}\nmore` } : n,
      ),
    })
    const out = await (await JSZip.loadAsync(saved)).file('word/footnotes.xml')!.async('string')
    expect(out.split('<w:drawing>').length - 1).toBe(2)
    expect(out).not.toMatch(/<(?:\w+:)?redact[\s/>]/)
  })
})
