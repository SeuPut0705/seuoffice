// Containers and parts the corpus does not hold: every limit and malformed
// package the loader has an answer for, built byte by byte, and OOXML parts
// written the Strict way.
import { COMMENT_PARTS, STORIES } from './withheld-inputs'
import { crc32, deflateRawSync } from 'node:zlib'

const encoder = new TextEncoder()
const bytesOf = (data: string | Uint8Array): Uint8Array =>
  typeof data === 'string' ? encoder.encode(data) : data

interface EntrySpec {
  name: string | Uint8Array
  data: string | Uint8Array
  /** 0 stores, 8 deflates; any other number is written as it is, over stored bytes. */
  method?: number
  /** General purpose bit flag; 0x0800 (names are UTF-8) when absent. */
  flags?: number
  /** The uncompressed size both headers declare, where it is not the true one. */
  declaredSize?: number
  /** The stored or deflated bytes, where they are not the true ones. */
  payload?: Uint8Array
  /** The name of the local header, where it differs from the central one. */
  localName?: string | Uint8Array
  /** Extra field of the central header. */
  extra?: Uint8Array
  externalAttributes?: number
  versionMadeBy?: number
  /** Leaves the entry out of the count the end record declares. */
  uncounted?: boolean
  /** The compressed size both headers declare, where it is not the length of the payload. */
  compressedSize?: number
  /** The offset the central header gives for the local one, where it is not the true one. */
  localOffset?: number
}

interface ZipSpec {
  /** Bytes before the first local header; `adjusted` makes the offsets account for them. */
  prepend?: Uint8Array
  adjusted?: boolean
  /** Bytes between the central directory and the end record, or what makes them from the directory's offset and length. */
  gap?: Uint8Array | ((directoryOffset: number, directoryLength: number) => Uint8Array)
  comment?: Uint8Array
  /** Bytes after the end record and its comment. */
  trailer?: Uint8Array
  /** Added to the directory size the end record declares. */
  directorySizeDelta?: number
  /** Fields of the end record written as given. */
  count?: number
  /** The count on this disk alone; `count` sets both counts. */
  countOnDisk?: number
  diskNumber?: number
  directoryDisk?: number
  directorySize?: number
  directoryOffset?: number
}

function header(size: number, write: (view: DataView) => void): Uint8Array {
  const bytes = new Uint8Array(size)
  write(new DataView(bytes.buffer))
  return bytes
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0))
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

export function buildZip(entries: EntrySpec[], spec: ZipSpec = {}): Uint8Array {
  const prepend = spec.prepend ?? new Uint8Array(0)
  const shift = spec.adjusted ? prepend.length : 0
  const locals: Uint8Array[] = []
  const centrals: Uint8Array[] = []
  let offset = shift
  for (const entry of entries) {
    const name = bytesOf(entry.name)
    const localName = bytesOf(entry.localName ?? entry.name)
    const data = bytesOf(entry.data)
    const method = entry.method ?? 0
    const payload = entry.payload ?? (method === 8 ? deflateRawSync(data) : data)
    const flags = entry.flags ?? 0x0800
    const declared = entry.declaredSize ?? data.length
    const checksum = crc32(data)
    const extra = entry.extra ?? new Uint8Array(0)
    const sizes = (view: DataView, at: number): void => {
      view.setUint32(at, checksum, true)
      view.setUint32(at + 4, entry.compressedSize ?? payload.length, true)
      view.setUint32(at + 8, declared, true)
    }
    const local = header(30, (view) => {
      view.setUint32(0, 0x04034b50, true)
      view.setUint16(4, 20, true)
      view.setUint16(6, flags, true)
      view.setUint16(8, method, true)
      sizes(view, 14)
      view.setUint16(26, localName.length, true)
    })
    centrals.push(
      header(46, (view) => {
        view.setUint32(0, 0x02014b50, true)
        view.setUint16(4, entry.versionMadeBy ?? 20, true)
        view.setUint16(6, 20, true)
        view.setUint16(8, flags, true)
        view.setUint16(10, method, true)
        sizes(view, 16)
        view.setUint16(28, name.length, true)
        view.setUint16(30, extra.length, true)
        view.setUint32(38, entry.externalAttributes ?? 0, true)
        view.setUint32(42, entry.localOffset ?? offset, true)
      }),
      name,
      extra,
    )
    locals.push(local, localName, payload)
    offset += 30 + localName.length + payload.length
  }
  const directory = concat(centrals)
  const comment = spec.comment ?? new Uint8Array(0)
  const counted = spec.count ?? entries.filter((entry) => !entry.uncounted).length
  const end = header(22, (view) => {
    view.setUint32(0, 0x06054b50, true)
    view.setUint16(4, spec.diskNumber ?? 0, true)
    view.setUint16(6, spec.directoryDisk ?? 0, true)
    view.setUint16(8, spec.countOnDisk ?? counted, true)
    view.setUint16(10, counted, true)
    view.setUint32(
      12,
      spec.directorySize ?? directory.length + (spec.directorySizeDelta ?? 0),
      true,
    )
    view.setUint32(16, spec.directoryOffset ?? offset, true)
    view.setUint16(20, comment.length, true)
  })
  return concat([
    prepend,
    ...locals,
    directory,
    typeof spec.gap === 'function'
      ? spec.gap(offset, directory.length)
      : (spec.gap ?? new Uint8Array(0)),
    end,
    comment,
    spec.trailer ?? new Uint8Array(0),
  ])
}

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const PACKAGE_RELS = 'http://schemas.openxmlformats.org/package/2006/relationships'
const OFFICE_RELS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

const CONTENT_TYPES =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="RELS" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Default Extension="xml" ContentType="application/second"/>' +
  '<Default ContentType="application/no-extension"/><Default Extension="" ContentType="x/y"/>' +
  '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
  '<Override PartName="/word/document.xml" ContentType="application/again"/>' +
  '<Override PartName="" ContentType="x/y"/><Override PartName="/a"/>' +
  '</Types>'
const rels = (...relationships: string[]): string =>
  `<?xml version="1.0"?><Relationships xmlns="${PACKAGE_RELS}">${relationships.join('')}</Relationships>`
const ROOT_RELS = rels(
  `<Relationship Id="rId1" Type="${OFFICE_RELS}/officeDocument" Target="word/document.xml"/>`,
)
const DOCUMENT = `<?xml version="1.0"?><w:document xmlns:w="${W}"><w:body><w:p><w:r><w:t>text</w:t></w:r></w:p></w:body></w:document>`
const STYLES =
  `<?xml version="1.0"?><w:styles xmlns:w="${W}"><w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="21"/></w:rPr></w:rPrDefault></w:docDefaults>` +
  '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:style>' +
  '<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/></w:style>' +
  '</w:styles>'

const base = (): EntrySpec[] => [
  { name: '[Content_Types].xml', data: CONTENT_TYPES, method: 8 },
  { name: '_rels/.rels', data: ROOT_RELS, method: 8 },
  { name: 'word/document.xml', data: DOCUMENT, method: 8 },
  { name: 'word/styles.xml', data: STYLES, method: 8 },
]
const withEntry = (...extra: EntrySpec[]): EntrySpec[] => [...base(), ...extra]
const replaced = (name: string, change: Partial<EntrySpec>): EntrySpec[] =>
  base().map((entry) => (entry.name === name ? { ...entry, ...change } : entry))

/** A minimal sfnt face: a head and an hhea table, which is what the line metrics read. */
function sfnt(
  magic: string,
  unitsPerEm: number,
  ascent: number,
  descent: number,
  lineGap: number,
): Uint8Array {
  const tables: Array<[tag: string, offset: number, length: number]> = [
    ['head', 60, 54],
    ['hhea', 114, 36],
    ['name', 0x7fffffff, 10],
  ]
  return header(150, (view) => {
    latin1(magic).forEach((byte, index) => view.setUint8(index, byte))
    view.setUint16(4, tables.length)
    tables.forEach(([tag, offset, length], index) => {
      latin1(tag).forEach((byte, at) => view.setUint8(12 + 16 * index + at, byte))
      view.setUint32(12 + 16 * index + 8, offset)
      view.setUint32(12 + 16 * index + 12, length)
    })
    view.setUint16(60 + 18, unitsPerEm)
    view.setInt16(114 + 4, ascent)
    view.setInt16(114 + 6, descent)
    view.setInt16(114 + 8, lineGap)
  })
}

