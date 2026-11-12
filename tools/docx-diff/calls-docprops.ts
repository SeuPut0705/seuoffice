// Group docprops of comparison (f): the read side of doc-properties.ts,
// zotero-doc-props.ts, sources.ts and protection.ts.
import {
  APP_PROPERTIES_CONTENT_TYPE,
  APP_PROPERTIES_PATH,
  APP_PROPERTIES_REL_TYPE,
  APP_PROPERTY_KEYS,
  CORE_PROPERTIES_CONTENT_TYPE,
  CORE_PROPERTIES_PATH,
  CORE_PROPERTIES_REL_TYPE,
  CORE_PROPERTY_KEYS,
  emptyDocumentProperties,
  parseAppPropertiesXml,
  parseCorePropertiesXml,
  parseCustomPropertiesXml,
  parseCustomPropertyTypesXml,
  readDocumentProperties,
} from './reference/doc-properties'
import {
  DEFAULT_SPIN_COUNT,
  hashProtectionPassword,
  MAX_SPIN_COUNT,
  resolveSpinCount,
  verifyProtectionPassword,
} from './reference/protection'
import {
  bibliographyLine,
  citationText,
  CUSTOM_XML_REL_TYPE,
  findSourcesPart,
  parseSourcesXml,
  SOURCES_NS,
} from './reference/sources'
import type { DocProtection, SourceInfo } from './reference/types'
import {
  attrValue,
  CUSTOM_PROPERTIES_CONTENT_TYPE,
  CUSTOM_PROPERTIES_PATH,
  CUSTOM_PROPERTIES_REL_TYPE,
  decodeXmlText,
  parseZoteroDocumentDataXml,
  propertyText,
  readZoteroDocumentData,
} from './reference/zotero-doc-props'
import { type CallSpec, type Input, zipOf } from './calls-spec'

type Record_ = Pick<DocProtection, 'hash' | 'salt' | 'spinCount' | 'algorithmSid'>

const CONSTANTS: Record<string, unknown> = {
  CORE_PROPERTY_KEYS,
  APP_PROPERTY_KEYS,
  emptyDocumentProperties: emptyDocumentProperties(),
  CORE_PROPERTIES_PATH,
  APP_PROPERTIES_PATH,
  CORE_PROPERTIES_CONTENT_TYPE,
  CORE_PROPERTIES_REL_TYPE,
  APP_PROPERTIES_CONTENT_TYPE,
  APP_PROPERTIES_REL_TYPE,
  CUSTOM_PROPERTIES_PATH,
  CUSTOM_PROPERTIES_REL_TYPE,
  CUSTOM_PROPERTIES_CONTENT_TYPE,
  SOURCES_NS,
  CUSTOM_XML_REL_TYPE,
  DEFAULT_SPIN_COUNT,
  MAX_SPIN_COUNT,
}

/** The part as the text input, where the document has it. */
const part =
  (name: string) =>
  (parts: ReadonlyMap<string, string>): Input[] => {
    const text = parts.get(name)
    return text === undefined ? [] : [{ text }]
  }

const sourcesParts = (parts: ReadonlyMap<string, string>): string[] =>
  [...parts].filter(([name]) => /^customXml\/item\d+\.xml$/.test(name)).map(([, text]) => text)

/** The package of the parts whose name starts with one of `prefixes`. */
const packageOf =
  (...prefixes: string[]) =>
  (parts: ReadonlyMap<string, string>): Input[] => {
    const picked = [...parts].filter(([name]) => prefixes.some((prefix) => name.startsWith(prefix)))
    return picked.length === 0 ? [] : [{ args: { parts: picked } }]
  }

const VT = 'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"'
const FMTID = 'fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}"'

const CORE_FULL =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
  '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
  '<dc:title>Report &amp; Plan</dc:title><dc:subject>Sub</dc:subject><dc:creator>Kim</dc:creator>' +
  '<cp:keywords>a, b</cp:keywords><dc:description>Desc &lt;b&gt;</dc:description>' +
  '<cp:lastModifiedBy>Lee</cp:lastModifiedBy><cp:revision>7</cp:revision>' +
  '<dcterms:created xsi:type="dcterms:W3CDTF">2024-01-02T03:04:05Z</dcterms:created>' +
  '<dcterms:modified xsi:type="dcterms:W3CDTF">2024-01-02T03:04:05.123+09:00</dcterms:modified>' +
  '<cp:category>Cat</cp:category><cp:contentStatus>Draft</cp:contentStatus>' +
  '<dc:identifier>urn:1</dc:identifier><dc:language>ko-KR</dc:language><cp:version>1.0</cp:version>' +
  '</cp:coreProperties>'

