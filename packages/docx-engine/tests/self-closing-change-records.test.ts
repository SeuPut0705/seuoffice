import { describe, expect, it } from 'vitest'
import { parseDocx, setPPrChange, stripPPrChange, type Block } from '../src/index'
import { applyProtectedLeadingBreaks } from '../src/parse-block-passes'
import { buildDocx } from './helpers/build-docx'

/**
 * A property-change record written as one empty element is one element.
 * Removed as if it were the start of a paired one, the strip runs to the
 * next close tag of that name later in the part and takes the live
 * properties in between with it.
 */

const AT = 'w:id="1" w:author="A" w:date="2026-01-01T00:00:00Z"'
const OLD_PPR = `<w:pPrChange w:id="2" w:author="A" w:date="2026-01-01T00:00:00Z"><w:pPr><w:jc w:val="left"/></w:pPr></w:pPrChange>`

/** a floating text box whose inner paragraph carries a paired pPrChange */
const textbox =
  '<w:r><w:drawing><wp:anchor behindDoc="0" simplePos="0" relativeHeight="251658240" locked="0" layoutInCell="1" allowOverlap="1">' +
  '<wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="column"><wp:posOffset>0</wp:posOffset></wp:positionH>' +
  '<wp:positionV relativeFrom="paragraph"><wp:posOffset>0</wp:posOffset></wp:positionV>' +
  '<wp:extent cx="3000000" cy="1500000"/><wp:wrapNone/><wp:docPr id="1" name="Box"/>' +
  '<a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">' +
  '<wps:wsp xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">' +
  '<wps:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="3000000" cy="1500000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></wps:spPr>' +
  `<wps:txbx><w:txbxContent><w:p><w:pPr><w:jc w:val="center"/>${OLD_PPR}</w:pPr><w:r><w:t>Box</w:t></w:r></w:p></w:txbxContent></wps:txbx><wps:bodyPr/></wps:wsp>` +
  '</a:graphicData></a:graphic></wp:anchor></w:drawing></w:r>'

describe('a self-closing property-change record', () => {
  // the parser reads pageBreakBefore of such paragraphs itself; the whole-document
  // pass that restores it for a protected block whose pPr was swallowed is
  // checked on the block it gets
  it.each([
    ['followed by a paired record in a text box', textbox],
    ['alone', textbox.replace(OLD_PPR, '')],
  ])('%s: a protected text box paragraph keeps its page break before', (_name, run) => {
    const block: Block = {
      id: 'b0',
      type: 'passthrough',
      docxIndex: 0,
      // another producer writes the record first; the strip must not take what follows it
      originalXml: `<w:p><w:pPr><w:pPrChange ${AT}/><w:pageBreakBefore/></w:pPr>${run}</w:p>`,
    }
    applyProtectedLeadingBreaks([block])
    expect(block.format?.pageBreakBefore).toBe(true)
  })

  it('a section change record before a later paired one: the last section keeps its note format', async () => {
    const doc = await parseDocx(
      await buildDocx({
        bodyXml:
          '<w:p><w:pPr><w:sectPr><w:footnotePr><w:numFmt w:val="upperRoman"/></w:footnotePr>' +
          `<w:pgSz w:w="11906" w:h="16838"/><w:sectPrChange ${AT}/></w:sectPr></w:pPr></w:p>` +
          '<w:p><w:r><w:t>second section</w:t></w:r></w:p>',
        sectPrXml:
          '<w:sectPr><w:footnotePr><w:numFmt w:val="lowerLetter"/></w:footnotePr><w:pgSz w:w="11906" w:h="16838"/>' +
          `<w:sectPrChange w:id="3" w:author="A"><w:sectPr><w:footnotePr><w:numFmt w:val="decimal"/></w:footnotePr></w:sectPr></w:sectPrChange></w:sectPr>`,
      }),
    )
    expect(doc.footnoteProps?.numFmt).toBe('lowerLetter')
  })

  it('stripping it leaves the live properties, and setting a new record replaces it', () => {
    const pPr = `<w:pPr><w:jc w:val="center"/><w:pPrChange ${AT}/></w:pPr>`
    expect(stripPPrChange(pPr)).toBe('<w:pPr><w:jc w:val="center"/></w:pPr>')
    const set = setPPrChange(pPr, JSON.stringify({ author: 'B', old: { align: 'left' } }))
    expect(set.match(/<w:pPrChange\b/g)).toHaveLength(1)
    expect(set).toContain('w:author="B"')
  })
})
