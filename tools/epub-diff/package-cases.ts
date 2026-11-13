import {
  packagePathFromContainer,
  parsePackage,
  scanEncryption,
} from '../../packages/epub-engine/src/package'
import { navTocEntries, ncxEntries } from '../../packages/epub-engine/src/toc'
import {
  parseHtml,
  parseXml,
  type XmlAttribute,
  type XmlElement,
  type XmlNode,
} from '../../packages/epub-engine/src/xml'
import type { Input, Spec } from '../fileparse-diff/spec'

// The trees are built with the TypeScript parsers when the cases are made;
// both engines then read the same tree. Neither parser is under comparison here.

const OPF_NS = 'http://www.idpf.org/2007/opf'
const DC_NS = 'http://purl.org/dc/elements/1.1/'
const OPS_NS = 'http://www.idpf.org/2007/ops'
const XHTML_NS = 'http://www.w3.org/1999/xhtml'
const NCX_NS = 'http://www.daisy.org/z3986/2005/ncx/'
const CONTAINER_NS = 'urn:oasis:names:tc:opendocument:xmlns:container'
const ENC_NS = 'http://www.w3.org/2001/04/xmlenc#'
const DS_NS = 'http://www.w3.org/2000/09/xmldsig#'
const OPF_TYPE = 'application/oebps-package+xml'
const IDPF = 'http://www.idpf.org/2008/embedding'
const ADOBE = 'http://ns.adobe.com/pdf/enc#RC'
const AES = 'http://www.w3.org/2001/04/xmlenc#aes128-cbc'
const RSA = 'http://www.w3.org/2001/04/xmlenc#rsa-1_5'
const XML_DECL = '<?xml version="1.0" encoding="UTF-8"?>'

const esc = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')
const at = (name: string, value: string, uri: string | null = null): XmlAttribute => ({
  name,
  local: name.slice(name.indexOf(':') + 1),
  uri,
  value,
})
const node = (
  name: string,
  attributes: XmlAttribute[],
  children: XmlNode[],
  uri: string | null = null,
): XmlElement => ({ name, local: name.slice(name.indexOf(':') + 1), uri, attributes, children })
const tree = (input: Input): XmlElement => input.args!.tree as XmlElement
const arg = (input: Input, key: string): string => input.args![key] as string

/** Labels and arguments both unique: a repeated input adds a check that tests nothing. */
function distinct(fn: string, inputs: Input[]): Input[] {
  const labels = new Set<string>()
  const shapes = new Set<string>()
  for (const { label, args } of inputs) {
    const shape = JSON.stringify(args)
    if (labels.has(label) || shapes.has(shape))
      throw new Error(`${fn}: built input ${label} repeats another`)
    labels.add(label)
    shapes.add(shape)
  }
  return inputs
}

/** `Archive.find` of open.ts over a list of file entry names. The paths come from `resolveHref`, already normalized. */
function finder(entries: readonly string[]): (path: string) => string | null {
  const byLowerCase = new Map<string, string>()
  for (const name of entries) {
    const lower = name.toLowerCase()
    if (!byLowerCase.has(lower)) byLowerCase.set(lower, name)
  }
  return (path) => (entries.includes(path) ? path : (byLowerCase.get(path.toLowerCase()) ?? null))
}

const rootfile = (fullPath: string, mediaType = OPF_TYPE): string =>
  `<rootfile full-path="${esc(fullPath)}" media-type="${esc(mediaType)}"/>`
const container = (rootfiles: string): string =>
  `${XML_DECL}<container version="1.0" xmlns="${CONTAINER_NS}"><rootfiles>${rootfiles}</rootfiles></container>`

