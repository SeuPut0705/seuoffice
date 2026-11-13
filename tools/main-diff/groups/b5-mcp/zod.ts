/**
 * Group `b5-mcp`, slice `zod` (Rust: crates/main-core/src/calls/b5_mcp/zod.rs
 * over crates/main-core/src/packages/zod.rs).
 *
 * The shell builds tool shapes with the classic `z` of zod 4.6.7; the MCP SDK
 * turns a raw shape into `z4mini.object(shape)` (`objectFromShape`), lists it
 * through `toJsonSchemaCompat` and validates arguments with `safeParseAsync`.
 * Both functions here run exactly those SDK helpers on a shape built from a
 * descriptor.
 *
 * A zod schema in a case is a JSON array `[base, ...modifiers]`:
 *   base: "string" | "number" | "boolean" | "null" | "any" | "unknown"
 *       | ["enum", [values]] | ["array", desc] | ["object", shape]
 *       | ["looseObject", shape] | ["record", keyDesc, valueDesc]
 *       | ["union", [desc, ...]]
 *   modifier: ["optional"] | ["describe", text] | ["int"] | ["min", n] | ["max", n]
 *   shape: [[key, desc], ...]
 * Modifiers apply left to right as zod's chain does; the other slices import
 * `zodOf` and `shapeOf` for their own cases.
 *
 * - zod.toJsonSchema(shape): what the SDK lists as the tool's inputSchema.
 * - zod.safeParse(shape, input): the SDK's validation of the arguments:
 *   `{ success: true, data }` or `{ success: false, issues, message }` with the
 *   message of `getParseErrorMessage`.
 */
import { z } from 'zod'
import {
  getParseErrorMessage,
  normalizeObjectSchema,
  objectFromShape,
  safeParseAsync,
} from '@modelcontextprotocol/sdk/server/zod-compat.js'
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js'
import type { Case, Group } from '../../types.ts'

/** the chain methods a descriptor's modifiers call (a modifier a type lacks throws, as the chain would) */
interface Chain {
  optional: () => z.ZodType
  describe: (text: string) => z.ZodType
  int: () => z.ZodType
  min: (n: number) => z.ZodType
  max: (n: number) => z.ZodType
}

function baseOf(base: unknown): z.ZodType {
  if (typeof base === 'string') {
    switch (base) {
      case 'string':
        return z.string()
      case 'number':
        return z.number()
      case 'boolean':
        return z.boolean()
      case 'null':
        return z.null()
      case 'any':
        return z.any()
      case 'unknown':
        return z.unknown()
    }
    throw new Error(`unknown zod base ${base}`)
  }
  const [kind, a, b] = base as [string, unknown, unknown]
  switch (kind) {
    case 'enum':
      return z.enum(a as [string, ...string[]])
    case 'array':
      return z.array(zodOf(a))
    case 'object':
      return z.object(shapeOf(a))
    case 'looseObject':
      return z.looseObject(shapeOf(a))
    case 'record':
      return z.record(zodOf(a) as z.ZodString, zodOf(b))
    case 'union':
      return z.union((a as unknown[]).map(zodOf) as [z.ZodType, z.ZodType])
  }
  throw new Error(`unknown zod base ${kind}`)
}

/** the schema a descriptor `[base, ...modifiers]` names */
export function zodOf(desc: unknown): z.ZodType {
  const [base, ...modifiers] = desc as [unknown, ...unknown[]]
  let schema = baseOf(base)
  for (const modifier of modifiers) {
    const [name, arg] = modifier as [keyof Chain, never]
    schema = (schema as unknown as Chain)[name](arg)
  }
  return schema
}

/** the raw shape a descriptor `[[key, desc], ...]` names, its keys in that order */
export function shapeOf(shape: unknown): z.ZodRawShape {
  const out: Record<string, z.ZodType> = {}
  for (const [key, desc] of shape as [string, unknown][]) out[key] = zodOf(desc)
  return out
}

/** how `McpServer` lists a raw shape: `getZodSchemaObject`, then the tools/list handler */
function listedSchema(shape: z.ZodRawShape): unknown {
  const obj = normalizeObjectSchema(objectFromShape(shape))
  return toJsonSchemaCompat(obj!, { strictUnions: true, pipeStrategy: 'input' })
}

