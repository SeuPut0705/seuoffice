/**
 * Group `m/markdown-theme`: markdown's paper theme. The handlers are inline in
 * `registerMarkdownIpc` (apps/markdown/src/main/markdown-main.ts:1075,
 * 1110-1133, bodies copied verbatim), which cannot be loaded on the fake
 * Electron; the helpers they call (`normalizeMarkdownTheme`, `atomicWriteFile`)
 * are the real modules.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWriteFile } from '../../../../apps/markdown/src/main/atomic-write.ts'
import {
  normalizeMarkdownTheme,
  type MarkdownTheme,
} from '../../../../apps/markdown/src/shared/markdown-theme.ts'
import type { Case, Group } from '../../types.ts'

const file = (text: string) => ({ 'userData/markdown-settings.json': text })
const get = { channel: 'markdown:get-theme', args: [] }
const set = (theme: unknown) => ({ channel: 'markdown:set-theme', args: [theme] })
const markdown = [{ view: 1, window: 1, surface: 'Markdown' }]
const dirOnly = { userData: { dir: true } as const }

const cases: Case[] = [
  { note: 'no file: default', views: markdown, files: dirOnly, calls: [get] },
  {
    note: 'a stored theme',
    views: markdown,
    files: file('{"markdownTheme":"nord","imageHost":{"x":1}}'),
    calls: [get],
  },
  {
    note: 'a stored value that is no theme, a number-like value',
    views: markdown,
    files: file('{"markdownTheme":"Nord"}'),
    calls: [get],
  },
  { note: 'corrupt file', views: markdown, files: file('{oops'), calls: [get] },
  { note: 'JSON null', views: markdown, files: file('null'), calls: [get] },
  { note: 'JSON number', views: markdown, files: file('42'), calls: [get] },
  {
    note: 'JSON array carrying nothing',
    views: markdown,
    files: file('["nord"]'),
    calls: [get],
  },
  {
    note: 'stored theme is an array whose String() names a theme',
    views: markdown,
    files: file('{"markdownTheme":["blubook"]}'),
    calls: [get],
  },
  {
    note: 'set creates the file; the get after reads it back',
    views: markdown,
    files: dirOnly,
    calls: [set('notion-dark'), get],
  },
  {
    note: 'set keeps the image host beside the theme',
    views: markdown,
    files: file('{"imageHost":{"kind":"s3"},"markdownTheme":"nord"}'),
    calls: [set('newsprint'), get],
  },
  {
    note: 'set with an unknown theme writes default; non-strings too',
    views: markdown,
    files: dirOnly,
    calls: [set('rainbow'), set(5), set({ $: 'u' }), set(null), set(['nord'])],
  },
  {
    note: 'set over a corrupt file starts from an empty object',
    views: markdown,
    files: file('{oops'),
    calls: [set('drake-dark')],
  },
  {
    note: 'set over JSON null / number / string / array / true',
    views: markdown,
    files: file('null'),
    calls: [set('nord')],
  },
  { note: 'set over a number file', views: markdown, files: file('7'), calls: [set('nord')] },
  { note: 'set over a string file', views: markdown, files: file('"s"'), calls: [set('nord')] },
  { note: 'set over a boolean file', views: markdown, files: file('true'), calls: [set('nord')] },
  { note: 'set over an array file', views: markdown, files: file('[1,2]'), calls: [set('nord')] },
]

export const group: Group = {
  batch: 'M',
  async load(cx) {
    const { ipcMain, app } = cx.electron as unknown as {
      ipcMain: { handle(channel: string, fn: (...args: never[]) => unknown): void }
      app: { getPath(name: string): string }
    }
    const imageHostConfigPath = (): string =>
      join(app.getPath('userData'), 'markdown-settings.json')
    ipcMain.handle('markdown:get-theme', async (): Promise<MarkdownTheme> => {
      try {
        const raw = JSON.parse(await readFile(imageHostConfigPath(), 'utf8'))
        return normalizeMarkdownTheme(raw?.markdownTheme)
      } catch {
        return 'default'
      }
    })
    ipcMain.handle(
      'markdown:set-theme',
      async (_e: unknown, theme: unknown): Promise<MarkdownTheme> => {
        const normalized = normalizeMarkdownTheme(theme)
        let file: Record<string, unknown>
        try {
          file = JSON.parse(await readFile(imageHostConfigPath(), 'utf8'))
        } catch {
          file = {}
        }
        file.markdownTheme = normalized
        await atomicWriteFile(imageHostConfigPath(), Buffer.from(JSON.stringify(file, null, 2)))
        return normalized
      },
    )
  },
  cases,
}
