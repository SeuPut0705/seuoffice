import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import JSZip from 'jszip'
import { createBlankPptx, openPptx, savePptx, setSlideNotes } from '../../src/index'
import { REDACT_EL, REDACT_NS_WRITTEN, setRedactExt } from '../../src/redaction-xml'

/**
 * A deck holding text a person marked "hidden from AI", for the readers that
 * must withhold it: the attachment reader, the command line, the slide editor's
 * AI readers.
 */

export const LABEL = 'client phone'
export const SECRET = '13800138000'
export const PLACEHOLDER = `{{${LABEL}}}`

/** one suffix per story, so a leak says which story it came out of */
export const STORY_TAGS = ['B', 'T', 'G', 'F', 'N', 'C'] as const
/** a picture marked hidden (P), one inside a group (Q), a shape filled with a picture whose text is hidden (S) */
export const PICTURE_TAGS = ['P', 'Q', 'S'] as const
/** a hidden run whose words are the placeholder itself: a reader that compares texts finds nothing withheld */
export const ECHO_TAG = 'E'
/** the stories of the whole deck; the echo is left out, as it is a case of its own */
/** a chart whose title run (K) and category axis title run (A) are marked hidden */
export const CHART_TAGS = ['K', 'A'] as const
export const ALL_STORIES = [...STORY_TAGS, ...PICTURE_TAGS, ...CHART_TAGS] as const
/** the runs of the slide that hold the secret: body, table cell, grouped shape, field, picture-filled shape */
export const SECRET_RUNS = 5

const A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const P = 'http://schemas.openxmlformats.org/presentationml/2006/main'
const P188 = 'http://schemas.microsoft.com/office/powerpoint/2018/8/main'
const REL_MODERN_COMMENTS = 'http://schemas.microsoft.com/office/2018/10/relationships/comments'

const RPR = '<a:rPr lang="en-US" dirty="0"/>'

const plain = (text: string) => `<a:r>${RPR}<a:t>${text}</a:t></a:r>`

export type StoryTag = (typeof ALL_STORIES)[number] | typeof ECHO_TAG

/**
 * The run of a story: marked hidden from AI, as the slide editor writes the
 * mark, when the story is among `marked`, otherwise an ordinary run of words
 * that are no secret.
 */
const storyRun = (tag: StoryTag, marked: ReadonlySet<StoryTag>) =>
  marked.has(tag)
    ? `<a:r>${setRedactExt(RPR, LABEL)}<a:t>${tag === ECHO_TAG ? PLACEHOLDER : `${SECRET}${tag}`}</a:t></a:r>`
    : plain(`open${tag}`)

/** the 1x1 picture every picture of the deck shows */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
const IMAGE_REL = 'rId91'
const CHART_REL = 'rId92'
const PLAIN_CHART_REL = 'rId93'
const C = 'http://schemas.openxmlformats.org/drawingml/2006/chart'
const CHART_CT = 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml'

