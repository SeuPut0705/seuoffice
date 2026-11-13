/**
 * Group `a/mcp-bridges`: the shell half of the MCP to docs and sheets editor
 * bridges (`apps/shell/src/main/mcp/docs-bridge.ts`, `sheets-bridge.ts`).
 *
 * The renderer channels (`docs:mcp-ready`, `docs:mcp-result` and the sheets
 * twins) are `send`s that only change the bridge's state; what shows is the
 * command event (`docs:mcp-command`, `sheets:mcp-command`) and the promises
 * the MCP tool layer waits on. Those calls are no channel, so each is a
 * trigger (`a/mcp-docs-run` ...), left pending (`defer`) while it waits for
 * the renderer, and answered when the renderer's ready or result call lands.
 *
 * The deps `createDocsControl` and `createSheetsControl` get in the shell
 * entry (tab opening and closing, save authorisation) are stand-ins that log
 * one line each, as the Rust probe's `McpTabs` fake does; they answer from
 * `hosts.a.mcp.tabs` (`docs`, `sheets`: the views they hand out in order;
 * `sheetsError`: `openBlankSheetsTabForMcp` rejects with it).
 */
import type { Call, Case, Group, LoadContext, View } from '../../types.ts'

type DocsBridge = typeof import('../../../../apps/shell/src/main/mcp/docs-bridge.ts')
type SheetsBridge = typeof import('../../../../apps/shell/src/main/mcp/sheets-bridge.ts')
type Control = {
  openBlankTab: () => Promise<number>
  runCommand: (wcId: number, command: string, payload: unknown) => Promise<unknown>
}

interface Tabs {
  docs?: number[]
  sheets?: number[]
  sheetsError?: string
}

let docsControl: Control | undefined
let sheetsControl: Control | undefined

const views: View[] = [
  { view: 1, window: 1, surface: 'Shell' },
  { view: 2, window: 2, surface: 'Docs' },
  { view: 3, window: 3, surface: 'Docs' },
  { view: 4, window: 4, surface: 'Sheets' },
  { view: 5, window: 5, surface: 'Sheets' },
]

const trigger = (name: string, args: unknown[], defer = false): Call => ({
  channel: name,
  kind: 'trigger',
  name,
  view: 1,
  args,
  ...(defer ? { defer: true as const } : {}),
})
const docsRun = (wc: number, command: string, payload?: unknown, defer = true): Call =>
  trigger('a/mcp-docs-run', payload === undefined ? [wc, command] : [wc, command, payload], defer)
const sheetsRun = (wc: number, command: string, payload?: unknown, defer = true): Call =>
  trigger('a/mcp-sheets-run', payload === undefined ? [wc, command] : [wc, command, payload], defer)
const from = (view: number, channel: string, ...args: unknown[]): Call => ({
  channel,
  kind: 'send',
  view,
  args,
})
const ready = (view: number): Call => from(view, view >= 4 ? 'sheets:mcp-ready' : 'docs:mcp-ready')
const result = (view: number, payload: unknown): Call =>
  from(view, view >= 4 ? 'sheets:mcp-result' : 'docs:mcp-result', payload)
const answered = (index: number): Call => ({ channel: '', args: [], await: index })

const tabs = (t: Tabs) => ({ a: { mcp: { tabs: t } } })

