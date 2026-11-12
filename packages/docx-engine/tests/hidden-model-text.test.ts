import { readFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { editedCommentModelText, parseDocx } from '../src'
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
