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
import { engineInvoke, engineReady, type Shape } from '@seuoffice/engine-wasm'
import { adopt, adoptArchive, type ArchiveChanges } from './engine-adopt'
import type { OpenedPptx } from './index'
import type { Slide } from './types'
import type { PackageArchive } from './zip'

/** How an argument the engine changed is written back. */
export type Changed = 'opened' | 'archive' | 'json'

export interface CallOptions {
  /** the arguments the engine changes, by wire index */
  mut?: Readonly<Record<number, Changed>>
  /** the arguments that are an OpenedPptx the engine only reads */
  opened?: readonly number[]
  /** the reply holds Maps, Sets or lists of them at these places */
  shape?: Shape
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
  if (kind === 'json') {
    adopt(target as object, answer as Parameters<typeof adopt>[1])
    return
  }
  if (kind === 'archive') {
    adoptArchive(target as PackageArchive, answer as ArchiveChanges)
    return
  }
  const opened = target as OpenedPptx
  const next = answer as OpenedAnswer
  adopt(opened.deck, next.deck)
  adoptArchive(opened.archive, next.archive)
  if (next.saveSnapshot === null) saveSnapshots.delete(opened)
  else saveSnapshots.set(opened, next.saveSnapshot)
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
    shape: options.shape && { k: 'obj', f: { $result: options.shape } },
  }) as Answer
  for (const [index, value] of Object.entries(answer.$out ?? {})) {
    const at = Number(index)
    writeBack(args[at], mut[at] ?? 'json', value)
  }
  const value = answer.$result
  return value === undefined || (value === null && options.undef) ? undefined : value
}

/** The index of `slide` in the opened deck: the engine names a slide by its place. */
export function slideIndex(opened: OpenedPptx, slide: Slide): number {
  const at = opened.deck.slides.indexOf(slide)
  if (at === -1) throw new TypeError('the slide is not a slide of this deck')
  return at
}