/** a chart part: its title and category axis title are rich text, the runs of the two stories when marked */
const chartXml = (title: string, axisTitle: string) => {
  const rich = (run: string) =>
    `<c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p>${run}</a:p></c:rich></c:tx>`
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<c:chartSpace xmlns:c="${C}" xmlns:a="${A}" xmlns:r="${R}">` +
    `<c:chart><c:title>${rich(title)}<c:overlay val="0"/></c:title><c:autoTitleDeleted val="0"/><c:plotArea><c:layout/>` +
    '<c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:ser><c:idx val="0"/><c:order val="0"/>' +
    '<c:tx><c:strRef><c:f>Sheet1!$B$1</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>Series</c:v></c:pt></c:strCache></c:strRef></c:tx>' +
    '<c:cat><c:strRef><c:f>Sheet1!$A$2:$A$3</c:f><c:strCache><c:ptCount val="2"/><c:pt idx="0"><c:v>One</c:v></c:pt><c:pt idx="1"><c:v>Two</c:v></c:pt></c:strCache></c:strRef></c:cat>' +
    '<c:val><c:numRef><c:f>Sheet1!$C$2:$C$3</c:f><c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="2"/><c:pt idx="0"><c:v>1</c:v></c:pt><c:pt idx="1"><c:v>2</c:v></c:pt></c:numCache></c:numRef></c:val>' +
    '</c:ser><c:axId val="1"/><c:axId val="2"/></c:barChart>' +
    `<c:catAx><c:axId val="1"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/><c:title>${rich(axisTitle)}<c:overlay val="0"/></c:title><c:crossAx val="2"/></c:catAx>` +
    '<c:valAx><c:axId val="2"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="l"/><c:crossAx val="1"/></c:valAx>' +
    '</c:plotArea><c:plotVisOnly val="1"/></c:chart></c:chartSpace>'
  )
}

const chartFrame = (id: number, name: string, rel: string, y: number) =>
  `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="${name}"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>` +
  `<p:xfrm><a:off x="5200000" y="${y}"/><a:ext cx="3000000" cy="1500000"/></p:xfrm>` +
  `<a:graphic><a:graphicData uri="${C}"><c:chart xmlns:c="${C}" xmlns:r="${R}" r:id="${rel}"/></a:graphicData></a:graphic></p:graphicFrame>`

const XFRM = (x: number, y: number) =>
  `<a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="300000" cy="300000"/></a:xfrm>`

/**
 * A picture whose words (name and alt text) are the secret when it is hidden:
 * the mark is in its shape properties, as the slide editor writes it.
 */
const picture = (
  id: number,
  name: string,
  alt: string,
  x: number,
  y: number,
  hiddenFrom?: boolean,
) => {
  const spPr = `<p:spPr>${XFRM(x, y)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>`
  return (
    `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="${name}" descr="${alt}"/>` +
    '<p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>' +
    `<p:blipFill><a:blip r:embed="${IMAGE_REL}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>` +
    `${hiddenFrom ? setRedactExt(spPr, LABEL) : spPr}</p:pic>`
  )
}

const hiddenPicture = (
  tag: 'P' | 'Q',
  id: number,
  x: number,
  y: number,
  marked: ReadonlySet<StoryTag>,
) =>
  marked.has(tag)
    ? picture(id, `Photo ${SECRET}${tag}`, `${SECRET}${tag} alt`, x, y, true)
    : picture(id, `Photo open${tag}`, `open${tag} alt`, x, y)

const body = (paragraph: string) =>
  `<p:txBody><a:bodyPr/><a:lstStyle/><a:p>${paragraph}</a:p></p:txBody>`

const box = (id: number, name: string, x: number, y: number, paragraph: string) =>
  `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>` +
  `<p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="4000000" cy="600000"/></a:xfrm>` +
  `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>${body(paragraph)}</p:sp>`

const cell = (runs: string) =>
  `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p>${runs}</a:p></a:txBody><a:tcPr/></a:tc>`

const table = (marked: ReadonlySet<StoryTag>) =>
  '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="4" name="Table"/>' +
  '<p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr>' +
  '<p:xfrm><a:off x="500000" y="2000000"/><a:ext cx="4000000" cy="400000"/></p:xfrm>' +
  '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr/>' +
  '<a:tblGrid><a:gridCol w="2000000"/><a:gridCol w="2000000"/></a:tblGrid>' +
  `<a:tr h="400000">${cell(plain('Phone'))}${cell(plain('Tel ') + storyRun('T', marked))}</a:tr>` +
  '</a:tbl></a:graphicData></a:graphic></p:graphicFrame>'

const group = (marked: ReadonlySet<StoryTag>) =>
  '<p:grpSp><p:nvGrpSpPr><p:cNvPr id="5" name="Group"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
  '<p:grpSpPr><a:xfrm><a:off x="500000" y="3000000"/><a:ext cx="4000000" cy="600000"/>' +
  '<a:chOff x="500000" y="3000000"/><a:chExt cx="4000000" cy="600000"/></a:xfrm></p:grpSpPr>' +
  box(6, 'Grouped', 500000, 3000000, plain('Group ') + storyRun('G', marked)) +
  picture(12, 'Grouped plain photo', 'grouped plain alt', 4600000, 3000000) +
  hiddenPicture('Q', 13, 4900000, 3000000, marked) +
  '</p:grpSp>'

const field = (marked: ReadonlySet<StoryTag>) =>
  `<a:fld id="{B5A1C0DE-1111-4222-8333-444455556666}" type="datetime1">` +
  (marked.has('F')
    ? `${setRedactExt(RPR, LABEL)}<a:t>${SECRET}F</a:t>`
    : `${RPR}<a:t>openF</a:t>`) +
  '</a:fld>'

