// Built books for the gates of the XML half of epub-engine and of epubToText: a conforming book, then every
// way the checks of open.ts and the writer of save.ts can be made to differ. The builders follow
// packages/epub-engine/tests/helpers.ts, which they copy so that a change there does not move a population here.
import JSZip from 'jszip'
import { buildZip } from '../docx-diff/package-zips'

export interface FixtureEntry {
  name: string
  data: string | Uint8Array
  store?: boolean
  date?: Date
  comment?: string
  unixPermissions?: number
  dosPermissions?: number
  dir?: boolean
}

export const DATE = new Date('2026-01-01T00:00:00Z')

export const CONTAINER_XML = (opfPath = 'OEBPS/content.opf'): string =>
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n' +
  `<rootfiles><rootfile full-path="${opfPath}" media-type="application/oebps-package+xml"/></rootfiles>\n` +
  '</container>\n'

/** A zip from entries in the given order; `mimetype` is not added unless listed. */
export async function zipEntries(
  entries: FixtureEntry[],
  platform: 'DOS' | 'UNIX' = 'DOS',
): Promise<Uint8Array> {
  const zip = new JSZip()
  for (const entry of entries) {
    const options = {
      date: entry.date ?? DATE,
      createFolders: false,
      compression: entry.store ? ('STORE' as const) : ('DEFLATE' as const),
      ...(entry.comment === undefined ? {} : { comment: entry.comment }),
      ...(entry.unixPermissions === undefined ? {} : { unixPermissions: entry.unixPermissions }),
      ...(entry.dosPermissions === undefined ? {} : { dosPermissions: entry.dosPermissions }),
    }
    if (entry.dir) zip.file(entry.name, null, { ...options, dir: true })
    else zip.file(entry.name, entry.data, options)
  }
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', platform })
}

/** A conforming layout: mimetype first and stored, then container.xml, then the rest. */
export async function buildEpub(
  files: Record<string, string | Uint8Array>,
  opfPath = 'OEBPS/content.opf',
): Promise<Uint8Array> {
  const entries: FixtureEntry[] = [
    { name: 'mimetype', data: 'application/epub+zip', store: true },
    { name: 'META-INF/container.xml', data: CONTAINER_XML(opfPath) },
  ]
  for (const [name, data] of Object.entries(files)) entries.push({ name, data })
  return zipEntries(entries)
}

export const xhtml = (title: string, body: string, head = ''): string =>
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<!DOCTYPE html>\n' +
  '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">\n' +
  `<head><title>${title}</title>${head}</head>\n<body>\n${body}\n</body>\n</html>\n`

export interface OpfOptions {
  version?: string
  uniqueIdentifier?: string
  metadata: string
  manifest: string
  spine: string
  spineAttrs?: string
  packageAttrs?: string
}

export const opf = (o: OpfOptions): string =>
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  `<package xmlns="http://www.idpf.org/2007/opf" version="${o.version ?? '3.0'}" ` +
  `unique-identifier="${o.uniqueIdentifier ?? 'uid'}"${o.packageAttrs ? ` ${o.packageAttrs}` : ''}>\n` +
  '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">\n' +
  `${o.metadata}\n</metadata>\n` +
  `<manifest>\n${o.manifest}\n</manifest>\n` +
  `<spine${o.spineAttrs ? ` ${o.spineAttrs}` : ''}>\n${o.spine}\n</spine>\n` +
  '</package>\n'

