import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { afterEach, describe, expect, it } from 'vitest'
import { LANGS, PRODUCT_NAME, UPSTREAM_PRODUCT_NAME } from '@genoffice/i18n'
import { isQuickLookSupportedPath, quickLookFamilyOf } from '../src/shared/quick-look-api'
import {
  DEFAULT_QUICK_LOOK_SETTINGS,
  normalizeQuickLookSettings,
} from '../src/shared/quick-look-home'
import {
  clearQuickLookCache,
  extractEmbeddedThumbnail,
  extractQuickLook,
  parseDocBlocksFromText,
  parseMindmapFromText,
  parseSheetsFromText,
  parseSlidesFromText,
} from '../src/main/quick-look/extract'
import {
  quickLookStrings,
  quickLookText,
  type QuickLookStringKey,
} from '../src/renderer/src/i18n/strings-quick-look'

describe('Quick Look settings and file classification', () => {
  it('normalizes missing or partial settings to safe defaults', () => {
    expect(normalizeQuickLookSettings(undefined)).toEqual(DEFAULT_QUICK_LOOK_SETTINGS)
    expect(normalizeQuickLookSettings(null)).toEqual(DEFAULT_QUICK_LOOK_SETTINGS)
    expect(normalizeQuickLookSettings({ explorerSpacePreview: false })).toEqual({
      explorerSpacePreview: false,
      keepInTray: false,
    })
    expect(normalizeQuickLookSettings({ explorerSpacePreview: true, keepInTray: true })).toEqual({
      explorerSpacePreview: true,
      keepInTray: true,
    })
  })

  it('classifies office, mindmap, hwp, pdf, text, and image extensions', () => {
    expect(quickLookFamilyOf('docx')).toBe('docx')
    expect(quickLookFamilyOf('.odt')).toBe('docx')
    expect(quickLookFamilyOf('xlsx')).toBe('xlsx')
    expect(quickLookFamilyOf('csv')).toBe('xlsx')
    expect(quickLookFamilyOf('pptx')).toBe('pptx')
    expect(quickLookFamilyOf('pdf')).toBe('pdf')
    expect(quickLookFamilyOf('xmind')).toBe('xmind')
    expect(quickLookFamilyOf('hwp')).toBe('hwp')
    expect(quickLookFamilyOf('hwpx')).toBe('hwp')
    expect(quickLookFamilyOf('md')).toBe('md')
    expect(quickLookFamilyOf('html')).toBe('html')
    expect(quickLookFamilyOf('py')).toBe('text')
    expect(quickLookFamilyOf('png')).toBe('image')
    expect(quickLookFamilyOf('exe')).toBe('unsupported')

    expect(isQuickLookSupportedPath('C:\\docs\\report.docx')).toBe(true)
    expect(isQuickLookSupportedPath('/Users/test/notes.xmind')).toBe(true)
    expect(isQuickLookSupportedPath('C:\\Windows\\System32\\cmd.exe')).toBe(false)
  })
})

