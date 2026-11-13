/**
 * `apps/shell/src/main/detached-windows.ts` for the shell entry in the
 * `d2/pdf-tools-office` group: the case's active PDF tab
 * (`hosts.d2.pdf.tools.active_pdf_tab`, the Rust `PdfToolsShell::active_pdf_tab`
 * fake's answer) is a focused detached window, which is where `activePdfTarget()`
 * looks first and where `pdfHostWindow()` finds the tab's window. The tab
 * manager stays as the entry leaves it before the app is ready: null.
 */
import { answer, log } from './state.cts'

export * from '../../../../../apps/shell/src/main/detached-windows'

interface ActiveTab {
  id: string
  view: number
  filePath?: string
  window: number
}

/** the case's Electron, as main-diff/electron-fake.ts keeps it */
function electron(): Record<string, unknown> {
  const box = (globalThis as unknown as Record<symbol, { fake: Record<string, unknown> }>)[
    Symbol.for('main-diff.electron')
  ]
  return box.fake
}

/** the case's active tab, as the Rust fake answers it on every call */
function activeTab(): ActiveTab | undefined {
  const a = answer('active_pdf_tab')
  return a && typeof a === 'object' ? (a as ActiveTab) : undefined
}

function windowOf(tab: ActiveTab) {
  return {
    id: tab.window,
    isDestroyed: () => false,
    isFocused: () => true,
    setProgressBar: (progress: number) => log(['setProgressBar', tab.window, progress]),
  }
}

export function focusedDetachedTab() {
  const tab = activeTab()
  if (!tab) return undefined
  const contents = (electron().webContents as { fromId(id: number): unknown }).fromId(tab.view)
  return {
    id: tab.id,
    kind: 'pdf',
    webContents: contents,
    ...(tab.filePath ? { filePath: tab.filePath } : {}),
    window: windowOf(tab),
  }
}

export function detachedWindowForWebContents(wcId: number) {
  const tab = activeTab()
  return tab && tab.view === wcId ? windowOf(tab) : undefined
}

export function focusDetachedByPath(_path: string): boolean {
  return false
}
