import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { docxToText } from '../../file-parse/src/docx'
import { RedactionMarkError } from '../../file-parse/src/redaction-error'
import {
  mutatedStoriesDocx,
  SECRET,
  TAG_MUTATION_NAMES,
} from '../../docx-engine/tests/helpers/hidden-stories'
import { run, tempDir } from './helpers'

/**
 * The hidden-stories document (body, header, footer, comment, footnote, inline
 * content control, each with a run hidden from AI) with its tags written
 * another valid way. Whatever a reader makes of the tags, no hidden word may
 * reach what it hands over.
 */
describe.each(TAG_MUTATION_NAMES)('tags rewritten: %s', (mutation) => {
  it('docs read hands over no hidden word', async () => {
    const file = await mutatedStoriesDocx(tempDir(), mutation)
    const read = await run([
      'docs',
      'read',
      file,
      '--full',
      '--html',
      '--header-footer',
      '--comments',
      '--notes',
      '--fields',
      '--json',
    ])
    expect(read.stdout).not.toContain(SECRET)
    expect(read.stderr).not.toContain(SECRET)
    // and nothing goes missing: the note and the comment are listed, withheld
    const detail = read.json().detail
    expect(detail.notes.map((n: { id: string; text: string }) => [n.id, n.text])).toEqual([
      ['1', 'See {{client phone}}'],
    ])
    expect(detail.comments.map((c: { id: string; text: string }) => [c.id, c.text])).toEqual([
      ['1', 'Note: {{client phone}}'],
    ])
  })

  it('an attachment read hands over no hidden word', async () => {
    const file = await mutatedStoriesDocx(tempDir(), mutation)
    const text = await docxToText(new Uint8Array(readFileSync(file))).catch((err: unknown) => {
      // refusing the file is a safe answer; anything else is a failure
      if (err instanceof RedactionMarkError) return ''
      throw err
    })
    expect(text).not.toContain(SECRET)
  })
})

