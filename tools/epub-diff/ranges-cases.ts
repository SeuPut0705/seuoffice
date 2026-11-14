import {
  applyReplacements,
  composeReplacements,
  mapOffset,
  sortReplacements,
  validateReplacements,
  type RangeReplacement,
} from '../../packages/epub-engine/src/ranges'
import {
  cssDeclaresVerticalWriting,
  isVerticalWritingMode,
} from '../../packages/epub-engine/src/writing-mode'
import { mulberry32 } from '../docx-diff/synthetic'
import type { Input, Spec } from '../fileparse-diff/spec'

// Texts of the range functions cross both ways as UTF-16 code units: a range may split a surrogate pair, and
// serde_json refuses a lone surrogate in JSON text. An offset is a number, or the text Number() reads back where
// JSON has no number for it. sortReplacements answers with the input positions of the objects it returns, so the
// order of equal entries is compared, not hidden behind equal values.
type WireNumber = number | string
interface WireRange {
  start: WireNumber
  end: WireNumber
  text: number[]
}
type Range = readonly [start: number, end: number, text: string]

const HIGH = '\uD83D'
const LOW = '\uDE00'
const ASTRAL = HIGH + LOW
const ODD = [NaN, Infinity, -Infinity, -0, -1, 0.5, 1.5, -0.5, 1e21]

const units = (text: string) => Array.from({ length: text.length }, (_, i) => text.charCodeAt(i))
const fromUnits = (codes: readonly number[]) => String.fromCharCode(...codes)
const wireNumber = (n: number): WireNumber =>
  Object.is(n, -0) ? '-0' : Number.isFinite(n) ? n : String(n)
const readNumber = (value: unknown) => (typeof value === 'number' ? value : Number(value))
const wireRanges = (ranges: readonly Range[]): WireRange[] =>
  ranges.map(([start, end, text]) => ({
    start: wireNumber(start),
    end: wireNumber(end),
    text: units(text),
  }))
const readRanges = (value: unknown): RangeReplacement[] =>
  (value as WireRange[]).map((r) => ({
    start: readNumber(r.start),
    end: readNumber(r.end),
    text: fromUnits(r.text),
  }))
/** A number JSON cannot hold, as outcome.ts writes it. */
const numberOut = (n: number) => (Number.isFinite(n) ? n : { $number: String(n) })

/** One input per distinct args; `readable` is the case before its texts became code units. */
function distinct(
  name: string,
  cases: ReadonlyArray<readonly [readable: unknown, args: Record<string, unknown>]>,
): Input[] {
  const seen = new Set<string>()
  const out: Input[] = []
  for (const [readable, args] of cases) {
    const key = JSON.stringify(args)
    if (seen.has(key)) continue
    seen.add(key)
    const shown =
      JSON.stringify(readable, (_key, x: unknown) =>
        typeof x === 'number' && (!Number.isFinite(x) || Object.is(x, -0)) ? String(x) : x,
      ) ?? String(readable)
    out.push({ label: `${name} ${out.length} ${shown.slice(0, 160)}`, args })
  }
  return out
}

const pick = <T>(random: () => number, items: readonly T[]): T =>
  items[Math.floor(random() * items.length)]!
const ALPHABET = ['a', 'b', 'c', 'é', HIGH, LOW, ASTRAL]
function randomText(random: () => number, max: number): string {
  let text = ''
  for (let n = Math.floor(random() * (max + 1)); n > 0; n--) text += pick(random, ALPHABET)
  return text
}
/** `count` ranges that do not overlap, some empty, some at one offset, in shuffled order. */
function randomRanges(random: () => number, length: number, count: number): Range[] {
  const points = Array.from({ length: 2 * count }, () => Math.floor(random() * (length + 1))).sort(
    (a, b) => a - b,
  )
  const ranges = Array.from({ length: count }, (_, i): Range => [
    points[2 * i]!,
    points[2 * i + 1]!,
    randomText(random, 3),
  ])
  for (let i = ranges.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[ranges[i], ranges[j]] = [ranges[j]!, ranges[i]!]
  }
  return ranges
}
/** A third of the time, one offset of one range made odd: not an integer, negative, past the end. */
function spoiled(random: () => number, ranges: Range[], length: number): Range[] {
  if (ranges.length === 0 || random() >= 1 / 3) return ranges
  const at = Math.floor(random() * ranges.length)
  const odd = random() < 0.6 ? pick(random, ODD) : length + 1 + Math.floor(random() * 3)
  const endSide = random() < 0.5
  return ranges.map((r, i): Range =>
    i !== at ? r : endSide ? [r[0], odd, r[2]] : [odd, r[1], r[2]],
  )
}
const generated = <T>(seed: number, count: number, make: (random: () => number) => T): T[] => {
  const random = mulberry32(seed)
  return Array.from({ length: count }, () => make(random))
}

