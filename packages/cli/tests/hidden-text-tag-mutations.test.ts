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
