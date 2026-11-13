import JSZip from 'jszip'
import { OWN_REDACT_NS, REDACT_NAMESPACES } from '../../packages/agent-core/src/redact-range'
import { docxToText } from './reference/docx'
import type { Input, Spec } from './spec'
import { fixtureBytes } from './zip-fixture'

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const doc = (body: string) => `<?xml version="1.0"?><w:document ${W}><w:body>${body}</w:body></w:document>`
const p = (inner: string, ppr = '') => `<w:p>${ppr ? `<w:pPr>${ppr}</w:pPr>` : ''}${inner}</w:p>`
const r = (text: string, rpr = '') => `<w:r>${rpr ? `<w:rPr>${rpr}</w:rPr>` : ''}<w:t xml:space="preserve">${text}</w:t></w:r>`
const rels = (items: Array<[string, string, string?]>) =>
  `<Relationships>${items
    .map(([type, target, mode], n) => `<Relationship Id="r${n}" Type="${R}/${type}" Target="${target}"${mode ? ` TargetMode="${mode}"` : ''}/>`)
    .join('')}</Relationships>`
const styles = (defs: string) => `<w:styles ${W}>${defs}</w:styles>`
const style = (id: string, body: string, type = 'paragraph') =>
  `<w:style w:type="${type}" w:styleId="${id}">${body}</w:style>`
const drawing = (docPr: string) =>
  `<w:r><w:drawing><wp:inline><wp:docPr id="1" name="Picture 1"${docPr}/></wp:inline></w:drawing></w:r>`

async function zip(parts: Record<string, string | Uint8Array>, compression: 'STORE' | 'DEFLATE' = 'DEFLATE') {
  const z = new JSZip()
  for (const [name, data] of Object.entries(parts)) z.file(name, data)
  return fixtureBytes(z, compression)
}

/** Replace the first compressed byte of `name` with 0xFF: a reserved deflate block type, so JSZip throws when that part is read. */
function breakEntry(bytes: Uint8Array, name: string): Uint8Array {
  const out = bytes.slice()
  const view = new DataView(out.buffer)
  const nameBytes = new TextEncoder().encode(name)
  for (let at = 0; at + 30 < out.length; at++) {
    if (view.getUint32(at, true) !== 0x04034b50) continue
    const nameLen = view.getUint16(at + 26, true)
    const extraLen = view.getUint16(at + 28, true)
    const found = out.subarray(at + 30, at + 30 + nameLen)
    if (nameLen === nameBytes.length && found.every((b, i) => b === nameBytes[i])) {
      out[at + 30 + nameLen + extraLen] = 0xff
      return out
    }
  }
  throw new Error(`entry ${name} not found`)
}

const STYLES = styles(
  style('Heading2', '<w:name w:val="heading 2"/>') +
    style('Custom', '<w:name w:val="Fancy"/><w:basedOn w:val="Heading2"/>') +
    style('Titled', '<w:name w:val="Title"/>') +
    style('Outline', '<w:name w:val="o"/><w:pPr><w:outlineLvl w:val="3"/></w:pPr>') +
    style('Body9', '<w:name w:val="b"/><w:pPr><w:outlineLvl w:val="9"/></w:pPr>') +
    style('Zero', '<w:name w:val="heading 0"/><w:basedOn w:val="Heading2"/>') +
    style('ListStyle', '<w:name w:val="List"/><w:pPr><w:numPr><w:numId w:val="4"/></w:numPr></w:pPr>') +
    style('ListChild', '<w:name w:val="lc"/><w:basedOn w:val="ListStyle"/>') +
    style('NoList', '<w:name w:val="nl"/><w:basedOn w:val="ListStyle"/><w:pPr><w:numPr><w:numId w:val="0"/></w:numPr></w:pPr>') +
    style('CycleA', '<w:name w:val="ca"/><w:basedOn w:val="CycleB"/>') +
    style('CycleB', '<w:name w:val="cb"/><w:basedOn w:val="CycleA"/><w:pPr><w:outlineLvl w:val="1"/></w:pPr>') +
    style('Self', '<w:name w:val="s"/><w:basedOn w:val="Self"/>') +
    style('Orphan', '<w:name w:val="or"/><w:basedOn w:val="Missing"/>') +
    style('EmptyBase', '<w:name w:val="eb"/><w:basedOn w:val=""/>') +
    style('CharStyle', '<w:name w:val="heading 1"/>', 'character') +
    style('Dup', '<w:name w:val="heading 4"/>') +
    style('Dup', '<w:name w:val="plain"/>') +
    // U+0131 is not `i` under /i: neither of these names a heading
    style('DotlessHeading', '<w:name w:val="head\u0131ng 3"/>') +
    style('DotlessTitle', '<w:name w:val="T\u0131TLE"/>'),
)

