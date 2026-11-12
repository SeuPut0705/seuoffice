import { describe, expect, it } from 'vitest'
import { parseDocx } from '../src/index'
import { vmlShapeSvg } from '../src/parse-vml'
import { readWatermarkShape } from '../src/watermark'
import { buildDocx } from './helpers/build-docx'

/** VML writes a fraction three ways: `.5`, `32768f` (1/65536ths) and `50%` */

const rect = (opacity: string) =>
  `<w:pict><v:rect style="width:40pt;height:20pt" fillcolor="#336699" stroked="f"><v:fill opacity="${opacity}"/></v:rect></w:pict>`
const svgOf = (pict: string) =>
  decodeURIComponent(vmlShapeSvg(pict)!.dataUrl.replace('data:image/svg+xml,', ''))

describe('a VML fraction written as a percentage', () => {
  it('a half-transparent shape in a document is drawn half-transparent', async () => {
    const doc = await parseDocx(
      await buildDocx({
        bodyXml: `<w:p><w:r>${rect('50%')}</w:r></w:p>`,
        docRootExtraAttrs: 'xmlns:v="urn:schemas-microsoft-com:vml"',
      }),
    )
    const url = /data:image\/svg\+xml,[^"\\]+/.exec(JSON.stringify(doc.blocks[0]))![0]
    expect(decodeURIComponent(url)).toContain('fill="#336699" fill-opacity="0.5"')
  })

  it('the three spellings of one opacity draw the same shape', () => {
    expect(svgOf(rect('50%'))).toBe(svgOf(rect('.5')))
    expect(svgOf(rect('50%'))).toBe(svgOf(rect('32768f')))
    expect(svgOf(rect('12.5%'))).toContain('fill-opacity="0.125"')
  })

  it('100% is opaque and a bare percent sign is no value', () => {
    expect(svgOf(rect('100%'))).toBe(svgOf(rect('1')))
    expect(svgOf(rect('%'))).toBe(svgOf(rect('1')))
  })

  it('a watermark with a percent opacity', () => {
    const pict = (opacity: string) =>
      '<w:pict><v:shape style="position:absolute;width:400pt;height:100pt" fillcolor="silver" stroked="f">' +
      `<v:fill opacity="${opacity}"/><v:textpath style="font-family:&quot;Arial&quot;" string="DRAFT"/></v:shape></w:pict>`
    expect(readWatermarkShape(pict('25%'))!.wordArt!.opacity).toBe(0.25)
    expect(readWatermarkShape(pict('.25'))!.wordArt!.opacity).toBe(0.25)
  })
})