export function epub3Files(): Record<string, string> {
  return {
    'OEBPS/content.opf': opf({
      metadata: [
        '<dc:identifier id="uid">urn:uuid:12345678-90ab-cdef-1234-567890abcdef</dc:identifier>',
        '<dc:identifier id="isbn">978-0-00-000000-0</dc:identifier>',
        '<dc:title>  A Book &amp; Its Title </dc:title>',
        '<dc:creator>First Author</dc:creator>',
        '<dc:creator>Second Author</dc:creator>',
        '<dc:language>en</dc:language>',
        '<dc:language>fr</dc:language>',
        '<meta property="dcterms:modified">2026-01-01T00:00:00Z</meta>',
      ].join('\n'),
      manifest: [
        '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
        '<item id="css" href="styles/book.css" media-type="text/css"/>',
        '<item id="c1" href="text/chapter%201.xhtml" media-type="application/xhtml+xml"/>',
        '<item id="c2" href="text/c2.xhtml" media-type="application/xhtml+xml" properties="mathml scripted"/>',
        '<item id="notes" href="text/notes.xhtml" media-type="application/xhtml+xml"/>',
      ].join('\n'),
      spine: [
        '<itemref idref="c1"/>',
        '<itemref idref="c2" properties="page-spread-left"/>',
        '<itemref idref="notes" linear="no"/>',
      ].join('\n'),
      spineAttrs: 'page-progression-direction="ltr"',
    }),
    'OEBPS/nav.xhtml': xhtml(
      'Contents',
      '<nav epub:type="landmarks"><ol><li><a href="text/c2.xhtml">Wrong</a></li></ol></nav>\n' +
        '<nav epub:type="toc" id="toc"><h1>Contents</h1><ol>\n' +
        '<li><a href="text/chapter%201.xhtml">Chapter <em>One</em></a>\n' +
        '<ol><li><a href="text/chapter%201.xhtml#s1">Section 1.1</a></li></ol></li>\n' +
        '<li><a href="text/c2.xhtml#top">Chapter&#160;Two</a></li>\n' +
        '<li><span>Back matter</span><ol><li><a href="text/notes.xhtml">Notes</a></li></ol></li>\n' +
        '<li><a href="https://example.com/">Website</a></li>\n' +
        '</ol></nav>',
    ),
    'OEBPS/styles/book.css': 'body { margin: 0 }\n',
    'OEBPS/text/chapter 1.xhtml': xhtml(
      'One',
      '<h1>One</h1><p id="s1">First chapter.</p>',
      '<link rel="stylesheet" href="../styles/book.css"/>',
    ),
    'OEBPS/text/c2.xhtml': xhtml('Two', '<h1 id="top">Two</h1><p>Second chapter.</p>'),
    'OEBPS/text/notes.xhtml': xhtml('Notes', '<p>Notes.</p>'),
  }
}

export function epub2Files(): Record<string, string> {
  return {
    'content.opf': opf({
      version: '2.0',
      uniqueIdentifier: 'BookId',
      metadata: [
        '<dc:title>Old Book</dc:title>',
        '<dc:creator opf:role="aut">Old Author</dc:creator>',
        '<dc:language>ja</dc:language>',
        '<dc:identifier id="BookId" opf:scheme="UUID">0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0</dc:identifier>',
        '<meta name="primary-writing-mode" content="vertical-rl"/>',
      ].join('\n'),
      manifest: [
        '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>',
        '<item id="ch1" href="ch1.html" media-type="application/xhtml+xml"/>',
        '<item id="ch2" href="ch2.html" media-type="application/xhtml+xml"/>',
      ].join('\n'),
      spine: '<itemref idref="ch1"/>\n<itemref idref="ch2"/>',
      spineAttrs: 'toc="ncx" page-progression-direction="rtl"',
    }),
    'toc.ncx':
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">\n' +
      '<head/><docTitle><text>Old Book</text></docTitle>\n<navMap>\n' +
      '<navPoint id="n1" playOrder="1"><navLabel><text>Part One</text></navLabel><content src="ch1.html"/>\n' +
      '  <navPoint id="n2" playOrder="2"><navLabel><text>Inner</text></navLabel><content src="ch1.html#inner"/></navPoint>\n' +
      '</navPoint>\n' +
      '<navPoint id="n3" playOrder="3"><navLabel><text> Part Two </text></navLabel><content src="ch2.html"/></navPoint>\n' +
      '</navMap>\n</ncx>\n',
    'ch1.html': xhtml('ch1', '<p>One</p><p id="inner">Inner</p>'),
    'ch2.html': xhtml('ch2', '<p>Two</p>'),
  }
}