const SORT_POOL = [0, 1, 1, 2, 3, NaN, Infinity, -Infinity, -1, 0.5, -0]
const SORTS: Range[][] = [
  [],
  [[0, 0, 'a']],
  [
    [3, 3, 'a'],
    [3, 3, 'b'],
    [3, 3, 'c'],
  ],
  [
    [5, 6, 'x'],
    [3, 4, 'y'],
    [1, 2, 'z'],
  ],
  [
    [2, 5, 'a'],
    [2, 2, 'b'],
    [2, 3, 'c'],
    [2, 2, 'd'],
  ],
  [
    [4, 4, 'a'],
    [NaN, 1, 'b'],
    [2, 2, 'c'],
    [NaN, 0, 'd'],
  ],
  [
    [1, 3, 'a'],
    [1, NaN, 'b'],
    [1, 1, 'c'],
  ],
  [
    [Infinity, 1, 'a'],
    [-Infinity, 0, 'b'],
    [Infinity, 0, 'c'],
    [0, Infinity, 'd'],
  ],
  [
    [1.5, 2, 'a'],
    [-1, 0, 'b'],
    [1.25, 1.5, 'c'],
    [-0, 0, 'd'],
    [0, 0, 'e'],
  ],
]
/** Past 63 entries V8 sorts in runs and merges them, galloping where one run keeps winning. */
function bigSorts(): Array<[string, Range[]]> {
  const random = mulberry32(7)
  const out: Array<[string, Range[]]> = []
  for (const n of [64, 65, 100, 200, 333]) {
    out.push([
      `random keys with NaN ${n}`,
      Array.from({ length: n }, (): Range => {
        const start = random() < 0.08 ? NaN : Math.floor(random() * 8)
        return [start, random() < 0.04 ? NaN : start + Math.floor(random() * 3), '']
      }),
    ])
    out.push([
      `random keys ${n}`,
      Array.from({ length: n }, (): Range => {
        const start = Math.floor(random() * 8)
        return [start, start + Math.floor(random() * 3), '']
      }),
    ])
  }
  const interleaved = (nan: boolean) =>
    Array.from({ length: 256 }, (_, i): Range => {
      const j = i % 128
      const start = Math.floor(j / 10) * 20 + (i < 128 ? 0 : 10) + (j % 10)
      return [nan && i % 37 === 5 ? NaN : start, start, '']
    })
  out.push(
    ['interleaved blocks', interleaved(false)],
    ['interleaved blocks with NaN', interleaved(true)],
  )
  out.push(['descending', Array.from({ length: 100 }, (_, i): Range => [100 - i, 100 - i, ''])])
  out.push([
    'descending pairs',
    Array.from({ length: 100 }, (_, i): Range => [Math.floor((100 - i) / 2), 200, '']),
  ])
  const longThenShort = (nan: boolean): Range[] => [
    ...Array.from({ length: 200 }, (_, i): Range => [i * 2, nan && i % 41 === 3 ? NaN : i * 2, '']),
    ...Array.from({ length: 70 }, (_, i): Range => [i * 5 + 1, 0, '']),
  ]
  out.push(
    ['long run then short run', longThenShort(false)],
    ['long run then short run with NaN', longThenShort(true)],
  )
  return out
}