/** ECMA-376 17.8.1: the first 32 bytes XORed with the GUID's bytes in reverse order. */
function obfuscated(font: Uint8Array, guid: string): Uint8Array {
  const key = Buffer.from(guid.replace(/[^0-9a-f]/gi, ''), 'hex')
  return font.map((byte, index) => (index < 32 ? byte ^ key[15 - (index % 16)]! : byte))
}

const FONT_KEY = '{1A2B3C4D-5E6F-7081-92A3-B4C5D6E7F809}'

/**
 * Packages holding what the readers read and the tracked documents lack:
 * embedded fonts, comments with pictures and replies, protection, picture
 * bullets, numbering style links, two styles of one heading level.
 */
function richPackages(withHidden = false): Record<string, EntrySpec[]> {
  const settings = (inner: string): string =>
    `<?xml version="1.0"?><w:settings xmlns:w="${W}">${inner}</w:settings>`
  const lvl = (ilvl: string, inner: string): string => `<w:lvl w:ilvl="${ilvl}">${inner}</w:lvl>`
  const fontTable =
    `<w:fonts xmlns:w="${W}" xmlns:r="${OFFICE_RELS}">` +
    `<w:font w:name="Masked"><w:altName w:val="Alt"/><w:panose1 w:val="020B0604020202020204"/><w:charset w:val="00"/><w:family w:val="swiss"/><w:pitch w:val="variable"/><w:sig w:usb0="E0002AFF" w:csb0="000001FF"/>` +
    `<w:embedRegular r:id="rId1" w:fontKey="${FONT_KEY}"/><w:embedBold r:id="rId2"/><w:embedItalic r:id="rId3" w:fontKey="${FONT_KEY}"/><w:embedBoldItalic r:id="rId4" w:fontKey="${FONT_KEY}"/></w:font>` +
    `<w:font w:name="Elsewhere"><w:embedRegular r:id="rId5"/><w:embedBold r:id="rId6"/><w:embedItalic r:id="rId7" w:fontKey="{00000000-0000-0000-0000-000000000000}"/><w:embedBoldItalic r:id="rId8" w:fontKey="short"/></w:font>` +
    '<w:font w:name="No slots"><w:embedRegular/></w:font><w:font><w:embedRegular r:id="rId1"/></w:font></w:fonts>'
  const fontRels = rels(
    '<Relationship Id="rId1" Type="t" Target="fonts/font1.odttf"/>',
    '<Relationship Id="rId2" Type="t" Target="/word/fonts/plain.ttf"/>',
    '<Relationship Id="rId3" Type="t" Target="fonts/not-a-font.odttf"/>',
    '<Relationship Id="rId4" Type="t" Target="fonts/true.odttf"/>',
    '<Relationship Id="rId5" Type="t" Target="http://example.com/font.ttf" TargetMode="External"/>',
    '<Relationship Id="rId6" Type="t" Target="fonts/missing.odttf"/>',
    '<Relationship Id="rId7" Type="t" Target="fonts/zero-key.odttf"/>',
    '<Relationship Id="rId8" Type="t" Target="../../outside.ttf"/>',
  )
  const comment = (id: string, paraId: string, inner: string): string =>
    `<w:comment w:id="${id}" w:author="A ${id}" w:initials="a" w:date="2026-01-0${id}T00:00:00Z"><w:p w14:paraId="skipped"><w:r><w:t>first</w:t></w:r></w:p>` +
    `<w:p w14:paraId="${paraId}"><w:r><w:t>text ${id}</w:t><w:instrText>FIELD</w:instrText><w:delText>gone</w:delText></w:r>${inner}</w:p></w:comment>`
  const picture = (relId: string, cx: string, cy: string): string =>
    `<w:r><w:drawing><wp:inline><wp:extent cx="${cx}" cy="${cy}"/><a:blip r:embed="${relId}"/><a:blip r:embed="later"/></wp:inline></w:drawing></w:r>`
  const comments =
    `<w:comments xmlns:w="${W}">` +
    comment('1', 'AAAA0001', picture('rId1', '952500', '476250')) +
    comment('2', 'AAAA0002', picture('rId2', '0', 'abc')) +
    comment('3', 'AAAA0002', picture('rId3', '9525', '4762')) +
    comment('4', 'AAAA0004', picture('rId4', '1', '1')) +
    comment('5', '', picture('rId5', '1', '1')) +
    '<w:comment w:author="no id"/><w:comment w:id="6"/></w:comments>'
  const commentRels = rels(
    '<Relationship Id="rId1" Type="t" Target="media/c1.PNG"/>',
    '<Relationship Id="rId2" Type="t" Target="/word/media/c2.gif"/>',
    '<Relationship Id="rId3" Type="t" Target="http://example.com/c.png" TargetMode="External"/>',
    '<Relationship Id="rId5" Type="t" Target="media/missing.jpg"/>',
  )
  const commentsExtended =
    '<w15:commentsEx><w15:commentEx w15:paraId="AAAA0002" w15:paraIdParent="AAAA0001" w15:done="1"/>' +
    '<w15:commentEx w15:paraId="AAAA0004" w15:paraIdParent="AAAA0002" w15:done="0"/>' +
    '<w15:commentEx w15:paraId="AAAA0001" w15:paraIdParent="AAAA9999" w15:done="true"/>' +
    '<w15:commentEx w15:paraId="unknown" w15:done="1"/><w15:commentEx w15:done="1"/></w15:commentsEx>'
  const numbering =
    `<w:numbering xmlns:w="${W}" xmlns:r="${OFFICE_RELS}" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006">` +
    '<w:numPicBullet w:numPicBulletId="0"><w:pict><v:shape><v:imagedata r:id="rId1"/></v:shape></w:pict></w:numPicBullet>' +
    '<w:numPicBullet w:numPicBulletId="1"><w:drawing><a:graphic><a:blip r:embed=""/></a:graphic><a:blip r:embed="rId2"/></w:drawing></w:numPicBullet>' +
    '<w:numPicBullet w:numPicBulletId="2"><w:pict><v:group><v:imagedata/></v:group></w:pict><w:pict><v:imagedata r:id="rId3"/></w:pict></w:numPicBullet>' +
    '<w:numPicBullet w:numPicBulletId="0"><a:blip r:embed="rId9"/></w:numPicBullet><w:numPicBullet w:numPicBulletId="-0"><a:blip r:embed="rId8"/></w:numPicBullet>' +
    '<w:numPicBullet w:numPicBulletId="x"><a:blip r:embed="rId7"/></w:numPicBullet><w:numPicBullet w:numPicBulletId="1.9"/>' +
    '<w:abstractNum w:abstractNumId="0">' +
    lvl(
      '0',
      '<w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="&#61623;"/><w:lvlPicBulletId w:val="1"/><w:pPr><w:ind w:hanging="0" w:firstLine="200" w:end="-5"/><w:bidi/></w:pPr><w:rPr><w:sz w:val="0"/><w:color w:val="auto"/><w:b w:val="off"/><w:i/><w:rFonts w:hAnsi="H" w:eastAsia="E"/></w:rPr>',
    ) +
    lvl(
      '1',
      '<w:numFmt w:val="decimal"/><w:lvlText/><w:suff w:val="space"/><w:isLgl w:val="false"/><w:lvlJc w:val="center"/><w:pStyle w:val="Heading1"/><w:lvlRestart w:val="0"/><w:pPr><w:tabs><w:tab w:pos="720"/><w:tab w:pos="x"/></w:tabs><w:ind w:start="360" w:hanging="-5" w:firstLine="-10"/><w:bidi w:val="0"/></w:pPr><w:rPr><w:sz w:val="21.5"/><w:color w:val="aBcDeF"/><w:b/><w:rFonts w:ascii=""/></w:rPr>',
    ) +
    lvl(
      '2',
      '<mc:AlternateContent><mc:Choice Requires="w14"><w:numFmt w:val="custom" w:format="\u03b1, \u03b2, \u03b3, ..."/></mc:Choice><mc:Fallback><w:numFmt w:val="lowerLetter"/></mc:Fallback></mc:AlternateContent><w:suff w:val="other"/><w:isLgl/>',
    ) +
    lvl(
      '3',
      '<mc:AlternateContent><mc:Choice><w:numFmt w:val="custom" w:format="only one"/></mc:Choice><mc:Fallback><w:numFmt w:val="upperRoman"/></mc:Fallback></mc:AlternateContent>',
    ) +
    lvl(
      '4',
      '<mc:AlternateContent><mc:Choice><w:numFmt w:val="chicago"/></mc:Choice></mc:AlternateContent>',
    ) +
    lvl('5', '<mc:AlternateContent><mc:Fallback/></mc:AlternateContent><w:start w:val="abc"/>') +
    lvl('6e1', '<w:start w:val="7"/>') +
    lvl(' 8x', '<w:start w:val="8"/>') +
    lvl('', '') +
    '</w:abstractNum>' +
    '<w:abstractNum w:abstractNumId="1"><w:numStyleLink w:val="ListStyle"/>' +
    lvl('0', '<w:start w:val="9"/>') +
    // keys that are no array index keep the order they were set in: the levels of the
    // linked abstractNum first; and 10 comes after 2, which text order would not give
    lvl('-3', '<w:start w:val="1"/>') +
    lvl('-1', '') +
    lvl('10', '') +
    '</w:abstractNum>' +
    '<w:abstractNum w:abstractNumId="2"><w:styleLink w:val="ListStyle"/><w:numStyleLink w:val="Other"/>' +
    lvl('0', '<w:numFmt w:val="bullet"/>') +
    lvl('1', '<w:numFmt w:val="upperLetter"/>') +
    '</w:abstractNum>' +
    '<w:abstractNum w:abstractNumId="3"><w:styleLink w:val="Other"/><w:numStyleLink w:val="ListStyle"/>' +
    lvl('2', '<w:numFmt w:val="ordinal"/>') +
    lvl('-2', '') +
    lvl('-3', '') +
    '</w:abstractNum>' +
    '<w:abstractNum><w:lvl w:ilvl="0"/></w:abstractNum>' +
    '<w:abstractNum w:abstractNumId="7"><w:lvl w:ilvl="0"/></w:abstractNum><w:abstractNum w:abstractNumId="7"/>' +
    '<w:abstractNum w:abstractNumId="8"><w:lvl w:ilvl="-0"><w:start w:val="3"/></w:lvl><w:lvl w:ilvl="0"/></w:abstractNum>' +
    '<w:num w:numId="1"><w:abstractNumId w:val="1"/></w:num>' +
    '<w:num w:numId="2"><w:abstractNumId w:val="2"/><w:lvlOverride w:ilvl="1"><w:startOverride w:val="4"/></w:lvlOverride><w:lvlOverride w:ilvl="0"><w:startOverride w:val="x"/><w:lvl w:ilvl="5"><w:numFmt w:val="decimalZero"/></w:lvl></w:lvlOverride><w:lvlOverride w:ilvl="x"><w:startOverride w:val="1"/></w:lvlOverride></w:num>' +
    '<w:num w:numId="3"><w:abstractNumId w:val="3"/></w:num><w:num w:numId="1"><w:abstractNumId w:val="404"/></w:num>' +
    // numId 1 is taken over by the entry above: this one shows the levels abstractNum 1
    // gets through its numStyleLink
    '<w:num w:numId="8"><w:abstractNumId w:val="8"/></w:num><w:num w:numId="9"><w:abstractNumId w:val="1"/></w:num>' +
    '<w:num w:numId="5"/><w:num><w:abstractNumId w:val="0"/></w:num><w:num w:numId="0"><w:abstractNumId w:val="0"/></w:num></w:numbering>'
  const theme = (scheme: string): string =>
    `<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:themeElements>${scheme}` +
    '<a:fontScheme name="F"><a:majorFont><a:latin typeface="Major Latin"/><a:ea typeface=""/><a:cs typeface="Major Cs"/><a:font script="Hang" typeface="Malgun Gothic"/><a:font script="__proto__" typeface="P"/><a:font script="constructor" typeface="C"/><a:font script="Jpan" typeface=""/></a:majorFont>' +
    '<a:minorFont><a:latin typeface=""/><a:ea typeface="Minor Ea"/><a:cs typeface=""/></a:minorFont></a:fontScheme></a:themeElements></a:theme>'
  const styles = (inner: string): string =>
    `<?xml version="1.0"?><w:styles xmlns:w="${W}">${inner}</w:styles>`
  const heading = (id: string, level: string, extra = ''): string =>
    `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${id}"/><w:pPr><w:outlineLvl w:val="${level}"/></w:pPr>${extra}</w:style>`
  const common: EntrySpec[] = [
    { name: '[Content_Types].xml', data: CONTENT_TYPES, method: 8 },
    { name: '_rels/.rels', data: ROOT_RELS, method: 8 },
    { name: 'word/document.xml', data: DOCUMENT, method: 8 },
  ]
  return {
    'a package with fonts, comments, protection, picture bullets and style links': [
      ...common,
      {
        name: 'word/styles.xml',
        data: styles(
          '<w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="21"/><w:lang w:eastAsia="ko-KR"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:line="0" w:after="0"/></w:pPr></w:pPrDefault></w:docDefaults>' +
            heading('First1', '0') +
            heading('Second1', '0') +
            heading('Third2', '1') +
            heading('Body', '9') +
            heading('Bad', 'x') +
            '<w:style w:type="paragraph" w:styleId="listparagraph"><w:name w:val="lower"/></w:style><w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/></w:style>',
        ),
      },
      {
        name: 'word/theme/theme1.xml',
        data: theme(
          '<a:clrScheme name="Lower &amp; case"><a:dk1><a:sysClr val="windowText" lastClr="0a0b0c"/></a:dk1><a:lt1>\n <a:srgbClr val="fffffe"/></a:lt1><a:dk2><a:srgbClr val="44546"/></a:dk2><a:accent1><a:srgbClr val="aabbcc"/></a:accent1><a:accent2><a:schemeClr val="x"/></a:accent2><a:hlink><a:srgbClr val="0563c1"/></a:hlink><a:folHlink><a:sysClr lastClr="954f72" val="x"/></a:folHlink></a:clrScheme>',
        ),
      },
      {
        name: 'word/settings.xml',
        data: settings(
          `<w:themeFontLang w:val="en-US" w:eastAsia="ja-JP" w:bidi="ar-SA"/><w:documentProtection w:edit='forms' w:enforcement="on" w:cryptAlgorithmSid="14" w:cryptSpinCount="100000" w:hash="aGFzaA==" w:salt='c2FsdA=='/>` +
            '<w:writeProtection w:recommended="on" w:cryptSpinCount="50000" w:hash="d3A="/><w:removePersonalInformation w:val="FALSE"/>',
        ),
      },
      { name: 'word/numbering.xml', data: numbering, method: 8 },
      { name: 'word/fontTable.xml', data: fontTable },
      { name: 'word/_rels/fontTable.xml.rels', data: fontRels },
      {
        name: 'word/fonts/font1.odttf',
        data: obfuscated(sfnt('\x00\x01\x00\x00', 2048, 1900, -500, 67), FONT_KEY),
      },
      { name: 'word/fonts/plain.ttf', data: sfnt('OTTO', 1000, 800, -200, 0) },
      { name: 'word/fonts/not-a-font.odttf', data: 'this is not a font at all, only some text' },
      { name: 'word/fonts/true.odttf', data: obfuscated(sfnt('true', 0, 1, 1, 1), FONT_KEY) },
      { name: 'word/fonts/zero-key.odttf', data: sfnt('OTTO', 1024, -1, 1, -1).subarray(0, 20) },
      { name: 'word/comments.xml', data: comments, method: 8 },
      { name: 'word/_rels/comments.xml.rels', data: commentRels },
      { name: 'word/commentsExtended.xml', data: commentsExtended },
      { name: 'word/media/c1.PNG', data: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0, 0xff, 0xfe]) },
      { name: 'word/media/c2.gif', data: 'GIF89a' },
    ],
    // hidden from AI (built containers only, not mutation seeds: they would dilute the seeds that
    // reach the readers the tracked documents lack): the comments of the stories of hidden-stories.ts (every spelling of the mark,
    // every tag mutation), and ones whose tags a pattern reads differently from the parser
    ...(withHidden
      ? {
          // a relationship id with a character outside the BMP goes into a pattern without `u`: two units in JavaScript
          'a package with a comment picture whose relationship id is an emoji': [
            ...common,
            {
              name: 'word/comments.xml',
              data: `<w:comments xmlns:w="${W}">${comment('1', 'A', picture('\u{1F600}', '1', '1'))}${comment('2', 'B', picture('rId1', '9525', '9525'))}</w:comments>`,
            },
            { name: 'word/_rels/comments.xml.rels', data: commentRels },
          ] as EntrySpec[],
        }
      : {}),
    ...Object.fromEntries(
      (withHidden
        ? [...STORIES.map((story) => story.comments), ...COMMENT_PARTS.slice(STORIES.length)]
        : []
      ).map((data, index): [string, EntrySpec[]] => [
        `a package with comments hidden from AI (${index})`,
        [...common, { name: 'word/comments.xml', data }],
      ]),
    ),
    'a package with the other answers of the settings and theme readers': [
      ...common,
      {
        name: 'word/styles.xml',
        data: styles(
          // an East Asian language that is a name every object inherits, once lower case
          '<w:docDefaults><w:rPrDefault><w:rPr><w:lang w:eastAsia="Constructor"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:line="-240" w:lineRule="exact"/></w:pPr></w:pPrDefault></w:docDefaults>' +
            heading('Later2', '1') +
            heading('Earlier1', '0', '<w:basedOn w:val="Later2"/>') +
            heading('Again2', '1'),
        ),
      },
      {
        name: 'word/theme/theme1.xml',
        data: theme('<a:clrScheme name=""><a:dk1><a:srgbClr val="GGGGGG"/></a:dk1></a:clrScheme>'),
      },
      {
        name: 'word/settings.xml',
        data: settings(
          '<w:themeFontLang w:val="en-US" w:eastAsia=""/><w:documentProtection w:enforcement="1" w:edit="trackedChanges" w:cryptSpinCount="1e5" w:hash=""/>' +
            `<w:writeProtection w:recommended='true'/><w:removePersonalInformation></w:removePersonalInformation><w:linkStyles/>`,
        ),
      },
      {
        name: 'word/fontTable.xml',
        data: '<w:fonts><w:font w:name="A"><w:embedRegular r:id="rId1"/></w:font></w:fonts>',
      },
      { name: 'word/_rels/fontTable.xml.rels', data: '<Relationships><!--' },
      {
        // the relationship id goes into a pattern unescaped: this one makes the reader throw
        name: 'word/comments.xml',
        data: `<w:comments xmlns:w="${W}">${comment('1', 'A', picture('rId(', '1', '1'))}</w:comments>`,
      },
      { name: 'word/_rels/comments.xml.rels', data: commentRels },
    ],
    'a package whose styles take every spread, assign and delete of parseStyles': [
      ...common,
      {
        // key order by path: a pBdr spread per side, a tab merge that empties and a style
        // under it that sets tabs again (a deleted key comes back last), the docDefaults
        // indent and border fill-in, a linked style filling run keys around a key that holds
        // undefined, both sides of a table condition, the Times New Roman and w:lang paths
        name: 'word/styles.xml',
        data: styles(
          '<w:docDefaults><w:rPrDefault><w:rPr><w:szCs w:val="24"/><w:lang w:val="en-US" w:eastAsia="ko-KR"/><w:b/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:pBdr><w:left w:val="single" w:sz="4"/></w:pBdr><w:ind w:right="100" w:leftChars="30"/></w:pPr></w:pPrDefault></w:docDefaults>' +
            '<w:style w:type="paragraph" w:styleId="P1"><w:name w:val="P1"/><w:link w:val="C1"/><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="8"/></w:pBdr><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs><w:ind w:firstLineChars="100"/></w:pPr><w:rPr><w:color w:val="FF0000"/><w:sz w:val="28"/><w:b/></w:rPr></w:style>' +
            '<w:style w:type="paragraph" w:styleId="P2"><w:name w:val="P2"/><w:basedOn w:val="P1"/><w:pPr><w:pBdr><w:top w:val="nil"/></w:pBdr><w:tabs><w:tab w:val="clear" w:pos="720"/></w:tabs><w:ind w:left="200" w:leftChars="50"/></w:pPr><w:rPr><w:i/></w:rPr></w:style>' +
            '<w:style w:type="paragraph" w:styleId="P3"><w:name w:val="P3"/><w:basedOn w:val="P2"/><w:pPr><w:tabs><w:tab w:val="right" w:pos="900"/></w:tabs></w:pPr></w:style>' +
            '<w:style w:type="character" w:styleId="C1"><w:name w:val="C1"/><w:link w:val="P1"/><w:rPr><w:sz w:val="abc"/><w:i/></w:rPr></w:style>' +
            '<w:style w:type="table" w:styleId="T0"><w:name w:val="T0"/><w:rPr><w:color w:val="00FF00"/></w:rPr><w:pPr><w:spacing w:after="10"/></w:pPr><w:tblPr><w:tblCellMar><w:right w:w="50" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblStylePr w:type="firstRow"><w:rPr><w:b/></w:rPr><w:tcPr><w:tcBorders><w:top w:val="single"/></w:tcBorders><w:tcMar><w:left w:w="5" w:type="dxa"/></w:tcMar></w:tcPr></w:tblStylePr></w:style>' +
            '<w:style w:type="table" w:styleId="T1"><w:name w:val="T1"/><w:basedOn w:val="T0"/><w:rPr><w:i/><w:color w:val="0000FF"/></w:rPr><w:pPr><w:jc w:val="center"/><w:spacing w:before="20" w:after="30"/></w:pPr><w:tblPr><w:tblBorders><w:top w:val="single"/></w:tblBorders><w:tblCellMar><w:top w:w="7" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblStylePr w:type="lastRow"><w:tcPr><w:shd w:fill="AAAAAA"/></w:tcPr></w:tblStylePr><w:tblStylePr w:type="firstRow"><w:tcPr><w:shd w:fill="BBBBBB"/><w:tcBorders><w:bottom w:val="double"/></w:tcBorders><w:tcMar><w:top w:w="9" w:type="dxa"/></w:tcMar></w:tcPr></w:tblStylePr></w:style>',
        ),
      },
    ],
    // U+0131 (dotless i), U+017F (long s) and U+212A (Kelvin sign) are an ASCII
    // letter only under Unicode case folding, which /i without /u does not apply:
    // none of these is a heading, a list paragraph, a justified paragraph, a
    // pattern shading or a false
    'a package whose names hold letters that fold to ASCII only in Unicode': [
      ...common,
      {
        name: 'word/styles.xml',
        data: styles(
          '<w:style w:type="paragraph" w:styleId="A1"><w:name w:val="head\u0131ng 1"/></w:style>' +
            '<w:style w:type="paragraph" w:styleId="A2"><w:name w:val="HEAD\u0131NG 2"/></w:style>' +
            '<w:style w:type="paragraph" w:styleId="L\u0131stParagraph"><w:name w:val="B1"/><w:pPr><w:jc w:val="low\u212Aashida"/></w:pPr></w:style>' +
            '<w:style w:type="paragraph" w:styleId="Li\u017ftParagraph"><w:name w:val="B2"/><w:pPr><w:jc w:val="ka\u017fhida"/></w:pPr></w:style>' +
            '<w:style w:type="paragraph" w:styleId="C1"><w:name w:val="C1"/><w:pPr><w:jc w:val="tha\u0131Distribute"/><w:shd w:val="thinHorz\u017ftripe" w:color="FF0000" w:fill="FFFFFF"/></w:pPr></w:style>' +
            '<w:style w:type="paragraph" w:styleId="C2"><w:name w:val="C2"/><w:pPr><w:jc w:val="thaiDi\u017ftribute"/></w:pPr><w:rPr><w:shd w:val="diagCro\u017f\u017f" w:color="0000FF" w:fill="FFFF00"/></w:rPr></w:style>' +
            '<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="heading 3"/><w:pPr><w:jc w:val="lowKashida"/></w:pPr></w:style>',
        ),
      },
      {
        name: 'word/settings.xml',
        data: settings('<w:removePersonalInformation w:val="fal\u017fe"/>'),
      },
    ],
    // a prefix outside ASCII is none to the reader, whose prefix pattern is
    // ASCII: the setting is not found on either side
    'a package whose settings prefix is outside ASCII': [
      ...common,
      { name: 'word/styles.xml', data: STYLES },
      {
        name: 'word/settings.xml',
        data:
          `<\u00E9:settings xmlns:\u00E9="${W}" xmlns:w\u00E9="${W}"><\u00E9:removePersonalInformation \u00E9:val="0"/>` +
          '<w\u00E9:removePersonalInformation w\u00E9:val="false"/></\u00E9:settings>',
      },
    ],
    'a package whose settings switch protection off': [
      ...common,
      { name: 'word/styles.xml', data: STYLES },
      {
        name: 'word/settings.xml',
        data:
          `<x:settings xmlns:x="${W}" xmlns:w="urn:not-w"><x:documentProtection x:edit="readOnly"/>` +
          '<w:documentProtection w:edit="none" w:enforcement="true"/><w:writeProtection w:recommended="0"/><x:removePersonalInformation/></x:settings>',
      },
    ],
  }
}