const CORE_BUILT: string[] = [
  CORE_FULL,
  '<cp:coreProperties><dc:title/><dc:subject></dc:subject><title>no prefix</title></cp:coreProperties>',
  '<cp:coreProperties><dc:title>first</dc:title><dc:title>second</dc:title><x:creator>other prefix</x:creator></cp:coreProperties>',
  "<cp:coreProperties><dc:title xml:lang='ko'>quoted &#x41;&#66;&#x1F600;&#xD83D;&#xDE00;&amp;lt;</dc:title><dc:creator><![CDATA[a<b]]></dc:creator></cp:coreProperties>",
  '<cp:coreProperties><dc:titleX>not it</dc:titleX><dc:title >spaced</dc:title ><cp:keywords a="1"/></cp:coreProperties>',
  '<cp:coreProperties><dc:title>mismatched</y:title><dcterms:created>2024-01-02</dcterms:created><dcterms:modified>garbage date</dcterms:modified></cp:coreProperties>',
  '<cp:coreProperties><dc:title>&#x110000;&#99999999999999999999;&#xZZ;&#;&#x26;#65;&#X42;&quot;&apos;&gt;</dc:title><cp:revision>\n 3 \n</cp:revision><dc:language/></cp:coreProperties>',
  // half a surrogate pair in one property, with every other property beside
  // it: the rest of such a result is compared with the half as U+FFFD
  CORE_FULL.replace('<dc:language>ko-KR', '<dc:language>ko&#xD800;KR').replace(
    '<cp:version>1.0',
    '<cp:version>&#xDC00;1.0&#xD83D;',
  ),
  '<dc:title>unclosed',
  '',
]

const APP_FULL =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
  `<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" ${VT}>` +
  '<Template>Normal.dotm</Template><TotalTime>12</TotalTime><Pages>3</Pages><Words>420</Words>' +
  '<Characters>2400</Characters><Application>Microsoft Office Word</Application><DocSecurity>0</DocSecurity>' +
  '<Lines>20</Lines><Paragraphs>5</Paragraphs><ScaleCrop>false</ScaleCrop>' +
  '<HeadingPairs><vt:vector size="2" baseType="variant"><vt:variant><vt:lpstr>Title</vt:lpstr></vt:variant></vt:vector></HeadingPairs>' +
  '<Company>ACME &amp; Co</Company><LinksUpToDate>false</LinksUpToDate><CharactersWithSpaces>2800</CharactersWithSpaces>' +
  '<SharedDoc>false</SharedDoc><HyperlinksChanged>false</HyperlinksChanged><AppVersion>16.0000</AppVersion>' +
  '<Manager>Park</Manager></Properties>'

const APP_BUILT: string[] = [
  APP_FULL,
  '<Properties><Template/><Pages>3</Pages><Pages>4</Pages><ap:Company>prefixed</ap:Company></Properties>',
  "<Properties><Company a='x'>single &#x41C;</Company><Manager></Manager><Lines>1</Lines ></Properties>",
  '<Properties><PagesX>no</PagesX><Words>1<Words>2</Words></Words></Properties>',
  '',
]

const property = (name: string, body: string, pid = 2): string =>
  `<property ${FMTID} pid="${pid}" name="${name}">${body}</property>`

const custom = (...properties: string[]): string =>
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
  `<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" ${VT}>` +
  properties.join('') +
  '</Properties>'

