// What the specs of the hidden-from-AI batch read: the documents of
// packages/docx-engine/tests/helpers/hidden-stories.ts (a mark under every
// spelling, in both namespaces, under every tag mutation) taken apart into
// their parts, and entries written by hand for what those documents do not
// reach: marks where no run accounts for them, labels the placeholder cleans,
// tags a pattern reads differently from the parser.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import {
  hiddenStoriesDocx,
  LABEL,
  MARK_SPELLINGS,
  mutatedStoriesDocx,
  NAMESPACES,
  OWN_REDACT_NS,
  SECRET,
  TAG_MUTATION_NAMES,
} from '../../packages/docx-engine/tests/helpers/hidden-stories'

export { LABEL, OWN_REDACT_NS, SECRET }

/** The parts of one hidden-stories document that hold a story. */
export interface Story {
  name: string
  /** the whole document */
  docx: Uint8Array
  document: string
  comments: string
  footnotes: string
  header: string
  footer: string
}

async function storyOf(name: string, file: string): Promise<Story> {
  const docx = new Uint8Array(readFileSync(file))
  const zip = await JSZip.loadAsync(docx)
  const text = (path: string) => zip.file(path)!.async('string')
  return {
    name,
    docx,
    document: await text('word/document.xml'),
    comments: await text('word/comments.xml'),
    footnotes: await text('word/footnotes.xml'),
    header: await text('word/header1.xml'),
    footer: await text('word/footer1.xml'),
  }
}