/** An Info-ZIP Unicode Path field naming `path`, valid for an entry named `headerName`. */
function unicodePath(
  headerName: string,
  path: string,
  version = 1,
  checksumOffset = 0,
): Uint8Array {
  const name = encoder.encode(path)
  return concat([
    header(9, (view) => {
      view.setUint16(0, 0x7075, true)
      view.setUint16(2, 5 + name.length, true)
      view.setUint8(4, version)
      view.setUint32(5, (crc32(encoder.encode(headerName)) + checksumOffset) >>> 0, true)
    }),
    name,
  ])
}

const latin1 = (text: string): Uint8Array => Uint8Array.from(text, (char) => char.charCodeAt(0))
const MEGABYTE = 1024 * 1024

/**
 * A ZIP64 end record and its locator, written so that JSZip reads the archive
 * as ZIP64 while the gate does not see it: the gate looks for the locator 20
 * bytes before the end record, and four more bytes sit in between.
 */
const zip64Tail =
  (change: { disks?: number; extensible?: Uint8Array; record?: boolean } = {}) =>
  (directoryOffset: number, directoryLength: number): Uint8Array => {
    const extensible = change.extensible ?? new Uint8Array(0)
    const record = header(56, (view) => {
      view.setUint32(0, change.record === false ? 0 : 0x06064b50, true)
      view.setUint32(4, 44 + extensible.length, true)
      view.setUint32(24, 4, true)
      view.setUint32(32, 4, true)
      // four bytes more than the directory: where the end record then is expected is where it is
      view.setUint32(40, directoryLength + 4, true)
      view.setUint32(48, directoryOffset, true)
    })
    const locator = header(20, (view) => {
      view.setUint32(0, 0x07064b50, true)
      view.setUint32(8, directoryOffset + directoryLength, true)
      view.setUint32(16, change.disks ?? 1, true)
    })
    return concat([record, extensible, locator, new Uint8Array(4)])
  }