const CUSTOM_BUILT: string[] = [
  custom(
    property('Text', '<vt:lpwstr>hello &amp; bye</vt:lpwstr>'),
    property('Count', '<vt:i4>42</vt:i4>'),
    property('Flag', '<vt:bool>true</vt:bool>'),
    property('When', '<vt:filetime>2024-01-02T03:04:05Z</vt:filetime>'),
    property('Ratio', '<vt:r8>1.5</vt:r8>'),
    property('Day', '<vt:date>2024-01-02</vt:date>'),
    property('Money', '<vt:cy>12.50</vt:cy>'),
    property('Odd', '<vt:foo>unknown</vt:foo>'),
    property('Big', '<vt:i8>9007199254740993</vt:i8>'),
    property('Dec', '<vt:decimal>0.1</vt:decimal>'),
  ),
  custom(
    property('Dup', '<vt:lpwstr>first</vt:lpwstr>'),
    property('Dup', '<vt:i4>2</vt:i4>'),
    property('__proto__', '<vt:lpwstr>proto</vt:lpwstr>'),
    property('constructor', '<vt:lpwstr>ctor</vt:lpwstr>'),
    property('10', '<vt:lpwstr>ten</vt:lpwstr>'),
    property('2', '<vt:lpwstr>two</vt:lpwstr>'),
    property('', '<vt:lpwstr>no name</vt:lpwstr>'),
    `<property ${FMTID} pid="9"><vt:lpwstr>missing name</vt:lpwstr></property>`,
  ),
  custom(
    `<property ${FMTID} pid='3' name='single'><vt:lpwstr>q</vt:lpwstr></property>`,
    `<property pid="4" name="a&amp;b&#x41;"><lpwstr>no vt prefix</lpwstr></property>`,
    `<property aname="z" name="y"><vt:lpwstr>after aname</vt:lpwstr></property>`,
    `<property x:name="first" name="second"><vt:i4>5</vt:i4></property>`,
    property('Mismatch', '<vt:i4>5</vt:i8><vt:lpwstr>fallback</vt:lpwstr>'),
    property('SelfClosing', '<vt:lpwstr/>'),
    property('Cdata', '<vt:lpwstr><![CDATA[x<y]]></vt:lpwstr>'),
    property('Vector', '<vt:vector size="1" baseType="lpstr"><vt:lpstr>v</vt:lpstr></vt:vector>'),
    property('Blob', '<vt:blob>AAAA</vt:blob>'),
    property('Empty', ''),
    property('Spaced', '<vt:i4 >7</vt:i4 >'),
  ),
  custom(
    property('10', '<vt:lpwstr>ten</vt:lpwstr>'),
    property('half&#xD800;name', '<vt:lpwstr>in a key</vt:lpwstr>'),
    property('2', '<vt:i4>2</vt:i4>'),
    property('Value', '<vt:lpwstr>in a value &#xDFFF;</vt:lpwstr>'),
    property('Last', '<vt:bool>true</vt:bool>'),
  ),
  '<op:Properties><op:property name="ns"><vt:bool>0</vt:bool></op:property ></op:Properties>',
  custom(),
  '',
]

const ZOTERO_BUILT: string[] = [
  custom(
    property('ZOTERO_PREF_2', '<vt:lpwstr>-second</vt:lpwstr>'),
    property('ZOTERO_PREF_1', '<vt:lpwstr>&lt;data first</vt:lpwstr>'),
    property('ZOTERO_PREF_10', '<vt:lpwstr>-tenth</vt:lpwstr>'),
    property('ZOTERO_PREF_3', '<vt:lpwstr>-third</vt:lpwstr>'),
  ),
  custom(property('ZOTERO_PREF', '<vt:lpwstr>legacy &amp; only</vt:lpwstr>')),
  custom(
    property('ZOTERO_PREF', '<vt:lpwstr>legacy</vt:lpwstr>'),
    property('ZOTERO_PREF_010', '<vt:lpwstr>b</vt:lpwstr>'),
    property('ZOTERO_PREF_2', '<vt:lpwstr>a</vt:lpwstr>'),
    property('ZOTERO_PREF_2', '<vt:lpwstr>a2</vt:lpwstr>'),
  ),
  custom(
    property('ZOTERO_PREF_' + '9'.repeat(400), '<vt:lpwstr>inf1</vt:lpwstr>'),
    property('ZOTERO_PREF_' + '8'.repeat(400), '<vt:lpwstr>inf2</vt:lpwstr>'),
    property('ZOTERO_PREF_5', '<vt:i4>no lpwstr</vt:i4>'),
    property('ZOTERO_PREF_', '<vt:lpwstr>no digits</vt:lpwstr>'),
    property('zotero_pref_1', '<vt:lpwstr>lower case</vt:lpwstr>'),
  ),
  custom(property('Other', '<vt:lpwstr>x</vt:lpwstr>')),
]

const source = (body: string): string => `<b:Source>${body}</b:Source>`