async function readStories(pictures: boolean): Promise<Story[]> {
  const dir = mkdtempSync(join(tmpdir(), 'withheld-inputs-'))
  try {
    const out: Story[] = []
    for (const [nsName, ns] of NAMESPACES)
      for (const spelling of MARK_SPELLINGS)
        out.push(
          await storyOf(
            `${nsName}, ${spelling}`,
            await hiddenStoriesDocx(dir, ns, `${out.length}.docx`, spelling, { pictures }),
          ),
        )
    for (const mutation of TAG_MUTATION_NAMES)
      out.push(
        await storyOf(
          `mutated: ${mutation}`,
          await mutatedStoriesDocx(dir, mutation, { pictures }),
        ),
      )
    return out
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export const STORIES: Story[] = await readStories(false)

/** The same documents with a picture, an old-kind picture and an object in marked runs and in plain ones. */
export const PICTURE_STORIES_DOCS: Story[] = (await readStories(true)).map((story) => ({
  ...story,
  name: `pictures, ${story.name}`,
}))

const NS = 'https://genspark.ai/genoffice/redaction/2026'

/** A run hidden from AI under `mark`, a rPr child. */
export const hiddenRun = (text: string, mark: string): string =>
  `<w:r><w:rPr>${mark}</w:rPr><w:t>${text}</w:t></w:r>`
export const plainRun = (text: string): string =>
  `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`

/** Marks as another writer may spell them, each reading as `label`. */
export const marks = (label = 'phone'): string[] => [
  `<go:redact xmlns:go="${NS}" w:label="${label}"/>`,
  `<gx:redact xmlns:gx="${OWN_REDACT_NS}" w:label="${label}"/>`,
  `<redact xmlns="${NS}" w:label="${label}"/>`,
  `<redact w:label="${label}"/>`,
  `<go:redact w:label = '${label}'/>`,
  `<go:redact\n  w:label="${label}"\n/>`,
  `<go:redact w:x="a>b" w:label="${label}"></go:redact>`,
  `<go:redact w:x='a/>b' w:label='${label}'/>`,
]

/** Labels as the placeholder cleans them. */
export const LABELS = [
  'phone',
  '',
  'client phone',
  '  spaced   out  ',
  '{curly} <angle> "quote" \'tick\' = eq',
  'a'.repeat(39) + '\u{1F600}b',
  'a'.repeat(40),
  'a'.repeat(41),
  '\u{1F600}'.repeat(25),
  '$&$1$$',
  'tab\tand\nnewline',
  '\u{FEFF}bom\u{FEFF}',
  '{{}}',
  '\u{e9}clair',
]

/** The ways a mark can sit in an entry, as paragraphs. */
export const MARK_PLACES: string[] = [
  // a run hidden from AI beside plain ones
  `<w:p>${plainRun('Call ')}${hiddenRun('13800138000', '<go:redact w:label="phone"/>')}${plainRun(' now')}</w:p>`,
  // neighbours under one label read as one, another label apart
  `<w:p>${plainRun('a')}${hiddenRun('1', '<go:redact w:label="phone"/>')}\n  ${hiddenRun('2', '<go:redact w:label="phone"/>')}${plainRun('b')}${hiddenRun('x', '<go:redact w:label="name"/>')}${hiddenRun('y', '<go:redact w:label="phone"/>')}</w:p>`,
  // a plain run that is only white space between two hidden ones
  `<w:p>${hiddenRun('1', '<go:redact w:label="p"/>')}${plainRun(' ')}${hiddenRun('2', '<go:redact w:label="p"/>')}${plainRun('\t')}${hiddenRun('3', '<go:redact w:label="p"/>')}</w:p>`,
  // a text box inside a hidden run, a hidden run inside a text box
  `<w:p><w:r><w:rPr><go:redact w:label="logo"/></w:rPr><w:drawing><w:txbxContent><w:p>${plainRun('inner words')}</w:p></w:txbxContent></w:drawing></w:r>${plainRun('tail')}</w:p>`,
  `<w:p><w:r><w:drawing><w:txbxContent><w:p>${plainRun('in box ')}${hiddenRun('secret', '<go:redact w:label="phone"/>')}</w:p></w:txbxContent></w:drawing></w:r>${hiddenRun('after', '<go:redact w:label="phone"/>')}</w:p>`,
  // a mark on the paragraph mark has no words to withhold
  `<w:p><w:pPr><w:rPr><go:redact w:label="phone"/></w:rPr></w:pPr>${plainRun('open')}</w:p>`,
  // a mark no run accounts for: the whole entry is withheld
  `<w:p><w:r><w:t>secret</w:t><go:redact w:label="phone"/></w:r></w:p>`,
  `<w:p><go:redact w:label="phone"/>${plainRun('secret')}</w:p>`,
  `<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>secret</w:t></w:r><w:hyperlink><w:r><w:rPr><w:rPrChange><w:rPr><go:redact w:label="x"/></w:rPr></w:rPrChange></w:rPr><w:t>deep</w:t></w:r></w:hyperlink></w:p>`,
  // a mark with no label, an empty one, one whose label has entities
  `<w:p>${hiddenRun('nolabel', '<go:redact/>')}${plainRun('|')}${hiddenRun('empty', '<go:redact w:label=""/>')}${plainRun('|')}${hiddenRun('ent', '<go:redact w:label="a &amp; b &lt;c&gt; &quot;d&quot;"/>')}</w:p>`,
  // a run with its rPr after other children, pretty-printed
  `<w:p>\n  <w:r>\n    <!-- marked -->\n    <w:rPr>\n      <go:redact w:label="phone"/>\n    </w:rPr>\n    <w:t>pretty</w:t>\n  </w:r>\n</w:p>`,
  // markup faked by comments and CDATA
  `<w:p>${plainRun('x')}<!-- <w:r><w:rPr><go:redact w:label="fake"/></w:rPr></w:r> --><w:r><w:t><![CDATA[<go:redact w:label="fake"/>]]></w:t></w:r></w:p>`,
  `<w:p>${hiddenRun('<![CDATA[</w:p><w:p><w:r><w:t>secret</w:t></w:r></w:p>]]>', '<go:redact w:label="phone"/>')}</w:p>`,
  // an instruction and a deletion are no shown text
  `<w:p>${plainRun('a')}<w:r><w:instrText>HIDDEN</w:instrText></w:r><w:del><w:r><w:delText>gone</w:delText></w:r></w:del>${hiddenRun('b', '<go:redact w:label="phone"/>')}</w:p>`,
  // no mark at all
  `<w:p>${plainRun('open')}</w:p>`,
  '<w:p/>',
  '',
  '<w:p><w:r><w:t>unclosed',
  '<?xml version="1.0"?><w:p><w:r><w:t>decl</w:t></w:r></w:p>',
  '<w:p><w:r><w:t>a</w:t></w:r></w:p><w:p><w:r><w:t>two roots</w:t></w:r></w:p>',
]

/** The paragraph of each mark spelling and each place, for the readers that take an entry. */
export const ENTRIES: string[] = [
  ...MARK_PLACES,
  ...marks().map((mark) => `<w:p>${plainRun('See ')}${hiddenRun('hidden', mark)}</w:p>`),
  ...STORIES.flatMap((story) => [
    story.header.slice(story.header.indexOf('<w:p'), story.header.lastIndexOf('</w:hdr>')),
  ]),
]

/** Comments parts: the stories' own, then the ways an entry can be written. */
export const COMMENT_PARTS: string[] = [
  ...STORIES.map((story) => story.comments),
  '<w:comments><w:comment w:id="1"><w:p/></w:comment></w:comments>',
  // quotes, white space around =, `>` and `/>` inside a value
  `<w:comments><w:comment w:id='1' w:author='A>B'><w:p>${plainRun('single')}</w:p></w:comment>` +
    `<w:comment w:id = "2" w:author="x/>y"><w:p>${plainRun('spaced')}</w:p></w:comment>` +
    `<w:comment\n w:id="3"\n w:x='a>b'\n>${'<w:p/>'}</w:comment >` +
    '</w:comments>',
  // self-closing entries and ones without an id
  '<w:comments><w:comment w:id="1"/><w:comment w:author="no id"><w:p/></w:comment><w:comment w:id="2"><w:p/></w:comment><w:comment w:id=""><w:p/></w:comment><w:comment/></w:comments>',
  // ids with entities, twice
  '<w:comments><w:comment w:id="a&amp;b"><w:p/></w:comment><w:comment w:id="a&amp;b"><w:p>x</w:p></w:comment></w:comments>',
  // markup inside a comment and CDATA that fakes a tag
  `<w:comments><!-- <w:comment w:id="9"><w:p/></w:comment> --><w:comment w:id="1"><w:p>${hiddenRun('<![CDATA[</w:comment><w:comment w:id="9"><w:p><w:r><w:t>x</w:t></w:r></w:p></w:comment>]]>', '<go:redact w:label="phone"/>')}</w:p></w:comment></w:comments>`,
  '<w:comments><w:comment w:id="1"><w:p/></w:comments>',
  '<w:comments><w:comment w:id="1" w:x="<w:comment w:id=\'2\'>"><w:p/></w:comment><w:comment w:id="3"><w:p/></w:comment></w:comments>',
  // a comment inside a comment
  '<w:comments><w:comment w:id="1"><w:p><w:comment w:id="2"/></w:p></w:comment><w:comment w:id="3"/></w:comments>',
  '<w:comments/>',
  '',
  'not xml',
]

/** Notes parts: the stories' own, then the ways an entry can be written. */
export const NOTE_PARTS: string[] = [
  ...STORIES.map((story) => story.footnotes),
  `<w:footnotes><w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote><w:footnote w:id="1"><w:p><w:r><w:footnoteRef/></w:r>${plainRun(' kept')}</w:p></w:footnote></w:footnotes>`,
  // quotes, white space around =, `>` and `/>` inside a value, a space before >
  `<w:footnotes><w:footnote w:id='1' w:x='a>b'><w:p>${plainRun(' single')}</w:p></w:footnote>` +
    `<w:footnote w:id = "2" w:x="a/>b"><w:p>${plainRun(' spaced')}</w:p></w:footnote >` +
    `<w:footnote w:type = 'separator' w:id="3"><w:p/></w:footnote></w:footnotes>`,
  // self-closing entries, without an id, empty
  '<w:footnotes><w:footnote w:id="1"/><w:footnote w:id="2"><w:p/></w:footnote><w:footnote><w:p/></w:footnote><w:footnote w:id=""><w:p/></w:footnote><w:footnote w:id="3"></w:footnote></w:footnotes>',
  // markup faked by a comment and CDATA
  `<w:footnotes><!-- <w:footnote w:id="9"><w:p/></w:footnote> --><w:footnote w:id="1"><w:p>${hiddenRun('<![CDATA[</w:footnote><w:footnote w:id="9"><w:p><w:r><w:t>x</w:t></w:r></w:p></w:footnote>]]>', '<go:redact w:label="phone"/>')}</w:p></w:footnote></w:footnotes>`,
  // the first paragraph opens with the reference and a spacer; a hidden run first
  `<w:footnotes><w:footnote w:id="1"><w:p><w:r><w:footnoteRef/></w:r>${hiddenRun(' secret', '<go:redact w:label="phone"/>')}${plainRun(' tail')}</w:p><w:p>${hiddenRun('second', '<go:redact w:label="phone"/>')}</w:p></w:footnote></w:footnotes>`,
  // pictures in a note, one of them in a hidden run, and `$` patterns in a picture's XML
  `<w:footnotes><w:footnote w:id="1"><w:p><w:r><w:footnoteRef/></w:r>${plainRun(' See ')}${hiddenRun('138', '<go:redact w:label="phone"/>')}<w:r><w:rPr><go:redact w:label="logo"/></w:rPr><w:drawing><wp:inline a="$&amp;$1"/></w:drawing></w:r></w:p><w:p><w:r><w:pict><v:shape/></w:pict></w:r><w:r><w:object>$$</w:object></w:r></w:p></w:footnote></w:footnotes>`,
  `<w:footnotes><w:footnote w:id="1"><w:p><w:r><w:footnoteRef/></w:r>${plainRun(' Plain ')}<w:r><w:drawing/></w:r></w:p></w:footnote></w:footnotes>`,
  // a mark no run accounts for
  `<w:footnotes><w:footnote w:id="1"><w:p><go:redact w:label="phone"/>${plainRun(' secret')}</w:p></w:footnote></w:footnotes>`,
  '<w:footnotes><w:footnote w:id="1"><w:p>',
  '<w:footnotes/>',
  '',
]

/** Header and footer parts: the stories' own and ones that keep their root. */
export const HF_PARTS: Array<{ root: 'w:hdr' | 'w:ftr'; xml: string }> = [
  ...STORIES.flatMap((story) => [
    { root: 'w:hdr' as const, xml: story.header },
    { root: 'w:ftr' as const, xml: story.footer },
  ]),
  ...(['w:hdr', 'w:ftr'] as const).flatMap((root) => [
    {
      root,
      xml: `<${root} xmlns:w="x"><w:tbl><w:tr/></w:tbl><w:p><w:r><w:t>a</w:t></w:r></w:p></${root}>`,
    },
    // the end tag of the root faked inside a comment and CDATA
    {
      root,
      xml: `<${root} xmlns:w="x"><w:p><w:r><w:t><![CDATA[</${root}>]]></w:t></w:r></w:p><w:tbl/><!-- </${root}> --><w:p/></${root}>`,
    },
    { root, xml: `<${root} xmlns:w="x"><w:p/><!-- <w:tbl/> --></${root}>` },
    {
      root,
      xml: `<${root} xmlns:w="x"><w:p><w:r><w:t>a</w:t></w:r><!-- </w:p> --></w:p></${root}>`,
    },
    { root, xml: `<${root}><w:sdt><w:sdtContent><w:p/></w:sdtContent></w:sdt></${root}>` },
    { root, xml: `<${root} a=">"><w:p/><w:tbl/></${root}>` },
    { root, xml: `<w:p/>` },
  ]),
]

/** A node with its attributes as entries: their order is part of the node (serializeXNode). */
export function attrEntries(node: unknown): unknown {
  return Object.fromEntries(
    Object.entries(node as Record<string, unknown>).map(([key, value]) => [
      key,
      key === ':@'
        ? Object.entries(value as Record<string, string>)
        : Array.isArray(value)
          ? value.map(attrEntries)
          : value,
    ]),
  )
}

/** The entry `<w:comment>` or `<w:footnote>` slices of a part: what a person's edit is read against. */
export function entrySlices(part: string, tag: 'w:comment' | 'w:footnote'): string[] {
  return part.match(new RegExp(`<${tag}\\b[^]*?</${tag}\\s*>`, 'g')) ?? []
}

/** The texts a person's edit can give an entry that reads as `old`: unchanged, across words, a paragraph more or fewer. */
export function editsOf(old: string): string[] {
  return [
    old,
    `${old}!`,
    `!${old}`,
    old.slice(1),
    old.slice(0, -1),
    old.replace(/\S/, 'Q'),
    old.replace(/(\S+)(\s+)(\S+)/, '$3$2$1'),
    `${old}\nextra`,
    old.split('\n')[0] ?? '',
    old.replace(/\d+/g, ''),
    old.toUpperCase(),
    '',
    'wholly new',
  ]
}
