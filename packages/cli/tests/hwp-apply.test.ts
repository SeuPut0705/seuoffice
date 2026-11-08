import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import init, { HwpDocument } from '@rhwp/core'
import { run, tempDir } from './helpers'

/** The documents are built with the engine the editor runs; there is no other writer here. */
beforeAll(async () => {
  const wasm = createRequire(import.meta.url).resolve('@rhwp/core/rhwp_bg.wasm')
  await init({ module_or_path: readFileSync(wasm) })
})

/** 제목 / 본문 / a 2×2 table with an empty cell / 끝 */
function report(): HwpDocument {
  const doc = HwpDocument.createEmpty()
  doc.createBlankDocument()
  const lines = ['등록제 시행 안내', '7월 1일부터 시행합니다.', '', '끝.']
  lines.forEach((line, index) => {
    if (index > 0) doc.splitParagraph(0, index - 1, doc.getParagraphLength(0, index - 1))
    if (line) doc.insertText(0, index, 0, line)
  })
  doc.pasteHtml(
    0,
    2,
    0,
    '<table><tr><td>구분</td><td>연락처</td></tr><tr><td>특송</td><td></td></tr></table>',
  )
  return doc
}

function write(dir: string, name: string, bytes: Uint8Array): string {
  const path = join(dir, name)
  writeFileSync(path, bytes)
  return path
}

function ops(dir: string, list: unknown): string {
  const path = join(dir, 'ops.json')
  writeFileSync(path, JSON.stringify(list))
  return path
}

/** The text of a written file, as the engine reads it back. */
function textOf(path: string): string[] {
  const doc = new HwpDocument(readFileSync(path))
  try {
    return (JSON.parse(doc.getTextFileText()) as string).split(/\r?\n/).filter(Boolean)
  } finally {
    doc.free()
  }
}

function isOle(path: string): boolean {
  return readFileSync(path)
    .subarray(0, 4)
    .equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0]))
}

function isZip(path: string): boolean {
  return readFileSync(path)
    .subarray(0, 4)
    .equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
}

const EDITS = [
  { op: 'replace_text', find: '7월 1일', replace: '8월 1일' },
  { op: 'insert_paragraphs', where: 'after', anchor: '시행합니다', paragraphs: ['문의는 아래로.'] },
  { op: 'fill_cells', table: 1, cells: [{ row: 2, col: 2, text: '032-722-4315' }] },
]

