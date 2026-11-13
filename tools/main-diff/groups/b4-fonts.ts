/**
 * Group `b4-fonts`: `packages/font-metrics` (family-info, metrics, sfnt) and
 * the rebuild-font finder of `apps/pdf/src/main/text-edit.ts`.
 *
 * The fonts are built here (`font`, `ttc`): a few tables, the name table with
 * the records a case asks for. A fixture font carries a fixed modification
 * time, so the persisted cache of both sides names the same one.
 *
 * - The scenarios (`family-info.familyInfoFor`, `metrics.familyVerticalMetrics`,
 *   `sfnt.familyAliases`) run a list of steps over the font folders of the
 *   case. Each case loads fresh copies of the three modules (they keep their
 *   state in module variables), with `process.platform` set to win32 and HOME
 *   to the case's folder, so the one folder read is
 *   `<home>/AppData/Local/Microsoft/Windows/Fonts`. A step is `{ extra }`
 *   (configureExtraFontDirs), `{ cache }` (configureMetricsCache), `{ info }`,
 *   `{ metrics }`, `{ aliases }`, `{ write }` / `{ rm }` (a file, its folder
 *   made, its time in whole seconds), `{ read }` (a file's text or null) and
 *   `{ restart }` (the modules start over, as a new process).
 * - `text-edit.loadEditFont` / `listEditFonts` run over a copy of the part of
 *   text-edit.ts that holds them, with every font path read from
 *   `<root>/<path with / \ : and spaces written _>`.
 */
import { mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Case, Group } from '../types.ts'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any

const familyInfo = await import('../../../packages/font-metrics/src/family-info.ts')

const scratch = new URL('../out/b4-fonts/', import.meta.url)
let scratchCount = 0
let scratchReady = false

function scratchFile(name: string, source: string): string {
  if (!scratchReady) {
    mkdirSync(fileURLToPath(scratch), { recursive: true })
    process.on('exit', () => rmSync(fileURLToPath(scratch), { recursive: true, force: true }))
    scratchReady = true
  }
  scratchCount += 1
  const path = fileURLToPath(new URL(`${scratchCount}-${name}`, scratch))
  writeFileSync(path, source)
  return pathToFileURL(path).href
}

function must(src: string, from: string, to: string, file: string): string {
  if (!src.includes(from)) throw new Error(`${file}: no ${JSON.stringify(from)} to patch`)
  return src.split(from).join(to)
}

const SRC = new URL('../../../packages/font-metrics/src/', import.meta.url)
const source = (file: string): string => readFileSync(new URL(file, SRC), 'utf8')

/** copies of sfnt, metrics and family-info that share one fresh sfnt */
async function freshModules(): Promise<{ sfnt: J; metrics: J; info: J }> {
  const sfntUrl = scratchFile('sfnt.mts', source('sfnt.ts'))
  const metricsUrl = scratchFile(
    'metrics.mts',
    must(source('metrics.ts'), "from './sfnt'", `from '${sfntUrl}'`, 'metrics.ts'),
  )
  const infoUrl = scratchFile(
    'family-info.mts',
    must(source('family-info.ts'), "from './sfnt'", `from '${sfntUrl}'`, 'family-info.ts'),
  )
  return {
    sfnt: await import(sfntUrl),
    metrics: await import(metricsUrl),
    info: await import(infoUrl),
  }
}

