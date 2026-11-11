/**
 * Character references in the surrogate range (&#xD800; .. &#xDFFF;). XML
 * forbids them, a crafted part can still carry one. Read on its own, such a
 * reference is U+FFFD and never half of a surrogate pair; a high and a low
 * surrogate written as two adjacent references still spell their one character.
 */
import { describe, expect, it } from 'vitest'
import {
  parseAppPropertiesXml,
  parseCorePropertiesXml,
  parseCustomPropertiesXml,
  parseDocx,
  parseZoteroDocumentDataXml,
  planRemoveParts,
} from '../src/index'
import { sdtCheckboxGlyphs } from '../src/checkbox-control'
import { buildDocx } from './helpers/build-docx'

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
const EMOJI = '\u{1F600}'
const REPLACEMENT = '\uFFFD'

/** half of a surrogate pair without its partner (the u flag reads a whole pair as one character) */
const LONE_SURROGATE = /[\uD800-\uDFFF]/u

const property = (name: string, value: string, pid = 2): string =>
  `<property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="${pid}" name="${name}">` +
  `<vt:lpwstr>${value}</vt:lpwstr></property>`

const customXml = (properties: string): string =>
  XML_DECL +
  '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" ' +
  'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
  `${properties}</Properties>`

const customValue = (value: string): string =>
  parseCustomPropertiesXml(customXml(property('Key', value))).Key

const customName = (name: string): string =>
  Object.keys(parseCustomPropertiesXml(customXml(property(name, 'v'))))[0]

/** [the text as the part writes it, the text it reads as] */
const LONE_REFERENCES: Array<[string, string]> = [
  ['&#xD800;', REPLACEMENT],
  ['&#xDBFF;', REPLACEMENT],
  ['&#xDC00;', REPLACEMENT],
  ['&#xdfff;', REPLACEMENT],
  ['&#55296;', REPLACEMENT],
  ['&#57343;', REPLACEMENT],
  ['a&#xD800;b', `a${REPLACEMENT}b`],
  // a low surrogate before a high one is not a pair
  ['&#xDE00;&#xD83D;', REPLACEMENT + REPLACEMENT],
  // two high surrogates, then the low one: only the last two pair up
  ['&#xD83D;&#xD83D;&#xDE00;', REPLACEMENT + EMOJI],
  // the pair is broken by the character between its halves
  ['&#xD83D;-&#xDE00;', `${REPLACEMENT}-${REPLACEMENT}`],
]

/** a high and a low surrogate as two adjacent references spell one character */
const PAIRED_REFERENCES: Array<[string, string]> = [
  ['&#xD83D;&#xDE00;', EMOJI],
  ['&#55357;&#56832;', EMOJI],
  ['&#xD83D;&#56832;', EMOJI],
  ['&#x1F600;', EMOJI],
  ['a&#xD83D;&#xDE00;b', `a${EMOJI}b`],
]

