/**
 * Group `m/print-diagram`: the diagram editor's `diagram:print`.
 *
 * The real module is loaded: apps/diagram/src/main/export-main.ts registers the
 * handler (`registerDiagramExportIpc`; it also registers the export channels,
 * which this group does not call). The window is print/host.ts's: its
 * `partition` option makes it the "diagram" profile, `loadURL` logs the
 * address without the random token, and the navigation guard's own calls
 * (`setWindowOpenHandler`, `on`) are Electron's and not logged.
 */
import type { Case, Group } from '../../types.ts'
import { installPrintHosts } from './print/host.ts'

const MODULE = 'apps/diagram/src/main/export-main.ts'
type ExportMain = typeof import('../../../../apps/diagram/src/main/export-main.ts')

const diagram = [{ view: 1, window: 1, surface: 'Diagram' }]
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"><rect/></svg>'
const sheet = { svg, width: 100, height: 50, pageWidth: 827, pageHeight: 1169 }
const print = (...args: unknown[]) => ({ channel: 'diagram:print', args })
const m = (config: Record<string, unknown>) => ({ m: config })
const refused = (reason: string) => m({ print: { success: false, failureReason: reason } })

const cases: Case[] = [
  {
    note: 'the system dialog takes the pages',
    views: diagram,
    calls: [print({ pages: [sheet], title: 'Flow' })],
  },
  {
    note: 'several pages, a title that is no string, none, and a leading blank before the svg',
    views: diagram,
    calls: [
      print({ pages: [sheet, { ...sheet, svg: `  \n${svg}` }], title: 7 }),
      print({ pages: [sheet] }),
      print({ pages: [sheet], title: null }),
      print({ pages: [sheet], title: ['a', 'b'] }),
    ],
  },
  {
    note: 'the document: titles to escape, scripts and event attributes dropped, sizes that fall back or scale',
    views: diagram,
    calls: [
      print({
        title: `<b>"A" & 'B'</b> ${'x'.repeat(300)}`,
        pages: [
          {
            svg: `<svg onload="x()" width="9"><script>bad()</script><g onclick='y()' ONMOUSEOVER = "z()"><script src="u"/></g></svg>`,
            width: 400,
            height: 300,
            pageWidth: 1169,
            pageHeight: 827,
          },
          { ...sheet, width: 0, height: -5, pageWidth: 0, pageHeight: 100001 },
          { ...sheet, width: 100000, height: 12.345, pageWidth: 100000, pageHeight: 1.005 },
          { ...sheet, pageWidth: 595.5, pageHeight: 842.25 },
        ],
      }),
      print({ pages: [sheet], title: '한글 제목' }),
    ],
  },
  {
    note: 'the user closes the dialog (any reason that says cancel, in any case)',
    views: diagram,
    hosts: refused('Print job Cancelled'),
    calls: [print({ pages: [sheet], title: 'x' })],
  },
  {
    note: 'a failure with a reason',
    views: diagram,
    hosts: refused('no printer'),
    calls: [print({ pages: [sheet] })],
  },
  {
    note: 'a failure without a reason',
    views: diagram,
    hosts: refused(''),
    calls: [print({ pages: [sheet] })],
  },
  {
    note: 'the document does not load: the window is destroyed and the error answers',
    views: diagram,
    hosts: m({ loadError: 'ERR_CONNECTION_REFUSED' }),
    calls: [print({ pages: [sheet] })],
  },
  {
    note: 'the readiness probe rejects: printing goes on',
    views: diagram,
    hosts: m({ exec: 'rejected' }),
    calls: [print({ pages: [sheet] })],
  },
  {
    note: 'a probe that never settles is cut off by its timer',
    views: diagram,
    hosts: m({ exec: 'pending' }),
    calls: [print({ pages: [sheet] })],
  },
  {
    note: 'requests that have no pages a sheet can be made of, before any window is made',
    views: diagram,
    calls: [
      print({ $: 'u' }),
      print(null),
      print('pages'),
      print({}),
      print({ pages: [] }),
      print({ pages: 'x' }),
      print({ pages: [{}] }),
      print({ pages: [sheet, { ...sheet, svg: 'x' }] }),
      print({ pages: [{ ...sheet, svg: '<svgx/>' }] }),
      print({ pages: [{ ...sheet, width: '100' }] }),
      print({ pages: [{ ...sheet, pageHeight: null }] }),
      print({ pages: [null] }),
    ],
  },
]

export const group: Group = {
  batch: 'M',
  async load(cx) {
    installPrintHosts(cx)
    const mod = await cx.fresh<ExportMain>(MODULE)
    mod.registerDiagramExportIpc({ filePathOf: () => undefined })
  },
  cases,
}