describe('ieumoffice hwp apply', () => {
  it('edits a .hwp in place, keeps it .hwp and the old bytes beside it', async () => {
    const dir = tempDir()
    const original = report().exportHwp()
    const path = write(dir, 'report.hwp', original)
    const r = await run(['hwp', 'apply', path, '--ops', ops(dir, EDITS), '--json'])
    expect(r.code, r.stdout).toBe(0)
    const { detail, output_path } = r.json()
    expect(output_path).toBe(path)
    expect(detail.format).toBe('hwp')
    expect(detail.batch).toMatchObject({ total: 3, applied: 3, failed: 0 })
    expect(detail.results.every((step: { changed: boolean }) => step.changed)).toBe(true)
    expect(isOle(path)).toBe(true)
    const text = textOf(path).join('\n')
    expect(text).toContain('8월 1일부터 시행합니다.')
    expect(text).toContain('문의는 아래로.')
    expect(text).toContain('032-722-4315')
    expect(detail.backup_path).toBe(`${path}.bak`)
    expect(readFileSync(`${path}.bak`).equals(Buffer.from(original))).toBe(true)
  })

  it('edits a .hwpx and writes it back as .hwpx', async () => {
    const dir = tempDir()
    const path = write(dir, 'report.hwpx', report().exportHwpx())
    const r = await run(['hwp', 'apply', path, '--ops', ops(dir, EDITS), '--json'])
    expect(r.code, r.stdout).toBe(0)
    expect(r.json().detail.format).toBe('hwpx')
    expect(isZip(path)).toBe(true)
    expect(textOf(path).join('\n')).toContain('8월 1일부터')
  })

  it('writes to --out in the format its extension names and leaves the input alone', async () => {
    const dir = tempDir()
    const original = report().exportHwp()
    const path = write(dir, 'report.hwp', original)
    const out = join(dir, 'copy.hwpx')
    const r = await run(['hwp', 'apply', path, '--ops', ops(dir, EDITS), '--out', out, '--json'])
    expect(r.code, r.stdout).toBe(0)
    expect(isZip(out)).toBe(true)
    expect(readFileSync(path).equals(Buffer.from(original))).toBe(true)
    expect(existsSync(`${path}.bak`)).toBe(false)
    expect(r.json().detail.backup_path).toBeUndefined()
  })

  it('refuses an ambiguous edit and leaves the file untouched (atomic)', async () => {
    const dir = tempDir()
    const original = report().exportHwp()
    const path = write(dir, 'report.hwp', original)
    const r = await run([
      'hwp',
      'apply',
      path,
      '--ops',
      ops(dir, [
        { op: 'replace_text', find: '7월 1일', replace: '8월 1일' },
        // "시행" occurs twice: the in-app AI is told the places instead of a guess
        { op: 'replace_text', find: '시행', replace: '실시' },
      ]),
      '--json',
    ])
    expect(r.code).toBe(1)
    const failure = r.json().detail.failures[0]
    expect(failure).toMatchObject({ index: 1, op: 'replace_text', reason: 'op_rejected' })
    expect(readFileSync(path).equals(Buffer.from(original))).toBe(true)
  })

  it('writes what applied with --best-effort and reports the rest', async () => {
    const dir = tempDir()
    const path = write(dir, 'report.hwp', report().exportHwp())
    const r = await run([
      'hwp',
      'apply',
      path,
      '--ops',
      ops(dir, [
        { op: 'replace_text', find: '없는 말', replace: 'x' },
        { op: 'replace_text', find: '끝.', replace: '이상.' },
      ]),
      '--best-effort',
      '--json',
    ])
    expect(r.code, r.stdout).toBe(0)
    const result = r.json()
    expect(result.status).toBe('partial')
    expect(result.detail.batch).toMatchObject({ applied: 1, failed: 1 })
    expect(textOf(path)).toContain('이상.')
  })

  it('names unknown ops and the ones that need the app', async () => {
    const dir = tempDir()
    const path = write(dir, 'report.hwp', report().exportHwp())
    const unknown = await run([
      'hwp',
      'apply',
      path,
      '--ops',
      ops(dir, [{ op: 'replace_txt', find: 'a', replace: 'b' }]),
      '--json',
    ])
    expect(unknown.code).toBe(1)
    expect(unknown.json().detail.failures[0]).toMatchObject({
      reason: 'unknown_op',
      did_you_mean: 'replace_text',
    })
    const web = await run([
      'hwp',
      'apply',
      path,
      '--ops',
      ops(dir, [{ op: 'image_search', query: 'x' }]),
      '--json',
    ])
    expect(web.json().detail.failures[0]).toMatchObject({ reason: 'unsupported' })
  })

  it('runs a batch in memory with --dry-run', async () => {
    const dir = tempDir()
    const original = report().exportHwp()
    const path = write(dir, 'report.hwp', original)
    const r = await run(['hwp', 'apply', path, '--ops', ops(dir, EDITS), '--dry-run', '--json'])
    expect(r.code, r.stdout).toBe(0)
    expect(r.json().summary).toContain('dry run')
    expect(readFileSync(path).equals(Buffer.from(original))).toBe(true)
  })

  it('answers the read ops in the results and leaves the file as it was', async () => {
    const dir = tempDir()
    const original = report().exportHwp()
    const path = write(dir, 'report.hwp', original)
    const r = await run([
      'hwp',
      'apply',
      path,
      '--ops',
      ops(dir, [{ op: 'list_tables' }, { op: 'read_table', table: 1 }]),
      '--json',
    ])
    expect(r.code, r.stdout).toBe(0)
    const [tables, table] = r.json().detail.results
    expect(tables.changed).toBe(false)
    expect(table.output).toContain('특송')
    expect(r.json().output_path).toBeUndefined()
    expect(readFileSync(path).equals(Buffer.from(original))).toBe(true)
    expect(existsSync(`${path}.bak`)).toBe(false)
  })
})

describe('ieumoffice create --type hwp', () => {
  it('builds a new .hwp from ops on a blank document', async () => {
    const dir = tempDir()
    const out = join(dir, 'new.hwp')
    const r = await run([
      'create',
      '--type',
      'hwp',
      '--ops',
      ops(dir, [
        { op: 'insert_paragraphs', where: 'end', paragraphs: ['회의 결과 보고', '참석자: 5명'] },
        {
          op: 'insert_table',
          where: 'end',
          rows: [
            ['안건', '결과'],
            ['예산', '승인'],
          ],
          header: true,
        },
      ]),
      '--out',
      out,
      '--json',
    ])
    expect(r.code, r.stdout).toBe(0)
    expect(isOle(out)).toBe(true)
    const text = textOf(out).join('\n')
    expect(text).toContain('회의 결과 보고')
    expect(text).toContain('예산')
  })

  it('builds a .hwpx and refuses an existing output without --force', async () => {
    const dir = tempDir()
    const out = join(dir, 'new.hwpx')
    const list = ops(dir, [{ op: 'insert_paragraphs', where: 'end', paragraphs: ['안녕하세요'] }])
    const first = await run(['create', '--type', 'hwpx', '--ops', list, '--out', out, '--json'])
    expect(first.code, first.stdout).toBe(0)
    expect(isZip(out)).toBe(true)
    expect(textOf(out)).toContain('안녕하세요')
    const again = await run(['create', '--type', 'hwpx', '--ops', list, '--out', out, '--json'])
    expect(again.code).toBe(2)
    expect(again.json().error).toBe('output_exists')
  })
})
