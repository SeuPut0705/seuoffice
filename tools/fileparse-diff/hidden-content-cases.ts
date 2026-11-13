import JSZip from 'jszip'
import {
  fileHoldsHiddenContent,
  HIDDEN_CONTENT_EXTENSIONS,
  htmlHoldsMark,
  markdownHoldsMark,
  xmlHoldsMark,
} from './reference/hidden-content'
import type { Input, Spec } from './spec'
import { breakEntry, inputs as xlsxInputs } from './xlsx-cases'
import { fixtureBytes } from './zip-fixture'

const OWN_NS = 'https://github.com/SeuPut0705/seuoffice/redaction/2026'
const OLD_NS = 'https://genspark.ai/genoffice/redaction/2026'
const DECK_URI = '{9F1B2C3D-4E5F-4A6B-8C7D-9E0F1A2B3C4D}'

const hex = (text: string) => [...text].map((ch) => `&#x${ch.codePointAt(0)!.toString(16)};`).join('')
const dec = (text: string) => [...text].map((ch) => `&#${ch.codePointAt(0)};`).join('')
const upperHex = (text: string) => [...text].map((ch) => `&#x${ch.codePointAt(0)!.toString(16).toUpperCase()};`).join('')

/** the part text under test, one per spelling of a mark and of what only looks like one */
const XML: ReadonlyArray<readonly [string, string]> = [
  ['empty', ''],
  ['plain text', 'nothing to see'],
  ['own namespace', `<w:document xmlns:go="${OWN_NS}"/>`],
  ['old namespace', `<w:document xmlns:go="${OLD_NS}"/>`],
  ['own namespace bare', OWN_NS],
  ['own namespace truncated', OWN_NS.slice(0, -1)],
  ['own namespace in hex references', `<a xmlns:go="${hex(OWN_NS)}"/>`],
  ['old namespace in hex references', `<a xmlns:go="${hex(OLD_NS)}"/>`],
  ['own namespace in decimal references', `<a xmlns:go="${dec(OWN_NS)}"/>`],
  ['old namespace in decimal references', `<a xmlns:go="${dec(OLD_NS)}"/>`],
  ['own namespace in upper-case hex references', `<a xmlns:go="${upperHex(OWN_NS)}"/>`],
  ['own namespace, one character a reference', OWN_NS.replace('g', '&#103;')],
  ['own namespace, one character a padded reference', OWN_NS.replace('g', '&#x00000000067;')],
  ['own namespace, one character a zero-padded decimal reference', OWN_NS.replace('g', `&#${'0'.repeat(40)}103;`)],
  ['own namespace, a reference with an upper-case X', OWN_NS.replace('g', '&#X67;')],
  ['own namespace, a reference without its semicolon', OWN_NS.replace('g', '&#103')],
  ['own namespace, a reference with no digits', OWN_NS.replace('g', '&#;g')],
  ['own namespace, a reference of a name', OWN_NS.replace('g', '&amp;')],
  ['own namespace, doubled reference opener', OWN_NS.replace('g', '&#&#103;')],
  ['reference of a surrogate left as written', `<a x="${'&#xD800;'}"/>`],
  ['namespace broken by a reference of a surrogate', OWN_NS.replace('g', '&#xD800;')],
  ['namespace broken by a reference past 0x10FFFF', OWN_NS.replace('g', '&#x110000;')],
  ['namespace broken by a long hex reference', OWN_NS.replace('g', `&#x${'f'.repeat(400)};`)],
  ['namespace broken by a long decimal reference', OWN_NS.replace('g', `&#${'9'.repeat(400)};`)],
  ['reference at the largest code point', 'a&#x10FFFF;b'],
  ['reference at the largest code point, decimal', 'a&#1114111;b'],
  ['reference of zero', 'a&#0;b&#x0;c'],
  ['reference of a surrogate then a mark', `&#xDFFF;<redact>`],
  ['reference that spells the opener of an element', '&#60;redact&#62;'],
  ['reference that spells the opener of an element, decimal and hex', '&#x3C;redact/&#x3E;'],
  ['deck extension uri', `<p:ext uri="${DECK_URI}"/>`],
  ['deck extension uri in references', `<p:ext uri="${hex(DECK_URI)}"/>`],
  ['deck extension uri lower case', `<p:ext uri="${DECK_URI.toLowerCase()}"/>`],
  ['redact element', '<redact>x</redact>'],
  ['prefixed redact element', '<x:redact/>'],
  ['prefixed redact element, dotted prefix', '<a.b-c_d:redact >'],
  ['redact element then a tab', '<redact\tid="1">'],
  ['redact element then a newline', '<redact\nid="1">'],
  ['redact element then a no-break space', '<redact\u00a0id="1">'],
  ['redact element then a form feed', '<redact\fid="1">'],
  ['redact element then a line separator', '<redact\u2028id="1">'],
  ['redact element then a byte order mark', '<redact\ufeffid="1">'],
  ['redact element then a vertical tab', '<redact\u000bid="1">'],
  ['redact element then a zero-width space', '<redact\u200bid="1">'],
  ['redact element at the end of the text', '<redact'],
  ['redact element with a slash', '<redact/>'],
  ['redactx element', '<redactx>'],
  ['redact with a colon after', '<redact:x>'],
  ['redact prefix of redact element', '<redact:redact>'],
  ['redact prefix of redactx element', '<redact:redactx>'],
  ['two prefixes', '<a:b:redact>'],
  ['prefix with a space', '<a :redact>'],
  ['prefix with a non-ASCII letter', '<é:redact>'],
  ['upper-case element', '<REDACT>'],
  ['closing tag', '</redact>'],
  ['closing tag prefixed', '</x:redact>'],
  ['redact as text', 'redact <b>redact</b>'],
  ['redact attribute', '<w:r redact="1"/>'],
  ['opener at the end', '<'],
  ['openers then a mark', '<<<<x:redact>'],
  ['astral text before a mark', '\u{1F600}<x:redact/>'],
  ['long run of name characters', `<${'a'.repeat(5000)}`],
  ['long run of name characters then a mark', `<${'a'.repeat(5000)}:redact>`],
  ['long run of openers', '<a'.repeat(5000)],
]