/**
 * Every answer the loader has: each refusal of the gate, each refusal of
 * JSZip a container can reach past the gate, and the containers both open
 * with entries that are not what the headers seem to say.
 */
export function oddContainers(): Array<[name: string, docx: Uint8Array]> {
  const valid = buildZip(base())
  const half = new Uint8Array(450 * MEGABYTE)
  const halfDeflated = deflateRawSync(half)
  // by hand, not a deflated text with bytes flipped: what a deflater writes differs
  // between zlib builds, and the flipped bytes then land somewhere else. A stored
  // block of 200 bytes, then a block of the reserved type.
  const stored = encoder.encode(DOCUMENT.repeat(2)).subarray(0, 200)
  const damaged = concat([Uint8Array.from([0, 200, 0, 55, 255]), stored, Uint8Array.from([7])])
  const cut = deflateRawSync(encoder.encode(DOCUMENT.repeat(40))).subarray(0, 60)
  const cases: Record<string, Uint8Array> = {
    'a valid package, deflated': valid,
    'a valid package, stored': buildZip(base().map((entry) => ({ ...entry, method: 0 }))),
    'no bytes': new Uint8Array(0),
    'not a zip': encoder.encode('this is not a zip container, it is a sentence'),
    'a local header and nothing else': valid.subarray(0, 60),
    'cut inside the central directory': valid.subarray(0, valid.length - 60),
    'cut inside the end record': valid.subarray(0, valid.length - 5),
    'an end record alone': valid.subarray(valid.length - 22),
    'more than 10000 parts': buildZip(
      Array.from({ length: 10_001 }, (_, index) => ({ name: `p${index}`, data: '' })),
    ),
    'a part declaring more than the limit': buildZip(
      withEntry({ name: 'word/media/big.bin', data: 'x', declaredSize: 600 * MEGABYTE }),
    ),
    'parts inflating to more than the total limit': buildZip(
      withEntry(
        ...[1, 2, 3, 4].map((index) => ({
          name: `word/media/zeros${index}.bin`,
          data: '',
          method: 8,
          payload: halfDeflated,
          declaredSize: half.length,
        })),
      ),
    ),
    'a stored part longer than it declares': buildZip(
      replaced('word/styles.xml', { method: 0, declaredSize: 10 }),
    ),
    'a deflated part inflating past what it declares': buildZip(
      replaced('word/styles.xml', { declaredSize: 10 }),
    ),
    'a stored part shorter than it declares': buildZip(
      replaced('word/styles.xml', { method: 0, declaredSize: STYLES.length + 5 }),
    ),
    'a deflated part inflating to less than it declares': buildZip(
      replaced('word/styles.xml', { declaredSize: STYLES.length + 5 }),
    ),
    'the main part inflating to less than it declares': buildZip(
      replaced('word/document.xml', { declaredSize: DOCUMENT.length + 5 }),
    ),
    'a media part shorter than it declares': buildZip(
      withEntry({ name: 'word/media/image1.png', data: 'png', declaredSize: 9 }),
    ),
    'a part declaring no bytes over real data': buildZip(
      replaced('word/styles.xml', { declaredSize: 0, method: 0 }),
    ),
    'damaged deflate data': buildZip(replaced('word/styles.xml', { payload: damaged })),
    'deflate data cut short': buildZip(replaced('word/styles.xml', { payload: cut })),
    'deflate data cut short and under-declared': buildZip(
      replaced('word/styles.xml', { payload: cut, declaredSize: 3 }),
    ),
    'empty deflate data': buildZip(replaced('word/styles.xml', { payload: new Uint8Array(0) })),
    // refused as the product's hosts refuse them (host.ts); Node as it is reads past them
    'bytes after the deflate stream': buildZip(
      replaced('word/styles.xml', { payload: afterTheStream(STYLES) }),
    ),
    // over what the part declares, the declaration is what it is refused for
    'bytes after the deflate stream of a part that under-declares': buildZip(
      replaced('word/styles.xml', { payload: afterTheStream(STYLES), declaredSize: 9 }),
    ),
    'one byte after a deflate stream of 300 KB': buildZip(
      replaced('word/styles.xml', {
        data: STYLES.padEnd(300_000, ' '),
        payload: concat([
          deflateRawSync(encoder.encode(STYLES.padEnd(300_000, ' '))),
          Uint8Array.from([0]),
        ]),
      }),
    ),
    'an unsupported compression method': buildZip(replaced('word/styles.xml', { method: 12 })),
    'an unsupported method on an entry the end record does not count': buildZip(
      withEntry({ name: 'extra.bin', data: 'x', method: 99, uncounted: true }),
    ),
    'an encrypted entry': buildZip(replaced('word/styles.xml', { flags: 0x0801 })),
    'an encrypted entry the end record does not count': buildZip(
      withEntry({ name: 'extra.bin', data: 'x', flags: 0x0801, uncounted: true }),
    ),
    'zip64: the record count is 0xffff': buildZip(base(), { count: 0xffff }),
    'zip64: the directory offset is 0xffffffff': buildZip(base(), { directoryOffset: 0xffffffff }),
    'zip64: the directory size is 0xffffffff': buildZip(base(), { directorySize: 0xffffffff }),
    'zip64: a locator before the end record': buildZip(base(), {
      gap: concat([latin1('PK\x06\x07'), new Uint8Array(16)]),
    }),
    'zip64: only the disk number says so': buildZip(base(), { diskNumber: 0xffff }),
    'zip64: only the disk of the directory says so': buildZip(base(), { directoryDisk: 0xffff }),
    'zip64: only the count on this disk says so': buildZip(base(), { countOnDisk: 0xffff }),
    'the end record counts more entries than there are': buildZip(base(), { count: 9 }),
    'the end record counts fewer entries than there are': buildZip(
      withEntry({
        name: 'word/numbering.xml',
        data: `<w:numbering xmlns:w="${W}"/>`,
        uncounted: true,
      }),
    ),
    'the end record counts none': buildZip(base(), { count: 0 }),
    'bytes between the directory and the end record, which counts none': buildZip(base(), {
      gap: encoder.encode('gap gap gap'),
      count: 0,
    }),
    'the directory ends past the end record': buildZip(base(), {
      directorySizeDelta: 30,
      comment: new Uint8Array(40),
    }),
    'zip64 past the gate': buildZip(base(), { diskNumber: 0xffff, gap: zip64Tail() }),
    'zip64 past the gate, on two disks': buildZip(base(), {
      diskNumber: 0xffff,
      gap: zip64Tail({ disks: 2 }),
    }),
    'zip64 past the gate, a locator without its record': buildZip(base(), {
      diskNumber: 0xffff,
      gap: zip64Tail({ record: false }),
    }),
    'zip64 past the gate, with extensible data': buildZip(base(), {
      diskNumber: 0xffff,
      gap: zip64Tail({ extensible: Uint8Array.from([1, 0, 2, 0, 0, 0, 7, 7]) }),
    }),
    'an uncounted entry whose local header is elsewhere': buildZip(
      withEntry({ name: 'extra.bin', data: 'x', uncounted: true, localOffset: 3 }),
    ),
    'an uncounted entry of unknown size': buildZip(
      withEntry({ name: 'extra.bin', data: 'x', uncounted: true, compressedSize: 0xffffffff }),
    ),
    'an uncounted entry declaring 4 GiB': buildZip(
      withEntry({ name: 'extra.bin', data: 'x', uncounted: true, declaredSize: 0xfffffffe }),
    ),
    'an uncounted entry declaring more than the limit': buildZip(
      withEntry({ name: 'extra.bin', data: 'x', uncounted: true, declaredSize: 600 * MEGABYTE }),
    ),
    'an uncounted entry with a size past 2 GiB': buildZip(
      withEntry({ name: 'extra.bin', data: 'x', uncounted: true, compressedSize: 0x80000010 }),
    ),
    'an uncounted entry with damaged deflate data': buildZip(
      withEntry({ name: 'extra.xml', data: STYLES, method: 8, payload: damaged, uncounted: true }),
    ),
    'an uncounted entry with deflate data cut short': buildZip(
      withEntry({ name: 'extra.xml', data: STYLES, method: 8, payload: cut, uncounted: true }),
    ),
    'a folder by its Unix mode alone': buildZip(
      withEntry({
        name: 'unixdir',
        data: '',
        externalAttributes: 0x41ed0000,
        versionMadeBy: 0x031e,
      }),
    ),
    'the directory offset points into the data': buildZip(base(), { directoryOffset: 10 }),
    'the directory offset points past the end': buildZip(base(), { directoryOffset: 0x7fffffff }),
    'the directory size is too small': buildZip(base(), { directorySize: 50 }),
    'the directory size is too large': buildZip(base(), { directorySize: 100_000 }),
    'bytes between the directory and the end record': buildZip(base(), {
      gap: encoder.encode('gap gap gap'),
    }),
    'bytes before the first entry, offsets not adjusted': buildZip(base(), {
      prepend: encoder.encode('#!/bin/sh\n'),
    }),
    'bytes before the first entry, offsets adjusted': buildZip(base(), {
      prepend: encoder.encode('#!/bin/sh\n'),
      adjusted: true,
    }),
    'a comment holding an end record signature': buildZip(base(), {
      comment: latin1('PK\x05\x06 and more comment text here'),
    }),
    'bytes after the end record': buildZip(base(), { trailer: encoder.encode('trailing bytes') }),
    'a local header offset pointing at no header': buildZip(
      replaced('word/styles.xml', { localOffset: 3 }),
    ),
    'a local header offset past the end': buildZip(
      replaced('word/styles.xml', { localOffset: 0x7ffffff0 }),
    ),
    'compressed data running past the end': buildZip(
      replaced('word/styles.xml', { compressedSize: 0x00ffffff }),
    ),
    'compressed data shorter than the payload': buildZip(
      replaced('word/styles.xml', { compressedSize: 20 }),
    ),
    'the local name differs from the central name': buildZip(
      replaced('word/styles.xml', { localName: 'word/other.xml' }),
    ),
    'two entries of one name': buildZip(
      withEntry({ name: 'word/styles.xml', data: STYLES.replace('21', '30'), method: 8 }),
    ),
    'a name that is not UTF-8, without the flag': buildZip(
      withEntry({ name: latin1('word/caf\xe9.xml'), data: '<a/>', flags: 0 }),
    ),
    'a name that is not UTF-8, with the flag': buildZip(
      withEntry({ name: latin1('word/caf\xe9.xml'), data: '<a/>' }),
    ),
    'a UTF-8 name without the flag': buildZip(
      withEntry({ name: 'word/\ud55c\uae00.xml', data: '<a/>', flags: 0 }),
    ),
    'a Unicode Path field that would shadow the main part': buildZip(
      withEntry({
        name: 'word/shadow.xml',
        data: '<w:document/>',
        flags: 0,
        extra: unicodePath('word/shadow.xml', 'word/document.xml'),
      }),
    ),
    'a Unicode Path field on an entry the end record does not count': buildZip(
      withEntry({
        name: 'word/shadow.xml',
        data: '<w:document/>',
        flags: 0,
        uncounted: true,
        extra: unicodePath('word/shadow.xml', 'word/shadowed.xml'),
      }),
    ),
    'an uncounted Unicode Path field with another checksum': buildZip(
      withEntry({
        name: 'word/shadow.xml',
        data: '<a/>',
        flags: 0,
        uncounted: true,
        extra: unicodePath('word/shadow.xml', 'word/shadowed.xml', 1, 1),
      }),
    ),
    'an uncounted Unicode Path field of another version': buildZip(
      withEntry({
        name: 'word/shadow.xml',
        data: '<a/>',
        flags: 0,
        uncounted: true,
        extra: unicodePath('word/shadow.xml', 'word/shadowed.xml', 2),
      }),
    ),
    'an uncounted Unicode Path field too short to read': buildZip(
      withEntry({
        name: 'word/shadow.xml',
        data: '<a/>',
        flags: 0,
        uncounted: true,
        extra: Uint8Array.from([0x75, 0x70, 2, 0, 1, 0, 0xee, 0xee, 0xee, 0xee]),
      }),
    ),
    'an extra field running past its header': buildZip(
      replaced('word/styles.xml', { extra: Uint8Array.from([1, 2, 0xff, 0xff, 9, 9, 9, 9]) }),
    ),
    'folders: by name, by DOS attribute, by Unix mode and name': buildZip(
      withEntry(
        { name: 'word/media/', data: '' },
        { name: 'dosdir', data: 'kept as a folder', externalAttributes: 0x10 },
        { name: 'unixdir/', data: '', externalAttributes: 0x41ed0000, versionMadeBy: 0x031e },
        { name: 'unixfile', data: 'x', externalAttributes: 0x81a40000, versionMadeBy: 0x031e },
        { name: 'dirmode-made-by-dos', data: 'x', externalAttributes: 0x41ed0000 },
      ),
    ),
    'names with dot segments, doubled and leading slashes, backslashes': buildZip(
      withEntry(
        { name: 'word/../word/./numbering.xml', data: `<w:numbering xmlns:w="${W}"/>` },
        { name: '../outside.xml', data: '<a/>' },
        { name: '/rooted.xml', data: '<a/>' },
        { name: 'a//b.xml', data: '<a/>' },
        { name: 'a\\b.xml', data: '<a/>' },
        { name: '', data: 'nameless' },
        { name: '..', data: 'dots' },
      ),
    ),
    'names that are array indexes': buildZip(
      withEntry(
        { name: 'b', data: '1' },
        { name: '10', data: '2' },
        { name: '2', data: '3' },
        { name: '02', data: '4' },
        { name: '4294967295', data: '5' },
        { name: '4294967294', data: '6' },
        { name: '0', data: '7' },
        { name: '2', data: '8' },
      ),
    ),
    'no main part': buildZip(base().filter((entry) => entry.name !== 'word/document.xml')),
    'no main part and no relationships': buildZip(
      base().filter((entry) => entry.name !== 'word/document.xml' && entry.name !== '_rels/.rels'),
    ),
    'the main part under another name': buildZip([
      { name: '[Content_Types].xml', data: CONTENT_TYPES },
      {
        name: '_rels/.rels',
        data: rels(
          `<Relationship Id="rId0" Type="${OFFICE_RELS}/officeDocument" Target="http://example.com/x" TargetMode="External"/>`,
          `<Relationship Id="rId1" Type="${OFFICE_RELS}/officeDocument" Target="missing.xml"/>`,
          `<Relationship Id="rId2" Type="${OFFICE_RELS}/officeDocument" Target="/word/trial%20run.xml#frag"/>`,
        ),
      },
      { name: 'word/trial run.xml', data: DOCUMENT },
      {
        name: 'word/_rels/trial run.xml.rels',
        data: rels('<Relationship Id="rId1" Type="t" Target="styles.xml"/>'),
      },
    ]),
    'relationships that lead out of the package or nowhere': buildZip(
      replaced('_rels/.rels', {
        data: rels(
          ...[
            '../../etc/passwd',
            '/../x',
            'file:///c:/x',
            'C:\\x',
            '%2e%2e/x',
            '..\\..\\x',
            '%zz',
            '%E0%A4%A',
            '',
            '#only-a-fragment',
            'a/./b/../c.xml',
            '\\rooted\\by\\backslash.xml',
            'word/%ED%95%9C%EA%B8%80.xml',
            'mailto:a@b',
            './',
            'a%2Fb',
          ].map(
            (target, index) =>
              `<Relationship Id="r${index}" Type="${OFFICE_RELS}/officeDocument" Target="${target}"/>`,
          ),
          '<Relationship Type="no id" Target="x"/><Relationship Id="" Target="empty id"/>',
          '<Relationship Id="r0" Target="the same id again"/><Relationship Id="bare"/>',
        ),
      }),
    ),
    'relationships after a DOCTYPE': buildZip(
      replaced('_rels/.rels', {
        data: `<?xml version="1.0"?><!DOCTYPE Relationships [<!ENTITY x SYSTEM "file:///etc/passwd">]>${ROOT_RELS.slice(21)}`,
      }),
    ),
    'content types that are not XML': buildZip(
      replaced('[Content_Types].xml', { data: '<Types><Default Extension="xml"' }),
    ),
    'content types without the Types element': buildZip(
      replaced('[Content_Types].xml', {
        data: '<types><Default Extension="xml" ContentType="a/b"/></types>',
      }),
    ),
    'relationships that are not XML': buildZip(
      replaced('_rels/.rels', { data: '<Relationships><!--' }),
    ),
    'styles that are not XML': buildZip(replaced('word/styles.xml', { data: '<w:styles><!--' })),
    'a Strict package': buildZip(STRICT_PACKAGE.map(([name, data]) => ({ name, data, method: 8 }))),
    'an uncounted entry declaring no bytes over real data': buildZip(
      withEntry({ name: 'extra.xml', data: STYLES, uncounted: true, declaredSize: 0 }),
    ),
    'an entry without a name at the end of the directory': buildZip(
      withEntry({ name: '', data: 'nameless' }),
    ),
    'folders that would put the count past the limit': buildZip(
      withEntry(
        ...Array.from({ length: 9_990 }, (_, index) => ({ name: `p${index}`, data: '' })),
        ...Array.from({ length: 20 }, (_, index) => ({ name: `folder${index}/`, data: '' })),
      ),
    ),
    ...Object.fromEntries(
      Object.entries(richPackages(true)).map(([name, entries]) => [name, buildZip(entries)]),
    ),
  }
  return Object.entries(cases)
}

