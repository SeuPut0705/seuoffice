/**
 * The rest of the lookups a document (or an unchecked option) reaches with a
 * key every object inherits: see inherited-key-lookups.test.ts for the class.
 * Each case is held against an ordinary unknown value, which is what an
 * inherited key has to read as.
 */
import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { parseChartPartXml } from '../src/chart'
import {
  patchAppPropertiesXml,
  patchCorePropertiesXml,
  patchCustomPropertiesXml,
} from '../src/doc-properties'
import { buildLineParagraphXml, mergePPrFormat, patchTableCellTexts } from '../src/generate'
import { mergeFieldText, valueOf } from '../src/mail-merge'
import { normalizeOoxmlXml } from '../src/ooxml-normalize'
import { parseDocx } from '../src/parse'
import { colorNodeHex } from '../src/parse-drawing-geometry'
import { vmlShapeSvg } from '../src/parse-vml'
import { saveDocx } from '../src/patch'
import { planRemoveParts } from '../src/remove-parts'
import { applyTrackedChangesXml, countTrackedChangesXml } from '../src/revision-xml'
import { xmlParser, type XNode } from '../src/xml-utils'
import { IMAGE_PARAGRAPH_XML, TABLE_XML, TINY_PNG_BASE64, buildDocx } from './helpers/build-docx'

const INHERITED_KEYS = ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__']
/** the inherited keys a tag-name scan can read (it wants a leading letter) */
const INHERITED_TAG_NAMES = ['constructor', 'toString', 'valueOf', 'hasOwnProperty']
/** the inherited keys that survive lower-casing */
const LOWER_CASE_INHERITED_KEYS = ['constructor', '__proto__']

const A_NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'

describe('run and paragraph content read from a document', () => {
  const textOf = async (bodyXml: string): Promise<string> => {
    const parsed = await parseDocx(await buildDocx({ bodyXml }))
    return (parsed.blocks[0]!.runs ?? []).map((run) => run.text).join('')
  }

  it.each(INHERITED_KEYS)('w:br w:type="%s" is a soft line break', async (key) => {
    const para = (type: string) =>
      `<w:p><w:r><w:t>a</w:t><w:br w:type="${type}"/><w:t>b</w:t></w:r></w:p>`
    expect(await textOf(para(key))).toBe('a\nb')
    expect(await textOf(para('page'))).toBe('a\fb')
  })

  it.each(LOWER_CASE_INHERITED_KEYS)(
    'a picture part with the extension .%s takes its type from the content types',
    async (extension) => {
      const picture = async (ext: string) => {
        const parsed = await parseDocx(
          await buildDocx({
            bodyXml: IMAGE_PARAGRAPH_XML,
            extraRels: `<Relationship Id="rId10" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.${ext}"/>`,
            binaryParts: [
              {
                path: `word/media/image1.${ext}`,
                base64: TINY_PNG_BASE64,
                extension: ext,
                contentType: 'image/png',
              },
            ],
          }),
        )
        return parsed.blocks[0]!.imageDataUrl
      }
      expect(await picture('bin')).toMatch(/^data:image\/png;base64,/)
      expect(await picture(extension)).toBe(await picture('bin'))
    },
  )
})