const SOURCE_TYPES = [
  'Book',
  'BookSection',
  'JournalArticle',
  'ArticleInAPeriodical',
  'ConferenceProceedings',
  'Report',
  'SoundRecording',
  'Performance',
  'Art',
  'DocumentFromInternetSite',
  'InternetSite',
  'Film',
  'Interview',
  'Patent',
  'ElectronicSource',
  'Case',
  'Misc',
]

const SOURCES_FULL =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<b:Sources SelectedStyle="\\APA.XSL" StyleName="APA" xmlns:b="${SOURCES_NS}" xmlns="${SOURCES_NS}">` +
  SOURCE_TYPES.map((type, index) =>
    source(
      `<b:Tag>T${index}</b:Tag><b:SourceType>${type}</b:SourceType>` +
        `<b:Author><b:Author><b:NameList><b:Person><b:Last>Last${index}</b:Last><b:First>First${index}</b:First></b:Person>` +
        `<b:Person><b:Last>Second${index}</b:Last></b:Person></b:NameList></b:Author></b:Author>` +
        `<b:Title>Title ${index}</b:Title><b:Year>20${10 + index}</b:Year>` +
        (type === 'JournalArticle'
          ? '<b:JournalName>Journal</b:JournalName>'
          : type === 'InternetSite'
            ? '<b:InternetSiteTitle>Site</b:InternetSiteTitle><b:URL>https://x.test/?a=1&amp;b=2</b:URL>'
            : '<b:Publisher>Pub &amp; Sons</b:Publisher>'),
    ),
  ).join('') +
  '</b:Sources>'

const SOURCES_BUILT: string[] = [
  SOURCES_FULL,
  source(
    '<b:Tag>Corp</b:Tag><b:Author><b:Author><b:Corporate>  World Bank  </b:Corporate></b:Author></b:Author><b:Last>Ignored</b:Last>',
  ) +
    source('<b:Tag>   </b:Tag><b:Title>blank tag</b:Title>') +
    source('<b:Title>no tag</b:Title>') +
    source('<b:Tag></b:Tag>') +
    source(
      '<b:Tag>WS</b:Tag><b:Corporate> </b:Corporate><b:First>Only First</b:First><b:SourceType> </b:SourceType>',
    ) +
    source('<b:Tag>L</b:Tag><b:Last>Only Last</b:Last><b:Year></b:Year><b:Title>T</b:Title>') +
    source(
      '<b:Tag>Pubs</b:Tag><b:JournalName>J</b:JournalName><b:InternetSiteTitle>S</b:InternetSiteTitle>',
    ) +
    source(
      '<b:Tag>Site</b:Tag><b:InternetSiteTitle>&quot;S&apos;&lt;&gt;</b:InternetSiteTitle><b:URL> </b:URL>',
    ) +
    '<b:Source xmlns:b="x"><b:Tag>attr</b:Tag></b:Source>' +
    source(
      '<b:Tag>&amp;lt;</b:Tag><b:Publisher></b:Publisher><b:JournalName>after empty</b:JournalName>',
    ),
  `<b:Sources xmlns:b="${SOURCES_NS}"/>`,
  '',
]

const SOURCE_ARGS: SourceInfo[] = [
  {
    tag: 'a',
    type: 'Book',
    author: 'Kim, Min',
    title: 'T',
    year: '2024',
    publisher: 'P',
    url: 'https://u',
  },
  { tag: 'b', type: 'Misc', author: '', title: 'Only title', year: '' },
  { tag: 'c', type: 'Misc', author: '', title: '', year: '1999' },
  { tag: 'd', type: 'Report', author: 'Org', title: '', year: '', publisher: '', url: '' },
  { tag: 'e', type: 'Book', author: 'A', title: 'B', year: '', url: 'u' },
  { tag: 'f', type: 'Book', author: '', title: '', year: '' },
]

const packageInput = (...parts: Array<[string, string]>): Input => ({ args: { parts } })

const SOURCES_PACKAGES: Input[] = [
  packageInput(),
  packageInput(['customXml/item1.xml', '<root/>'], ['customXml/item2.xml', SOURCES_FULL]),
  packageInput(
    ['customXml/item10.xml', `<b:Sources xmlns:b="${SOURCES_NS}"/>`],
    ['customXml/item2.xml', SOURCES_FULL],
  ),
  packageInput(
    ['customXml/item.xml', SOURCES_FULL],
    ['customXml/itemProps1.xml', SOURCES_FULL],
    ['customXml/item3.xml', '<Sources/>'],
    ['customXml/item4.xml', `<x xmlns="${SOURCES_NS}"/>`],
    ['word/customXml/item5.xml', SOURCES_FULL],
  ),
]

const DOC_PROPS_PACKAGES: Input[] = [
  packageInput(),
  packageInput(
    [CORE_PROPERTIES_PATH, CORE_FULL],
    [APP_PROPERTIES_PATH, APP_FULL],
    [CUSTOM_PROPERTIES_PATH, CUSTOM_BUILT[0]!],
  ),
  packageInput([CUSTOM_PROPERTIES_PATH, CUSTOM_BUILT[1]!]),
  packageInput([CORE_PROPERTIES_PATH, CORE_BUILT[2]!]),
  packageInput([CUSTOM_PROPERTIES_PATH, ZOTERO_BUILT[0]!]),
  packageInput([CUSTOM_PROPERTIES_PATH, ZOTERO_BUILT[1]!]),
]

/** Records hashed by `hashProtectionPassword` with the salt of their `saltBytes`. */
const SECRET_2: Record_ = {
  hash: '8ksaeikUOI/cDAyxYyW3GT/YUGNQl1ivK55Lzsjq/qAi/Ondvpjq2jxtgU0NR09iybGPYCtPaXSx5CHH+1T4nQ==',
  salt: 'AAECAwQFBgcICQoLDA0ODw==',
  spinCount: 2,
  algorithmSid: 14,
}
const SECRET_0: Record_ = {
  hash: '9AWDP7eWN6QgOFpcIAEFDxFYMKGgZU16gvgB2StrRH40OOMhRw/0haHRO3LMSQGuwrGrnDAJcapvF4fIqe+4LQ==',
  salt: 'AAIEBggKDA4QEhQWGBocHg==',
  spinCount: 0,
  algorithmSid: 14,
}
const HANGUL_1000: Record_ = {
  hash: '6mbN0TIb59F+klEJvhYwy+797h2UGYjx7xAj0lTL6CO/ZUHMgAI3nDCh7UgrSPPvdUF4xsP/W9Ku8IWiF0aYJg==',
  salt: 'AAMGCQwPEhUYGx4hJCcqLQ==',
  spinCount: 1000,
  algorithmSid: 14,
}
const EMPTY_DEFAULT: Record_ = {
  hash: 'vGja4hhP4rYVHdfKkD1Smm4b5Mhs+tMVc4vYUFsAlqFqGHcEj0g2PgWcmkai9C2kgkV6m6kLQYggsojUvwVLMw==',
  salt: 'AAQIDBAUGBwgJCgsMDQ4PA==',
}

/**
 * Records with a spin count that is a string where the TypeScript type says
 * number: verification handles both.
 */
const looseSpin = (record: Record_, spinCount: unknown): Record<string, unknown> => ({
  ...record,
  spinCount,
})

const verify = (password: string, protection: Record<string, unknown>): Input => ({
  text: password,
  args: { protection },
})

// an empty password keeps a default-count input out of the mutation seeds:
// a digest loop of 100000 takes seconds in the TypeScript
const VERIFY_BUILT: Input[] = [
  verify('secret', { ...SECRET_2 }),
  verify('Secret', { ...SECRET_2 }),
  verify('secret', { ...SECRET_0 }),
  verify('비밀😀', { ...HANGUL_1000 }),
  verify('비밀', { ...HANGUL_1000 }),
  verify('', { ...EMPTY_DEFAULT }),
  verify('', { ...EMPTY_DEFAULT, spinCount: '' }),
  verify('secret', {}),
  verify('secret', { ...SECRET_2, hash: '' }),
  verify('secret', { ...SECRET_2, algorithmSid: 4 }),
  verify('secret', { ...SECRET_2, algorithmSid: null }),
  verify('secret', { ...SECRET_2, salt: undefined }),
  verify('secret', { ...SECRET_2, salt: '' }),
  verify('secret', { ...SECRET_2, salt: '!!!' }),
  verify('secret', { ...SECRET_2, salt: 'Q' }),
  verify('secret', { ...SECRET_2, salt: ' AAEC AwQF\nBgcICQoLDA0ODw ' }),
  verify('secret', { ...SECRET_2, salt: 'AAECAwQFBgcICQoLDA0ODw=' }),
  verify('secret', { ...SECRET_2, salt: 'AAECAwQFBgcICQoLDA0ODw===' }),
  verify('secret', { ...SECRET_2, salt: 'AAECAwQFBgcICQoLDA0ODx==' }),
  verify('secret', { ...SECRET_2, salt: 'AA=ECAwQFBgcICQoLDA0ODw' }),
  verify('secret', looseSpin(SECRET_2, '2')),
  verify('secret', looseSpin(SECRET_2, ' 2 ')),
  verify('secret', looseSpin(SECRET_2, '0x2')),
  verify('secret', looseSpin(SECRET_2, 'abc')),
  verify('secret', looseSpin(SECRET_2, -1)),
  verify('secret', looseSpin(SECRET_2, 1.5)),
  verify('secret', looseSpin(SECRET_2, true)),
  verify('secret', looseSpin(SECRET_2, 2_000_000)),
  verify('secret', looseSpin(SECRET_2, '1e7')),
  verify('secret', looseSpin(SECRET_2, 1000)),
]

const hash = (password: string, saltBytes: number[], spinCount?: unknown): Input => ({
  text: password,
  args: spinCount === undefined ? { saltBytes } : { saltBytes, spinCount },
})

const bytes = (fill: number): number[] => Array.from({ length: 16 }, (_, i) => (i * fill) & 255)

const HASH_BUILT: Input[] = [
  hash('secret', bytes(1), 2),
  hash('secret', bytes(2), 0),
  hash('비밀😀', bytes(3), 1000),
  hash('', bytes(4)),
  hash('pw', bytes(5), 1),
  hash('pw', bytes(5), '3'),
  hash('pw', bytes(5), -1),
  hash('pw', bytes(5), 'x'),
  hash('pw', bytes(5), 2_000_000.5),
  hash('pw', bytes(6), ' 0 '),
]

/** `crypto.getRandomValues` that gives these bytes: the salt `hashProtectionPassword` draws. */
function fixedSalt(salt: number[]) {
  return <T extends ArrayBufferView | null>(array: T): T => {
    if (array instanceof Uint8Array) array.set(salt)
    return array
  }
}

async function hashWithSalt(password: string, salt: number[], spinCount: unknown) {
  const random = globalThis.crypto.getRandomValues
  globalThis.crypto.getRandomValues = fixedSalt(salt)
  try {
    return await hashProtectionPassword(password, spinCount as number | undefined)
  } finally {
    globalThis.crypto.getRandomValues = random
  }
}

export const DOCPROPS: CallSpec[] = [
  {
    fn: 'docprops.constants',
    call: (_text, args) => {
      const name = String(args.name)
      if (!Object.hasOwn(CONSTANTS, name)) throw new Error(`no constant ${name}`)
      return CONSTANTS[name]
    },
    built: [...Object.keys(CONSTANTS), 'nothing'].map((name) => ({ args: { name } })),
    mutation: 'none',
  },
  {
    fn: 'docprops.parseCorePropertiesXml',
    call: (text) => parseCorePropertiesXml(text),
    fromDocument: part(CORE_PROPERTIES_PATH),
    built: CORE_BUILT.map((text) => ({ text })),
  },
  {
    fn: 'docprops.parseAppPropertiesXml',
    call: (text) => parseAppPropertiesXml(text),
    fromDocument: part(APP_PROPERTIES_PATH),
    built: APP_BUILT.map((text) => ({ text })),
  },
  {
    fn: 'docprops.parseCustomPropertiesXml',
    call: (text) => parseCustomPropertiesXml(text),
    fromDocument: part(CUSTOM_PROPERTIES_PATH),
    built: [...CUSTOM_BUILT, ...ZOTERO_BUILT].map((text) => ({ text })),
  },
  {
    fn: 'docprops.parseCustomPropertyTypesXml',
    call: (text) => parseCustomPropertyTypesXml(text),
    fromDocument: part(CUSTOM_PROPERTIES_PATH),
    built: [...CUSTOM_BUILT, ...ZOTERO_BUILT].map((text) => ({ text })),
  },
  {
    fn: 'docprops.readDocumentProperties',
    call: (_text, args) => readDocumentProperties(zipOf(args.parts)),
    fromDocument: packageOf('docProps/'),
    built: DOC_PROPS_PACKAGES,
    mutation: 'none',
  },
  {
    fn: 'docprops.parseZoteroDocumentDataXml',
    call: (text) => parseZoteroDocumentDataXml(text),
    fromDocument: part(CUSTOM_PROPERTIES_PATH),
    built: [...ZOTERO_BUILT, ...CUSTOM_BUILT].map((text) => ({ text })),
  },
  {
    fn: 'docprops.readZoteroDocumentData',
    call: (_text, args) => readZoteroDocumentData(zipOf(args.parts)),
    fromDocument: packageOf('docProps/'),
    built: DOC_PROPS_PACKAGES,
    mutation: 'none',
  },
  {
    fn: 'docprops.decodeXmlText',
    call: (text) => decodeXmlText(text),
    built: [
      ...[
        '&#x41;&#X42;&#x1f600;&#128512;&#xD83D;&#56832;&#x26;#67;',
        '&#x110000;&#1114112;&#99999999999999999999;&#x;&#12a;&amp;amp;&lt;&gt;&quot;&apos;',
        'plain',
        '',
      ].map((text) => ({ text })),
    ],
  },
  {
    fn: 'docprops.attrValue',
    call: (text, args) => attrValue(text, String(args.name)),
    built: [
      ...['name', 'pid', 'fmtid', 'n.me', '', 'x(', 'name\\b'].map((name) => ({
        text: `<property ${FMTID} pid='5' xname="no" name="a&amp;b"><vt:lpwstr name="inner">v</vt:lpwstr></property>`,
        args: { name },
      })),
      { text: '<p name=unquoted/>', args: { name: 'name' } },
    ],
  },
  {
    fn: 'docprops.propertyText',
    call: (text) => propertyText(text),
    built: [
      property('A', '<vt:lpwstr>a &amp; b</vt:lpwstr>'),
      property('B', '<lpwstr x="1">no prefix</lpwstr>'),
      property('C', '<vt:i4>3</vt:i4>'),
      property('D', '<vt:lpwstr>open</vt:lpstr>'),
    ].map((text) => ({ text })),
  },
  {
    fn: 'docprops.findSourcesPart',
    call: (_text, args) => findSourcesPart(zipOf(args.parts)),
    fromDocument: packageOf('customXml/'),
    built: SOURCES_PACKAGES,
    mutation: 'none',
  },
  {
    fn: 'docprops.parseSourcesXml',
    call: (text) => parseSourcesXml(text),
    fromDocument: (parts) => sourcesParts(parts).map((text) => ({ text })),
    built: SOURCES_BUILT.map((text) => ({ text })),
  },
  {
    fn: 'docprops.citationText',
    call: (_text, args) => citationText(args.source as SourceInfo),
    fromDocument: (parts) =>
      sourcesParts(parts).flatMap((text) =>
        parseSourcesXml(text).map((info) => ({ args: { source: info } })),
      ),
    built: [...SOURCE_ARGS.map((info) => ({ args: { source: info } })), { args: {} }],
    mutation: 'none',
  },
  {
    fn: 'docprops.bibliographyLine',
    call: (_text, args) => bibliographyLine(args.source as SourceInfo),
    fromDocument: (parts) =>
      sourcesParts(parts).flatMap((text) =>
        parseSourcesXml(text).map((info) => ({ args: { source: info } })),
      ),
    built: [...SOURCE_ARGS.map((info) => ({ args: { source: info } })), { args: {} }],
    mutation: 'none',
  },
  {
    fn: 'docprops.resolveSpinCount',
    // the text stands for the raw value where the arguments carry none
    call: (text, args) => resolveSpinCount('raw' in args ? args.raw : text),
    built: [
      ...['', '  12 ', '1.5', '-1', 'abc', '0x10', '1e3', '2000000', ' ', 'Infinity', '0'].map(
        (text) => ({ text }),
      ),
      ...[null, 5, -0, 1.5, true, {}, '', 'Infinity', ' ', 1_000_000, 1_000_001].map((raw) => ({
        args: { raw },
      })),
    ],
  },
  {
    fn: 'docprops.hashProtectionPassword',
    call: (text, args) => hashWithSalt(text, args.saltBytes as number[], args.spinCount),
    built: HASH_BUILT,
  },
  {
    fn: 'docprops.verifyProtectionPassword',
    call: (text, args) => verifyProtectionPassword(text, args.protection as Record_),
    built: VERIFY_BUILT,
  },
]