function containerCases(): Input[] {
  const texts: Array<[string, string]> = [
    ['standard', container(rootfile('OEBPS/content.opf'))],
    [
      'OPF media type wins over the first',
      container(rootfile('first.opf', 'application/xhtml+xml') + rootfile('OPS/package.opf')),
    ],
    [
      'first rootfile when none has the OPF type',
      container(rootfile('a.opf', 'text/xml') + rootfile('b.opf', 'application/xml')),
    ],
    [
      'padded media type',
      container(rootfile('other.opf', 'text/plain') + rootfile('padded.opf', `  ${OPF_TYPE} `)),
    ],
    [
      'media type in another case',
      container(
        rootfile('lower.opf', 'text/plain') +
          rootfile('upper.opf', 'Application/OEBPS-Package+XML'),
      ),
    ],
    [
      'rootfile without full-path skipped',
      container(`<rootfile media-type="${OPF_TYPE}"/>${rootfile('second.opf', 'text/plain')}`),
    ],
    ['empty full-path', container(rootfile(''))],
    ['no rootfile', container('')],
    [
      'rootfile outside rootfiles',
      `<container xmlns="${CONTAINER_NS}"><rootfile full-path="top.opf"/></container>`,
    ],
    ['URL scheme', container(rootfile('https://example.com/content.opf'))],
    ['protocol-relative', container(rootfile('//host/content.opf'))],
    ['drive letter', container(rootfile('C:/book/content.opf'))],
    ['dot', container(rootfile('.'))],
    ['white space only', container(rootfile('   '))],
    ['dot dot above the root', container(rootfile('../../OEBPS/./content.opf'))],
    ['leading slash', container(rootfile('/OPS//content.opf'))],
    ['percent-encoded', container(rootfile('My%20Book/content%2Eopf'))],
    ['malformed percent escape', container(rootfile('bad%E0%A4%A.opf'))],
    ['query and fragment', container(rootfile('content.opf?v=2#top'))],
    ['fragment only', container(rootfile('#frag'))],
    ['backslash', container(rootfile('OEBPS\\content.opf'))],
    ['non-ASCII', container(rootfile('ÉPUB/内容.opf'))],
    [
      'prefixed elements',
      `<c:container xmlns:c="${CONTAINER_NS}"><c:rootfiles><c:rootfile full-path="pref.opf" media-type="${OPF_TYPE}"/></c:rootfiles></c:container>`,
    ],
    [
      'capitalized Rootfile',
      `<container><Rootfile full-path="cap.opf" media-type="${OPF_TYPE}"/></container>`,
    ],
    [
      'full-path in a namespace',
      `<container xmlns:x="urn:x"><rootfile x:full-path="ns.opf" media-type="${OPF_TYPE}"/></container>`,
    ],
    [
      'full-path with an undeclared prefix',
      `<container><rootfile x:full-path="undeclared.opf"/></container>`,
    ],
    [
      'nested rootfiles in document order',
      `<container><rootfile full-path="outer.opf" media-type="text/plain"><rootfile full-path="inner.opf" media-type="text/plain"/></rootfile></container>`,
    ],
    [
      'nested rootfile of the OPF type',
      `<container><rootfile full-path="outer.opf" media-type="text/plain"><rootfile full-path="inner.opf" media-type="${OPF_TYPE}"/></rootfile></container>`,
    ],
  ]
  return [
    ...texts.map(([label, text]) => ({
      label: `container ${label}`,
      args: { tree: parseXml(text) },
    })),
    {
      label: 'container root is the rootfile',
      args: { tree: node('rootfile', [at('full-path', 'hand.opf')], []) },
    },
    {
      label: 'container full-path attribute with a URI',
      args: { tree: node('rootfile', [at('full-path', 'hand.opf', 'urn:x')], []) },
    },
  ]
}

const encryption = (body: string): string =>
  `${XML_DECL}<encryption xmlns="${CONTAINER_NS}" xmlns:enc="${ENC_NS}" xmlns:ds="${DS_NS}">${body}</encryption>`
const reference = (uri: string | null): string =>
  uri === null ? '<enc:CipherReference/>' : `<enc:CipherReference URI="${esc(uri)}"/>`
const data = (algorithm: string | null, uri: string | null): string =>
  `<enc:EncryptedData>${algorithm === null ? '' : `<enc:EncryptionMethod Algorithm="${esc(algorithm)}"/>`}` +
  `<enc:CipherData>${reference(uri)}</enc:CipherData></enc:EncryptedData>`

function encryptionCases(): Input[] {
  const texts: Array<[string, string]> = [
    ['empty', encryption('')],
    ['IDPF font', encryption(data(IDPF, 'OEBPS/fonts/a.otf'))],
    ['Adobe font', encryption(data(ADOBE, 'fonts/b.ttf'))],
    ['padded algorithm', encryption(data(` ${IDPF}  `, 'c.otf'))],
    ['byte order mark before the algorithm', encryption(data(`\uFEFF${IDPF}`, 'k.otf'))],
    ['next line after the algorithm', encryption(data(`${IDPF}\u0085`, 'l.otf'))],
    ['AES data', encryption(data(AES, 'OEBPS/ch1.xhtml'))],
    [
      'encrypted key first',
      encryption(
        `<enc:EncryptedKey><enc:EncryptionMethod Algorithm="${RSA}"/></enc:EncryptedKey>${data(IDPF, 'x.otf')}`,
      ),
    ],
    ['data without a method', encryption(data(null, 'd.otf'))],
    ['empty algorithm', encryption(data('', 'e.otf'))],
    ['method without Algorithm outside data', encryption('<enc:EncryptionMethod/>')],
    ['blank Algorithm outside data', encryption('<enc:EncryptionMethod Algorithm="  "/>')],
    ['URI climbing out of META-INF', encryption(data(IDPF, '../OEBPS/fonts/f.otf'))],
    ['URI with a scheme', encryption(data(IDPF, 'http://example.com/f.otf'))],
    ['CipherReference without URI', encryption(data(IDPF, null))],
    ['empty URI', encryption(data(IDPF, ''))],
    ['percent-encoded URI', encryption(data(IDPF, 'fonts/My%20Font.otf'))],
    ['URI with a fragment', encryption(data(IDPF, 'fonts/g.otf#x'))],
    [
      'fonts in document order',
      encryption(data(IDPF, '1.otf') + data(ADOBE, '2.otf') + data(IDPF, '3.otf')),
    ],
    ['font then DRM', encryption(data(IDPF, '1.otf') + data(AES, 'ch.xhtml'))],
    [
      'second method after a font method',
      encryption(
        `<enc:EncryptedData><enc:EncryptionMethod Algorithm="${IDPF}"/><enc:EncryptionMethod Algorithm="${AES}"/><enc:CipherData>${reference('h.otf')}</enc:CipherData></enc:EncryptedData>`,
      ),
    ],
    [
      'method below a child of the data',
      encryption(
        `<enc:EncryptedData><ds:KeyInfo><enc:EncryptionMethod Algorithm="${IDPF}"/></ds:KeyInfo><enc:CipherData>${reference('m.otf')}</enc:CipherData></enc:EncryptedData>`,
      ),
    ],
    [
      'Algorithm in a namespace',
      encryption(
        `<enc:EncryptedData><enc:EncryptionMethod ds:Algorithm="${IDPF}"/><enc:CipherData>${reference('n.otf')}</enc:CipherData></enc:EncryptedData>`,
      ),
    ],
    [
      'lower-case element names',
      encryption(`<encrypteddata><encryptionmethod Algorithm="${AES}"/></encrypteddata>`),
    ],
    [
      'default namespace',
      encryption(
        `<EncryptedData xmlns="${ENC_NS}"><EncryptionMethod Algorithm="${IDPF}"/><CipherData><CipherReference URI="i.otf"/></CipherData></EncryptedData>`,
      ),
    ],
    [
      'two references in one data',
      encryption(
        `<enc:EncryptedData><enc:EncryptionMethod Algorithm="${ADOBE}"/><enc:CipherData>${reference('p.otf')}${reference('q.otf')}</enc:CipherData></enc:EncryptedData>`,
      ),
    ],
    [
      'nested data counted twice',
      encryption(
        `<enc:EncryptedData><enc:EncryptionMethod Algorithm="${IDPF}"/><enc:EncryptedData><enc:EncryptionMethod Algorithm="${ADOBE}"/><enc:CipherData>${reference('j.otf')}</enc:CipherData></enc:EncryptedData></enc:EncryptedData>`,
      ),
    ],
  ]
  return texts.map(([label, text]) => ({
    label: `encryption ${label}`,
    args: { tree: parseXml(text) },
  }))
}

