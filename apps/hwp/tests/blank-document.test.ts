/**
 * The document a new HWP tab starts from (src/renderer/assets/blank.hwp, written by
 * scripts/make-blank.mjs): an A4 page holding one empty paragraph, which the engine opens
 * and writes like any other HWP.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import init, { HwpDocument } from '@rhwp/core'

const require = createRequire(import.meta.url)
const BLANK = join(__dirname, '..', 'src', 'renderer', 'assets', 'blank.hwp')

beforeAll(async () => {
  const wasm = join(dirname(require.resolve('@rhwp/core')), 'rhwp_bg.wasm')
  await init({ module_or_path: readFileSync(wasm) })
})

describe('the blank document', () => {
  it('is an HWP 5 file of one empty paragraph on one A4 page', () => {
    const bytes = readFileSync(BLANK)
    // the compound-file signature every HWP 5 document starts with
    expect([...bytes.subarray(0, 8)]).toEqual([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
    const doc = new HwpDocument(bytes)
    expect(doc.getSectionCount()).toBe(1)
    expect(doc.getParagraphCount(0)).toBe(1)
    expect(doc.getParagraphLength(0, 0)).toBe(0)
    expect(doc.pageCount()).toBe(1)
    const page = JSON.parse(doc.getPageDef(0)) as { width: number; height: number }
    // A4 in HWPUNIT (1/7200 inch), as Hangul writes it: 210 × 297 mm
    expect(page.width).toBe(59528)
    expect(page.height).toBe(84186)
  })

  it('is what the engine makes for a blank document now', () => {
    const fresh = HwpDocument.createEmpty()
    fresh.createBlankDocument()
    const made = new HwpDocument(fresh.exportHwp())
    const bundled = new HwpDocument(readFileSync(BLANK))
    // run scripts/make-blank.mjs when an engine update changes the blank document
    expect(bundled.getPageDef(0)).toBe(made.getPageDef(0))
    expect(bundled.getStyleList()).toBe(made.getStyleList())
    expect(bundled.getCharPropertiesAt(0, 0, 0)).toBe(made.getCharPropertiesAt(0, 0, 0))
    expect(bundled.getParaPropertiesAt(0, 0)).toBe(made.getParaPropertiesAt(0, 0))
  })

  it('takes text and writes it, in both formats', () => {
    const doc = new HwpDocument(readFileSync(BLANK))
    doc.insertText(0, 0, 0, '새 문서의 첫 문단')
    for (const written of [doc.exportHwp(), doc.exportHwpx()]) {
      const back = new HwpDocument(written)
      expect(back.getTextRange(0, 0, 0, back.getParagraphLength(0, 0))).toBe('새 문서의 첫 문단')
    }
  })
})