async function safeParse(shape: z.ZodRawShape, input: unknown): Promise<unknown> {
  const result = await safeParseAsync(objectFromShape(shape), input)
  if (result.success) return { success: true, data: result.data }
  const issues = (result.error as z.ZodError).issues.map((i) => ({
    message: i.message,
    path: i.path,
  }))
  return { success: false, issues, message: getParseErrorMessage(result.error) }
}

// ---------------------------------------------------------------------------
// descriptors
// ---------------------------------------------------------------------------

type D = unknown[]
const S: D = ['string']
const N: D = ['number']
const B: D = ['boolean']
const NUL: D = ['null']
const ANY: D = ['any']
const UNK: D = ['unknown']
const OPT: D = ['optional']
const text = (t: string): D => ['describe', t]
const int: D = ['int']
const min = (n: number): D => ['min', n]
const max = (n: number): D => ['max', n]
const en = (values: string[], ...mods: D[]): D => [['enum', values], ...mods]
const arr = (item: D, ...mods: D[]): D => [['array', item], ...mods]
const un = (options: D[], ...mods: D[]): D => [['union', options], ...mods]
const rec = (key: D, value: D, ...mods: D[]): D => [['record', key, value], ...mods]
const obj = (shape: unknown, ...mods: D[]): D => [['object', shape], ...mods]
const loose = (shape: unknown, ...mods: D[]): D => [['looseObject', shape], ...mods]
/** a descriptor plus modifiers */
const mod = (base: D, ...mods: D[]): D => [...base, ...mods]
/** a one-key shape `{ a: desc }` */
const a = (desc: D): unknown => [['a', desc]]

// ---------------------------------------------------------------------------
// zod.toJsonSchema
// ---------------------------------------------------------------------------

/** every schema once as the value of the key `k` */
const SCHEMAS: D[] = [
  S,
  N,
  B,
  NUL,
  ANY,
  UNK,
  // modifier order: `describe().optional()` and `optional().describe()` list differently
  mod(S, OPT),
  mod(S, text('x')),
  mod(S, text('x'), OPT),
  mod(S, OPT, text('x')),
  mod(S, text('first'), text('second')),
  mod(ANY, text('x')),
  mod(ANY, OPT),
  mod(ANY, OPT, text('x')),
  mod(UNK, text('x')),
  mod(UNK, OPT),
  mod(NUL, text('n')),
  mod(B, OPT),
  mod(B, text('b'), OPT),
  // enums: repeated values drop, integer-like ones come first
  en(['a', 'b']),
  en(['b', '1', 'a', 'b'], text('e')),
  en([]),
  en(['a']),
  en(['a', 'b'], OPT),
  en(['a', 'b'], OPT, text('e')),
  en(['10', '9', 'x'], text('numbers first')),
  // numbers: int widens to the safe range, min and max narrow it
  mod(N, int),
  mod(N, min(0)),
  mod(N, max(9)),
  mod(N, int, min(1)),
  mod(N, min(1), int),
  mod(N, int, max(50)),
  mod(N, min(1), max(5)),
  mod(N, max(5), min(1), text('n')),
  mod(N, min(0.5), max(2.5)),
  mod(N, min(3), min(1)),
  mod(N, max(3), max(9)),
  mod(N, min(-7), max(-2.5)),
  mod(N, int, min(0), OPT, text('o')),
  mod(N, int, OPT),
  mod(N, int, text('i'), min(2)),
  mod(N, min(1e21)),
  // arrays
  arr(S),
  arr(S, min(1)),
  arr(S, max(3)),
  arr(S, min(1), max(3)),
  arr(S, max(3), min(1)),
  arr(S, text('a'), max(3)),
  arr(S, max(3), text('a'), OPT),
  arr(S, min(1), max(3), OPT, text('z')),
  arr(S, OPT),
  arr(mod(N, int, min(1))),
  arr(arr(ANY)),
  arr(arr(un([S, N, B, NUL]))),
  arr(ANY, text('array of op objects'), max(50)),
  arr(UNK, min(0)),
  // unions: bare types fold into `type`, anything else stays in `anyOf`
  un([S, N]),
  un([S, N, B, NUL]),
  un([S, N], text('u')),
  un([S, N], OPT, text('u')),
  un([S, N], text('u'), OPT),
  un([S, N], text('u'), OPT, text('v')),
  un([S, mod(N, int)]),
  un([S, mod(S, text('d'))]),
  un([S, ANY]),
  un([S, UNK]),
  un([S]),
  un([]),
  un([mod(S, OPT), N]),
  un([un([S, N]), NUL]),
  un([un([S, N]), B]),
  un([arr(S), S]),
  un([un([S, N], text('q')), B]),
  un([S, S, N, N]),
  un([en(['a']), N]),
  un([obj([['x', S]]), S]),
  // records
  rec(S, UNK),
  rec(S, S, text('r')),
  rec(S, mod(N, int), OPT),
  rec(S, mod(S, OPT)),
  rec(S, arr(S)),
  rec(en(['a', 'b']), S),
  rec(en(['a', 'b']), mod(S, OPT)),
  rec(en(['a', 'b'], OPT), S),
  rec(en([]), S),
  rec(N, S),
  rec(mod(N, int), S),
  rec(mod(N, min(5), text('k')), S),
  rec(un([S, N]), S),
  rec(un([N, mod(N, int)]), S),
  rec(un([en(['p']), en(['q'])]), S),
  rec(mod(S, text('key')), S),
  rec(S, rec(S, N)),
  // objects
  obj([]),
  obj([['a', S]]),
  obj([
    ['a', S],
    ['b', mod(N, OPT)],
  ]),
  obj([['a', S]], OPT),
  obj([['a', S]], text('obj')),
  obj([['a', S]], OPT, text('obj')),
  obj([['a', mod(S, OPT)]]),
  obj([['a', obj([['b', NUL]])]]),
  obj([['a', UNK]]),
  loose([]),
  loose([['a', S]]),
  loose([['a', mod(ANY, OPT)]], text('lo')),
  loose([['a', loose([['b', B]])]], OPT),
]