const META_MIN = '<metadata><dc:title>Book</dc:title></metadata>'
const MANIFEST_MIN =
  '<manifest><item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/></manifest>'
const SPINE_MIN = '<spine><itemref idref="c1"/></spine>'
const opf = (attributes: string, body: string): string =>
  `${XML_DECL}<package xmlns="${OPF_NS}" xmlns:dc="${DC_NS}" ${attributes}>${body}</package>`
const withMetadata = (metadata: string, attributes = 'version="3.0"'): string =>
  opf(attributes, `<metadata>${metadata}</metadata>${MANIFEST_MIN}${SPINE_MIN}`)
const withManifest = (items: string): string =>
  opf('version="3.0"', `${META_MIN}<manifest>${items}</manifest>${SPINE_MIN}`)
const withSpine = (spineAttributes: string, itemrefs: string): string =>
  opf('version="3.0"', `${META_MIN}${MANIFEST_MIN}<spine ${spineAttributes}>${itemrefs}</spine>`)

const BOOK_ENTRIES = [
  'mimetype',
  'META-INF/container.xml',
  'OEBPS/content.opf',
  'OEBPS/nav.xhtml',
  'OEBPS/toc.ncx',
  'OEBPS/Text/ch1.xhtml',
  'OEBPS/Text/ch2.xhtml',
  'OEBPS/Images/cover.jpg',
  'OEBPS/ch1.xhtml',
]