describe('DrawingML colours read from a document', () => {
  const solidFill = (inner: string): XNode =>
    (xmlParser.parse(`<a:solidFill ${A_NS}>${inner}</a:solidFill>`) as XNode[])[0]!

  it.each(INHERITED_KEYS)('a:prstClr val="%s" is no colour', (key) => {
    expect(colorNodeHex(solidFill(`<a:prstClr val="${key}"/>`))).toBeUndefined()
    expect(colorNodeHex(solidFill('<a:prstClr val="red"/>'))).toBe('FF0000')
  })

  it.each(INHERITED_KEYS)('a textbox filled with a:prstClr val="%s" still parses', async (key) => {
    const box = (prstClr: string) =>
      '<w:p><w:r><w:drawing><wp:anchor behindDoc="0" simplePos="0" locked="0" layoutInCell="1" allowOverlap="1">' +
      '<wp:simplePos x="0" y="0"/><wp:extent cx="4897120" cy="520700"/><wp:wrapNone/>' +
      '<a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">' +
      '<wps:wsp xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">' +
      '<wps:spPr><a:prstGeom prst="rect"><a:avLst/></a:prstGeom>' +
      `<a:solidFill><a:prstClr val="${prstClr}"/></a:solidFill><a:ln><a:noFill/></a:ln></wps:spPr>` +
      '<wps:txbx><w:txbxContent><w:p><w:r><w:t>boxed</w:t></w:r></w:p></w:txbxContent></wps:txbx>' +
      '</wps:wsp></a:graphicData></a:graphic></wp:anchor></w:drawing></w:r></w:p>'
    const textboxes = async (prstClr: string) =>
      (await parseDocx(await buildDocx({ bodyXml: box(prstClr) }))).blocks[0]!.textboxes
    expect(await textboxes(key)).toEqual(await textboxes('notAColour'))
    expect((await textboxes(key))?.[0]?.paras[0]?.runs[0]?.text).toBe('boxed')
  })

  it.each(INHERITED_KEYS)('a diagram shape filled with a:schemeClr val="%s"', async (key) => {
    const drawing = (scheme: string) =>
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      `<dsp:drawing xmlns:dsp="http://schemas.microsoft.com/office/drawing/2008/diagram" ${A_NS}>` +
      '<dsp:spTree><dsp:sp><dsp:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm>' +
      `<a:prstGeom prst="rect"/><a:solidFill><a:schemeClr val="${scheme}"/></a:solidFill>` +
      '</dsp:spPr></dsp:sp></dsp:spTree></dsp:drawing>'
    const fillOf = async (scheme: string) => {
      const parsed = await parseDocx(
        await buildDocx({
          bodyXml:
            '<w:p><w:r><w:drawing><wp:inline><wp:extent cx="5486400" cy="419100"/>' +
            '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/diagram">' +
            '<dgm:relIds xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram" r:dm="rId40"/>' +
            '</a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>',
          extraRels:
            '<Relationship Id="rId40" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/diagramData" Target="diagrams/data1.xml"/>',
          extraParts: [
            {
              path: 'word/diagrams/data1.xml',
              xml: '<dgm:dataModel xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram"/>',
              contentType:
                'application/vnd.openxmlformats-officedocument.drawingml.diagramData+xml',
            },
            {
              path: 'word/diagrams/drawing1.xml',
              xml: drawing(scheme),
              contentType: 'application/vnd.ms-office.drawingml.diagramDrawing+xml',
            },
          ],
        }),
      )
      return parsed.blocks[0]!.diagramDisplay?.shapes[0]?.fillHex
    }
    expect(await fillOf('notASlot')).toMatch(/^[0-9A-F]{6}$/)
    expect(await fillOf(key)).toBe(await fillOf('notASlot'))
  })

  // the path reader walks `length` characters, so the inherited functions that take an argument are the ones it trips on
  it.each(['constructor', 'hasOwnProperty'])(
    'a VML shape with o:spt="%s" has no preset path',
    (key) => {
      const pict = (spt: string) =>
        `<w:pict><v:shape o:spt="${spt}" style="width:10pt;height:10pt" fillcolor="red"/></w:pict>`
      expect(vmlShapeSvg(pict('1'))).not.toBeNull()
      expect(vmlShapeSvg(pict('999'))).toBeNull()
      expect(vmlShapeSvg(pict(key))).toBeNull()
    },
  )
})

