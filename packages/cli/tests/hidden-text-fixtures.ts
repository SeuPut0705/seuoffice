import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import JSZip from 'jszip'
import { expect } from 'vitest'
import { OLD_REDACT_NS } from '../../agent-core/src/old-names'
import {
  applyRedactionNameMirror,
  serializeRedactionPart,
  type SheetRedactionState,
} from '@seuoffice/xlsx-gateway/gateway/xlsx-redaction'
import { setRedactExt } from '../../pptx-engine/src/redaction-xml'
import { buildDocx } from '../../docx-engine/tests/helpers/build-docx'

/** Fixtures for text a person marked "hidden from AI", as the apps write it. */

export const OWN_REDACT_NS = 'https://github.com/SeuPut0705/seuoffice/redaction/2026'
export const NAMESPACES: Array<[string, string]> = [
  ['the old namespace', OLD_REDACT_NS],
  ['this product’s own namespace', OWN_REDACT_NS],
]
export const LABEL = 'client phone'
export const SECRET = '13800138000'
export const PLACEHOLDER = `{{${LABEL}}}`

const MC = 'http://schemas.openxmlformats.org/markup-compatibility/2006'

/** A docx whose one paragraph holds a span marked hidden from AI under `ns`. */
export async function hiddenDocx(dir: string, ns: string, name = 'hidden.docx'): Promise<string> {
  const bytes = await buildDocx({
    docRootExtraAttrs: `xmlns:mc="${MC}" xmlns:go="${ns}" mc:Ignorable="go"`,
    bodyXml:
      '<w:p><w:r><w:t xml:space="preserve">Call </w:t></w:r>' +
      '<w:r><w:rPr><w:bdr w:val="single" w:sz="6" w:color="6B4FC0"/>' +
      `<go:redact w:label="${LABEL}"/></w:rPr><w:t>${SECRET}</w:t></w:r>` +
      '<w:r><w:t xml:space="preserve"> now</w:t></w:r></w:p>',
  })
  const file = join(dir, name)
  writeFileSync(file, bytes)
  return file
}

/**
 * A deck whose slide text and speaker notes each hold a run marked hidden from
 * AI, written the way the slide editor writes the mark (its own helper).
 */
export async function hiddenPptx(dir: string, name = 'hidden.pptx'): Promise<string> {
  const { run } = await import('./helpers')
  const spec = join(dir, 'deck.json')
  writeFileSync(
    spec,
    JSON.stringify({
      pages: [
        {
          elements: [
            {
              type: 'text',
              x: 80,
              y: 80,
              w: 600,
              h: 80,
              paragraphs: [{ runs: [{ text: 'Call ' }, { text: SECRET }, { text: ' now' }] }],
            },
          ],
        },
      ],
    }),
  )
  const file = join(dir, name)
  expect(
    (await run(['create', '--type', 'pptx', '--spec', spec, '--out', file, '--json'])).code,
  ).toBe(0)
  const ops = join(dir, 'ops.json')
  writeFileSync(ops, JSON.stringify([{ op: 'setNotes', target: { slide: 0 }, text: SECRET }]))
  expect((await run(['slides', 'apply', file, '--ops', ops, '--json'])).code).toBe(0)
  const zip = await JSZip.loadAsync(readFileSync(file))
  for (const part of ['ppt/slides/slide1.xml', 'ppt/notesSlides/notesSlide1.xml']) {
    const xml = await zip.file(part)!.async('string')
    const marked = xml.replace(
      /<a:r>(<a:rPr[^>]*?\/>|<a:rPr[^>]*>[\s\S]*?<\/a:rPr>)?<a:t>13800138000<\/a:t><\/a:r>/,
      (_all, rPr: string | undefined) =>
        `<a:r>${setRedactExt(rPr ?? '<a:rPr lang="en-US"/>', LABEL)}<a:t>${SECRET}</a:t></a:r>`,
    )
    expect(marked).not.toBe(xml)
    zip.file(part, marked)
  }
  writeFileSync(file, await zip.generateAsync({ type: 'uint8array' }))
  return file
}

/**
 * A workbook with a phone number in B2 hidden from AI, and a total in C2 that
 * computes from it; the record is written the way a save of the sheet editor
 * writes it (the part and its copy in the defined names).
 */
export async function hiddenXlsx(dir: string, name = 'hidden.xlsx'): Promise<string> {
  const { run } = await import('./helpers')
  const table = join(dir, 'table.json')
  writeFileSync(
    table,
    JSON.stringify([
      ['Name', 'Phone', 'Double'],
      ['Kim', Number(SECRET), '=B2*2'],
    ]),
  )
  const file = join(dir, name)
  expect(
    (await run(['create', '--type', 'xlsx', '--from', table, '--out', file, '--json'])).code,
  ).toBe(0)
  const zip = await JSZip.loadAsync(readFileSync(file))
  const workbook = await zip.file('xl/workbook.xml')!.async('string')
  const sheetName = /<sheet\b[^>]*\bname="([^"]+)"/.exec(workbook)![1]!
  const states: SheetRedactionState[] = [
    {
      sheetName,
      marks: [{ startRow: 1, startColumn: 1, endRow: 1, endColumn: 1, label: LABEL }],
    },
  ]
  zip.file('xl/gxRedactions.json', serializeRedactionPart(states))
  zip.file('xl/workbook.xml', applyRedactionNameMirror(workbook, states, [sheetName]))
  writeFileSync(file, await zip.generateAsync({ type: 'uint8array' }))
  return file
}

const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'

/** A run marked hidden from AI the way the document editor writes one, its prefix bound on the element. */
function hiddenRun(ns: string, text: string): string {
  return (
    '<w:r><w:rPr><w:bdr w:val="single" w:sz="6" w:color="6B4FC0"/>' +
    `<go:redact xmlns:go="${ns}" w:label="${LABEL}"/></w:rPr><w:t>${text}</w:t></w:r>`
  )
}

function plainRun(text: string): string {
  return `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`
}

/**
 * A docx whose header, footer, comment and footnote each hold a run marked
 * hidden from AI: `${SECRET}` followed by H, F, C or N, after a plain lead-in
 * (`Head `, `Foot `, `Note: `, `See `).
 */
export async function hiddenStoriesDocx(
  dir: string,
  ns: string,
  name = 'stories.docx',
): Promise<string> {
  const bytes = await buildDocx({
    bodyXml:
      '<w:p><w:commentRangeStart w:id="1"/>' +
      plainRun('Body text') +
      '<w:commentRangeEnd w:id="1"/><w:r><w:commentReference w:id="1"/></w:r>' +
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
