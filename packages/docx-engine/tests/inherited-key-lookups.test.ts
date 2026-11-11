/**
 * A table that is a plain object also answers to the keys every object
 * inherits: `constructor`, `toString`, `valueOf` and `hasOwnProperty` give a
 * function, `__proto__` gives Object.prototype. A document can name any of
 * them where the engine expects a bullet, a font, a language, an alignment or
 * a colour, so each lookup has to answer for the table's own keys only.
 */
import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { buildBlankDocx } from '../src/blank'
import { buildAnchoredTextboxParagraphXml } from '../src/generate'
import { markerFallbackFace, substituteBullet } from '../src/list-markers'
import { parseDocx } from '../src/parse'
import { vmlColorHex } from '../src/parse-vml'
import { decodeSymbolChar, decodeSymbolText, isSymbolFont, symbolGlyph } from '../src/symbol-fonts'
import { readWatermarkShape } from '../src/watermark'
import { buildDocx } from './helpers/build-docx'

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'
const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'

const INHERITED_KEYS = ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__']
/** the inherited keys that survive the lower-casing a font name or language tag goes through */
const LOWER_CASE_INHERITED_KEYS = ['constructor', '__proto__']

/** one bullet level whose text (and optionally font) is given, as numId 1 */
function bulletNumberingXml(lvlText: string, font?: string): string {
  const rPr = font ? `<w:rPr><w:rFonts w:ascii="${font}" w:hAnsi="${font}"/></w:rPr>` : ''
  return (
    XML_DECL +
    `<w:numbering ${W_NS}><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0">` +
    `<w:numFmt w:val="bullet"/><w:lvlText w:val="${lvlText}"/>${rPr}</w:lvl></w:abstractNum>` +
    '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>'
  )
}

/** the list marker the parser gives a textbox paragraph numbered with numId 1 */
async function parsedBulletMarker(numberingXml: string) {
  const box = buildAnchoredTextboxParagraphXml({
    anchor: 'paragraph',
    xEmu: 0,
    yEmu: 0,
    widthEmu: 3000000,
    heightEmu: 1000000,
    insetsEmu: { l: 0, t: 0, r: 0, b: 0 },
    zOrder: 1,
    id: 7,
    paragraphs: [{ runs: [{ text: 'item' }] }],
    holderLineTwips: 20,
  })
  const at = box.indexOf('<w:txbxContent>')
  const bodyXml =
    box.slice(0, at) +
    box
      .slice(at)
      .replace(
        '<w:p><w:r>',
        '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r>',
      )
  const parsed = await parseDocx(await buildDocx({ bodyXml, numberingXml }))
  return parsed.blocks.flatMap((b) => b.textboxes ?? [])[0]!.paras[0]!.listMarker
}

describe('bullet glyph tables', () => {
  it.each(INHERITED_KEYS)('a bullet whose level text is %s shows that text', async (key) => {
    expect((await parsedBulletMarker(bulletNumberingXml('o')))?.text).toBe('◦')
    expect((await parsedBulletMarker(bulletNumberingXml(key)))?.text).toBe(key)
  })

  it.each(INHERITED_KEYS)('%s has no substitute bullet', (key) => {
    expect(substituteBullet('\u2022')).toEqual({ glyph: '\u25cf', face: 'Symbol Bullet GO' })
    expect(substituteBullet(key)).toBeNull()
  })
})

describe('symbol font table', () => {
  it.each(LOWER_CASE_INHERITED_KEYS)('a font named %s is not a symbol font', (font) => {
    expect(isSymbolFont(' WingDings ')).toBe(true)
    expect(decodeSymbolChar('Symbol', 0xf0b7)).toBe('•')
    expect(isSymbolFont(font)).toBe(false)
    // a space is the one code every symbol font decodes, so it shows which path ran
    expect(decodeSymbolChar(font, 0x20)).toBeNull()
    expect(decodeSymbolText(font, ' ')).toBeNull()
    expect(symbolGlyph(font, '20')).toBe('\uf020')
    expect(markerFallbackFace('\u25b8', font)).toBe('Segoe UI Symbol')
  })

  it.each(LOWER_CASE_INHERITED_KEYS)(
    'a bullet in a text font named %s shows its own text',
    async (font) => {
      const marker = await parsedBulletMarker(bulletNumberingXml('x', font))
      expect(marker?.text).toBe('x')
      expect(marker?.symbol).toBeUndefined()
    },
  )
})

describe('East Asian default font by language', () => {
  const stylesXml = (eastAsia: string) =>
    `${XML_DECL}<w:styles ${W_NS}><w:docDefaults><w:rPrDefault><w:rPr>` +
    `<w:lang w:eastAsia="${eastAsia}"/></w:rPr></w:rPrDefault><w:pPrDefault/></w:docDefaults></w:styles>`
  const docDefaultsOf = async (eastAsia: string) =>
    (await parseDocx(await buildDocx({ bodyXml: '<w:p/>', stylesXml: stylesXml(eastAsia) })))
      .docDefaults

  it.each(['Constructor', 'constructor', '__proto__'])(
    'w:lang w:eastAsia="%s" names no font',
    async (lang) => {
      expect(await docDefaultsOf('ko-KR')).toMatchObject({
        eastAsiaFont: 'Malgun Gothic',
        eaFromLang: true,
      })
      const defaults = await docDefaultsOf(lang)
      expect(defaults?.eastAsiaLang).toBe(lang)
      expect(defaults?.eastAsiaFont).toBeUndefined()
      expect(defaults?.eaFromLang).toBeUndefined()
    },
  )
})