/** a shape filled with the picture, holding hidden words */
const textured = (marked: ReadonlySet<StoryTag>) =>
  '<p:sp><p:nvSpPr><p:cNvPr id="11" name="Textured"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>' +
  `<p:spPr>${XFRM(5200000, 1200000)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>` +
  `<a:blipFill><a:blip r:embed="${IMAGE_REL}"/><a:stretch><a:fillRect/></a:stretch></a:blipFill></p:spPr>` +
  body(plain('Tex ') + storyRun('S', marked)) +
  '</p:sp>'

const slideXml = (marked: ReadonlySet<StoryTag>) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:sld xmlns:a="${A}" xmlns:r="${R}" xmlns:p="${P}">` +
  '<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
  '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>' +
  box(2, 'Body', 500000, 500000, plain('Call ') + storyRun('B', marked) + plain(' now')) +
  box(3, 'Plain', 500000, 1300000, plain('Edit me please')) +
  table(marked) +
  group(marked) +
  box(7, 'Field', 500000, 4000000, plain('Today ') + field(marked)) +
  box(8, 'Echo', 500000, 4600000, plain('Echo ') + storyRun(ECHO_TAG, marked)) +
  hiddenPicture('P', 9, 5200000, 500000, marked) +
  picture(10, 'Plain photo', 'plain control alt', 5600000, 500000) +
  textured(marked) +
  chartFrame(14, 'Chart', CHART_REL, 2400000) +
  chartFrame(15, 'Plain chart', PLAIN_CHART_REL, 4000000) +
  '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>'

const commentsXml = (marked: ReadonlySet<StoryTag>) =>
  `<p188:cmLst xmlns:p188="${P188}" xmlns:a="${A}">` +
  '<p188:cm id="{62A8A96D-E5A8-4BFC-B993-A6EAE3907CAD}" authorId="{CD37207E-7903-4ED4-8AE8-017538D2DF7E}" created="2024-12-30T20:26:06.503">' +
  `<p188:txBody><a:bodyPr/><a:lstStyle/><a:p>${plain('Note: ')}${storyRun('C', marked)}</a:p></p188:txBody>` +
  '</p188:cm></p188:cmLst>'

const authorsXml =
  `<p188:authorLst xmlns:p188="${P188}">` +
  '<p188:author id="{CD37207E-7903-4ED4-8AE8-017538D2DF7E}" name="Alice" initials="A" userId="alice" providerId="None"/>' +
  '</p188:authorLst>'

/**
 * The bytes of a one-slide deck whose body text (B), table cell (T), shape in
 * a group (G), field (F), speaker notes (N) and modern comment (C) each hold a
 * run marked hidden from AI, with a plain text box 'Edit me please' to edit.
 */
export async function hiddenDeckBytes(
  /** the stories that hold a hidden run; the others hold ordinary words */
  stories: readonly StoryTag[] = ALL_STORIES,
): Promise<Uint8Array> {
  const marked = new Set(stories)
  const opened = await openPptx(await createBlankPptx())
  setSlideNotes(opened, 0, `See ${SECRET}N`)
  const zip = await JSZip.loadAsync(await savePptx(opened))
  zip.file('ppt/slides/slide1.xml', slideXml(marked))
  const notesPath = Object.keys(zip.files).find((p) => /^ppt\/notesSlides\/[^/]+\.xml$/.test(p))!
  const notes = await zip.file(notesPath)!.async('string')
  const split = notes.replace(
    /<a:r><a:rPr[^>]*\/><a:t>See 13800138000N<\/a:t><\/a:r>/,
    plain('See ') + storyRun('N', marked),
  )
  if (split === notes) throw new Error('the notes run of the fixture was not found')
  zip.file(notesPath, split)

  zip.file('ppt/comments/comment1.xml', commentsXml(marked))
  zip.file('ppt/authors.xml', authorsXml)
  const rels = await zip.file('ppt/slides/_rels/slide1.xml.rels')!.async('string')
  zip.file(
    'ppt/slides/_rels/slide1.xml.rels',
    rels.replace(
      '</Relationships>',
      `<Relationship Id="rId90" Type="${REL_MODERN_COMMENTS}" Target="../comments/comment1.xml"/></Relationships>`,
    ),
  )
  const titleRun = (tag: 'K' | 'A', words: string) =>
    marked.has(tag) ? storyRun(tag, marked) : plain(words)
  zip.file('ppt/charts/chart1.xml', chartXml(titleRun('K', 'Revenue'), titleRun('A', 'Quarter')))
  zip.file('ppt/charts/chart2.xml', chartXml(plain('Plain revenue'), plain('Plain quarter')))
  zip.file('ppt/media/image1.png', PNG_BASE64, { base64: true })
  const slideRels = await zip.file('ppt/slides/_rels/slide1.xml.rels')!.async('string')
  zip.file(
    'ppt/slides/_rels/slide1.xml.rels',
    slideRels.replace(
      '</Relationships>',
      `<Relationship Id="${IMAGE_REL}" Type="${R}/image" Target="../media/image1.png"/>` +
        `<Relationship Id="${CHART_REL}" Type="${R}/chart" Target="../charts/chart1.xml"/>` +
        `<Relationship Id="${PLAIN_CHART_REL}" Type="${R}/chart" Target="../charts/chart2.xml"/></Relationships>`,
    ),
  )
  const types = await zip.file('[Content_Types].xml')!.async('string')
  zip.file(
    '[Content_Types].xml',
    types.replace(
      '</Types>',
      (types.includes('Extension="png"')
        ? ''
        : '<Default Extension="png" ContentType="image/png"/>') +
        `<Override PartName="/ppt/charts/chart1.xml" ContentType="${CHART_CT}"/>` +
        `<Override PartName="/ppt/charts/chart2.xml" ContentType="${CHART_CT}"/>` +
        '<Override PartName="/ppt/comments/comment1.xml" ContentType="application/vnd.ms-powerpoint.comments+xml"/>' +
        '<Override PartName="/ppt/authors.xml" ContentType="application/vnd.ms-powerpoint.authors+xml"/></Types>',
    ),
  )
  return zip.generateAsync({ type: 'uint8array' })
}

const FAKE_MARK = `<a:extLst><a:ext uri="{9F1B2C3D-4E5F-4A6B-8C7D-9E0F1A2B3C4D}"><${REDACT_EL} label="x"/></a:ext></a:extLst>`
const GO = `xmlns:go="${REDACT_NS_WRITTEN}"`

/**
 * The same tags written another valid way, as another producer may write
 * them. Each changes the XML text a pattern reads and leaves the document the
 * XML parser reads as it was (but the prefix renames, which leave the namespace
 * URI alone and the prefix a reader may have hard-coded).
 */
export const TAG_MUTATIONS = {
  'single quotes': (xml: string) =>
    xml.replace(/<[^>!?]+>/g, (tag) => tag.replace(/="([^"]*)"/g, "='$1'")),
  'spaces around =': (xml: string) =>
    xml.replace(/<[^>!?]+>/g, (tag) => tag.replace(/(\s[\w:.-]+)=(["'])/g, '$1 = $2')),
  '> and /> inside values': (xml: string) =>
    xml.replace(
      /<(a:r|a:rPr|a:ext|a:p|a:tbl|a:tc|a:fld|p:sp|p:pic|p:grpSp|p188:cm)(?=[\s/>])/g,
      '<$1 xx="a/>b>c"',
    ),
  comments: (xml: string) =>
    xml
      .replace(/(<a:r(?:\s[^>]*)?>)/g, '$1<!-- </a:r></a:p> <go:redact label="x"/> -->')
      .replace(
        /(<a:ext\s+uri=)/g,
        '<!-- <a:ext uri="{9F1B2C3D-4E5F-4A6B-8C7D-9E0F1A2B3C4D}"/> -->$1',
      )
      .replace(/<\/a:ext>/g, '</a:ext><!-- </a:extLst></a:rPr> -->')
      .replace(/<\/a:t>/g, '<!-- </a:t> --></a:t>'),
  // a hidden run's words inside CDATA dressed as other runs, paragraphs and shapes
  'fake markup in CDATA': (xml: string) =>
    xml.replace(
      new RegExp(`<a:t([^>]*)>(${SECRET}[A-Z]?)</a:t>`, 'g'),
      (_all, attrs: string, words: string) =>
        `<a:t${attrs}><![CDATA[</a:t></a:r></a:p></p:txBody></p:sp><p:sp><p:txBody><a:p><a:r><a:t>${words}</a:t></a:r></a:p>` +
        `<a:p><a:r><a:t>${words}]]></a:t>`,
    ),
  // the same, dressed as a run that is marked and one that is not
  'fake mark in CDATA': (xml: string) =>
    xml.replace(
      new RegExp(`<a:t([^>]*)>(${SECRET}[A-Z]?)</a:t>`, 'g'),
      (_all, attrs: string, words: string) =>
        `<a:t${attrs}><![CDATA[</a:t></a:r><a:r><a:rPr>${FAKE_MARK}</a:rPr><a:t>${words}</a:t></a:r><a:r><a:t>${words}]]></a:t>`,
    ),
  'space before > in end tags': (xml: string) => xml.replace(/<\/([\w:.-]+)>/g, '</$1 >'),
  CDATA: (xml: string) =>
    xml.replace(
      new RegExp(`<a:t([^>]*)>(${SECRET}[A-Z]?)</a:t>`, 'g'),
      '<a:t$1><![CDATA[</a:r>]]><![CDATA[$2]]></a:t>',
    ),
  'namespace prefix a': (xml: string) =>
    xml
      .replace(/xmlns:a=/g, 'xmlns:aa=')
      .replace(/(<\/?)a:/g, '$1aa:')
      .replace(/(\s)a:/g, '$1aa:'),
  'namespace prefix go': (xml: string) =>
    xml.replace(/xmlns:go=/g, 'xmlns:gx=').replace(/(<\/?)go:/g, '$1gx:'),
  'namespace prefix p': (xml: string) =>
    xml
      .replace(/xmlns:p=/g, 'xmlns:pp=')
      .replace(/(<\/?)p:/g, '$1pp:')
      .replace(/(\s)p:/g, '$1pp:'),
  // the characters of the extension id and of the label written as references
  'character references': (xml: string) =>
    xml
      .replace(/uri="\{9F1B/g, 'uri="&#123;9F1B')
      .replace(/label="client phone"/g, 'label="client&#x20;&#112;hone"'),
  // as a pretty-printer lays out a part
  'indented tags': (xml: string) => xml.replace(/></g, '>\n    <'),
  'newlines in tags': (xml: string) =>
    xml.replace(/<[^>!?/][^>]*>/g, (tag) => tag.replace(/ (?=[\w:.-]+\s*=)/g, '\r\n\t')),
  'byte order mark': (xml: string) => `\uFEFF${xml}`,
  // another extension in the same list as the mark, as PowerPoint writes its own beside it
  'foreign extension beside the mark': (xml: string) =>
    xml.replace(
      /(<a:ext\s+uri="\{9F1B)/g,
      '<a:ext uri="{FF2B5EF4-FFF2-40B4-BE49-F238E27FC236}"><a16:x xmlns:a16="urn:x"/></a:ext>$1',
    ),
  'mark namespace on the part root': (xml: string) =>
    xml
      .replace(new RegExp(` ${GO}`, 'g'), '')
      .replace(/^(<\?xml[^>]*\?>\s*)?(<[\w:.-]+)/, `$1$2 ${GO}`),
  'no prefix for the mark': (xml: string) =>
    xml
      .replace(new RegExp(` ${GO}`, 'g'), '')
      .replace(/<go:redact /g, `<redact xmlns="${REDACT_NS_WRITTEN}" `),
} satisfies Record<string, (xml: string) => string>

export type TagMutation = keyof typeof TAG_MUTATIONS | 'all' | 'none'
/** every spelling but the one the editor writes */
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

/** hiddenDeckBytes with every ppt/**\/*.xml part's tags rewritten by `mutation`, written to `dir`. */
export async function mutatedHiddenDeck(
  dir: string,
  mutation: TagMutation,
  name = 'mutated.pptx',
  stories: readonly StoryTag[] = ALL_STORIES,
): Promise<string> {
  const zip = await JSZip.loadAsync(await hiddenDeckBytes(stories))
  for (const path of Object.keys(zip.files)) {
    if (!/^ppt\/.*\.xml$/.test(path)) continue
    zip.file(path, mutate(await zip.file(path)!.async('string'), mutation))
  }
  const file = join(dir, name)
  writeFileSync(file, await zip.generateAsync({ type: 'uint8array' }))
  return file
}
