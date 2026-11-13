// Group `hiddenContent`: hidden-content.ts. The package is `args.parts`, a list
// of [name, text] pairs, written to a zip by both sides; clearHiddenMarks is
// compared by the entries of the package it writes (names, folder flags, texts),
// not by its bytes.
import JSZip from 'jszip'
import { clearHiddenMarks, docxHoldsHiddenContent } from './reference/hidden-content'
import type { CallSpec, Input } from './calls-spec'
import { marks, OWN_REDACT_NS, SECRET, STORIES } from './withheld-inputs'

type Parts = Array<[string, string]>

const OLD_NS = 'https://genspark.ai/genoffice/redaction/2026'
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
const bytesOf = async (parts: Parts): Promise<Uint8Array> => {
  const zip = new JSZip()
  for (const [name, text] of parts) zip.file(name, text)
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
}
const body = (inner: string, root = 'w:document'): string =>
  `<${root} ${W}><w:body>${inner}</w:body></${root}>`
const run = (mark: string, text = SECRET): string =>
  `<w:r><w:rPr>${mark}</w:rPr><w:t>${text}</w:t></w:r>`
const BDR = '<w:bdr w:val="single" w:sz="6" w:color="6B4FC0"/>'

const packageOf = (document: string, ...more: Parts): Parts => [
  ['[Content_Types].xml', '<Types/>'],
  ['word/document.xml', document],
  ...more,
]