/** Markdown text; each is one the span pattern reads or nearly reads */
const MARKDOWN: ReadonlyArray<readonly [string, string]> = [
  ['empty', ''],
  ['span as the editor writes it', '<span class="redact-span" data-redaction="" data-label="x">words</span>'],
  ['bare attribute', '<span data-redaction>words</span>'],
  ['upper-case span', '<SPAN DATA-REDACTION>x</SPAN>'],
  ['mixed case', '<Span Data-Redaction=1>x'],
  ['attributes before', '<span id="a" class="b" data-redaction="">x</span>'],
  ['newline before the attribute', '<span\nclass="a"\ndata-redaction>x'],
  ['carriage return before the attribute', '<span\rdata-redaction>x'],
  ['attribute after a quoted greater-than', '<span title=">" data-redaction>x'],
  ['attribute inside a quoted value', '<span title="data-redaction">x'],
  ['data-redaction-x', '<span data-redaction-x="1">x</span>'],
  ['data-redaction_x', '<span data-redaction_x>x'],
  ['data-redactions', '<span data-redactions>x'],
  ['xdata-redaction', '<span xdata-redaction>x'],
  ['x-data-redaction', '<span x-data-redaction>x'],
  ['data-redaction then a dot', '<span data-redaction.x>x'],
  ['no closing greater-than', '<span data-redaction'],
  ['span with no attribute', '<span>data-redaction</span>'],
  ['spanx', '<spanx data-redaction>'],
  ['span_', '<span_ data-redaction>'],
  ['not a span', '<div data-redaction>x</div>'],
  ['attribute before the span', 'data-redaction <span>'],
  ['span in a comment', '<!-- <span data-redaction> -->'],
  ['span in a code fence', '```\n<span data-redaction>\n```'],
  ['two spans, the second marked', '<span a>x</span> <span data-redaction>y</span>'],
  ['span after a stray greater-than', '<span a> data-redaction'],
  ['astral text in the span', '<span a="\u{1F600}" data-redaction>'],
  ['Kelvin sign in the attribute', '<span data-redaction K>'],
  ['long dotted s in span', '<\u017Fpan data-redaction>'],
  ['plain prose', 'a **bold** word and `code`'],
  ['tangled: many openers then the attribute', '<span a="x"'.repeat(60) + '> data-redaction'],
]