const RICH_BODY = doc(
  p(r('Plain')) +
    p(r('Styled heading'), '<w:pStyle w:val="Heading2"/>') +
    p(r('Inherited'), '<w:pStyle w:val="Custom"/>') +
    p(r('Title'), '<w:pStyle w:val="Titled"/>') +
    p(r('Outline'), '<w:pStyle w:val="Outline"/>') +
    p(r('Body9'), '<w:pStyle w:val="Body9"/>') +
    p(r('Zero'), '<w:pStyle w:val="Zero"/>') +
    p(r('Unknown Heading7'), '<w:pStyle w:val="Heading7"/>') +
    p(r('Unknown other'), '<w:pStyle w:val="Nope"/>') +
    p(r('List style'), '<w:pStyle w:val="ListStyle"/>') +
    p(r('List child'), '<w:pStyle w:val="ListChild"/>') +
    p(r('No list'), '<w:pStyle w:val="NoList"/>') +
    p(r('Off'), '<w:pStyle w:val="ListStyle"/><w:numPr><w:numId w:val="0"/></w:numPr>') +
    p(r('Direct list'), '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr>') +
    p(r('Cycle'), '<w:pStyle w:val="CycleA"/>') +
    p(r('Self'), '<w:pStyle w:val="Self"/>') +
    p(r('Orphan'), '<w:pStyle w:val="Orphan"/>') +
    p(r('Empty base'), '<w:pStyle w:val="EmptyBase"/>') +
    p(r('Char style'), '<w:pStyle w:val="CharStyle"/>') +
    p(r('Dup'), '<w:pStyle w:val="Dup"/>') +
    p(r('Dotless heading'), '<w:pStyle w:val="DotlessHeading"/>') +
    p(r('Dotless title'), '<w:pStyle w:val="DotlessTitle"/>') +
    p(r('Direct outline 9'), '<w:outlineLvl w:val="9"/>') +
    p(r('Direct outline 7'), '<w:outlineLvl w:val="7"/>') +
    p(r('Empty val'), '<w:pStyle w:val=""/>') +
    p(r('Hidden', '<w:vanish/>') + r('Shown', '<w:vanish w:val="0"/>') + r('Alsofalse', '<w:vanish w:val="false"/>') + r(' visible')) +
    p('<w:r><w:rPr><w:vanish/></w:rPr><w:tab/><w:br/><w:noBreakHyphen/><w:sym w:font="Symbol" w:char="F0B7"/></w:r>' + r('after hidden')) +
    p('<w:r><w:t>a</w:t><w:tab/><w:t>b</w:t><w:ptab/><w:br/><w:t>c</w:t><w:br w:type="page"/><w:cr/><w:br w:type="column"/><w:noBreakHyphen/><w:sym w:char="0041"/><w:sym w:char="41"/><w:sym w:char="00e9"/></w:r>') +
    p(r('&amp;&lt;&gt;&quot;&apos;&#65;&#x42;&#X43;&#0;&nbsp;&#x1F600;&#xD83D;&#xDE00;')) +
    p('<w:del><w:r><w:delText>deleted</w:delText></w:r></w:del><w:ins>' + r('inserted') + '</w:ins><w:moveFrom>' + r('moved') + '</w:moveFrom>') +
    p('<w:r><w:instrText> PAGE </w:instrText></w:r><w:r><w:t>field</w:t></w:r><w:del/>' + r('-tail')) +
    p('<mc:AlternateContent><mc:Choice>' + r('choice') + '</mc:Choice><mc:Fallback>' + r('fallback') + '</mc:Fallback></mc:AlternateContent>') +
    p('<w:r><w:t/>' + '<w:t>x</w:t></w:r>') +
    p('See' + drawing(' descr="a &amp; b"') + r('below')) +
    p(drawing(' title="only title"') + drawing(' descr="" title="fallback title"') + drawing(' hidden="1" descr="hid"') + drawing(' hidden="true" descr="hid2"') + drawing(' hidden="0" descr="shown0"') + drawing(' xhidden="1" descr="prefixed"') + drawing(' adescr="no"')) +
    p('<w:r><w:rPr><w:vanish/></w:rPr><w:drawing><wp:docPr descr="hidden run"/></w:drawing></w:r>') +
    '<w:tbl><w:tblPr><w:tblStyle w:val="T"/></w:tblPr><w:tblGrid><w:gridCol/></w:tblGrid>' +
    '<w:tr><w:trPr/><w:tc><w:tcPr/>' + p(r('A1')) + p(r('A1b')) + '</w:tc><w:tc>' + p('<w:r><w:t>line</w:t><w:br/><w:t xml:space="preserve">  next </w:t></w:r>') + '</w:tc><w:tc/></w:tr>' +
    '<w:tr><w:tc>' + '<w:tbl><w:tr><w:tc>' + p(r('inner1')) + '</w:tc><w:tc>' + p(r('inner2')) + '</w:tc></w:tr><w:tr/></w:tbl>' + p(r('after inner')) + '</w:tc></w:tr>' +
    '</w:tbl>' +
    '<w:tc>' + p(r('stray cell')) + '</w:tc><w:tr/>' +
    '<w:sdt><w:sdtContent>' + p(r('in sdt')) + '</w:sdtContent></w:sdt>' +
    p('<w:r><w:pict><v:textbox><w:txbxContent>' + p(r('box text')) + '</w:txbxContent></v:textbox></w:pict></w:r>' + r('outer')) +
    '<w:p/>' + p(r('<!-- c -->')) + '</w:p>' + p(r('after stray close')) +
    '<w:sectPr><w:headerReference/>' + p(r('in sectPr')) + '</w:sectPr>',
)

