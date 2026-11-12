import { describe, expect, it } from 'vitest'
import { OLD_REDACT_NS } from '../../agent-core/src/old-names'
import { parseSlide } from '../src/index'
import { REDACT_EXT_URI, setRedactExt } from '../src/redaction-xml'
import type { TextElement } from '../src/types'

/**
 * The deck editor reads a withheld run back whichever namespace its label was
 * saved under, and writes the one an already installed version recognises.
 */

const OWN_REDACT_NS = 'https://github.com/SeuPut0705/seuoffice/redaction/2026'
const LABEL = 'client phone'

function runOf(rPr: string) {
  const slideXml =
    '<?xml version="1.0"?><p:sld xmlns:p="p" xmlns:a="a" xmlns:r="r"><p:cSld><p:spTree>' +
    '<p:nvGrpSpPr/><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="s"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>' +
    '<p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="100"/></a:xfrm></p:spPr>' +
    `<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r>${rPr}<a:t>13800138000</a:t></a:r></a:p></p:txBody>` +
    '</p:sp></p:spTree></p:cSld></p:sld>'
  const slide = parseSlide({ path: 'ppt/slides/slide1.xml', slideXml, ctx: {} })
  return (slide.elements[0] as TextElement).text!.paragraphs[0]!.runs[0]!
}

describe('a withheld run in a saved deck', () => {
  it.each([
    ['the old namespace', OLD_REDACT_NS],
    ['this product’s own namespace', OWN_REDACT_NS],
  ])('opens withheld when the label is under %s', (_name, ns) => {
    const run = runOf(
      `<a:rPr lang="en-US"><a:extLst><a:ext uri="${REDACT_EXT_URI}" xmlns:go="${ns}">` +
        `<go:redact label="${LABEL}"/></a:ext></a:extLst></a:rPr>`,
    )
    expect(run.redact).toBe(LABEL)
  })

  it('marked now, reopens withheld, under the namespace installed versions read', () => {
    const marked = setRedactExt('<a:rPr lang="en-US"/>', LABEL)
    expect(runOf(marked).redact).toBe(LABEL)
    expect(marked).toContain(`xmlns:go="${OLD_REDACT_NS}"`)
  })
})
