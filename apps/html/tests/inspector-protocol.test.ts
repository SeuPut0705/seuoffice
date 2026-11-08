import { describe, expect, it } from 'vitest'
import {
  isFromInspector,
  readExtraSids,
  readPaperReport,
} from '../src/renderer/preview/inspector-protocol'

describe('isFromInspector', () => {
  it('accepts well-formed inspector messages', () => {
    expect(isFromInspector({ type: 'gx:ready', version: 3, title: 't', docHeight: 10 })).toBe(true)
    expect(isFromInspector({ type: 'gx:zoom', version: 1, delta: 5 })).toBe(true)
  })

  it('rejects forged or malformed shapes', () => {
    expect(isFromInspector(null)).toBe(false)
    expect(isFromInspector('gx:ready')).toBe(false)
    // Unknown tag, even with the gx: prefix.
    expect(isFromInspector({ type: 'gx:evil', version: 1 })).toBe(false)
    // Version is required and numeric (the App matches it against live parse maps).
    expect(isFromInspector({ type: 'gx:ready', title: 't' })).toBe(false)
    expect(isFromInspector({ type: 'gx:ready', version: '3' })).toBe(false)
    expect(isFromInspector({ type: 'gx:ready', version: Number.NaN })).toBe(false)
  })
})

describe('readExtraSids', () => {
  it('keeps the sids in click order, once each', () => {
    expect(readExtraSids([7, 3, 7, 12])).toEqual([7, 3, 12])
    expect(readExtraSids([])).toEqual([])
  })

  it('drops what is not a sid and caps a list nobody clicked together', () => {
    expect(readExtraSids('7')).toEqual([])
    expect(readExtraSids([null, '4', 2.5, -1, 9])).toEqual([9])
    expect(readExtraSids(Array.from({ length: 5000 }, (_, i) => i))).toHaveLength(200)
  })
})

describe('readPaperReport', () => {
  it('passes a sheet count with a plain colour', () => {
    expect(readPaperReport({ pages: 12, sheet: 'rgb(255, 255, 255)' })).toEqual({
      pages: 12,
      sheet: 'rgb(255, 255, 255)',
    })
    expect(readPaperReport({ pages: 1, sheet: '#1f2a44' })).not.toBeNull()
    expect(readPaperReport({ pages: 3, sheet: 'rgba(0, 0, 0, 0.5)' })).not.toBeNull()
  })

  it('rejects counts and colours a forged message could carry', () => {
    expect(readPaperReport({ pages: 0, sheet: '#fff' })).toBeNull()
    expect(readPaperReport({ pages: 1.5, sheet: '#fff' })).toBeNull()
    expect(readPaperReport({ pages: '3', sheet: '#fff' })).toBeNull()
    expect(readPaperReport({ pages: 2, sheet: 'url(https://example.com/x)' })).toBeNull()
    expect(readPaperReport({ pages: 2, sheet: 'red; background: url(x)' })).toBeNull()
    expect(readPaperReport({ pages: 2, sheet: 42 })).toBeNull()
  })
})