const HTML: ReadonlyArray<readonly [string, string]> = [
  ['empty', ''],
  ['attribute', '<p data-gx-redact="a">x</p>'],
  ['upper-case attribute', '<P DATA-GX-REDACT="a">x</P>'],
  ['mixed case', 'Data-Gx-Redact'],
  ['script literal', '<script>var a = "/*gx:redact:abc*/"</script>'],
  ['script literal in capitals', 'GX:REDACT:'],
  ['script literal mixed case', 'Gx:Redact:'],
  ['script literal without its last colon', 'gx:redact'],
  ['data-gx-redac', 'data-gx-redac'],
  ['data-gx-redac t', 'data-gx-redac t'],
  ['data-gx redact', 'data-gx redact'],
  ['data_gx_redact', 'data_gx_redact'],
  ['data-gx-redact-x', 'data-gx-redact-x'],
  ['gx:redact:', 'gx:redact:'],
  ['gx;redact;', 'gx;redact;'],
  ['redact only', '<redact>'],
  ['Kelvin sign in the script literal', 'gx:redact:'.replace('x', '\u212A')],
  ['long s', 'data-gx-redact'.replace('a', '\u017F')],
  ['astral text before', '\u{1F600} data-gx-redact'],
  ['plain page', '<html><body>nothing</body></html>'],
]

const text = (label: string, value: string): Input => ({ label, text: value })

// ---- files

const FIXED = new Date('2024-01-02T03:04:06Z')
const enc = (value: string) => new TextEncoder().encode(value)
const MARK_SPAN = '<span class="redact-span" data-redaction="" data-label="x">words</span>'
const MARK_PAGE = '<p data-gx-redact="a">x</p>'

function utf16(value: string, littleEndian: boolean, bom = true): Uint8Array {
  const out = new Uint8Array((value.length + (bom ? 1 : 0)) * 2)
  const view = new DataView(out.buffer)
  let at = 0
  if (bom) view.setUint16((at += 2) - 2, 0xfeff, littleEndian)
  for (let i = 0; i < value.length; i++) view.setUint16((at += 2) - 2, value.charCodeAt(i), littleEndian)
  return out
}

async function zipOf(parts: Array<[name: string, data: string | Uint8Array]>, compression: 'STORE' | 'DEFLATE' = 'DEFLATE'): Promise<Uint8Array> {
  const archive = new JSZip()
  for (const [name, data] of parts) archive.file(name, data)
  for (const file of Object.values(archive.files)) file.date = FIXED
  return fixtureBytes(archive, compression)
}

const WORD_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const DOC = (body: string) => `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="${WORD_NS}"><w:body>${body}</w:body></w:document>`
const PLAIN_DOC = DOC('<w:p><w:r><w:t>plain</w:t></w:r></w:p>')
const MARKED = (ns: string) => `<w:document xmlns:w="${WORD_NS}" xmlns:go="${ns}"><w:body><go:redact/></w:body></w:document>`
const SLIDE = (inner: string) => `<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">${inner}</p:sld>`
const PLAIN_SLIDE = SLIDE('<p:cSld/>')
const DECK_EXT = SLIDE(`<p:extLst><p:ext uri="${DECK_URI}"/></p:extLst>`)
const PADDING = ' '.repeat(400)

