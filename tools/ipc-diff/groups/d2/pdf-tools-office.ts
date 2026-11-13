/**
 * Group `d2/pdf-tools-office`: `pdf:convert-office`, registered by the shell
 * entry itself (`apps/shell/src/main/index.ts`, loaded with W's
 * `loadShellIndex`). The handler converts only for the active pdf tab, which
 * the tab manager knows; the entry builds the tab manager once the app is
 * ready, which it never is here, so every format answers undefined without
 * an effect, as the Rust handler does with no active pdf tab.
 */
import type { Case, Group, View } from '../../types.ts'
import { loadShellIndex } from '../w/shell-index.ts'

const SHELL: View = { view: 1, window: 1, surface: 'Shell' }
const PDF: View = { view: 5, window: 1, surface: 'Pdf' }
const convert = (format: unknown) => ({ channel: 'pdf:convert-office', view: 5, args: [format] })

const cases: Case[] = [
  {
    note: 'no active pdf tab: no format converts',
    views: [SHELL, PDF],
    calls: [convert('docx'), convert('xlsx'), convert('pptx'), convert('hwp'), convert(3)],
  },
  {
    note: 'only a pdf view may ask',
    views: [SHELL, PDF],
    calls: [{ channel: 'pdf:convert-office', view: 1, args: ['docx'] }],
  },
]

export const group: Group = {
  batch: 'D2',
  async load(cx) {
    await loadShellIndex(cx)
  },
  cases,
  single: {
    'pdf:convert-office':
      'answers undefined for every format; the conversions need the active pdf tab of a ready shell',
  },
}