function packageCases(): Input[] {
  const cases: Array<{ label: string; text: string; opfPath?: string; entries?: string[] }> = [
    {
      label: 'EPUB 3 book',
      text: opf(
        'version="3.0" unique-identifier="uid" xml:lang="en"',
        '<metadata><dc:identifier id="uid">urn:uuid:12345678-1234-1234-1234-123456789abc</dc:identifier>' +
          '<dc:title id="t1">Main</dc:title><dc:title id="t2">Sub</dc:title><dc:creator>A. Author</dc:creator><dc:creator>B. Author</dc:creator>' +
          '<dc:language>en</dc:language><dc:language>ko</dc:language><meta property="dcterms:modified">2026-01-01T00:00:00Z</meta>' +
          '<meta refines="#t2" property="title-type">subtitle</meta><meta property="rendition:layout">pre-paginated</meta></metadata>' +
          '<manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>' +
          '<item id="c1" href="Text/ch1.xhtml" media-type="application/xhtml+xml"/>' +
          '<item id="c2" href="Text/ch2.xhtml" media-type="application/xhtml+xml" properties="scripted svg"/>' +
          '<item id="cover" href="Images/cover.jpg" media-type="image/jpeg" properties="cover-image"/></manifest>' +
          '<spine page-progression-direction="rtl"><itemref idref="c1"/><itemref idref="c2" linear="no" properties="page-spread-right rendition:layout-reflowable"/></spine>',
      ),
    },
    {
      label: 'EPUB 2 book with an NCX',
      text:
        `${XML_DECL}<package xmlns="${OPF_NS}" xmlns:dc="${DC_NS}" xmlns:opf="${OPF_NS}" version="2.0" unique-identifier="BookId">` +
        '<metadata><dc:title>Two</dc:title><dc:identifier id="BookId" opf:scheme="ISBN">9780000000000</dc:identifier>' +
        '<meta name="cover" content="cover"/><meta name="primary-writing-mode" content=" horizontal-rl "/></metadata>' +
        '<manifest><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/><item id="c1" href="Text/ch1.xhtml" media-type="application/xhtml+xml"/></manifest>' +
        '<spine toc="ncx"><itemref idref="c1"/></spine></package>',
    },
    {
      label: 'opf:scheme with an undeclared prefix',
      text: withMetadata(
        '<dc:identifier id="u" opf:scheme="UUID">urn:uuid:x</dc:identifier>',
        'version="3.0" unique-identifier="u"',
      ),
    },
    {
      label: 'plain scheme attribute',
      text: withMetadata('<dc:identifier scheme="DOI">10.1/x</dc:identifier>'),
    },
    {
      label: 'scheme in the OPF namespace under another prefix',
      text: withMetadata(`<dc:identifier xmlns:o="${OPF_NS}" o:scheme="ISBN">978</dc:identifier>`),
    },
    {
      label: 'root is a container',
      text: `<container xmlns="${CONTAINER_NS}"><manifest/><spine/></container>`,
    },
    {
      label: 'Package in capitals',
      text: `<Package xmlns="${OPF_NS}">${MANIFEST_MIN}${SPINE_MIN}</Package>`,
      opfPath: 'content.opf',
    },
    { label: 'no manifest', text: opf('version="3.0"', META_MIN + SPINE_MIN) },
    {
      label: 'no spine',
      text: opf('version="3.0"', META_MIN + MANIFEST_MIN),
      opfPath: 'a/b/package.opf',
    },
    { label: 'neither manifest nor spine', text: opf('version="3.0"', META_MIN) },
    {
      label: 'manifest inside metadata',
      text: opf('version="3.0"', `<metadata>${MANIFEST_MIN}</metadata>${SPINE_MIN}`),
    },
    {
      label: 'Manifest in capitals',
      text: opf(
        'version="3.0"',
        `<Manifest><item id="c1" href="ch1.xhtml"/></Manifest>${SPINE_MIN}`,
      ),
    },
    {
      label: 'prefixed package elements',
      text:
        `<opf:package xmlns:opf="${OPF_NS}" xmlns:dc="${DC_NS}" version="3.0"><opf:metadata><dc:title>P</dc:title><opf:meta property="rendition:layout">pre-paginated</opf:meta></opf:metadata>` +
        '<opf:manifest><opf:item id="a" href="a.xhtml" media-type="application/xhtml+xml"/></opf:manifest><opf:spine><opf:itemref idref="a"/></opf:spine></opf:package>',
    },
    { label: 'no metadata', text: opf('version="3.0"', MANIFEST_MIN + SPINE_MIN) },
    {
      label: 'empty metadata',
      text: opf('version="3.0"', `<metadata/>${MANIFEST_MIN}${SPINE_MIN}`),
    },
    {
      label: 'main title by refines',
      text: withMetadata(
        '<dc:title id="t1">Alpha</dc:title><dc:title id="t2">Beta</dc:title><meta refines="#t2" property="title-type"> main </meta>',
      ),
    },
    {
      label: 'main title refines without a hash',
      text: withMetadata(
        '<dc:title id="t1">Alpha</dc:title><dc:title id="t2">Beta</dc:title><meta refines="t2" property="title-type">main</meta>',
      ),
    },
    {
      label: 'main title refines padded',
      text: withMetadata(
        '<dc:title id="t1">Alpha</dc:title><dc:title id="t2">Beta</dc:title><meta refines="  #t2 " property="title-type">main</meta>',
      ),
    },
    {
      label: 'main title pointing nowhere',
      text: withMetadata(
        '<dc:title id="t1">Alpha</dc:title><dc:title id="t2">Beta</dc:title><meta refines="#t9" property="title-type">main</meta>',
      ),
    },
    {
      label: 'main title without refines',
      text: withMetadata(
        '<dc:title>Alpha</dc:title><dc:title id="t2">Beta</dc:title><meta property="title-type">main</meta>',
      ),
    },
    {
      label: 'title type Main in capitals',
      text: withMetadata(
        '<dc:title id="t1">Alpha</dc:title><dc:title id="t2">Beta</dc:title><meta refines="#t2" property="title-type">Main</meta>',
      ),
    },
    {
      label: 'Meta in capitals is no meta',
      text: withMetadata(
        '<dc:title id="t1">Alpha</dc:title><dc:title id="t2">Beta</dc:title><Meta refines="#t2" property="title-type">main</Meta>',
      ),
    },
    {
      label: 'undeclared and capitalized dc prefixes',
      text:
        `<package xmlns="${OPF_NS}" version="3.0"><metadata><dc:title>Undeclared</dc:title><DC:Creator>Caps</DC:Creator>` +
        `<d:language xmlns:d="${DC_NS}">fr</d:language><title>Not DC</title><identifier xmlns="${DC_NS}">default-ns</identifier>` +
        `<x:language xmlns:x="urn:other">no</x:language><dcterms:title xmlns:dcterms="http://purl.org/dc/terms/">terms</dcterms:title></metadata>${MANIFEST_MIN}${SPINE_MIN}</package>`,
    },
    {
      label: 'EPUB 2 legacy metadata wrappers',
      text: withMetadata(
        '<dc-metadata><dc:Title>Legacy</dc:Title><dc:Creator>X</dc:Creator></dc-metadata><x-metadata><meta name="primary-writing-mode" content="vertical-rl"/></x-metadata>',
        'version="2.0"',
      ),
    },
    {
      label: 'mixed content in titles',
      text: withMetadata(
        '<dc:title>  A <span>B</span> &amp; <![CDATA[C]]>  </dc:title><dc:creator>&#160;Name&#xFEFF;</dc:creator><dc:language>en&#x85;</dc:language>',
      ),
    },
    {
      label: 'layout padded',
      text: withMetadata('<meta property="rendition:layout">\n  pre-paginated\n</meta>'),
    },
    {
      label: 'layout refines first then global',
      text: withMetadata(
        '<meta property="rendition:layout" refines="#c1">pre-paginated</meta><meta property="rendition:layout">reflowable</meta>',
      ),
    },
    {
      label: 'layout refines only',
      text: withMetadata('<meta property="rendition:layout" refines="#c1">pre-paginated</meta>'),
    },
    {
      label: 'layout unknown value',
      text: withMetadata('<meta property="rendition:layout">fixed</meta>'),
    },
    {
      label: 'layout with a no-break space',
      text: withMetadata('<meta property="rendition:layout">pre-paginated&#160;</meta>'),
    },
    {
      label: 'layout global after a refined one',
      text: withMetadata(
        '<meta property="rendition:layout" refines="#c1">reflowable</meta><meta property="rendition:layout">pre-paginated</meta>',
      ),
    },
    {
      label: 'writing mode without content',
      text: withMetadata(
        '<meta name="primary-writing-mode"/><meta name="primary-writing-mode" content="vertical-rl"/>',
      ),
    },
    {
      label: 'writing mode empty content',
      text: withMetadata('<meta name="primary-writing-mode" content=""/>'),
    },
    {
      label: 'unique identifier missing',
      text: withMetadata(
        '<dc:identifier id="a">A</dc:identifier>',
        'version="3.0" unique-identifier="b"',
      ),
    },
    {
      label: 'unique identifier padded',
      text: withMetadata(
        '<dc:identifier id="a">A</dc:identifier><dc:identifier id="b"> B </dc:identifier>',
        'version="3.0" unique-identifier=" b "',
      ),
    },
    {
      label: 'unique identifier empty',
      text: withMetadata(
        '<dc:identifier id="">A</dc:identifier>',
        'version="3.0" unique-identifier=""',
      ),
    },
    {
      label: 'unique identifier repeated id',
      text: withMetadata(
        '<dc:identifier id="a">first</dc:identifier><dc:identifier id="a">second</dc:identifier>',
        'version="3.0" unique-identifier="a"',
      ),
    },
    {
      label: 'unique identifier in another case',
      text: withMetadata(
        '<dc:identifier id="UID">A</dc:identifier>',
        'version="3.0" unique-identifier="uid"',
      ),
    },
    {
      label: 'unique identifier in a namespace',
      text: withMetadata(
        '<dc:identifier id="a">A</dc:identifier>',
        'version="3.0" xmlns:x="urn:x" x:unique-identifier="a"',
      ),
    },
    {
      label: 'manifest hrefs',
      entries: [...BOOK_ENTRIES, 'OEBPS/Text/Ch 1.xhtml', 'outside.xhtml'],
      text: withManifest(
        '<item id="nohref" media-type="text/css"/><item id="remote" href="https://cdn.example/x.css" media-type=" text/css "/>' +
          '<item id="up" href="../outside.xhtml" media-type="application/xhtml+xml"/><item id="missing" href="../missing.xhtml"/>' +
          '<item id="pct" href="Text/Ch%201.xhtml" media-type="application/xhtml+xml"/><item href="ch1.xhtml" media-type="application/xhtml+xml"/>' +
          '<item id="self" href=""/><item id="frag" href="#frag"/><item id="query" href="?q"/><item id="spaced" href=" Text/ch2.xhtml "/>' +
          '<item id="abs" href="/OEBPS/Images/cover.jpg"/><div><item id="nested" href="nested.xhtml"/></div><Item id="caps" href="caps.xhtml"/>',
      ),
    },
    {
      label: 'manifest properties',
      text: withManifest(
        '<item id="a" href="a.xhtml" properties="nav\n  scripted  "/><item id="b" href="b.xhtml" properties="a&#160;b"/><item id="c" href="c.xhtml" properties=""/>',
      ),
    },
    {
      label: 'manifest case variants',
      entries: [
        'OEBPS/text/CH2.xhtml',
        'OEBPS/Text/ch2.XHTML',
        'OEBPS/TEXT/CH3.XHTML',
        'OEBPS/Text/ch3.xhtml',
        'OEBPS/Ä.xhtml',
        'OEBPS/\u212A.xhtml',
        'OEBPS/οδος.xhtml',
      ],
      text: withManifest(
        '<item id="v2" href="Text/ch2.xhtml"/><item id="v3" href="Text/ch3.xhtml"/><item id="umlaut" href="ä.xhtml"/><item id="kelvin" href="k.xhtml"/><item id="sigma" href="ΟΔΟΣ.xhtml"/><item id="none" href="none.xhtml"/>',
      ),
    },
    {
      label: 'manifest case variants, no entries',
      entries: [],
      text: withManifest(
        '<item id="v2" href="Text/ch2.xhtml"/><item id="v3" href="Text/ch3.xhtml"/>',
      ),
    },
    {
      label: 'spine itemrefs',
      text: withSpine(
        '',
        '<itemref idref=" c1 "/><itemref idref="\uFEFFc2" linear=" no "/><itemref idref="c3\u0085" linear="NO"/><itemref idref="c4" linear="yes"/><itemref/>' +
          '<itemref idref="c5" properties="rendition:layout-pre-paginated page-spread-left"/><itemref idref="c6" properties="rendition:layout-reflowable rendition:layout-pre-paginated"/>' +
          '<itemref idref="c7" properties="rendition:layout-fixed"/><div><itemref idref="nested"/></div><itemRef idref="caps"/>',
      ),
    },
    {
      label: 'spine direction rtl, toc padded',
      text: withSpine('page-progression-direction="rtl" toc=" ncx "', '<itemref idref="c1"/>'),
    },
    {
      label: 'spine direction padded ltr',
      text: withSpine('page-progression-direction=" ltr "', '<itemref idref="c1"/>'),
    },
    {
      label: 'spine direction default, toc empty',
      text: withSpine('page-progression-direction="default" toc=""', '<itemref idref="c1"/>'),
    },
    {
      label: 'spine direction in capitals, toc blank',
      text: withSpine('page-progression-direction="RTL" toc="   "', '<itemref idref="c1"/>'),
    },
    {
      label: 'spine direction empty',
      text: withSpine('page-progression-direction=""', '<itemref idref="c1"/>'),
    },
    {
      label: 'two manifests and two spines',
      text: opf(
        'version="3.0"',
        `${META_MIN}${MANIFEST_MIN}<manifest><item id="second" href="second.xhtml"/></manifest>${SPINE_MIN}<spine toc="second"><itemref idref="second"/></spine>`,
      ),
    },
  ]
  for (const version of ['2.0', ' 3.1 ', '10', '3abc', '+3', '-3', 'abc', '0x3', '\u0663', '']) {
    cases.push({
      label: `version ${JSON.stringify(version)}`,
      text: opf(`version="${version}"`, META_MIN + MANIFEST_MIN + SPINE_MIN),
    })
  }
  cases.push({ label: 'version missing', text: opf('', META_MIN + MANIFEST_MIN + SPINE_MIN) })
  return cases.map(({ label, text, opfPath = 'OEBPS/content.opf', entries = BOOK_ENTRIES }) => ({
    label: `package ${label}`,
    args: { tree: parseXml(text), opfPath, entries },
  }))
}

