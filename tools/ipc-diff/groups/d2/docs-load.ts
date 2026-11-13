/**
 * Loads `apps/docs/src/main/docs-main.ts` afresh for one case and wires it as
 * the shell's entry does (`setDocsShellHooks`, the file hooks, the active-tab
 * resolver, `registerAiIpc`, `registerDocsIpc`), over the fakes of
 * `docs-fakes.ts`. Not a group: the docs groups call it from their `load`.
 */
import { createRequire } from 'node:module'
import type { LoadContext } from '../../types.ts'
import { inert, withInert } from '../w/shell-index.ts'
import {
  answer,
  fakeMenu,
  fakeNativeImage,
  fakeNet,
  shellHooks,
  useDocsCase,
} from './docs-fakes.ts'

const ENTRY = 'apps/docs/src/main/docs-main.ts'
const require = createRequire(import.meta.url)

/** the recovery store's process-wide state, as the probe's fresh one per case */
const SHARED = Symbol.for('seuoffice.recovery-store.shared')

/** the case's `hosts.d2.docs` */
export function docsCase(cx: LoadContext): Record<string, unknown> {
  const d2 = (cx.case.hosts?.d2 ?? {}) as Record<string, unknown>
  return (d2.docs ?? {}) as Record<string, unknown>
}

type Fn = (...args: unknown[]) => unknown

interface DocsMain extends Record<string, unknown> {
  setDocsShellHooks(hooks: unknown): void
  setDocsFileSavedHook(hook: unknown): void
  setDocsFileOpenedHook(hook: unknown): void
  setActiveDocsResolver(fn: unknown): void
  configureDocsRuntime(config: unknown): void
  registerAiIpc(): void
  registerDocsIpc(): void
}

/** Registers the Word editor's handlers for this case; returns the module */
export async function loadDocs(cx: LoadContext): Promise<DocsMain> {
  const docs = docsCase(cx)
  useDocsCase(cx.electron, cx.dir, docs)
  ;(globalThis as Record<symbol, unknown>)[SHARED] = {
    shuttingDown: false,
    epochs: new Map(),
    queues: new Map(),
    runId: '0000000000000000',
    discarded: new Set(),
  }
  require('@seuoffice/i18n').setUiLang(docs.ui_lang === 'ko' ? 'ko' : 'en')
  // every module under apps/docs/src/main starts over (docx-encryption.ts and
  // docs-recovery.ts keep per-process maps), as the probe's fresh world does
  for (const key of Object.keys(require.cache)) {
    if (key.includes('/apps/docs/src/main/')) delete require.cache[key]
  }
  const app = cx.electron.app as Record<string, unknown>
  cx.install({
    app: withInert({
      ...app,
      getVersion: () => '0.13.0',
      getAppPath: () => `${process.cwd()}/apps/docs`,
      getSystemLocale: () => 'en-US',
      isReady: () => false,
      whenReady: () => new Promise(() => {}),
    }),
    Menu: fakeMenu(),
    nativeImage: fakeNativeImage(),
    net: fakeNet(),
    session: inert(),
    protocol: inert(),
    nativeTheme: inert(),
    screen: inert(),
    WebContentsView: inert(),
    dialog: withInert(cx.electron.dialog as object),
    shell: withInert(cx.electron.shell as object),
    clipboard: withInert(cx.electron.clipboard as object),
    webContents: withInert(cx.electron.webContents as object),
    BrowserWindow: withInert(cx.electron.BrowserWindow as object),
  })
  // capturePage of a docs view takes the rectangle (the shared fake ignores it)
  for (const v of cx.case.views ?? []) {
    const contents = cx.electron.contents(v.view)
    // the destroyed hook docs:view-menu-state hangs on its sender
    contents.once = () => contents
    contents.capturePage = async (rect: unknown) => {
      cx.electron.log.push(['webContents.capturePage', v.view, rect])
      const png = answer('capture_rect')
      const bytes = typeof png === 'string' ? Buffer.from(png, 'utf8') : Buffer.alloc(0)
      return { isEmpty: () => bytes.length === 0, toPNG: () => bytes }
    }
  }
  const main = await cx.fresh<DocsMain>(ENTRY)
  const hooks = shellHooks(cx.electron)
  main.setDocsShellHooks(hooks.hooks)
  main.setDocsFileSavedHook(hooks.fileSaved)
  main.setDocsFileOpenedHook(hooks.fileOpened)
  main.setActiveDocsResolver(hooks.active)
  main.registerAiIpc()
  main.registerDocsIpc()
  return main
}

/**
 * The shell's calls of the Word editor by trigger name (`d2/docs:<what>`),
 * each the exported function crates/shell-ipc/d2/src/docs/trigger.rs calls
 * through `DocsEditors`: `(view, args) => outcome`
 */
export type DocsTriggers = Record<string, (view: number, args: unknown[]) => unknown>

export function docsTriggers(main: DocsMain, cx: LoadContext): DocsTriggers {
  const fn = (name: string) => main[name] as Fn
  const contents = (view: number) => cx.electron.contents(view)
  const editor = () =>
    (require('@seuoffice/electron-utils').recoveryEditor('docs') ?? {}) as Record<string, Fn>
  return {
    'request-close': (view, [parent]) =>
      fn('requestDocsClose')(
        contents(view),
        typeof parent === 'number' ? { id: parent, isDestroyed: () => false } : undefined,
      ),
    'file-renamed': (view, [from, to]) => fn('docsFileRenamed')(contents(view), from, to),
    'mark-new-blank': (view) => fn('markDocsNewBlank')(view),
    'queue-copy': (view, [copy]) => fn('queueDocsCopy')(view, copy),
    'authorize-mcp-doc-write': (view, [path]) => fn('authorizeMcpDocWrite')(view, path),
    teardown: (view) => fn('teardownDocsRenderer')(contents(view)),
    'discard-recovery': (view) => fn('discardDocsRecovery')(contents(view)),
    'recovery-identity': (view) => fn('docsRecoveryIdentity')(view),
    'write-copies-now': () => editor().writeCopiesNow(),
    'open-file-with-decision': (view, [request]) =>
      editor().openFileWithDecision(contents(view), request),
    'open-untitled-copy': (view, [request]) => editor().openUntitledCopy(contents(view), request),
    'create-ai-document': (view, [request]) => fn('createAiDocument')(request, view),
  }
}