const encoder = new TextEncoder()
export const utf16 = (text: string, little: boolean): Uint8Array => {
  const out = new Uint8Array(2 + text.length * 2)
  out.set(little ? [0xff, 0xfe] : [0xfe, 0xff])
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i)
    out[2 + 2 * i] = little ? unit & 255 : unit >> 8
    out[3 + 2 * i] = little ? unit >> 8 : unit & 255
  }
  return out
}

const CHAPTER = '<h1>Heading</h1><p>Text of the chapter.</p>'

/** A one-chapter EPUB 3 book whose package document is `opfXml` and whose files are `extra`. */
async function small(
  opfXml: string,
  extra: Record<string, string | Uint8Array> = {},
  entries?: FixtureEntry[],
): Promise<Uint8Array> {
  return entries
    ? zipEntries(entries)
    : buildEpub({ 'OEBPS/content.opf': opfXml, 'OEBPS/c1.xhtml': xhtml('One', CHAPTER), ...extra })
}

const ONE = (over: Partial<OpfOptions> = {}): string =>
  opf({
    metadata:
      '<dc:identifier id="uid">urn:uuid:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee</dc:identifier>\n<dc:title>T</dc:title>\n<dc:language>en</dc:language>',
    manifest: '<item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/>',
    spine: '<itemref idref="c1"/>',
    ...over,
  })

const ENCRYPTION = (...entries: string[]): string =>
  '<?xml version="1.0"?><encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:enc="http://www.w3.org/2001/04/xmlenc#">' +
  entries.join('') +
  '</encryption>'
const ENCRYPTED = (algorithm: string, uri: string): string =>
  `<enc:EncryptedData><enc:EncryptionMethod Algorithm="${algorithm}"/><enc:CipherData><enc:CipherReference URI="${uri}"/></enc:CipherData></enc:EncryptedData>`
const IDPF = 'http://www.idpf.org/2008/embedding'
const ADOBE = 'http://ns.adobe.com/pdf/enc#RC'

export interface BuiltBook {
  label: string
  bytes: Uint8Array
}

