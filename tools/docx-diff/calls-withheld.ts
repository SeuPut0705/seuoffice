// Group `withheld`: the hidden-from-AI batch of the TypeScript engine,
// function by function. withheld.ts and comment-slices.ts, the edit reader of
// parse-package.ts, and the two readers of text-patch.ts and hf-root.ts that
// find tags past a comment or a CDATA section.
import { commentEntries } from './reference/comment-slices'
import { hfKeptRoot } from './reference/hf-root'
import { editedCommentModelText } from './reference/parse-package'
import { patchParagraphTexts } from './reference/text-patch'
import {
  firstMarkLabel,
  hasMarkElement,
  hasWithheldTrace,
  overWithheld,
  overWithheldModelText,
  parseEntry,
  runsText,
  withheldLabelOf,
  withheldNode,
  withheldText,
  withRedactNamespace,
} from './reference/withheld'
import type { XNode } from './reference/xml-utils'
import { findChildren } from './reference/xml-utils'
import type { CallSpec, Input } from './calls-spec'
import {
  attrEntries,
  COMMENT_PARTS,
  editsOf,
  ENTRIES,
  entrySlices,
  hiddenRun,
  HF_PARTS,
  LABELS,
  marks,
  NOTE_PARTS,
  plainRun,
} from './withheld-inputs'

const texts = (list: string[]): Input[] => list.map((text) => ({ text }))

/** What a call that takes a node gives for a text that holds none. */
const overEntry = (text: string, read: (node: XNode) => unknown): unknown => {
  const node = parseEntry(text)
  return node === undefined ? 'unparsed' : read(node)
}

const attrOf = (label: string): string =>
  label.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')

/** rPr texts the label of a run is read from. */
const R_PRS: string[] = [
  ...marks().flatMap((mark) => [
    `<w:rPr>${mark}</w:rPr>`,
    `<w:rPr><w:bdr w:val="single" w:sz="6" w:color="6B4FC0"/>${mark}</w:rPr>`,
    `<w:rPr xmlns="x"><w:b/>${mark}<w:i/></w:rPr>`,
  ]),
  ...LABELS.map((label) => `<w:rPr><go:redact w:label="${attrOf(label)}"/></w:rPr>`),
  '<w:rPr><go:redact w:label="a &amp; b &lt;c&gt; &quot;d&quot; &#65; &#x42;"/></w:rPr>',
  '<w:rPr><go:redact/></w:rPr>',
  '<w:rPr><go:redact w:label=""/></w:rPr>',
  '<w:rPr><go:redact w:label=\'single\'/></w:rPr>',
  '<w:rPr><go:redact w:other="x"/><go:redact w:label="second"/></w:rPr>',
  '<w:rPr><go:redact w:label="first"/></w:rPr><w:rPr><x:redact w:label="second"/></w:rPr>',
  '<w:rPr><redacted w:label="no"/></w:rPr>',
  '<w:rPr><go:Redact w:label="no"/></w:rPr>',
  '<w:rPr><a.b-c:redact w:label="dotted prefix"/></w:rPr>',
  '<w:rPr><a:b:redact w:label="two colons"/></w:rPr>',
  '<w:rPr><redact:x w:label="colon after"/></w:rPr>',
  '<w:rPr><!-- <go:redact w:label="in a comment"/> --></w:rPr>',
  '<w:rPr><![CDATA[<go:redact w:label="in CDATA"/>]]></w:rPr>',
  '<w:rPr><w:b/></w:rPr>',
  '<w:rPr/>',
  '',
]

/** Entries, each as a comment's or a note's paragraphs. */
const ENTRY_PARTS: string[] = [
  ...ENTRIES,
  ...COMMENT_PARTS.flatMap((part) => entrySlices(part, 'w:comment')),
  ...NOTE_PARTS.flatMap((part) => entrySlices(part, 'w:footnote')),
]

