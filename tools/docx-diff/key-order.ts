// The order of the keys of an object is part of parity: the engine's results
// are printed as JSON and iterated. JSON.parse cannot show the order Rust
// wrote, because a JavaScript object moves its integer keys to the front
// ("10" written before "2" reads back as "2", "10"), so a reply is parsed
// here and the written order is kept beside the object where it differs.

/** The keys of an object as its JSON text had them, where the object itself orders them otherwise. */
const writtenOrders = new WeakMap<object, string[]>()

const NUMBER = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y

/** `JSON.parse(text)`, remembering the written order of the keys of every object. */
export function parseKeepingOrder(text: string): unknown {
  let at = 0
  const fail = (): never => {
    throw new SyntaxError(`not JSON at ${at}: ${JSON.stringify(text.slice(at, at + 40))}`)
  }
  const skipSpace = (): void => {
    for (;;) {
      const code = text.charCodeAt(at)
      if (code !== 0x20 && code !== 0x0a && code !== 0x0d && code !== 0x09) return
      at += 1
    }
  }
  const literal = <T>(word: string, value: T): T => {
    if (!text.startsWith(word, at)) fail()
    at += word.length
    return value
  }
  const string = (): string => {
    const start = at
    let scan = at + 1
    for (;;) {
      const quote = text.indexOf('"', scan)
      if (quote === -1) fail()
      let slashes = 0
      while (text.charCodeAt(quote - 1 - slashes) === 0x5c) slashes += 1
      scan = quote + 1
      if (slashes % 2 === 0) break
    }
    at = scan
    const raw = text.slice(start + 1, at - 1)
    return raw.includes('\\') ? (JSON.parse(text.slice(start, at)) as string) : raw
  }
  const value = (): unknown => {
    skipSpace()
    const first = text.charCodeAt(at)
    if (first === 0x22) return string()
    if (first === 0x7b) return object()
    if (first === 0x5b) return array()
    if (first === 0x74) return literal('true', true)
    if (first === 0x66) return literal('false', false)
    if (first === 0x6e) return literal('null', null)
    NUMBER.lastIndex = at
    const found = NUMBER.exec(text)
    if (!found) return fail()
    at = NUMBER.lastIndex
    return Number(found[0])
  }
  const array = (): unknown[] => {
    const out: unknown[] = []
    at += 1
    skipSpace()
    if (text.charCodeAt(at) === 0x5d) {
      at += 1
      return out
    }
    for (;;) {
      out.push(value())
      skipSpace()
      const next = text.charCodeAt(at)
      at += 1
      if (next === 0x5d) return out
      if (next !== 0x2c) fail()
    }
  }
  const object = (): object => {
    const out: Record<string, unknown> = {}
    const written: string[] = []
    at += 1
    skipSpace()
    if (text.charCodeAt(at) === 0x7d) {
      at += 1
      return out
    }
    for (;;) {
      skipSpace()
      if (text.charCodeAt(at) !== 0x22) fail()
      const key = string()
      skipSpace()
      if (text.charCodeAt(at) !== 0x3a) fail()
      at += 1
      const inner = value()
      written.push(key)
      // as JSON.parse: an own entry, also under the name __proto__
      if (key === '__proto__') {
        Object.defineProperty(out, key, {
          value: inner,
          enumerable: true,
          writable: true,
          configurable: true,
        })
      } else out[key] = inner
      skipSpace()
      const next = text.charCodeAt(at)
      at += 1
      if (next === 0x7d) break
      if (next !== 0x2c) fail()
    }
    const own = Object.keys(out)
    if (own.length !== written.length || own.some((key, index) => key !== written[index])) {
      writtenOrders.set(out, written)
    }
    return out
  }
  const parsed = value()
  skipSpace()
  if (at !== text.length) fail()
  return parsed
}

/** The keys of an object in the order its JSON text had them. */
export function keysAsWritten(value: object): string[] {
  return writtenOrders.get(value) ?? Object.keys(value)
}

export interface OrderDifference {
  /** Where the object is, as a path of keys and indices. */
  path: string
  typescript: string[]
  rust: string[]
}

/**
 * Every object of two values that are equal as JSON whose keys are not in the
 * same order on both sides. `typescript` is a JavaScript value, so its order
 * is the one JSON.stringify writes; `rust` comes from `parseKeepingOrder`.
 */
export function keyOrderDifferences(
  typescript: unknown,
  rust: unknown,
  path = '',
  found: OrderDifference[] = [],
): OrderDifference[] {
  if (typescript === null || rust === null) return found
  if (typeof typescript !== 'object' || typeof rust !== 'object') return found
  if (Array.isArray(typescript) || Array.isArray(rust)) {
    if (!Array.isArray(typescript) || !Array.isArray(rust)) return found
    const length = Math.min(typescript.length, rust.length)
    for (let index = 0; index < length; index++) {
      keyOrderDifferences(typescript[index], rust[index], `${path}/${index}`, found)
    }
    return found
  }
  const [left, right] = [Object.keys(typescript), keysAsWritten(rust)]
  if (left.length !== right.length || left.some((key, index) => key !== right[index])) {
    found.push({ path: path || '/', typescript: left, rust: right })
  }
  for (const key of left) {
    if (!Object.hasOwn(rust, key)) continue
    keyOrderDifferences(
      (typescript as Record<string, unknown>)[key],
      (rust as Record<string, unknown>)[key],
      `${path}/${key}`,
      found,
    )
  }
  return found
}

