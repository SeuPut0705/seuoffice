import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { OLD_REDACT_NS } from '../../../agent-core/src/old-names'
import { buildDocx, TINY_PNG_BASE64 } from './build-docx'

/**
 * Documents holding text a person marked "hidden from AI", for the readers
 * that must withhold it: the docs app's AI readers and the command line.
 */

export const OWN_REDACT_NS = 'https://github.com/SeuPut0705/seuoffice/redaction/2026'
export const NAMESPACES: Array<[string, string]> = [
  ['the old namespace', OLD_REDACT_NS],
  ['this product’s own namespace', OWN_REDACT_NS],
]
export const LABEL = 'client phone'
export const SECRET = '13800138000'
export const PLACEHOLDER = `{{${LABEL}}}`

const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'

/**
 * The rPr of a run marked hidden from AI. `go` is how the document editor
 * writes it; the others are spellings another writer may use for the same
 * mark: another prefix, no prefix with the namespace declared on the mark,
 * and no prefix with the namespace declared on the rPr around it.
 */
export type MarkSpelling = 'go' | 'other prefix' | 'unprefixed' | 'unprefixed, inherited' | 'spaced'
export const MARK_SPELLINGS: MarkSpelling[] = [
  'go',
  'other prefix',
  'unprefixed',
  'unprefixed, inherited',
  'spaced',
]

function markedRPr(ns: string, spelling: MarkSpelling): string {
  const bdr = '<w:bdr w:val="single" w:sz="6" w:color="6B4FC0"/>'
  switch (spelling) {
    case 'go':
    case 'spaced':
      return `<w:rPr>${bdr}<go:redact xmlns:go="${ns}" w:label="${LABEL}"/></w:rPr>`
    case 'other prefix':
      return `<w:rPr>${bdr}<gx:redact xmlns:gx="${ns}" w:label="${LABEL}"/></w:rPr>`
    case 'unprefixed':
      return `<w:rPr>${bdr}<redact xmlns="${ns}" w:label="${LABEL}"/></w:rPr>`
    case 'unprefixed, inherited':
      return `<w:rPr xmlns="${ns}">${bdr}<redact w:label="${LABEL}"/></w:rPr>`
  }
}

/** A run marked hidden from AI. */
function hiddenRunOf(ns: string, text: string, spelling: MarkSpelling = 'go'): string {
  // pretty-printed XML: white space and a comment between the run and its properties
  if (spelling === 'spaced') {
    return `<w:r>\n  <!-- marked -->\n  ${markedRPr(ns, 'go')}\n  <w:t>${text}</w:t>\n</w:r>`
  }
  return `<w:r>${markedRPr(ns, spelling)}<w:t>${text}</w:t></w:r>`
}