const SLIDE_MUTATIONS: Record<string, (xml: string) => string> = {
  'single quotes': (xml) => xml.replace(/<[^>!?]+>/g, (tag) => tag.replace(/="([^"]*)"/g, "='$1'")),
  'spaces around =': (xml) =>
    xml.replace(/<[^>!?]+>/g, (tag) => tag.replace(/(\s[\w:.-]+)=(["'])/g, '$1 = $2')),
  '> and /> inside values': (xml) => xml.replace(/<a:r(?=[\s>])/g, '<a:r xx="a/>b>c"'),
  comments: (xml) => xml.replace(/(<a:r(?:\s[^>]*)?>)/g, '$1<!-- </a:r> -->'),
  CDATA: (xml) =>
    xml.replace(
      new RegExp(`<a:t>${SECRET}</a:t>`, 'g'),
      `<a:t><![CDATA[</a:r>]]><![CDATA[${SECRET}]]></a:t>`,
    ),
}

describe.each(Object.keys(SLIDE_MUTATIONS))('slide tags rewritten: %s', (mutation) => {
  it('slides read and the attachment reader hand over no hidden word', async () => {
    const JSZip = (await import('jszip')).default
    const { writeFileSync } = await import('node:fs')
    const { hiddenPptx } = await import('./hidden-text-fixtures')
    const { pptxToText } = await import('../../file-parse/src/pptx')
    const file = await hiddenPptx(tempDir())
    const zip = await JSZip.loadAsync(readFileSync(file))
    for (const part of ['ppt/slides/slide1.xml', 'ppt/notesSlides/notesSlide1.xml']) {
      zip.file(part, SLIDE_MUTATIONS[mutation]!(await zip.file(part)!.async('string')))
    }
    writeFileSync(file, await zip.generateAsync({ type: 'uint8array' }))
    const read = await run(['slides', 'read', file, '--full', '--json'])
    expect(read.stdout).not.toContain(SECRET)
    const text = await pptxToText(new Uint8Array(readFileSync(file))).catch((err: unknown) => {
      if (err instanceof RedactionMarkError) return ''
      throw err
    })
    expect(text).not.toContain(SECRET)
  })
})

/**
 * A change elsewhere in the document, saved: whatever the tags looked like,
 * every hidden run keeps its words and its mark, and no reader of the saved
 * file hands a hidden word over.
 */
const CHANGES: Record<string, unknown[]> = {
  'add a note': [{ op: 'insert_footnote', blockIndex: 0, text: 'Extra note.' }],
  'add a comment': [{ op: 'add_comment', blockIndex: 0, comment: 'Extra comment.' }],
  'add a paragraph': [{ op: 'insert_content', html: '<p>Appended.</p>' }],
  'edit another paragraph': [{ op: 'findReplace', find: 'Edit me', replace: 'Edited' }],
  'replace another paragraph': [
    { op: 'replace_blocks', startBlockIndex: 1, endBlockIndex: 1, html: '<p>Replaced.</p>' },
  ],
  'edit the header': [{ op: 'set_header_footer', kind: 'header', text: 'Head 2 {{client phone}}' }],
  'edit the footer': [{ op: 'set_header_footer', kind: 'footer', text: 'Foot 2 {{client phone}}' }],
  'add a first-page header': [
    { op: 'set_header_footer', kind: 'header', view: 'first', text: 'Cover' },
  ],
  'set a watermark': [{ op: 'set_watermark', text: 'DRAFT' }],
  'insert a section break': [{ op: 'insert_section_break', afterBlockIndex: 0 }],
  'change the page setup': [{ op: 'set_page_setup', orientation: 'landscape' }],
}

const MC = 'http://schemas.openxmlformats.org/markup-compatibility/2006'

/**
 * A written story part's root lists, by namespace, every mark the part holds
 * as ignorable and as preserved: the lists' prefixes are read where the root
 * declares them, and each mark element by the namespace it is really in.
 */
async function expectMarkDirective(path: string, xml: string) {
  const { JSDOM } = await import('jsdom')
  const doc = new new JSDOM('').window.DOMParser().parseFromString(xml, 'application/xml')
  expect(doc.getElementsByTagName('parsererror').length, `${path}: well-formed`).toBe(0)
  const root = doc.documentElement
  const list = (name: string) => (root.getAttributeNS(MC, name) ?? '').split(/\s+/).filter(Boolean)
  const ignorable = new Set(list('Ignorable').map((prefix) => root.lookupNamespaceURI(prefix)))
  const preserved = new Set(
    list('PreserveElements').map((qname) => {
      const [prefix, local] = qname.split(':')
      return `${root.lookupNamespaceURI(prefix!)}|${local}`
    }),
  )
  const marks = [...doc.getElementsByTagNameNS('*', 'redact')]
  for (const mark of marks) {
    expect(ignorable.has(mark.namespaceURI), `${path}: ${mark.namespaceURI} ignorable`).toBe(true)
    expect(preserved.has(`${mark.namespaceURI}|redact`), `${path}: preserved`).toBe(true)
  }
}

const SAVED = TAG_MUTATION_NAMES.flatMap((mutation) => [
  { mutation, rels: false },
  { mutation, rels: true },
])

describe.each(SAVED)(
  'tags rewritten: $mutation (.rels too: $rels), then saved',
  ({ mutation, rels }) => {
    it.each(Object.keys(CHANGES))('%s keeps every hidden run hidden', async (change) => {
      const { writeFileSync } = await import('node:fs')
      const { join } = await import('node:path')
      const JSZip = (await import('jszip')).default
      const dir = tempDir()
      const file = await mutatedStoriesDocx(dir, mutation, { rels })
      const before = await JSZip.loadAsync(readFileSync(file))
      const original = new Map(
        await Promise.all(
          Object.values(before.files)
            .filter((entry) => !entry.dir)
            .map(async (entry) => [entry.name, await entry.async('string')] as const),
        ),
      )
      const ops = join(dir, 'ops.json')
      writeFileSync(ops, JSON.stringify(CHANGES[change]))
      const applied = await run(['docs', 'apply', file, '--ops', ops, '--json'])
      expect(applied.stdout).not.toContain(SECRET)
      expect(applied.code).toBe(0)

      // the words are kept in the file
      const zip = await JSZip.loadAsync(readFileSync(file))
      const parts = await Promise.all(
        Object.keys(zip.files)
          .filter((path) => /^word\/[^/]+\.xml$/.test(path))
          .map((path) => zip.file(path)!.async('string')),
      )
      for (const tag of ['B', 'H', 'F', 'C', 'N', 'S']) {
        expect(parts.some((xml) => xml.includes(`${SECRET}${tag}`))).toBe(true)
      }
      // and every story part the save wrote keeps the mark for the next consumer
      for (const path of Object.keys(zip.files)) {
        if (!/^word\/[^/]+\.xml$/.test(path)) continue
        const xml = await zip.file(path)!.async('string')
        if (xml === original.get(path) || !/<(?:[\w.-]+:)?redact\b/.test(xml)) continue
        await expectMarkDirective(path, xml)
      }
      // and still withheld from every reader
      const read = await run([
        'docs',
        'read',
        file,
        '--full',
        '--html',
        '--header-footer',
        '--comments',
        '--notes',
        '--json',
      ])
      expect(read.code).toBe(0)
      expect(read.stdout).not.toContain(SECRET)
      const detail = read.json().detail
      expect(detail.items[0].text).toContain('{{client phone}}')
      if (change === 'edit another paragraph') expect(detail.items[1].text).toBe('Edited please')
      if (change === 'replace another paragraph') expect(detail.items[1].text).toBe('Replaced.')
      expect(detail.headerFooter.header).toContain('{{client phone}}')
      expect(detail.headerFooter.footer).toContain('{{client phone}}')
      expect(detail.comments.find((c: { id: string }) => c.id === '1').text).toContain('{{')
      expect(detail.notes.find((n: { id: string }) => n.id === '1').text).toContain('{{')
      const attachment = await docxToText(new Uint8Array(readFileSync(file))).catch(
        (err: unknown) => {
          if (err instanceof RedactionMarkError) return ''
          throw err
        },
      )
      expect(attachment).not.toContain(SECRET)
    })
  },
)