const VALIDATES: Array<[Range[], number]> = [
  [[], 0],
  [[], NaN],
  [[[0, 3, 'x']], 3],
  [[[0, 4, 'x']], 3],
  [[[-1, 0, '']], 5],
  [[[2, 1, '']], 5],
  [[[1.5, 2, '']], 5],
  [[[NaN, 2, '']], 5],
  [[[2, NaN, '']], 5],
  [[[Infinity, Infinity, '']], 5],
  [[[0, -Infinity, '']], 5],
  [
    [
      [0, 1, ''],
      [0, 2, ''],
    ],
    5,
  ],
  [
    [
      [3, 3, 'a'],
      [1, 3, 'b'],
    ],
    5,
  ],
  [
    [
      [1, 5, ''],
      [3, 3, 'a'],
    ],
    5,
  ],
  [
    [
      [2, 2, 'a'],
      [2, 2, 'b'],
    ],
    2,
  ],
  [
    [
      [5, 3, ''],
      [NaN, 9, ''],
    ],
    10,
  ],
  [
    [
      [NaN, 9, ''],
      [5, 3, ''],
    ],
    10,
  ],
  [[[0, 0, '']], NaN],
  [[[0, 3, '']], 2.5],
  [[[0, 2, '']], 2.5],
  [[[0, 0, '']], -1],
  [[[1e21, 1e21, '']], 5],
  [[[123456789012, 123456789013, '']], 5],
  [[[-0, 0, '']], 0],
  [[[1e-7, 1, '']], 5],
  [
    [
      [0, 2, ''],
      [1, 3, ''],
      [5, 9, ''],
    ],
    6,
  ],
  [
    [
      [4, 6, ''],
      [0, 2, ''],
      [2, 4, ''],
    ],
    6,
  ],
  [[[2 ** 53, 2 ** 53 + 2, '']], 1],
  [[[-0, -0, '']], -0],
  [[[0, 0, '']], Infinity],
  [[[3, 7, '']], 2 ** 53],
]

const APPLIES: Array<[string, Range[]]> = [
  [
    'hello world',
    [
      [6, 11, 'there'],
      [0, 0, '['],
      [11, 11, '!'],
      [0, 0, '('],
    ],
  ],
  [
    'ab',
    [
      [1, 1, 'x'],
      [1, 1, 'y'],
    ],
  ],
  [
    'ab',
    [
      [1, 1, 'y'],
      [1, 1, 'x'],
    ],
  ],
  [
    'abc',
    [
      [1, 2, ''],
      [1, 1, 'x'],
      [2, 2, 'y'],
    ],
  ],
  [ASTRAL, [[1, 1, '-']]],
  [ASTRAL, [[0, 1, 'x']]],
  [ASTRAL, [[1, 2, LOW + LOW]]],
  [`${HIGH}a${LOW}`, [[1, 2, '']]],
  [HIGH, [[1, 1, LOW]]],
  [LOW, [[0, 0, HIGH]]],
  [ASTRAL, [[0, 2, '']]],
  [ASTRAL, [[0, 3, '']]],
  ['abc', [[2, 1, '']]],
  ['abc', [[1.5, 2, '']]],
  [
    'abc',
    [
      [0, 2, ''],
      [1, 3, ''],
    ],
  ],
  ['abc', [[NaN, 1, 'q']]],
  ['abc', [[-1, 1, '']]],
  ['', []],
  ['', [[0, 0, 'new']]],
  ['abc', [[0, 3, '']]],
  ['abc', []],
  ['abc', [[-0, 1, 'Z']]],
  [
    'abc',
    [
      [5, 3, ''],
      [NaN, 9, ''],
    ],
  ],
  ['abc', [[1e21, 1e21, '']]],
]

const MAPS: Array<[number, Range[]]> = [
  [5, []],
  [3, [[1, 5, 'x']]],
  [1, [[1, 5, 'x']]],
  [5, [[1, 5, 'x']]],
  [3, [[3, 3, 'ab']]],
  [2, [[3, 3, 'ab']]],
  [
    10,
    [
      [6, 8, ''],
      [0, 0, 'abc'],
      [2, 4, 'z'],
    ],
  ],
  [
    10,
    [
      [2, 4, 'z'],
      [0, 0, 'abc'],
      [6, 8, ''],
    ],
  ],
  [
    1,
    [
      [0.1, 0.3, ''],
      [0.3, 0.7, ''],
      [0.7, 0.8, 'x'],
    ],
  ],
  [
    1,
    [
      [0.7, 0.8, 'x'],
      [0.3, 0.7, ''],
      [0.1, 0.3, ''],
    ],
  ],
  [NaN, [[0, 1, 'x']]],
  [Infinity, [[0, 1, 'xx']]],
  [Infinity, [[0, Infinity, '']]],
  [-3, [[0, 1, 'xx']]],
  [-0, []],
  [-0, [[0, 0, 'a']]],
  [2, [[NaN, 1, 'x']]],
  [2, [[1, NaN, 'x']]],
  [1, [[0, 2, ASTRAL]]],
  [2, [[0, 2, 'x']]],
  [1.5, [[1, 2, '']]],
  [0.5, [[1, 1, 'q']]],
  [
    3,
    [
      [1, 2, 'x'],
      [1, 2, 'y'],
    ],
  ],
  [
    4,
    [
      [0, 2, ''],
      [1, 3, ''],
    ],
  ],
  [-1, [[-2, 0, 'abc']]],
  [1e21, [[0, 5, '']]],
  [
    3,
    [
      [3, 3, 'a'],
      [3, 3, 'bc'],
      [1, 3, ''],
    ],
  ],
]

