import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { OLD_REDACT_NS } from '../../../agent-core/src/old-names'
import { buildDocx } from './build-docx'

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

function plainRun(text: string): string {
  return `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`
}

/**
 * A docx whose body, header, footer, comment and footnote each hold a run
 * marked hidden from AI under `spelling`: `${SECRET}` followed by B, H, F, C
 * or N, after a plain lead-in (`Body text and `, `Head `, `Foot `, `Note: `,
 * `See `).
 */
export async function hiddenStoriesDocx(
  dir: string,
  ns: string,
  name = 'stories.docx',
  spelling: MarkSpelling = 'go',
): Promise<string> {
  const hiddenRun = (namespace: string, text: string) => hiddenRunOf(namespace, text, spelling)
  const bytes = await buildDocx({
    bodyXml:
      '<w:p><w:commentRangeStart w:id="1"/>' +
      plainRun('Body text') +
      '<w:commentRangeEnd w:id="1"/>' +
      plainRun(' and ') +
      hiddenRun(ns, `${SECRET}B`) +
      '<w:r><w:commentReference w:id="1"/></w:r>' +
      '<w:r><w:footnoteReference w:id="1"/></w:r></w:p>',
    headerXml: `<w:p>${plainRun('Head ')}${hiddenRun(ns, `${SECRET}H`)}</w:p>`,
    footerXml: `<w:p>${plainRun('Foot ')}${hiddenRun(ns, `${SECRET}F`)}</w:p>`,
    extraRels:
      '<Relationship Id="rIdFn" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" Target="footnotes.xml"/>',
    extraParts: [
      {
        path: 'word/comments.xml',
        xml:
          `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:comments ${W_NS}>` +
          `<w:comment w:id="1" w:author="Kim"><w:p>${plainRun('Note: ')}${hiddenRun(ns, `${SECRET}C`)}</w:p></w:comment>` +
          '</w:comments>',
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml',
      },
      {
        path: 'word/footnotes.xml',
        xml:
          `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:footnotes ${W_NS}>` +
          '<w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote>' +
          '<w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>' +
          `<w:footnote w:id="1"><w:p><w:r><w:footnoteRef/></w:r>${plainRun(' See ')}${hiddenRun(ns, `${SECRET}N`)}</w:p></w:footnote>` +
          '</w:footnotes>',
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml',
      },
    ],
  })
  const file = join(dir, name)
  writeFileSync(file, bytes)
  return file
}
