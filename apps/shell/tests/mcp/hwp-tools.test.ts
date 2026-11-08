/**
 * read_hwp: the MCP tool around the shared HWP reader (@genoffice/file-parse).
 * The documents are built with the engine the reader uses.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import init, { HwpDocument } from '@rhwp/core'
import { HWP_MAX_CHARS, createHwpTools, hwpTextWindow } from '../../src/main/mcp/tools/hwp-tools'

beforeAll(async () => {
  const wasm = createRequire(import.meta.url).resolve('@rhwp/core/rhwp_bg.wasm')
  await init({ module_or_path: readFileSync(wasm) })
})

const dir = mkdtempSync(join(tmpdir(), 'hwp-tools-'))

function report(): HwpDocument {
  const doc = HwpDocument.createEmpty()
  doc.createBlankDocument()
  const lines = ['등록제 시행 안내', '', '끝.']
  lines.forEach((line, index) => {
    if (index > 0) doc.splitParagraph(0, index - 1, doc.getParagraphLength(0, index - 1))
    if (line) doc.insertText(0, index, 0, line)
  })
  doc.pasteHtml(
    0,
    1,
    0,
    '<table><tr><td>구분</td><td>연락처</td></tr><tr><td>특송</td><td>032-722-4315</td></tr></table>',
  )
  return doc
}

function write(name: string, bytes: Uint8Array): string {
  const path = join(dir, name)
  writeFileSync(path, bytes)
  return path
}

const readHwp = createHwpTools().find((tool) => tool.name === 'read_hwp')!

describe('read_hwp tool', () => {
  it('reads a .hwp and a .hwpx file from disk', async () => {
    for (const [name, bytes] of [
      ['report.hwp', report().exportHwp()],
      ['report.hwpx', report().exportHwpx()],
    ] as const) {
      const path = write(name, bytes)
      const result = (await readHwp.handler({ path })) as Record<string, unknown>
      expect(result).toMatchObject({ path, name, offset: 0, truncated: false })
      expect(result.text).toBe('등록제 시행 안내\n구분 | 연락처\n특송 | 032-722-4315\n끝.')
      expect(result.totalChars).toBe((result.text as string).length)
      expect(result.nextOffset).toBeUndefined()
    }
  })

  it('refuses a relative path, another extension and a missing file', async () => {
    await expect(readHwp.handler({ path: 'report.hwp' })).rejects.toThrow(/absolute/)
    await expect(readHwp.handler({ path: join(dir, 'notes.docx') })).rejects.toThrow(/\.hwp/)
    await expect(readHwp.handler({ path: join(dir, 'none.hwp') })).rejects.toThrow(/not found/)
  })

  it('reports a password-protected document as a tool error', async () => {
    const path = write('locked.hwp', report().exportHwpWithPassword('1234'))
    await expect(readHwp.handler({ path })).rejects.toThrow(/password-protected/)
  })
})

describe('the window a long document is returned in', () => {
  const long = '가'.repeat(HWP_MAX_CHARS + 500)

  it('returns the first part and where to go on', () => {
    const first = hwpTextWindow(long, 0)
    expect(first.text).toHaveLength(HWP_MAX_CHARS)
    expect(first).toMatchObject({
      totalChars: long.length,
      offset: 0,
      truncated: true,
      nextOffset: HWP_MAX_CHARS,
    })
  })

  it('returns the rest from that offset', () => {
    const rest = hwpTextWindow(long, HWP_MAX_CHARS)
    expect(rest.text).toHaveLength(500)
    expect(rest.truncated).toBe(false)
    expect(rest.nextOffset).toBeUndefined()
  })

  it('answers an offset past the end with nothing, not an error', () => {
    expect(hwpTextWindow('짧은 글', 100)).toMatchObject({ text: '', offset: 4, truncated: false })
  })
})