const COMPOSES: Array<[string, Range[], Range[]]> = [
  ['abc', [], []],
  ['hello world', [[0, 5, 'HELLO']], [[6, 11, 'there']]],
  ['abc', [[0, 1, 'x']], [[0, 1, 'a']]],
  ['abc', [[1, 1, 'XYZ']], [[2, 3, '_']]],
  ['abcdef', [[2, 2, '123']], [[1, 6, '']]],
  [
    'abc',
    [
      [1, 1, 'a'],
      [1, 1, 'b'],
    ],
    [
      [1, 1, 'c'],
      [3, 3, 'd'],
    ],
  ],
  ['aaaa', [[1, 3, 'aXa']], []],
  ['aa', [[0, 2, 'aaa']], []],
  [ASTRAL, [[1, 1, 'x']], []],
  [ASTRAL, [[0, 2, '\u{1F601}']], []],
  [`${HIGH}x${LOW}`, [[1, 2, '']], []],
  [ASTRAL + ASTRAL, [[2, 2, 'q']], [[1, 4, '']]],
  ['abcdef', [[1.5, 3.5, 'Z']], []],
  ['abc', [[-2, 1, 'Q']], []],
  ['abc', [[NaN, 2, 'q']], []],
  ['abc', [[2, 10, '']], []],
  ['abc', [[2, 1, 'x']], []],
  [
    'abc',
    [
      [1, 2, 'a'],
      [1, 3, 'b'],
    ],
    [],
  ],
  ['abc', [], [[Infinity, 1, 'x']]],
  ['abc', [], [[0, -Infinity, 'x']]],
  ['abc', [[0, 3, 'abc']], [[0, 0, '']]],
  ['', [], [[0, 0, 'x']]],
  ['abc', [[0.5, 0.5, 'y']], []],
  ['abc', [], [[-0.5, 1.5, 'w']]],
  ['abcdef', [[1, 1, 'xy']], [[2, 2, 'z']]],
  ['abc', [[3, 3, 'x']], [[3, 4, '']]],
  ['abc', [[1, 2, HIGH]], [[2, 2, LOW]]],
]

