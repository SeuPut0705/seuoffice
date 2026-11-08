/** Translated and bilingual trees share the original tree's format (spec §1). */
import { describe, expect, it } from 'vitest'
import { deriveBilingualTree, deriveTranslatedTree, sha256Hex, textUnits } from '../src/tree'
import type { DocumentTree, InlineRun } from '../src/tree'
import { textOf } from './helpers/tree'

const t = (text: string): InlineRun[] => [{ kind: 'text', text }]
const at = { page: 1, pageFingerprint: 'fp1', source: 'pdf' as const }

function sample(): DocumentTree {
  return {
    version: 1,
    variant: 'original',
    info: {},
    sourcePageCount: 1,
    pages: [{ page: 1, fingerprint: 'fp1', status: 'text', widthPt: 612, heightPt: 792 }],
    blocks: [
      { ...at, id: 'p1.1', kind: 'pageBreak' },
      { ...at, id: 'p1.2', kind: 'heading', level: 1, levelSource: 'font', runs: t('Title') },
      {
        ...at,
        id: 'p1.3',
        kind: 'paragraph',
        runs: [...t('Body '), { kind: 'footnoteRef', id: 'n1', marker: '1' }],
      },
      {
        ...at,
        id: 'p1.4',
        kind: 'table',
        table: {
          rowCount: 1,
          colCount: 2,
          cells: [
            { row: 0, col: 0, rowSpan: 1, colSpan: 1, paragraphs: [t('Cell')] },
            { row: 0, col: 1, rowSpan: 1, colSpan: 1, paragraphs: [t('Keep')] },
          ],
        },
        caption: {
          ...at,
          id: 'p1.5',
          kind: 'caption',
          position: 'above',
          runs: t('Table 1 Sizes'),
        },
      },
      { ...at, id: 'p1.6', kind: 'paragraph', runs: t('Untranslated') },
    ],
    footnotes: [
      {
        id: 'n1',
        marker: '1',
        page: 1,
        pageFingerprint: 'fp1',
        blocks: [{ ...at, id: 'fnn1.1', kind: 'paragraph', runs: t('Note') }],
      },
    ],
    outline: [],
    toc: [],
    footnoteLinkFailedPages: [],
    warnings: [],
  }
}

const translations = new Map<string, InlineRun[]>([
  ['p1.2', t('Titel')],
  ['p1.3', [...t('Inhalt '), { kind: 'footnoteRef', id: 'n1', marker: '1' }]],
  ['p1.4#0.0.0', t('Zelle')],
  ['p1.5', t('Tabelle 1 Größen')],
  ['fnn1.1', t('Notiz')],
])

describe('text units', () => {
  it('lists every translatable unit with a stable key', () => {
    expect(textUnits(sample()).map((u) => u.key)).toEqual([
      'p1.2',
      'p1.3',
      'p1.5',
      'p1.4#0.0.0',
      'p1.4#0.1.0',
      'p1.6',
      'fnn1.1',
    ])
  })
})

describe('translated tree', () => {
  it('replaces translated text and keeps the rest', () => {
    const tree = deriveTranslatedTree(sample(), 'de', translations)
    expect(tree.variant).toBe('translated')
    expect(tree.targetLanguage).toBe('de')
    const [, h, p, table, untranslated] = tree.blocks
    expect(h).toMatchObject({ kind: 'heading', id: 'p1.2@de', translationOf: 'p1.2', lang: 'de' })
    expect(textOf((h as { runs: InlineRun[] }).runs)).toBe('Titel')
    expect(p!.kind === 'paragraph' && p.runs.some((r) => r.kind === 'footnoteRef')).toBe(true)
    if (table?.kind !== 'table') throw new Error('table expected')
    expect(textOf(table.table.cells[0]!.paragraphs[0]!)).toBe('Zelle')
    expect(textOf(table.table.cells[1]!.paragraphs[0]!)).toBe('Keep')
    expect(textOf(table.caption!.runs)).toBe('Tabelle 1 Größen')
    // a block without a translation stays the original block
    expect(untranslated).toMatchObject({ id: 'p1.6', kind: 'paragraph' })
    expect(untranslated).not.toHaveProperty('translationOf')
    expect(textOf(tree.footnotes[0]!.blocks[0]!.runs)).toBe('Notiz')
  })
})

describe('bilingual tree', () => {
  it('follows each original block with its translation', () => {
    const tree = deriveBilingualTree(sample(), 'de', translations)
    expect(tree.variant).toBe('bilingual')
    expect(tree.blocks.map((b) => b.id)).toEqual([
      'p1.1',
      'p1.2',
      'p1.2@de',
      'p1.3',
      'p1.3@de',
      'p1.4',
      'p1.4@de',
      'p1.6',
    ])
    const table = tree.blocks[6]!
    expect(table).toMatchObject({ kind: 'table', translationOf: 'p1.4' })
    if (table.kind === 'table') expect(textOf(table.caption!.runs)).toBe('Tabelle 1 Größen')
    expect(tree.footnotes[0]!.blocks.map((b) => b.id)).toEqual(['fnn1.1', 'fnn1.1@de'])
  })
})

describe('sha256', () => {
  it('matches the FIPS test vectors', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
    expect(sha256Hex('a'.repeat(1000))).toBe(
      '41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3',
    )
  })
})