/** Entries as `buildCommentsXml` writes them anew. */
const GENERATED_ENTRIES: string[] = [
  '<w:comment w:id="1" w:author="A"><w:p><w:r><w:t xml:space="preserve">plain words</w:t></w:r></w:p></w:comment>',
  '<w:comment w:id="1" w:author="A"><w:p w14:paraId="0000000A"><w:r><w:t xml:space="preserve">one</w:t></w:r></w:p><w:p><w:r><w:t xml:space="preserve"></w:t></w:r></w:p><w:p><w:r><w:t xml:space="preserve">&lt;three&gt; &amp; $&amp;</w:t></w:r></w:p></w:comment>',
  '<w:comment w:id="1"><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>already styled</w:t></w:r></w:p></w:comment>',
  '<w:comment w:id="1"><w:p><w:r w:rsidR="00A"><w:rPr/><w:t> </w:t></w:r><w:r><w:t xml:space="preserve">spacer then words</w:t></w:r></w:p></w:comment>',
  '<w:comment w:id="1"><w:p><w:r><w:rPr></w:rPr><w:t>empty rPr pair</w:t></w:r></w:p></w:comment>',
  '<w:comment w:id="1"><w:p><w:r><w:t>words</w:t><w:t>second</w:t></w:r><w:r><w:footnoteRef/></w:r><w:r><w:drawing/></w:r></w:p></w:comment>',
  '<w:footnote w:id="1"><w:p><w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:footnoteRef/></w:r><w:r><w:t xml:space="preserve"> </w:t></w:r><w:r><w:t xml:space="preserve">note words</w:t></w:r></w:p></w:footnote>',
  '<w:comment w:id="1"><w:p/></w:comment>',
  '',
  'no runs',
]

/** The ways a root can be written, for the namespace the mark needs declared. */
const NAMESPACE_PARTS: Array<[string, string]> = [
  ['w:comments', '<w:comments xmlns:w="w"><w:comment><w:p><w:r><w:rPr><go:redact w:label="x"/></w:rPr></w:r></w:p></w:comment></w:comments>'],
  ['w:comments', '<?xml version="1.0"?>\n<w:comments xmlns:w="w" xmlns:go="https://genspark.ai/genoffice/redaction/2026"><w:comment><go:redact/></w:comment></w:comments>'],
  ['w:comments', '<w:comments xmlns:w="w" xmlns:go=\'https://genspark.ai/genoffice/redaction/2026\'><go:redact/></w:comments>'],
  ['w:comments', '<w:comments xmlns:go="another"><go:redact/></w:comments>'],
  ['w:comments', '<w:comments xmlns:go=""><go:redact/></w:comments>'],
  ['w:comments', '<w:comments xmlns:w="w" xmlns:mc="mc" mc:Ignorable="w14"><go:redact/></w:comments>'],
  ['w:comments', '<w:comments xmlns:w="w" xmlns:mc="mc" mc:Ignorable="w14 go"><go:redact/></w:comments>'],
  ['w:comments', '<w:comments xmlns:w="w" xmlns:mc="mc" mc:Ignorable="  "><go:redact/></w:comments>'],
  ['w:comments', '<w:comments xmlns:w="w" xmlns:mc="mc" mc:Ignorable="$&amp; $1 $$ $`"><go:redact/></w:comments>'],
  ['w:comments', '<w:comments xmlns:w="w" mc:Ignorable="gox go2 xgo"><go:redact/></w:comments>'],
  ['w:comments', '<w:comments xmlns:w="w" mc:Ignorable=""><go:redact/></w:comments>'],
  ['w:comments', '<w:comments xmlns:w="w"><w:comment/></w:comments>'],
  ['w:comments', '<w:comments xmlns:w="w"><w:comment><!-- <go:redact/> --></w:comment></w:comments>'],
  ['w:comments', '<w:comments a=">" xmlns:w="w"><go:redact/></w:comments>'],
  ['w:comments', '<w:commentsX><go:redact/></w:commentsX>'],
  ['w:comments', '<w:comments/>'],
  ['w:comments', '<w:comments><go:redact w:label="x"/></w:comments>'],
  ['w:comments', '<?xml version="1.0"?>\n<w:comments\n  xmlns:w="w"\n>\n<go:redact/></w:comments>'],
  ['w:footnotes', '<w:footnotes xmlns:w="w"><go:redact/></w:footnotes>'],
  ['w:footnotes', '<w:footnotes xmlns:mc="mc" xmlns:go="https://genspark.ai/genoffice/redaction/2026" mc:Ignorable="w14"><go:redact/></w:footnotes>'],
  ['w:endnotes', '<w:endnotes xmlns:w="w"><go:redact/></w:endnotes>'],
  ['w:endnotes', '<w:footnotes xmlns:w="w"><go:redact/></w:footnotes>'],
  ['w:($', '<w:($ xmlns:w="w"><go:redact/>'],
  ['w:a$&', '<w:a$& xmlns:w="w"><go:redact/></w:a$&>'],
  ['w:a$1', '<w:a$1 xmlns:w="w"><go:redact/></w:a$1>'],
  ['', '<a><go:redact/></a>'],
  ['w:comments', ''],
]

