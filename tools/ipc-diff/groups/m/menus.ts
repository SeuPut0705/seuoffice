/**
 * Group `m/menus`: the nine event channels no IPC handler emits, only a native
 * menu: `menu:command` (docs), `menu:action` (sheets), `<app>:print-request`
 * (pdf, markdown, html, hwp, diagram, mindmap), `docs:context-menu` and
 * `seuoffice:view-image` (the native right-click menu). Every call is a
 * `trigger` (README.md): the click fires on both sides. Names:
 * `m/menu:<app>:<labels joined by " > ">` (args `[]`) and `m/context-menu` (args `[params, path]`).
 *
 * Where the TypeScript menus come from:
 *   - sheets: the real `installSheetsMenu` of apps/sheets/src/main/sheets-main.ts,
 *     with its active web contents set to the view.
 *   - docs and the six shell-built menus: `docs-main.ts` and `index.ts` cannot
 *     be loaded (docs-main reaches the html2docx browser scripts, index.ts is
 *     the shell's entry). The functions are taken out of the source text with
 *     the TypeScript compiler and run in a scope of the names they use, so the
 *     templates are the real ones, never a copy:
 *       docs-main.ts   tMain (309), tm (613), sendCommand (4092), buildDocsMenu (4155)
 *       index.ts       tMain (1181), tm (1512), buildPdfMenu (5005),
 *                      buildMarkdownMenu (5106), buildHwpMenu (5221),
 *                      buildHtmlMenu (5430), buildDiagramMenu (5538),
 *                      buildMindmapMenu (5680)
 *     The clicks reach the real `send<App>PrintRequest` of each app's main file
 *     (`sendHtmlPrintRequest` of html-main.ts:753 is taken out of the source as
 *     well: html-main reaches html2docx too). What the menus click on that is
 *     not an M event (open, save, export, the tab manager) is not run.
 *   - the docs arm and claim handlers (docs-main.ts:2880-2910, copied as
 *     m/spell does) and the real `installContextMenu` of
 *     packages/electron-utils/src/context-menu.ts, which pops the native menu.
 *
 * Language: the process language is the `language` of the case's
 * userData/app-settings.json (English by default), set for `getUiLang()` when
 * the case loads, as the shell sets it at start.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import {
  aboutMenuItem,
  appMenuLabels,
  appMenuTemplate,
  contextMenuLabels,
  editMenuTemplate,
  helpCheckUpdatesItems,
  installContextMenu,
  setContextMenuInterceptor,
  settingsMenuItem,
  toggleDevToolsItem,
  windowMenuTemplate,
} from '@seuoffice/electron-utils'
import { createI18n, getUiLang, normalizeLang, setUiLang } from '@seuoffice/i18n'
import { ClickClaims } from '../../../../apps/docs/src/shared/context-menu-claims.ts'
import { sendDiagramPrintRequest } from '../../../../apps/diagram/src/main/diagram-main.ts'
import { requestHwpPrint } from '../../../../apps/hwp/src/main/hwp-main.ts'
import { sendMarkdownPrintRequest } from '../../../../apps/markdown/src/main/markdown-main.ts'
import { sendMindmapPrintRequest } from '../../../../apps/mindmap/src/main/mindmap-main.ts'
import { sendPdfPrintRequest } from '../../../../apps/pdf/src/main/pdf-main.ts'
import { HTML_CHANNELS } from '../../../../apps/html/src/shared/ipc.ts'
import type { CaseElectron } from '../../fakes.ts'
import type { Call, Case, Group, LoadContext, TriggerContext, View } from '../../types.ts'
import type { FakeMenu, MenuTemplateItem } from '../../fakes.ts'

/** the apps compile to CommonJS: `@seuoffice/i18n` is loaded twice, and each copy holds its own language */
const cjsI18n = createRequire(import.meta.url)('@seuoffice/i18n') as {
  setUiLang(lang: string): void
}
const setLanguage = (lang: 'en' | 'ko'): void => {
  setUiLang(lang)
  cjsI18n.setUiLang(lang)
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const SHEETS = 'apps/sheets/src/main/sheets-main.ts'
const DOCS_MAIN = 'apps/docs/src/main/docs-main.ts'
const INDEX = 'apps/shell/src/main/index.ts'

type Fn = (...args: unknown[]) => unknown

/** the declarations `names` of a source file, as JavaScript, in that order */
function declarations(file: string, names: string[]): string {
  const text = readFileSync(resolve(root, file), 'utf8')
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true)
  return names
    .map((name) => {
      const statement = source.statements.find((s) =>
        ts.isFunctionDeclaration(s)
          ? s.name?.text === name
          : ts.isVariableStatement(s) &&
            s.declarationList.declarations.some(
              (d) => ts.isIdentifier(d.name) && d.name.text === name,
            ),
      )
      if (!statement) throw new Error(`${file} declares no ${name}`)
      const js = ts.transpileModule(statement.getText(source), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
      }).outputText
      return js.replace(/^export\s+/, '')
    })
    .join('\n')
}

