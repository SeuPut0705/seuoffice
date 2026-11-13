// The core of the pptx binding: how an exported function of this package
// reaches the wasm engine (crates/office-wasm, `pptx.` rows). The generated
// modules call `call` with the TypeScript arguments positionally; the engine
// answers `{ "$result": value, "$out": { "<wire index>": answer } }`, and each
// argument it changed (`$out`) is written back into the caller's object
// (engine-adopt.ts), so references callers hold into a deck stay live.
// crates/pptx-engine/C2-PLAN.md has the argument kinds. The codec is the shared
// one of @seuoffice/engine-wasm. This file never starts the engine
// (engine-init.ts and the `node` export condition do); it only refuses to call
// one that has not started.
import { engineInvoke, engineReady, sameBytesAs, type Shape } from '@seuoffice/engine-wasm'
import { adopt, adoptArchive, type ArchiveChanges } from './engine-adopt'
import { TYPE_SHAPES } from './engine-type-shapes'
import type { OpenedPptx } from './index'
import type { Slide } from './types'
import { PackageArchive } from './zip'

/** A model type the engine answers whole, by its TypeScript name. */
export type ModelType = 'Slide' | 'SlideDeck' | 'SlideElement' | 'GroupElement' | 'Paragraph[]'

/**
 * How an argument the engine changed is written back: an opened deck, an
 * archive, a model value (its holes and Maps revived by the type's shape) or
 * other JSON.
 */
export type Changed = 'opened' | 'archive' | 'json' | ModelType

export interface CallOptions {
  /** the arguments the engine changes, by wire index */
  mut?: Readonly<Record<number, Changed>>
  /** the arguments that are an OpenedPptx the engine only reads */
  opened?: readonly number[]
  /** the reply holds Maps, Sets or lists of them at these places */
  shape?: Shape
  /** the reply is a model value of this kind (`opened`: a deck the engine opened, `{ deck, archive }`) */
  reply?: Changed
  /** the TypeScript function returns undefined where Rust has no value */
  undef?: boolean
  /** the name of each wire argument: a function argument crosses as a callback slot of that name */
  names?: readonly string[]
}

interface Answer {
  $result?: unknown
  $out?: Record<string, unknown>
}

interface OpenedAnswer {
  deck: Parameters<typeof adopt>[1]
  archive: ArchiveChanges
  saveSnapshot: Array<[string, string]> | null
}

export function ensureEngine(): void {
  if (!engineReady()) {
    throw new Error(
      'the pptx engine is not started: await initPptxEngine(url) (a page or worker) or initPptxEngineSync(bytes) once before the first call; under the `node` export condition it starts itself',
    )
  }
}

// `saveSnapshot` of index.ts: what the last save patched, per opened deck.
// The engine has no memory between calls, so the binding keeps it.
const saveSnapshots = new WeakMap<object, Array<[string, string]>>()

/** A save that failed to reach its file leaves no snapshot (`savePptxToFile`). */
export function forgetSnapshot(opened: OpenedPptx): void {
  saveSnapshots.delete(opened)
}

const utf8 = new TextEncoder()

/**
 * An archive as the engine reads it. The TypeScript engine read each part
 * through `readText`/`readBytes`, so a caller could hand it a view over an
 * archive that answers some parts otherwise (the CLI reads notes through one
 * that withholds runs hidden from AI). The engine reads the entries: a view
 * crosses as the parts it answers, an XML part rewritten where its `readText`
 * differs from the archive's own.
 */
function archiveArg(archive: PackageArchive): unknown {
  if (Object.getPrototypeOf(archive) === PackageArchive.prototype) return archive
  const own = PackageArchive.prototype
  const entries = new Map<string, Uint8Array>()
  for (const [path, stored] of archive.entries) {
    let bytes = archive.readBytes(path) ?? stored
    if (/\.(?:xml|rels)$/.test(path)) {
      const text = archive.readText(path)
      if (text !== null && text !== own.readText.call(archive, path)) bytes = utf8.encode(text)
    }
    entries.set(path, bytes)
  }
  return { entries, originalHash: archive.originalHash }
}