const MODES: unknown[] = [
  'vertical-rl',
  'vertical-lr',
  ' Vertical-RL ',
  'VERTICAL-',
  'vertical',
  'horizontal-tb',
  'horizontal-rl',
  '',
  '\u3000vertical-rl',
  '\uFEFFvertical-rl',
  '\u0085vertical-rl',
  '\u2029vertical-lr',
  'vert\u0130cal-rl',
  'vert\u0131cal-rl',
  'x vertical-rl',
  '\nvertical-lr',
  'vertical-\u00e9',
  'sideways-rl',
  null,
  undefined,
  7,
  true,
]
const STYLESHEETS = [
  'html { writing-mode: vertical-rl; }',
  'body{-epub-writing-mode:vertical-rl}',
  '.v { -webkit-writing-mode : vertical-lr !important }',
  'p {\n  WRITING-MODE:\n  vertical-rl;\n}',
  'body { writing-mode: horizontal-tb }',
  '/* writing-mode: vertical-rl */ body { margin: 0 }',
  '.x { my-writing-mode: vertical-rl }',
  'p::before { content: "writing-mode: vertical-rl" }',
  '',
  'writing-mode: vertical-rl',
  'writing-mode:vertical-',
  'a;writing-mode:vertical-lr',
  'xwriting-mode: vertical-rl',
  '-moz-writing-mode: vertical-rl',
  '-webkit-writing-mode: vertical-rl',
  '-WEBKIT-Writing-Mode : VERTICAL-RL',
  '-web\u212Ait-writing-mode: vertical-rl',
  'writing-mode: vert\u0131cal-rl',
  'writing-mode: vert\u0130cal-rl',
  'writing-mode\t:\u3000vertical-rl',
  'writing-mode:\u0085vertical-rl',
  'writing-mode:\uFEFFvertical-rl',
  '\u2028writing-mode: vertical-rl',
  '\u0085writing-mode: vertical-rl',
  '/* writing-mode: vertical-rl',
  '/* x */writing-mode: vertical-rl',
  'a/**/writing-mode:vertical-rl',
  '/*/ writing-mode: vertical-rl */',
  '{writing-mode:/* c */vertical-rl}',
  'writing-mode/**/:vertical-rl',
  '"a\\"writing-mode: vertical-rl"',
  '"writing-mode: vertical-rl',
  ' "x\n writing-mode: vertical-rl',
  '"a\\\nb" writing-mode: vertical-rl',
  "content: 'writing-mode: vertical-rl'",
  "content:'it\\'s'; writing-mode: vertical-lr",
  `"${ASTRAL}" writing-mode: vertical-rl`,
  `'${ASTRAL}\\' writing-mode: vertical-rl`,
  'writing-modes: vertical-rl',
  'writing-mode : vertical',
  '"\\',
  "'a' 'b' writing-mode: vertical-rl",
  '"a"writing-mode: vertical-rl',
  '/**/',
  '*/ writing-mode: vertical-rl',
  // a string past the old regex bound: a base64 font in a stylesheet
  `@font-face { src: url("data:font/woff2;base64,${'A'.repeat(2_000_000)}") }\nbody { writing-mode: vertical-rl }`,
  `@font-face { src: url('data:font/woff2;base64,${'A'.repeat(2_000_000)}') }\nbody { writing-mode: horizontal-tb }`,
  `"${'\\"'.repeat(5)}" writing-mode: vertical-rl`,
  // strings that never close, crossed again from inside: each start is read alone
  `"${'\\"'.repeat(3000)} writing-mode: vertical-rl`,
  `"${'\\"'.repeat(3000)}\n" writing-mode: vertical-rl "`,
  `"${'\\\\"'.repeat(3000)} writing-mode: vertical-rl`,
  `"\\${'\\"'.repeat(3000)}`,
  `'${`\\'"`.repeat(2000)} writing-mode: vertical-rl`,
  `"${`'\\"x`.repeat(2000)}\n'writing-mode: vertical-rl'`,
  `${'"a\\'.repeat(2000)}" writing-mode: vertical-rl`,
  `'a\\'b' writing-mode: vertical-rl`,
  `"/* " writing-mode: vertical-rl /* "`,
  '"abc\\\ndef" writing-mode: vertical-rl',
  "'unterminated writing-mode: vertical-rl",
  '/* never closed "',
  'a "x" /* y */ writing-mode: vertical-rl',
]