describe('paragraph alignment table', () => {
  const para = (jc: string) =>
    `<w:p><w:pPr><w:jc w:val="${jc}"/></w:pPr><w:r><w:t>x</w:t></w:r></w:p>`
  const formatOf = async (bodyXml: string, extraStylesXml?: string) =>
    (await parseDocx(await buildDocx({ bodyXml, extraStylesXml }))).blocks[0]!.format

  it.each(INHERITED_KEYS)('w:jc w:val="%s" reads like any unknown value', async (key) => {
    // numTab is a real ST_Jc value the engine does not model
    const unknown = await formatOf(para('numTab'))
    const format = await formatOf(para(key))
    expect(format?.align).toBeUndefined()
    expect(format).toEqual(unknown)
    expect(format?.effective?.align).toBe(unknown?.effective?.align)
  })

  it.each(INHERITED_KEYS)('a table style w:jc w:val="%s" aligns no cell', async (key) => {
    const tableStyle = (jc: string) =>
      '<w:style w:type="table" w:styleId="T"><w:name w:val="T"/>' +
      `<w:pPr><w:jc w:val="${jc}"/></w:pPr></w:style>`
    const table =
      '<w:tbl><w:tblPr><w:tblStyle w:val="T"/></w:tblPr><w:tblGrid><w:gridCol w:w="4000"/></w:tblGrid>' +
      '<w:tr><w:tc><w:p><w:r><w:t>cell</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'
    const cellAlign = async (jc: string) => {
      const parsed = await parseDocx(
        await buildDocx({ bodyXml: table, extraStylesXml: tableStyle(jc) }),
      )
      return parsed.blocks[0]!.table!.rows[0]![0]!.richParas?.[0]?.effective?.align
    }
    expect(await cellAlign('center')).toBe('center')
    expect(await cellAlign(key)).toBe(await cellAlign('numTab'))
  })
})

describe('VML colour names', () => {
  it.each(LOWER_CASE_INHERITED_KEYS)('%s is not a colour', (key) => {
    expect(vmlColorHex(key)).toBeUndefined()
    expect(vmlColorHex('Silver')).toBe('C0C0C0')
  })

  const watermarkPict = (fillcolor: string) =>
    '<w:pict><v:shape id="PowerPlusWaterMarkObject1" type="#_x0000_t136"' +
    ' style="position:absolute;margin-left:0;margin-top:0;width:468pt;height:280.8pt;z-index:-251658752"' +
    ` fillcolor="${fillcolor}" stroked="f"><v:fill opacity=".5"/>` +
    '<v:textpath style="font-family:&quot;Calibri&quot;;font-size:1pt" string="DRAFT"/>' +
    '</v:shape></w:pict>'

  it.each(LOWER_CASE_INHERITED_KEYS)(
    'a watermark filled with %s takes the default black',
    (key) => {
      expect(readWatermarkShape(watermarkPict(key))?.wordArt?.colorHex).toBe('000000')
    },
  )

  it.each(LOWER_CASE_INHERITED_KEYS)(
    'a parsed header watermark filled with %s is black',
    async (key) => {
      const headerXml =
        `${XML_DECL}<w:hdr ${W_NS} xmlns:v="urn:schemas-microsoft-com:vml"` +
        ' xmlns:o="urn:schemas-microsoft-com:office:office">' +
        `<w:p><w:r>${watermarkPict(key)}</w:r></w:p></w:hdr>`
      const parsed = await parseDocx(
        await buildDocx({
          bodyXml: '<w:p/>',
          sectPrExtra: '<w:headerReference w:type="default" r:id="rId20"/>',
          extraRels:
            '<Relationship Id="rId20" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>',
          extraParts: [
            {
              path: 'word/header1.xml',
              xml: headerXml,
              contentType:
                'application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml',
            },
          ],
        }),
      )
      const watermark = parsed.headerImages?.find((image) => image.wordArt)
      expect(watermark?.wordArt).toMatchObject({ text: 'DRAFT', colorHex: '000000' })
    },
  )
})

describe('blank document paper size', () => {
  const pageSizeOf = async (paperSize?: string): Promise<string | undefined> => {
    const bytes = await buildBlankDocx(
      paperSize === undefined ? undefined : { paperSize: paperSize as 'A4' },
    )
    const xml = await (await JSZip.loadAsync(bytes)).file('word/document.xml')!.async('string')
    return /<w:pgSz[^>]*>/.exec(xml)?.[0]
  }

  it.each([...INHERITED_KEYS, 'B5'])('an unknown size (%s) writes the default A4', async (size) => {
    expect(await pageSizeOf('Letter')).toBe('<w:pgSz w:w="12240" w:h="15840"/>')
    expect(await pageSizeOf()).toBe('<w:pgSz w:w="11906" w:h="16838"/>')
    expect(await pageSizeOf(size)).toBe(await pageSizeOf())
  })
})
