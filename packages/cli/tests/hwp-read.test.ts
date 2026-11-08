import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import init, { HwpDocument } from '@rhwp/core'
import { run, tempDir } from './helpers'

const env = { ...process.env, GENOFFICE_AUDIT_LOG: 'off' }

/** The documents are built with the engine the reader uses; there is no other writer here. */
beforeAll(async () => {
  const wasm = createRequire(import.meta.url).resolve('@rhwp/core/rhwp_bg.wasm')
  await init({ module_or_path: readFileSync(wasm) })
})

/** 제목 / 본문 / a 2×2 table / 끝 */
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
    '<table><tr><td>구분</td><td>연락처</td></tr><tr><td>특송</td><td>032-722-4315</td></tr></table>',
  )
  return doc
}

function write(name: string, bytes: Uint8Array): string {
  const path = join(tempDir(), name)
  writeFileSync(path, bytes)
  return path
}

describe('ieumoffice hwp read', () => {
  it('returns the text of a .hwp document, tables as rows', async () => {
    const r = await run(['hwp', 'read', write('report.hwp', report().exportHwp()), '--json'])
    expect(r.code).toBe(0)
    const { detail, summary } = r.json()
    expect(detail.format).toBe('hwp')
    expect(detail.text.split('\n')).toEqual([
      '등록제 시행 안내',
      '7월 1일부터 시행합니다.',
      '구분 | 연락처',
      '특송 | 032-722-4315',
      '끝.',
    ])
    expect(detail.chars).toBe(detail.text.length)
    expect(detail.truncated).toBeUndefined()
    expect(summary).toContain(`${detail.chars} characters`)
  })

  it('reads a .hwpx document the same way', async () => {
    const r = await run(['hwp', 'read', write('report.hwpx', report().exportHwpx()), '--json'])
    expect(r.code).toBe(0)
    expect(r.json().detail).toMatchObject({ format: 'hwpx' })
    expect(r.json().detail.text).toContain('특송 | 032-722-4315')
  })

  it('clips a long read and names where to go on', async () => {
    const path = write('report.hwp', report().exportHwp())
    const first = (await run(['hwp', 'read', path, '--max-chars', '10', '--json'])).json()
    expect(first.detail.text).toBe('등록제 시행 안내\n')
    expect(first.detail.next_offset).toBe(10)
    expect(first.detail.truncated).toContain('--offset 10')
    const rest = (await run(['hwp', 'read', path, '--offset', '10', '--full', '--json'])).json()
    expect(rest.detail.text.startsWith('7월 1일부터')).toBe(true)
    expect(rest.detail.truncated).toBeUndefined()
    expect(first.detail.text + rest.detail.text).toHaveLength(first.detail.chars)
  })

  it('does not split an emoji between two parts of a paged read', async () => {
    const doc = HwpDocument.createEmpty()
    doc.createBlankDocument()
    doc.insertText(0, 0, 0, '가나😀다라마')
    const path = write('emoji.hwp', doc.exportHwp())
    const first = (await run(['hwp', 'read', path, '--max-chars', '3', '--json'])).json().detail
    expect(first.text.isWellFormed()).toBe(true)
    const rest = (
      await run(['hwp', 'read', path, '--offset', String(first.next_offset), '--full', '--json'])
    ).json().detail
    expect(rest.text.isWellFormed()).toBe(true)
    expect(first.text + rest.text).toBe('가나😀다라마')
  })

  it.each([
    { ext: 'hwp', character: '😀' },
    { ext: 'hwpx', character: '😀' },
    { ext: 'hwp', character: '𠀀' },
    { ext: 'hwpx', character: '𠀀' },
  ])('rejects a starting offset inside $character in $ext', async ({ ext, character }) => {
    const doc = HwpDocument.createEmpty()
    doc.createBlankDocument()
    doc.insertText(0, 0, 0, `가${character}나`)
    const path = write(`unicode.${ext}`, ext === 'hwp' ? doc.exportHwp() : doc.exportHwpx())
    const before = readFileSync(path)
    const r = await run(['hwp', 'read', path, '--offset', '2', '--full', '--json'], { env })
    expect(r.code).toBe(1)
    expect(r.json().error).toBe('invalid_argument')
    expect(r.json().suggestion).toContain('--offset 1')
    expect(r.json().suggestion).toContain('--offset 3')
    expect(readFileSync(path)).toEqual(before)
  })

  it.each(['hwp', 'hwpx'])('keeps aligned offsets and paged reads in %s', async (ext) => {
    const doc = HwpDocument.createEmpty()
    doc.createBlankDocument()
    const text = '가😀나'
    doc.insertText(0, 0, 0, text)
    const path = write(`unicode.${ext}`, ext === 'hwp' ? doc.exportHwp() : doc.exportHwpx())
    const before = readFileSync(path)
    for (const offset of [0, 1, 3, 4]) {
      const r = await run(['hwp', 'read', path, '--offset', String(offset), '--full', '--json'], {
        env,
      })
      expect(r.code).toBe(0)
      expect(r.json().detail.offset).toBe(offset)
      expect(r.json().detail.text).toBe(text.slice(offset))
      expect(r.json().detail.text.isWellFormed()).toBe(true)
    }
    const first = (await run(['hwp', 'read', path, '--max-chars', '2', '--json'], { env })).json()
      .detail
    const rest = (
      await run(['hwp', 'read', path, '--offset', String(first.next_offset), '--full', '--json'], {
        env,
      })
    ).json().detail
    expect(first.text.isWellFormed()).toBe(true)
    expect(rest.text.isWellFormed()).toBe(true)
    expect(first.text + rest.text).toBe(text)
    expect(readFileSync(path)).toEqual(before)
  })

  it('refuses an offset past the end and a file of another kind', async () => {
    const path = write('report.hwp', report().exportHwp())
    const past = await run(['hwp', 'read', path, '--offset', '99999', '--json'])
    expect(past.code).not.toBe(0)
    const other = write('notes.txt', new TextEncoder().encode('hello'))
    const wrong = await run(['hwp', 'read', other, '--json'])
    expect(wrong.code).not.toBe(0)
    expect(wrong.stdout + wrong.stderr).toContain('not an HWP or HWPX document')
  })

  it('reports a password-protected document instead of crashing', async () => {
    const locked = write('locked.hwp', report().exportHwpWithPassword('1234'))
    const r = await run(['hwp', 'read', locked, '--json'])
    expect(r.code).not.toBe(0)
    expect(r.stdout + r.stderr).toContain('password-protected')
  })
})

describe('ieumoffice info on an HWP document', () => {
  it('says how much text there is and which command reads it', async () => {
    const r = await run(['info', write('report.hwpx', report().exportHwpx()), '--json'])
    expect(r.code).toBe(0)
    expect(r.json().detail).toMatchObject({ format: 'hwpx', lines: 5, read_with: 'hwp read' })
  })
})
