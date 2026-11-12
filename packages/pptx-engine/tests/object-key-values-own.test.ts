/**
 * A value of the document looked up in a table of the engine, or a name of the document used as
 * a key, is the table's own key or nothing. `constructor`, `toString`, `valueOf` and
 * `hasOwnProperty` answer every plain object with a function and `__proto__` with
 * Object.prototype, so a lookup handed those back as the line cap, the anchor or the alignment
 * of the deck; and an assignment under `__proto__` swaps the prototype instead of adding the
 * entry, so a guide or a script font named so was lost.
 * (Inputs from the Rust port's divergence ledger: inherited-key-parse-678, -686, -713, -3319,
 * -3762, -3985, avlst-proto, theme-script-font-proto, inherited-key-placeholder-anchor,
 * inherited-key-placeholder-align.)
 */
import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import {
  addMedia,
  addPicture,
  copyElementData,
  copySlide,
  pasteElements,
  createBlankPptx,
  extractMergeSlideSource,
  listSlideLayouts,
  mergeSlideFromSource,
  openPptx,
  parseSlide,
  pasteSlide,
  savePptx,
} from '../src/index'
import { parseTheme } from '../src/theme'
import {
  parseLstStyleLevels,
  parsePlaceholderMap,
  resolvePlaceholderAnchor,
} from '../src/placeholder'
import { defaultContentTypeFor } from '../src/xml-utils'
import type { TableElement, TextElement } from '../src/types'

const INHERITED = ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']
const OFF = { x: 0, y: 0, cx: 914400, cy: 914400 }
const PNG = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  ),
)

const slideOf = (body: string) =>
  parseSlide({
    path: 'ppt/slides/slide1.xml',
    slideXml:
      '<p:sld xmlns:a="a" xmlns:r="r" xmlns:p="p"><p:cSld><p:spTree><p:nvGrpSpPr/><p:grpSpPr/>' +
      `${body}</p:spTree></p:cSld></p:sld>`,
    ctx: {},
  })

const shape = (spPrTail: string, bodyPr = '<a:bodyPr/>', pPr = '') =>
  '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Shape 1"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>' +
  '<p:spPr><a:xfrm><a:off x="100" y="200"/><a:ext cx="3000" cy="2000"/></a:xfrm>' +
  `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>${spPrTail}</p:spPr>` +
  `<p:txBody>${bodyPr}<a:lstStyle/><a:p>${pPr}<a:r><a:rPr lang="en-US"/><a:t>a</a:t></a:r></a:p></p:txBody></p:sp>`

const LINE = '<a:solidFill><a:srgbClr val="000000"/></a:solidFill>'
const only = (body: string) => slideOf(body).elements[0] as TextElement