const navDoc = (body: string, namespaces = `xmlns="${XHTML_NS}" xmlns:epub="${OPS_NS}"`): string =>
  `${XML_DECL}<html ${namespaces}><head><title>Nav</title></head><body>${body}</body></html>`
const tocNav = (list: string, type = 'toc'): string =>
  `<nav epub:type="${type}"><ol>${list}</ol></nav>`
const li = (label: string, nested = ''): string =>
  `<li>${label}${nested === '' ? '' : `<ol>${nested}</ol>`}</li>`
const link = (href: string, text: string): string => `<a href="${esc(href)}">${text}</a>`

function navCases(): Input[] {
  const standard = navDoc(
    `<nav epub:type="toc" id="toc"><h1>Contents</h1><ol>${li(link('Text/ch1.xhtml', 'Chapter 1'))}` +
      `${li(link('Text/ch2.xhtml#sec', 'Chapter 2'), li(link('Text/ch2.xhtml#s1', 'Part 2.1'), li(link('Text/ch2.xhtml#s1a', 'Deep'))))}</ol></nav>`,
  )
  const xml: Array<[string, string, string?]> = [
    ['standard', standard],
    [
      'landmarks before toc',
      navDoc(
        tocNav(li(link('cover.xhtml', 'Cover')), 'landmarks') +
          tocNav(li(link('ch1.xhtml', 'One'))),
      ),
    ],
    ['toc among other tokens', navDoc(tocNav(li(link('ch1.xhtml', 'One')), 'x toc'))],
    ['TOC in capitals', navDoc(tocNav(li(link('ch1.xhtml', 'One')), 'TOC'))],
    ['no nav', navDoc('<p>none</p>')],
    ['toc without a list', navDoc('<nav epub:type="toc"><p>empty</p></nav>')],
    [
      'list inside a div',
      navDoc(`<nav epub:type="toc"><div><ol>${li(link('div.xhtml', 'In div'))}</ol></div></nav>`),
    ],
    [
      'OPS under another prefix',
      navDoc(
        `<nav e:type="toc"><ol>${li(link('e.xhtml', 'E'))}</ol></nav>`,
        `xmlns="${XHTML_NS}" xmlns:e="${OPS_NS}"`,
      ),
    ],
    ['undeclared epub prefix', navDoc(tocNav(li(link('u.xhtml', 'U'))), `xmlns="${XHTML_NS}"`)],
    ['plain type attribute', navDoc(`<nav type="toc"><ol>${li(link('p.xhtml', 'P'))}</ol></nav>`)],
    [
      'labels',
      navDoc(
        tocNav(
          li('<span>Span only</span>') +
            li('<a>No href</a>') +
            li('<a href="img.xhtml"><img src="i.png" alt=" Image alt "/></a>') +
            li('<a href="titled.xhtml" title=" Titled "></a>') +
            li('<a href="alt-after-title.xhtml" title=""><img alt="Alt"/></a>') +
            li('<a href="blank-alt.xhtml"><img alt="  "/></a>') +
            li('<span></span>', li(link('child.xhtml', 'Child of an empty label'))) +
            li(link('ruby.xhtml', '<ruby>漢<rt>かん</rt><rp>(</rp>字</ruby>')) +
            li(link('space.xhtml', '  Chapter&#160; 1 \n\t end ')) +
            li('<p><a href="p.xhtml">Not a direct child</a></p>') +
            li('<span>Span first</span><a href="second.xhtml">Second</a>') +
            li('<A HREF="caps.xhtml">Caps</A>'),
        ),
      ),
    ],
    [
      'hrefs',
      navDoc(
        tocNav(
          li(link('', 'Self')) +
            li(link('#x', 'Fragment')) +
            li(link('%E2%9C%93.xhtml#%E2%9C%93', 'Check')) +
            li(link('https://example.com/', 'Remote')) +
            li(link('../../up.xhtml', 'Up')) +
            li(link('q.xhtml?q=1#f', 'Query')) +
            li(link('bad%E0%A4%A.xhtml#%E0%A4%A', 'Malformed')),
        ),
      ),
    ],
    [
      'upper-case element names',
      navDoc(`<NAV epub:type="toc"><OL><LI><A href="u.xhtml">Upper</A></LI></OL></NAV>`),
    ],
    [
      'nav under a prefix',
      navDoc(
        `<h:nav xmlns:h="${XHTML_NS}" epub:type="toc"><h:ol><h:li><h:a href="h.xhtml">H</h:a></h:li></h:ol></h:nav>`,
      ),
    ],
    [
      'non-li children skipped',
      navDoc(
        `<nav epub:type="toc"><ol><div><a href="d.xhtml">D</a></div>${li(link('kept.xhtml', 'Kept'))}</ol></nav>`,
      ),
    ],
    [
      'first nested list only',
      navDoc(
        tocNav(
          `<li><a href="top.xhtml">Top</a><ol>${li(link('first.xhtml', 'First'))}</ol><ol>${li(link('second.xhtml', 'Second'))}</ol></li>`,
        ),
      ),
    ],
    [
      'two toc navs',
      navDoc(tocNav(li(link('one.xhtml', 'One'))) + tocNav(li(link('two.xhtml', 'Two')))),
    ],
    ['nav at the root', standard, 'nav.xhtml'],
    ['nav deep in folders', standard, 'a/b/c/nav.xhtml'],
  ]
  const html: Array<[string, string]> = [
    ['standard read as HTML', standard],
    [
      'unclosed items read as HTML',
      '<nav epub:type=toc><ol><li><a href=a.xhtml>A<li><a href=b.xhtml>B</ol></nav>',
    ],
  ]
  const deep = (children: XmlNode[]): XmlElement =>
    node('ol', [], [node('li', [], [node('a', [at('href', 'z.xhtml')], ['Z']), ...children])])
  return [
    ...xml.map(([label, text, navPath = 'OEBPS/nav.xhtml']) => ({
      label: `nav ${label}`,
      args: { tree: parseXml(text), navPath },
    })),
    ...html.map(([label, text]) => ({
      label: `nav ${label}`,
      args: { tree: parseHtml(text), navPath: 'OEBPS/nav.xhtml' },
    })),
    {
      label: 'nav empty namespaced type wins over epub:type',
      args: {
        navPath: 'OEBPS/nav.xhtml',
        tree: node('nav', [at('e:type', '', OPS_NS), at('epub:type', 'toc')], [deep([])]),
      },
    },
    {
      label: 'nav namespaced toc with an empty epub:type',
      args: {
        navPath: 'OEBPS/nav.xhtml',
        tree: node('nav', [at('e:type', 'toc', OPS_NS), at('epub:type', '')], [deep([deep([])])]),
      },
    },
  ]
}