/** runs `code` with `scope`'s names in reach and answers what it declares under `results` */
function evaluate(
  code: string,
  scope: Record<string, unknown>,
  results: string[],
): Record<string, Fn> {
  const names = Object.keys(scope)
  const make = new Function(...names, `${code}\nreturn { ${results.join(', ')} }`)
  return make(...names.map((n) => scope[n])) as Record<string, Fn>
}

const memo = new Map<string, string>()
const taken = (file: string, names: string[]): string => {
  const key = `${file}:${names.join()}`
  if (!memo.has(key)) memo.set(key, declarations(file, names))
  return memo.get(key)!
}

/** the process language of a case: its settings file's `language`, else the system's `en-US` */
function languageOf(c: Case): 'en' | 'ko' {
  const file = c.files?.['userData/app-settings.json']
  const text = typeof file === 'string' ? file : (file as { text?: string } | undefined)?.text
  let stored: unknown
  try {
    stored = text === undefined ? undefined : (JSON.parse(text) as { language?: unknown }).language
  } catch {
    stored = undefined
  }
  return normalizeLang(typeof stored === 'string' && stored.trim() ? stored : 'en-US')
}

/** the names the shell-built menus use besides their dictionary */
function shellScope(
  electron: CaseElectron,
  view: number,
  lang: 'en' | 'ko',
): Record<string, unknown> {
  const target = () => ({ webContents: electron.contents(view) })
  return {
    process,
    createI18n,
    app: electron.app,
    Menu: electron.Menu,
    currentLang: () => lang,
    appMenuLabels,
    appMenuTemplate,
    editMenuTemplate,
    windowMenuTemplate,
    settingsMenuItem,
    helpCheckUpdatesItems,
    aboutMenuItem,
    documentLinkFileMenuItems: () => [],
    activePdfTarget: target,
    activeMarkdownTarget: target,
    activeHwpTarget: target,
    activeHtmlTarget: target,
    activeDiagramTarget: target,
    activeMindmapTarget: target,
    sendPdfPrintRequest,
    sendMarkdownPrintRequest,
    requestHwpPrint,
    sendDiagramPrintRequest,
    sendMindmapPrintRequest,
    sendHtmlPrintRequest: evaluate(
      `const HTML_CHANNELS = scope_HTML_CHANNELS\nconst presentOwnerByWc = new Map()\n${declarations(
        'apps/html/src/main/html-main.ts',
        ['sendHtmlPrintRequest'],
      )}`,
      { scope_HTML_CHANNELS: HTML_CHANNELS },
      ['sendHtmlPrintRequest'],
    ).sendHtmlPrintRequest,
  }
}

const SHELL_MENUS = {
  pdf: 'buildPdfMenu',
  markdown: 'buildMarkdownMenu',
  hwp: 'buildHwpMenu',
  html: 'buildHtmlMenu',
  diagram: 'buildDiagramMenu',
  mindmap: 'buildMindmapMenu',
} as const