/** whole shapes: key order, `required`, descriptions, what the shell's tools declare */
const SHAPES: unknown[] = [
  [],
  [
    ['a', S],
    ['b', mod(N, OPT)],
    ['1', B],
    ['c', mod(S, text('cc'))],
  ],
  [
    ['b', S],
    ['a', S],
    ['b', N],
  ],
  [
    ['x', mod(ANY, OPT)],
    ['y', mod(UNK, text('y'))],
    ['z', mod(S, OPT)],
  ],
  [
    ['2', S],
    ['10', S],
    ['1', S],
    ['a', S],
  ],
  [['offset', mod(N, int, min(0), OPT, text('character to start from; default 0'))]],
  [
    ['startBlockIndex', mod(N, int, text('first block index to replace (inclusive)'))],
    ['endBlockIndex', mod(N, int, text('last block index to replace (inclusive)'))],
    ['ops', arr(ANY, text('array of op objects'))],
  ],
  [['ops', arr(ANY, text('array of op objects (at most 50 per transaction)'), max(50))]],
  [
    ['rows', arr(arr(un([S, N, B, NUL])), text('rows of cells'))],
    ['columns', mod(arr(mod(N, int, min(1))), OPT)],
  ],
  [['ops', arr(loose([['op', S]]), min(1), text('The ops, applied in order.'))]],
  [
    ['properties', mod(rec(S, UNK), OPT, text('properties to set'))],
    ['mode', mod(en(['replace', 'append']), OPT)],
  ],
  [
    ['index', un([N, S], text('a block index or a name'))],
    ['count', mod(N, OPT)],
  ],
]

const toJsonSchemaCases: Case[] = [
  ...SHAPES.map((shape): Case => ({ args: [shape] })),
  ...SCHEMAS.map((desc): Case => ({ args: [[['k', desc]]] })),
]

// ---------------------------------------------------------------------------
// zod.safeParse
// ---------------------------------------------------------------------------

const over = (shape: unknown, ...inputs: unknown[]): Case[] =>
  inputs.map((input): Case => ({ args: [shape, input] }))

const withProto = JSON.parse('{"__proto__":1,"b":"x","c":2}') as unknown

