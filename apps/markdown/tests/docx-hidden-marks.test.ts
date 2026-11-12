import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { JSONContent } from '@tiptap/core'
import { docxHoldsHiddenContent, parseDocx, withheldLabelOf } from '@seuoffice/docx-engine'
import { docxToText } from '../../../packages/file-parse/src/docx'
import { RedactionMarkError } from '../../../packages/file-parse/src/redaction-error'
import { run } from '../../../packages/cli/tests/helpers'
import { exportDocxBytes } from '../src/renderer/export/docxExport'

/**
 * Content a person hid from AI stays hidden in the Word export: each hidden
 * span is written as a run carrying the same mark and label the Docs app
 * writes, so that every reader of the .docx withholds it.
 */

const SECRET = '13800138000'
const noImages = () => Promise.resolve(null)

const hidden = (text: string, label = 'client phone', extra: object[] = []): JSONContent => ({
  type: 'text',
  text,
  marks: [...extra, { type: 'redaction', attrs: { label } }],
})
const text = (value: string): JSONContent => ({ type: 'text', text: value })
const para = (...content: JSONContent[]): JSONContent => ({ type: 'paragraph', content })

/** every place a hidden span can sit in a markdown document */
const PLACES: Record<string, () => JSONContent[]> = {
  'a paragraph': () => [para(text('Call '), hidden(`${SECRET}P`))],
  'a heading': () => [
    { type: 'heading', attrs: { level: 2 }, content: [text('Title '), hidden(`${SECRET}H`)] },
  ],
  'a bullet': () => [
    {
      type: 'bulletList',
      content: [{ type: 'listItem', content: [para(text('Item '), hidden(`${SECRET}L`))] }],
    },
  ],
  'a numbered item': () => [
    {
      type: 'orderedList',
      content: [{ type: 'listItem', content: [para(text('Step '), hidden(`${SECRET}O`))] }],
    },
  ],
  'a task': () => [
    {
      type: 'taskList',
      content: [
        { type: 'taskItem', attrs: { checked: false }, content: [para(hidden(`${SECRET}T`))] },
      ],
    },
  ],
  'a quote': () => [{ type: 'blockquote', content: [para(text('Said '), hidden(`${SECRET}Q`))] }],
  'a table cell': () => [
    {
      type: 'table',
      content: [
        {
          type: 'tableRow',
          content: [
            { type: 'tableHeader', content: [para(hidden(`${SECRET}X`))] },
            { type: 'tableCell', content: [para(text('plain'))] },
          ],
        },
        {
          type: 'tableRow',
          content: [
            { type: 'tableCell', content: [para(text('a'))] },
            { type: 'tableCell', content: [para(text('b '), hidden(`${SECRET}Y`))] },
          ],
        },
      ],
    },
  ],
  'a footnote': () => [
    {
      type: 'footnoteDefinition',
      attrs: { label: '1' },
      content: [para(text('See '), hidden(`${SECRET}N`))],
    },
  ],
  'bold words': () => [para(hidden(`${SECRET}B`, 'client phone', [{ type: 'bold' }]))],
  'a link': () => [
    para(
      hidden(`${SECRET}K`, 'client phone', [{ type: 'link', attrs: { href: 'https://x.test' } }]),
    ),
  ],
}

async function exported(blocks: JSONContent[]): Promise<Uint8Array> {
  return exportDocxBytes({ type: 'doc', content: blocks }, noImages)
}

const attachmentText = (bytes: Uint8Array) =>
  docxToText(bytes).catch((err: unknown) => {
    // refusing the file is a safe answer; anything else is a failure
    if (err instanceof RedactionMarkError) return ''
    throw err
  })

describe.each(Object.keys(PLACES))('a hidden span in %s', (place) => {
  it('is written under the mark, and the label survives', async () => {
    const bytes = await exported(PLACES[place]!())
    expect(await docxHoldsHiddenContent(bytes)).toBe(true)
    const doc = await parseDocx(bytes)
    const labels: Array<string | null> = []
    const collect = (runs: Array<{ text: string; rawRPr?: string }> | undefined) => {
      for (const r of runs ?? [])
        if (r.text.includes(SECRET)) labels.push(withheldLabelOf(r.rawRPr))
    }
    for (const block of doc.blocks) {
      collect(block.runs)
      for (const row of block.table?.rows ?? [])
        for (const cell of row) for (const p of cell.richParas ?? []) collect(p.runs)
    }
    // the table holds two hidden spans, every other place one
    expect(labels).toEqual(
      place === 'a table cell' ? Array(2).fill('client phone') : ['client phone'],
    )
  })

  it('is withheld by the attachment reader', async () => {
    expect(await attachmentText(await exported(PLACES[place]!()))).not.toContain(SECRET)
  })

  it('is withheld by docs read', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'md-hidden-'))
    const file = join(dir, 'out.docx')
    writeFileSync(file, await exported(PLACES[place]!()))
    const read = await run([
      'docs',
      'read',
      file,
      '--full',
      '--html',
      '--comments',
      '--notes',
      '--header-footer',
      '--json',
    ])
    expect(read.code).toBe(0)
    expect(read.stdout).not.toContain(SECRET)
    expect(read.stdout).toContain('{{client phone}}')
  })
})

describe('hidden content that is not a plain text node', () => {
  const marks = [{ type: 'redaction', attrs: { label: 'id' } }]

  it.each([
    [
      'an inline formula',
      () => [para(text('x '), { type: 'inlineMath', attrs: { latex: `a${SECRET}` }, marks })],
    ],
    ['a hard break', () => [para(text('x'), { type: 'hardBreak', marks }, hidden(SECRET))]],
    [
      'a picture',
      () => [
        para({ type: 'image', attrs: { src: `/p/${SECRET}.png`, alt: `alt ${SECRET}` }, marks }),
      ],
    ],
    [
      'code',
      () => [
        { type: 'codeBlock', attrs: { language: 'js' }, content: [hidden(`var k = "${SECRET}"`)] },
      ],
    ],
    [
      'a diagram',
      () => [
        {
          type: 'codeBlock',
          attrs: { language: 'mermaid' },
          content: [hidden(`graph TD; A["${SECRET}"]`)],
        },
      ],
    ],
    [
      'a block of a kind the export does not know',
      () => [{ type: 'callout', content: [para(text('see '), hidden(SECRET))] }],
    ],
  ])('%s is written under the mark', async (_name, build) => {
    let diagramsDrawn = 0
    const bytes = await exportDocxBytes({ type: 'doc', content: build() }, noImages, async () => {
      diagramsDrawn++
      return null
    })
    expect(diagramsDrawn).toBe(0)
    expect(await docxHoldsHiddenContent(bytes)).toBe(true)
    expect(await attachmentText(bytes)).not.toContain(SECRET)
    const doc = await parseDocx(bytes)
    const hiddenRuns = doc.blocks
      .flatMap((b) => b.runs ?? [])
      .filter((r) => r.text.includes(SECRET))
    expect(hiddenRuns.length).toBeGreaterThan(0)
    for (const r of hiddenRuns) expect(withheldLabelOf(r.rawRPr)).not.toBeNull()
  })
})

describe('the export of a document with no hidden span', () => {
  it('carries no mark', async () => {
    const bytes = await exported([para(text('Plain '), text('words'))])
    expect(await docxHoldsHiddenContent(bytes)).toBe(false)
  })
})