/** The rich packages as mutation seeds: the container, and its parts that are text. */
export function richSeeds(): Array<{
  where: string
  docx: Uint8Array
  parts: Array<[name: string, text: string]>
}> {
  return Object.entries(richPackages()).map(([where, entries]) => ({
    where,
    docx: buildZip(entries),
    parts: entries.flatMap(({ name, data }): Array<[string, string]> =>
      typeof name === 'string' && typeof data === 'string' ? [[name, data]] : [],
    ),
  }))
}

/**
 * Containers JSZip does not return from. The zip gate refuses them before
 * JSZip sees them; each loader opens them in a process of its own
 * (package-run.ts), so one that reaches the loop again shows as a difference
 * instead of hanging the gate.
 *
 * JSZip reads the extensible data of a ZIP64 end record in a loop that never
 * advances its counter and ends when a read runs past the data. A field of
 * length -6 moves the reader back to where the field began; a field of
 * length 0 and then one of length -12 do the same between them.
 */
export function hostileContainers(): Record<string, Uint8Array> {
  return {
    'zip64 extensible data that reads itself again': buildZip(base(), {
      diskNumber: 0xffff,
      gap: zip64Tail({ extensible: Uint8Array.from([1, 0, 0xfa, 0xff, 0xff, 0xff]) }),
    }),
    'zip64 extensible data that leads back over two fields': buildZip(base(), {
      diskNumber: 0xffff,
      gap: zip64Tail({
        extensible: Uint8Array.from([1, 0, 0, 0, 0, 0, 2, 0, 0xf4, 0xff, 0xff, 0xff]),
      }),
    }),
  }
}

