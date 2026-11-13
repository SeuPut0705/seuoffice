import JSZip from 'jszip'
import {
  REDACTION_PART_PATH,
  applyRedactionNameMirror,
  serializeRedactionPart,
  type SheetRedactionState,
} from '../../src/gateway/xlsx-redaction'

/**
 * A workbook holding values a person marked "hidden from AI", for the readers
 * that must withhold them (the file readers, the sheet editor's loader) and
 * the saves that must keep the mark. Its XML parts can be rewritten by
 * `mutatedHiddenBook`: the same document spelled another valid way.
 */

export const LABEL = 'client phone'
export const SECRET = '13800138000'
export const PLACEHOLDER = `{{${LABEL}}}`
/** what the cached result of `=B2*2` is, as the last calculation left it */
export const DERIVED_NUMBER = '27600276000'
/** what the cached result of `=B2&"x"` is */
export const DERIVED_TEXT = `${SECRET}x`
/** every word that must never reach a reader that withholds the marked cells */
export const WITHHELD_WORDS = [SECRET, DERIVED_NUMBER, DERIVED_TEXT] as const

const SHEET_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const PKG_RELS_NS = 'http://schemas.openxmlformats.org/package/2006/relationships'
const TYPES_NS = 'http://schemas.openxmlformats.org/package/2006/content-types'
const DRAWING_NS = 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing'
const CHART_NS = 'http://schemas.openxmlformats.org/drawingml/2006/chart'
const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'
export const REDACTION_REL_TYPE =
  'https://schemas.genspark.ai/genoffice/2026/relationships/redactions'

/** B2:B3 of 'Data', zero-based */
export const HIDDEN_MARKS: readonly SheetRedactionState[] = [
  {
    sheetName: 'Data',
    marks: [{ startRow: 1, endRow: 2, startColumn: 1, endColumn: 1, label: LABEL }],
  },
]

/** where the record is written: the package part, the hidden defined names (what Excel leaves), or both */
export type RecordKind = 'part' | 'mirror' | 'both'
export const RECORD_KINDS: readonly RecordKind[] = ['part', 'mirror', 'both']
/** how B2 holds its text */
export type StringKind = 'shared' | 'inline'
export const STRING_KINDS: readonly StringKind[] = ['shared', 'inline']

export interface HiddenBookOptions {
  readonly record: RecordKind
  readonly strings?: StringKind
  /** the sheet the PivotTable reads: 'Data' (holding the phone), or 'Report' for a workbook whose Data rows can move */
  readonly pivotOver?: 'Data' | 'Report'
}

const inline = (ref: string, text: string) =>
  `<c r="${ref}" t="inlineStr"><is><t>${text}</t></is></c>`

/** the label cell the 'fake markup in CDATA' mutation fills with something that only looks like markup */
export const LABEL_CELL_TEXT = 'Name'

/**
 * Data: the hidden phone at B2 (B3 beside it), a formula over it, a text
 * formula over it, a defined name for it and a formula over that, a note on
 * the hidden B3, a list validation over B2:B3, and a chart caching its text.
 * Report: a PivotTable whose source holds B2, its output at A3:B4.
 */
