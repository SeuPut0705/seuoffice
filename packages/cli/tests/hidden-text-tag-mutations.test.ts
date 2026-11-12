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
