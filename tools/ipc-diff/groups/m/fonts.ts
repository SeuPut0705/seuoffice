/**
 * Group `m/fonts`: the installed-font queries. The handler bodies are copied
 * verbatim from apps/docs/src/main/docs-main.ts:2478-2497
 * (`docs:font-metrics`, `app:font-family-info`, `docs:font-aliases`) and
 * apps/pdf/src/main/pdf-main.ts:1932-1935 (`pdf:list-edit-fonts`). The font
 * queries they call (`familyInfoFor`, `familyVerticalMetrics`,
 * `familyAliases` of @seuoffice/font-metrics, `listEditFonts` of the PDF
 * editor) scan the machine's fonts, so they are faked from the case's
 * `hosts.m` (`familyInfo`, `metrics`, `aliases`, `editFonts`) exactly as the
 * Rust fake of crates/shell-ipc/m/src/probe.rs answers; `familyInfoFor` logs
 * `['familyInfoFor', families]` there too.
 */
import type { Case, Group } from '../../types.ts'

type Hosts = Record<string, unknown>
type Handler = (...args: never[]) => unknown

const docs = [{ view: 1, window: 1, surface: 'Docs' }]
const own = (object: unknown, key: string): unknown =>
  object !== null && typeof object === 'object' && Object.hasOwn(object, key)
    ? (object as Record<string, unknown>)[key]
    : undefined

const info = (families: unknown) => ({ channel: 'app:font-family-info', args: [families] })
const metrics = (family: unknown) => ({ channel: 'docs:font-metrics', args: [family] })
const aliases = (names: unknown) => ({ channel: 'docs:font-aliases', args: [names] })

const HANGUL = [
  ['Malgun Gothic', { ko: '맑은 고딕', hangul: true }],
  ['Noto Sans CJK KR', { hangul: true }],
]
const METRICS = {
  Arial: { unitsPerEm: 2048, hheaAscender: 1854, hheaDescender: -434, typoAscender: null },
  '맑은 고딕': { unitsPerEm: 2048, hheaAscender: 2191, hheaDescender: -537, winAscent: 2191 },
}