interface Place {
  results: number
  example: OrderDifference
}

/** Per place (who returned the value, and where in it): the results whose keys differ in order there. */
const places = new Map<string, Place>()
let resultsOutOfOrder = 0

/**
 * The key order of one result that is equal as JSON. Returns the text of the
 * difference, `null` where the order is the same, and counts each place of the
 * result once.
 */
export function keyOrderDifference(who: string, typescript: unknown, rust: unknown): string | null {
  if (KEY_ORDERS) collectOrders(who, typescript, '')
  const found = keyOrderDifferences(typescript, rust)
  if (found.length === 0) return null
  resultsOutOfOrder += 1
  const seen = new Set<string>()
  for (const difference of found) {
    // one place for every element of an array
    const place = `${who} ${difference.path.replace(/\/\d+(?=\/|$)/g, '/*')}`
    if (seen.has(place)) continue
    seen.add(place)
    const tally = places.get(place) ?? { results: 0, example: difference }
    tally.results += 1
    places.set(place, tally)
  }
  const first = found[0]!
  return (
    `key order at ${first.path}` +
    (found.length > 1 ? ` and ${found.length - 1} more` : '') +
    `\n      typescript ${first.typescript.join(', ')}\n      rust       ${first.rust.join(', ')}`
  )
}

/** The places where key order differs, most results first. */
export function reportKeyOrder(show: number): void {
  console.log(
    `key order: ${resultsOutOfOrder} results equal as JSON differ in the order of their keys, ` +
      `in ${places.size} places`,
  )
  const sorted = [...places].sort((a, b) => b[1].results - a[1].results)
  for (const [place, { results, example }] of sorted.slice(0, show)) {
    console.log(
      `    ${String(results).padStart(7)}  ${place}\n` +
        `             typescript ${example.typescript.join(', ')}\n` +
        `             rust       ${example.rust.join(', ')}`,
    )
  }
  if (sorted.length > show) console.log(`    ... ${sorted.length - show} more places (--places N)`)
  reportKeyOrders()
}

/** `--key-orders`: also report, per place, the order the TypeScript writes its keys in. */
const KEY_ORDERS = process.argv.includes('--key-orders')
/** A place with more distinct key sequences than this is a record keyed by data, not a type. */
const MOST_SEQUENCES = 400
const SEPARATOR = '\u0001'
const sequences = new Map<string, Set<string>>()

function collectOrders(who: string, value: unknown, path: string): void {
  if (value === null || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (const inner of value) collectOrders(who, inner, `${path}/*`)
    return
  }
  const place = `${who} ${path || '/'}`
  const seen = sequences.get(place) ?? new Set<string>()
  if (seen.size <= MOST_SEQUENCES) seen.add(Object.keys(value).join(SEPARATOR))
  sequences.set(place, seen)
  for (const [key, inner] of Object.entries(value)) collectOrders(who, inner, `${path}/${key}`)
}

/**
 * One order that every sequence follows, or two keys that come both ways (in
 * one sequence or through others): then the order depends on the path the
 * TypeScript took.
 */
function oneOrder(seen: Set<string>): { order: string[] } | { bothWays: [string, string] } {
  const after = new Map<string, Set<string>>()
  for (const sequence of seen) {
    const keys = sequence === '' ? [] : sequence.split(SEPARATOR)
    keys.forEach((key, index) => {
      const later = after.get(key) ?? new Set<string>()
      for (const other of keys.slice(index + 1)) later.add(other)
      after.set(key, later)
    })
  }
  const order: string[] = []
  const left = new Set(after.keys())
  while (left.size > 0) {
    // the first key, in the order the keys were met, that no key left comes before
    const next = [...left].find((key) => ![...left].some((other) => after.get(other)!.has(key)))
    if (next === undefined) {
      const [key] = left
      const before = [...left].find((other) => after.get(other)!.has(key!))!
      return { bothWays: [before, key!] }
    }
    order.push(next)
    left.delete(next)
  }
  return { order }
}

/** The order of the keys of every type the TypeScript returned, for writing the Rust fields down. */
function reportKeyOrders(): void {
  if (!KEY_ORDERS) return
  console.log(`key orders of the TypeScript, ${sequences.size} places:`)
  for (const [place, seen] of [...sequences].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (seen.size > MOST_SEQUENCES) {
      console.log(`    ${place}: more than ${MOST_SEQUENCES} sequences, keyed by data`)
      continue
    }
    const found = oneOrder(seen)
    console.log(
      'order' in found
        ? `    ${place}: ${found.order.join(', ')}`
        : `    ${place}: NO ONE ORDER, ${found.bothWays[0]} and ${found.bothWays[1]} come both ways ` +
            `in ${seen.size} sequences`,
    )
  }
}
