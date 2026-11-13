import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildDocx } from '../../docx-engine/tests/helpers/build-docx'
import { LABEL, OWN_REDACT_NS, PLACEHOLDER, SECRET } from './hidden-text-fixtures'
import { run, tempDir } from './helpers'

/**
 * `docs read --fields` lists a field over words a person hid from AI, or one
 * whose instruction repeats them, as the placeholder in every part (keyword,
 * instruction, result): the result alone being withheld would still hand the
 * words over in a HYPERLINK or MERGEFIELD instruction. An error about a field
 * does not quote such an instruction either.
 */

const rPr = `<w:rPr><go:redact xmlns:go="${OWN_REDACT_NS}" w:label="${LABEL}"/></w:rPr>`
const plain = (text: string) => `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`
const hidden = (text: string) => `<w:r>${rPr}<w:t>${text}</w:t></w:r>`
const field = (instr: string, result: string, instrHidden = false) =>
  '<w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
  `<w:r>${instrHidden ? rPr : ''}<w:instrText xml:space="preserve"> ${instr} </w:instrText></w:r>` +
  '<w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
  result +
  '<w:r><w:fldChar w:fldCharType="end"/></w:r>'
const cellTable = (inner: string) =>
  '<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="4000"/></w:tblGrid>' +
  `<w:tr><w:tc><w:p>${inner}</w:p></w:tc></w:tr></w:tbl>`

async function docx(bodyXml: string): Promise<string> {
  const file = join(tempDir(), 'fields.docx')
  writeFileSync(file, await buildDocx({ bodyXml }))
  return file
}

interface Field {
  type: string
  instr: string
  result: string
}

async function fieldsOf(file: string): Promise<Field[]> {
  const read = await run(['docs', 'read', file, '--fields', '--full', '--html', '--json'])
  expect(read.code).toBe(0)
  expect(read.stdout).not.toContain(SECRET)
  return read.json().detail.fields
}

const withheld = { type: PLACEHOLDER, instr: PLACEHOLDER, result: PLACEHOLDER }

describe('docs read --fields: a field and hidden words', () => {
  const HIDDEN_ELSEWHERE = `<w:p>${plain('Call ')}${hidden(SECRET)}</w:p>`
  const cases: Array<{ name: string; body: string; listed?: boolean }> = [
    {
      name: 'a paragraph field whose result is hidden',
      body: `<w:p>${plain('Call ')}${field(`HYPERLINK "tel:${SECRET}"`, hidden(SECRET))}</w:p>`,
    },
    {
      name: 'a table cell field whose result is hidden',
      body: cellTable(field(`HYPERLINK "tel:${SECRET}"`, hidden(SECRET))) + '<w:p/>',
    },
    {
      name: 'a paragraph merge field whose result is hidden',
      body: `<w:p>${plain('Call ')}${field('MERGEFIELD Phone', hidden(SECRET))}</w:p>`,
      listed: true,
    },
    {
      name: 'a table cell merge field whose result is hidden',
      body: cellTable(field('MERGEFIELD Phone', hidden(SECRET))) + '<w:p/>',
      listed: true,
    },
    {
      name: 'a paragraph field whose instruction repeats hidden words',
      body: HIDDEN_ELSEWHERE + `<w:p>${field(`MERGEFIELD ${SECRET}`, plain('Phone'))}</w:p>`,
      listed: true,
    },
    {
      name: 'a table cell field whose instruction repeats hidden words',
      body: HIDDEN_ELSEWHERE + cellTable(field(`MERGEFIELD ${SECRET}`, plain('Phone'))) + '<w:p/>',
      listed: true,
    },
    {
      name: 'a table cell field whose instruction itself is hidden',
      body: cellTable(field(`MERGEFIELD ${SECRET}`, plain('Phone'), true)) + '<w:p/>',
      listed: true,
    },
    {
      name: 'a field whose instruction repeats one short word of a hidden run',
      body:
        `<w:p>${plain('Name: ')}${hidden('환자 이름')}</w:p>` +
        cellTable(field('MERGEFIELD 환자', plain('Phone'))) +
        '<w:p/>',
      listed: true,
    },
    {
      name: 'a paragraph field whose instruction itself is hidden',
      body: `<w:p>${field(`MERGEFIELD ${SECRET}`, plain('Phone'), true)}</w:p>`,
      listed: true,
    },
  ]

  it.each(cases)('$name reads as the placeholder', async ({ body, listed }) => {
    const fields = await fieldsOf(await docx(body))
    // a HYPERLINK becomes a link, which is no field to list
    if (listed) expect(fields).toHaveLength(1)
    for (const f of fields) expect(f).toMatchObject(withheld)
  })

  it('a plain field beside hidden words reads as itself', async () => {
    const fields = await fieldsOf(
      await docx(HIDDEN_ELSEWHERE + cellTable(field('MERGEFIELD Name', plain('Kim'))) + '<w:p/>'),
    )
    expect(fields).toEqual([
      expect.objectContaining({ type: 'MERGEFIELD', instr: 'MERGEFIELD Name', result: 'Kim' }),
    ])
  })

  it('an anchor that ends inside such a field does not quote its instruction', async () => {
    const file = await docx(
      HIDDEN_ELSEWHERE + cellTable(field(`MERGEFIELD ${SECRET}`, plain('Phone'))) + '<w:p/>',
    )
    const ops = join(tempDir(), 'ops.json')
    writeFileSync(
      ops,
      JSON.stringify([{ op: 'insert_footnote', blockIndex: 1, afterText: 'Pho', text: 'x' }]),
    )
    const applied = await run(['docs', 'apply', file, '--ops', ops, '--json'])
    expect(applied.stdout + applied.stderr).toContain('ends inside a field')
    expect(applied.stdout + applied.stderr).not.toContain(SECRET)
  })

  it('an anchor that ends inside a field naming a short hidden word does not quote it', async () => {
    const file = await docx(
      `<w:p>${plain('Name: ')}${hidden('환자 이름')}</w:p>` +
        cellTable(field('MERGEFIELD 환자', plain('Phone'))) +
        '<w:p/>',
    )
    const ops = join(tempDir(), 'ops.json')
    writeFileSync(
      ops,
      JSON.stringify([{ op: 'insert_footnote', blockIndex: 1, afterText: 'Pho', text: 'x' }]),
    )
    const applied = await run(['docs', 'apply', file, '--ops', ops, '--json'])
    expect(applied.stdout + applied.stderr).toContain('ends inside a field')
    expect(applied.stdout + applied.stderr).not.toContain('환자')
  })
})