describe('surrogate character references in document properties', () => {
  it.each(LONE_REFERENCES)('reads the custom property value %s as %j', (written, read) => {
    const value = customValue(written)
    expect(LONE_SURROGATE.test(value)).toBe(false)
    expect(value).toBe(read)
  })

  it.each(LONE_REFERENCES)('reads the custom property name %s as %j', (written, read) => {
    const name = customName(written)
    expect(LONE_SURROGATE.test(name)).toBe(false)
    expect(name).toBe(read)
  })

  it.each(PAIRED_REFERENCES)('combines the references %s into %j', (written, read) => {
    expect(customValue(written)).toBe(read)
    expect(customName(written)).toBe(read)
  })

  it('reads core and extended properties the same way', () => {
    const core = parseCorePropertiesXml(
      XML_DECL +
        '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
        'xmlns:dc="http://purl.org/dc/elements/1.1/">' +
        '<dc:title>T&#xD800;</dc:title><dc:creator>&#xD83D;&#xDE00;</dc:creator></cp:coreProperties>',
    )
    expect(core).toMatchObject({ title: `T${REPLACEMENT}`, creator: EMOJI })
    const app = parseAppPropertiesXml(
      XML_DECL +
        '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">' +
        '<Company>C&#xDFFF;</Company></Properties>',
    )
    expect(app).toMatchObject({ company: `C${REPLACEMENT}` })
  })

  it('reads the Zotero document data the same way', () => {
    const xml = customXml(
      property('ZOTERO_PREF_1', 'a&#xD800;', 2) + property('ZOTERO_PREF_2', '&#xD83D;&#xDE00;', 3),
    )
    expect(parseZoteroDocumentDataXml(xml)).toBe(`a${REPLACEMENT}${EMOJI}`)
  })

  it('opens a document whose properties carry such references', async () => {
    const doc = await parseDocx(
      await buildDocx({
        bodyXml: '<w:p><w:r><w:t>Text</w:t></w:r></w:p>',
        extraParts: [
          {
            path: 'docProps/custom.xml',
            xml: customXml(
              property('Lone&#xD800;', 'v&#xDC00;', 2) + property('Pair', '&#xD83D;&#xDE00;', 3),
            ),
            contentType: 'application/vnd.openxmlformats-officedocument.custom-properties+xml',
          },
        ],
      }),
    )
    expect(doc.properties.custom).toEqual({
      [`Lone${REPLACEMENT}`]: `v${REPLACEMENT}`,
      Pair: EMOJI,
    })
    expect(Object.keys(doc.properties.customTypes)).toEqual([`Lone${REPLACEMENT}`, 'Pair'])
  })

  it('keeps a reference above U+10FFFF as written and still opens the document', async () => {
    // no such character exists: the reference stays the text the part holds
    for (const written of [
      '&#x110000;',
      '&#1114112;',
      '&#xFFFFFFFFFFFFFFFFFFFF;',
      `&#${'9'.repeat(400)};`,
    ]) {
      expect(customValue(written), written).toBe(written)
      expect(customName(written), written).toBe(written)
    }
    const doc = await parseDocx(
      await buildDocx({
        bodyXml: '<w:p><w:r><w:t>Text</w:t></w:r></w:p>',
        extraParts: [
          {
            path: 'docProps/custom.xml',
            xml: customXml(property('Big&#x110000;', '&#x110000;')),
            contentType: 'application/vnd.openxmlformats-officedocument.custom-properties+xml',
          },
        ],
      }),
    )
    expect(doc.properties.custom).toEqual({ 'Big&#x110000;': '&#x110000;' })
  })
})

describe('surrogate character references in a remove_parts plan', () => {
  const STORE_ITEM_ID = '{AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE}'

  const boundControl = (tag: string): string =>
    `<w:sdt><w:sdtPr><w:id w:val="42"/><w:tag w:val="${tag}"/>` +
    `<w:dataBinding w:xpath="/matter/client" w:storeItemID="${STORE_ITEM_ID}"/></w:sdtPr>` +
    '<w:sdtContent><w:p><w:r><w:t>Acme</w:t></w:r></w:p></w:sdtContent></w:sdt>'

  const tagOfPlan = async (tag: string): Promise<string | undefined> => {
    const bytes = await buildDocx({
      bodyXml: boundControl(tag),
      extraParts: [
        {
          path: 'customXml/item1.xml',
          xml: `${XML_DECL}<matter><client>Acme</client></matter>`,
          contentType: 'application/xml',
        },
        {
          path: 'customXml/itemProps1.xml',
          xml:
            XML_DECL +
            `<ds:datastoreItem ds:itemID="${STORE_ITEM_ID}" ` +
            'xmlns:ds="http://schemas.openxmlformats.org/officeDocument/2006/customXml"/>',
          contentType: 'application/vnd.openxmlformats-officedocument.customXmlProperties+xml',
        },
      ],
    })
    const plan = await planRemoveParts(bytes, { kinds: ['customXml'] })
    expect(plan.dataBindings).toHaveLength(1)
    return plan.dataBindings[0].tag
  }

  it('reports the tag of a bound control without half a surrogate pair', async () => {
    expect(await tagOfPlan('Client&#xD800;')).toBe(`Client${REPLACEMENT}`)
    expect(await tagOfPlan('Client&#57343;')).toBe(`Client${REPLACEMENT}`)
  })

  it('combines a pair written as two references in the tag', async () => {
    expect(await tagOfPlan('Client&#xD83D;&#xDE00;')).toBe(`Client${EMOJI}`)
  })
})

describe('surrogate code points as checkbox glyphs', () => {
  const glyphsOf = (checked: string, unchecked: string) =>
    sdtCheckboxGlyphs(
      `<w:sdtPr><w14:checkbox><w14:checkedState w14:val="${checked}"/>` +
        `<w14:uncheckedState w14:val="${unchecked}"/></w14:checkbox></w:sdtPr>`,
    )

  it("falls back to Word's own glyphs for a value that is half a surrogate pair", () => {
    // the same glyphs an absent or unreadable value gets
    const defaults = glyphsOf('', '')
    expect(glyphsOf('D83D', 'DE00')).toEqual(defaults)
    expect(glyphsOf('D800', 'DFFF')).toEqual(defaults)
  })

  it('still reads a glyph outside the BMP', () => {
    expect(glyphsOf('1F600', '2610')).toEqual({ checked: EMOJI, unchecked: '\u2610' })
  })
})