export async function hiddenBook(options: HiddenBookOptions): Promise<Uint8Array> {
  const strings = options.strings ?? 'shared'
  const withPart = options.record !== 'mirror'
  const withMirror = options.record !== 'part'
  const sheets = ['Data', 'Report']

  const zip = new JSZip()
  let workbookXml =
    `${XML_DECL}<workbook xmlns="${SHEET_NS}" xmlns:r="${REL_NS}"><sheets>` +
    sheets
      .map((name, i) => `<sheet name="${name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
      .join('') +
    '</sheets><definedNames>' +
    '<definedName name="phone">Data!$B$2</definedName>' +
    '<definedName name="greeting">"hello"</definedName>' +
    '</definedNames><pivotCaches><pivotCache cacheId="1" r:id="rId5"/></pivotCaches></workbook>'
  if (withMirror) workbookXml = applyRedactionNameMirror(workbookXml, HIDDEN_MARKS, sheets)
  zip.file('xl/workbook.xml', workbookXml)

  zip.file(
    'xl/_rels/workbook.xml.rels',
    `${XML_DECL}<Relationships xmlns="${PKG_RELS_NS}">` +
      sheets
        .map(
          (_, i) =>
            `<Relationship Id="rId${i + 1}" Type="${REL_NS}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
        )
        .join('') +
      `<Relationship Id="rId3" Type="${REL_NS}/sharedStrings" Target="sharedStrings.xml"/>` +
      `<Relationship Id="rId5" Type="${REL_NS}/pivotCacheDefinition" Target="pivotCache/pivotCacheDefinition1.xml"/>` +
      (withPart
        ? `<Relationship Id="rId6" Type="${REDACTION_REL_TYPE}" Target="gxRedactions.json"/>`
        : '') +
      '</Relationships>',
  )
  zip.file(
    '_rels/.rels',
    `${XML_DECL}<Relationships xmlns="${PKG_RELS_NS}">` +
      `<Relationship Id="rId1" Type="${REL_NS}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
  )
  const override = (part: string, type: string) =>
    `<Override PartName="${part}" ContentType="application/vnd.openxmlformats-officedocument.${type}+xml"/>`
  zip.file(
    '[Content_Types].xml',
    `${XML_DECL}<Types xmlns="${TYPES_NS}">` +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      override('/xl/workbook.xml', 'spreadsheetml.sheet.main') +
      override('/xl/worksheets/sheet1.xml', 'spreadsheetml.worksheet') +
      override('/xl/worksheets/sheet2.xml', 'spreadsheetml.worksheet') +
      override('/xl/sharedStrings.xml', 'spreadsheetml.sharedStrings') +
      override('/xl/comments1.xml', 'spreadsheetml.comments') +
      override('/xl/pivotTables/pivotTable1.xml', 'spreadsheetml.pivotTable') +
      override('/xl/pivotCache/pivotCacheDefinition1.xml', 'spreadsheetml.pivotCacheDefinition') +
      override('/xl/drawings/drawing1.xml', 'drawing') +
      override('/xl/charts/chart1.xml', 'drawingml.chart') +
      (withPart
        ? '<Override PartName="/xl/gxRedactions.json" ContentType="application/json"/>'
        : '') +
      '</Types>',
  )

  zip.file(
    'xl/sharedStrings.xml',
    `${XML_DECL}<sst xmlns="${SHEET_NS}" count="1" uniqueCount="1">` +
      (strings === 'shared' ? `<si><t>${SECRET}</t></si>` : '<si><t>unused</t></si>') +
      '</sst>',
  )
  const phone = strings === 'shared' ? `<c r="B2" t="s"><v>0</v></c>` : inline('B2', SECRET)
  zip.file(
    'xl/worksheets/sheet1.xml',
    `${XML_DECL}<worksheet xmlns="${SHEET_NS}" xmlns:r="${REL_NS}"><sheetData>` +
      `<row r="1">${inline('A1', LABEL_CELL_TEXT)}${inline('B1', 'Phone')}</row>` +
      `<row r="2">${inline('A2', 'Kim')}${phone}` +
      `<c r="C2"><f>B2*2</f><v>${DERIVED_NUMBER}</v></c>` +
      `<c r="D2" t="str"><f>B2&amp;"x"</f><v>${DERIVED_TEXT}</v></c>` +
      `<c r="E2"><f>phone</f><v>${SECRET}</v></c></row>` +
      `<row r="3">${inline('A3', 'Lee')}${inline('B3', 'second')}</row>` +
      '<row r="5"><c r="C5"><f>1+1</f><v>2</v></c></row>' +
      '</sheetData>' +
      '<dataValidations count="1"><dataValidation type="list" sqref="G2">' +
      '<formula1>$B$2:$B$3</formula1></dataValidation></dataValidations>' +
      '<drawing r:id="rId2"/></worksheet>',
  )
  zip.file(
    'xl/worksheets/_rels/sheet1.xml.rels',
    `${XML_DECL}<Relationships xmlns="${PKG_RELS_NS}">` +
      `<Relationship Id="rId1" Type="${REL_NS}/comments" Target="../comments1.xml"/>` +
      `<Relationship Id="rId2" Type="${REL_NS}/drawing" Target="../drawings/drawing1.xml"/>` +
      '</Relationships>',
  )
  zip.file(
    'xl/comments1.xml',
    `${XML_DECL}<comments xmlns="${SHEET_NS}"><authors><author>K</author></authors><commentList>` +
      `<comment ref="B3" authorId="0"><text><r><t>call ${SECRET} back</t></r></text></comment>` +
      '</commentList></comments>',
  )
  zip.file(
    'xl/drawings/drawing1.xml',
    `${XML_DECL}<xdr:wsDr xmlns:xdr="${DRAWING_NS}" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${REL_NS}">` +
      '<xdr:twoCellAnchor><xdr:from><xdr:col>8</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>1</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>' +
      '<xdr:to><xdr:col>12</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>8</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>' +
      '<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="2" name="Chart 1"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr>' +
      '<xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm>' +
      `<a:graphic><a:graphicData uri="${CHART_NS}"><c:chart xmlns:c="${CHART_NS}" r:id="rId1"/></a:graphicData></a:graphic>` +
      '</xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor></xdr:wsDr>',
  )
  zip.file(
    'xl/drawings/_rels/drawing1.xml.rels',
    `${XML_DECL}<Relationships xmlns="${PKG_RELS_NS}">` +
      `<Relationship Id="rId1" Type="${REL_NS}/chart" Target="../charts/chart1.xml"/></Relationships>`,
  )
  zip.file(
    'xl/charts/chart1.xml',
    `${XML_DECL}<c:chartSpace xmlns:c="${CHART_NS}"><c:chart><c:plotArea><c:barChart><c:ser>` +
      `<c:tx><c:strRef><c:f>Data!$B$1</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>${SECRET}</c:v></c:pt></c:strCache></c:strRef></c:tx>` +
      `<c:val><c:numRef><c:f>Data!$B$2:$B$3</c:f><c:numCache><c:ptCount val="1"/><c:pt idx="0"><c:v>${SECRET}</c:v></c:pt></c:numCache></c:numRef></c:val>` +
      '</c:ser></c:barChart></c:plotArea></c:chart></c:chartSpace>',
  )

  zip.file(
    'xl/worksheets/sheet2.xml',
    `${XML_DECL}<worksheet xmlns="${SHEET_NS}"><sheetData>` +
      `<row r="3">${inline('A3', 'Phone')}${inline('B3', 'Total')}${inline('D3', 'beside')}</row>` +
      `<row r="4">${inline('A4', SECRET)}<c r="B4"><v>${DERIVED_NUMBER}</v></c></row>` +
      '</sheetData></worksheet>',
  )
  zip.file(
    'xl/worksheets/_rels/sheet2.xml.rels',
    `${XML_DECL}<Relationships xmlns="${PKG_RELS_NS}">` +
      `<Relationship Id="rId1" Type="${REL_NS}/pivotTable" Target="../pivotTables/pivotTable1.xml"/></Relationships>`,
  )
  zip.file(
    'xl/pivotTables/pivotTable1.xml',
    `${XML_DECL}<pivotTableDefinition xmlns="${SHEET_NS}" name="PivotTable1" cacheId="1">` +
      '<location ref="A3:B4" firstHeaderRow="1" firstDataRow="1" firstDataCol="1"/>' +
      '<pivotFields count="1"><pivotField axis="axisRow" showAll="0"><items count="2"><item x="0"/><item t="default"/></items></pivotField></pivotFields>' +
      '</pivotTableDefinition>',
  )
  zip.file(
    'xl/pivotTables/_rels/pivotTable1.xml.rels',
    `${XML_DECL}<Relationships xmlns="${PKG_RELS_NS}">` +
      `<Relationship Id="rId1" Type="${REL_NS}/pivotCacheDefinition" Target="../pivotCache/pivotCacheDefinition1.xml"/></Relationships>`,
  )
  zip.file(
    'xl/pivotCache/pivotCacheDefinition1.xml',
    `${XML_DECL}<pivotCacheDefinition xmlns="${SHEET_NS}" xmlns:r="${REL_NS}">` +
      (options.pivotOver === 'Report'
        ? '<cacheSource type="worksheet"><worksheetSource ref="A3:B4" sheet="Report"/></cacheSource>'
        : '<cacheSource type="worksheet"><worksheetSource ref="A1:B3" sheet="Data"/></cacheSource>') +
      `<cacheFields count="1"><cacheField name="Phone"><sharedItems count="1"><s v="${SECRET}"/></sharedItems></cacheField></cacheFields>` +
      '</pivotCacheDefinition>',
  )

  if (withPart) zip.file(REDACTION_PART_PATH, serializeRedactionPart(HIDDEN_MARKS))
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
}