async function withHome<T>(home: string, run: () => Promise<T>): Promise<T> {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')
  const env = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  process.env.HOME = home
  process.env.USERPROFILE = home
  try {
    return await run()
  } finally {
    if (platform) Object.defineProperty(process, 'platform', platform)
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

function writeStep(step: J): void {
  mkdirSync(dirname(step.path), { recursive: true })
  writeFileSync(
    step.path,
    step.hex !== undefined ? Buffer.from(step.hex, 'hex') : (step.text ?? ''),
  )
  if (step.mtimeMs !== undefined) utimesSync(step.path, step.mtimeMs / 1000, step.mtimeMs / 1000)
}

function readStep(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

interface ScenarioSpec {
  home: string
  steps: J[]
}

async function runScenario(spec: ScenarioSpec): Promise<unknown[]> {
  return withHome(spec.home, async () => {
    let mods = await freshModules()
    const results: unknown[] = []
    for (const step of spec.steps) {
      let result: unknown = null
      if ('restart' in step) mods = await freshModules()
      else if ('extra' in step) mods.sfnt.configureExtraFontDirs(step.extra)
      else if ('cache' in step) mods.metrics.configureMetricsCache(step.cache)
      else if ('info' in step) result = await mods.info.familyInfoFor(step.info)
      else if ('metrics' in step) result = mods.metrics.familyVerticalMetrics(step.metrics)
      else if ('aliases' in step) result = mods.sfnt.familyAliases(step.aliases)
      else if ('write' in step) writeStep(step.write)
      else if ('rm' in step) rmSync(step.rm, { force: true })
      else if ('read' in step) result = readStep(step.read)
      results.push(result)
    }
    return results
  })
}

// ---------------------------------------------------------------------------
// fonts
// ---------------------------------------------------------------------------

const be = (...values: number[]): number[] => values.flatMap((v) => [(v >> 8) & 255, v & 255])
const be32 = (v: number): number[] => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]
const hex = (bytes: number[]): string => Buffer.from(bytes).toString('hex')

/** platform, encoding, language, name id, the text (or its bytes) */
type NameRec = [number, number, number, number, string | number[]]
const W = (id: number, text: string, lang = 0x409): NameRec => [3, 1, lang, id, text]

function nameTable(records: NameRec[]): number[] {
  const strings: number[] = []
  const rows: number[] = []
  for (const [platform, encoding, language, nameId, value] of records) {
    const bytes =
      typeof value !== 'string'
        ? value
        : platform === 1
          ? [...Buffer.from(value, 'latin1')]
          : platform === 0 || platform === 3
            ? [...Buffer.from(value, 'utf16le').swap16()]
            : [...Buffer.from(value)]
    rows.push(...be(platform, encoding, language, nameId, bytes.length, strings.length))
    strings.push(...bytes)
  }
  return [...be(0, records.length, 6 + 12 * records.length), ...rows, ...strings]
}

interface Os2 {
  xAvg?: number
  fsSel?: number
  tAsc?: number
  tDesc?: number
  tGap?: number
  wAsc?: number
  wDesc?: number
  cpr?: number
  length?: number
}

function os2Table(o: Os2): number[] {
  const t = Array(96).fill(0) as number[]
  const put16 = (at: number, v = 0): void => void t.splice(at, 2, ...be(v))
  put16(2, o.xAvg)
  put16(62, o.fsSel)
  put16(68, o.tAsc)
  put16(70, o.tDesc)
  put16(72, o.tGap)
  put16(74, o.wAsc)
  put16(76, o.wDesc)
  t.splice(78, 4, ...be32(o.cpr ?? 0))
  return t.slice(0, o.length ?? 96)
}

function sfnt(flavor: number, tables: [string, number[]][], base: number): number[] {
  const dir: number[] = []
  const data: number[] = []
  let offset = base + 12 + 16 * tables.length
  for (const [tag, bytes] of tables) {
    dir.push(...Buffer.from(tag, 'latin1'), ...be32(0), ...be32(offset), ...be32(bytes.length))
    const pad = (4 - (bytes.length % 4)) % 4
    data.push(...bytes, ...Array(pad).fill(0))
    offset += bytes.length + pad
  }
  return [...be32(flavor), ...be(tables.length, 0, 0, 0), ...dir, ...data]
}

interface FontOpts {
  names?: NameRec[] | null
  upem?: number
  hhea?: [number, number, number]
  os2?: Os2 | null
  flavor?: number
  headLen?: number
  hheaLen?: number
  /** the name table ahead of the others, so a cut file loses the last of the rest */
  nameFirst?: boolean
}

function fontBytes(o: FontOpts, base = 0): number[] {
  const tables: [string, number[]][] = []
  const head = [...Array(18).fill(0), ...be(o.upem ?? 1000), ...Array(34).fill(0)] as number[]
  tables.push(['head', head.slice(0, o.headLen ?? 54)])
  const [asc, desc, gap] = o.hhea ?? [900, -200, 50]
  const hhea = [...Array(4).fill(0), ...be(asc, desc, gap), ...Array(26).fill(0)] as number[]
  tables.push(['hhea', hhea.slice(0, o.hheaLen ?? 36)])
  if (o.os2 !== null) tables.push(['OS/2', os2Table(o.os2 ?? {})])
  if (o.names !== null) {
    const name: [string, number[]] = ['name', nameTable(o.names ?? [])]
    if (o.nameFirst) tables.unshift(name)
    else tables.push(name)
  }
  return sfnt(o.flavor ?? 0x10000, tables, base)
}

const font = (o: FontOpts): string => hex(fontBytes(o))

function ttc(faces: FontOpts[]): string {
  const lengths = faces.map((o) => fontBytes(o).length)
  let pos = 12 + 4 * faces.length
  const offsets: number[] = []
  const parts: number[] = []
  faces.forEach((o, i) => {
    offsets.push(pos)
    parts.push(...fontBytes(o, pos))
    pos += lengths[i]!
  })
  return hex([
    ...be32(0x74746366),
    ...be32(0x10000),
    ...be32(faces.length),
    ...offsets.flatMap(be32),
    ...parts,
  ])
}

const MT = 1_700_000_000_000
const FONTS = 'home/AppData/Local/Microsoft/Windows/Fonts'
const HOME = '$DIR/home'
const fx = (name: string, bytes: string, dir = FONTS): Case['files'] => ({
  [`${dir}/${name}`]: { hex: bytes, mtimeMs: MT },
})
const files = (...parts: Case['files'][]): Case['files'] => Object.assign({}, ...parts)

const ALPHA_R = font({
  names: [W(1, 'Alpha Sans'), W(2, 'Regular'), W(6, 'AlphaSans-Regular')],
  hhea: [900, -200, 50],
  os2: { xAvg: 500, fsSel: 0x80, tAsc: 800, tDesc: -250, tGap: 90, wAsc: 950, wDesc: 250 },
})
const ALPHA_B = font({
  names: [W(1, 'Alpha Sans'), W(2, 'Bold'), W(6, 'AlphaSans-Bold')],
  hhea: [910, -210, 40],
  os2: { xAvg: 520, fsSel: 0x20, tAsc: 810, tDesc: -240, tGap: 80, wAsc: 960, wDesc: 260 },
})
const KO = font({
  names: [
    W(1, 'Hangul Gothic'),
    W(1, '한글고딕', 0x412),
    W(16, 'Hangul Gothic'),
    W(16, '한글고딕', 0x412),
    W(2, 'Regular'),
    W(6, 'HangulGothic-Regular'),
  ],
  hhea: [880, -120, 0],
  os2: { cpr: 1 << 19, wAsc: 1000, wDesc: 300 },
})
const KO_BOLD = font({
  names: [
    W(1, 'Hangul Gothic Bold'),
    W(1, '한글고딕 Bold', 0x412),
    W(16, 'Hangul Gothic'),
    W(16, '한글고딕', 0x412),
    W(2, 'Bold'),
    W(6, 'HangulGothic-Bold'),
  ],
  os2: { cpr: 1 << 19 },
})
const JOHAB = font({ names: [W(1, 'Johab Mono'), W(2, 'Regular')], os2: { cpr: (1 << 21) | 0x1 } })
const SERIF = font({
  names: [W(1, 'Plain Serif'), W(2, 'Italic')],
  os2: { cpr: 0x7fffffff & ~((1 << 19) | (1 << 21)) },
})
const KOPUB = font({
  names: [W(1, 'KoPubDotum Bold'), W(1, '코펍돋움 Bold', 0x412), W(2, 'Bold')],
  os2: { cpr: 0 },
})
const A2Z = font({
  names: [W(1, 'A2Z 1 Thin'), W(1, '에이투지 1 얇은', 0x412)],
  os2: { cpr: 0 },
})
const FZ = font({
  names: [W(1, 'FZFangSong-Z02'), W(1, '方正仿宋_GBK', 0x804), W(1, '方正仿宋', 0x411)],
})
const HIRA_W3 = font({
  names: [
    W(1, 'Hiragino Sans GB W3'),
    W(16, 'Hiragino Sans GB'),
    W(16, '冬青黑体简体中文', 0x804),
    [1, 0, 0, 1, 'Hiragino Sans GB'],
    W(2, 'W3'),
  ],
})
const HIRA_W6 = font({
  names: [
    W(1, 'Hiragino Sans GB W6'),
    W(16, 'Hiragino Sans GB'),
    [1, 0, 0, 1, 'Hiragino Sans GB'],
    W(2, 'W6'),
  ],
})
const UNI = font({
  names: [
    [0, 3, 0, 1, 'Uni Family'],
    [0, 3, 5, 1, '유니 로컬'],
    [0, 3, 0x409, 1, 'Uni Alias'],
  ],
})
const COLLECTION = ttc([
  { names: [W(1, 'Coll One'), W(2, 'Regular')], hhea: [700, -300, 10] },
  {
    names: [W(1, 'Coll Two'), W(1, '컬렉션 둘', 0x412), W(2, 'Regular')],
    os2: { cpr: 1 << 19 },
    hhea: [710, -310, 20],
  },
])
const NAMELESS = font({ names: null })
const ZERO_EM = font({ names: [W(1, 'Zero Em')], upem: 0 })
const SHORT_HEAD = font({ names: [W(1, 'Short Head')], headLen: 19 })
const SHORT_HHEA = font({ names: [W(1, 'Short Hhea')], hheaLen: 9 })
const NO_OS2 = font({ names: [W(1, 'No Os2')], os2: null })
const OTTO = font({ names: [W(1, 'Otto Face')], flavor: 0x4f54544f, hhea: [800, -200, 0] })
const TRUE = font({ names: [W(1, 'True Face')], flavor: 0x74727565 })
const ODD_STRING = font({ names: [[3, 1, 0x409, 1, [0, 65, 0]], W(1, 'Odd Sibling')] })
const CUT_OS2 = hex(fontBytes({ names: [W(1, 'Cut Os2')], nameFirst: true }).slice(0, -10))
const NOT_SFNT = font({ names: [W(1, 'Not Sfnt')], flavor: 0x12345678 })

const OS2_LENGTHS = [2, 3, 4, 62, 63, 64, 73, 74, 77, 78, 81, 82].map((length) =>
  font({
    names: [W(1, `Os2 Length ${length}`)],
    os2: {
      xAvg: 321,
      fsSel: 0x80,
      tAsc: 700,
      tDesc: -300,
      tGap: 11,
      wAsc: 900,
      wDesc: 400,
      cpr: 0x00280000,
      length,
    },
  }),
)

const cases = (...lists: unknown[][]): Case[] => lists.map((args): Case => ({ args }))
const info = (...families: unknown[]): J => ({ info: families })
const metricsOf = (family: string): J => ({ metrics: family })
const aliasesOf = (name: string): J => ({ aliases: name })
const scenario = (
  steps: J[],
  note: string,
  fonts?: Case['files'],
  more: Partial<Case> = {},
): Case => ({
  args: [{ home: HOME, steps }],
  ...(fonts ? { files: fonts } : {}),
  note,
  ...more,
})

const MAIN_FONTS = files(
  fx('alpha-regular.ttf', ALPHA_R),
  fx('alpha-bold.ttf', ALPHA_B),
  fx('ko.ttf', KO),
  fx('ko-bold.otf', KO_BOLD),
  fx('johab.TTF', JOHAB),
  fx('serif.ttf', SERIF),
  fx('kopub.ttf', KOPUB),
  fx('a2z.ttf', A2Z),
  fx('fz.ttf', FZ),
  fx('hira-w3.ttf', HIRA_W3),
  fx('hira-w6.ttf', HIRA_W6),
  fx('uni.otf', UNI),
  fx('collection.ttc', COLLECTION),
)
const NOISE = files(
  fx('nameless.ttf', NAMELESS),
  fx('odd.ttf', ODD_STRING),
  fx('not-sfnt.ttf', NOT_SFNT),
  fx('garbage.ttf', hex([...Buffer.from('this is not a font')])),
  fx('tiny.ttf', '0001'),
  fx('empty.ttf', ''),
  fx('readme.txt', hex([...Buffer.from('text')])),
  fx('font.woff', ALPHA_R),
  fx('noext', ALPHA_R),
)

// ---------------------------------------------------------------------------
// family-info: pure functions
// ---------------------------------------------------------------------------

const names = (records: NameRec[]): string => hex(nameTable(records))
const rec = (id: number, name: string, korean = false): J => ({ id, name, korean })

const parseCases: Case[] = [
  ...cases(
    [names([W(1, 'Alpha'), W(16, 'Alpha Typo'), W(1, '알파', 0x412)])],
    [names([[0, 3, 0x412, 1, 'Unicode Ko'], W(16, 'Win')])],
    [names([[1, 0, 0, 1, 'Mac'], [3, 1, 0x409, 2, 'Style'], W(1, 'Kept')])],
    [names([W(1, '')])],
    [names([[3, 1, 0x409, 1, [0, 65, 0]], W(1, 'Odd skipped')])],
    [names([W(6, 'Ps'), W(1, 'Only'), W(17, 'Sub')])],
    [names([W(1, 'Emoji \u{1F600}'), W(1, '\ud55c\uae00', 0x412)])],
  ),
  { args: [''], note: 'an empty table' },
  { args: ['000000000006'], note: 'a header with no records' },
  { args: ['0000000100060003000000010004000a0000'], note: 'a record the table cannot hold' },
  {
    args: [`0000000100060003000000010004ffff0000`],
    note: 'a string past the end of the table',
  },
  { args: ['0000ffff00060003000000010002000000'], note: 'more records than there are bytes' },
]

const hangulCases: Case[] = [
  { args: [null], note: 'no OS/2' },
  { args: [hex(os2Table({ cpr: 1 << 19, length: 81 }))], note: 'a table of 81 bytes' },
  { args: [hex(os2Table({ cpr: 1 << 19, length: 82 }))], note: 'Wansung' },
  { args: [hex(os2Table({ cpr: 1 << 21, length: 82 }))], note: 'Johab' },
  { args: [hex(os2Table({ cpr: (1 << 19) | (1 << 21) }))], note: 'both' },
  { args: [hex(os2Table({ cpr: 1 << 17 }))], note: 'another East Asian page' },
  { args: [hex(os2Table({ cpr: 0 }))], note: 'none' },
  { args: [hex(os2Table({ cpr: 0xffffffff }))], note: 'every bit' },
  { args: [hex(os2Table({ cpr: 0x80000000 }))], note: 'the top bit only' },
]

const faceCases: Case[] = [
  { args: [[rec(1, 'A')], false], note: 'one spelling' },
  { args: [[rec(1, 'A')], true], note: 'hangul declared' },
  { args: [[rec(16, 'A'), rec(16, 'A', true), rec(1, 'A Bold')], false], note: 'a name repeated' },
  {
    args: [
      [
        rec(16, 'A'),
        rec(16, '\ud55c\uae00', true),
        rec(1, 'A Bold'),
        rec(1, '\ud55c\uae00 Bold', true),
      ],
      false,
    ],
    note: 'a Korean name pairs with its own name id only',
  },
  {
    args: [[rec(1, 'A'), rec(1, 'Latin only', true)], false],
    note: 'a Korean record without Hangul is not a Korean name',
  },
  {
    args: [[rec(1, '\ud55c\uae00', true), rec(16, 'B')], false],
    note: 'typographic spellings come first',
  },
  { args: [[], true], note: 'nothing' },
  { args: [[rec(1, 'X', false), rec(1, '\u1100\u1161', true)], false], note: 'a Jamo name' },
  { args: [[rec(1, '\u3131', true)], false], note: 'a Compatibility Jamo name' },
]

const ff = (name: string, ko?: string, hangul = false): J => ({
  name,
  ...(ko ? { ko } : {}),
  hangul,
})

const resolveCases: Case[] = [
  {
    args: [['KoPubDotum'], [ff('KoPubDotum Bold', '\ucf54\ud3fd\ub3cb\uc6c0 Bold', true)]],
    note: 'a style suffix dropped from both names',
  },
  {
    args: [['KoPubDotum'], [ff('KoPubDotum', '\ucf54\ud3fd\ub3cb\uc6c0', true)]],
    note: 'an exact match',
  },
  {
    args: [['kopubdotum'], [ff('KoPubDotum Bold', '\ucf54\ud3fd Bold', true)]],
    note: 'case of the family',
  },
  {
    args: [['A2Z 1'], [ff('A2Z 1 Thin', '\uc5d0\uc774 1 \uc587\uc740', true)]],
    note: 'the Korean name does not end with the suffix',
  },
  {
    args: [
      ['A2Z 1'],
      [
        ff('A2Z 1 Thin', '\uc5d0\uc774 1 Thin', true),
        ff('A2Z 1 Bold', '\ub2e4\ub978 1 Bold', true),
      ],
    ],
    note: 'the first Korean name wins',
  },
  { args: [['Foo'], [ff('Foo Bar', '\ud55c', true)]], note: 'a suffix that is no style' },
  { args: [['Foo'], [ff('Foo Extra Light', '\ud3f0 Extra Light', true)]], note: 'extra light' },
  { args: [['Foo'], [ff('Foo-SemiBold', '\ud3f0-SemiBold', true)]], note: 'a dash' },
  {
    args: [['Foo'], [ff('Foo Ultra  Condensed Italic', '\ud3f0 Ultra  Condensed Italic', true)]],
    note: 'several words',
  },
  {
    args: [['Foo'], [ff('Foo Demi Bold Oblique', '\ud3f0 Demi Bold Oblique', true)]],
    note: 'demi bold oblique',
  },
  { args: [['Foo'], [ff('Foobar Bold', '\ud3f0 Bold', true)]], note: 'not a style suffix of Foo' },
  {
    args: [['Foo'], [ff('Foo Bold', undefined, true)]],
    note: 'Hangul declared without a Korean name',
  },
  { args: [['Foo'], [ff('Foo Bold', undefined, false)]], note: 'nothing Korean' },
  {
    args: [
      ['Foo', 'Bar', 'Baz'],
      [ff('Foo', undefined, false), ff('Bar', '\ubc14', true), ff('Baz', undefined, true)],
    ],
    note: 'the rest are left out',
  },
  {
    args: [['\u{1D49C}\u{1D4B7} Sans'], [ff('\u{1D49C}\u{1D4B7} Sans Bold', '\ud3f0 Bold', true)]],
    note: 'a family with astral letters',
  },
  {
    args: [['\u0130stanbul'], [ff('\u0130stanbul Bold', '\uc774 Bold', true)]],
    note: 'a letter that lower-cases to two',
  },
  {
    args: [['Foo Bold'], [ff('Foo Bold', '\ud3f0 Bold', true)]],
    note: 'a family that already ends with a style',
  },
  {
    args: [['FOO'], [ff('foo regular', '\ud3f0 regular', true)]],
    note: 'the suffix in lower case',
  },
  { args: [['X'], [ff('X Bold', 'X Bold', true)]], note: 'the Korean name is the family itself' },
  { args: [['A B'], [ff('ab', '\ud3f0', true)]], note: 'the match is on the normalized name' },
  { args: [['Foo'], [ff('Foo Hairline', '\ud3f0 Hairline', true)]], note: 'hairline' },
  { args: [['Foo'], [ff('Foo Expanded', '\ud3f0 Expanded', true)]], note: 'expanded' },
  {
    args: [['Foo'], [ff('Foo Bold', ' Bold', true)]],
    note: 'a Korean name that is only the suffix',
  },
  { args: [[], []], note: 'nothing' },
]

// ---------------------------------------------------------------------------
// the scenarios
// ---------------------------------------------------------------------------

const wideFamilies = (n: number, ...tail: string[]): string[] => [
  ...Array.from({ length: n }, (_, i) => `x${i}`),
  ...tail,
]

const infoCases: Case[] = [
  scenario(
    [
      info(
        'Hangul Gothic',
        'Hangul Gothic Bold',
        'Johab Mono',
        'Plain Serif',
        'Alpha Sans',
        'Nothing',
      ),
    ],
    'the Korean name, the Hangul coverage, the rest left out',
    MAIN_FONTS,
  ),
  scenario(
    [info('KoPubDotum', 'kopubdotum', 'A2Z 1', 'Coll One', 'Coll Two', 'Uni Family', 'Uni Alias')],
    'the style suffix of a family the OS grouped; a collection; Unicode names',
    MAIN_FONTS,
  ),
  scenario(
    [
      info('Hangul Gothic'),
      info('Hangul Gothic'),
      { rm: `${HOME}/AppData/Local/Microsoft/Windows/Fonts/ko.ttf` },
      info('Hangul Gothic'),
      { restart: true },
      info('Hangul Gothic'),
    ],
    'scanned once per process: a font removed shows after a restart',
    files(fx('ko.ttf', KO)),
  ),
  scenario(
    [info('Hangul Gothic', 'Plain Serif')],
    'noise files: unreadable, no name table, odd strings',
    files(NOISE, fx('ok.ttf', KO), fx('serif.ttf', SERIF)),
  ),
  scenario(
    [info('Os2 Length 81', 'Os2 Length 82', 'Os2 Length 78', 'Os2 Length 2', 'Os2 Length 62')],
    'OS/2 tables of several lengths: Hangul only from 82 bytes',
    files(...OS2_LENGTHS.map((bytes, i) => fx(`os2-${i}.ttf`, bytes))),
  ),
  scenario(
    [info('No Os2', 'Otto Face', 'True Face', 'Not Sfnt', 'Nameless')],
    'faces without OS/2, other flavors, a flavor that is no sfnt',
    files(
      fx('no-os2.ttf', NO_OS2),
      fx('otto.otf', OTTO),
      fx('true.ttf', TRUE),
      fx('not.ttf', NOT_SFNT),
    ),
  ),
  scenario(
    [info('Hangul Gothic'), { extra: [`${HOME}/extra`] }, info('Hangul Gothic', 'Johab Mono')],
    "naming the app's own folders starts the scan over",
    files(fx('ko.ttf', KO), fx('johab.ttf', JOHAB, 'home/extra')),
  ),
  scenario(
    [
      { extra: [`${HOME}/extra`] },
      info('Johab Mono', 'Deep Face'),
      { extra: [] },
      info('Johab Mono'),
    ],
    'the extra folder is scanned flat; an empty list restores the system folders alone',
    files(
      fx('johab.ttf', JOHAB, 'home/extra'),
      fx('deep.ttf', font({ names: [W(1, 'Deep Face')], os2: { cpr: 1 << 19 } }), 'home/extra/sub'),
    ),
  ),
  scenario(
    [
      info('Hangul Gothic'),
      {
        write: {
          path: `${HOME}/AppData/Local/Microsoft/Windows/Fonts/late.ttf`,
          hex: JOHAB,
          mtimeMs: MT,
        },
      },
      info('Johab Mono'),
      { extra: [] },
      info('Johab Mono'),
    ],
    'a font that arrives after the scan shows only when the scan starts over',
    files(fx('ko.ttf', KO)),
  ),
  scenario(
    [info('Found Deep', 'Lost Deep', 'Mid')],
    'the system folders are scanned two levels down',
    files(
      fx('found.ttf', font({ names: [W(1, 'Found Deep')], os2: { cpr: 1 << 19 } }), `${FONTS}/a/b`),
      fx('lost.ttf', font({ names: [W(1, 'Lost Deep')], os2: { cpr: 1 << 19 } }), `${FONTS}/a/b/c`),
      fx('mid.ttf', font({ names: [W(1, 'Mid')], os2: { cpr: 1 << 19 } }), `${FONTS}/a`),
    ),
  ),
  scenario(
    [info('Upper', 'Lower', 'Mixed')],
    'the extensions are matched without regard to case',
    files(
      fx('a.TTF', font({ names: [W(1, 'Upper')], os2: { cpr: 1 << 19 } })),
      fx('b.OtC', ttc([{ names: [W(1, 'Lower')], os2: { cpr: 1 << 19 } }])),
      fx('c.Otf', font({ names: [W(1, 'Mixed')], os2: { cpr: 1 << 19 } })),
    ),
  ),
  ...[null, 'a string', 5, { families: ['Hangul Gothic'] }, true, []].map((value): Case =>
    scenario(
      [info('Hangul Gothic'), { info: value }],
      `a value that is no array: ${JSON.stringify(value)}`,
      files(fx('ko.ttf', KO)),
    ),
  ),
  scenario(
    [
      {
        info: [
          'Hangul Gothic',
          5,
          null,
          'x'.repeat(257),
          'Hangul Gothic ',
          { a: 1 },
          'Johab Mono',
          ['Plain Serif'],
        ],
      },
    ],
    'only strings of at most 256 count',
    files(fx('ko.ttf', KO), fx('johab.ttf', JOHAB)),
  ),
  scenario(
    [
      { info: [...wideFamilies(4999, 'Hangul Gothic', 'Johab Mono')] },
      { info: [...wideFamilies(5000, 'Hangul Gothic')] },
    ],
    'the first 5,000 families are looked up',
    files(fx('ko.ttf', KO), fx('johab.ttf', JOHAB)),
  ),
  scenario(
    [info('y'.repeat(256), 'y'.repeat(255), 'y'.repeat(257))],
    'a family of exactly 256 code units counts',
    files(
      fx('long.ttf', font({ names: [W(1, 'y'.repeat(256))], os2: { cpr: 1 << 19 } })),
      fx('long2.ttf', font({ names: [W(1, 'y'.repeat(255))], os2: { cpr: 1 << 19 } })),
      fx('long3.ttf', font({ names: [W(1, 'y'.repeat(257))], os2: { cpr: 1 << 19 } })),
    ),
  ),
  scenario(
    [info('\ud55c\uae00\uace0\ub515', 'Hangul Gothic ')],
    'a Korean name asked for as such is not a family of the files',
    files(fx('ko.ttf', KO)),
  ),
]

const FONT_PATH = `${HOME}/AppData/Local/Microsoft/Windows/Fonts`
const CACHE_DIR = `${HOME}/ud/font-metrics`
const CACHE = `${CACHE_DIR}/font-vertical-metrics.json`
const cache = (): J => ({ cache: CACHE_DIR })
const read = (): J => ({ read: CACHE })
const ALPHA_ONLY = files(fx('alpha-regular.ttf', ALPHA_R), fx('alpha-bold.ttf', ALPHA_B))
const ALPHA_SIZE = fontBytes({
  names: [W(1, 'Alpha Sans'), W(2, 'Regular'), W(6, 'AlphaSans-Regular')],
}).length
const entryJson = (m: J, size: number, mtimeMs = MT): string =>
  JSON.stringify({
    alphasans: { path: `${FONT_PATH}/alpha-regular.ttf`, offset: 0, mtimeMs, size, m },
  })
const FULL_M = {
  unitsPerEm: 1000,
  hheaAscender: 1,
  hheaDescender: -2,
  hheaLineGap: 3,
  typoAscender: 4,
  typoDescender: -5,
  typoLineGap: 6,
  winAscent: 7,
  winDescent: 8,
  useTypoMetrics: true,
  xAvgCharWidth: 9,
  codePageRange1: 10,
}
const { codePageRange1: _dropped, ...OLD_M } = FULL_M
const writeText = (path: string, text: string): J => ({ write: { path, text } })

const metricsCases: Case[] = [
  scenario(
    [
      cache(),
      metricsOf('Alpha Sans'),
      metricsOf('alpha-sans'),
      metricsOf('ALPHA_SANS'),
      metricsOf('Missing Family'),
      read(),
    ],
    'the regular-ish face of a family, persisted by path, time and size',
    ALPHA_ONLY,
  ),
  scenario(
    [metricsOf('Alpha Sans'), metricsOf('Nope'), metricsOf(''), metricsOf(' - _ ')],
    'no cache folder: nothing is written',
    ALPHA_ONLY,
  ),
  scenario(
    [cache(), metricsOf('Alpha Sans'), { restart: true }, cache(), metricsOf('Alpha Sans'), read()],
    'a second process answers from the cache file',
    ALPHA_ONLY,
  ),
  scenario(
    [
      cache(),
      metricsOf('Alpha Sans'),
      { write: { path: `${FONT_PATH}/alpha-regular.ttf`, hex: ALPHA_B, mtimeMs: MT + 1000 } },
      { restart: true },
      cache(),
      metricsOf('Alpha Sans'),
      read(),
    ],
    'a font that changed on disk is read again',
    ALPHA_ONLY,
  ),
  scenario(
    [
      cache(),
      metricsOf('Alpha Sans'),
      { rm: `${FONT_PATH}/alpha-regular.ttf` },
      { rm: `${FONT_PATH}/alpha-bold.ttf` },
      { restart: true },
      cache(),
      metricsOf('Alpha Sans'),
      read(),
    ],
    'a family that is no longer installed leaves the cache',
    ALPHA_ONLY,
  ),
  scenario(
    [
      cache(),
      metricsOf('Alpha Sans'),
      { rm: `${FONT_PATH}/alpha-regular.ttf` },
      { rm: `${FONT_PATH}/alpha-bold.ttf` },
      metricsOf('Alpha Sans'),
      read(),
    ],
    'a font that vanishes after the scan is a transient miss: nothing is written',
    ALPHA_ONLY,
  ),
  scenario(
    [
      cache(),
      metricsOf('Late Family'),
      {
        write: {
          path: `${FONT_PATH}/late.ttf`,
          hex: font({ names: [W(1, 'Late Family')] }),
          mtimeMs: MT,
        },
      },
      metricsOf('Late Family'),
      { restart: true },
      cache(),
      metricsOf('Late Family'),
      read(),
    ],
    'a missing family is remembered for the process only',
    ALPHA_ONLY,
  ),
  scenario(
    [
      cache(),
      metricsOf('Johab Mono'),
      { extra: [`${HOME}/extra`] },
      metricsOf('Johab Mono'),
      metricsOf('Alpha Sans'),
      read(),
    ],
    "naming the app's own folders clears the misses and shows its fonts",
    files(fx('alpha.ttf', ALPHA_R), fx('johab.ttf', JOHAB, 'home/extra')),
  ),
  scenario(
    [cache(), { extra: [`${HOME}/extra`] }, metricsOf('Alpha Sans'), read()],
    'the same family in a system and an app folder: the plainest face',
    files(fx('alpha-bold.ttf', ALPHA_B), fx('alpha.ttf', ALPHA_R, 'home/extra')),
  ),
  scenario(
    [
      cache(),
      { extra: [`${HOME}/e1`] },
      metricsOf('Alpha Sans'),
      { extra: [`${HOME}/e2`] },
      metricsOf('Johab Mono'),
      metricsOf('Missing'),
      read(),
    ],
    'naming other folders drops the index built with the first',
    files(fx('alpha.ttf', ALPHA_R, 'home/e1'), fx('johab.ttf', JOHAB, 'home/e2')),
  ),
  scenario(
    [cache(), metricsOf('Cut Os2'), metricsOf('Cut Os2'), read()],
    'a table that cannot be read is a transient failure: nothing is cached',
    files(fx('cut.ttf', CUT_OS2)),
  ),
  scenario(
    [
      cache(),
      metricsOf('Hangul Gothic'),
      metricsOf('Hangul Gothic Bold'),
      metricsOf('\ud55c\uae00\uace0\ub515'),
      metricsOf('Coll One'),
      metricsOf('Coll Two'),
      read(),
    ],
    "names in other languages, a collection's second face at its offset",
    files(fx('ko.ttf', KO), fx('ko-bold.otf', KO_BOLD), fx('collection.ttc', COLLECTION)),
  ),
  scenario(
    [
      cache(),
      ...[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((i) =>
        metricsOf(`Os2 Length ${[2, 3, 4, 62, 63, 64, 73, 74, 77, 78, 81, 82][i]}`),
      ),
      read(),
    ],
    'every length of the OS/2 table shows what it holds',
    files(...OS2_LENGTHS.map((bytes, i) => fx(`os2-${i}.ttf`, bytes))),
  ),
  scenario(
    [
      cache(),
      metricsOf('No Os2'),
      metricsOf('Zero Em'),
      metricsOf('Short Head'),
      metricsOf('Short Hhea'),
      metricsOf('Otto Face'),
      metricsOf('True Face'),
      metricsOf('Not Sfnt'),
      read(),
    ],
    'faces without the tables, a zero em, other flavors',
    files(
      fx('a.ttf', NO_OS2),
      fx('b.ttf', ZERO_EM),
      fx('c.ttf', SHORT_HEAD),
      fx('d.ttf', SHORT_HHEA),
      fx('e.otf', OTTO),
      fx('f.ttf', TRUE),
      fx('g.ttf', NOT_SFNT),
    ),
  ),
  scenario(
    [cache(), metricsOf('Alpha Sans'), read()],
    'a cache file that is not JSON is replaced',
    files(ALPHA_ONLY, {
      'home/ud/font-metrics/font-vertical-metrics.json': { text: 'not json {' },
    }),
  ),
  scenario(
    [cache(), metricsOf('Alpha Sans'), read()],
    'a cache file that holds an array is read as no cache, and written back as an array',
    files(ALPHA_ONLY, { 'home/ud/font-metrics/font-vertical-metrics.json': { text: '[1,2]' } }),
  ),
  scenario(
    [cache(), metricsOf('Alpha Sans'), read()],
    'a cache file that holds null',
    files(ALPHA_ONLY, { 'home/ud/font-metrics/font-vertical-metrics.json': { text: 'null' } }),
  ),
  scenario(
    [writeText(CACHE, entryJson(OLD_M, ALPHA_SIZE)), cache(), metricsOf('Alpha Sans'), read()],
    'a cache entry of the version before codePageRange1 is read again',
    ALPHA_ONLY,
  ),
  scenario(
    [writeText(CACHE, entryJson(FULL_M, ALPHA_SIZE)), cache(), metricsOf('Alpha Sans'), read()],
    'a cache entry with the right path, time and size is believed',
    ALPHA_ONLY,
  ),
  scenario(
    [writeText(CACHE, entryJson(FULL_M, 1)), cache(), metricsOf('Alpha Sans'), read()],
    "a cache entry whose size is not the file's",
    ALPHA_ONLY,
  ),
  scenario(
    [
      writeText(CACHE, entryJson(FULL_M, ALPHA_SIZE, MT + 1)),
      cache(),
      metricsOf('Alpha Sans'),
      read(),
    ],
    "a cache entry whose time is not the file's",
    ALPHA_ONLY,
  ),
  scenario(
    [writeText(CACHE, entryJson(null, ALPHA_SIZE)), cache(), metricsOf('Alpha Sans'), read()],
    'a null entry for a family that is installed now is valid: the answer is null',
    ALPHA_ONLY,
  ),
  scenario(
    [cache(), metricsOf('Alpha Sans'), metricsOf('Gone Family'), read()],
    'a null entry: a family that was not installed is looked for again',
    files(ALPHA_ONLY, {
      'home/ud/font-metrics/font-vertical-metrics.json': {
        text: JSON.stringify({ alphasans: null, gonefamily: null, junk: 'x', other: 5 }),
      },
    }),
  ),
  scenario(
    [cache(), metricsOf('constructor'), read(), metricsOf('Alpha Sans'), read()],
    'the one lower-case name every object has: a miss that still writes the file',
    ALPHA_ONLY,
  ),
  scenario(
    [cache(), metricsOf('Alpha Sans'), metricsOf('123'), metricsOf('9'), read()],
    'numeric names come first in the file, in numeric order',
    files(
      ALPHA_ONLY,
      fx('n1.ttf', font({ names: [W(1, '123')], hhea: [1, 2, 3] })),
      fx('n2.ttf', font({ names: [W(1, '9')], hhea: [4, 5, 6] })),
    ),
  ),
  scenario(
    [
      { cache: `${HOME}/ud/not/yet/there` },
      metricsOf('Alpha Sans'),
      { read: `${HOME}/ud/not/yet/there/font-vertical-metrics.json` },
    ],
    'the cache folder is made, deep',
    ALPHA_ONLY,
  ),
  scenario(
    [
      { cache: `${HOME}/blocked/sub` },
      metricsOf('Alpha Sans'),
      { read: `${HOME}/blocked/sub/font-vertical-metrics.json` },
    ],
    'a cache folder that cannot be made: the answer stands, nothing is written',
    files(ALPHA_ONLY, { 'home/blocked': { text: 'a file where the folder should be' } }),
  ),
  scenario(
    [cache(), metricsOf('Alpha Sans'), cache(), metricsOf('Alpha Sans'), read()],
    'configuring the cache again starts it over',
    ALPHA_ONLY,
  ),
  scenario(
    [
      cache(),
      metricsOf('Uni Family'),
      metricsOf('Uni Alias'),
      metricsOf('\uc720\ub2c8 \ub85c\uceec'),
      read(),
    ],
    'Unicode-platform names',
    files(fx('uni.otf', UNI)),
  ),
]

const aliasCases: Case[] = [
  scenario(
    [
      aliasesOf('FZFangSong-Z02'),
      aliasesOf('\u65b9\u6b63\u4eff\u5b8b_GBK'),
      aliasesOf('\u65b9\u6b63\u4eff\u5b8b'),
      aliasesOf('fzfangsong z02'),
      aliasesOf('Nobody'),
    ],
    'the English spelling first, then the localized ones, from any of them',
    MAIN_FONTS,
  ),
  scenario(
    [
      aliasesOf('Hiragino Sans GB'),
      aliasesOf('\u51ac\u9752\u9ed1\u4f53\u7b80\u4f53\u4e2d\u6587'),
      aliasesOf('Hiragino Sans GB W3'),
      aliasesOf('Hiragino Sans GB W6'),
    ],
    "only the spellings of the same slot: a weight face's own name is no alias",
    files(fx('w3.ttf', HIRA_W3), fx('w6.ttf', HIRA_W6)),
  ),
  scenario(
    [
      aliasesOf('Uni Family'),
      aliasesOf('\uc720\ub2c8 \ub85c\uceec'),
      aliasesOf('Uni Alias'),
      aliasesOf('Hangul Gothic'),
      aliasesOf('\ud55c\uae00\uace0\ub515'),
      aliasesOf('Coll Two'),
      aliasesOf('\ucee8\ub809\uc158 \ub458'),
    ],
    'Unicode names, a family with two name ids, a collection',
    MAIN_FONTS,
  ),
  scenario(
    [aliasesOf(''), aliasesOf('  '), aliasesOf('-_ '), aliasesOf('Alpha Sans')],
    'no name, no alias; a family with one spelling',
    ALPHA_ONLY,
  ),
  scenario(
    [aliasesOf('Same'), aliasesOf('\ub3d9\uc77c')],
    'two faces of one family repeat their spellings once',
    files(
      fx('a.ttf', font({ names: [W(1, 'Same'), W(1, '\ub3d9\uc77c', 0x412)] })),
      fx(
        'b.ttf',
        font({ names: [W(1, 'Same'), W(1, '\ub3d9\uc77c', 0x412), W(1, '\u540c\u3058', 0x411)] }),
      ),
    ),
  ),
  scenario(
    [aliasesOf('Alias One'), { extra: [`${HOME}/extra`] }, aliasesOf('Alias One')],
    "the app's own folders do not count for aliases",
    files(
      fx('a.ttf', font({ names: [W(1, 'Alias One'), W(1, '\ubcc4\uba85', 0x412)] })),
      fx('b.ttf', font({ names: [W(1, 'Extra Only'), W(1, '\uc5d0\uc2a4', 0x412)] }), 'home/extra'),
    ),
  ),
  scenario(
    [aliasesOf('Mac Name'), aliasesOf('Windows Name')],
    'a Macintosh record and a Windows record of one slot number are different slots',
    files(
      fx(
        'a.ttf',
        font({
          names: [[1, 0, 0, 1, 'Mac Name'], W(1, 'Windows Name'), W(1, '\ub85c\uceec', 0x412)],
        }),
      ),
    ),
  ),
]

// ---------------------------------------------------------------------------
// text-edit: loadEditFont, listEditFonts
// ---------------------------------------------------------------------------

const editFontsModule = (): Promise<J> => {
  const src = readFileSync(
    new URL('../../../apps/pdf/src/main/text-edit.ts', import.meta.url),
    'utf8',
  )
  const from = src.indexOf('export type EditFontStyle')
  const to = src.indexOf('/** Can this machine draw')
  if (from < 0 || to < from) throw new Error('text-edit.ts: the edit font section moved')
  const module = [
    "import { readFileSync as realRead } from 'node:fs'",
    'const readFileSync = (p: string): Buffer => (globalThis as any).__b4Map(p)',
    ';(globalThis as any).__b4Real = realRead',
    src.slice(from, to),
    'export { loadEditFont }',
  ].join('\n')
  return import(scratchFile('edit-fonts.mts', module))
}

const editName = (path: string): string => path.replace(/[\\/: ]/g, '_')
const ef = (path: string, bytes: string): Case['files'] => ({
  [`ef/${editName(path)}`]: { hex: bytes, mtimeMs: MT },
})

interface EditSpec {
  root: string
  steps: J[]
}

async function runEditFonts(spec: EditSpec): Promise<unknown[]> {
  const mod = await editFontsModule()
  const g = globalThis as J
  g.__b4Map = (p: string) => g.__b4Real(`${spec.root}/${editName(p)}`)
  try {
    const results: unknown[] = []
    for (const step of spec.steps) {
      let result: unknown = null
      if ('load' in step) {
        const bytes =
          step.load[1] == null
            ? mod.loadEditFont(step.load[0])
            : mod.loadEditFont(step.load[0], step.load[1])
        result = bytes === null ? null : Buffer.from(bytes).toString('hex')
      } else if ('list' in step) result = mod.listEditFonts()
      else if ('write' in step) writeStep(step.write)
      else if ('rm' in step) rmSync(step.rm, { force: true })
      results.push(result)
    }
    return results
  } finally {
    delete g.__b4Map
    delete g.__b4Real
  }
}

const EDIT_ROOT = '$DIR/ef'
const editScenario = (steps: J[], note: string, fonts?: Case['files']): Case => ({
  args: [{ root: EDIT_ROOT, steps }],
  ...(fonts ? { files: fonts } : {}),
  note,
})
const MAC = '/System/Library/Fonts/Supplemental/'
const WIN = 'C:\\Windows\\Fonts\\'
const LIB = '/usr/share/fonts/truetype/liberation/'
const AB = 'ab'
const load = (id: string, style: string | null = null): J => ({ load: [id, style] })

const editCases: Case[] = [
  editScenario(
    [{ list: true }, load('arial'), load('times'), load('courier')],
    'nothing readable',
    {},
  ),
  editScenario(
    [
      load('arial'),
      load('arial', 'bold'),
      load('arial', 'italic'),
      load('arial', 'bolditalic'),
      load('arial', 'regular'),
      { list: true },
    ],
    'one file per style; the first readable path of a list wins',
    files(
      ef(`${MAC}Arial.ttf`, '01'),
      ef(`${WIN}arialbd.ttf`, '02'),
      ef(`${LIB}LiberationSans-Italic.ttf`, '03'),
      ef(`${MAC}Arial Bold Italic.ttf`, '04'),
      ef(`${LIB}LiberationSans-Regular.ttf`, '05'),
    ),
  ),
  editScenario(
    [
      load('times'),
      load('times', 'bold'),
      load('times', 'italic'),
      load('times', 'bolditalic'),
      { list: true },
    ],
    'the Windows path and the Liberation path',
    files(
      ef(`${WIN}times.ttf`, 'aa'),
      ef(`${LIB}LiberationSerif-Bold.ttf`, 'bb'),
      ef(`${LIB}LiberationSerif-Italic.ttf`, 'cc'),
      ef(`${WIN}timesbi.ttf`, 'dd'),
    ),
  ),
  editScenario(
    [
      { list: true },
      load('courier'),
      load('courier', 'bold'),
      load('courier', 'italic'),
      load('courier', 'bolditalic'),
    ],
    'only the bold faces: courier is not listed',
    files(ef(`${LIB}LiberationMono-Bold.ttf`, '11'), ef(`${MAC}Courier New Bold Italic.ttf`, '22')),
  ),
  editScenario(
    [
      load('arial'),
      { write: { path: `${EDIT_ROOT}/${editName(`${MAC}Arial.ttf`)}`, hex: 'ff', mtimeMs: MT } },
      load('arial'),
      { write: { path: `${EDIT_ROOT}/${editName(`${WIN}cour.ttf`)}`, hex: 'ee', mtimeMs: MT } },
      load('courier'),
      { rm: `${EDIT_ROOT}/${editName(`${WIN}cour.ttf`)}` },
      load('courier'),
      { list: true },
    ],
    'a result is cached, a missing one too',
    {},
  ),
  editScenario(
    [
      load('arial'),
      { rm: `${EDIT_ROOT}/${editName(`${MAC}Arial.ttf`)}` },
      load('arial'),
      load('arial', 'bold'),
      { list: true },
    ],
    'a font removed later is still the cached one',
    files(ef(`${MAC}Arial.ttf`, '99')),
  ),
  editScenario(
    [
      load('comic'),
      load(''),
      load('constructor'),
      load('__proto__'),
      load('toString'),
      load('hasOwnProperty'),
      load('Arial'),
      load('arial ', 'bold'),
      { list: true },
    ],
    'ids the table does not own',
    files(ef(`${MAC}Arial.ttf`, '01')),
  ),
  editScenario(
    [load('arial'), load('arial', 'bold'), { list: true }],
    'a folder where a font should be is not readable; the next path is',
    files(
      { [`ef/${editName(`${MAC}Arial.ttf`)}`]: { dir: true } },
      ef(`${LIB}LiberationSans-Regular.ttf`, '07'),
      { [`ef/${editName(`${MAC}Arial Bold.ttf`)}`]: { dir: true } },
    ),
  ),
  editScenario(
    [load('arial'), load('times'), { list: true }],
    'an empty file is a font that is read',
    files(ef(`${MAC}Arial.ttf`, ''), ef(`${LIB}LiberationSerif-Regular.ttf`, 'ab')),
  ),
  editScenario(
    [
      { list: true },
      { list: true },
      load('arial'),
      load('times', 'italic'),
      load('courier', 'bolditalic'),
      load('arial', 'bolditalic'),
    ],
    'every style of every id',
    files(
      ef(`${LIB}LiberationSans-Regular.ttf`, '0a'),
      ef(`${LIB}LiberationSerif-Italic.ttf`, '0b'),
      ef(`${LIB}LiberationMono-BoldItalic.ttf`, '0c'),
      ef(`${LIB}LiberationSans-BoldItalic.ttf`, AB),
    ),
  ),
]

export const group: Group = {
  'family-info.parseFamilyNames': {
    ts: (a) => familyInfo.parseFamilyNames(Buffer.from(a[0] as string, 'hex')),
    cases: parseCases,
  },
  'family-info.declaresHangul': {
    ts: (a) => familyInfo.declaresHangul(a[0] === null ? null : Buffer.from(a[0] as string, 'hex')),
    cases: hangulCases,
  },
  'family-info.faceFamilies': {
    ts: (a) => familyInfo.faceFamilies(a[0] as J, a[1] as boolean),
    cases: faceCases,
  },
  'family-info.resolveFamilyInfo': {
    ts: (a) => familyInfo.resolveFamilyInfo(a[0] as string[], a[1] as J),
    cases: resolveCases,
  },
  'family-info.familyInfoFor': {
    ts: (a) => runScenario(a[0] as ScenarioSpec),
    cases: infoCases,
  },
  'metrics.familyVerticalMetrics': {
    ts: (a) => runScenario(a[0] as ScenarioSpec),
    cases: metricsCases,
  },
  'sfnt.familyAliases': {
    ts: (a) => runScenario(a[0] as ScenarioSpec),
    cases: aliasCases,
  },
  'text-edit.loadEditFont': {
    ts: (a) => runEditFonts(a[0] as EditSpec),
    cases: editCases.slice(0, 5),
  },
  'text-edit.listEditFonts': {
    ts: (a) => runEditFonts(a[0] as EditSpec),
    cases: editCases.slice(5),
  },
}
