import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { clearHiddenMarks, docxHoldsHiddenContent, parseDocx } from '../src'
import { buildDocx } from './helpers/build-docx'
import {
  hiddenStoriesDocx,
  MARK_SPELLINGS,
  mutatedStoriesDocx,
  OWN_REDACT_NS,
  NAMESPACES,
  SECRET,
  TAG_MUTATION_NAMES,
} from './helpers/hidden-stories'

const dir = () => mkdtempSync(join(tmpdir(), 'hidden-content-'))
const load = (file: string) => new Uint8Array(readFileSync(file))

const mark = (label = 'client phone') =>
  `<w:r><w:rPr><go:redact xmlns:go="${OWN_REDACT_NS}" w:label="${label}"/></w:rPr><w:t>${SECRET}</w:t></w:r>`
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
const NOTE_REL =
  '<Relationship Id="rIdFn" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" Target="footnotes.xml"/>'

/** a document whose only hidden content sits in one place */
const ONLY: Record<string, () => Promise<Uint8Array>> = {
  'the body': () => buildDocx({ bodyXml: `<w:p>${mark()}</w:p>` }),
  'a header': () => buildDocx({ bodyXml: '<w:p/>', headerXml: `<w:p>${mark()}</w:p>` }),
  'a footer': () => buildDocx({ bodyXml: '<w:p/>', footerXml: `<w:p>${mark()}</w:p>` }),
  'a comment': () =>
    buildDocx({
      bodyXml: '<w:p><w:r><w:commentReference w:id="1"/></w:r></w:p>',
      extraParts: [
        {
          path: 'word/comments.xml',
          contentType:
            'application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml',
          xml: `<w:comments ${W}><w:comment w:id="1" w:author="K"><w:p>${mark()}</w:p></w:comment></w:comments>`,
        },
      ],
    }),
  'a note': () =>
    buildDocx({
      bodyXml: '<w:p><w:r><w:footnoteReference w:id="1"/></w:r></w:p>',
      extraRels: NOTE_REL,
      extraParts: [
        {
          path: 'word/footnotes.xml',
          contentType:
            'application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml',
          xml: `<w:footnotes ${W}><w:footnote w:id="1"><w:p>${mark()}</w:p></w:footnote></w:footnotes>`,
        },
      ],
    }),
  'a picture': () =>
    buildDocx({
      bodyXml:
        `<w:p><w:r><w:rPr><go:redact xmlns:go="${OWN_REDACT_NS}" w:label="id"/></w:rPr><w:drawing><wp:inline>` +
        '<wp:extent cx="95250" cy="95250"/><wp:docPr id="1" name="x"/></wp:inline></w:drawing></w:r></w:p>',
    }),
}

describe('docxHoldsHiddenContent', () => {
  it('is false for a document with nothing hidden', async () => {
    expect(
      await docxHoldsHiddenContent(
        await buildDocx({ bodyXml: '<w:p><w:r><w:t>Hi</w:t></w:r></w:p>' }),
      ),
    ).toBe(false)
  })

  it.each(Object.keys(ONLY))('finds a mark that sits only in %s', async (where) => {
    expect(await docxHoldsHiddenContent(await ONLY[where]!())).toBe(true)
  })

  it.each(NAMESPACES)('finds the mark under %s', async (_name, ns) => {
    expect(await docxHoldsHiddenContent(load(await hiddenStoriesDocx(dir(), ns)))).toBe(true)
  })

  it.each(MARK_SPELLINGS)('finds the mark spelled %s', async (spelling) => {
    const file = await hiddenStoriesDocx(dir(), OWN_REDACT_NS, 's.docx', spelling)
    expect(await docxHoldsHiddenContent(load(file))).toBe(true)
  })

  it.each(TAG_MUTATION_NAMES)('finds the mark with its tags rewritten: %s', async (mutation) => {
    expect(
      await docxHoldsHiddenContent(
        load(await mutatedStoriesDocx(dir(), mutation, { pictures: true })),
      ),
    ).toBe(true)
  })
})

describe('clearHiddenMarks', () => {
  it.each(['none', ...TAG_MUTATION_NAMES] as const)(
    'takes every mark off, keeps every word, and the document still opens (tags: %s)',
    async (mutation) => {
      const file =
        mutation === 'none'
          ? await hiddenStoriesDocx(dir(), OWN_REDACT_NS, 'c.docx', 'go', { pictures: true })
          : await mutatedStoriesDocx(dir(), mutation, { pictures: true })
      const cleared = await clearHiddenMarks(load(file))
      expect(await docxHoldsHiddenContent(cleared)).toBe(false)
      const zip = await JSZip.loadAsync(cleared)
      const parts = await Promise.all(
        Object.keys(zip.files)
          .filter((p) => /^word\/[^/]+\.xml$/.test(p))
          .map((p) => zip.file(p)!.async('string')),
      )
      // the words and pictures stay
      for (const tag of ['B', 'H', 'F', 'C', 'N']) {
        expect(parts.some((xml) => xml.includes(`${SECRET}${tag}`))).toBe(true)
      }
      expect(parts.filter((xml) => /<\w+:drawing>/.test(xml)).length).toBeGreaterThan(0)
      if (mutation === 'namespace prefix') return
      const doc = await parseDocx(cleared)
      expect(
        doc.comments.every((c) => c.modelText === undefined && c.markedXml === undefined),
      ).toBe(true)
      expect(doc.footnotes.every((n) => n.modelText === undefined)).toBe(true)
      expect(doc.blocks.every((b) => b.redact === undefined)).toBe(true)
    },
  )

  it.each(MARK_SPELLINGS)('clears a mark spelled %s', async (spelling) => {
    const file = await hiddenStoriesDocx(dir(), OWN_REDACT_NS, 's.docx', spelling)
    expect(await docxHoldsHiddenContent(await clearHiddenMarks(load(file)))).toBe(false)
  })

  it('leaves a document with no mark as it is, in content', async () => {
    const bytes = await buildDocx({ bodyXml: '<w:p><w:r><w:t>Hi</w:t></w:r></w:p>' })
    const out = await JSZip.loadAsync(await clearHiddenMarks(bytes))
    expect(await out.file('word/document.xml')!.async('string')).toContain('<w:t>Hi</w:t>')
  })
})