describe.each(INHERITED)('a value "%s" where a table key is expected', (name) => {
  it('a:ln cap and cmpd name no cap and no compound line', () => {
    expect(only(shape(`<a:ln cap="${name}">${LINE}</a:ln>`)).stroke!.cap).toBeUndefined()
    expect(only(shape(`<a:ln cmpd="${name}">${LINE}</a:ln>`)).stroke!.compound).toBeUndefined()
  })

  it('a:headEnd w and len are the default size, med', () => {
    const end = `<a:headEnd type="arrow" w="${name}" len="${name}"/>`
    expect(only(shape(`<a:ln>${LINE}${end}</a:ln>`)).stroke!.headEnd).toEqual({
      type: 'arrow',
      w: 'med',
      len: 'med',
    })
  })

  it('a:bodyPr anchor and a:pPr algn are no anchor and no alignment', () => {
    const box = only(shape('', `<a:bodyPr anchor="${name}"/>`, `<a:pPr algn="${name}"/>`))
    expect(box.text!.anchor).toBeUndefined()
    expect(box.text!.paragraphs[0]!.align).toBeUndefined()
  })

  it('a:tcPr anchor is no anchor', () => {
    const table = slideOf(
      '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="4" name="Table 1"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>' +
        '<p:xfrm><a:off x="10" y="20"/><a:ext cx="6000" cy="3000"/></p:xfrm>' +
        '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl>' +
        '<a:tblGrid><a:gridCol w="100"/></a:tblGrid><a:tr h="100"><a:tc><a:txBody><a:bodyPr/><a:lstStyle/>' +
        `<a:p><a:r><a:rPr lang="en-US"/><a:t>a</a:t></a:r></a:p></a:txBody><a:tcPr anchor="${name}"/></a:tc></a:tr>` +
        '</a:tbl></a:graphicData></a:graphic></p:graphicFrame>',
    ).elements[0] as TableElement
    expect(table.rows[0]![0]!.text!.anchor).toBeUndefined()
  })

  describe('in a layout placeholder', () => {
    const MASTER =
      '<p:sldMaster xmlns:a="a" xmlns:r="r" xmlns:p="p"><p:cSld><p:spTree><p:nvGrpSpPr/><p:grpSpPr/>' +
      '<p:sp><p:nvSpPr><p:cNvPr id="2" name="s"/><p:cNvSpPr/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr>' +
      '<p:spPr><a:xfrm><a:off x="1000" y="1000"/><a:ext cx="1000" cy="1000"/></a:xfrm></p:spPr>' +
      '<p:txBody><a:bodyPr anchor="ctr"/><a:lstStyle><a:lvl1pPr algn="r"/></a:lstStyle><a:p/></p:txBody></p:sp>' +
      '</p:spTree></p:cSld></p:sldMaster>'
    const layout = (bodyPr: string, lstStyle: string) =>
      '<p:sldLayout xmlns:a="a" xmlns:r="r" xmlns:p="p"><p:cSld><p:spTree><p:nvGrpSpPr/><p:grpSpPr/>' +
      '<p:sp><p:nvSpPr><p:cNvPr id="2" name="s"/><p:cNvSpPr/><p:nvPr><p:ph idx="1"/></p:nvPr></p:nvSpPr>' +
      `<p:spPr/><p:txBody>${bodyPr}<a:lstStyle>${lstStyle}</a:lstStyle><a:p/></p:txBody></p:sp>` +
      '</p:spTree></p:cSld></p:sldLayout>'

    it('bodyPr anchor names no anchor, and the master anchor shows through', () => {
      const map = parsePlaceholderMap(layout(`<a:bodyPr anchor="${name}"/>`, ''))
      expect(map.entries.some((e) => e.anchor !== undefined)).toBe(false)
      expect(resolvePlaceholderAnchor(map, parsePlaceholderMap(MASTER), 'body', '1')).toBe('middle')
    })

    it('lvl1pPr algn names no alignment', () => {
      const levels = parseLstStyleLevels({ 'a:lvl1pPr': { '@_algn': name, '@_marL': '5' } })
      expect(levels!.levels[0]).toEqual({ marL: 5 })
      const map = parsePlaceholderMap(layout('<a:bodyPr/>', `<a:lvl1pPr algn="${name}"/>`))
      expect(map.entries.some((e) => e.textStyle?.levels[0]?.align !== undefined)).toBe(false)
    })
  })

  it('a layout placeholder of that type carries the plain hint', async () => {
    const opened = await openPptx(await createBlankPptx())
    const path = listSlideLayouts(opened.archive)[0]!.path
    opened.archive.entries.set(
      path,
      Buffer.from(
        opened.archive
          .readText(path)!
          .replace(
            '</p:spTree>',
            () =>
              `<p:sp><p:nvSpPr><p:cNvPr id="90" name="x"/><p:cNvSpPr/><p:nvPr><p:ph type="${name}" idx="9"/></p:nvPr></p:nvSpPr>` +
              '<p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="10" cy="10"/></a:xfrm></p:spPr></p:sp></p:spTree>',
          ),
        'utf8',
      ),
    )
    const ph = listSlideLayouts(opened.archive)[0]!.placeholders.find((p) => p.idx === '9')!
    expect(ph.hint).toBe('Click to add text')
  })

  it('a picture or a media file of that extension is refused, not typed as a function', async () => {
    const opened = await openPptx(await createBlankPptx())
    expect(
      addPicture(opened, opened.deck.slides[0]!, { bytes: PNG, ext: name, offset: OFF }),
    ).toBeNull()
    expect(addMedia(opened, 0, { kind: 'video', bytes: PNG, ext: name, offset: OFF })).toBeNull()
    expect(defaultContentTypeFor(opened.archive.readText('[Content_Types].xml')!, name)).toBe(
      undefined,
    )
  })
})