const cases: Case[] = [
  {
    note: 'a command waits for its tab, goes out when the tab is ready and resolves with the answer',
    views,
    calls: [
      docsRun(2, 'read_document'), // 0: waits: not ready
      ready(2), // sends mcp-1
      result(2, { requestId: 'mcp-1', ok: true, result: { text: 'hello' } }),
      answered(0),
    ],
  },
  {
    note: 'a tab that is ready already is sent the command at once; the payload goes along',
    views,
    calls: [
      ready(2),
      docsRun(2, 'insert_content', { blocks: [1, 2] }),
      result(2, { requestId: 'mcp-1', ok: true }),
      answered(1),
    ],
  },
  {
    note: 'the tab fails the command: its message rejects; no message is "command failed"',
    views,
    calls: [
      ready(2),
      docsRun(2, 'apply_ops'), // 1
      result(2, { requestId: 'mcp-1', ok: false, error: 'no such block' }),
      answered(1),
      docsRun(2, 'apply_ops'), // 3
      result(2, { requestId: 'mcp-2', ok: false }),
      answered(3),
    ],
  },
  {
    note: 'a result from another tab, for no command or without an id changes nothing',
    views,
    calls: [
      ready(2),
      ready(3),
      docsRun(2, 'read_document'), // 2
      result(3, { requestId: 'mcp-1', ok: true, result: 'forged' }),
      result(2, { requestId: 'mcp-99', ok: true }),
      result(2, { ok: true }),
      result(2, 'text'),
      result(2, { requestId: 'mcp-1', ok: true, result: 'real' }),
      answered(2),
    ],
  },
  {
    note: 'a tab that does not exist is refused at once',
    views,
    calls: [docsRun(77, 'read_document', undefined, false)],
  },
  {
    note: 'save_document: a path is required; an existing file needs overwrite; the save is authorised',
    views,
    files: { 'existing.docx': 'x' },
    calls: [
      ready(2),
      docsRun(2, 'save_document', {}, false),
      docsRun(2, 'save_document', { path: '$DIR/existing.docx' }, false),
      docsRun(2, 'save_document', { path: '$DIR/existing.docx', overwrite: true }), // 3
      result(2, { requestId: 'mcp-1', ok: true, result: '$DIR/existing.docx' }),
      answered(3),
      docsRun(2, 'save_document', { path: '$DIR/new.docx' }), // 6
      result(2, { requestId: 'mcp-2', ok: true }),
      answered(6),
    ],
  },
  {
    note: 'a blank docs tab resolves with its id once it is ready',
    views,
    hosts: tabs({ docs: [3] }),
    calls: [trigger('a/mcp-docs-open-blank', [], true), ready(3), answered(0)],
  },
  {
    note: 'a blank docs tab that is ready before it is asked for resolves at once',
    views,
    hosts: tabs({ docs: [3] }),
    calls: [ready(3), trigger('a/mcp-docs-open-blank', [], false)],
  },
  {
    note: 'sheets: a command goes out when the tab is ready and resolves with the answer',
    views,
    calls: [
      sheetsRun(4, 'read_sheet'), // 0
      ready(4),
      result(4, { requestId: 'mcp-1', ok: true, result: [[1, 2]] }),
      answered(0),
    ],
  },
  {
    note: 'sheets: the path gets .xlsx, an existing file needs overwrite, the save is authorised',
    views,
    files: { 'book.xlsx': 'x' },
    calls: [
      ready(4),
      sheetsRun(4, 'save_sheet', {}, false),
      sheetsRun(4, 'save_sheet', { path: '$DIR/book' }, false),
      sheetsRun(4, 'save_sheet', { path: '$DIR/book.xlsx', overwrite: true }), // 3
      result(4, { requestId: 'mcp-1', ok: true }),
      answered(3),
      sheetsRun(4, 'save_sheet', { path: '$DIR/fresh' }), // 6
      result(4, { requestId: 'mcp-2', ok: false, error: 'disk full' }),
      answered(6),
    ],
  },
  {
    note: 'a blank sheets tab resolves with its id once it is ready; a rejection is the message',
    views,
    hosts: tabs({ sheets: [5] }),
    calls: [trigger('a/mcp-sheets-open-blank', [], true), ready(5), answered(0)],
  },
  {
    note: 'a blank sheets tab that cannot be opened rejects with the reason',
    views,
    hosts: tabs({ sheetsError: 'no workbook folder' }),
    calls: [trigger('a/mcp-sheets-open-blank', [], false)],
  },
  {
    note: 'docs and sheets keep their own request numbers',
    views,
    calls: [
      ready(2),
      ready(4),
      docsRun(2, 'read_document'),
      sheetsRun(4, 'read_sheet'),
      result(4, { requestId: 'mcp-1', ok: true, result: 'sheet' }),
      result(2, { requestId: 'mcp-1', ok: true, result: 'doc' }),
      answered(2),
      answered(3),
    ],
  },
]

/** The stand-ins of the entry's deps: one log line each, answering from `hosts.a.mcp.tabs` */
function controls(cx: LoadContext, docs: DocsBridge, sheets: SheetsBridge) {
  const world = ((cx.case.hosts?.a ?? {}) as { mcp?: { tabs?: Tabs } }).mcp?.tabs ?? {}
  const docTabs = [...(world.docs ?? [])]
  const sheetTabs = [...(world.sheets ?? [])]
  const log = cx.electron.log
  docsControl = docs.createDocsControl({
    openBlankTab: () => {
      log.push(['openBlankDocsTabForMcp'])
      return docTabs.shift() ?? 0
    },
    authorizeSave: (wcId, path) => void log.push(['authorizeMcpDocWrite', wcId, path]),
    abandonBlankTab: (wcId) => void log.push(['abandonBlankTabForMcp', wcId]),
  }) as unknown as Control
  sheetsControl = sheets.createSheetsControl({
    openBlankTab: async () => {
      log.push(['openBlankSheetsTabForMcp'])
      if (world.sheetsError !== undefined) throw new Error(world.sheetsError)
      return sheetTabs.shift() ?? 0
    },
    authorizeSave: (wcId, path) => void log.push(['authorizeMcpSheetWrite', wcId, path]),
    abandonBlankTab: (wcId) => void log.push(['abandonBlankSheetsTabForMcp', wcId]),
  }) as unknown as Control
}

export const group: Group = {
  batch: 'A',
  async load(cx) {
    const docs = await cx.fresh<DocsBridge>('apps/shell/src/main/mcp/docs-bridge.ts')
    const sheets = await cx.fresh<SheetsBridge>('apps/shell/src/main/mcp/sheets-bridge.ts')
    docs.installDocsBridge()
    sheets.installSheetsBridge()
    controls(cx, docs, sheets)
  },
  triggers: {
    'a/mcp-docs-open-blank': () => docsControl!.openBlankTab(),
    'a/mcp-sheets-open-blank': () => sheetsControl!.openBlankTab(),
    'a/mcp-docs-run': (_cx, _view, args) =>
      docsControl!.runCommand(args[0] as number, args[1] as string, args[2]),
    'a/mcp-sheets-run': (_cx, _view, args) =>
      sheetsControl!.runCommand(args[0] as number, args[1] as string, args[2]),
  },
  cases,
  single: {
    'docs:mcp-ready':
      'a send has no answer; the effect is the command it releases and the promise it settles',
    'docs:mcp-result': 'a send has no answer; the effect is the promise it settles',
    'sheets:mcp-ready':
      'a send has no answer; the effect is the command it releases and the promise it settles',
    'sheets:mcp-result': 'a send has no answer; the effect is the promise it settles',
  },
}