const ncx = (body: string): string =>
  `${XML_DECL}<ncx xmlns="${NCX_NS}" version="2005-1"><head><meta name="dtb:uid" content="x"/></head><docTitle><text>Book</text></docTitle>${body}</ncx>`
const point = (label: string | null, src: string | null, inner = ''): string =>
  `<navPoint>${label === null ? '' : `<navLabel><text>${label}</text></navLabel>`}${src === null ? '' : `<content src="${esc(src)}"/>`}${inner}</navPoint>`
const navMap = (points: string): string => `<navMap>${points}</navMap>`

function ncxCases(): Input[] {
  const standard = ncx(
    navMap(
      point('One', 'Text/ch1.xhtml') +
        point(
          'Two',
          'Text/ch2.xhtml#s',
          point('Two A', 'Text/ch2.xhtml#a', point('Deep', 'Text/ch2.xhtml#d')),
        ),
    ),
  )
  const texts: Array<[string, string, string?]> = [
    ['standard', standard],
    ['no navMap', ncx('')],
    ['point without a label', ncx(navMap(point(null, 'nolabel.xhtml')))],
    ['point without content', ncx(navMap(point('No content', null)))],
    ['empty point with children', ncx(navMap(point(null, null, point('Child', 'child.xhtml'))))],
    ['src with a scheme', ncx(navMap(point('Remote', 'https://example.com/x.xhtml')))],
    [
      'upper-case element names',
      ncx(
        '<NAVMAP><NavPoint><NAVLABEL><TEXT>Up</TEXT></NAVLABEL><CONTENT src="up.xhtml"/></NavPoint></NAVMAP>',
      ),
    ],
    [
      'ruby and white space in a label',
      ncx(navMap(point('  <ruby>漢<rt>かん</rt><rp>(</rp></ruby>字\n\t章&#160; ', 'ruby.xhtml'))),
    ],
    [
      'two text elements',
      ncx(
        navMap(
          '<navPoint><navLabel><text>First</text><text>Second</text></navLabel><content src="t.xhtml"/></navPoint>',
        ),
      ),
    ],
    [
      'navList before navMap',
      ncx(
        `<navList><navPoint><navLabel><text>Listed</text></navLabel><content src="l.xhtml"/></navPoint></navList>${navMap(point('Mapped', 'm.xhtml'))}`,
      ),
    ],
    ['navMap nested', ncx(`<wrapper>${navMap(point('Wrapped', 'w.xhtml'))}</wrapper>`)],
    [
      'two navMaps',
      ncx(navMap(point('First map', 'f.xhtml')) + navMap(point('Second map', 's.xhtml'))),
    ],
    [
      'src forms',
      ncx(
        navMap(
          point('Self', '') +
            point('Fragment', '#f') +
            point('Percent', 'a%20b.xhtml#%C3%A9') +
            point('Up', '../../up.xhtml'),
        ),
      ),
    ],
    [
      'prefixed elements',
      `<n:ncx xmlns:n="${NCX_NS}"><n:navMap><n:navPoint><n:navLabel><n:text>P</n:text></n:navLabel><n:content src="p.xhtml"/></n:navPoint></n:navMap></n:ncx>`,
    ],
    ['label text with markup', ncx(navMap(point('A <span>B</span> C', 'markup.xhtml')))],
    [
      'text not a direct child of navLabel',
      ncx(
        navMap(
          '<navPoint><navLabel><span><text>Hidden</text></span></navLabel><content src="h.xhtml"/></navPoint>',
        ),
      ),
    ],
    [
      'content not a direct child',
      ncx(
        navMap(
          '<navPoint><navLabel><text>Wrapped content</text></navLabel><div><content src="c.xhtml"/></div></navPoint>',
        ),
      ),
    ],
    [
      'src in a namespace',
      ncx(
        navMap(
          `<navPoint xmlns:x="urn:x"><navLabel><text>NS</text></navLabel><content x:src="ns.xhtml"/></navPoint>`,
        ),
      ),
    ],
    ['ncx at the root', standard, 'toc.ncx'],
  ]
  return [
    ...texts.map(([label, text, ncxPath = 'OEBPS/toc.ncx']) => ({
      label: `ncx ${label}`,
      args: { tree: parseXml(text), ncxPath },
    })),
    {
      label: 'ncx navMap is the root',
      args: {
        ncxPath: 'OEBPS/toc.ncx',
        tree: node(
          'navMap',
          [],
          [node('navPoint', [], [node('content', [at('src', 'root.xhtml')], [])])],
        ),
      },
    },
  ]
}

const treeSpec = (fn: string, call: (input: Input) => unknown, cases: () => Input[]): Spec => ({
  fn,
  extensions: [],
  mutation: 'none',
  call,
  built: () => distinct(fn, cases()),
})

export const SPECS: Spec[] = [
  treeSpec(
    'packagePathFromContainer',
    (input) => packagePathFromContainer(tree(input)),
    containerCases,
  ),
  treeSpec('scanEncryption', (input) => scanEncryption(tree(input)), encryptionCases),
  treeSpec(
    'parsePackage',
    (input) =>
      parsePackage(tree(input), arg(input, 'opfPath'), finder(input.args!.entries as string[])),
    packageCases,
  ),
  treeSpec('navTocEntries', (input) => navTocEntries(tree(input), arg(input, 'navPath')), navCases),
  treeSpec('ncxEntries', (input) => ncxEntries(tree(input), arg(input, 'ncxPath')), ncxCases),
]
