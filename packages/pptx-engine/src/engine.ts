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
import type { PackageArchive } from './zip'

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

/** An opened deck as the engine reads it: the deck, the archive and its save snapshot. */
function openedArg(opened: OpenedPptx): unknown {
  return { deck: opened.deck, archive: opened.archive, saveSnapshot: saveSnapshots.get(opened) ?? null }
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
  if (kind === 'opened') return TYPE_SHAPES.SlideDeck && { k: 'obj', f: { deck: TYPE_SHAPES.SlideDeck } }
  if (kind === 'Paragraph[]') return TYPE_SHAPES.Paragraph && { k: 'arr', v: TYPE_SHAPES.Paragraph }
  return kind === undefined || kind === 'archive' || kind === 'json' ? undefined : TYPE_SHAPES[kind]
}

/** The shape of the whole answer: the value's, and each changed argument's. */
function answerShape(options: CallOptions, mut: Readonly<Record<number, Changed>>): Shape | undefined {
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

/** One exported function of the package: the engine's answer, with the arguments it changed written back. */
export function call(fn: string, args: readonly unknown[], options: CallOptions = {}): unknown {
  ensureEngine()
  const mut = options.mut ?? {}
  const wire = args.map((arg, i) =>
    mut[i] === 'opened' || options.opened?.includes(i) ? openedArg(arg as OpenedPptx) : arg,
  )
  const answer = engineInvoke(fn, wire, {
    fnPrefix: 'pptx.',
    names: options.names,
    shape: answerShape(options, mut),
  }) as Answer
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
    keysA.every((k) => sameValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
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
    for (const [key, value] of Object.entries(answer)) out[key] = shared((input as Record<string, unknown>)[key], value)
    return out as T
  }
  return answer
}

/** The index of `slide` in the opened deck: the engine names a slide by its place. */
export function slideIndex(opened: OpenedPptx, slide: Slide): number {
  const at = opened.deck.slides.indexOf(slide)
  if (at === -1) throw new TypeError('the slide is not a slide of this deck')
  return at
}