const afterTheStream = (text: string): Uint8Array =>
  concat([deflateRawSync(encoder.encode(text)), encoder.encode('trailing')])

const S = 'http://purl.oclc.org/ooxml/'
const STRICT_W = `${S}wordprocessingml/main`
const WPS = 'http://schemas.microsoft.com/office/word/2010/wordprocessingShape'

/** A package the way Word 2013 writes it in ISO Strict mode, with prefixes of its own. */
const STRICT_PACKAGE: Array<[string, string]> = [
  ['[Content_Types].xml', CONTENT_TYPES],
  [
    '_rels/.rels',
    rels(
      `<Relationship Id="rId1" Type="${S}officeDocument/relationships/officeDocument" Target="word/document.xml"/>`,
      `<Relationship Id="rId2" Type="${S}officeDocument/relationships/extendedProperties" Target="docProps/app.xml"/>`,
    ),
  ],
  [
    'word/document.xml',
    `<?xml version="1.0"?><x:document xmlns:x="${STRICT_W}" xmlns:rel="${S}officeDocument/relationships" x:conformance="strict">` +
      '<x:body><x:p><x:pPr><x:ind x:left="2.54cm" x:hanging="36pt"/><x:spacing x:before="0.5in" x:line="12pt"/></x:pPr>' +
      '<x:r><x:rPr><x:sz x:val="10.5pt"/></x:rPr><x:t>strict</x:t></x:r></x:p>' +
      '<x:sectPr><x:pgSz x:w="210mm" x:h="297mm"/><x:pgMar x:top="1in" x:left="6pc" x:right="6pi" x:gutter="-3.5mm"/></x:sectPr>' +
      '</x:body></x:document>',
  ],
  [
    'word/_rels/document.xml.rels',
    rels(
      `<Relationship Id="rId1" Type="${S}officeDocument/relationships/styles" Target="styles.xml"/>`,
      `<Relationship Id="rId2" Type="${S}officeDocument/relationships/customProperties" Target="x.xml"/>`,
    ),
  ],
  [
    'word/styles.xml',
    `<?xml version="1.0"?><styles xmlns="${STRICT_W}"><docDefaults><rPrDefault><rPr><sz val="11pt"/></rPr></rPrDefault></docDefaults>` +
      '<style type="paragraph" styleId="Normal" default="1"><name val="Normal"/><pPr><spacing after="8pt"/></pPr></style></styles>',
  ],
  ['docProps/app.xml', `<Properties xmlns="${S}officeDocument/extendedProperties"/>`],
  ['word/media/image1.png', 'not xml: left alone'],
  // the loader normalizes .xml and .rels in any case
  [
    'word/Header1.XML',
    `<x:hdr xmlns:x="${STRICT_W}"><x:p><x:pPr><x:spacing x:after="6pt"/></x:pPr></x:p></x:hdr>`,
  ],
  // but not a name ending in U+017F, an s only under Unicode case folding,
  // which /i without /u does not apply: this part stays Strict
  [
    'word/x.rel\u017f',
    `<x:hdr xmlns:x="${STRICT_W}"><x:p><x:pPr><x:spacing x:after="6pt"/></x:pPr></x:p></x:hdr>`,
  ],
  ['word/unchanged.xml', `<w:ftr xmlns:w="${W}"/>`],
]

