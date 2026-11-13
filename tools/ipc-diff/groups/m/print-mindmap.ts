/**
 * Group `m/print-mindmap`: the mindmap editor's `mindmap:print`.
 *
 * The real module is loaded: apps/mindmap/src/main/export-main.ts registers the
 * handler (`registerMindmapExportIpc`, loaded afresh per case so its
 * `registered` guard and request blocker start over). Its export session is
 * a fake partition (a `session` option makes print/host.ts's window the
 * "mindmap-export" profile); its hidden window and temp folder are
 * print/host.ts's.
 */
import type { Case, Group } from '../../types.ts'
import { installPrintHosts } from './print/host.ts'

const MODULE = 'apps/mindmap/src/main/export-main.ts'
type ExportMain = typeof import('../../../../apps/mindmap/src/main/export-main.ts')

const mind = [{ view: 1, window: 1, surface: 'Mindmap' }]
const files = { temp: { dir: true as const } }
const page = '<!doctype html><html><body>map</body></html>'
const print = (...args: unknown[]) => ({ channel: 'mindmap:print', args })
const m = (config: Record<string, unknown>) => ({ m: config })
const refused = (reason: string) => m({ print: { success: false, failureReason: reason } })

const cases: Case[] = [
  {
    note: 'the system dialog takes the page: landscape A4, no margins said to it as well',
    views: mind,
    files,
    calls: [print({ html: page })],
  },
  {
    note: 'the user closes the dialog',
    views: mind,
    files,
    hosts: refused('Print job canceled'),
    calls: [print({ html: page })],
  },
  {
    note: 'only the exact reason is a cancel; one that merely mentions it is a failure',
    views: mind,
    files,
    hosts: refused('canceled by the driver'),
    calls: [print({ html: page })],
  },
  {
    note: 'a failure without a reason',
    views: mind,
    files,
    hosts: refused(''),
    calls: [print({ html: page })],
  },
  {
    note: 'the page does not load',
    views: mind,
    files,
    hosts: m({ loadError: 'ERR_FILE_NOT_FOUND' }),
    calls: [print({ html: page })],
  },
  {
    note: 'the readiness probe rejects: printing goes on',
    views: mind,
    files,
    hosts: m({ exec: 'rejected' }),
    calls: [print({ html: page })],
  },
  {
    note: 'a probe that never settles is cut off by its timer',
    views: mind,
    files,
    hosts: m({ exec: 'pending' }),
    calls: [print({ html: page })],
  },
  {
    note: 'requests that are no map page, before any window is made',
    views: mind,
    files,
    calls: [print({ $: 'u' }), print(null), print('html'), print({}), print({ html: '' }), print({ html: 4 })],
  },
]

export const group: Group = {
  batch: 'M',
  async load(cx) {
    installPrintHosts(cx)
    const mod = await cx.fresh<ExportMain>(MODULE)
    mod.registerMindmapExportIpc({ filePathOf: () => undefined })
  },
  cases,
}