/** Entries whose paragraphs, runs and texts a pattern reads differently from the parser. */
const MASKED_ENTRIES: string[] = [
  // a comment fakes the end of a paragraph, a run and a text
  `<w:comment w:id="1"><w:p>${plainRun('one ')}<!-- </w:p><w:p> -->${plainRun('two')}</w:p></w:comment>`,
  `<w:comment w:id="1"><w:p><w:r><!-- </w:r> --><w:t>kept</w:t></w:r></w:p></w:comment>`,
  `<w:comment w:id="1"><w:p><w:r><w:t>a<!-- </w:t> -->b</w:t></w:r></w:p></w:comment>`,
  `<w:comment w:id="1"><w:p><w:r><w:t><![CDATA[a</w:t>b]]>c</w:t></w:r></w:p></w:comment>`,
  `<w:comment w:id="1"><w:p><w:r><w:t>a&amp;<![CDATA[<&>]]>&lt;z</w:t></w:r></w:p></w:comment>`,
  // end tags with white space, tags with `>` inside a value, quotes of both kinds
  `<w:comment w:id="1"><w:p w:x="a>b"><w:r w:y='c/>d'><w:t w:z="e>f">words here</w:t ></w:r ></w:p ></w:comment>`,
  `<w:comment w:id="1"><w:p><w:r><w:t xml:space = "preserve">spaced</w:t></w:r></w:p></w:comment>`,
  // self-closing paragraphs, runs and texts
  `<w:comment w:id="1"><w:p/><w:p>${plainRun('after')}</w:p><w:p /></w:comment>`,
  `<w:comment w:id="1"><w:p><w:r/><w:r><w:t/></w:r><w:r><w:t>real</w:t></w:r></w:p></w:comment>`,
  `<w:comment w:id="1"><w:p><w:pPr/><w:r><w:t>one</w:t><w:t/><w:t>two</w:t></w:r></w:p></w:comment>`,
  // a hidden run beside a plain one in a change that spans both, and one in a text box
  `<w:comment w:id="1"><w:p>${plainRun('plain ')}${hiddenRun('hidden', '<go:redact w:label="p"/>')}${plainRun(' plain')}</w:p></w:comment>`,
  `<w:comment w:id="1"><w:p>${hiddenRun('hid', '<go:redact w:label="p"/>')}${hiddenRun('den', '<go:redact w:label="p"/>')}${plainRun(' tail')}</w:p></w:comment>`,
  `<w:comment w:id="1"><w:p><w:r><w:rPr><go:redact w:label="p"/></w:rPr><w:drawing><w:txbxContent><w:p>${plainRun('in box')}</w:p></w:txbxContent></w:drawing></w:r>${plainRun(' out')}</w:p></w:comment>`,
  `<w:comment w:id="1"><w:p><w:r\n><!-- c --><w:rPr\n><gx:redact w:label = 'p'/></w:rPr><w:t>pretty</w:t></w:r><w:r><w:t> after</w:t></w:r></w:p></w:comment>`,
  `<w:comment w:id="1"><w:p><w:r><w:rPr w:x=">"><redact xmlns="https://genspark.ai/genoffice/redaction/2026" w:label="p"/></w:rPr><w:t>unprefixed</w:t></w:r><w:r><w:rPr/><w:t> plain</w:t></w:r></w:p></w:comment>`,
  `<w:comment w:id="1"><w:p><w:r><w:rPr><!-- <go:redact/> --></w:rPr><w:t>commented mark</w:t></w:r><w:r><w:t> plain</w:t></w:r></w:p></w:comment>`,
  `<w:comment w:id="1"><w:p><w:r><w:rPr><w:rPrChange><w:rPr><go:redact w:label="p"/></w:rPr></w:rPrChange></w:rPr><w:t>nested mark</w:t></w:r><w:r><w:t> plain</w:t></w:r></w:p></w:comment>`,
  // a leading spacer, as a note's first paragraph
  `<w:footnote w:id="1"><w:p><w:r><w:footnoteRef/></w:r><w:r><w:t xml:space="preserve"> </w:t></w:r><w:r><w:t>Words</w:t></w:r></w:p><w:p><w:r><w:t>Second</w:t></w:r></w:p></w:footnote>`,
  `<w:footnote w:id="1"><w:p><w:r><w:t xml:space="preserve">  </w:t></w:r></w:p></w:footnote>`,
]

const stripAndPatch = (xml: string): Input[] => {
  const node = parseEntry(xml)
  const old = node ? findChildren(node, 'w:p').map(runsText).join('\n') : ''
  return editsOf(old).flatMap((newText) => [
    { text: xml, args: { newText, strip: false } },
    { text: xml, args: { newText, strip: true } },
  ])
}