/**
 * The same tags written another valid way, as another producer may write
 * them. Each changes the XML text a pattern reads and leaves the document the
 * XML parser reads as it was (but `namespace prefix`, which renames the
 * default namespace's prefix, so a reader that names `<c>` reads nothing at
 * all).
 */

const FAKE_ENTRIES =
  '</sheetData></worksheet><worksheet><sheetData><row r="2"><c r="B2"><v>0</v></c></row>' +
  '<c r="C2"><f>1</f><v>1</v></c></definedNames>' +
  '<definedName name="_gxRedaction_9" hidden="1">"{""v"":1,""sheet"":1,""from"":[0,0],""to"":[0,0],""label"":""fake""}"</definedName>' +
  `<Relationship Id="rId9" Type="${REDACTION_REL_TYPE}" Target="fake.json"/>` +
  '<Override PartName="/xl/gxRedactions.json" ContentType="a"/><f>1</f>'
/** the label cell's text after 'fake markup in CDATA' */
export const FAKE_LABEL_TEXT = FAKE_ENTRIES

const inTags = (xml: string, edit: (tag: string) => string): string =>
  xml.replace(/<[^>!?]+>/g, edit)

const ELEMENT_NAMES =
  'c|f|row|definedName|sheet|Relationship|Override|sheetData|location|worksheetSource'