const FILLER: Array<[string, string]> = [['[Content_Types].xml', '<Types/>'], ['_rels/.rels', '<Relationships/>']]

async function docxInputs(): Promise<Input[]> {
  const docx = (label: string, parts: Array<[string, string | Uint8Array]>, ext = 'docx', compression?: 'STORE' | 'DEFLATE'): Promise<Input> =>
    zipOf([...FILLER, ...parts], compression).then((bytes) => ({ label, bytes, args: { ext } }))
  const out = await Promise.all([
    docx('docx: mark in document.xml', [['word/document.xml', MARKED(OWN_NS)]]),
    docx('docx: mark in document.xml, old namespace', [['word/document.xml', MARKED(OLD_NS)]]),
    docx('docx: namespace spelled in references', [['word/document.xml', `<w:document xmlns:go="${hex(OWN_NS)}"/>`]]),
    docx('docx: redact element, no namespace', [['word/document.xml', '<w:document><redact/></w:document>']]),
    docx('docx: redact element with a prefix', [['word/document.xml', '<w:document><x:redact w:id="1"/></w:document>']]),
    docx('docx: mark in comments.xml', [['word/document.xml', PLAIN_DOC], ['word/comments.xml', MARKED(OWN_NS)]]),
    docx('docx: mark in footnotes.xml', [['word/document.xml', PLAIN_DOC], ['word/footnotes.xml', MARKED(OWN_NS)]]),
    docx('docx: mark in header and footer', [['word/header1.xml', PLAIN_DOC], ['word/footer1.xml', MARKED(OLD_NS)]]),
    docx('docx: mark in a nested path', [['word/glossary/document.xml', MARKED(OWN_NS)]]),
    docx('docx: mark in word/.xml', [['word/.xml', MARKED(OWN_NS)]]),
    docx('docx: mark in word/.rels is not an xml part', [['word/_rels/document.xml.rels', MARKED(OWN_NS)]]),
    docx('docx: mark in word/x.xml.bak', [['word/x.xml.bak', MARKED(OWN_NS)]]),
    docx('docx: mark in WORD/document.xml', [['WORD/document.xml', MARKED(OWN_NS)]]),
    docx('docx: mark in word.xml', [['word.xml', MARKED(OWN_NS)]]),
    docx('docx: mark in a path with a newline', [['word/a\nb.xml', MARKED(OWN_NS)], ['word/c.xml', PLAIN_DOC]]),
    docx('docx: mark only in a path with a newline', [['word/a\nb.xml', MARKED(OWN_NS)]]),
    docx('docx: mark only in a path with a carriage return', [['word/a\rb.xml', MARKED(OWN_NS)]]),
    docx('docx: mark only in a path with a line separator', [['word/a\u2028b.xml', MARKED(OWN_NS)]]),
    docx('docx: mark in customXml', [['word/document.xml', PLAIN_DOC], ['customXml/item1.xml', MARKED(OWN_NS)]]),
    docx('docx: mark in docProps', [['word/document.xml', PLAIN_DOC], ['docProps/core.xml', MARKED(OWN_NS)]]),
    docx('docx: mark in a pptx part', [['word/document.xml', PLAIN_DOC], ['ppt/slides/slide1.xml', DECK_EXT]]),
    docx('docx: no mark', [['word/document.xml', PLAIN_DOC], ['word/comments.xml', PLAIN_DOC]]),
    docx('docx: no word parts', [['other.xml', PLAIN_DOC]]),
    docx('docx: empty package', []),
    docx('docx: mark in a stored part', [['word/document.xml', MARKED(OWN_NS)]], 'docx', 'STORE'),
    docx('docx: a directory entry named like a part', [['word/', '']]),
    docx('docx: mark that is not UTF-8', [['word/document.xml', new Uint8Array([0xff, ...enc(MARKED(OWN_NS))])]]),
    docx('docx: UTF-8 byte order mark before a mark', [['word/document.xml', new Uint8Array([0xef, 0xbb, 0xbf, ...enc(MARKED(OWN_NS))])]]),
    docx('docx: invalid UTF-8 then no mark', [['word/document.xml', new Uint8Array([0xc3, 0x28, 0xe2, 0x82])]]),
    docx('docx: extension with a dot, upper case', [['word/document.xml', MARKED(OWN_NS)]], '.DOCX'),
    docx('docx: extension upper case', [['word/document.xml', MARKED(OWN_NS)]], 'DocX'),
    docx('docx: extension with two dots', [['word/document.xml', MARKED(OWN_NS)]], '..docx'),
    docx('docx: extension with trailing space', [['word/document.xml', MARKED(OWN_NS)]], 'docx '),
    docx('docx: extension empty', [['word/document.xml', MARKED(OWN_NS)]], ''),
    docx('docx: extension of a zip that is a deck', [['ppt/slides/slide1.xml', DECK_EXT]], 'docx'),
    docx('docx: a thousand parts and the mark in the last', [...Array.from({ length: 1000 }, (_, i): [string, string] => [`word/p${i}.xml`, PLAIN_DOC]), ['word/z.xml', MARKED(OWN_NS)]]),
    docx('pptx: mark in a slide', [['ppt/slides/slide1.xml', MARKED(OWN_NS)]], 'pptx'),
    docx('pptx: deck extension in a slide', [['ppt/slides/slide1.xml', DECK_EXT]], 'pptx'),
    docx('pptx: deck extension in a slide, spelled in references', [['ppt/slides/slide1.xml', SLIDE(`<p:ext uri="${dec(DECK_URI)}"/>`)]], 'pptx'),
    docx('pptx: mark in notes', [['ppt/slides/slide1.xml', PLAIN_SLIDE], ['ppt/notesSlides/notesSlide1.xml', MARKED(OWN_NS)]], 'pptx'),
    docx('pptx: mark in a comment part', [['ppt/comments/comment1.xml', MARKED(OLD_NS)]], 'pptx'),
    docx('pptx: mark in a layout', [['ppt/slideLayouts/slideLayout1.xml', MARKED(OWN_NS)]], 'pptx'),
    docx('pptx: mark in presentation.xml', [['ppt/presentation.xml', DECK_EXT]], 'pptx'),
    docx('pptx: mark in customXml', [['ppt/slides/slide1.xml', PLAIN_SLIDE], ['customXml/item1.xml', MARKED(OWN_NS)]], 'pptx'),
    docx('pptx: mark in a word part', [['ppt/slides/slide1.xml', PLAIN_SLIDE], ['word/document.xml', MARKED(OWN_NS)]], 'pptx'),
    docx('pptx: mark in a ppt rels part', [['ppt/_rels/presentation.xml.rels', MARKED(OWN_NS)]], 'pptx'),
    docx('pptx: no mark', [['ppt/slides/slide1.xml', PLAIN_SLIDE]], 'pptx'),
    docx('pptx: empty package', [], 'pptx'),
    docx('pptx: extension upper case with a dot', [['ppt/slides/slide1.xml', DECK_EXT]], '.PPTX'),
    docx('pptx: redact element in a slide', [['ppt/slides/slide1.xml', SLIDE('<p:redact/>')]], 'pptx'),
  ])

  // a part that does not inflate: the mark before it answers, one after it throws
  const corrupt = async (label: string, parts: Array<[string, string]>, name: string, ext = 'docx'): Promise<Input> => ({
    label,
    bytes: breakEntry(await zipOf([...FILLER, ...parts]), name),
    args: { ext },
  })
  const bad = MARKED(OWN_NS) + PADDING
  const fine = PLAIN_DOC + PADDING
  out.push(
    await corrupt('docx: corrupt first part', [['word/document.xml', fine], ['word/comments.xml', fine]], 'word/document.xml'),
    await corrupt('docx: corrupt second part, no mark before', [['word/document.xml', fine], ['word/comments.xml', fine]], 'word/comments.xml'),
    await corrupt('docx: corrupt second part, mark before', [['word/document.xml', bad], ['word/comments.xml', fine]], 'word/comments.xml'),
    await corrupt('docx: corrupt part of another path', [['word/document.xml', bad], ['customXml/item1.xml', fine]], 'customXml/item1.xml'),
    await corrupt('docx: corrupt part after no word part', [['customXml/item1.xml', fine]], 'customXml/item1.xml'),
    await corrupt('pptx: corrupt first slide', [['ppt/slides/slide1.xml', fine]], 'ppt/slides/slide1.xml', 'pptx'),
    await corrupt('pptx: corrupt notes after a mark', [['ppt/slides/slide1.xml', SLIDE(`<p:ext uri="${DECK_URI}"/>`) + PADDING], ['ppt/notesSlides/n.xml', fine]], 'ppt/notesSlides/n.xml', 'pptx'),
  )
  const whole = await zipOf([...FILLER, ['word/document.xml', MARKED(OWN_NS)]])
  const part = (label: string, bytes: Uint8Array, ext = 'docx'): Input => ({ label, bytes, args: { ext } })
  out.push(
    part('docx: not a zip', enc('this is not a zip')),
    part('docx: empty bytes', new Uint8Array(0)),
    part('docx: PK only', enc('PK')),
    part('docx: zip cut short', whole.slice(0, whole.length - 10)),
    part('docx: zip cut in half', whole.slice(0, whole.length >> 1)),
    part('docx: zip with a prefix', new Uint8Array([...enc('junk'), ...whole])),
    part('docx: zip with a suffix', new Uint8Array([...whole, ...enc('trailing')])),
    part('docx: end record only', new Uint8Array([0x50, 0x4b, 0x05, 0x06, ...new Uint8Array(18)])),
    part('pptx: not a zip', enc('this is not a zip'), 'pptx'),
    part('pptx: empty bytes', new Uint8Array(0), 'pptx'),
  )
  return out
}

