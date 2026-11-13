/**
 * How the ODF style chain reaches the Word editor: the engine's effective
 * paragraph format of the bridge docx merges the default style, the common
 * ancestors and the paragraph's own automatic style, the nearest value wins.
 */
import { type Block, parseDocx } from '@seuoffice/docx-engine'
import { beforeAll, describe, expect, it } from 'vitest'
import { type Bridge, odtToBridge } from './helpers/bridge'
import { buildOdt } from './helpers/build-odt'
import { hPara } from './helpers/hancom-fragments'

const common =
  '<style:default-style style:family="paragraph"><style:paragraph-properties fo:line-height="100%" fo:orphans="2"><style:tab-stops><style:tab-stop style:position="1cm"/></style:tab-stops></style:paragraph-properties><style:text-properties fo:font-size="10pt" fo:color="#000000"/></style:default-style>' +
  '<style:style style:name="Base" style:family="paragraph"><style:paragraph-properties fo:line-height="160%"/><style:text-properties fo:font-size="12pt"/></style:style>' +
  '<style:style style:name="Child Style" style:parent-style-name="Base" style:family="paragraph"><style:paragraph-properties fo:text-align="center"><style:tab-stops><style:tab-stop style:position="3cm" style:type="right"/></style:tab-stops></style:paragraph-properties></style:style>' +
  '<style:style style:name="Loop A" style:parent-style-name="Loop B" style:family="paragraph"/>' +
  '<style:style style:name="Loop B" style:parent-style-name="Loop A" style:family="paragraph"/>'
const autos =
  '<style:style style:name="Child Style" style:family="paragraph"><style:paragraph-properties fo:text-align="end"/></style:style>' +
  '<style:style style:name="P1" style:parent-style-name="Child Style" style:family="paragraph"><style:text-properties fo:font-weight="bold"/></style:style>' +
  '<style:style style:name="P2" style:parent-style-name="Standard" style:family="paragraph"><style:paragraph-properties fo:margin-left="1cm"/></style:style>' +
  '<style:style style:name="P3" style:parent-style-name="Loop A" style:family="paragraph"/>' +
  '<style:style style:name="P4" style:parent-style-name="Base" style:family="paragraph"/>'

interface Effective {
  align?: string
  indent: { left: number }
  spacing: { line: { raw: number } }
  tabStops: Array<{ pos: number; val: string }>
  mark: { sizeHalfPoints: number; color: string }
}

let bridge: Bridge
let blocks: Block[]

beforeAll(async () => {
  bridge = await odtToBridge(
    await buildOdt({
      commonStyles: common,
      contentAutomaticStyles: autos,
      body: ['P1', 'P2', 'P3', 'P4'].map((style) => hPara(`text ${style}`, { style })).join(''),
    }),
  )
  blocks = (await parseDocx(bridge.docx)).blocks.filter((b) => !b.hidden)
})

const effective = (i: number) => (blocks[i].format as unknown as { effective: Effective }).effective

describe('style inheritance in the bridge docx', () => {
  it('merges default style, ancestors and the style itself, nearest wins', () => {
    const e = effective(0)
    expect(e.align).toBe('center')
    // 160% from Base over the default 100%
    expect(e.spacing.line.raw).toBe(384)
    // 12pt from Base over the default 10pt; the colour comes from the default style
    expect(e.mark.sizeHalfPoints).toBe(24)
    expect(e.mark.color).toBe('000000')
    // the automatic style's bold shows on the run
    expect(blocks[0].runs?.[0].bold).toBe(true)
  })

  it('never takes an automatic style as a parent', () => {
    // content.xml has an automatic "Child Style" (right-aligned) too; the parent of P1 is the common one
    expect(effective(0).align).toBe('center')
  })

  it('takes tab stops from the nearest style that defines them', () => {
    expect(effective(0).tabStops).toEqual([{ pos: 1701, val: 'right' }])
    expect(effective(3).tabStops).toEqual([{ pos: 567, val: 'left' }])
  })

  it('tolerates a parent that does not exist (Hancom references an undefined Standard)', () => {
    const e = effective(1)
    expect(e.indent.left).toBe(567)
    expect(e.spacing.line.raw).toBe(240)
    expect(blocks[1].runs?.[0].text).toBe('text P2')
  })

  it('stops on inheritance cycles', () => {
    expect(blocks[2].runs?.[0].text).toBe('text P3')
  })
})