export const WITHHELD: CallSpec[] = [
  {
    fn: 'withheld.withheldLabelOf',
    call: (text, args) => withheldLabelOf(args.absent === true ? undefined : text),
    built: [
      ...R_PRS.map((text) => ({ text })),
      { text: '<w:rPr><go:redact w:label="x"/></w:rPr>', args: { absent: true } },
      { text: '', args: { absent: true } },
    ],
  },
  {
    fn: 'withheld.hasWithheldTrace',
    call: (text) => hasWithheldTrace(text),
    built: texts([...R_PRS, ...ENTRY_PARTS]),
  },
  {
    fn: 'withheld.hasMarkElement',
    call: (text) => overEntry(text, hasMarkElement),
    built: texts(ENTRY_PARTS),
  },
  {
    fn: 'withheld.withheldNode',
    call: (text) =>
      overEntry(text, (node) => {
        const view = withheldNode(node)
        return view === null ? null : attrEntries(view)
      }),
    built: texts(ENTRY_PARTS),
  },
  {
    fn: 'withheld.runsText',
    call: (text) => overEntry(text, runsText),
    built: texts(ENTRY_PARTS),
  },
  {
    fn: 'withheld.parseEntry',
    call: (text) => {
      const node = parseEntry(text)
      return node && attrEntries(node)
    },
    built: texts([...ENTRY_PARTS, ...R_PRS]),
  },
  {
    fn: 'withheld.withheldText',
    call: (text, args) => {
      const readers: Record<string, (node: XNode) => string> = {
        runsText,
        wrapped: (node) => `<${runsText(node)}>`,
      }
      return overEntry(text, (node) => withheldText(node, readers[args.reader as string]!))
    },
    built: ENTRY_PARTS.flatMap((text) =>
      ['runsText', 'wrapped'].map((reader) => ({ text, args: { reader } })),
    ),
  },
  {
    fn: 'withheld.firstMarkLabel',
    call: (text) => firstMarkLabel(text),
    built: texts([...ENTRY_PARTS, ...R_PRS]),
  },
  {
    fn: 'withheld.overWithheldModelText',
    call: (text, args) => overWithheldModelText(text, args.label as string),
    built: [
      'phone is 138',
      'one\n\ntwo\n   \nthree',
      '',
      '\n',
      ' \t \u{FEFF}\n\u{A0}x\n\u{85}',
      'a\r\nb',
      '{{already}} a marker',
    ].flatMap((text) => LABELS.map((label) => ({ text, args: { label } }))),
    mutation: 'none',
  },
  {
    fn: 'withheld.overWithheld',
    call: (text, args) => overWithheld(text, args.label as string),
    built: GENERATED_ENTRIES.flatMap((text) => LABELS.map((label) => ({ text, args: { label } }))),
  },
  {
    fn: 'withheld.withRedactNamespace',
    call: (text, args) => withRedactNamespace(text, args.rootTag as string),
    built: NAMESPACE_PARTS.map(([rootTag, text]) => ({ text, args: { rootTag } })),
  },
  {
    fn: 'withheld.commentEntries',
    call: (text) => commentEntries(text),
    fromDocument: (parts) => {
      const xml = parts.get('word/comments.xml')
      return xml === undefined ? [] : [{ text: xml }]
    },
    built: texts([...COMMENT_PARTS, ...NOTE_PARTS]),
  },
  {
    fn: 'withheld.editedCommentModelText',
    call: (text, args) => editedCommentModelText(text, args.text as string),
    built: COMMENT_PARTS.flatMap((part) => entrySlices(part, 'w:comment')).flatMap((xml) => {
      const node = parseEntry(xml)
      const old = node ? findChildren(node, 'w:p').map(runsText).join('\n') : ''
      return editsOf(old).map((text) => ({ text: xml, args: { text } }))
    }),
  },
  {
    fn: 'withheld.patchParagraphTexts',
    call: (text, args) => patchParagraphTexts(text, args.newText as string, {
      stripFirstParaLeadingSpace: args.strip === true,
    }),
    fromDocument: (parts) =>
      ['word/comments.xml', 'word/footnotes.xml', 'word/endnotes.xml']
        .flatMap((name) => {
          const xml = parts.get(name)
          return xml === undefined ? [] : entrySlices(xml, name.includes('comments') ? 'w:comment' : 'w:footnote')
        })
        .slice(0, 40)
        .flatMap(stripAndPatch),
    built: [
      ...ENTRY_PARTS.flatMap(stripAndPatch),
      ...MASKED_ENTRIES.flatMap(stripAndPatch),
    ],
  },
  {
    fn: 'withheld.hfKeptRoot',
    call: (text, args) => {
      const kept = hfKeptRoot(args.root as 'w:hdr' | 'w:ftr', text)
      return (
        kept && {
          before: kept.before,
          open: kept.open,
          children: kept.children.map((child) => ({ ...child, textPara: kept.isTextPara(child) })),
        }
      )
    },
    built: HF_PARTS.map(({ root, xml }) => ({ text: xml, args: { root } })),
  },
]