function textFileInputs(): Input[] {
  const file = (label: string, bytes: Uint8Array, ext: string): Input => ({ label, bytes, args: { ext } })
  const out: Input[] = []
  for (const ext of ['md', 'markdown', 'MD', '.md', 'Markdown']) {
    out.push(
      file(`${ext}: UTF-8 span`, enc(`# title\n${MARK_SPAN}`), ext),
      file(`${ext}: UTF-8 no span`, enc('# title\nplain'), ext),
      file(`${ext}: UTF-16LE with a byte order mark`, utf16(MARK_SPAN, true), ext),
      file(`${ext}: UTF-16BE with a byte order mark`, utf16(MARK_SPAN, false), ext),
      file(`${ext}: UTF-16LE without a byte order mark`, utf16(MARK_SPAN, true, false), ext),
    )
  }
  for (const ext of ['html', 'htm', 'HTML', '.htm', 'Htm']) {
    out.push(
      file(`${ext}: UTF-8 mark`, enc(`<html>${MARK_PAGE}</html>`), ext),
      file(`${ext}: UTF-8 no mark`, enc('<html><p>plain</p></html>'), ext),
      file(`${ext}: UTF-16LE with a byte order mark`, utf16(MARK_PAGE, true), ext),
      file(`${ext}: UTF-16BE with a byte order mark`, utf16(MARK_PAGE, false), ext),
      file(`${ext}: upper-case mark`, enc(MARK_PAGE.toUpperCase()), ext),
    )
  }
  const high = new Uint8Array(0x20)
  high.forEach((_, i) => (high[i] = 0x80 + i))
  const cp1252 = (ext: string, mark: string, label: string): Input[] => [
    file(`${ext}: windows-1252 high bytes before a mark (${label})`, new Uint8Array([...high, ...enc(mark), ...high]), ext),
    file(`${ext}: windows-1252 high bytes, no mark (${label})`, new Uint8Array([...high, ...enc('plain'), ...high]), ext),
    file(`${ext}: windows-1252 undefined bytes (${label})`, new Uint8Array([0x81, 0x8d, 0x8f, 0x90, 0x9d, ...enc(mark)]), ext),
  ]
  out.push(...cp1252('md', MARK_SPAN, 'span'), ...cp1252('html', MARK_PAGE, 'page'))
  out.push(
    file('md: UTF-8 byte order mark then a span', new Uint8Array([0xef, 0xbb, 0xbf, ...enc(MARK_SPAN)]), 'md'),
    file('html: UTF-8 byte order mark then a mark', new Uint8Array([0xef, 0xbb, 0xbf, ...enc(MARK_PAGE)]), 'html'),
    file('md: UTF-8 span in non-ASCII text', enc(`가나다 ${MARK_SPAN} \u{1F600}`), 'md'),
    file('html: UTF-8 mark in non-ASCII text', enc(`가나다 ${MARK_PAGE} \u{1F600}`), 'html'),
    file('md: empty', new Uint8Array(0), 'md'),
    file('html: empty', new Uint8Array(0), 'html'),
    file('md: FF only', new Uint8Array([0xff]), 'md'),
    file('md: FF FE only', new Uint8Array([0xff, 0xfe]), 'md'),
    file('md: FE FF only', new Uint8Array([0xfe, 0xff]), 'md'),
    file('md: UTF-16LE odd length', new Uint8Array([...utf16(MARK_SPAN, true), 0x41]), 'md'),
    file('html: UTF-16BE odd length', new Uint8Array([...utf16(MARK_PAGE, false), 0x41]), 'html'),
    file('html: UTF-16LE lone surrogate before a mark', new Uint8Array([0xff, 0xfe, 0x00, 0xd8, ...utf16(MARK_PAGE, true, false)]), 'html'),
    file('html: UTF-16LE of a mark broken by a lone surrogate', new Uint8Array([0xff, 0xfe, ...utf16('data-gx-', true, false), 0x00, 0xd8, ...utf16('redact', true, false)]), 'html'),
    file('html: UTF-16 byte order mark that is not one', new Uint8Array([0xfe, 0xfe, ...enc(MARK_PAGE)]), 'html'),
    file('html: UTF-16LE mark with its byte order swapped', utf16(MARK_PAGE, false).map((b, i) => (i < 2 ? [0xff, 0xfe][i]! : b)), 'html'),
    file('md: tangled spans', enc('<span a="x"'.repeat(80) + '> data-redaction'), 'md'),
    file('md: tangled spans that stay within the budget', enc('<span a="x"'.repeat(8) + '> data-redaction'), 'md'),
    file('md: long span-less text', enc('<span '.repeat(200)), 'md'),
  )
  return out
}