const relsPart = (inner: string) =>
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${inner}</Relationships>`

function plainRun(text: string): string {
  return `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`
}

/**
 * Pictures inside runs marked hidden from AI, one per story (`B` an inline one
 * in the body paragraph, `BA` a floating one there, `BI` one alone in its
 * paragraph, `BX` one alone in its paragraph whose media part is missing, `H`, `F`, `C`, `N` and `S` the header, footer, comment, note and
 * inline content control). Each carries `${SECRET}P<story>` as the wp:docPr
 * name, descr and title and as the pic:cNvPr name and descr, and its own
 * media part, named by it, whose bytes are recognisable as
 * hiddenPictureBase64(story).
 */
export const PICTURE_STORIES = ['B', 'BA', 'BI', 'BX', 'H', 'F', 'C', 'N', 'S'] as const
export type PictureStory = (typeof PICTURE_STORIES)[number]

/** what a hidden picture's alt text reads */
export const pictureAlt = (story: PictureStory): string => `${SECRET}P${story}`

/** The alt text of the picture no mark covers: readers must still hand it over. */
export const PLAIN_PICTURE_ALT = 'Company logo'
/** The bytes of that picture (the engine fixtures' 1x1 png). */
export const PLAIN_PICTURE_BASE64 = TINY_PNG_BASE64

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
  }
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'ascii')
  const body = Buffer.concat([head.subarray(4), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([head, data, crc])
}

/** The base64 of a 1x1 png whose one pixel is told apart by the story, so its bytes can be looked for in what a reader hands over. */
export function hiddenPictureBase64(story: PictureStory): string {
  const seed = PICTURE_STORIES.indexOf(story) + 1
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(1, 0)
  ihdr.writeUInt32BE(1, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const pixel = Buffer.from([0, 16 * seed, 255 - 16 * seed, 77 + seed])
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(pixel)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]).toString('base64')
}

const mediaPath = (story: PictureStory) => `media/${SECRET}P${story}.png`
const relId = (story: PictureStory) => (story === 'BX' ? 'rIdNoSuchPart' : `rIdPic${story}`)
const IMAGE_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image'
const DRAWING_NS =
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'

const imageRels = (stories: PictureStory[]) =>
  stories
    .filter((s) => s !== 'BX')
    .map((s) => `<Relationship Id="${relId(s)}" Type="${IMAGE_REL}" Target="${mediaPath(s)}"/>`)
    .join('')

/** a picture drawing; `plain` is the control no mark covers (over rId10, the fixtures' image1.png) */
function drawingOf(story: PictureStory | 'plain', id: number): string {
  const alt = story === 'plain' ? PLAIN_PICTURE_ALT : pictureAlt(story)
  const rid = story === 'plain' ? 'rId10' : relId(story)
  const graphic =
    `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
    `<pic:pic><pic:nvPicPr><pic:cNvPr id="${id}" name="${alt}" descr="${alt}"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="95250" cy="95250"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>' +
    '</pic:pic></a:graphicData></a:graphic>'
  const docPr = `<wp:docPr id="${id}" name="${alt}" descr="${alt}" title="${alt}"/>`
  if (story === 'BA') {
    return (
      '<w:drawing><wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="1" behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1">' +
      '<wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="column"><wp:posOffset>0</wp:posOffset></wp:positionH>' +
      '<wp:positionV relativeFrom="paragraph"><wp:posOffset>0</wp:posOffset></wp:positionV>' +
      `<wp:extent cx="95250" cy="95250"/><wp:wrapSquare wrapText="bothSides"/>${docPr}<wp:cNvGraphicFramePr/>${graphic}</wp:anchor></w:drawing>`
    )
  }
  return `<w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="95250" cy="95250"/>${docPr}<wp:cNvGraphicFramePr/>${graphic}</wp:inline></w:drawing>`
}

const pictureIds: Record<PictureStory | 'plain', number> = {
  B: 11,
  BA: 12,
  BI: 13,
  BX: 20,
  H: 14,
  F: 15,
  C: 16,
  N: 17,
  S: 18,
  plain: 19,
}

/** A run marked hidden from AI that holds one picture. */
export function hiddenPictureRunOf(
  ns: string,
  story: PictureStory,
  spelling: MarkSpelling,
): string {
  const drawing = drawingOf(story, pictureIds[story])
  if (spelling === 'spaced') {
    return `<w:r>\n  <!-- marked -->\n  ${markedRPr(ns, 'go')}\n  ${drawing}\n</w:r>`
  }
  return `<w:r>${markedRPr(ns, spelling)}${drawing}</w:r>`
}

/** A run holding a picture no mark covers. */
const plainPictureRun = () => `<w:r>${drawingOf('plain', pictureIds.plain)}</w:r>`

export interface StoriesOptions {
  /** each story also holds a hidden picture (PICTURE_STORIES); the header, the note, a second comment and a body paragraph of their own hold a plain one */
  pictures?: boolean
  /** the hidden runs' words are the placeholder itself, `{{client phone}}`, so that what a model reads of them equals what they say; the body also holds an inline control around one */
  literal?: boolean
}

const controlOf = (runs: string) =>
  `<w:sdt><w:sdtPr><w:tag w:val="phone"/></w:sdtPr><w:sdtContent>${runs}</w:sdtContent></w:sdt>`

/**
 * A docx whose body, header, footer, comment and footnote each hold a run
 * marked hidden from AI under `spelling`: `${SECRET}` followed by B, H, F, C
 * or N, after a plain lead-in (`Body text and `, `Head `, `Foot `, `Note: `,
 * `See `). See StoriesOptions for the variants.
 */
export async function hiddenStoriesDocx(
  dir: string,
  ns: string,
  name = 'stories.docx',
  spelling: MarkSpelling = 'go',
  { pictures = false, literal = false }: StoriesOptions = {},
): Promise<string> {
  const words = (tag: string) => (literal ? PLACEHOLDER : `${SECRET}${tag}`)
  const hiddenRun = (namespace: string, text: string) => hiddenRunOf(namespace, text, spelling)
  const picture = (story: PictureStory) => (pictures ? hiddenPictureRunOf(ns, story, spelling) : '')
  const plainPicture = pictures ? plainPictureRun() : ''
  const drawingNs = pictures ? ` ${DRAWING_NS}` : ''
  const bytes = await buildDocx({
    bodyXml:
      '<w:p><w:commentRangeStart w:id="1"/>' +
      plainRun('Body text') +
      '<w:commentRangeEnd w:id="1"/>' +
      plainRun(' and ') +
      hiddenRun(ns, words('B')) +
      picture('B') +
      picture('BA') +
      (literal ? controlOf(hiddenRun(ns, words('S'))) : '') +
      '<w:r><w:commentReference w:id="1"/></w:r>' +
      '<w:r><w:footnoteReference w:id="1"/></w:r></w:p>' +
      (pictures
        ? `<w:p>${picture('BI')}</w:p><w:p>${picture('BX')}</w:p>` +
          `<w:p><w:commentRangeStart w:id="2"/>${plainPicture}<w:commentRangeEnd w:id="2"/><w:r><w:commentReference w:id="2"/></w:r></w:p>`
        : ''),
    headerXml: `<w:p>${plainRun('Head ')}${hiddenRun(ns, words('H'))}${picture('H')}${plainPicture}</w:p>`,
    footerXml: `<w:p>${plainRun('Foot ')}${hiddenRun(ns, words('F'))}${picture('F')}</w:p>`,
    ...(pictures
      ? {
          withImage: true,
          headerRelsXml:
            `<Relationship Id="rId10" Type="${IMAGE_REL}" Target="media/image1.png"/>` +
            imageRels(['H']),
          footerRelsXml: imageRels(['F']),
          binaryParts: PICTURE_STORIES.filter((story) => story !== 'BX').map((story) => ({
            path: `word/${mediaPath(story)}`,
            base64: hiddenPictureBase64(story),
            extension: 'png',
            contentType: 'image/png',
          })),
        }
      : {}),
    extraRels:
      '<Relationship Id="rIdFn" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" Target="footnotes.xml"/>' +
      (pictures ? imageRels(['B', 'BA', 'BI', 'S']) : ''),
    extraParts: [
      {
        path: 'word/comments.xml',
        xml:
          `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:comments ${W_NS}${drawingNs}>` +
          `<w:comment w:id="1" w:author="Kim"><w:p>${plainRun('Note: ')}${hiddenRun(ns, words('C'))}${picture('C')}</w:p></w:comment>` +
          (pictures
            ? `<w:comment w:id="2" w:author="Lee"><w:p>${plainRun('Logo: ')}${plainPicture}</w:p></w:comment>`
            : '') +
          '</w:comments>',
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml',
      },
      {
        path: 'word/footnotes.xml',
        xml:
          `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:footnotes ${W_NS}${drawingNs}>` +
          '<w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote>' +
          '<w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>' +
          `<w:footnote w:id="1"><w:p><w:r><w:footnoteRef/></w:r>${plainRun(' See ')}${hiddenRun(ns, words('N'))}${picture('N')}${plainPicture}</w:p></w:footnote>` +
          '</w:footnotes>',
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml',
      },
      ...(pictures
        ? [
            {
              path: 'word/_rels/comments.xml.rels',
              xml: relsPart(
                `<Relationship Id="rId10" Type="${IMAGE_REL}" Target="media/image1.png"/>${imageRels(['C'])}`,
              ),
              contentType: '',
            },
            {
              path: 'word/_rels/footnotes.xml.rels',
              xml: relsPart(
                `<Relationship Id="rId10" Type="${IMAGE_REL}" Target="media/image1.png"/>${imageRels(['N'])}`,
              ),
              contentType: '',
            },
          ]
        : []),
    ],
  })
  const file = join(dir, name)
  writeFileSync(file, bytes)
  return file
}

/**
 * The same tags written another valid way, as another producer may write
 * them. Each changes the XML text a pattern reads and leaves the document the
 * XML parser reads as it was (but `prefix`, which renames the main namespace's
 * prefix, so a reader that names `w:` reads nothing at all).
 */
export const TAG_MUTATIONS = {
  'single quotes': (xml: string) =>
    xml.replace(/<[^>!?]+>/g, (tag) => tag.replace(/="([^"]*)"/g, "='$1'")),
  'spaces around =': (xml: string) =>
    xml.replace(/<[^>!?]+>/g, (tag) => tag.replace(/(\s[\w:.-]+)=(["'])/g, '$1 = $2')),
  '> and /> inside values': (xml: string) =>
    xml
      .replace(/<(w:r|w:comment|w:footnote|w:sdt)(?=[\s>])/g, '<$1 w:x="a/>b>c"')
      .replace(/<w:p(?=[\s>])/g, '<w:p w:x="a>b"'),
  comments: (xml: string) =>
    xml
      .replace(/(<w:r(?:\s[^>]*)?>)/g, '$1<!-- </w:r></w:p> <go:redact w:label="x"/> -->')
      .replace(/<\/w:t>/g, '<!-- </w:t> --></w:t>'),
  // a hidden run's words inside CDATA dressed as a control, a note and a comment
  // of their own: a pattern that takes them for markup makes an unmarked entry
  'fake markup in CDATA': (xml: string) =>
    xml.replace(
      new RegExp(`<w:t([^>]*)>(${SECRET}[A-Z]?)</w:t>`, 'g'),
      (_all, attrs: string, words: string) =>
        `<w:t${attrs}><![CDATA[<w:sdt><w:sdtContent><w:r><w:t>${words}</w:t></w:r></w:sdtContent></w:sdt>` +
        `</w:footnote><w:footnote w:id="9"><w:p><w:r><w:t>${words}</w:t></w:r></w:p></w:footnote>` +
        `</w:comment><w:comment w:id="9" w:author="K"><w:p><w:r><w:t>${words}</w:t></w:r></w:p></w:comment>]]></w:t>`,
    ),
  'space before > in end tags': (xml: string) => xml.replace(/<\/([\w:.-]+)>/g, '</$1 >'),
  CDATA: (xml: string) =>
    xml.replace(
      new RegExp(`<w:t([^>]*)>(${SECRET}[A-Z]?)</w:t>`, 'g'),
      '<w:t$1><![CDATA[</w:r></w:p>]]><![CDATA[$2]]></w:t>',
    ),
  'namespace prefix': (xml: string) =>
    xml
      .replace(/xmlns:w=/g, 'xmlns:ww=')
      .replace(/(<\/?)w:/g, '$1ww:')
      .replace(/(\s)w:/g, '$1ww:'),
} satisfies Record<string, (xml: string) => string>

export type TagMutation = keyof typeof TAG_MUTATIONS | 'all'
export const TAG_MUTATION_NAMES = [...Object.keys(TAG_MUTATIONS), 'all'] as TagMutation[]

function mutate(xml: string, mutation: TagMutation): string {
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

/** hiddenStoriesDocx with every word/*.xml part's tags rewritten by `mutation`. */
export async function mutatedStoriesDocx(
  dir: string,
  mutation: TagMutation,
  options: StoriesOptions = {},
): Promise<string> {
  const { default: JSZip } = await import('jszip')
  const { readFileSync } = await import('node:fs')
  const file = await hiddenStoriesDocx(dir, OWN_REDACT_NS, `mutated.docx`, 'go', options)
  const zip = await JSZip.loadAsync(readFileSync(file))
  // a plain paragraph to edit, and an inline content control holding a hidden
  // run in a paragraph of its own
  const documentXml = await zip.file('word/document.xml')!.async('string')
  zip.file(
    'word/document.xml',
    documentXml.replace(
      '<w:sectPr',
      '<w:p><w:r><w:t>Edit me please</w:t></w:r></w:p>' +
        '<w:p><w:sdt><w:sdtPr><w:tag w:val="phone"/></w:sdtPr><w:sdtContent>' +
        `${hiddenRunOf(OWN_REDACT_NS, options.literal ? PLACEHOLDER : `${SECRET}S`)}` +
        `${options.pictures ? hiddenPictureRunOf(OWN_REDACT_NS, 'S', 'go') : ''}</w:sdtContent></w:sdt></w:p><w:sectPr`,
    ),
  )
  for (const path of Object.keys(zip.files)) {
    if (!/^word\/[^/]+\.xml$/.test(path)) continue
    zip.file(path, mutate(await zip.file(path)!.async('string'), mutation))
  }
  writeFileSync(file, await zip.generateAsync({ type: 'uint8array' }))
  return file
}