/** Parts and fragments that take every branch of the normalizer. */
export const STRICT_PARTS: string[] = [
  ...STRICT_PACKAGE.map(([, text]) => text),
  '',
  'no tags at all',
  '<a/>',
  '<>',
  '< w:p>',
  '<a',
  '<a b="1',
  '</a>',
  '</a></b><c>',
  '<a><b></a>',
  '<!-- <x:p xmlns:x="strict"> --><![CDATA[<x:p>]]><?pi <x:p>?><!DOCTYPE a [<!ENTITY b "c">]>',
  '<!-- never closed <a>',
  '<![CDATA[ never closed <a>',
  '<? never closed <a>',
  `<x:p xmlns:x="${STRICT_W}" a="1>2" b='3>4' c="it's" d='say "hi"' e = "spaced" f= 'g'   h="i" />`,
  `<x:p xmlns:x='${STRICT_W}'><x:r x:rsidR = "1"/></x:p >`,
  // the default namespace is the strict w: it stays, and a w prefix is added
  `<document xmlns="${STRICT_W}"><body><p><pPr><ind left="1cm"/></pPr></p></body></document>`,
  // the canonical prefix is taken by another namespace: the binding stays as it is
  `<w:a xmlns:w="urn:other"><x:p xmlns:x="${STRICT_W}"><x:ind x:left="1in" w:left="1in"/></x:p></w:a>`,
  // the canonical binding exists already: the second declaration is dropped
  `<w:a xmlns:w="${W}"><x:p xmlns:x="${W}"><x:r/></x:p><w:p/></w:a>`,
  // two prefixes of one namespace on one element, and one declared twice
  `<x:a xmlns:x="${W}" xmlns:y="${W}" xmlns:x="${STRICT_W}"><y:b x:c="1" y:d="2"/></x:a>`,
  // a rename that ends inside: the outer scope has its prefix back
  `<a xmlns:x="urn:one"><x:b><x:c xmlns:x="${W}"><x:d/></x:c><x:e/></x:b></a>`,
  `<x:tbl xmlns:x="${STRICT_W}"><x:tblPr><x:tblW x:w="100pt" x:type="dxa"/><x:tblBorders><x:top x:sz="0.5pt" x:space="2pt" x:val="single"/></x:tblBorders>` +
    '<x:tblCellMar><x:left x:w="0.19cm"/></x:tblCellMar></x:tblPr></x:tbl>',
  `<w:p xmlns:w="${W}"><w:ind w:left="12pt" w:right="-0.5in" w:start="1.5pc" w:end="2pi" w:firstLine="5mm" w:hanging="abc"/>` +
    `<w:sz w:val="${'9'.repeat(400)}in"/><w:sz w:val="12.5pt"/><w:sz w:val=".5pt"/><w:sz w:val="5.pt"/><w:sz w:val="1e2pt"/><w:sz w:val="12PT"/>` +
    '<w:spacing w:val="0.0124pt" w:line="0.025pt" w:before="-0.025pt"/><w:other w:val="12pt"/><w:tab w:pos="1in" pos="2in" x:pos="3in"/></w:p>',
  // a measure on an element of another namespace is left alone
  `<a:ind xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" left="12pt"/>`,
  // Word 2013 strict: shape children in the wp namespace inside a wps graphicData
  `<w:drawing xmlns:w="${W}" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">` +
    `<wp:inline><a:graphic><a:graphicData uri="${WPS}"><wp:wsp><wp:cNvSpPr/><wp:spPr><a:prstGeom prst="rect"/></wp:spPr><wp:bodyPr/></wp:wsp></a:graphicData>` +
    `<a:graphicData uri="other"><wp:wsp/></a:graphicData><a:graphicData uri="${WPS}"/><wp:after/></a:graphic></wp:inline></w:drawing>`,
  `<w:drawing xmlns:w="${W}" xmlns:d="${S}drawingml/wordprocessingDrawing" xmlns:a="${S}drawingml/main" xmlns:wps="urn:taken">` +
    `<a:graphicData uri="${WPS}"><d:wsp><d:bodyPr/><a:graphicData uri="${WPS}"><d:wsp/></a:graphicData></d:wsp></a:graphicData></w:drawing>`,
  // markup compatibility lists follow the renamed prefixes
  `<x:document xmlns:x="${STRICT_W}" xmlns:m2="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:q="http://schemas.microsoft.com/office/word/2010/wordml" m2:Ignorable="q x  unknown" m2:MustUnderstand="q">` +
    '<m2:AlternateContent><m2:Choice Requires="q x"><x:p/></m2:Choice><m2:Fallback Requires="q"/></m2:AlternateContent><x:p Requires="q" Ignorable="q"/></x:document>',
  `<Relationships xmlns="${PACKAGE_RELS}"><Relationship Type="${S}officeDocument/relationships/image" Target="${S}officeDocument/relationships"/>` +
    `<Relationship Type="${S}officeDocument/relationships/" Target="${S}unknown/part"/></Relationships>`,
  `<v:shape xmlns:v="urn:schemas-microsoft-com:vml" xmlns:office="urn:schemas-microsoft-com:office:office" xmlns:xml2="http://www.w3.org/XML/1998/namespace" office:spid="1" xml:space="preserve" xml2:lang="en"/>`,
  `<x:p xmlns:x="${STRICT_W}" xmlns:\ud55c="${S}officeDocument/math"><\ud55c:oMath \ud55c:val="\ud55c\uae00 \u{1f600}"/>\u{1f600}</x:p>`,
]

