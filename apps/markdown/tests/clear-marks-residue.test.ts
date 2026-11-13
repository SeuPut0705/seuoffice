import { afterEach, describe, expect, it } from 'vitest'
import { Editor, type JSONContent } from '@tiptap/core'
import JSZip from 'jszip'
import { buildExtensions } from '../src/renderer/editor/extensions'
import { clearRedaction, holdsRedaction, redactLabels } from '../src/renderer/editor/redact'
import { exportDocxBytes } from '../src/renderer/export/docxExport'

/**
 * "Clear marks" writes a copy (the ODT export) from which nothing of the
 * hiding is left: no mark, no label, no `data-redaction` span written out as
 * text, no placeholder, and every hidden word still there as plain text.
 * The file is read the way the app opens it, so spellings the file may hold
 * all go through the same reader.
 */

const SECRET = '13800138000'

const editors: Editor[] = []
afterEach(() => {
  for (const e of editors.splice(0)) e.destroy()
})

function open(md: string): JSONContent {
  const editor = new Editor({
    extensions: buildExtensions({
      slashController: {
        onOpen: () => {},
        onUpdate: () => {},
        onKeyDown: () => false,
        onClose: () => {},
      },
      slashItems: () => [],
    }),
    content: '',
  })
  editors.push(editor)
  editor.commands.setContent(md, { contentType: 'markdown' })
  return editor.getJSON()
}

const span = (text: string, label = 'client phone') =>
  `<span data-redaction data-label="${label}">${text}</span>`

/** every place and spelling a hidden span can take in a markdown file */
const PLACES: Record<string, string> = {
  'a paragraph': `Call ${span(`${SECRET}P`)} now`,
  'a heading': `## Title ${span(`${SECRET}H`)}`,
  'a bullet': `- Item ${span(`${SECRET}L`)}`,
  'a task': `- [ ] Task ${span(`${SECRET}T`)}`,
  'a quote': `> Quote ${span(`${SECRET}Q`)}`,
  'a table cell': `| a | b |\n| --- | --- |\n| x | ${span(`${SECRET}C`)} |`,
  'bold inside the span': `Call ${span(`**${SECRET}B**`)}`,
  'the span inside bold': `Call **${span(`${SECRET}O`)}**`,
  'a link text': `[${span(`${SECRET}K`)}](https://example.com)`,
  'single quotes': `Call <span data-redaction data-label='client phone'>${SECRET}S</span>`,
  'the label first': `Call <span data-label="client phone" data-redaction>${SECRET}F</span>`,
  'a valued attribute': `Call <span data-redaction="" data-label="client phone">${SECRET}V</span>`,
  'a label with entities': `Call ${span(`${SECRET}E`, 'client &amp; phone')}`,
}

/** the text of every w:t in every part */
async function docxText(bytes: Uint8Array): Promise<{ xml: string; text: string }> {
  const zip = await JSZip.loadAsync(bytes)
  const parts = await Promise.all(
    Object.keys(zip.files)
      .filter((p) => /^word\/[^/]+\.xml$/.test(p))
      .map((p) => zip.file(p)!.async('string')),
  )
  const xml = parts.join('\n')
  const text = [...xml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]).join('')
  return { xml, text }
}

describe.each(Object.keys(PLACES))('clearing the marks of %s', (place) => {
  it('leaves no mark, label or marker, and keeps the words', async () => {
    const json = open(PLACES[place]!)
    // the file is read as marked: otherwise there is nothing to clear
    expect(holdsRedaction(json)).toBe(true)
    const words = JSON.stringify(json).match(new RegExp(`${SECRET}[A-Z]`))![0]

    const cleared = clearRedaction(json)
    const raw = JSON.stringify(cleared)
    expect(redactLabels(cleared)).toEqual([])
    expect(raw).not.toMatch(/redaction|data-label|client phone|client &|\{\{/)
    expect(raw).toContain(words)

    const { xml, text } = await docxText(
      await exportDocxBytes(cleared, () => Promise.resolve(null)),
    )
    expect(xml).not.toMatch(/redact|6B4FC0|client phone/)
    expect(text).not.toMatch(/data-redaction|<span|\{\{/)
    expect(text).toContain(words)
  })
})