/** An opened deck as the engine reads it: the deck, the archive and its save snapshot. */
function openedArg(opened: OpenedPptx): unknown {
  return {
    deck: opened.deck,
    archive: archiveArg(opened.archive),
    saveSnapshot: saveSnapshots.get(opened) ?? null,
  }
}

function writeBack(target: unknown, kind: Changed, answer: unknown): void {
  if (kind === 'archive') {
    adoptArchive(target as PackageArchive, answer as ArchiveChanges)
    return
  }
  if (kind !== 'opened') {
    adopt(target as object, answer as Parameters<typeof adopt>[1])
    return
  }
  const opened = target as OpenedPptx
  const next = answer as OpenedAnswer
  adopt(opened.deck, next.deck)
  adoptArchive(opened.archive, next.archive)
  if (next.saveSnapshot === null) saveSnapshots.delete(opened)
  else saveSnapshots.set(opened, next.saveSnapshot)
}

/** Where the JSON of a changed value holds what JSON cannot: the holes of its arrays, its Maps and Sets. */
function shapeOf(kind: Changed | undefined): Shape | undefined {
  if (kind === 'opened')
    return TYPE_SHAPES.SlideDeck && { k: 'obj', f: { deck: TYPE_SHAPES.SlideDeck } }
  if (kind === 'Paragraph[]') return TYPE_SHAPES.Paragraph && { k: 'arr', v: TYPE_SHAPES.Paragraph }
  return kind === undefined || kind === 'archive' || kind === 'json' ? undefined : TYPE_SHAPES[kind]
}

/** The shape of the whole answer: the value's, and each changed argument's. */
function answerShape(
  options: CallOptions,
  mut: Readonly<Record<number, Changed>>,
): Shape | undefined {
  const fields: Record<string, Shape> = {}
  const result = options.shape ?? shapeOf(options.reply)
  if (result) fields.$result = result
  const out: Record<string, Shape> = {}
  for (const [index, kind] of Object.entries(mut)) {
    const shape = shapeOf(kind)
    if (shape) out[index] = shape
  }
  if (Object.keys(out).length) fields.$out = { k: 'obj', f: out }
  return Object.keys(fields).length ? { k: 'obj', f: fields } : undefined
}

// The TypeScript engine minted its ids with `crypto.randomUUID()` (creation ids) and
// `Math.random()` (field ids), looked up at each call: a host that replaces them (co-editing
// seeds both, so every page mints the same ids for one edit) got its own ids back. The wasm
// engine draws its random bytes through WASI `random_get`, which the loader answers with
// `crypto.getRandomValues`: one draw of 16 bytes is a `crypto.randomUUID()` (jscompat
// random_uuid), one of 8 bytes a `Math.random()` (jscompat math_random, 53 bits shifted up 11).
// While either function is replaced, a call answers those draws from them; anything else, and
// every draw while both are the platform's, stays with `getRandomValues`.
const PLATFORM_UUID = globalThis.crypto?.randomUUID
const PLATFORM_RANDOM = Math.random