const sheetsModules = new WeakMap<CaseElectron, Promise<Record<string, Fn>>>()

export const group: Group = {
  batch: 'M',

  async load(cx: LoadContext) {
    const { electron } = cx
    setLanguage(languageOf(cx.case))
    // docs-main.ts:2880-2910
    const app = electron.app as never
    const ctxMenuClaims = new Map<number, ClickClaims>()
    const tornDownWcIds = new Set<number>()
    const on = (ch: string, fn: Fn) =>
      electron.handlers.on.set(ch, [...(electron.handlers.on.get(ch) ?? []), fn])
    on('docs:context-menu-claim', (event: any, seq: unknown) => {
      event.returnValue = true
      if (typeof seq !== 'number') return
      let claims = ctxMenuClaims.get(event.sender.id)
      if (!claims) {
        claims = new ClickClaims()
        ctxMenuClaims.set(event.sender.id, claims)
      }
      claims.claim(seq, Date.now())
    })
    on('docs:context-menu-arm', (event: any) => {
      const wc = event.sender
      setContextMenuInterceptor(app, wc, (contents, params) => {
        if (contents.isDestroyed() || tornDownWcIds.has(contents.id)) return Promise.resolve(false)
        const seq = ctxMenuClaims.get(contents.id)?.take(Date.now()) ?? null
        if (seq !== null) {
          const request = {
            seq,
            misspelledWord: params.misspelledWord,
            suggestions: params.dictionarySuggestions,
          }
          contents.send('docs:context-menu', request)
        }
        return Promise.resolve(seq !== null)
      })
      wc.once('destroyed', () => {
        setContextMenuInterceptor(app, wc, null)
        ctxMenuClaims.delete(wc.id)
      })
    })
    // index.ts:6507, with the language of the case
    installContextMenu(app, () => contextMenuLabels(getUiLang()))
  },

  cases: [],
}

async function buildMenu(cx: LoadContext, kind: string, view: number): Promise<void> {
  {
    const { electron } = cx
    const lang = languageOf(cx.case)
    setLanguage(lang)
    if (kind === 'sheets') {
      if (!sheetsModules.has(electron)) sheetsModules.set(electron, cx.fresh(SHEETS))
      const sheets = await sheetsModules.get(electron)!
      // the module sets its own language when it loads
      setLanguage(lang)
      sheets.setActiveSheetsWebContents(electron.contents(view))
      sheets.installSheetsMenu()
      return
    }
    if (kind === 'docs') {
      const scope = {
        process,
        createI18n,
        getUiLang,
        app: electron.app,
        Menu: electron.Menu,
        basename: (p: string) => p.split('/').pop(),
        readJson: () => [],
        RECENT_PATH: () => '',
        appMenuLabels,
        appMenuTemplate,
        settingsMenuItem,
        windowMenuTemplate,
        helpCheckUpdatesItems,
        aboutMenuItem,
        toggleDevToolsItem,
        docsMenuGate: null,
        extraFileMenuItems: [],
        documentLinkMenuItems: null,
        shellHooks: { openTab() {}, closeActiveTab() {} },
        isDev: false,
        createDocsWindow: () => ({ webContents: electron.contents(view) }),
        markDocsNewBlank() {},
        activeDocsWebContents: () => electron.contents(view),
        activeViewMenuState: () => ({ aiSidebar: true, darkCanvas: false, odt: false }),
      }
      evaluate(taken(DOCS_MAIN, ['tMain', 'tm', 'sendCommand', 'buildDocsMenu']), scope, [
        'buildDocsMenu',
      ]).buildDocsMenu()
      return
    }
    const build = SHELL_MENUS[kind as keyof typeof SHELL_MENUS]
    if (!build) throw new Error(`no menu for ${kind}`)
    evaluate(taken(INDEX, ['tMain', 'tm', build]), shellScope(electron, view, lang), [build])[
      build
    ]()
  }
}

const list = (path: string[]): string => `[${path.map((p) => JSON.stringify(p)).join(', ')}]`