const PACKAGES: Parts[] = [
  ...STORIES.map((story): Parts => [
    ['[Content_Types].xml', '<Types/>'],
    ['word/document.xml', story.document],
    ['word/comments.xml', story.comments],
    ['word/footnotes.xml', story.footnotes],
    ['word/header1.xml', story.header],
    ['word/footer1.xml', story.footer],
    ['docProps/app.xml', '<Properties/>'],
  ]),
  // no mark, every way
  packageOf(body('<w:p><w:r><w:t>plain</w:t></w:r></w:p>')),
  packageOf(''),
  [],
  // marks under any prefix or none, with and without the border the editor writes
  ...marks().map((mark) =>
    packageOf(body(run(BDR + mark)), ['word/comments.xml', body(run(mark), 'w:comments')]),
  ),
  ...marks().map((mark) => packageOf(body(run(mark)))),
  // the namespace alone, declared and used in the text
  packageOf(`<w:document xmlns:go="${OLD_NS}" ${W}/>`),
  packageOf(`<w:document xmlns:go='${OWN_REDACT_NS}' xmlns="${OLD_NS}"${W}/>`),
  packageOf(`<w:document xmlns:go = "${OWN_REDACT_NS}"/>`),
  packageOf(`<w:document xmlns:go="${OLD_NS}x"/>`),
  packageOf(`<w:document><w:t>${OWN_REDACT_NS}</w:t></w:document>`),
  packageOf(`<w:document a="${OLD_NS}"/>`),
  // numeric references spelling the mark, the namespace, a surrogate and a huge one
  packageOf(body('&#60;go:redact w:label="x"/&#62;')),
  packageOf(body('&#x3c;redact/&#x3E;')),
  packageOf(`<w:document xmlns:go="${OLD_NS.replace('genspark', '&#103;enspark')}"/>`),
  packageOf(
    body('&#xD800;&#55357;&#128512;&#1114112;&#99999999999999999999;&#x;&#;&#65;&amp;#60;redact/>'),
  ),
  // a trace in a comment and in CDATA
  packageOf(body(`<!-- ${run('<go:redact w:label="x"/>')} -->`)),
  packageOf(body(`<w:t><![CDATA[<go:redact w:label="x"/>]]></w:t>`)),
  packageOf(body(`<w:t><![CDATA[${OLD_NS}]]></w:t>`)),
  // a CDATA section that spells a mark is words: not cut, and a trace it leaves makes the clearing fail
  packageOf(
    body(`<w:t><![CDATA[<go:redact w:label="x"/>]]></w:t>${run('<go:redact w:label="y"/>')}`),
  ),
  packageOf(body(`<![CDATA[<go:redact/>]]>${run('<redact/>')}<![CDATA[x]]><![CDATA[</redact>]]>`)),
  packageOf(body(`<w:t><![CDATA[a&#60;go:redact/&#62;]]></w:t>&#60;go:redact/&#62;`)),
  packageOf(body(`<!-- <![CDATA[ --><go:redact w:label="x"/><!-- ]]> -->`)),
  packageOf(body(`<![CDATA[ never closed <go:redact/>`)),
  packageOf(body(`<![CDATA[<go:redact/>]]]]><go:redact/>`)),
  // references outside the marks stay as written
  packageOf(body(`${run('<go:redact w:label="x"/>', '&#65;&#x42;&amp;&#60;')}`)),
  // marks in parts that are no word/*.xml, and in a folder-like name
  [
    ['[Content_Types].xml', '<Types/>'],
    ['docProps/app.xml', `<go:redact xmlns:go="${OLD_NS}"/>`],
    ['word/media/x.png', '<go:redact/>'],
    ['word/_rels/document.xml.rels', '<redact/>'],
  ],
  [
    ['word/embeddings/a.xml', '<redact/>'],
    ['xword/document.xml', '<redact/>'],
    ['word/document.xml.bak', '<redact/>'],
    ['word/', ''],
    ['word/x.xml', 'no mark'],
  ],
  // the mark's tag with attribute values that hold `>` and `/>`, end tags, white space
  packageOf(
    body(run(`${BDR}<go:redact xmlns:go="${OLD_NS}" w:label="a>b" w:x='c/>d'></go:redact>`)),
  ),
  packageOf(body(run(`${BDR}\n  <go:redact w:label="x"\n></go:redact\n>`))),
  packageOf(
    body(run(`<w:bdr  w:val="single" w:sz="6" w:color="6B4FC0" /> <go:redact w:label="x"/>`)),
  ),
  packageOf(body(run(`<w:bdr w:val="single" w:sz="6" w:color="000000"/><go:redact w:label="x"/>`))),
  packageOf(
    body(`${run('<go:redact w:label="a"/>')}${run('<gx:redact/>')}${run('<redact w:label="c"/>')}`),
  ),
  // traces the clearing leaves: an unclosed mark element, a namespace in text, a mark in an attribute, a spelled mark that clears to another
  packageOf(body('<go:redact w:label="x">')),
  packageOf(body(`<go:redact w:label="x"/><w:t>${OLD_NS}</w:t>`)),
  packageOf(body('<w:x a="<go:redact/>"/>')),
  packageOf(body('<go:redact w:label="x"/&#62;')),
  packageOf(body('<go:redact w:label="x"></go:redact x>')),
  packageOf(body('<go:redact w:label="x"/>'), ['word/header1.xml', '<w:hdr><go:redact></w:hdr>']),
  // a part that follows one that clears, to see both are judged
  packageOf(
    body(run('<go:redact w:label="x"/>')),
    ['word/comments.xml', 'clean'],
    ['word/endnotes.xml', run('<redact/>')],
  ),
  // names with characters past ASCII, folders, nested folders
  packageOf(
    body(run('<go:redact/>')),
    ['word/\u{e9}/x.xml', run('<redact/>')],
    ['word/a/b/c.xml', '<go:redact/>'],
    ['word/\u{1F600}.xml', '<redact/>'],
  ),
]

const inputs = (): Input[] => PACKAGES.map((parts) => ({ args: { parts } }))

const entriesOf = async (bytes: Uint8Array): Promise<unknown> => {
  const zip = await JSZip.loadAsync(bytes)
  return Promise.all(
    Object.entries(zip.files).map(async ([name, file]) => [
      name,
      file.dir,
      file.dir ? '' : await file.async('string'),
    ]),
  )
}

export const HIDDEN_CONTENT: CallSpec[] = [
  {
    fn: 'hiddenContent.docxHoldsHiddenContent',
    call: async (_text, args) => docxHoldsHiddenContent(await bytesOf(args.parts as Parts)),
    built: inputs(),
    mutation: 'none',
  },
  {
    fn: 'hiddenContent.clearHiddenMarks',
    call: async (_text, args) =>
      entriesOf(await clearHiddenMarks(await bytesOf(args.parts as Parts))),
    built: inputs(),
    mutation: 'none',
  },
]
