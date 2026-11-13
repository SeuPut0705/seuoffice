import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { JSONContent } from '@tiptap/core'
import { markedOdtChoice } from '@seuoffice/electron-utils/marked-odt'
import { askMarkedExport } from '../src/main/odt-export'
import { clearRedaction, holdsRedaction } from '../src/renderer/editor/redact'
import { MARKDOWN_CHANNELS } from '../src/shared/ipc'

/**
 * An ODT cannot keep the hiding of content marked "hidden from AI": a document
 * with a hidden span is not exported as ODT; Word instead, or the marks cleared
 * for the copy that is exported (the document itself keeps them).
 */

const SECRET = '13800138000'
const marked = (extra: object[] = []): JSONContent => ({
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Call ' },
        {
          type: 'text',
          text: SECRET,
          marks: [...extra, { type: 'redaction', attrs: { label: 'client phone' } }],
        },
      ],
    },
    {
      type: 'bulletList',
      content: [
        {
          type: 'listItem',
          content: [
            {
              type: 'paragraph',
              content: [
                {
                  type: 'text',
                  text: SECRET,
                  marks: [{ type: 'redaction', attrs: { label: 'x' } }],
                },
              ],
            },
          ],
        },
      ],
    },
  ],
})

describe('a document with content hidden from AI', () => {
  it('is told apart from one with none', () => {
    expect(holdsRedaction(marked())).toBe(true)
    expect(
      holdsRedaction({
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'Hi', marks: [{ type: 'bold' }] }] },
        ],
      }),
    ).toBe(false)
  })

  it('has its marks taken off in the copy, words and other marks kept, the original untouched', () => {
    const original = marked([{ type: 'bold' }])
    const before = JSON.stringify(original)
    const cleared = clearRedaction(original)
    expect(holdsRedaction(cleared)).toBe(false)
    const text = JSON.stringify(cleared)
    expect(text).toContain(SECRET)
    expect(text).toContain('"bold"')
    expect(text).not.toContain('redaction')
    expect(JSON.stringify(original)).toBe(before)
  })
})

describe('the choice box', () => {
  it.each(['en', 'ko'] as const)('has three buttons in %s, cancel last', async (lang) => {
    const shown: Array<{ buttons: string[]; cancelId: number }> = []
    const choice = await askMarkedExport(
      'odt',
      async (options) => {
        shown.push(options)
        return { response: 0 }
      },
      lang,
    )
    expect(choice).toBe('docx')
    expect(shown[0]!.buttons).toHaveLength(3)
    expect(new Set(shown[0]!.buttons).size).toBe(3)
    expect(shown[0]!.cancelId).toBe(2)
  })

  it('answers cancel for a closed box', () => {
    expect([0, 1, 2, -1].map((r) => markedOdtChoice(r))).toEqual([
      'docx',
      'clear',
      'cancel',
      'cancel',
    ])
  })

  it('speaks Korean and English differently', async () => {
    const title = async (lang: 'en' | 'ko') => {
      let out = ''
      await askMarkedExport('odt', async (o) => ((out = o.title), { response: 2 }), lang)
      return out
    }
    expect(await title('ko')).not.toBe(await title('en'))
  })
})

const source = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')

describe('where the document is exported', () => {
  it('asks before anything is built, for every format that cannot keep the mark', () => {
    const app = source('../src/renderer/App.tsx')
    const run = app.slice(app.indexOf('async (format: ExportFormat, outPath?: string'))
    const gate = run.indexOf('planMarkedExport(')
    expect(gate).toBeGreaterThan(-1)
    // before the page images, the PDF and the Word bytes the ODT is made from
    expect(gate).toBeLessThan(run.indexOf("if (format === 'png')"))
    expect(gate).toBeLessThan(run.indexOf('markdownApi.exportPdf('))
    expect(gate).toBeLessThan(run.indexOf('exportDocxBytes(plan.json,'))
    expect(run).toContain("if (plan.kind === 'declined') return false")
    expect(run).toContain("runExportRef.current('docx')")
    // the command-line export has no one to ask
    expect(run).toContain('outPath ? null :')
    // every ODT export, the export menu's and Save As ›, goes through runExport
    expect(app.match(/markdownApi\.exportOdt\(/g)).toHaveLength(1)
  })

  it('routes the question through preload to the main handler', () => {
    expect(MARKDOWN_CHANNELS.confirmMarkedExport).toBe('markdown:confirm-marked-export')
    expect(source('../src/preload/index.ts')).toMatch(
      /confirmMarkedExport:[^]*MARKDOWN_CHANNELS\.confirmMarkedExport/,
    )
    expect(source('../src/main/markdown-main.ts')).toMatch(
      /ipcMain\.handle\(MARKDOWN_CHANNELS\.confirmMarkedExport,/,
    )
  })
})