function uuidBytes(into: Uint8Array): void {
  const hex = globalThis.crypto.randomUUID().replaceAll('-', '')
  for (let i = 0; i < 16; i++) into[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
}

function randomBytes(into: Uint8Array): void {
  let word = BigInt(Math.floor(Math.random() * 2 ** 53)) << 11n
  for (let i = 0; i < 8; i++) {
    into[i] = Number(word & 0xffn)
    word >>= 8n
  }
}

function withHostRandomness<T>(run: () => T): T {
  const crypto = globalThis.crypto
  if (crypto.randomUUID === PLATFORM_UUID && Math.random === PLATFORM_RANDOM) return run()
  const own = Object.getOwnPropertyDescriptor(crypto, 'getRandomValues')
  const platform = crypto.getRandomValues.bind(crypto)
  Object.defineProperty(crypto, 'getRandomValues', {
    configurable: true,
    writable: true,
    // the loader hands a Uint8Array view of the engine's memory
    value: (array: Uint8Array): Uint8Array => {
      if (array.length === 16) uuidBytes(array)
      else if (array.length === 8) randomBytes(array)
      else platform(array)
      return array
    },
  })
  try {
    return run()
  } finally {
    if (own) Object.defineProperty(crypto, 'getRandomValues', own)
    else Reflect.deleteProperty(crypto, 'getRandomValues')
  }
}

/** One exported function of the package: the engine's answer, with the arguments it changed written back. */
export function call(fn: string, args: readonly unknown[], options: CallOptions = {}): unknown {
  try {
    return callEngine(fn, args, options)
  } finally {
    returnLent()
  }
}

function callEngine(fn: string, args: readonly unknown[], options: CallOptions): unknown {
  ensureEngine()
  const mut = options.mut ?? {}
  const wire = args.map((arg, i) =>
    mut[i] === 'opened' || options.opened?.includes(i)
      ? openedArg(arg as OpenedPptx)
      : arg instanceof PackageArchive
        ? archiveArg(arg)
        : arg,
  )
  const answer = withHostRandomness(
    () =>
      engineInvoke(fn, wire, {
        fnPrefix: 'pptx.',
        names: options.names,
        shape: answerShape(options, mut),
        types: TYPE_SHAPES,
      }) as Answer,
  )
  for (const [index, value] of Object.entries(answer.$out ?? {})) {
    const at = Number(index)
    writeBack(args[at], mut[at] ?? 'json', value)
  }
  const value = answer.$result
  if (value === undefined || (value === null && options.undef)) return undefined
  // bytes given back unchanged are the caller's own array, as the TypeScript returned its argument
  return sameBytesAs(
    value,
    args.filter((arg): arg is Uint8Array => arg instanceof Uint8Array),
  )
}

function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const keysA = Object.keys(a).filter((k) => (a as Record<string, unknown>)[k] !== undefined)
  const keysB = Object.keys(b).filter((k) => (b as Record<string, unknown>)[k] !== undefined)
  return (
    keysA.length === keysB.length &&
    keysA.every((k) =>
      sameValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
    )
  )
}

/**
 * `answer` with every part equal to the same place of `input` replaced by the
 * input's object: what a TypeScript function that copies only what it changes
 * returned (`{ ...run, lang }` for a changed run, the run itself otherwise).
 */
export function shared<T>(input: T, answer: T): T {
  if (sameValue(input, answer)) return input
  if (Array.isArray(input) && Array.isArray(answer) && input.length === answer.length)
    return answer.map((item, i) => shared(input[i], item)) as T
  if (
    input !== null &&
    answer !== null &&
    typeof input === 'object' &&
    typeof answer === 'object' &&
    !Array.isArray(input) &&
    !Array.isArray(answer)
  ) {
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(answer))
      out[key] = shared((input as Record<string, unknown>)[key], value)
    return out as T
  }
  return answer
}

// Slides lent to a deck for the length of one call (`slideIndex`).
const lent: Array<{ slides: Slide[]; slide: Slide }> = []

/** Takes the slides `slideIndex` lent back out of their decks. */
function returnLent(): void {
  for (const { slides, slide } of lent.splice(0)) {
    const at = slides.lastIndexOf(slide)
    if (at !== -1) slides.splice(at, 1)
  }
}

/**
 * The index of `slide` in the opened deck: the engine names a slide by its
 * place. The TypeScript took any slide beside the deck, a master or a layout
 * parsed on its own (pptx-ops edits chrome so): such a slide is lent to the
 * deck at its end for the next call, which writes the engine's answer back
 * into it (slides are matched by path) and takes it out again.
 */
export function slideIndex(opened: OpenedPptx, slide: Slide): number {
  const at = opened.deck.slides.indexOf(slide)
  if (at !== -1) return at
  lent.push({ slides: opened.deck.slides, slide })
  return opened.deck.slides.push(slide) - 1
}