const EXTENSIONS: Input[] = [
  ...HIDDEN_CONTENT_EXTENSIONS.flatMap((ext) => [ext, ext.toUpperCase(), `.${ext}`, `${ext} `, `${ext}x`, `x${ext}`].map((spelled): Input => ({
    label: `extension ${JSON.stringify(spelled)} over an empty file`,
    bytes: new Uint8Array(0),
    args: { ext: spelled },
  }))),
  ...['', '.', 'txt', 'pdf', 'doc', 'ppt', 'xls', 'odt', 'epub', 'csv', 'json', 'hwp', '.docx.', 'docx.xml', 'MARKDOWN ', '\u212Aml', 'htm\u0131', 'ms'].map(
    (ext): Input => ({ label: `unknown extension ${JSON.stringify(ext)}`, bytes: enc(`${MARK_SPAN}${MARK_PAGE}`), args: { ext } }),
  ),
  { label: 'unknown extension over marked text', bytes: enc(MARK_SPAN), args: { ext: 'txt' } },
  { label: 'Kelvin sign spells markdown', bytes: enc(MARK_SPAN), args: { ext: 'mar\u212Adown' } },
  { label: 'extension HTML in capitals', bytes: enc(MARK_PAGE), args: { ext: 'HTML' } },
  { label: 'a dot and a dot', bytes: enc(MARK_PAGE), args: { ext: '..html' } },
]