/** the item at `path` of a template: each label but the last names a submenu */
function findItem(
  items: MenuTemplateItem[] | undefined,
  path: string[],
): MenuTemplateItem | undefined {
  const [first, ...rest] = path
  const item = items?.find((i) => i.label === first)
  if (!item || rest.length === 0) return item
  return findItem(Array.isArray(item.submenu) ? item.submenu : item.submenu?.template, rest)
}

/** Electron's `click(menuItem, window, event)` */
async function clickItem(cx: TriggerContext, view: number, item: MenuTemplateItem): Promise<void> {
  const windows = cx.electron.BrowserWindow as { fromWebContents(wc: unknown): unknown }
  await item.click?.(item, windows.fromWebContents(cx.contents(view)), {})
}

async function clickAppMenu(
  cx: TriggerContext,
  view: number,
  app: string,
  path: string[],
): Promise<void> {
  await buildMenu(cx, app, view)
  const menu = (cx.electron.Menu as { getApplicationMenu(): FakeMenu | null }).getApplicationMenu()
  const item = findItem(menu?.template, path)
  if (!item) throw new Error(`no menu item ${list(path)} in the ${app} menu`)
  await clickItem(cx, view, item)
}

/** `contents.emit('context-menu')`, then the click on the entry of the menu that was popped, if one was */
async function rightClick(
  cx: TriggerContext,
  view: number,
  params: Record<string, unknown>,
  path: string[],
): Promise<void> {
  cx.electron.takePopped()
  await cx.contents(view).emit(
    'context-menu',
    {},
    {
      misspelledWord: '',
      dictionarySuggestions: [],
      selectionText: '',
      isEditable: false,
      x: 0,
      y: 0,
      ...params,
      editFlags: {
        canCut: false,
        canCopy: false,
        canPaste: false,
        canSelectAll: false,
        ...(params.editFlags as object | undefined),
      },
    },
  )
  // the native menu pops after a dynamic import
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r))
  const menu = cx.electron.takePopped()
  if (!menu) return
  const item = findItem(menu.template, path)
  if (!item) throw new Error(`no context menu entry ${list(path)}`)
  await clickItem(cx, view, item)
}

const MENU = 'm/menu:'
const CONTEXT = 'm/context-menu'

group.triggers = new Proxy({} as NonNullable<Group['triggers']>, {
  get(_, name) {
    if (typeof name !== 'string') return undefined
    if (name === CONTEXT)
      return (cx: TriggerContext, view: number, [params, path]: unknown[]) =>
        rightClick(cx, view, params as Record<string, unknown>, path as string[])
    if (!name.startsWith(MENU)) return undefined
    const [app, labels] = [
      name.slice(MENU.length).split(':')[0],
      name.slice(MENU.length).split(':').slice(1).join(':'),
    ]
    return (cx: TriggerContext, view: number) => clickAppMenu(cx, view, app, labels.split(' > '))
  },
})

const surfaces: Record<string, string> = {
  docs: 'Docs',
  sheets: 'Sheets',
  pdf: 'Pdf',
  markdown: 'Markdown',
  hwp: 'Hwp',
  html: 'Html',
  diagram: 'Diagram',
  mindmap: 'Mindmap',
}

const one = (app: string): { views: View[] } => ({
  views: [{ view: 1, window: 1, surface: surfaces[app] }],
})
const click = (app: string, path: string[], view?: number): Call => ({
  channel: `${MENU}${app}:${path.join(' > ')}`,
  kind: 'trigger',
  name: `${MENU}${app}:${path.join(' > ')}`,
  args: [],
  ...(view === undefined ? {} : { view }),
})
const ko = { 'userData/app-settings.json': JSON.stringify({ language: 'ko' }) }
const PRINT = ['File', 'Print\u2026']

