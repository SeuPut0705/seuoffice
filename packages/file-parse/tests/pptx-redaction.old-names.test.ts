import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { OLD_REDACT_NS } from '../../agent-core/src/old-names'
// the deck engine's own writer, by path: "marked now" is what it really saves
import { REDACT_EXT_URI, setRedactExt } from '../../pptx-engine/src/redaction-xml'
import { parseFileToText } from '../src/index'
import { writeFixture } from './helpers/fixtures'

/**
 * A deck read as another file's material keeps a withheld run out of the
 * text whichever namespace its label was saved under, and still refuses the
 * whole deck when a mark under either namespace cannot be read.
 */

const OWN_REDACT_NS = 'https://github.com/SeuPut0705/seuoffice/redaction/2026'
const LABEL = 'client phone'
const SECRET = '13800138000'
const RPR = '<a:rPr lang="en-US" sz="1800"/>'
const NAMESPACES: Array<[string, string]> = [
  ['the old namespace', OLD_REDACT_NS],
  ['this product’s own namespace', OWN_REDACT_NS],
]

const run = (text: string, rPr = '') => `<a:r>${rPr}<a:t>${text}</a:t></a:r>`

let seq = 0
async function readSlide(paragraph: string) {
  const zip = new JSZip()
  zip.file(
    'ppt/slides/slide1.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ' +
      'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' +
      `<p:cSld><p:spTree><p:sp><p:txBody><a:p>${paragraph}</a:p></p:txBody></p:sp>` +
      '</p:spTree></p:cSld></p:sld>',
  )
  const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
  return parseFileToText(writeFixture(`old-names-${++seq}.pptx`, bytes))
}

describe('pptx: a withheld run under either namespace', () => {
  // the withheld-run cases in redaction.test.ts read the engine's own mark,
  // which is written under the old namespace
  it.each(NAMESPACES)('reads as its marker when the label is under %s', async (_name, ns) => {
    const marked =
      `<a:rPr lang="en-US"><a:extLst><a:ext uri="${REDACT_EXT_URI}" xmlns:go="${ns}">` +
      `<go:redact label="${LABEL}"/></a:ext></a:extLst></a:rPr>`
    const result = await readSlide(run('please call ') + run(SECRET, marked) + run(' to confirm'))
    expect(result).toEqual({
      ok: true,
      kind: 'text',
      text: `## Slide 1\nplease call {{${LABEL}}} to confirm`,
    })
  })

  it('reads a run marked now as its marker', async () => {
    const result = await readSlide(run(SECRET, setRedactExt(RPR, LABEL)))
    expect(result.text).toBe(`## Slide 1\n{{${LABEL}}}`)
  })
})

describe('pptx: a mark under either namespace that cannot be read fails the read', () => {
  it.each(NAMESPACES)('the label under %s bound to another prefix', async (_name, ns) => {
    const result = await readSlide(
      run(
        SECRET,
        `<a:rPr><a:extLst><a:ext uri="{OTHER}" xmlns:x="${ns}"><x:redact label="x"/></a:ext></a:extLst></a:rPr>`,
      ),
    )
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/redaction/i)
    expect(JSON.stringify(result)).not.toContain(SECRET)
  })

  it('a readable mark under one namespace does not cover an unreadable one under the other', async () => {
    const result = await readSlide(
      run('Jane Roe', setRedactExt(RPR, 'client name')) +
        run(
          SECRET,
          `<a:rPr><a:extLst><a:ext uri="{OTHER}" xmlns:x="${OWN_REDACT_NS}"><x:redact label="x"/></a:ext></a:extLst></a:rPr>`,
        ),
    )
    expect(result.ok).toBe(false)
    expect(JSON.stringify(result)).not.toContain(SECRET)
  })
})