function decodeText(text: string): string {
  return text
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&')
}

export const TAG_MUTATIONS = {
  'single quotes': (xml: string) => inTags(xml, (tag) => tag.replace(/="([^"]*)"/g, "='$1'")),
  'spaces around =': (xml: string) =>
    inTags(xml, (tag) => tag.replace(/(\s[\w:.-]+)=(["'])/g, '$1 = $2')),
  'newlines between attributes': (xml: string) =>
    inTags(xml, (tag) => tag.replace(/(["'])\s+([\w:.-]+=)/g, '$1\r\n\t$2')),
  'reversed attribute order': (xml: string) =>
    inTags(xml, (tag) => {
      const head = /^<[\w:.-]+/.exec(tag)?.[0]
      if (head === undefined) return tag
      const attributes = [...tag.matchAll(/\s[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*')/g)].map(
        (match) => match[0],
      )
      return `${head}${attributes.reverse().join('')}${tag.endsWith('/>') ? '/>' : '>'}`
    }),
  '> and /> inside values': (xml: string) =>
    xml.replace(
      new RegExp(`<((?:[\\w.-]+:)?(?:${ELEMENT_NAMES}))(?=[\\s/>])`, 'g'),
      '<$1 data-x="a/>b>c"',
    ),
  // The comments hold the closing tags and records the readers look for; they
  // go in after the plain replacements so they are not rewritten themselves.
  comments: (xml: string) =>
    xml
      .replace(/<\/f>/g, '<!-- </f> --></f>')
      .replace(/<\/(t|v)>/g, '<!-- </$1> --></$1>')
      .replace(/<\/definedName>/g, '</definedName><!-- </definedName> -->')
      .replace(/(<c(?=\s)[^>/]*>)/g, '$1<!-- </c></row></sheetData> <c r="B2"><v>0</v></c> -->')
      .replace(
        /<definedNames>/,
        '<definedNames><!-- <definedName name="_gxRedaction_9" hidden="1">"{""v"":1,""sheet"":1,""from"":[0,0],""to"":[0,0],""label"":""fake""}"</definedName> -->',
      )
      .replace(
        /<Relationships[^>]*>/g,
        (tag) => `${tag}<!-- <Relationship Type="${REDACTION_REL_TYPE}" Target="x"/> -->`,
      ),
  // a plain text's words inside CDATA dressed as the markup the readers look
  // for: a pattern that takes it for markup ends the grid early, finds
  // another record or declares another part
  'fake markup in CDATA': (xml: string) =>
    xml
      .replaceAll(`<t>${LABEL_CELL_TEXT}</t>`, `<t><![CDATA[${FAKE_ENTRIES}]]></t>`)
      .replace(
        '>"hello"</definedName>',
        () => `><![CDATA["${FAKE_ENTRIES.replaceAll('"', '""')}"]]></definedName>`,
      ),
  'space before > in end tags': (xml: string) => xml.replace(/<\/([\w:.-]+)>/g, '</$1 >'),
  'space before > in start tags': (xml: string) =>
    inTags(xml, (tag) =>
      /^<[\w:.-]/.test(tag) ? tag.replace(/(\/?)>$/, (_all, slash: string) => ` ${slash}>`) : tag,
    ),
  CDATA: (xml: string) =>
    xml.replace(
      /<(f|t|v|definedName|formula1)((?:\s[^>]*)?)>([^<]+)<\/\1>/g,
      (_all, name: string, attributes: string, text: string) =>
        `<${name}${attributes}><![CDATA[${decodeText(text)}]]></${name}>`,
    ),
  'namespace prefix': (xml: string) =>
    /xmlns="(?:http:\/\/schemas\.openxmlformats\.org\/(?:spreadsheetml\/2006\/main|package\/2006\/(?:relationships|content-types)))"/.test(
      xml,
    )
      ? xml
          .replace(/(<[\w:.-]+[^>]*?)\sxmlns="/, '$1 xmlns:x="')
          .replace(/<(\/?)([A-Za-z_][\w.-]*)(?=[\s/>])/g, '<$1x:$2')
      : xml,
} satisfies Record<string, (xml: string) => string>

export type TagMutation = keyof typeof TAG_MUTATIONS | 'all' | 'none'
export const TAG_MUTATION_NAMES = [...Object.keys(TAG_MUTATIONS), 'all'] as Exclude<
  TagMutation,
  'none'
>[]

function mutate(xml: string, mutation: TagMutation): string {
  if (mutation === 'none') return xml
  if (mutation !== 'all') return TAG_MUTATIONS[mutation](xml)
  const order: Array<keyof typeof TAG_MUTATIONS> = [
    'single quotes',
    'spaces around =',
    'CDATA',
    'comments',
    '> and /> inside values',
    'space before > in end tags',
  ]
  return order.reduce((out, name) => TAG_MUTATIONS[name](out), xml)
}

/** `bytes` with every XML part's tags rewritten by `mutation` */
export async function mutatePackage(bytes: Uint8Array, mutation: TagMutation): Promise<Uint8Array> {
  if (mutation === 'none') return bytes
  const zip = await JSZip.loadAsync(bytes)
  for (const path of Object.keys(zip.files)) {
    if (!/\.(?:xml|rels)$/.test(path)) continue
    zip.file(path, mutate(await zip.file(path)!.async('string'), mutation))
  }
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
}

/** hiddenBook with every XML part's tags rewritten by `mutation` */
export async function mutatedHiddenBook(
  mutation: TagMutation,
  options: HiddenBookOptions,
): Promise<Uint8Array> {
  return mutatePackage(await hiddenBook(options), mutation)
}

/**
 * `bytes` with Data's sheet grown past `minChars` by plain rows far below the
 * cells under test (rows 1000 and on, in column A), so a reader that treats a
 * large part differently from a small one meets the same cells in a big part.
 */
export async function padSheet(bytes: Uint8Array, minChars: number): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(bytes)
  const path = 'xl/worksheets/sheet1.xml'
  const xml = await zip.file(path)!.async('string')
  const rows: string[] = []
  let size = xml.length
  for (let row = 1000; size < minChars; row += 1) {
    const text = `<row r="${row}"><c r="A${row}" t="inlineStr"><is><t>padding padding padding</t></is></c></row>`
    rows.push(text)
    size += text.length
  }
  zip.file(path, xml.replace(/<\/sheetData\s*>/, `${rows.join('')}</sheetData>`))
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
}
