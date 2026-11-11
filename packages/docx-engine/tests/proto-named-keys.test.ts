/**
 * A record keyed by names a document gives has to hold the name `__proto__`
 * like any other. A plain assignment `record['__proto__'] = value` stores
 * nothing: a string is ignored, an object (or null) becomes the record's
 * prototype. The entry then is in neither Object.keys nor JSON, and a save
 * that goes through the record loses it.
 */
import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import {
  parseCustomPropertiesXml,
  parseCustomPropertyTypesXml,
  parsePropertyChanges,
  patchCustomPropertiesXml,
} from '../src/doc-properties'
import { mergeBlockTree, mergeDataFromRows, mergeFieldText } from '../src/mail-merge'
import { parseDocx } from '../src/parse'
import { vmlShapeTypeTable } from '../src/parse-vml'
import { saveDocx } from '../src/patch'
import { readThemeFonts } from '../src/theme'
import type { Block } from '../src/types'
import { CHART_PARAGRAPH_XML, CHART_PART_XML, buildDocx } from './helpers/build-docx'

const PROTO = '__proto__'
const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
const PLAIN_PARA = '<w:p><w:r><w:t>hello</w:t></w:r></w:p>'

/** an ordinary record: own enumerable entries, Object.prototype behind it, JSON keeps every entry */
function expectPlainRecord(record: object | undefined, entries: Array<[string, unknown]>): void {
  expect(Object.entries(record ?? {})).toEqual(entries)
  expect(Object.getPrototypeOf(record)).toBe(Object.prototype)
  expect(Object.entries({ ...record })).toEqual(entries)
  expect(Object.entries(JSON.parse(JSON.stringify(record)) as object)).toEqual(entries)
}

describe('a custom document property named __proto__', () => {
  const property = (pid: number, name: string, type: string, value: string) =>
    `<property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="${pid}" name="${name}">` +
    `<vt:${type}>${value}</vt:${type}></property>`
  const CUSTOM_XML =
    XML_DECL +
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties"' +
    ' xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
    property(2, PROTO, 'r8', '1.5') +
    property(3, 'Client', 'lpwstr', 'Acme') +
    '</Properties>'
  const sourceDocx = () =>
    buildDocx({
      bodyXml: PLAIN_PARA,
      extraParts: [
        {
          path: 'docProps/custom.xml',
          xml: CUSTOM_XML,
          contentType: 'application/vnd.openxmlformats-officedocument.custom-properties+xml',
        },
      ],
    })

  it('is read with its value and type', () => {
    expectPlainRecord(parseCustomPropertiesXml(CUSTOM_XML), [
      [PROTO, '1.5'],
      ['Client', 'Acme'],
    ])
    expectPlainRecord(parseCustomPropertyTypesXml(CUSTOM_XML), [
      [PROTO, 'r8'],
      ['Client', 'lpwstr'],
    ])
  })

  it('survives a patch of another property', () => {
    const patched = patchCustomPropertiesXml(CUSTOM_XML, { Client: 'Globex' })
    expect(Object.entries(parseCustomPropertiesXml(patched))).toEqual([
      [PROTO, '1.5'],
      ['Client', 'Globex'],
    ])
    expect(Object.entries(parseCustomPropertyTypesXml(patched))).toEqual([
      [PROTO, 'r8'],
      ['Client', 'lpwstr'],
    ])
  })

  it('keeps its stored type when it is the one patched', () => {
    const patched = patchCustomPropertiesXml(CUSTOM_XML, Object.fromEntries([[PROTO, 2]]))
    expect(Object.entries(parseCustomPropertiesXml(patched))).toEqual([
      [PROTO, '2'],
      ['Client', 'Acme'],
    ])
    expect(Object.entries(parseCustomPropertyTypesXml(patched))).toEqual([
      [PROTO, 'r8'],
      ['Client', 'lpwstr'],
    ])
  })

  it('is a change set_properties accepts: a value to set, or null to remove', () => {
    const set = parsePropertyChanges({ custom: JSON.parse('{"__proto__":"v","Client":null}') })
    expectPlainRecord(set.custom, [
      [PROTO, 'v'],
      ['Client', null],
    ])
    const removal = parsePropertyChanges({ custom: JSON.parse('{"__proto__":null}') })
    expectPlainRecord(removal.custom, [[PROTO, null]])
  })

  it('is on the parsed document and survives a save that sets another property', async () => {
    const parsed = await parseDocx(await sourceDocx())
    expectPlainRecord(parsed.properties.custom, [
      [PROTO, '1.5'],
      ['Client', 'Acme'],
    ])
    const saved = await saveDocx(parsed, [{ kind: 'original', docxIndex: 0 }], {
      properties: parsePropertyChanges({ custom: { Client: 'Globex', Count: 7 } }),
    })
    const reparsed = await parseDocx(saved)
    expect(Object.entries(reparsed.properties.custom)).toEqual([
      [PROTO, '1.5'],
      ['Client', 'Globex'],
      ['Count', '7'],
    ])
    expect(Object.entries(reparsed.properties.customTypes)).toEqual([
      [PROTO, 'r8'],
      ['Client', 'lpwstr'],
      ['Count', 'i4'],
    ])
  })

  it('is set and removed by a save like any other property', async () => {
    const parsed = await parseDocx(await sourceDocx())
    const blocks = [{ kind: 'original' as const, docxIndex: 0 }]
    const changed = await parseDocx(
      await saveDocx(parsed, blocks, {
        properties: parsePropertyChanges({ custom: JSON.parse('{"__proto__":3}') }),
      }),
    )
    expect(Object.entries(changed.properties.custom)).toEqual([
      [PROTO, '3'],
      ['Client', 'Acme'],
    ])
    expect(Object.entries(changed.properties.customTypes)[0]).toEqual([PROTO, 'r8'])
    const removed = await parseDocx(
      await saveDocx(parsed, blocks, {
        properties: parsePropertyChanges({ custom: JSON.parse('{"__proto__":null}') }),
      }),
    )
    expect(Object.entries(removed.properties.custom)).toEqual([['Client', 'Acme']])
  })
})

