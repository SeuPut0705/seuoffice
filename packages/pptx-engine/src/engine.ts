// The core of the pptx binding: how an exported function of this package
// reaches the wasm engine (crates/office-wasm, `pptx.` rows). The generated
// modules call `call` with the TypeScript arguments positionally; the engine
// answers `{ value, out }`, and each argument it changed (`out[i]`) is written
// back into the caller's object (engine-adopt.ts), so references callers hold
// into a deck stay live. crates/pptx-engine/C2-PLAN.md has the argument kinds.
import { engineInvoke, type Shape } from '@seuoffice/engine-wasm'
import { adopt, adoptArchive, type ArchiveChanges } from './engine-adopt'
import type { OpenedPptx } from './index'
import type { Slide } from './types'
import type { PackageArchive } from './zip'

/** How an argument the engine changed is written back. */
export type Changed = 'opened' | 'archive' | 'json'

export interface CallOptions {
  /** the arguments the engine changes, by index */
  mut?: Readonly<Record<number, Changed>>
  /** the reply holds Maps, Sets or lists of them at these places */
  shape?: Shape
  /** the TypeScript function returns undefined where Rust has no value */
  undef?: boolean
}

interface Answer {
  value?: unknown
  out?: Record<string, unknown>
}

interface OpenedAnswer {
  deck: Parameters<typeof adopt>[1]
  archive: ArchiveChanges
  saveSnapshot: Array<[string, string]> | null
}

// `saveSnapshot` of index.ts: what the last save patched, per opened deck.
// The engine has no memory between calls, so the binding keeps it.
const saveSnapshots = new WeakMap<object, Array<[string, string]>>()

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
  const mut = options.mut ?? {}
  const wire = args.map((arg, i) => (mut[i] === 'opened' ? openedArg(arg as OpenedPptx) : arg))
  const answer = engineInvoke(fn, wire, { fnPrefix: 'pptx.', shape: options.shape && { k: 'obj', f: { value: options.shape } } }) as Answer
  for (const [index, value] of Object.entries(answer.out ?? {})) {
    const at = Number(index)
    writeBack(args[at], mut[at] ?? 'json', value)
  }
  const value = answer.value === undefined || (answer.value === null && options.undef) ? undefined : answer.value
  return value
}

/** `call` for a function the TypeScript declares `async`. */
export async function callAsync(fn: string, args: readonly unknown[], options: CallOptions = {}): Promise<unknown> {
  return call(fn, args, options)
}

/** The index of `slide` in the opened deck: the engine names a slide by its place. */
export function slideIndex(opened: OpenedPptx, slide: Slide): number {
  const at = opened.deck.slides.indexOf(slide)
  if (at === -1) throw new TypeError('the slide is not a slide of this deck')
  return at
}