describe('theme fonts', () => {
  const BATANG = '\ubc14\ud0d5'
  const MALGUN = '\ub9d1\uc740 \uace0\ub515'
  const themePart = (scripts: string) => ({
    path: 'word/theme/theme1.xml',
    xml:
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      `<a:theme ${A_NS} name="T"><a:themeElements><a:fontScheme name="T">` +
      `<a:majorFont><a:latin typeface="Aptos Display"/><a:ea typeface="${BATANG}"/><a:cs typeface=""/>${scripts}</a:majorFont>` +
      `<a:minorFont><a:latin typeface="Aptos"/><a:ea typeface="${BATANG}"/><a:cs typeface=""/>${scripts}</a:minorFont>` +
      '</a:fontScheme></a:themeElements></a:theme>',
    contentType: 'application/vnd.openxmlformats-officedocument.theme+xml',
  })
  const settingsPart = (eaLang: string) => ({
    path: 'word/settings.xml',
    xml:
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      `<w:themeFontLang w:val="en-US" w:eastAsia="${eaLang}"/></w:settings>`,
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml',
  })

  it.each(['Constructor', ...LOWER_CASE_INHERITED_KEYS])(
    'themeFontLang w:eastAsia="%s" picks no script-table face',
    async (lang) => {
      // what the inherited value reads as when it is taken for a script name
      const inheritedScript = String(({} as Record<string, unknown>)[lang.toLowerCase()])
      const scripts =
        `<a:font script="Hang" typeface="${MALGUN}"/>` +
        `<a:font script="${inheritedScript}" typeface="Wrong Face"/>`
      const fontOf = async (eaLang: string) => {
        const parsed = await parseDocx(
          await buildDocx({
            bodyXml:
              '<w:p><w:r><w:rPr><w:rFonts w:eastAsiaTheme="minorEastAsia"/></w:rPr>' +
              '<w:t>\ubcf8\ubb38</w:t></w:r></w:p>',
            extraParts: [themePart(scripts), settingsPart(eaLang)],
          }),
        )
        return parsed.blocks[0]!.runs![0]!.font
      }
      expect(await fontOf('ko-KR')).toBe(MALGUN)
      expect(await fontOf(lang)).toBe(BATANG)
    },
  )
})

describe('charts', () => {
  it.each(INHERITED_KEYS)('a cx:series with layoutId="%s" is an unknown chart kind', (key) => {
    const chartex = (layoutId: string) =>
      '<cx:chartSpace xmlns:cx="http://schemas.microsoft.com/office/drawing/2014/chartex">' +
      '<cx:chartData><cx:data id="0"><cx:numDim type="val"><cx:f>S!$A$2:$A$4</cx:f><cx:lvl ptCount="3">' +
      '<cx:pt idx="0">100</cx:pt><cx:pt idx="1">-40</cx:pt><cx:pt idx="2">60</cx:pt>' +
      '</cx:lvl></cx:numDim></cx:data></cx:chartData>' +
      '<cx:chart><cx:plotArea><cx:plotAreaRegion>' +
      `<cx:series layoutId="${layoutId}"><cx:tx><cx:txData><cx:v>Series1</cx:v></cx:txData></cx:tx>` +
      '<cx:dataId val="0"/></cx:series>' +
      '</cx:plotAreaRegion></cx:plotArea></cx:chart></cx:chartSpace>'
    const kindOf = (layoutId: string) =>
      parseChartPartXml(chartex(layoutId), 'word/charts/chartEx1.xml')?.kind
    expect(kindOf('waterfall')).toBe('bar')
    expect(kindOf('notALayout')).toBe('other')
    expect(kindOf(key)).toBe('other')
  })
})

describe('tracked changes in a part kept as XML', () => {
  it.each(INHERITED_TAG_NAMES)('an element named %s is not a revision', (name) => {
    const header = (extra: string) =>
      '<w:hdr xmlns:w="w"><w:p><w:ins w:id="1" w:author="A"><w:r><w:t>new</w:t></w:r></w:ins>' +
      `${extra}</w:p></w:hdr>`
    const xml = header(`<${name} w:id="2" w:author="A"/>`)
    expect(countTrackedChangesXml(xml)).toBe(1)
    const accepted = applyTrackedChangesXml(xml, 'accept')
    expect(accepted.applied).toBe(1)
    expect(accepted.xml).toContain(`<${name} w:id="2" w:author="A"/>`)
  })
})

describe('strict-to-transitional normalization', () => {
  it.each(INHERITED_KEYS)('a strict relationship type ending in /%s keeps its tail', (key) => {
    const rels = (base: string, tail: string) =>
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      `<Relationship Id="rId1" Type="${base}${tail}" Target="x.xml"/></Relationships>`
    const strict = 'http://purl.oclc.org/ooxml/officeDocument/relationships/'
    const transitional = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/'
    expect(normalizeOoxmlXml(rels(strict, 'extendedProperties'))).toBe(
      rels(transitional, 'extended-properties'),
    )
    expect(normalizeOoxmlXml(rels(strict, key))).toBe(rels(transitional, key))
  })
})

describe('mail merge', () => {
  it.each(INHERITED_KEYS)('a merge field named %s with no such column is empty', (name) => {
    expect(valueOf({ Name: 'Ada' }, name)).toBe('')
    expect(mergeFieldText(`MERGEFIELD ${name}`, { Name: 'Ada' })).toBe('')
    expect(mergeFieldText('MERGEFIELD Name', { Name: 'Ada' })).toBe('Ada')
  })
})

