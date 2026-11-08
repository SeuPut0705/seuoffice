import { describe, expect, it } from 'vitest'
import { pageAtScroll, readPageSetup, sheetPeriod } from '../src/renderer/document/page-setup'

const MM = 96 / 25.4
const doc = (css: string) =>
  `<!doctype html><html><head><style>${css}</style></head><body></body></html>`

describe('pageAtScroll', () => {
  const setup = readPageSetup(doc('@page{size:A4;margin:15mm}'))
  const period = sheetPeriod(setup, 24)

  it('spaces the sheets by their full height plus the desk between them', () => {
    expect(period).toBeCloseTo(297 * MM + 24, 1)
  })

  it('names the page under a line a third of the way down the view', () => {
    expect(pageAtScroll(0, 900, period, 12)).toBe(0)
    // the next sheet takes over once its top has come up past that line
    expect(pageAtScroll(period - 400, 900, period, 12)).toBe(0)
    expect(pageAtScroll(period - 200, 900, period, 12)).toBe(1)
    expect(pageAtScroll(5 * period, 900, period, 12)).toBe(5)
  })

  it('stays inside the document', () => {
    expect(pageAtScroll(-50, 900, period, 12)).toBe(0)
    expect(pageAtScroll(40 * period, 900, period, 12)).toBe(11)
    expect(pageAtScroll(0, 900, period, 0)).toBe(0)
  })
})

describe('readPageSetup', () => {
  it('uses the PDF export defaults when the document declares no paper', () => {
    const setup = readPageSetup(doc('body{margin:0}'))
    expect(setup.marginTop).toBeCloseTo(57.6, 2)
    expect(setup.marginLeft).toBeCloseTo(57.6, 2)
    expect(setup.width).toBe(Math.round(210 * MM - 2 * 57.6))
    expect(setup.height).toBeCloseTo(297 * MM - 2 * 57.6, 1)
  })

  it('reads size and margin, ignoring the margin boxes nested in the rule', () => {
    const setup = readPageSetup(
      doc(
        "@page{size:A4 portrait;margin:15mm;@bottom-center{content:'p ' counter(page);margin:99mm;font-size:8pt}}",
      ),
    )
    expect(setup.width).toBe(680)
    expect(setup.height).toBeCloseTo(267 * MM, 1)
    expect(setup.marginTop).toBeCloseTo(15 * MM, 1)
    expect(setup.marginRight).toBeCloseTo(15 * MM, 1)
  })

  it('turns a named size with the orientation keyword', () => {
    const setup = readPageSetup(doc('@page { size: A4 landscape; margin: 10mm }'))
    expect(setup.width).toBe(Math.round(277 * MM))
    expect(setup.height).toBeCloseTo(190 * MM, 1)
    expect(readPageSetup(doc('@page{size:landscape;margin:10mm}')).width).toBe(setup.width)
  })

  it('takes explicit lengths and per-side margins', () => {
    const setup = readPageSetup(
      doc('@page{size:100mm 150mm;margin:10mm 5mm}\n@page{margin-bottom:1in !important}'),
    )
    expect(setup.width).toBe(Math.round(90 * MM))
    expect(setup.marginTop).toBeCloseTo(10 * MM, 1)
    expect(setup.marginLeft).toBeCloseTo(5 * MM, 1)
    expect(setup.marginBottom).toBe(96)
    expect(setup.height).toBeCloseTo(150 * MM - 10 * MM - 96, 1)
  })

  it('leaves named and pseudo pages, comments and unparsable values out of it', () => {
    const base = readPageSetup(doc(''))
    expect(
      readPageSetup(
        doc(
          '@page :first{margin:0}@page cover{size:A3}/* @page{size:A5} */@page{size:banana;margin:calc(1mm + 2mm)}',
        ),
      ),
    ).toEqual(base)
  })

  it('keeps a printable page when the margins swallow the sheet', () => {
    const setup = readPageSetup(doc('@page{size:A5;margin:200mm}'))
    expect(setup.width).toBeGreaterThan(48)
    expect(setup.height).toBeGreaterThan(48)
  })
})
