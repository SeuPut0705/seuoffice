import { describe, expect, it } from 'vitest'
import { readPdfText } from '../src/main/read-text'

/** One-page Helvetica PDF around a raw content stream. */
function rawPdf(content: string): Uint8Array {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [4 0 R] /Count 1 >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 5 0 R /Resources << /Font << /F1 3 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ]
  let body = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((obj, i) => {
    offsets.push(body.length)
    body += `${i + 1} 0 obj\n${obj}\nendobj\n`
  })
  const xref = body.length
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const off of offsets) body += `${String(off).padStart(10, '0')} 00000 n \n`
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new Uint8Array(Buffer.from(body, 'latin1'))
}

describe('readPdfText line breaks', () => {
  it('keeps glyphs placed slightly left of the previous one on the same line', async () => {
    // each 24pt glyph starts 12pt after the previous one, inside it; pdfium read
    // every step back as a new line ("Wo\nr\nd")
    const glyphs = (word: string, x: number, y: number) =>
      [...word].map((c, i) => `BT /F1 24 Tf ${x + i * 12} ${y} Td (${c}) Tj ET`).join(' ')
    const content = [
      glyphs('Word', 72, 700),
      glyphs('Next', 72, 650),
      `${glyphs('Menu', 72, 600)} ${glyphs('Price', 300, 600)}`,
    ].join(' ')
    const text = (await readPdfText(rawPdf(content))).pages[0]!.text
    // pdfium may still put its own space after a narrow glyph; what matters is the lines
    const lines = text.split('\n')
    expect(lines.map((l) => l.replace(/ /g, ''))).toEqual(['Word', 'Next', 'MenuPrice'])
    expect(lines[2]).toMatch(/u P/)
  })

  it('leaves ordinary lines alone', async () => {
    const content = ['First line', 'Second line']
      .map((t, i) => `BT /F1 24 Tf 72 ${700 - i * 50} Td (${t}) Tj ET`)
      .join(' ')
    expect((await readPdfText(rawPdf(content))).pages[0]!.text).toBe('First line\nSecond line')
  })
})