describe('a name of the document used as a key', () => {
  it.each([[['__proto__']], [['__proto__', 'adj']]])('a preset guide named %j is kept', (names) => {
    const gds = names.map((n, i) => `<a:gd name="${n}" fmla="val ${5 + i}"/>`).join('')
    const box = only(
      shape('').replace(
        '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>',
        `<a:prstGeom prst="d"><a:avLst>${gds}</a:avLst></a:prstGeom>`,
      ),
    )
    // compared as entries: an object literal cannot hold an own `__proto__` entry
    expect(Object.entries(box.adjust!)).toEqual(names.map((n, i) => [n, 5 + i]))
    expect(Object.getPrototypeOf(box.adjust)).toBe(Object.prototype)
  })

  it('a theme font of script "__proto__" is kept, and the map stays a plain map', () => {
    const theme = parseTheme(
      '<a:theme xmlns:a="a" name="T"><a:themeElements><a:clrScheme name="c"/><a:fontScheme name="f">' +
        '<a:majorFont><a:latin typeface="Major"/></a:majorFont>' +
        '<a:minorFont><a:latin typeface="Minor"/><a:font script="Jpan" typeface="Gothic"/>' +
        '<a:font script="__proto__" typeface="Proto"/></a:minorFont>' +
        '</a:fontScheme></a:themeElements></a:theme>',
    )
    const fonts = theme.minorScriptFonts!
    expect(Object.entries(fonts)).toEqual([
      ['Jpan', 'Gothic'],
      ['__proto__', 'Proto'],
    ])
    expect(Object.getPrototypeOf(fonts)).toBe(Object.prototype)
  })
})

describe('a part extension of the document used as a key', () => {
  /** A deck whose picture part has the extension `ext`, declared by a Default of its own. */
  async function deckWithPictureExt(ext: string): Promise<Uint8Array> {
    const built = await openPptx(await createBlankPptx())
    const pic = addPicture(built, built.deck.slides[0]!, { bytes: PNG, ext: 'png', offset: OFF })!
    const zip = await JSZip.loadAsync(await savePptx(built))
    const to = pic.mediaRef!.replace(/\.png$/, `.${ext}`)
    zip.file(to, await zip.file(pic.mediaRef!)!.async('uint8array'))
    zip.remove(pic.mediaRef!)
    const from = pic.mediaRef!.split('/').pop()!
    for (const name of Object.keys(zip.files).filter((n) => n.endsWith('.rels'))) {
      const xml = await zip.file(name)!.async('string')
      zip.file(name, xml.split(from).join(to.split('/').pop()!))
    }
    const ct = await zip.file('[Content_Types].xml')!.async('string')
    zip.file(
      '[Content_Types].xml',
      ct.replace('</Types>', `<Default Extension="${ext}" ContentType="image/png"/></Types>`),
    )
    return zip.generateAsync({ type: 'uint8array' })
  }

  it.each(['__proto__', 'constructor'])(
    'a slide pasted with a "%s" picture keeps its content type',
    async (ext) => {
      const source = await openPptx(await deckWithPictureExt(ext))
      const target = await openPptx(await createBlankPptx())
      expect(pasteSlide(target, 0, copySlide(source, 0)!)).not.toBeNull()
      const ct = target.archive.readText('[Content_Types].xml')!
      expect(defaultContentTypeFor(ct, ext)).toBe('image/png')
    },
  )

  it.each(['__proto__', 'constructor'])(
    'a picture pasted on its own with a "%s" part keeps its content type',
    async (ext) => {
      const source = await openPptx(await deckWithPictureExt(ext))
      const slide = source.deck.slides[0]!
      const pic = slide.elements.find((e) => e.type === 'picture')!
      // the clipboard crosses as JSON, as it does between windows
      const item = JSON.parse(JSON.stringify(copyElementData(source, slide, pic)))
      const target = await openPptx(await createBlankPptx())
      expect(pasteElements(target, 0, [item], { dx: 0, dy: 0 })).not.toBeNull()
      const ct = target.archive.readText('[Content_Types].xml')!
      expect(defaultContentTypeFor(ct, ext)).toBe('image/png')
    },
  )

  it.each(['__proto__', 'constructor'])(
    'a slide merged with a "%s" picture is typed as an unknown file',
    async (ext) => {
      const source = (await extractMergeSlideSource(await deckWithPictureExt(ext)))!
      const target = await openPptx(await createBlankPptx())
      expect(mergeSlideFromSource(target, source)).not.toBeNull()
      const ct = target.archive.readText('[Content_Types].xml')!
      expect(defaultContentTypeFor(ct, ext)).toBe('application/octet-stream')
    },
  )
})