const NOTES = (tag: 'footnote' | 'endnote') =>
  `<w:${tag}s ${W}>` +
  `<w:${tag} w:type="separator" w:id="-1">${p('<w:r><w:separator/></w:r>')}</w:${tag}>` +
  `<w:${tag} w:type="continuationSeparator" w:id="0">${p(r('cont'))}</w:${tag}>` +
  `<w:${tag} w:type="continuationNotice" w:id="9">${p(r('notice'))}</w:${tag}>` +
  `<w:${tag} w:id="1">${p(r('first')) + p(r('second'), '<w:pStyle w:val="Heading2"/>')}</w:${tag}>` +
  `<w:${tag} w:id="2"/>` +
  `<w:${tag} w:id="3">${'<w:tbl><w:tr><w:tc>' + p(r('n1')) + '</w:tc><w:tc>' + p(r('n2')) + '</w:tc></w:tr></w:tbl>'}</w:${tag}>` +
  `<w:${tag} w:id="4">${p('')}</w:${tag}>` +
  `</w:${tag}s>` + p(r('outside notes'))

const HDR = (text: string) => `<w:hdr ${W}>${p(r(text))}</w:hdr>`
const DOC_RELS = rels([
  ['header', 'header1.xml'],
  ['header', './header1.xml'],
  ['footer', '/word/footer1.xml'],
  ['comments', 'comments.xml'],
  ['header', 'http://example.org/h.xml', 'External'],
  ['image', 'media/a.png'],
  ['footer', 'missing.xml'],
  ['footer', 'empty.xml'],
  ['header', '%ZZ'],
  ['header', '..\\word\\header2.xml'],
])

const RICH = {
  '[Content_Types].xml': '<Types/>',
  'word/document.xml': RICH_BODY,
  'word/styles.xml': STYLES,
  'word/footnotes.xml': NOTES('footnote'),
  'word/endnotes.xml': NOTES('endnote'),
  'word/_rels/document.xml.rels': DOC_RELS,
  'word/header1.xml': HDR('Header text'),
  'word/header2.xml': HDR('Backslash header'),
  'word/footer1.xml': `<w:ftr ${W}>${p(r('Footer text'))}</w:ftr>`,
  'word/comments.xml': `<w:comments ${W}><w:comment w:id="0">${p(r('A comment'))}</w:comment></w:comments>`,
  'word/empty.xml': '',
}

const MAX_CHARS = [undefined, 0, 1, 5, 6, 7, 30, 31, 200, 400, 600, Number.NaN, -1, Infinity]