/** Every built book; the labels say what each one makes a reader decide. */
export async function builtBooks(): Promise<BuiltBook[]> {
  const out: BuiltBook[] = []
  const add = async (
    label: string,
    make: () => Promise<Uint8Array> | Uint8Array,
  ): Promise<void> => {
    out.push({ label, bytes: await make() })
  }
  const font = new Uint8Array(3000).map((_, i) => (i * 7 + 3) & 255)
  const e3 = epub3Files()

  await add('epub3', () => buildEpub(e3))
  await add('epub2 ncx vertical rtl', () => buildEpub(epub2Files(), 'content.opf'))
  await add('epub3 unix platform', () =>
    zipEntries(
      [
        { name: 'mimetype', data: 'application/epub+zip', store: true },
        { name: 'META-INF/container.xml', data: CONTAINER_XML() },
        ...Object.entries(e3).map(([name, data]) => ({ name, data, unixPermissions: 0o644 })),
      ],
      'UNIX',
    ),
  )
  await add('no mimetype', () =>
    zipEntries([
      { name: 'META-INF/container.xml', data: CONTAINER_XML() },
      ...Object.entries(e3).map(([name, data]) => ({ name, data })),
    ]),
  )
  await add('mimetype last and deflated', () =>
    zipEntries([
      { name: 'META-INF/container.xml', data: CONTAINER_XML() },
      ...Object.entries(e3).map(([name, data]) => ({ name, data })),
      { name: 'mimetype', data: 'application/epub+zip' },
    ]),
  )
  await add('mimetype empty', () =>
    zipEntries([
      { name: 'mimetype', data: '', store: true },
      { name: 'META-INF/container.xml', data: CONTAINER_XML() },
      ...Object.entries(e3).map(([name, data]) => ({ name, data })),
    ]),
  )
  await add('directories, comments, odd dates, stored entries', () =>
    zipEntries([
      {
        name: 'mimetype',
        data: 'application/epub+zip',
        store: true,
        date: new Date('1980-01-01T00:00:00Z'),
      },
      { name: 'META-INF/', data: '', dir: true, comment: 'folder' },
      { name: 'META-INF/container.xml', data: CONTAINER_XML(), comment: 'c\u00e9' },
      { name: 'OEBPS/', data: '', dir: true, dosPermissions: 0x11 },
      ...Object.entries(e3).map(([name, data], index) => ({
        name,
        data,
        store: index % 2 === 0,
        date: index === 1 ? new Date('2107-12-31T23:59:58Z') : undefined,
        ...(index === 2 ? { comment: '\u6ce8\u91c8' } : {}),
        ...(index === 3 ? { dosPermissions: 0x21 } : {}),
      })),
      { name: 'OEBPS/empty.txt', data: '' },
      { name: 'OEBPS/empty-stored.txt', data: '', store: true },
      { name: 'OEBPS/ima\u00e9.bin', data: font },
    ]),
  )
  await add('a zip comment and bytes before the archive', async () => {
    const zip = await zipEntries([
      { name: 'mimetype', data: 'application/epub+zip', store: true },
      { name: 'META-INF/container.xml', data: CONTAINER_XML() },
      ...Object.entries(e3).map(([name, data]) => ({ name, data })),
    ])
    return new Uint8Array([...encoder.encode('junk before'), ...zip])
  })

  // the checks of openEpub, in the order of its spec
  await add('no container', () =>
    zipEntries([
      { name: 'mimetype', data: 'application/epub+zip', store: true },
      { name: 'a.txt', data: 'x' },
    ]),
  )
  await add('container not well-formed', () =>
    zipEntries([
      { name: 'META-INF/container.xml', data: '<container><rootfiles>' },
      { name: 'a.txt', data: 'x' },
    ]),
  )
  await add('container names no package', () =>
    zipEntries([
      {
        name: 'META-INF/container.xml',
        data: '<container><rootfiles><rootfile media-type="x"/></rootfiles></container>',
      },
    ]),
  )
  await add('container names a package that is missing', () =>
    zipEntries([{ name: 'META-INF/container.xml', data: CONTAINER_XML('NOPE/content.opf') }]),
  )
  await add('container with two rootfiles', () =>
    zipEntries([
      {
        name: 'META-INF/container.xml',
        data: '<container><rootfiles><rootfile full-path="a.opf" media-type="text/plain"/><rootfile full-path="OEBPS/content.opf" media-type=" application/oebps-package+xml "/></rootfiles></container>',
      },
      ...Object.entries(e3).map(([name, data]) => ({ name, data })),
    ]),
  )
  await add('container path in another case', () =>
    zipEntries([
      { name: 'meta-inf/CONTAINER.xml', data: CONTAINER_XML('oebps/CONTENT.opf') },
      ...Object.entries(e3).map(([name, data]) => ({ name, data })),
    ]),
  )
  await add('rights.xml', () => buildEpub({ ...e3, 'META-INF/rights.xml': '<rights/>' }))
  await add('encryption.xml with an AES algorithm', () =>
    buildEpub({
      ...e3,
      'META-INF/encryption.xml': ENCRYPTION(
        ENCRYPTED('http://www.w3.org/2001/04/xmlenc#aes128-cbc', 'OEBPS/text/c2.xhtml'),
      ),
    }),
  )
  await add('encryption.xml without a method', () =>
    buildEpub({
      ...e3,
      'META-INF/encryption.xml': ENCRYPTION(
        '<enc:EncryptedData><enc:CipherData/></enc:EncryptedData>',
      ),
    }),
  )
  await add('encryption.xml with an empty algorithm', () =>
    buildEpub({
      ...e3,
      'META-INF/encryption.xml': ENCRYPTION('<enc:EncryptionMethod Algorithm=""/>'),
    }),
  )
  await add('encryption.xml not well-formed', () =>
    buildEpub({ ...e3, 'META-INF/encryption.xml': '<encryption>' }),
  )
  await add('encryption.xml that lists nothing', () =>
    buildEpub({ ...e3, 'META-INF/encryption.xml': ENCRYPTION() }),
  )
  await add('obfuscated fonts, IDPF and Adobe', () =>
    buildEpub({
      ...e3,
      'OEBPS/fonts/a.otf': font,
      'OEBPS/fonts/b.otf': font.slice(10),
      'OEBPS/fonts/c.otf': font.slice(20),
      'META-INF/encryption.xml': ENCRYPTION(
        ENCRYPTED(IDPF, '../OEBPS/fonts/a.otf'),
        ENCRYPTED(ADOBE, 'OEBPS/fonts/b.otf'),
        ENCRYPTED(IDPF, 'OEBPS/fonts/a.otf'),
        ENCRYPTED(IDPF, 'OEBPS/fonts/missing.otf'),
        ENCRYPTED(IDPF, 'OEBPS/FONTS/C.OTF'),
        ENCRYPTED(IDPF, 'https://x/y.otf'),
      ),
    }),
  )
  await add('Adobe font with no UUID identifier', () =>
    buildEpub({
      ...e3,
      'OEBPS/content.opf': e3['OEBPS/content.opf']!.replace(
        'urn:uuid:12345678-90ab-cdef-1234-567890abcdef',
        'not a uuid',
      ).replace('978-0-00-000000-0', 'also not'),
      'OEBPS/fonts/b.otf': font,
      'META-INF/encryption.xml': ENCRYPTION(ENCRYPTED(ADOBE, 'OEBPS/fonts/b.otf')),
    }),
  )
  await add('Adobe font keyed by the second identifier', () =>
    buildEpub({
      ...e3,
      'OEBPS/content.opf': e3['OEBPS/content.opf']!.replace(
        'urn:uuid:12345678-90ab-cdef-1234-567890abcdef',
        'plain',
      ).replace('978-0-00-000000-0', '{12345678-90AB-CDEF-1234-567890ABCDEF}'),
      'OEBPS/fonts/b.otf': font,
      'META-INF/encryption.xml': ENCRYPTION(ENCRYPTED(ADOBE, 'OEBPS/fonts/b.otf')),
    }),
  )
  await add('IDPF font with no identifier at all', () =>
    buildEpub({
      'OEBPS/content.opf': ONE({ metadata: '<dc:title>T</dc:title>' }).replace(
        ' unique-identifier="uid"',
        '',
      ),
      'OEBPS/c1.xhtml': xhtml('One', CHAPTER),
      'OEBPS/f.otf': font,
      'META-INF/encryption.xml': ENCRYPTION(ENCRYPTED(IDPF, 'OEBPS/f.otf')),
    }),
  )

  // the package document
  await add('package not a package', () => small('<notapackage/>'))
  await add('package not well-formed', () => small('<package><manifest>'))
  await add('package without manifest', () =>
    small('<package xmlns="http://www.idpf.org/2007/opf"><spine/></package>'),
  )
  await add('package without spine', () =>
    small('<package xmlns="http://www.idpf.org/2007/opf"><manifest/></package>'),
  )
  await add('spine that names nothing in the archive', () =>
    small(
      ONE({
        manifest:
          '<item id="c1" href="gone.xhtml" media-type="application/xhtml+xml"/><item id="r" href="https://example.com/r.xhtml" media-type="application/xhtml+xml"/>',
        spine: '<itemref idref="c1"/><itemref idref="r"/><itemref idref="nope"/>',
      }),
    ),
  )
  await add('manifest ids that repeat', () =>
    small(
      ONE({
        manifest:
          '<item id="c1" href="gone.xhtml" media-type="x"/><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/><item href="c1.xhtml"/><item id="n"/>',
      }),
    ),
  )
  await add('undeclared dc prefix', () =>
    small(
      '<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="u"><metadata><dc:title>Plain</dc:title><DC:Creator>Up</DC:Creator><dc:identifier id="u" opf:scheme="ISBN">123</dc:identifier></metadata><manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1" linear="no"/></spine></package>',
    ),
  )
  await add('package version 3 with a refined main title and global layout', () =>
    small(
      ONE({
        version: '3.1',
        metadata:
          '<dc:identifier id="uid">u</dc:identifier><dc:title id="t1">Sub</dc:title><dc:title id="t2">Main</dc:title><meta refines="#t2" property="title-type"> main </meta><meta property="rendition:layout">pre-paginated</meta><meta property="rendition:layout" refines="#t1">reflowable</meta>',
      }),
    ),
  )
  await add('fixed layout with itemref overrides', () =>
    small(
      ONE({
        metadata:
          '<dc:identifier id="uid">u</dc:identifier><meta property="rendition:layout"> reflowable </meta>',
        manifest:
          '<item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="c2.xhtml" media-type="application/xhtml+xml"/>',
        spine:
          '<itemref idref="c1" properties="rendition:layout-pre-paginated"/><itemref idref="c2" properties="rendition:layout-reflowable page-spread-right"/>',
      }),
      { 'OEBPS/c2.xhtml': xhtml('Two', '<p>Two</p>') },
    ),
  )
  await add('version 3 package in an EPUB 2 mime', () => small(ONE({ version: ' 2.0 ' })))
  await add('no version', () => small(ONE().replace(' version="3.0"', '')))
  await add('manifest href in another case and with a fragment and a query', () =>
    small(
      ONE({
        manifest: '<item id="c1" href="C1.XHTML?x=1#frag" media-type="application/xhtml+xml"/>',
      }),
    ),
  )
  await add('manifest href that climbs out of the archive and is percent encoded', () =>
    small(
      ONE({
        manifest:
          '<item id="c1" href="../../OEBPS/%63%31.xhtml" media-type="application/xhtml+xml"/><item id="bad" href="%E0%A4%A.xhtml" media-type="x"/>',
        spine: '<itemref idref="c1"/><itemref idref="bad"/>',
      }),
    ),
  )

  // the table of contents
  await add('nav without a toc nav, spine titles from headings and file names', () =>
    buildEpub({
      ...e3,
      'OEBPS/nav.xhtml': xhtml(
        'N',
        '<nav epub:type="landmarks"><ol><li><a href="text/c2.xhtml">x</a></li></ol></nav>',
      ),
      'OEBPS/text/chapter 1.xhtml': xhtml('One', '<p>no heading</p>'),
      'OEBPS/text/c2.xhtml': xhtml(
        'Two',
        '<h2><ruby>\u6f22<rp>(</rp><rt>kan</rt><rp>)</rp></ruby> two</h2>',
      ),
      'OEBPS/text/notes.xhtml': xhtml('Notes', '<h3> </h3><h4>Late   heading</h4>'),
    }),
  )
  await add('nav that is HTML only and a chapter that is not XML', () =>
    buildEpub({
      ...e3,
      'OEBPS/nav.xhtml':
        '<!DOCTYPE html><html><body><nav epub:type="toc"><ol><li><a href=text/c2.xhtml>Two&nbsp;&eacute;<li><a href="text/notes.xhtml">Notes<br></ol></nav>',
      'OEBPS/text/c2.xhtml': '<p>soup<p>more &nbsp; soup',
      'OEBPS/text/chapter 1.xhtml': '<h1>H&eacute;</h1><br>text',
    }),
  )
  await add('nav entries of every shape', () =>
    buildEpub({
      ...e3,
      'OEBPS/nav.xhtml': xhtml(
        'N',
        '<nav epub:type="toc other"><ol><li><a title=" Titled "><img alt=" alt text "/></a></li><li><span><ruby>base<rt>ruby</rt></ruby></span><ol><li><a href="#top">Self</a></li><li/></ol></li><li><a href="">Empty href</a></li><li><b>no label</b><ol><li><a href="text/c2.xhtml">In nested</a></li></ol></li><li><a href="TEXT/C2.XHTML#Frag%20x">Other case</a></li></ol></nav>',
      ),
    }),
  )
  await add('ncx without a spine toc attribute', () =>
    buildEpub(
      {
        ...epub2Files(),
        'content.opf': epub2Files()['content.opf']!.replace('toc="ncx" ', ''),
      },
      'content.opf',
    ),
  )
  await add('ncx that is empty, then nav', () =>
    buildEpub({
      ...e3,
      'OEBPS/nav.xhtml': xhtml('N', '<p>no nav</p>'),
      'OEBPS/toc.ncx': '<ncx><navMap/></ncx>',
      'OEBPS/content.opf': e3['OEBPS/content.opf']!.replace(
        '<item id="css"',
        '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/><item id="css"',
      ),
    }),
  )
  await add('ncx with nested uppercase elements and ruby', () =>
    buildEpub(
      {
        ...epub2Files(),
        'toc.ncx':
          '<NCX><NAVMAP><NAVPOINT><NAVLABEL><TEXT>A<rt>x</rt> <b>B</b></TEXT></NAVLABEL><CONTENT SRC="ch1.html"/><NAVPOINT><NAVLABEL><TEXT/></NAVLABEL><CONTENT src="ch2.html#z"/></NAVPOINT></NAVPOINT></NAVMAP></NCX>'.replace(
            /SRC/,
            'src',
          ),
      },
      'content.opf',
    ),
  )

  // the writing mode
  await add('vertical writing in the book CSS', () =>
    buildEpub({
      ...e3,
      'OEBPS/styles/book.css': '/* x */ html { -epub-writing-mode : vertical-rl }',
      'OEBPS/styles/other.css': 'p{writing-mode:horizontal-tb}',
      'OEBPS/content.opf': e3['OEBPS/content.opf']!.replace(
        '<item id="css"',
        '<item id="o" href="styles/other.css" media-type="text/css"/><item id="css"',
      ),
    }),
  )
  await add('a stylesheet that is missing and a stylesheet that is invalid UTF-8', () =>
    buildEpub({
      ...e3,
      'OEBPS/styles/book.css': new Uint8Array([0xff, 0xfe, 0x00]),
      'OEBPS/content.opf': e3['OEBPS/content.opf']!.replace(
        '<item id="css"',
        '<item id="m" href="styles/missing.css" media-type="text/css"/><item id="css"',
      ),
    }),
  )

  // chapters that do not decode, or decode otherwise
  const withChapter = (
    data: string | Uint8Array,
    chapter = 'OEBPS/text/c2.xhtml',
  ): Promise<Uint8Array> => buildEpub({ ...e3, [chapter]: data })
  await add('chapter in UTF-16LE', () =>
    withChapter(utf16(xhtml('Two', '<h1>\u4e8c</h1><p>utf16 le \ud83d\ude00</p>'), true)),
  )
  await add('chapter in UTF-16BE', () =>
    withChapter(utf16(xhtml('Two', '<h1>\u4e8c</h1><p>utf16 be</p>'), false)),
  )
  await add('chapter in UTF-16LE with a lone surrogate and an odd byte', () =>
    withChapter(new Uint8Array([...utf16('<p>a\ud800b</p>', true), 0x41])),
  )
  await add('chapter that is invalid UTF-8', () =>
    withChapter(
      new Uint8Array([...encoder.encode('<p>a'), 0xff, 0xc3, ...encoder.encode('b</p>')]),
    ),
  )
  await add('chapter with a UTF-8 byte order mark', () =>
    withChapter(new Uint8Array([0xef, 0xbb, 0xbf, ...encoder.encode(xhtml('Two', '<p>bom</p>'))])),
  )
  await add('every chapter invalid', () =>
    buildEpub({
      ...e3,
      'OEBPS/text/chapter 1.xhtml': new Uint8Array([0xff]),
      'OEBPS/text/c2.xhtml': new Uint8Array([0xc0]),
      'OEBPS/text/notes.xhtml': new Uint8Array([0x80]),
    }),
  )
  await add('every chapter in the archive is empty', () =>
    buildEpub({
      ...e3,
      'OEBPS/text/chapter 1.xhtml': '',
      'OEBPS/text/c2.xhtml': '',
      'OEBPS/text/notes.xhtml': '',
    }),
  )
  await add('chapters that are HTML and not XML', () =>
    buildEpub({
      ...e3,
      'OEBPS/text/chapter 1.xhtml':
        '<html><body><h1>Soup</h1><p>One<br>two<p>three &nbsp;&amp;&eacute;&#x1F600;&#0;',
      'OEBPS/text/c2.xhtml':
        '<ul><li>a<li>b</ul><table><tr><td>1<td>2<tr><th>3</table><pre>  keep\n  this  </pre>',
      'OEBPS/text/notes.xhtml': '<!-- only -->',
    }),
  )
  await add('chapters with entities, namespaces and structure', () =>
    buildEpub({
      ...e3,
      'OEBPS/text/chapter 1.xhtml': xhtml(
        'One',
        '<h1>A&nbsp;B &eacute; &hellip; &#169; &#xA9;</h1><div><p>x<br/>y</p><table><tr><td>1</td><td> </td><th>3</th></tr></table><pre>  a\n b  </pre><ruby>k<rt>r</rt></ruby><svg><text>skip</text></svg><script>no</script></div>',
      ),
      'OEBPS/text/c2.xhtml':
        '<?xml version="1.0"?><x:html xmlns:x="http://www.w3.org/1999/xhtml"><x:body><x:h2>Prefixed</x:h2><x:p>t</x:p><![CDATA[<cdata & >]]></x:body></x:html>',
      'OEBPS/text/notes.xhtml':
        '<html xmlns="http://www.w3.org/1999/xhtml"><body><p>&undefined;</p></body></html>',
    }),
  )

  // too many parts, forged sizes, and flags the gate refuses
  await add('too many parts', async () => {
    const zip = new JSZip()
    for (let i = 0; i < 10_001; i++) zip.file(`f${i}`, '', { createFolders: false, date: DATE })
    return zip.generateAsync({ type: 'uint8array', compression: 'STORE' })
  })
  await add('a part declared past the limit', () =>
    buildZip([{ name: 'META-INF/container.xml', data: '<a/>', declaredSize: 600_000_000 }]),
  )
  await add('parts that together are declared past the limit', () =>
    buildZip(
      [0, 1, 2, 3].map((n) => ({ name: `p${n}.xml`, data: '<a/>', declaredSize: 450_000_000 })),
    ),
  )
  await add('a part that inflates past its declaration', () =>
    buildZip([
      {
        name: 'META-INF/container.xml',
        data: 'x'.repeat(1536 * 1024),
        method: 8,
        declaredSize: 300,
      },
    ]),
  )
  await add('an encrypted flag', () =>
    buildZip([{ name: 'META-INF/container.xml', data: CONTAINER_XML(), flags: 1 }]),
  )
  await add('an unknown compression method', () =>
    buildZip([{ name: 'META-INF/container.xml', data: '<a/>', method: 99 }]),
  )
  await add('a deflate stream cut short', () =>
    buildZip([
      {
        name: 'META-INF/container.xml',
        data: 'y'.repeat(4000),
        method: 8,
        payload: new Uint8Array([0x4b, 0x4c]),
        compressedSize: 2,
      },
    ]),
  )
  await add('empty bytes', () => new Uint8Array(0))
  await add('not a zip', () => encoder.encode('this is not a zip file'))
  await add('a zip cut in the middle', async () => (await buildEpub(e3)).slice(0, 700))
  await add('a zip without its end', async () => (await buildEpub(e3)).slice(0, -10))
  return out
}

/** Edits for `saveEpub`: `[path, replacements]` pairs against `book`, texts as units. */
export type Edit = [string, Array<{ start: number | string; end: number | string; text: string }>]
