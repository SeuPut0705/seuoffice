import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import { buildDocx } from '../../../packages/docx-engine/tests/helpers/build-docx'
import { openCoEdited, settled, type CoFile } from './collab'

const repo = fileURLToPath(new URL('../../..', import.meta.url))
const at = (path: string): string => resolve(repo, path)

const para = (text: string, style?: string) =>
  `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`

const FOOTNOTES =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
  '<w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote>' +
  '<w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>' +
  '<w:footnote w:id="1"><w:p><w:r><w:t>The note.</w:t></w:r></w:p></w:footnote></w:footnotes>'

/** A table of contents over three headings, tracked changes and a footnote, in one file */
async function fieldsAndNotes(): Promise<CoFile> {
  const toc =
    '<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
    '<w:r><w:instrText xml:space="preserve"> TOC \\o "1-3" \\h \\z \\u </w:instrText></w:r>' +
    '<w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
    '<w:r><w:t>Chapter one</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>1</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t>Chapter two</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>1</w:t></w:r>' +
    '<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>'
  const body =
    toc +
    para('Chapter one', 'Heading1') +
    '<w:p><w:r><w:t xml:space="preserve">Kept </w:t></w:r>' +
    '<w:ins w:id="11" w:author="Reviewer" w:date="2024-01-01T00:00:00Z"><w:r><w:t>inserted</w:t></w:r></w:ins>' +
    '<w:del w:id="12" w:author="Reviewer" w:date="2024-01-01T00:00:00Z"><w:r><w:delText>gone</w:delText></w:r></w:del>' +
    '<w:r><w:t xml:space="preserve"> with a note</w:t></w:r>' +
    '<w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:footnoteReference w:id="1"/></w:r></w:p>' +
    Array.from({ length: 60 }, (_, i) =>
      para(`Filler paragraph ${i} pushing the second chapter down.`),
    ).join('') +
    para('Chapter two', 'Heading1')
  const bytes = await buildDocx({
    bodyXml: body,
    extraParts: [
      {
        path: 'word/footnotes.xml',
        xml: FOOTNOTES,
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml',
      },
    ],
    extraRels:
      '<Relationship Id="rIdFootnotes" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" Target="footnotes.xml"/>',
  })
  return { name: 'fields-and-notes.docx', mimeType: DOCX, buffer: Buffer.from(bytes) }
}

/** Many pages of mixed paragraphs and small tables */
async function longDocument(): Promise<CoFile> {
  const table = (n: number) =>
    `<w:tbl><w:tblGrid><w:gridCol w:w="4000"/><w:gridCol w:w="4000"/></w:tblGrid><w:tr>` +
    `<w:tc>${para(`cell ${n}a`)}</w:tc><w:tc>${para(`cell ${n}b`)}</w:tc></w:tr></w:tbl>`
  const body = Array.from({ length: 400 }, (_, i) =>
    i % 25 === 0
      ? table(i) + para(`Section ${i}`, 'Heading2')
      : para(`Line ${i} of a long document.`),
  ).join('')
  const bytes = await buildDocx({ bodyXml: body })
  return { name: 'long.docx', mimeType: DOCX, buffer: Buffer.from(bytes) }
}

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

const FILES: Array<{ label: string; file: () => Promise<CoFile> | CoFile }> = [
  { label: 'pictures, tables and lists', file: () => at('fixtures/generated/kitchen-sink.docx') },
  {
    label: 'a floating captioned table',
    file: () => at('fixtures/generated/visual-captable-float.docx'),
  },
  { label: 'nested tables', file: () => at('packages/docx2hwp/tests/fixtures/nested.docx') },
  { label: 'a notice with tabs', file: () => at('packages/docx2hwp/tests/fixtures/notice.docx') },
  {
    label: 'a picture in the header',
    file: () =>
      at('packages/docx-engine/tests/fixtures/truths/render-hf-inline-picture/probe.docx'),
  },
  {
    label: 'a header anchor',
    file: () =>
      at('packages/docx-engine/tests/fixtures/truths/render-hf-anchor-reserve/probe.docx'),
  },
  {
    label: 'a text box',
    file: () => at('packages/docx-engine/tests/fixtures/truths/textbox-hangul-wrap/probe.docx'),
  },
  { label: 'a table of contents, tracked changes and a footnote', file: fieldsAndNotes },
  { label: 'a long document', file: longDocument },
]

test.setTimeout(120_000)

for (const { label, file } of FILES) {
  test(`two pages on ${label} write nothing of their own`, async ({ browser }) => {
    const documentId = `quiet-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const source = await file()
    const alice = await openCoEdited(browser, source, { documentId, user: 'alice' })
    const bob = await openCoEdited(browser, source, { documentId, user: 'bob' })
    // layout, pagination and fonts settle in this time; whatever they write must stay local
    await alice.page.waitForTimeout(5_000)
    expect(await settled([alice, bob])).toBe(0)
    await alice.page.waitForTimeout(2_000)
    expect(await settled([alice, bob])).toBe(0)
    expect(await bob.text()).toBe(await alice.text())
    await alice.page.context().close()
    await bob.page.context().close()
  })
}
