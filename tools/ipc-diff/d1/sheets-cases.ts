/** What the sheets groups share: the folder every case starts from, the scripted engine answers and how a case is written. */
import canon from './sheets-canon.json' with { type: 'json' }
import { Bin, UNDEFINED, call, send } from './diagram-cases.ts'
import type { Call, Case, FileSpec, View } from '../types.ts'

export { Bin, UNDEFINED, call, send }

/** the session ids the engine fake hands out: counting up from here, per case */
export const sid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
export const S1 = sid(1)
export const S2 = sid(2)
export const S3 = sid(3)
/** an uuid no session has */
export const NOBODY = '00000000-0000-4000-8000-0000000000ff'
/** the transfer ids a case uses */
export const T1 = '22222222-0000-4000-8000-000000000001'
export const T2 = '22222222-0000-4000-8000-000000000002'
export const T3 = '22222222-0000-4000-8000-000000000003'
/** the clock of every case */
export const CLOCK = 1_700_000_000_000
const MTIME = 1_600_000_000_000

const file = (text: string): FileSpec => ({ text, mtimeMs: MTIME })
const bytes = (hex: string): FileSpec => ({ hex, mtimeMs: MTIME })

export const FILES: Record<string, FileSpec> = {
  'a.xlsx': file('xlsx'),
  'b.xlsx': file('xlsx'),
  'macro.xlsm': file('xlsm'),
  'empty.xlsx': file(''),
  'old.xls': file('xls'),
  'sheet.ods': file('ods'),
  't.csv': file('a,b\n1,2\n'),
  'empty.csv': file(''),
  'tab.tsv': file('a\tb\n'),
  'big.csv': file('x'.repeat(2048)),
  'notes.txt': file('hello attachment text'),
  'long.txt': file('0123456789'.repeat(20)),
  'pic.png': bytes('89504e47'),
  'enc.xlsx': bytes('d0cf11e0a1b11ae100'),
  'enc.xls': bytes('d0cf11e0a1b11ae100'),
  'doc.docx': file('docx'),
  'odd.bin': file('x'),
  'ext.xlsx': file('xlsx'),
  temp: { dir: true },
  userData: { dir: true },
  documents: { dir: true },
}

/** the sheets webview `n` */
export const tab = (n = 1): View => ({ view: n, window: n, surface: 'Sheets' })

/** `hosts.d1.sheets` and the shared dialogs of a case */
export interface Host {
  d1?: Record<string, unknown>
  saves?: (string | null)[]
  opens?: (string[] | null)[]
  messages?: number[]
  osShell?: Record<string, unknown>
}

/** the engine's answers every case starts from (the schemas' own output, sheets-canon.json) */
const ANSWERS = canon as Record<string, unknown>

export function sheetsCase(
  note: string,
  host: Host,
  calls: Call[],
  options: { files?: Record<string, FileSpec>; views?: View[] } = {},
): Case {
  const shared: Record<string, unknown> = {}
  if (host.saves || host.opens || host.messages) {
    shared.dialogs = {
      ...(host.saves ? { save: host.saves } : {}),
      ...(host.opens ? { open: host.opens } : {}),
      ...(host.messages ? { message: host.messages.map((response) => ({ response })) } : {}),
    }
  }
  if (host.osShell) shared.osShell = host.osShell
  return {
    note,
    views: options.views ?? [tab(1)],
    files: options.files ?? FILES,
    hosts: {
      ...(Object.keys(shared).length > 0 ? { shared } : {}),
      d1: { sheets: { ...ANSWERS, clock: CLOCK, ...host.d1 } },
    },
    calls,
  }
}

/** the shell queued these files for the views before the renderer's first call */
export const queued = (...entries: [number, string][]) => ({
  startup: { queued: entries.map(([view, name]) => ({ view, path: `$DIR/${name}` })) },
})

/** `workbook:select` of a queued file */
export const SELECT = call('workbook:select')

/** a save request of a session: the schema's own full form (sheets-canon.json), with what the case changes */
export const saveRequest = (
  session: string,
  mode: string,
  extra: Record<string, unknown> = {},
) => ({
  ...(canon.saveRequest as Record<string, unknown>),
  sessionId: session,
  mode,
  ...extra,
})

/** the schema's full PDF request */
export const pdfRequest = (extra: Record<string, unknown> = {}) => ({
  ...(canon.pdfRequest as Record<string, unknown>),
  ...extra,
})

/** a journaled cell edit */
export const cellEdit = (row: number, value: unknown = 1) => ({
  sheetId: 's1',
  row,
  column: 0,
  writeValue: true,
  value,
})
