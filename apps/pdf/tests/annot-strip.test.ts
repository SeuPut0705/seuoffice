// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { PDFDict, PDFDocument, PDFName, PDFRef, PDFString } from 'pdf-lib'
import { annotKindOf, stripAnnotsBytes } from '../src/main/annot-strip'

/**
 * Two pages, each with a sticky note (and its popup), a highlight, a reply to
 * the highlight, an ink drawing and a link; page 1 also has a text field.
 * Every annotation's /Contents names it, so the saved bytes show what is left.
 */
async function annotated(): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const { context } = doc
  const form = doc.getForm()
  for (const n of [1, 2]) {
    const page = doc.addPage([300, 300])
    const add = (subtype: string, contents: string, extra: Record<string, unknown> = {}) => {
      const ref = context.register(
        context.obj({
          Type: 'Annot',
          Subtype: subtype,
          Rect: [10, 10, 50, 50],
          Contents: PDFString.of(contents),
          ...extra,
        }),
      )
      page.node.addAnnot(ref)
      return ref
    }
    const note = add('Text', `note-secret-${n}`)
    const popup = add('Popup', `popup-${n}`, { Parent: note })
    ;(context.lookup(note) as PDFDict).set(PDFName.of('Popup'), popup)
    const appearance = context.register(
      context.stream('0 0 1 rg 0 0 40 40 re f', { BBox: [0, 0, 40, 40] }),
    )
    const highlight = add('Highlight', `highlight-${n}`, { AP: { N: appearance } })
    add('Text', `reply-${n}`, { IRT: highlight })
    add('Ink', `ink-${n}`)
    add('Link', `link-${n}`)
    if (n === 1) form.createTextField('name').addToPage(page, { x: 100, y: 100 })
  }
  return doc.save({ useObjectStreams: false })
}

const subtypes = async (bytes: Uint8Array) => {
  const doc = await PDFDocument.load(bytes)
  return doc.getPages().map((page) =>
    (page.node.Annots()?.asArray() ?? []).map((value) => {
      const dict = (value instanceof PDFRef ? doc.context.lookup(value) : value) as PDFDict
      return dict.lookup(PDFName.of('Subtype'), PDFName).decodeText()
    }),
  )
}

const text = (bytes: Uint8Array) => Buffer.from(bytes).toString('latin1')

describe('annotKindOf', () => {
  it('groups the subtypes and never offers form fields or popups', () => {
    expect(annotKindOf('Text')).toBe('comments')
    expect(annotKindOf('StrikeOut')).toBe('highlights')
    expect(annotKindOf('Square')).toBe('drawings')
    expect(annotKindOf('Link')).toBe('links')
    expect(annotKindOf('FileAttachment')).toBe('other')
    expect(annotKindOf(undefined)).toBe('other')
    expect(annotKindOf('Widget')).toBeNull()
    expect(annotKindOf('Popup')).toBeNull()
  })
})

describe('stripAnnotsBytes', () => {
  it('removes comments with their popups, and the text leaves the file', async () => {
    const input = await annotated()
    const { bytes, removed } = await stripAnnotsBytes(input, { kinds: ['comments'], pages: null })
    expect(removed).toBe(4)
    expect(await subtypes(bytes)).toEqual([
      ['Highlight', 'Ink', 'Link', 'Widget'],
      ['Highlight', 'Ink', 'Link'],
    ])
    expect(text(bytes)).not.toMatch(/note-secret|popup-|reply-/)
    expect(text(bytes)).toMatch(/highlight-1/)
  })

  it('takes a reply and the appearance stream along with a removed highlight', async () => {
    const { bytes } = await stripAnnotsBytes(await annotated(), {
      kinds: ['highlights'],
      pages: null,
    })
    expect(await subtypes(bytes)).toEqual([
      ['Text', 'Popup', 'Ink', 'Link', 'Widget'],
      ['Text', 'Popup', 'Ink', 'Link'],
    ])
    expect(text(bytes)).not.toMatch(/highlight-|reply-|0 0 1 rg/)
  })

  it('keeps links and form fields unless links are asked for, and only on the chosen pages', async () => {
    const all = ['comments', 'highlights', 'drawings', 'stamps', 'other'] as const
    const { bytes } = await stripAnnotsBytes(await annotated(), { kinds: all, pages: [1] })
    expect(await subtypes(bytes)).toEqual([
      ['Text', 'Popup', 'Highlight', 'Text', 'Ink', 'Link', 'Widget'],
      ['Link'],
    ])
    const withLinks = await stripAnnotsBytes(await annotated(), {
      kinds: [...all, 'links'],
      pages: null,
    })
    expect(await subtypes(withLinks.bytes)).toEqual([['Widget'], []])
    // the form still works
    const doc = await PDFDocument.load(withLinks.bytes)
    expect(doc.getForm().getTextField('name')).toBeTruthy()
  })

  it('counts nothing and keeps every annotation when none of the kinds is there', async () => {
    const input = await annotated()
    const { bytes, removed } = await stripAnnotsBytes(input, { kinds: ['stamps'], pages: null })
    expect(removed).toBe(0)
    expect((await subtypes(bytes))[1]).toHaveLength(6)
  })
})