const safeParseCases: Case[] = [
  // strings and what is not one
  ...over(a(S), { a: 'x' }, { a: '' }, { a: 'é😀' }, {}, { a: 1 }, { a: null }, { a: [1] }),
  ...over(a(S), { a: {} }, { a: true }, { a: 'x', b: 1 }, { b: 'x' }),
  // the arguments are not an object
  ...over(a(S), null, 'str', [1], 3, true, []),
  ...over(
    [
      ['a', S],
      ['b', N],
    ],
    { b: 1, a: 'z' },
    {},
    { a: 'z' },
    { a: 1, b: 'q' },
    { c: 1, b: 2, a: 'x', d: 3 },
  ),
  // optional keys
  ...over(a(mod(S, OPT)), {}, { a: 'x' }, { a: 2 }, { a: null }),
  ...over(a(mod(S, text('d'), OPT)), {}, { a: 'x' }, { a: false }),
  ...over(a(mod(S, OPT, text('d'))), {}, { a: 'x' }, { a: false }),
  // any and unknown: required, and nothing is refused once present
  ...over(a(ANY), {}, { a: null }, { a: 0 }, { a: { x: [1, 2] } }),
  ...over(a(UNK), {}, { a: null }, { a: 'x' }, { a: [] }),
  ...over(a(mod(ANY, OPT)), {}, { a: 1 }),
  ...over(a(mod(UNK, OPT)), {}, { a: null }),
  // numbers
  ...over(a(N), { a: 1.5 }, { a: 0 }, { a: -1e300 }, { a: '1' }, { a: null }, { a: true }, {}),
  ...over(a(mod(N, int)), { a: 3 }, { a: -5 }, { a: 1.5 }, { a: 0.1 }, { a: '3' }),
  ...over(
    a(mod(N, int)),
    { a: 9007199254740991 },
    { a: -9007199254740991 },
    { a: 9007199254740992 },
    { a: 1e20 },
    { a: -1e20 },
    { a: 1e300 },
  ),
  ...over(a(mod(N, int, min(1))), { a: 0 }, { a: 1 }, { a: 0.5 }, { a: 2 }, { a: -3 }),
  ...over(a(mod(N, int, min(0), max(9))), { a: -1e20 }, { a: 10 }, { a: 9 }, { a: 0 }, { a: 1e20 }),
  ...over(a(mod(N, int, max(50))), { a: 1e20 }, { a: 50 }, { a: 51 }),
  ...over(
    a(mod(N, min(1), max(5))),
    { a: 0 },
    { a: 1 },
    { a: 5 },
    { a: 6 },
    { a: '3' },
    { a: 2.5 },
  ),
  ...over(a(mod(N, min(0.5))), { a: 0.25 }, { a: 0.5 }),
  ...over(a(mod(N, max(-2.5))), { a: 0 }, { a: -2.5 }, { a: -3 }),
  ...over(a(mod(N, min(3), min(1))), { a: 2 }, { a: 3 }),
  ...over(a(mod(N, max(3), max(9))), { a: 4 }, { a: 3 }),
  ...over(a(mod(N, min(1e21))), { a: 5 }),
  ...over(a(mod(N, int, OPT)), {}, { a: 1.5 }, { a: 4 }),
  // booleans, null, enums
  ...over(a(B), { a: false }, { a: true }, { a: 'false' }, { a: 0 }),
  ...over(a(NUL), { a: null }, { a: 0 }, { a: 'null' }, {}),
  ...over(a(en(['x', 'y'])), { a: 'x' }, { a: 'z' }, {}, { a: 1 }, { a: null }),
  ...over(a(en(['x'])), { a: 'x' }, { a: 'q' }),
  ...over(a(en([])), { a: 'q' }, {}),
  ...over(a(en(['x', 'y'], OPT)), {}, { a: 'y' }, { a: 'n' }),
  ...over(a(en(['b', '1', 'a', 'b'])), { a: '1' }, { a: 'c' }),
  // arrays
  ...over(
    a(arr(S)),
    { a: ['x', 'y'] },
    { a: [] },
    { a: 'x' },
    { a: ['x', 1, null] },
    {},
    { a: {} },
  ),
  ...over(
    a(arr(S, min(2))),
    { a: ['x'] },
    { a: [] },
    { a: [1] },
    { a: ['x', 'y'] },
    { a: ['x', 'y', 'z'] },
  ),
  ...over(
    a(arr(S, max(2))),
    { a: ['x', 'y', 'z'] },
    { a: [1, 2, 3] },
    { a: [1, 2] },
    { a: ['x', 'y'] },
    { a: [] },
  ),
  ...over(
    a(arr(S, min(1), max(2))),
    { a: [] },
    { a: ['a', 'b', 'c'] },
    { a: ['a'] },
    { a: [1, 2, 3, 4] },
  ),
  ...over(a(arr(S, min(3), max(2))), { a: ['a'] }, { a: ['a', 'b', 'c', 'd'] }, { a: ['a', 'b'] }),
  ...over(a(arr(S, max(0))), { a: [] }, { a: ['x'] }),
  ...over(a(arr(S, max(2.5))), { a: ['a', 'b', 'c'] }, { a: ['a', 'b'] }),
  ...over(
    a(arr(S, max(50), text('ops'))),
    { a: Array.from({ length: 51 }, () => 0) },
    { a: Array.from({ length: 50 }, () => 's') },
  ),
  ...over(
    a(arr(mod(N, int, min(1)), min(2))),
    { a: [0] },
    { a: [0.5] },
    { a: [1e20] },
    { a: [1, 2] },
    { a: ['x'] },
  ),
  ...over(a(arr(mod(N, int, max(5)), min(2))), { a: [7] }, { a: [7, 8] }),
  ...over(a(arr(mod(N, min(1)), max(2))), { a: [0, 0, 0] }, { a: [0, 0] }),
  ...over(a(arr(mod(N, int, min(1)), max(1))), { a: [0, 1] }, { a: ['x', 1] }),
  ...over(a(arr(arr(N))), { a: [[1], [2, 'x']] }, { a: [[1], [2]] }, { a: [[], 1] }),
  ...over(a(arr(S, OPT)), {}, { a: ['q'] }, { a: 'q' }),
  ...over(a(arr(ANY)), { a: [1, 'x', null, {}] }),
  // unions
  ...over(a(un([S, N])), { a: 'x' }, { a: 2 }, { a: true }, {}, { a: null }, { a: [] }),
  ...over(a(un([mod(N, min(5)), S])), { a: 3 }, { a: 7 }, { a: 'x' }, { a: true }),
  ...over(a(un([mod(N, min(5)), mod(N, max(1))])), { a: 3 }, { a: 'z' }, { a: 6 }, { a: 0 }),
  ...over(a(un([S, N, B, NUL])), { a: [] }, { a: null }, { a: false }, { a: {} }),
  ...over(a(un([S])), { a: 1 }, { a: 's' }),
  ...over(a(un([])), { a: 1 }, {}),
  ...over(a(un([S, N], OPT)), {}, { a: 'x' }, { a: false }),
  ...over(a(un([mod(S, OPT), N])), {}, { a: true }, { a: 1 }),
  ...over(a(un([arr(S), S])), { a: [1] }, { a: ['x'] }, { a: 'x' }),
  ...over(a(un([obj([['x', S]]), S])), { a: { x: 1 } }, { a: { x: 'q' } }, { a: 'x' }, { a: {} }),
  ...over(
    a(un([obj([['x', S]]), obj([['y', N]])])),
    { a: { x: 1 } },
    { a: { x: 'q' } },
    { a: { y: 2 } },
    { a: {} },
  ),
  ...over(a(arr(un([S, N]))), { a: [true, 'x', 1, null] }, { a: ['x', 2] }),
  ...over(a(arr(un([mod(N, min(5)), S]))), { a: [1, 'x'] }, { a: [9, 'x'] }),
  ...over(a(un([mod(N, int), S])), { a: 1.5 }, { a: 2 }),
  ...over(a(un([mod(N, int, min(5)), S])), { a: 1.5 }, { a: 3 }),
  ...over(a(un([en(['p', 'q']), N])), { a: 'p' }, { a: 'z' }, { a: 4 }),
  // records
  ...over(
    a(rec(S, N)),
    { a: { x: 1, y: 2 } },
    { a: { x: 1, y: 'q' } },
    { a: [1] },
    { a: null },
    { a: {} },
    { a: 'x' },
    {},
  ),
  ...over(a(rec(S, UNK)), { a: { '2': 1, b: 2, '1': 3 } }, { a: { x: { y: [1] } } }),
  ...over(a(rec(S, mod(N, int))), { a: { x: 1.5, y: 2 } }, { a: { x: 1, y: 2 } }),
  ...over(a(rec(S, N)), { a: JSON.parse('{"__proto__":3,"b":1}') }),
  ...over(a(mod(rec(S, arr(S)), OPT)), {}, { a: { k: [1] } }, { a: { k: ['v'] } }),
  ...over(
    a(rec(en(['p', 'q']), N)),
    { a: { p: 1, q: 2 } },
    { a: { q: 2, p: 1 } },
    { a: { p: 1 } },
    { a: {} },
  ),
  ...over(
    a(rec(en(['p', 'q']), N)),
    { a: { p: 1, q: 2, r: 3 } },
    { a: { p: 1, q: 2, r: 3, s: 4 } },
    { a: { p: 'x', q: 2 } },
  ),
  ...over(a(rec(en(['p', 'q']), mod(N, OPT))), { a: { p: 1 } }, { a: {} }, { a: { z: 1 } }),
  ...over(
    a(rec(N, S)),
    { a: { '1': 'x', '2.5': 'y' } },
    { a: { '1': 'x', k: 'y' } },
    { a: { '01': 'x' } },
    { a: { '-3': 'x' } },
    { a: { '1e3': 'x' } },
  ),
  ...over(a(rec(mod(N, int), S)), { a: { '1.5': 'x' } }, { a: { '15': 'x' } }, { a: { '': 'x' } }),
  ...over(a(rec(mod(S, text('key')), N)), { a: { x: 1 } }, { a: { x: 'y' } }),
  ...over(a(rec(un([S, N]), N)), { a: { x: 1 } }),
  ...over(a(rec(S, rec(S, N))), { a: { x: { y: 1 } } }, { a: { x: { y: 'z' } } }, { a: { x: 1 } }),
  // objects
  ...over(
    a(obj([['b', S]])),
    { a: { b: 'x', c: 1 } },
    { a: {} },
    { a: 'x' },
    { a: [] },
    { a: null },
    { a: { b: 1 } },
  ),
  ...over(a(obj([])), { a: {} }, { a: { z: 1 } }, { a: [] }),
  ...over(a(mod(obj([['b', S]]), OPT)), {}, { a: { b: 'x' } }, { a: { b: 2 } }),
  ...over(
    a(loose([['b', S]])),
    { a: { b: 'x', c: 1, '0': 2 } },
    { a: { c: 1 } },
    { a: { b: 'x' } },
    { a: { '7': 1, '3': 2, z: 0, b: 'x', y: 9 } },
  ),
  ...over(a(loose([])), { a: { z: { q: 1 } } }, { a: {} }, { a: 5 }),
  ...over(
    a(loose([['b', S]])),
    { a: withProto },
    { a: JSON.parse('{"__proto__":{"x":1},"b":"y"}') },
  ),
  ...over(
    a(obj([['b', arr(obj([['c', N]]))]])),
    { a: { b: [{ c: 1 }, { c: 'x' }, {}] } },
    { a: { b: [{ c: 1 }] } },
    { a: { b: {} } },
  ),
  ...over(a(obj([['b', obj([['c', obj([['d', mod(N, int)]])]])]])), {
    a: { b: { c: { d: 1.5 } } },
  }),
  // keys: order and integer-like names
  ...over(
    [
      ['1', S],
      ['a', S],
    ],
    { a: 'x', '1': 'y' },
    { '1': 'y' },
    {},
  ),
  ...over(
    [
      ['b', S],
      ['10', S],
      ['2', S],
      ['a', S],
    ],
    { a: '1', '2': '2', '10': '10', b: '0', extra: 1 },
    {},
  ),
  ...over(
    [
      ['a', S],
      ['a', N],
    ],
    { a: 1 },
    { a: 'x' },
  ),
  ...over(JSON.parse('[["a", ["string"]]]'), JSON.parse('{"__proto__":1,"a":"x"}')),
  // empty and several failures at once
  ...over([], {}, { q: 1 }, null, []),
  ...over(
    [
      ['a', S],
      ['b', N],
      ['c', B],
    ],
    {},
    { a: 1, b: 'x', c: 'y' },
    { a: 's', b: 2, c: true },
  ),
  ...over(
    [
      ['a', mod(S, text('d'))],
      ['b', arr(mod(N, int, min(1)), min(2))],
      ['c', en(['p', 'q'])],
    ],
    {},
    { a: 'x', b: [0], c: 'r' },
    { a: 'x', b: [1, 2], c: 'p' },
  ),
]

export const group: Group = {
  'zod.toJsonSchema': {
    ts: (args) => listedSchema(shapeOf(args[0])),
    cases: toJsonSchemaCases,
  },
  'zod.safeParse': {
    ts: (args) => safeParse(shapeOf(args[0]), args[1]),
    cases: safeParseCases,
  },
}