const cases: Case[] = [
  {
    note: 'family info: an answer, two surfaces',
    views: [
      { view: 1, window: 1, surface: 'Docs' },
      { view: 2, window: 2, surface: 'Sheets' },
      { view: 3, window: 3, surface: 'Shell' },
      { view: 4, window: 4, surface: 'Slides' },
    ],
    hosts: { m: { familyInfo: HANGUL } },
    calls: [
      info(['Malgun Gothic', 'Arial']),
      { ...info(['Batang']), view: 2 },
      { ...info(['Gulim']), view: 3 },
      { ...info([]), view: 4 },
    ],
  },
  {
    note: 'family info: nothing installed; odd inputs go to the query as they are',
    views: docs,
    calls: [info({ $: 'u' }), info('Arial'), info(null), info([1, 'a', ['b']]), info({ a: 1 })],
  },
  {
    note: 'metrics: known family, unknown family, not a string',
    views: docs,
    hosts: { m: { metrics: METRICS } },
    calls: [
      metrics('Arial'),
      metrics('맑은 고딕'),
      metrics('Wingdings'),
      metrics(12),
      metrics({ $: 'u' }),
      metrics(['Arial']),
      metrics(''),
      metrics('toString'),
    ],
  },
  {
    note: 'aliases: not an array',
    views: docs,
    hosts: { m: { aliases: { Arial: ['Arial MT'] } } },
    calls: [aliases('Arial'), aliases({ $: 'u' }), aliases({ 0: 'Arial' }), aliases(null)],
  },
  {
    note: 'aliases: names with and without answers, skipped entries, duplicates',
    views: docs,
    hosts: {
      m: {
        aliases: {
          'Malgun Gothic': ['맑은 고딕', 'Malgun'],
          Batang: ['바탕'],
          Empty: [],
          Mixed: ['a', 7, null, 'b'],
          '10': ['ten'],
          '2': ['two'],
          ['__proto__']: ['proto'],
          constructor: ['ctor'],
        },
      },
    },
    calls: [
      aliases(['Malgun Gothic', 'Unknown', 'Batang', 'Batang', 'Empty', 'Mixed']),
      aliases(['', 5, null, 'Batang', ['Batang'], { name: 'x' }]),
      aliases(['10', 'Batang', '2', 'Malgun Gothic']),
      aliases(['__proto__', 'constructor', 'Batang']),
    ],
  },
  {
    note: 'aliases: name length is counted in UTF-16 units, the first 512 entries only',
    views: docs,
    hosts: {
      m: {
        aliases: {
          [`${'😀'.repeat(128)}`]: ['at the limit'],
          [`${'😀'.repeat(129)}`]: ['over the limit'],
          [`${'a'.repeat(256)}`]: ['a at the limit'],
          [`${'a'.repeat(257)}`]: ['a over the limit'],
          late: ['past 512'],
          early: ['inside 512'],
        },
      },
    },
    calls: [
      aliases([
        '😀'.repeat(128),
        '😀'.repeat(129),
        'a'.repeat(256),
        'a'.repeat(257),
        ...Array.from({ length: 507 }, (_, i) => `filler${i}`),
        'early',
        'late',
      ]),
      aliases(['late', 'early']),
    ],
  },
  {
    note: 'pdf edit fonts: what the machine has, none',
    views: [{ view: 1, window: 1, surface: 'Pdf' }],
    hosts: { m: { editFonts: ['arial', 'times'] } },
    calls: [{ channel: 'pdf:list-edit-fonts', args: [] }],
  },
  {
    note: 'pdf edit fonts: nothing found, odd entries in the host answer left out',
    views: [{ view: 1, window: 1, surface: 'Pdf' }],
    hosts: { m: { editFonts: ['courier', 5] } },
    calls: [{ channel: 'pdf:list-edit-fonts', args: [] }],
  },
]

export const group: Group = {
  batch: 'M',
  async load(cx) {
    const hosts = ((cx.case.hosts ?? {}).m ?? {}) as Hosts
    const { log } = cx.electron
    const ipcMain = cx.electron.ipcMain as {
      handle(channel: string, fn: Handler): void
      removeHandler(channel: string): void
    }

    // the faked @seuoffice/font-metrics and PDF editor queries
    const familyInfoFor = (families: unknown): unknown => {
      log.push(['familyInfoFor', families])
      return Array.isArray(hosts.familyInfo) ? hosts.familyInfo : []
    }
    const familyVerticalMetrics = (family: string): unknown => own(hosts.metrics, family) ?? null
    const familyAliases = (name: string): string[] => {
      const found = own(hosts.aliases, name)
      return Array.isArray(found) ? found.filter((v): v is string => typeof v === 'string') : []
    }
    const listEditFonts = (): string[] =>
      Array.isArray(hosts.editFonts)
        ? hosts.editFonts.filter((v): v is string => typeof v === 'string')
        : []

    ipcMain.handle('docs:font-metrics', (_event: unknown, family: string) =>
      typeof family === 'string' ? familyVerticalMetrics(family) : null,
    )
    ipcMain.removeHandler('app:font-family-info')
    ipcMain.handle('app:font-family-info', (_event: unknown, families: unknown) =>
      familyInfoFor(families),
    )
    ipcMain.handle('docs:font-aliases', (_event: unknown, names: unknown) => {
      if (!Array.isArray(names)) return {}
      const out: Record<string, readonly string[]> = {}
      for (const raw of names.slice(0, 512)) {
        if (typeof raw !== 'string' || raw.length === 0 || raw.length > 256) continue
        const aliases = familyAliases(raw)
        if (aliases.length) out[raw] = aliases
      }
      return out
    })
    ipcMain.handle('pdf:list-edit-fonts', async (): Promise<string[]> => listEditFonts())
  },
  cases,
}