async function workbookInputs(): Promise<Input[]> {
  const seeds = await xlsxInputs()
  const wanted = seeds.filter(({ label, args = {} }) =>
    !('formulaScanMaxBytes' in args) && (/^(withheld|derived): /.test(label) || [
      'values and shared strings', 'formulas cached, uncomputed and shared', 'workbook missing', 'workbook unclosed tag', 'not a zip', 'empty bytes',
    ].includes(label)))
  const out: Input[] = []
  for (const { label, bytes, mutate } of wanted) {
    if (bytes === undefined) continue
    out.push({ label: `xlsx: ${label}`, bytes, args: { ext: 'xlsx' }, ...(mutate === false ? { mutate } : {}) })
  }
  const first = wanted.find(({ bytes }) => bytes !== undefined && bytes[0] === 0x50)
  if (first?.bytes !== undefined) {
    out.push(
      { label: 'xlsm: a workbook', bytes: first.bytes, args: { ext: 'xlsm' } },
      { label: 'xlsx: extension upper case', bytes: first.bytes, args: { ext: '.XLSX' } },
      { label: 'docx: a workbook is no document', bytes: first.bytes, args: { ext: 'docx' } },
      { label: 'pptx: a workbook is no deck', bytes: first.bytes, args: { ext: 'pptx' } },
    )
  }
  const plain = (label: string, bytes: Uint8Array, ext = 'xlsx'): Input => ({ label, bytes, args: { ext } })
  out.push(
    plain('xlsx: not starting with PK', enc(MARK_SPAN)),
    plain('xlsx: starting with Pk', enc('Pk\u0003\u0004')),
    plain('xlsx: starting with pK', enc('pK\u0003\u0004')),
    plain('xlsx: starting with P only', enc('P')),
    plain('xlsx: PK only', enc('PK')),
    plain('xlsx: empty', new Uint8Array(0)),
    plain('xlsm: not starting with PK', enc('not a workbook'), 'xlsm'),
    plain('xlsx: a docx with a mark is no workbook', await zipOf([...FILLER, ['word/document.xml', MARKED(OWN_NS)]])),
    plain('xlsx: PK and junk', new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0])),
  )
  return out
}