async function inputs(): Promise<Input[]> {
  const out: Input[] = []
  const add = (label: string, bytes: Uint8Array, maxChars?: number) =>
    out.push({ label, bytes, args: maxChars === undefined ? {} : { maxChars: String(maxChars) } })

  const rich = await zip(RICH)
  for (const maxChars of MAX_CHARS) add(`rich maxChars=${maxChars}`, rich, maxChars)
  add('rich stored', await zip(RICH, 'STORE'))

  const imageOnly = (body: string, extra: Record<string, string> = {}) =>
    zip({ 'word/document.xml': doc(body), ...extra })
  add('image-only one', await imageOnly(p(drawing(''))))
  add('image-only two pict', await imageOnly(p('<w:r><w:pict/></w:r>') + p(drawing('')) + p(r('   '))))
  add('image-only then notes', await imageOnly(p(drawing('')), { 'word/footnotes.xml': NOTES('footnote') }))
  add('image-only maxChars 1', await imageOnly('<w:p/>' + p(drawing(''))), 1)
  add('image with alt is text', await imageOnly(p(drawing(' descr="alt"'))))
  add('empty body', await imageOnly(''))
  add('only blank paras', await imageOnly('<w:p/><w:p/>'))

  // withheld ("hidden from AI") runs
  const [OWN, OLD] = [OWN_REDACT_NS, REDACT_NAMESPACES[1]!]
  const GO = (ns: string, prefix = 'go') => `xmlns:${prefix}="${ns}"`
  const mark = (label: string | null, prefix = 'go') => `<${prefix}:redact${label === null ? '' : ` w:label="${label}"`}/>`
  const wr = (text: string, label?: string | null, prefix = 'go') =>
    `<w:r>${label === undefined ? '' : `<w:rPr>${mark(label, prefix)}</w:rPr>`}<w:t>${text}</w:t></w:r>`
  const rdoc = (body: string, decl = GO(OWN)) =>
    `<?xml version="1.0"?><w:document ${W} ${decl}><w:body>${body}</w:body></w:document>`
  const redactCase = async (label: string, body: string, decl?: string, maxChars?: number, extra: Record<string, string> = {}) =>
    add(label, await zip({ 'word/document.xml': rdoc(body, decl), ...extra }), maxChars)
  await redactCase('redact one run', p(wr('keep ') + wr('secret', 'Pay') + wr(' tail')))
  await redactCase('redact adjacent same label', p(wr('a') + wr('s1', 'Pay') + wr('s2', 'Pay') + wr('b')))
  await redactCase('redact adjacent different labels', p(wr('s1', 'Pay') + wr('s2', 'Name') + wr('b')))
  await redactCase('redact same label split by plain run', p(wr('s1', 'Pay') + wr('plain') + wr('s2', 'Pay')))
  await redactCase('redact same label across paragraphs', p(wr('s1', 'Pay')) + p(wr('s2', 'Pay')))
  await redactCase('redact label with entities', p(wr('s', 'A &amp; B &#65; &lt;x&gt;')))
  await redactCase('redact label over 40 units', p(wr('s', 'L'.repeat(60))))
  await redactCase('redact label with lone surrogate ref', p(wr('s', 'a&#xD800;')))
  await redactCase('redact empty label', p(wr('s', '')))
  await redactCase('redact missing label', p(wr('s', null)))
  await redactCase('redact label attr substring only', p(`<w:r><w:rPr><go:redact xw:label="x"/></w:rPr><w:t>s</w:t></w:r>`))
  await redactCase('redact mark in paragraph mark rPr', p(wr('text'), `<w:rPr>${mark('Pay')}</w:rPr>`))
  await redactCase('redact mark after run label stays with run', p(`<w:r><w:rPr>${mark('One')}${mark('Two')}</w:rPr><w:t>s</w:t></w:r>`))
  await redactCase('redact self-closing run', p('<w:r/>' + wr('a') + `<w:r>${mark('Pay')}</w:r>` + wr('b')))
  await redactCase('redact run without text', p(`<w:r>${mark('Pay')}</w:r>`))
  await redactCase('redact unprefixed own ns', p(`<w:r><w:rPr><redact xmlns="${OWN}" w:label="x"/></w:rPr><w:t>s</w:t></w:r>`), '')
  await redactCase('redact unprefixed single-quoted ns', p(`<w:r><w:rPr><redact xmlns='${OLD}' w:label="x"/></w:rPr><w:t>s</w:t></w:r>`), '')
  await redactCase('redact unprefixed unknown ns', p(`<w:r><w:rPr><redact xmlns="urn:other" w:label="x"/></w:rPr><w:t>s</w:t></w:r>`), '')
  await redactCase('redact unprefixed no xmlns in namespaced part', p(`<w:r><w:rPr><redact w:label="x"/></w:rPr><w:t>s</w:t></w:r>`))
  await redactCase('redact unprefixed no xmlns in plain part', p(`<w:r><w:rPr><redact w:label="x"/></w:rPr><w:t>s</w:t></w:r>`), '')
  await redactCase('redact prefix bound to old ns', p(wr('s', 'Pay', 'o')), GO(OLD, 'o'))
  await redactCase('redact prefix bound to own ns', p(wr('s', 'Pay', 'n')), GO(OWN, 'n'))
  await redactCase('redact both prefixes', p(wr('s', 'Pay', 'o') + wr('t', 'Name', 'n')), GO(OLD, 'o') + ' ' + GO(OWN, 'n'))
  await redactCase('redact prefix unbound', p(wr('s', 'Pay', 'x')), '')
  await redactCase('redact prefix bound to other ns', p(wr('s', 'Pay', 'x')), GO('urn:other', 'x'))
  await redactCase('redact prefix bound with single quotes', p(wr('s', 'Pay', 'x')), `xmlns:x='${OWN}'`)
  await redactCase('redact word merely starting redact', p(wr('a') + '<go:redactor/>' + wr('b')), GO(OWN))
  await redactCase('redact label single quotes', p(`<w:r><w:rPr><go:redact w:label='Pay'/></w:rPr><w:t>s</w:t></w:r>`))
  await redactCase('redact label spaces around eq', p(`<w:r><w:rPr><go:redact w:label = "Pay"/></w:rPr><w:t>s</w:t></w:r>`))
  await redactCase('redact label spaces around eq single quotes', p(`<w:r><w:rPr><go:redact w:label	=
'Pay'/></w:rPr><w:t>s</w:t></w:r>`))
  await redactCase('redact label on next line', p(`<w:r><w:rPr><go:redact
  w:label="Pay"/></w:rPr><w:t>s</w:t></w:r>`))
  await redactCase('redact label tab separated', p(`<w:r><w:rPr><go:redact	w:label="Pay"	/></w:rPr><w:t>s</w:t></w:r>`))
  await redactCase('redact self-closing with space', p(`<w:r><w:rPr><go:redact w:label="Pay" /></w:rPr><w:t>s</w:t></w:r>`))
  await redactCase('redact label single quoted with double quote inside', p(`<w:r><w:rPr><go:redact w:label='a"b'/></w:rPr><w:t>s</w:t></w:r>`))
  await redactCase('redact label double quoted with apostrophe', p(`<w:r><w:rPr><go:redact w:label="it's"/></w:rPr><w:t>s</w:t></w:r>`))
  await redactCase('redact label empty single quotes', p(`<w:r><w:rPr><go:redact w:label=''/></w:rPr><w:t>s</w:t></w:r>`))
  await redactCase('redact label unquoted refused', p(`<w:r><w:rPr><go:redact w:label=Pay/></w:rPr><w:t>s</w:t></w:r>`))
  await redactCase('redact label unterminated quote refused', p(`<w:r><w:rPr><go:redact w:label="Pay/></w:rPr><w:t>s</w:t></w:r>`))
  await redactCase('redact label first of two', p(`<w:r><w:rPr><go:redact w:label="One" w:label="Two"/></w:rPr><w:t>s</w:t></w:r>`))
  await redactCase('redact label in other attr value', p(`<w:r><w:rPr><go:redact w:note=" w:label='In'" w:label="Out"/></w:rPr><w:t>s</w:t></w:r>`))
  await redactCase('redact label gt inside value', p(`<w:r><w:rPr><go:redact w:label="a>b"/></w:rPr><w:t>s</w:t></w:r>`))
  await redactCase('redact label slash gt inside value', p(`<w:r><w:rPr><go:redact w:label="a/>b"/></w:rPr><w:t>s</w:t></w:r>`))
  await redactCase('redact open and close form', p(`<w:r><w:rPr><go:redact w:label="Pay"></go:redact></w:rPr><w:t>s</w:t></w:r>`))
  // a mark whose attribute values hold `>` or `/>`, and markup that is not a tag
  await redactCase('redact run attr holds slash gt', p(`<w:r w:x="a/>b"><w:rPr>${mark('Pay')}</w:rPr><w:t>s</w:t></w:r>` + r('after')))
  await redactCase('redact run attr holds gt single quotes', p(`<w:r w:x='a>b'><w:rPr>${mark('Pay')}</w:rPr><w:t>s</w:t></w:r>` + r('after')))
  await redactCase('redact comment holds mark', p(`<w:r><!-- ${mark('Pay')} --><w:t>s</w:t></w:r>` + r('after')))
  await redactCase('redact comment holds tags', p(`<w:r><w:rPr>${mark('Pay')}</w:rPr><!-- </w:r><w:r> --><w:t>s</w:t></w:r>` + r('after')))
  await redactCase('redact unterminated comment', p(wr('a') + '<!-- never closed' + wr('s', 'Pay')))
  await redactCase('redact processing instruction', p(`<w:r><?x ${mark('Pay')} ?><w:t>s</w:t></w:r>` + r('after')))
  await redactCase('redact declaration skipped', p(`<w:r><!DOCTYPE x><w:rPr>${mark('Pay')}</w:rPr><w:t>s</w:t></w:r>` + r('after')))
  await redactCase('redact cdata text read', p(`<w:r><w:t><![CDATA[a <b> &amp; c]]></w:t></w:r>`))
  await redactCase('redact cdata text in withheld run', p(`<w:r><w:rPr>${mark('Pay')}</w:rPr><w:t><![CDATA[secret]]></w:t></w:r>` + r('after')))
  await redactCase('redact cdata holds mark', p(`<w:r><w:t><![CDATA[${mark('Pay')}]]></w:t></w:r>`))
  await redactCase('redact unterminated cdata', p(wr('a') + '<w:r><w:t><![CDATA[never closed</w:t></w:r>' + wr('s', 'Pay')))
  await redactCase('redact stray lt in text', p(`<w:r><w:t>a < b</w:t></w:r>` + wr('s', 'Pay')))
  await redactCase('redact stray lt before gt', p(`<w:r><w:t><>x</w:t></w:r>` + wr('s', 'Pay')))
  await redactCase('redact unterminated quote in tag', p(`<w:r><w:t w:x="oops>text</w:t></w:r>` + wr('s', 'Pay')))
  await redactCase('redact unterminated single quote in tag', p(`<w:r><w:t w:x='oops>text</w:t></w:r>` + wr('s', 'Pay')))
  await redactCase('redact closing tag with attrs', p(`<w:r><w:rPr>${mark('Pay')}</w:rPr><w:t>s</w:t></w:r w:x="1">` + r('after')))
  // namespace declarations in any quotes, white space around `=`
  await redactCase('redact xmlns prefix spaced eq', p(wr('s', 'Pay', 'x')), `xmlns:x = "${OWN}"`)
  await redactCase('redact xmlns prefix single quotes spaced', p(wr('s', 'Pay', 'x')), `xmlns:x\n=\t'${OLD}'`)
  await redactCase('redact xmlns prefix other ns spaced', p(wr('s', 'Pay', 'x')), `xmlns:x = 'urn:other'`)
  await redactCase('redact xmlns prefix unquoted refused', p(wr('s', 'Pay', 'x')), `xmlns:x=${OWN}`)
  await redactCase('redact xmlns prefix space before colon refused', p(wr('s', 'Pay', 'x')), `xmlns :x="${OWN}"`)
  await redactCase('redact xmlns prefix mixed quotes refused', p(wr('s', 'Pay', 'x')), `xmlns:x="${OWN}'`)
  await redactCase('redact unprefixed xmlns spaced eq', p(`<w:r><w:rPr><redact xmlns = "${OWN}" w:label="x"/></w:rPr><w:t>s</w:t></w:r>`), '')
  await redactCase('redact unprefixed xmlns spaced eq single', p(`<w:r><w:rPr><redact xmlns\n=\n'${OLD}' w:label="x"/></w:rPr><w:t>s</w:t></w:r>`), '')
  await redactCase('redact unprefixed xmlns other ns spaced', p(`<w:r><w:rPr><redact xmlns = 'urn:other' w:label="x"/></w:rPr><w:t>s</w:t></w:r>`), '')
  await redactCase('redact unprefixed xmlns after newline', p(`<w:r><w:rPr><redact\nxmlns='${OWN}'\nw:label='x'/></w:rPr><w:t>s</w:t></w:r>`), '')
  await redactCase('redact unprefixed xmlns attr substring only', p(`<w:r><w:rPr><redact axmlns="${OWN}" w:label="x"/></w:rPr><w:t>s</w:t></w:r>`), '')
  await redactCase('redact unprefixed xmlns in other value', p(`<w:r><w:rPr><redact w:note=' xmlns="${OWN}"' w:label="x"/></w:rPr><w:t>s</w:t></w:r>`), '')
  await redactCase('redact in nested text box', p(`<w:r><w:rPr>${mark('Box')}</w:rPr><w:pict><v:textbox><w:txbxContent>${p(r('inner box'))}</w:txbxContent></v:textbox></w:pict></w:r>` + r('outer')))
  await redactCase('redact text box in plain run holds withheld run', p(`<w:r><w:pict><v:textbox><w:txbxContent>${p(wr('boxed', 'Pay') + r('ok'))}</w:txbxContent></v:textbox></w:pict></w:r>` + r('outer')))
  await redactCase('redact tab and break inside', p(`<w:r><w:rPr>${mark('Pay')}</w:rPr><w:t>a</w:t><w:tab/><w:br/><w:noBreakHyphen/><w:sym w:char="0041"/><w:ptab/><w:cr/>${'<wp:docPr descr="alt"/>'}</w:r>` + r('after')))
  await redactCase('redact mark late in run', p(`<w:r><w:t>before</w:t><w:tab/><w:rPr>${mark('Late')}</w:rPr><w:t>after</w:t></w:r>` + r('x')))
  await redactCase('redact alt text in withheld run', p(`<w:r><w:rPr>${mark('Pic')}</w:rPr>${'<w:drawing><wp:docPr descr="secret alt"/></w:drawing>'}</w:r>`))
  await redactCase('redact in table cell', `<w:tbl><w:tr><w:tc>${p(wr('s', 'Cell'))}</w:tc><w:tc>${p(r('b'))}</w:tc></w:tr></w:tbl>`)
  await redactCase('redact in heading', p(wr('s', 'Pay'), '<w:pStyle w:val="Heading2"/>'))
  for (const maxChars of [1, 5, 6, 8, 20])
    await redactCase(`redact cut maxChars=${maxChars}`, p(wr('keep')) + p(wr('s', 'Pay')) + p(wr('tail one')) + p(wr('tail two', 'Late')), undefined, maxChars)
  await redactCase('redact mark after cut is unread', p(wr('keep one')) + p(wr('keep two')) + p(wr('s', 'Pay')), undefined, 3)
  await redactCase('redact unreadable mark before cut', p(wr('keep one')) + p(wr('s', 'Pay', 'x')) + p(wr('keep two')), '', 3)
  await redactCase('redact unreadable mark after cut', p(wr('keep one')) + p(wr('keep two')) + p(wr('s', 'Pay', 'x')), '', 3)
  await redactCase('redact unreadable mark after cut namespaced', p(wr('keep one')) + p(wr('keep two')) + `<redact w:label="x"/>`, undefined, 3)
  await redactCase('redact mark exactly at cut', p(wr('keep one')) + p(wr('s', 'Pay')), undefined, 8)
  await redactCase('redact in footnotes', p(r('body')), undefined, undefined, {
    'word/footnotes.xml': `<w:footnotes ${W} ${GO(OWN)}><w:footnote w:id="1">${p(wr('note ') + wr('secret', 'Pay'))}</w:footnote></w:footnotes>`,
    'word/endnotes.xml': `<w:endnotes ${W} ${GO(OLD)}><w:endnote w:id="1">${p(wr('end ') + wr('secret', 'Pay'))}</w:endnote></w:endnotes>`,
  })
  await redactCase('redact unreadable in footnotes', p(r('body')), undefined, undefined, {
    'word/footnotes.xml': `<w:footnotes ${W}><w:footnote w:id="1">${p(wr('secret', 'Pay', 'x'))}</w:footnote></w:footnotes>`,
  })
  const hdrDoc = (body: string, decl = GO(OWN)) => `<w:hdr ${W} ${decl}>${body}</w:hdr>`
  await redactCase('redact in header and comment', p(r('body')), undefined, undefined, {
    'word/_rels/document.xml.rels': rels([['header', 'header1.xml'], ['comments', 'comments.xml']]),
    'word/header1.xml': hdrDoc(p(wr('head ') + wr('secret', 'Pay'))),
    'word/comments.xml': `<w:comments ${W} ${GO(OLD)}><w:comment w:id="0">${p(wr('c') + wr('secret', 'Pay'))}</w:comment></w:comments>`,
  })
  await redactCase('redact unreadable in header', p(r('body')), undefined, undefined, {
    'word/_rels/document.xml.rels': rels([['header', 'header1.xml']]),
    'word/header1.xml': hdrDoc(p(wr('secret', 'Pay', 'x')), ''),
  })

  // main document found through _rels/.rels
  const relsTo = (target: string, type = 'officeDocument', mode?: string) =>
    rels([['image', 'x.png'], [type, target, mode]])
  add('rels main doc', await zip({ '_rels/.rels': relsTo('/custom/main.xml'), 'custom/main.xml': doc(p(r('custom main'))), 'custom/styles.xml': STYLES, 'custom/_rels/main.xml.rels': rels([['header', 'h.xml']]), 'custom/h.xml': HDR('custom header') }))
  add('rels main doc at root', await zip({ '_rels/.rels': relsTo('root.xml'), 'root.xml': doc(p(r('root main'), '<w:pStyle w:val="Heading3"/>')), '_rels/root.xml.rels': rels([['footer', 'f.xml']]), 'f.xml': HDR('root footer'), 'footnotes.xml': NOTES('endnote') }))
  add('rels main doc external', await zip({ '_rels/.rels': relsTo('/custom/main.xml', 'officeDocument', 'External'), 'custom/main.xml': doc(p(r('x'))) }))
  add('rels main doc missing target', await zip({ '_rels/.rels': relsTo('/nowhere.xml') }))
  add('rels wrong type', await zip({ '_rels/.rels': relsTo('/custom/main.xml', 'extended-properties'), 'custom/main.xml': doc(p(r('x'))) }))
  add('no main document', await zip({ 'a.txt': 'x' }))
  add('empty main document', await zip({ 'word/document.xml': '' }))
  add('main document is folder only', await zip({ 'word/document.xml/x': 'x' }))

  // unreadable parts: the reader that asks for them throws
  add('broken document', breakEntry(await zip({ 'word/document.xml': doc(p(r('x'.repeat(200)))) }), 'word/document.xml'))
  add('broken styles', breakEntry(await zip({ 'word/document.xml': doc(p(r('x'))), 'word/styles.xml': STYLES }), 'word/styles.xml'))
  add('broken root rels', breakEntry(await zip({ '_rels/.rels': relsTo('/m.xml') + ' '.repeat(200), 'm.xml': doc('') }), '_rels/.rels'))
  const brokenNotes = breakEntry(await zip({ 'word/document.xml': doc(p(r('body text that fills'))), 'word/footnotes.xml': NOTES('footnote') + ' '.repeat(200) }), 'word/footnotes.xml')
  add('broken footnotes', brokenNotes)
  add('broken footnotes skipped when full', brokenNotes, 5)
  const brokenHeader = breakEntry(await zip({ 'word/document.xml': doc(p(r('body'))), 'word/_rels/document.xml.rels': DOC_RELS, 'word/header1.xml': HDR('h'.repeat(300)) }), 'word/header1.xml')
  add('broken header', brokenHeader)
  add('broken header read even when full', brokenHeader, 1)
  add('broken unrelated part', breakEntry(await zip({ 'word/document.xml': doc(p(r('ok'))), 'word/media/big.bin': 'z'.repeat(300) }), 'word/media/big.bin'))

  // character references
  const refs = async (text: string) => zip({ 'word/document.xml': doc(p(r(text))) })
  add('code point too large', await refs('&#x110000;'))
  add('code point huge decimal', await refs('&#123456789012345678901234567890;'))
  add('code point too large in alt', await zip({ 'word/document.xml': doc(p(drawing(' descr="&#1114112;"'))) }))
  add('code point too large in hidden run', await zip({ 'word/document.xml': doc(p(r('&#x110000;', '<w:vanish/>'))) }))
  add('surrogate pair from refs', await refs('&#xD83D;&#xDE00;'))
  add('surrogate pair from sym', await zip({ 'word/document.xml': doc(p('<w:r><w:sym w:char="D83D"/><w:sym w:char="DE00"/></w:r>')) }))
  add('lone surrogate ref', await refs('a&#xD800;b'))
  add('lone surrogate sym', await zip({ 'word/document.xml': doc(p('<w:r><w:sym w:char="DC00"/></w:r>')) }))
  add('astral text counts two', await refs('\u{1F600}\u{1F600}'), 5)

  // non-canonical XML is read as written, never normalized
  add('strict namespace', await zip({ 'word/document.xml': `<w:document xmlns:w="http://purl.oclc.org/ooxml/wordprocessingml/main"><w:body>${p(r('strict'))}</w:body></w:document>` }))
  add('other prefix', await zip({ 'word/document.xml': `<x:document xmlns:x="${W}"><x:body><x:p><x:r><x:t>prefixed</x:t></x:r></x:p></x:body></x:document>` }))
  add('bom and comment', await zip({ 'word/document.xml': '\uFEFF<!-- <w:p><w:r><w:t>commented</w:t></w:r></w:p> -->' + doc(p(r('real'))) }))
  add('cdata', await zip({ 'word/document.xml': doc(p('<w:r><w:t><![CDATA[a<b]]></w:t></w:r>')) }))
  add('unterminated', await zip({ 'word/document.xml': doc(p('<w:r><w:t>open')).slice(0, -30) }))

  // malformed or hostile archives
  add('empty bytes', new Uint8Array(0))
  add('not a zip', new TextEncoder().encode('PK not really a zip file at all'))
  const truncated = await zip(RICH)
  add('truncated zip', truncated.subarray(0, truncated.length - 10))
  add('zip header garbage', Uint8Array.from([0x50, 0x4b, 0x05, 0x06, ...new Array(18).fill(0)]))
  return out
}

export const SPECS: Spec[] = [{
  fn: 'docxToText',
  extensions: ['docx'],
  built: inputs,
  call: ({ bytes = new Uint8Array(0), args = {} }) =>
    docxToText(bytes, 'maxChars' in args ? { maxChars: Number(args.maxChars) } : {}),
}]
