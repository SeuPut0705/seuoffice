import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { XMLValidator } from 'fast-xml-parser'
import { describe, expect, it } from 'vitest'
import { parseDocx } from '../src'
import { patchTextboxParas } from '../src/generate'
import { xmlSegments } from '../src/xml-tag'
import { revisionsDocx } from './helpers/hidden-revisions'
import { SECRET, TAG_MUTATION_NAMES, type TagMutation } from './helpers/hidden-stories'

/**
 * A text box is patched in the bytes of its paragraph. However the tags are
 * written (quotes, spaces, a `>` in a value, comments, CDATA, white space before
 * the `>` of an end tag), the paragraphs it keeps stay as they were, the one
 * that is patched is rewritten, and the result is well-formed.
 */

const MUTATIONS = ['none', ...TAG_MUTATION_NAMES.filter((m) => m !== 'namespace prefix')] as const

async function boxParagraph(mutation: TagMutation | 'none'): Promise<string> {
  const file = await revisionsDocx(mkdtempSync(join(tmpdir(), 'txbx-')), mutation)
  const doc = await parseDocx(new Uint8Array(readFileSync(file)))
  const block = doc.blocks.find((b) => b.textboxes?.length)
  expect(block, 'the document holds a text box').toBeDefined()
  return block!.originalXml!
}

describe.each(MUTATIONS)('a text box patched, tags: %s', (mutation) => {
  it('keeps the paragraphs it is not asked to change, byte for byte', async () => {
    const xml = await boxParagraph(mutation)
    const content = xmlSegments(xml, 'w:txbxContent', 0, xml.length)
    expect(content).toHaveLength(1)
    const before = xml.slice(content[0]!.start, content[0]!.end)
    const paras = xmlSegments(before, 'w:p', before.indexOf('>') + 1, before.length)
    expect(paras).toHaveLength(3)
    const out = patchTextboxParas(xml, { byIndex: [[null, null, null]] })
    expect(out).toBe(xml)
  })

  it('rewrites the paragraph it is asked to, leaves the others, and stays well-formed', async () => {
    const xml = await boxParagraph(mutation)
    const out = patchTextboxParas(xml, {
      byIndex: [[{ runs: [{ text: 'Rewritten' }] }, null, null]],
    })
    expect(out).toContain('Rewritten')
    // the other two paragraphs, hidden words and all
    const count = (x: string) => x.split(SECRET).length - 1
    const first = xmlSegments(xml, 'w:p', xml.indexOf('<w:txbxContent'), xml.length)[0]!
    expect(count(out)).toBe(count(xml) - count(xml.slice(first.start, first.end)))
    expect(XMLValidator.validate(out.replace(/^<w:p\b[^>]*>/, '<w:p>'))).toBe(true)
  })
})