describe('a mail-merge column named __proto__', () => {
  const data = mergeDataFromRows([
    ['Name', PROTO],
    ['Ada', 'first'],
    ['Grace', 'second'],
  ])

  it('is a column of every record', () => {
    expectPlainRecord(data.records[0], [
      ['Name', 'Ada'],
      [PROTO, 'first'],
    ])
  })

  it('fills its merge field', () => {
    expect(mergeFieldText(`MERGEFIELD ${PROTO}`, data.records[1]!)).toBe('second')
    const template = {
      id: '',
      docxIndex: 0,
      originalXml: '',
      type: 'paragraph',
      runs: [{ text: `«${PROTO}»`, instrField: `MERGEFIELD ${PROTO}` }],
    } as unknown as Block
    const merged = mergeBlockTree([template], data)
    expect(merged.map((blocks) => blocks[0]!.runs?.map((run) => run.text).join(''))).toEqual([
      'first',
      'second',
    ])
  })
})

describe('theme font scripts', () => {
  it('a font group keeps a script named __proto__', () => {
    const group = (tag: string, fonts: string) =>
      `<a:${tag}><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/>${fonts}</a:${tag}>`
    const proto = `<a:font script="${PROTO}" typeface="Odd"/>`
    const fonts = readThemeFonts(
      '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="T">' +
        '<a:themeElements><a:fontScheme name="T">' +
        group('majorFont', `<a:font script="Hang" typeface="Malgun Gothic"/>${proto}`) +
        group('minorFont', proto) +
        '</a:fontScheme></a:themeElements></a:theme>',
    )
    expectPlainRecord(fonts?.majorScripts, [
      ['Hang', 'Malgun Gothic'],
      [PROTO, 'Odd'],
    ])
    expectPlainRecord(fonts?.minorScripts, [[PROTO, 'Odd']])
  })
})

describe('VML shapetype attributes', () => {
  it('a template keeps an attribute named __proto__', () => {
    const table = vmlShapeTypeTable(
      `<w:pict><v:shapetype id="t1" ${PROTO}="x" path="m,l,21600r21600,l21600,xe"/></w:pict>`,
    )
    expectPlainRecord(table.get('t1'), [
      ['id', 't1'],
      [PROTO, 'x'],
      ['path', 'm,l,21600r21600,l21600,xe'],
    ])
  })
})

describe('parts a document names __proto__', () => {
  it('a header whose relationship id is __proto__ is one of the header parts', async () => {
    const headerXml = `${XML_DECL}<w:hdr ${W_NS}><w:p><w:r><w:t>running head</w:t></w:r></w:p></w:hdr>`
    const parsed = await parseDocx(
      await buildDocx({
        bodyXml: PLAIN_PARA,
        sectPrExtra: `<w:headerReference w:type="default" r:id="${PROTO}"/>`,
        extraRels: `<Relationship Id="${PROTO}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>`,
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
    expect(Object.keys(parsed.hfParts ?? {})).toEqual([PROTO])
    expect(Object.getPrototypeOf(parsed.hfParts)).toBe(Object.prototype)
    expect(Object.values(parsed.hfParts ?? {})[0]?.text).toBe('running head')
    expect(Object.keys(JSON.parse(JSON.stringify(parsed.hfParts)) as object)).toEqual([PROTO])
  })

  it('a chart part at the package path __proto__ is kept for editing and saved back', async () => {
    const source = await buildDocx({
      bodyXml: CHART_PARAGRAPH_XML,
      extraRels: `<Relationship Id="rId30" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="/${PROTO}"/>`,
      extraParts: [
        {
          path: PROTO,
          xml: CHART_PART_XML,
          contentType: 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml',
        },
      ],
    })
    const parsed = await parseDocx(source)
    expectPlainRecord(parsed.extras.chartParts, [[PROTO, CHART_PART_XML]])

    const edited = CHART_PART_XML.replace('<c:v>120</c:v>', '<c:v>200</c:v>')
    const saved = await saveDocx(
      parsed,
      parsed.blocks
        .filter((b) => !b.hidden)
        .map((b) => ({ kind: 'original' as const, docxIndex: b.docxIndex! })),
      { partXml: Object.fromEntries([[PROTO, edited]]) },
    )
    expect(await (await JSZip.loadAsync(saved)).file(PROTO)?.async('string')).toBe(edited)
  })
})
