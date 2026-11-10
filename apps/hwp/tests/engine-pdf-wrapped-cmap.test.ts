/**
 * A PDF whose font table wraps an array over several lines imports, with the right letters
 * (rhwp patch 0044).
 *
 * A PDF font carries a table (ToUnicode CMap) from its character codes to Unicode. One entry
 * of the table can be an array, `<first> <last> [<a> <b> <c> ...]`, and Acrobat Distiller wraps a long
 * array over many lines. The importer read the table line by line, so a continuation line
 * `<2135> <D835DC9C> <212C>` was the range 0x2135 to 0xD835DC9C: 3.6 billion codes, past the
 * limit of 100,000. "PDF to HWP" then stopped with `PDF_RESOURCE_LIMIT: CMap entries` on a
 * five-page paper whose ten tables held 792 entries (2026-11-10). Lines that stayed
 * under the limit mapped the wrong codes without a word.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import init, { HwpDocument } from '@rhwp/core'

const require = createRequire(import.meta.url)

beforeAll(async () => {
  const wasm = join(dirname(require.resolve('@rhwp/core')), 'rhwp_bg.wasm')
  await init({ module_or_path: readFileSync(wasm) })
})

/**
 * A one-page PDF that shows `shown` in a font whose ToUnicode table has the one `bfrange`
 * entry given. Everything is ASCII, so a string's length is its byte length.
 */
function pdfWithRange(range: string, shown: string): Uint8Array {
  const stream = (body: string): string =>
    `<< /Length ${body.length} >>\nstream\n${body}\nendstream`
  const cmap = [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin',
    'begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    '/CMapName /Adobe-Identity-UCS def',
    '/CMapType 2 def',
    '1 begincodespacerange',
    '<00> <FF>',
    'endcodespacerange',
    '1 beginbfrange',
    range,
    'endbfrange',
    'endcmap',
    'CMapName currentdict /CMap defineresource pop',
    'end',
    'end',
  ].join('\n')
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    stream(`BT /F1 14 Tf 72 760 Td (${shown}) Tj ET`),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding /ToUnicode 6 0 R >>',
    stream(cmap),
  ]
  let file = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((body, index) => {
    offsets.push(file.length)
    file += `${index + 1} 0 obj\n${body}\nendobj\n`
  })
  const xref = file.length
  file += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) file += `${String(offset).padStart(10, '0')} 00000 n \n`
  file += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new Uint8Array(Buffer.from(file, 'latin1'))
}

/** The text drawn on the first page of the imported PDF (the import puts it in text boxes). */
function importedText(pdf: Uint8Array): string {
  const doc = HwpDocument.importPdf(pdf, {})
  try {
    expect(doc.pageCount()).toBe(1)
    const layout = JSON.parse(doc.getPageTextLayout(0)) as { runs: { text: string }[] }
    return layout.runs.map((run) => run.text).join('')
  } finally {
    doc.free()
  }
}

describe('PDF import: a ToUnicode array wrapped over lines', () => {
  it('reads the same letters from an array on one line and on two', () => {
    // codes A..F stand for R E A D Y !
    const oneLine = '<41> <46> [<0052> <0045> <0041> <0044> <0059> <0021>]'
    const wrapped = '<41> <46> [<0052> <0045> <0041>\n<0044> <0059> <0021>]'
    expect(importedText(pdfWithRange(oneLine, 'ABCDEF'))).toContain('READY!')
    // before the patch: `ABC!"#` (the second line mapped codes D..Y onto `!` onward)
    expect(importedText(pdfWithRange(wrapped, 'ABCDEF'))).toContain('READY!')
  })

  it('imports a table whose continuation line starts with a surrogate pair', () => {
    // codes A..H; D and E are U+2135 and U+1D49C, the strings a math symbol font carries
    const wrapped = '<41><48>[<0052><0045><0041>\n<2135><D835DC9C><0044>\n<0059><0021>]'
    // before the patch this threw `PDF_RESOURCE_LIMIT: CMap entries`
    expect(importedText(pdfWithRange(wrapped, 'ABCFGH'))).toContain('READY!')
  })

  it('still refuses a range that really is past the limit', () => {
    const huge = '<00000000>\n<FFFFFFFF> <0041>'
    expect(() => importedText(pdfWithRange(huge, 'ABC'))).toThrow(/PDF_RESOURCE_LIMIT/)
  })
})