describe('writing a document', () => {
  it.each(INHERITED_KEYS)('a table cell whose text is %s keeps that text', (key) => {
    const patched = (text: string) => patchTableCellTexts(TABLE_XML, [[[text], null], null])
    expect(patched(key)).toBe(patched('plainword').replace('plainword', key))
  })

  it.each(INHERITED_KEYS)('a line of kind %s is drawn as a plain line', (key) => {
    expect(buildLineParagraphXml({ kind: key })).toBe(buildLineParagraphXml({ kind: 'line' }))
    expect(buildLineParagraphXml({ kind: 'lineArrow' })).toContain('<a:tailEnd type="triangle"/>')
  })

  it.each(INHERITED_KEYS)('an unedited w:jc w:val="%s" keeps its bytes', (key) => {
    const pPr = (jc: string) => `<w:pPr><w:keepNext/><w:jc w:val="${jc}"/></w:pPr>`
    // numTab is a real ST_Jc value the engine does not model: the model holds no align for it
    expect(mergePPrFormat(pPr('numTab'), {})).toBe(pPr('numTab'))
    expect(mergePPrFormat(pPr(key), {})).toBe(pPr(key))
  })

  it.each(INHERITED_KEYS)(
    'a package entry named %s survives a save with part edits',
    async (name) => {
      const zip = await JSZip.loadAsync(
        await buildDocx({ bodyXml: '<w:p><w:r><w:t>hello</w:t></w:r></w:p>' }),
      )
      zip.file(name, 'payload')
      const stylesXml = await zip.file('word/styles.xml')!.async('string')
      const parsed = await parseDocx(await zip.generateAsync({ type: 'uint8array' }))
      for (const options of [
        { partXml: { 'word/styles.xml': stylesXml } },
        { partBinary: { 'word/styles.xml': Buffer.from(stylesXml).toString('base64') } },
      ]) {
        const saved = await saveDocx(parsed, [{ kind: 'original', docxIndex: 0 }], options)
        const entry = (await JSZip.loadAsync(saved)).file(name)
        expect(await entry?.async('string')).toBe('payload')
      }
    },
  )
})

describe('document properties', () => {
  const CORE_XML =
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"' +
    ' xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>T</dc:title></cp:coreProperties>'
  const APP_XML =
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">' +
    '<Company>C</Company></Properties>'
  const CUSTOM_XML =
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties"' +
    ' xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"></Properties>'

  it.each(INHERITED_KEYS)('%s is not a core or app property', (key) => {
    expect(patchCorePropertiesXml(CORE_XML, { [key]: 'x' })).toBe(CORE_XML)
    expect(patchCorePropertiesXml(CORE_XML, { [key]: null })).toBe(CORE_XML)
    expect(patchAppPropertiesXml(APP_XML, { [key]: 'x' })).toBe(APP_XML)
    expect(patchAppPropertiesXml(APP_XML, { [key]: null })).toBe(APP_XML)
    expect(patchCorePropertiesXml(CORE_XML, { title: 'New' })).toContain('<dc:title>New</dc:title>')
  })

  it.each(INHERITED_KEYS)('a new custom property named %s takes the type of its value', (key) => {
    const written = (name: string) =>
      patchCustomPropertiesXml(CUSTOM_XML, Object.fromEntries([[name, 5]]))
    expect(written('count')).toContain('<vt:i4>5</vt:i4>')
    expect(written(key)).toBe(written('count').replace('name="count"', `name="${key}"`))
  })
})

describe('remove_parts', () => {
  it('a part family named __proto__ selects nothing', async () => {
    const zip = await JSZip.loadAsync(
      await buildDocx({ bodyXml: '<w:p><w:r><w:t>hello</w:t></w:r></w:p>' }),
    )
    // what Object.prototype reads as when it is taken for a path prefix
    zip.file('[object Object]/item1.xml', '<x/>')
    const bytes = await zip.generateAsync({ type: 'uint8array' })
    const plan = await planRemoveParts(bytes, { kinds: ['__proto__' as 'customXml'] })
    expect(plan.removedPaths).toEqual([])
  })
})