const arm: Call = { channel: 'docs:context-menu-arm', kind: 'send', args: [] }
const claim = (seq: unknown): Call => ({
  channel: 'docs:context-menu-claim',
  kind: 'sendSync',
  args: [seq],
})
const context = (params: Record<string, unknown>, path: string[], view?: number): Call => ({
  channel: CONTEXT,
  kind: 'trigger',
  name: CONTEXT,
  args: [params, path],
  ...(view === undefined ? {} : { view }),
})
const image = { mediaType: 'image', srcURL: 'data:image/png;base64,AAAA' }

group.cases = [
  ...['pdf', 'markdown', 'html', 'diagram', 'mindmap'].map((app): Case => ({
    note: `${app}: File > Print sends ${app}:print-request`,
    ...one(app),
    calls: [click(app, PRINT)],
  })),
  {
    note: 'hwp: File > Export as PDF sends hwp:print-request with "pdf"',
    ...one('hwp'),
    calls: [click('hwp', ['File', 'Export as PDF\u2026'])],
  },
  {
    note: 'docs: commands, one with a payload; the event goes to the view the menu acts on',
    views: [
      { view: 1, window: 1, surface: 'Docs' },
      { view: 2, window: 2, surface: 'Docs' },
    ],
    calls: [
      click('docs', ['File', 'Save']),
      click('docs', PRINT, 2),
      click('docs', ['File', 'Name with AI\u2026']),
      click('docs', ['View', 'Zoom', '75%'], 2),
      click('docs', ['View', 'Zoom', 'Page Width']),
      click('docs', ['Format', 'Align', 'Center']),
      click('docs', ['Table', 'Insert', 'Cells\u2026'], 2),
      click('docs', ['Tools', 'Word Count']),
    ],
  },
  {
    note: 'docs: an item the menu does not have throws, and nothing is sent',
    ...one('docs'),
    calls: [click('docs', ['File', 'Nope']), click('docs', ['Save']), click('docs', [])],
  },
  {
    note: 'sheets: menu actions',
    ...one('sheets'),
    calls: [
      click('sheets', ['File', 'Open Workbook\u2026']),
      click('sheets', PRINT),
      click('sheets', ['File', 'Export CSV\u2026']),
      click('sheets', ['Edit', 'Undo']),
      click('sheets', ['Edit', 'Redo']),
      click('sheets', ['File', 'Print']),
    ],
  },
  {
    note: 'ko: the labels follow the language (docs, sheets, markdown); an English label is no item',
    files: ko,
    views: [
      { view: 1, window: 1, surface: 'Docs' },
      { view: 2, window: 2, surface: 'Sheets' },
      { view: 3, window: 3, surface: 'Markdown' },
    ],
    calls: [
      click('docs', ['\uD30C\uC77C', '\uC778\uC1C4\u2026'], 1),
      click('sheets', ['\uD30C\uC77C', '\uC778\uC1C4\u2026'], 2),
      click('markdown', ['\uD30C\uC77C', '\uC778\uC1C4\u2026'], 3),
      click('markdown', PRINT, 3),
    ],
  },
  {
    note: 'context menu: a claimed right-click of an armed docs view sends docs:context-menu',
    ...one('docs'),
    calls: [
      arm,
      claim(7),
      context({ misspelledWord: 'teh', dictionarySuggestions: ['the', 'ten'], isEditable: true }, [
        'the',
      ]),
    ],
  },
  {
    note: 'context menu: an unclaimed right-click on an image pops the native menu: View Image',
    ...one('docs'),
    calls: [
      arm,
      context(image, ['View Image']),
      context(image, ['Nope']),
      context({ ...image, mediaType: 'none' }, ['View Image']),
    ],
  },
  {
    note: 'context menu: the markdown view has no interceptor: View Image',
    views: [{ view: 1, window: 1, surface: 'Markdown' }],
    calls: [context(image, ['View Image'])],
  },
  {
    note: 'context menu: the labels follow the language',
    files: ko,
    ...one('docs'),
    calls: [context(image, ['\uC774\uBBF8\uC9C0 \uBCF4\uAE30']), context(image, ['View Image'])],
  },
]