describe('Quick Look structured parsers', () => {
  it('parses multi-sheet text output into tabular sheets', () => {
    const raw = [
      '# Revenue',
      'Quarter | Q1 | Q2',
      'Sales | 120 | 150',
      '# Costs',
      'Item | Amount',
      'Hosting | 30',
    ].join('\n')

    const { sheets, truncated } = parseSheetsFromText(raw, 'xlsx', 'Sheet1')
    expect(truncated).toBe(false)
    expect(sheets).toHaveLength(2)
    expect(sheets[0]).toEqual({
      name: 'Revenue',
      rows: [
        ['Quarter', 'Q1', 'Q2'],
        ['Sales', '120', '150'],
      ],
      truncatedRows: false,
      truncatedCols: false,
    })
    expect(sheets[1]).toEqual({
      name: 'Costs',
      rows: [
        ['Item', 'Amount'],
        ['Hosting', '30'],
      ],
      truncatedRows: false,
      truncatedCols: false,
    })
  })

  it('parses slide markers into slide cards', () => {
    const raw = [
      '## Slide 1',
      'Quarterly Review',
      'Revenue grew 25%',
      'New product launched',
      '### Notes',
      'Mention regional breakdown',
      '## Slide 2',
      'Next Steps',
      'Expand APAC team',
    ].join('\n')

    const { slides, truncated } = parseSlidesFromText(raw)
    expect(truncated).toBe(false)
    expect(slides).toEqual([
      {
        number: 1,
        title: 'Quarterly Review',
        bullets: ['Revenue grew 25%', 'New product launched'],
        notes: ['Mention regional breakdown'],
      },
      {
        number: 2,
        title: 'Next Steps',
        bullets: ['Expand APAC team'],
        notes: [],
      },
    ])
  })

  it('skips ### Comments blocks instead of folding them into notes or bullets', () => {
    const raw = [
      '## Slide 1',
      'Quarterly Review',
      '### Notes',
      'Mention regional breakdown',
      '### Comments',
      '- Alice (2026-01-01T00:00:00.000Z): Tighten the intro',
      '## Slide 2',
      'Next Steps',
    ].join('\n')

    const { slides } = parseSlidesFromText(raw)
    expect(slides[0]).toEqual({
      number: 1,
      title: 'Quarterly Review',
      bullets: [],
      notes: ['Mention regional breakdown'],
    })
    expect(slides[1]).toEqual({ number: 2, title: 'Next Steps', bullets: [], notes: [] })
  })

  it('parses mindmap outline into sheets and depth-indented nodes', () => {
    const raw = ['# Product Roadmap', '- Q1', '  - Quick Look', '  - Explorer Hook', '- Q2'].join(
      '\n',
    )
    const { mindmap, truncated } = parseMindmapFromText(raw)
    expect(truncated).toBe(false)
    expect(mindmap).toHaveLength(1)
    expect(mindmap[0]?.title).toBe('Product Roadmap')
    expect(mindmap[0]?.nodes).toEqual([
      { depth: 0, text: 'Q1' },
      { depth: 1, text: 'Quick Look' },
      { depth: 1, text: 'Explorer Hook' },
      { depth: 0, text: 'Q2' },
    ])
  })

  it('parses document blocks including headings, bullet items, tables, and fenced code', () => {
    const raw = [
      '# Title',
      'Intro paragraph.',
      '- First item',
      '- Second item',
      'Col A | Col B',
      'Val 1 | Val 2',
      '```ts',
      'const x = 1',
      '```',
    ].join('\n')

    const { docBlocks, truncated } = parseDocBlocksFromText(raw)
    expect(truncated).toBe(false)
    expect(docBlocks).toEqual([
      { kind: 'heading', level: 1, text: 'Title' },
      { kind: 'paragraph', text: 'Intro paragraph.' },
      { kind: 'bullet', text: 'First item' },
      { kind: 'bullet', text: 'Second item' },
      {
        kind: 'table',
        rows: [
          ['Col A', 'Col B'],
          ['Val 1', 'Val 2'],
        ],
      },
      { kind: 'code', text: 'const x = 1' },
    ])
  })
})

describe('Quick Look embedded thumbnail and file extractor', () => {
  let tmpDir = ''

  afterEach(() => {
    clearQuickLookCache()
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true })
      tmpDir = ''
    }
  })

  it('extracts embedded thumbnails from OOXML and XMind zip containers', async () => {
    const zip = new JSZip()
    const fakePng = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    zip.file('Thumbnails/thumbnail.png', fakePng)
    const bytes = await zip.generateAsync({ type: 'nodebuffer' })

    const dataUrl = await extractEmbeddedThumbnail('xmind', bytes)
    expect(dataUrl).toMatch(/^data:image\/png;base64,/)
  })

  it('extracts Quick Look payload for markdown, csv, and image files and caches by mtime', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ql-test-'))

    const mdPath = join(tmpDir, 'notes.md')
    writeFileSync(mdPath, '# Hello Quick Look\n\n- Fast preview\n- Spacebar trigger\n', 'utf8')
    const mdRes = await extractQuickLook(mdPath)
    expect(mdRes.ok).toBe(true)
    expect(mdRes.family).toBe('md')
    expect(mdRes.docBlocks?.[0]).toEqual({ kind: 'heading', level: 1, text: 'Hello Quick Look' })

    // Second call hits cache
    const mdCached = await extractQuickLook(mdPath)
    expect(mdCached).toBe(mdRes)

    const csvPath = join(tmpDir, 'table.csv')
    writeFileSync(csvPath, 'Name,Score\nAlice,95\nBob,88\n', 'utf8')
    const csvRes = await extractQuickLook(csvPath)
    expect(csvRes.ok).toBe(true)
    expect(csvRes.family).toBe('xlsx')
    expect(csvRes.sheets?.[0]?.rows).toEqual([
      ['Name', 'Score'],
      ['Alice', '95'],
      ['Bob', '88'],
    ])

    const imgPath = join(tmpDir, 'pixel.png')
    writeFileSync(imgPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    const imgRes = await extractQuickLook(imgPath)
    expect(imgRes.ok).toBe(true)
    expect(imgRes.family).toBe('image')
    expect(imgRes.thumbnailDataUrl).toMatch(/^data:image\/png;base64,/)
  })
})

describe('Quick Look 21-language dictionary', () => {
  const keys = Object.keys(quickLookStrings.zh) as QuickLookStringKey[]

  it('populates every key across all 21 supported languages and brands product names', () => {
    for (const lang of LANGS) {
      for (const key of keys) {
        const text = quickLookText(lang, key, { n: 3 })
        expect(text.trim().length, `${lang}.${key}`).toBeGreaterThan(0)
        expect(text, `${lang}.${key}`).not.toContain(UPSTREAM_PRODUCT_NAME)
      }
    }
    expect(quickLookText('ko', 'openInEditor')).toContain('이음오피스')
    expect(quickLookText('en', 'openInEditor')).toContain(PRODUCT_NAME)
  })
})