async function fileInputs(): Promise<Input[]> {
  return [...EXTENSIONS, ...textFileInputs(), ...(await docxInputs()), ...(await workbookInputs())]
}

const extensionOf = ({ args = {} }: Input): string => String(args.ext ?? '')

const textOf = (input: Input): string => {
  if (input.text === undefined) throw new Error(`hidden-content-cases: ${input.label} has no text`)
  return input.text
}

export const SPECS: Spec[] = [
  {
    fn: 'xmlHoldsMark',
    extensions: [],
    built: () => XML.map(([label, value]) => text(label, value)),
    call: (input) => xmlHoldsMark(textOf(input)),
    mutateText: true,
  },
  {
    fn: 'markdownHoldsMark',
    extensions: ['md', 'markdown'],
    built: () => MARKDOWN.map(([label, value]) => text(label, value)),
    call: (input) => markdownHoldsMark(textOf(input)),
    mutateText: true,
    seedCorpus: false,
  },
  {
    fn: 'htmlHoldsMark',
    extensions: ['html', 'htm'],
    built: () => HTML.map(([label, value]) => text(label, value)),
    call: (input) => htmlHoldsMark(textOf(input)),
    mutateText: true,
    seedCorpus: false,
  },
  {
    fn: 'fileHoldsHiddenContent',
    extensions: [...HIDDEN_CONTENT_EXTENSIONS],
    built: fileInputs,
    call: (input) => fileHoldsHiddenContent(input.bytes ?? new Uint8Array(0), extensionOf(input)),
    corpusExtension: true,
    seedCorpus: false,
  },
]