const TRANSITIONAL_TO_STRICT: Array<[string, string]> = [
  [W, STRICT_W],
  [OFFICE_RELS, `${S}officeDocument/relationships`],
  ['http://schemas.openxmlformats.org/drawingml/2006/main', `${S}drawingml/main`],
  [
    'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing',
    `${S}drawingml/wordprocessingDrawing`,
  ],
  ['http://schemas.openxmlformats.org/drawingml/2006/picture', `${S}drawingml/picture`],
  ['http://schemas.openxmlformats.org/officeDocument/2006/math', `${S}officeDocument/math`],
]

/**
 * A transitional part rewritten the Strict way: purl.oclc.org namespaces, a
 * prefix of its own for wordprocessingml, universal measures. Not a faithful
 * conversion: it only has to send real parts down the paths of the normalizer.
 */
export function strictified(xml: string): string {
  let out = xml
  for (const [transitional, strict] of TRANSITIONAL_TO_STRICT)
    out = out.replaceAll(transitional, strict)
  return out
    .replace(/xmlns:w=/g, 'xmlns:x=')
    .replace(/(<\/?)w:/g, '$1x:')
    .replace(/(\s)w:/g, '$1x:')
    .replace(
      /(x:(?:w|left|right|before|after|val|line|pos)=")(\d+)"/g,
      (_match, start: string, digits: string) => {
        const twips = Number(digits)
        return twips % 20 === 0
          ? `${start}${twips / 20}pt"`
          : `${start}${(twips / 567).toFixed(2)}cm"`
      },
    )
}

/** Offsets worth hitting: the end record, the central directory, the local headers. */
function landmarks(bytes: Uint8Array): number[][] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const end = bytes.length - 22
  const directory = end >= 0 ? Math.min(view.getUint32(end + 16, true), bytes.length) : 0
  const locals: number[] = []
  for (let at = 0; at + 4 <= directory; at++) {
    if (view.getUint32(at, true) === 0x04034b50) locals.push(at)
  }
  return [
    [Math.max(0, end), bytes.length],
    [directory, Math.max(directory, end)],
    ...locals.map((at) => [at, Math.min(at + 60, bytes.length)]),
  ]
}

const FIELD_VALUES = [0, 1, 2, 8, 0x10, 0xff, 0x100, 0x7fff, 0x8000, 0xffff]

/**
 * One to three edits of a container: a byte or a 16 or 32 bit field in a
 * header overwritten, a slice removed, repeated or zeroed, the end cut off.
 */
export function mutateContainer(docx: Uint8Array, random: () => number): Uint8Array {
  const int = (below: number): number => Math.floor(random() * below)
  let bytes: Uint8Array = docx.slice()
  for (let edits = 1 + int(3); edits > 0; edits--) {
    if (bytes.length < 30) break
    const regions = landmarks(bytes)
    const [from, to] = random() < 0.85 ? regions[int(regions.length)]! : [0, bytes.length]
    const at = from! + int(Math.max(1, to! - from!))
    const kind = random()
    if (kind < 0.35) {
      bytes[at] = random() < 0.5 ? int(256) : bytes[at]! ^ (1 << int(8))
    } else if (kind < 0.6) {
      const value = FIELD_VALUES[int(FIELD_VALUES.length)]!
      bytes[at] = value & 0xff
      if (at + 1 < bytes.length) bytes[at + 1] = value >> 8
    } else if (kind < 0.75) {
      const value = [
        0,
        1,
        bytes.length,
        bytes.length - 22,
        0x7fffffff,
        0x80000000,
        0xffffffff,
        int(bytes.length),
      ][int(8)]!
      for (let index = 0; index < 4 && at + index < bytes.length; index++) {
        bytes[at + index] = (value >>> (8 * index)) & 0xff
      }
    } else if (kind < 0.83) {
      bytes = concat([bytes.subarray(0, at), bytes.subarray(at + 1 + int(8))])
    } else if (kind < 0.9) {
      bytes = concat([
        bytes.subarray(0, at),
        bytes.subarray(at, at + 1 + int(40)),
        bytes.subarray(at),
      ])
    } else if (kind < 0.95) {
      bytes.fill(0, at, at + 1 + int(12))
    } else {
      bytes = bytes.slice(0, bytes.length - 1 - int(Math.min(80, bytes.length - 1)))
    }
  }
  return bytes
}