export const SPECS: Spec[] = [
  {
    fn: 'sortReplacements',
    extensions: [],
    mutation: 'none',
    call: ({ args = {} }) => {
      const replacements = readRanges(args.replacements)
      return sortReplacements(replacements).map((r) => replacements.indexOf(r))
    },
    built: () =>
      distinct('sort', [
        ...SORTS.map((ranges) => [ranges, { replacements: wireRanges(ranges) }] as const),
        ...bigSorts().map(
          ([name, ranges]) => [name, { replacements: wireRanges(ranges) }] as const,
        ),
        ...generated(11, 200, (random) => {
          const ranges = Array.from({ length: Math.floor(random() * 10) }, (): Range => [
            pick(random, SORT_POOL),
            pick(random, SORT_POOL),
            '',
          ])
          return [ranges, { replacements: wireRanges(ranges) }] as const
        }),
      ]),
  },
  {
    fn: 'validateReplacements',
    extensions: [],
    mutation: 'none',
    call: ({ args = {} }) =>
      validateReplacements(readRanges(args.replacements), readNumber(args.length)),
    built: () =>
      distinct('validate', [
        ...VALIDATES.map(
          ([ranges, length]) =>
            [
              [ranges, length],
              { replacements: wireRanges(ranges), length: wireNumber(length) },
            ] as const,
        ),
        ...generated(12, 200, (random) => {
          const length = Math.floor(random() * 9)
          const ranges = spoiled(
            random,
            randomRanges(random, length, Math.floor(random() * 5)),
            length,
          )
          if (ranges.length > 0 && random() < 0.25)
            ranges.push([Math.floor(random() * length), length, 'o'])
          const given = length + (random() < 0.2 ? Math.floor(random() * 3) - 1 : 0)
          return [
            [ranges, given],
            { replacements: wireRanges(ranges), length: wireNumber(given) },
          ] as const
        }),
      ]),
  },
  {
    fn: 'applyReplacements',
    extensions: [],
    mutation: 'none',
    call: ({ args = {} }) =>
      units(applyReplacements(fromUnits(args.source as number[]), readRanges(args.replacements))),
    built: () =>
      distinct('apply', [
        ...APPLIES.map(
          ([source, ranges]) =>
            [
              [source, ranges],
              { source: units(source), replacements: wireRanges(ranges) },
            ] as const,
        ),
        ...generated(13, 200, (random) => {
          const source = randomText(random, 8)
          const ranges = spoiled(
            random,
            randomRanges(random, source.length, Math.floor(random() * 5)),
            source.length,
          )
          return [
            [source, ranges],
            { source: units(source), replacements: wireRanges(ranges) },
          ] as const
        }),
      ]),
  },
  {
    fn: 'mapOffset',
    extensions: [],
    mutation: 'none',
    call: ({ args = {} }) => {
      const mapped = mapOffset(readNumber(args.offset), readRanges(args.replacements))
      return mapped === null ? null : numberOut(mapped)
    },
    built: () =>
      distinct('map', [
        ...MAPS.map(
          ([offset, ranges]) =>
            [
              [offset, ranges],
              { offset: wireNumber(offset), replacements: wireRanges(ranges) },
            ] as const,
        ),
        ...generated(14, 200, (random) => {
          const length = Math.floor(random() * 9)
          const ranges = spoiled(
            random,
            randomRanges(random, length, Math.floor(random() * 5)),
            length,
          )
          const offset =
            random() < 0.15 ? pick(random, ODD) : Math.floor(random() * (length + 3)) - 1
          return [
            [offset, ranges],
            { offset: wireNumber(offset), replacements: wireRanges(ranges) },
          ] as const
        }),
      ]),
  },
  {
    fn: 'composeReplacements',
    extensions: [],
    mutation: 'none',
    call: ({ args = {} }) =>
      composeReplacements(
        fromUnits(args.base as number[]),
        readRanges(args.first),
        readRanges(args.second),
      ).map((r) => ({ start: numberOut(r.start), end: numberOut(r.end), text: units(r.text) })),
    built: () =>
      distinct('compose', [
        ...COMPOSES.map(
          ([base, first, second]) =>
            [
              [base, first, second],
              { base: units(base), first: wireRanges(first), second: wireRanges(second) },
            ] as const,
        ),
        ...generated(15, 300, (random) => {
          const base = randomText(random, 8)
          const first = randomRanges(random, base.length, Math.floor(random() * 4))
          const middle = first.reduce(
            (n, [start, end, text]) => n + text.length - (end - start),
            base.length,
          )
          const second = spoiled(
            random,
            randomRanges(random, middle, Math.floor(random() * 4)),
            base.length,
          )
          const spoiledFirst = spoiled(random, first, base.length)
          return [
            [base, spoiledFirst, second],
            { base: units(base), first: wireRanges(spoiledFirst), second: wireRanges(second) },
          ] as const
        }),
        ...generated(16, 4, (random) => {
          const base = 'x'.repeat(40)
          const first = Array.from({ length: 70 }, (_, i): Range => {
            const at = Math.floor(random() * 41)
            return [i % 9 === 4 ? NaN : at, at, String.fromCharCode(0x61 + (i % 26))]
          })
          const second = randomRanges(random, 60, 5)
          return [
            [base, first, second],
            { base: units(base), first: wireRanges(first), second: wireRanges(second) },
          ] as const
        }),
      ]),
  },
  {
    fn: 'isVerticalWritingMode',
    extensions: [],
    mutation: 'none',
    call: ({ args = {} }) => isVerticalWritingMode(args.value as string | null | undefined),
    built: () =>
      distinct(
        'mode',
        MODES.map((value) => [value, value === undefined ? {} : { value }] as const),
      ),
  },
  {
    fn: 'cssDeclaresVerticalWriting',
    extensions: [],
    mutation: 'text',
    call: ({ text = '' }) => cssDeclaresVerticalWriting(text),
    built: () => STYLESHEETS.map((text) => ({ label: JSON.stringify(text), text })),
  },
]
