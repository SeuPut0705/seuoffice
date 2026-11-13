import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildDocx } from './build-docx'
import { mutate, OWN_REDACT_NS, PLACEHOLDER, SECRET, type TagMutation } from './hidden-stories'

/**
 * A document with tracked changes (an insertion, a deletion, a formatting
 * change) whose changed words a person hid from AI, in the body and in every
 * story outside it: header, footer, footnote, endnote, a text box and a comment.
 * `literal`: the hidden words are the placeholder itself, `{{client phone}}`.
 */

export const REVISION_KINDS = ['ins', 'del', 'rPrChange'] as const
export type RevisionKind = (typeof REVISION_KINDS)[number]

export const STORIES = ['body', 'header', 'footer', 'footnote', 'endnote', 'textbox'] as const
export type Story = (typeof STORIES)[number]

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
const REV = (id: number) => ` w:id="${id}" w:author="Ann" w:date="2026-09-29T12:23:00Z"`
const mark = `<go:redact xmlns:go="${OWN_REDACT_NS}" w:label="client phone"/>`

export const hiddenWords = (literal: boolean) => (literal ? PLACEHOLDER : `${SECRET}R`)

let seq = 100
const rev = () => REV(seq++)

const plain = (text: string) => `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`
const hiddenRun = (words: string, extra = '', inner?: string) =>
  `<w:r><w:rPr>${mark}${extra}</w:rPr>${inner ?? `<w:t>${words}</w:t>`}</w:r>`

/** the paragraph of a story holding one hidden tracked change of `kind` */
export function trackedParagraph(kind: RevisionKind, words: string, lead = 'Lead '): string {
  const body =
    kind === 'ins'
      ? `<w:ins${rev()}>${hiddenRun(words)}</w:ins>`
      : kind === 'del'
        ? `<w:del${rev()}>${hiddenRun(words, '', `<w:delText>${words}</w:delText>`)}</w:del>`
        : hiddenRun(words, `<w:b/><w:rPrChange${rev()}><w:rPr/></w:rPrChange>`)
  return `<w:p>${plain(lead)}${body}</w:p>`
}

const paragraphsOf = (words: string) =>
  REVISION_KINDS.map((kind) => trackedParagraph(kind, words, `${kind} `)).join('')

const textbox = (words: string) =>
  '<w:p><w:r><w:drawing><wp:anchor behindDoc="0" simplePos="0" locked="0" layoutInCell="1" allowOverlap="1">' +
  '<wp:simplePos x="0" y="0"/><wp:extent cx="6038850" cy="1704975"/>' +
  '<a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">' +
  '<wps:wsp xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">' +
  '<wps:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="6038850" cy="1704975"/></a:xfrm>' +
  '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></wps:spPr>' +
  `<wps:txbx><w:txbxContent>${paragraphsOf(words)}</w:txbxContent></wps:txbx></wps:wsp>` +
  '</a:graphicData></a:graphic></wp:anchor></w:drawing></w:r></w:p>'

/** body changes that are not a run: a moved run, a paragraph mark, a table row, a field result, a deleted block */
const bodyExtras = (words: string) =>
  `<w:p>${plain('move ')}<w:moveFrom${rev()}>${hiddenRun(words, '', `<w:delText>${words}</w:delText>`)}</w:moveFrom></w:p>` +
  `<w:p>${plain('move ')}<w:moveTo${rev()}>${hiddenRun(words)}</w:moveTo></w:p>` +
  `<w:p><w:pPr><w:rPr><w:del${rev()}/></w:rPr></w:pPr>${hiddenRun(words)}</w:p>` +
  `<w:p><w:pPr><w:rPr><w:ins${rev()}/></w:rPr></w:pPr>${hiddenRun(words)}</w:p>` +
  `<w:p>${plain('field ')}<w:ins${rev()}><w:r><w:fldChar w:fldCharType="begin"/></w:r>` +
  '<w:r><w:instrText xml:space="preserve"> REF Anchor </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
  `${hiddenRun(words)}<w:r><w:fldChar w:fldCharType="end"/></w:r></w:ins></w:p>` +
  '<w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="4000"/></w:tblGrid>' +
  `<w:tr><w:trPr><w:ins${rev()}/></w:trPr><w:tc><w:p>${hiddenRun(words)}</w:p></w:tc></w:tr>` +
  `<w:tr><w:trPr><w:del${rev()}/></w:trPr><w:tc><w:p><w:del${rev()}>${hiddenRun(words, '', `<w:delText>${words}</w:delText>`)}</w:del></w:p></w:tc></w:tr></w:tbl>`

export async function revisionsDocx(
  dir: string,
  mutation: TagMutation | 'none' = 'none',
  literal = false,
  name = 'revisions.docx',
): Promise<string> {
  seq = 100
  const words = hiddenWords(literal)
  const bytes = await buildDocx({
    bodyXml:
      `<w:p><w:bookmarkStart w:id="1" w:name="Anchor"/>${plain('Anchor')}<w:bookmarkEnd w:id="1"/>` +
      '<w:r><w:footnoteReference w:id="2"/></w:r><w:r><w:endnoteReference w:id="3"/></w:r>' +
      '<w:r><w:commentReference w:id="1"/></w:r></w:p>' +
      paragraphsOf(words) +
      bodyExtras(words) +
      textbox(words),
    headerXml: paragraphsOf(words),
    footerXml: paragraphsOf(words),
    extraRels:
      '<Relationship Id="rIdFn" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" Target="footnotes.xml"/>' +
      '<Relationship Id="rIdEn" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/endnotes" Target="endnotes.xml"/>',
    extraParts: [
      {
        path: 'word/footnotes.xml',
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml',
        xml:
          `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:footnotes ${W}>` +
          '<w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote>' +
          '<w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>' +
          `<w:footnote w:id="2"><w:p><w:r><w:footnoteRef/></w:r></w:p>${paragraphsOf(words)}</w:footnote></w:footnotes>`,
      },
      {
        path: 'word/endnotes.xml',
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.endnotes+xml',
        xml:
          `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:endnotes ${W}>` +
          '<w:endnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:endnote>' +
          '<w:endnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:endnote>' +
          `<w:endnote w:id="3"><w:p><w:r><w:endnoteRef/></w:r></w:p>${paragraphsOf(words)}</w:endnote></w:endnotes>`,
      },
      {
        path: 'word/comments.xml',
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml',
        xml:
          `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:comments ${W}>` +
          `<w:comment w:id="1" w:author="Kim">${paragraphsOf(words)}</w:comment></w:comments>`,
      },
    ],
  })
  const file = join(dir, name)
  if (mutation === 'none') {
    writeFileSync(file, bytes)
    return file
  }
  const { default: JSZip } = await import('jszip')
  const zip = await JSZip.loadAsync(bytes)
  for (const path of Object.keys(zip.files)) {
    if (!/^word\/[^/]+\.xml$/.test(path)) continue
    zip.file(path, mutate(await zip.file(path)!.async('string'), mutation))
  }
  writeFileSync(file, await zip.generateAsync({ type: 'uint8array' }))
  return file
}
