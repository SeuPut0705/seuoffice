// How an argument the engine changed is written back into the caller's object.
// The engine answers the new value as JSON; callers hold references into the
// old one (an element they found, the slide they render, the entries map an
// undo snapshot copied), so the old objects are kept and changed to match.
import type { PackageArchive } from './zip'

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
type Bag = Record<string, unknown>

function isBag(value: unknown): value is Bag {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    !ArrayBuffer.isView(value)
  )
}

/** The key an array's objects are matched by: `id` for elements, `path` for slides; null matches by index. */
function keyOf(items: readonly unknown[]): 'id' | 'path' | null {
  for (const key of ['id', 'path'] as const) {
    if (items.length && items.every((item) => isBag(item) && typeof item[key] === 'string'))
      return key
  }
  return null
}

function adoptValue(old: unknown, next: Json): unknown {
  if (Array.isArray(old) && Array.isArray(next)) {
    adoptArray(old, next)
    return old
  }
  if (isBag(old) && isBag(next)) {
    adopt(old, next)
    return old
  }
  return next
}

function adoptArray(old: unknown[], next: Json[]): void {
  const key = keyOf(next)
  // each old object is taken once, in order: a deck may list one slide part twice,
  // and two answers adopted into one object would make the two entries one
  const byKey = new Map<unknown, unknown[]>()
  if (key)
    for (const item of old)
      if (isBag(item)) {
        const same = byKey.get(item[key])
        if (same) same.push(item)
        else byKey.set(item[key], [item])
      }
  const items = next.map((item, i) => {
    const before = key && isBag(item) ? byKey.get(item[key])?.shift() : old[i]
    return before === undefined ? item : adoptValue(before, item)
  })
  old.length = 0
  for (const item of items) old.push(item)
}

/**
 * `target` (an object, or a list of them) changed in place to equal `next`: keys `next` lacks are deleted,
 * nested objects and arrays are kept and changed the same way, arrays of
 * elements and slides matched by `id` and `path` so each keeps its object.
 */
export function adopt(target: object, next: Json): void {
  if (Array.isArray(target)) {
    if (!Array.isArray(next))
      throw new TypeError('the engine answered a value where a list was written back')
    adoptArray(target, next)
    return
  }
  if (!isBag(next))
    throw new TypeError('the engine answered a value where an object was written back')
  const own = target as Bag
  for (const name of Object.keys(own)) if (!(name in next)) delete own[name]
  for (const [name, value] of Object.entries(next)) own[name] = adoptValue(own[name], value)
}

/** What the engine answers of an archive it was given: the entries it changed, and the order of all. */
export interface ArchiveChanges {
  /** a new part's bytes, or null where the part was removed */
  changed: Array<[string, Uint8Array | null]>
  paths: string[]
}

/**
 * The archive's entries changed to the engine's: a changed part gets the new
 * array (an entry is replaced, never written into: an undo snapshot holds the
 * old one), and the map takes the engine's order where it differs.
 */
export function adoptArchive(archive: PackageArchive, changes: ArchiveChanges): void {
  const entries = archive.entries
  for (const [path, bytes] of changes.changed) {
    if (bytes === null) entries.delete(path)
    // a copy: the answer is a view into the whole reply frame, which a kept view would pin
    else entries.set(path, bytes.slice())
  }
  const now = [...entries.keys()]
  if (now.length === changes.paths.length && now.every((path, i) => path === changes.paths[i]))
    return
  const kept = new Map(entries)
  entries.clear()
  for (const path of changes.paths) {
    const bytes = kept.get(path)
    if (bytes === undefined) throw new Error(`the engine named a part it did not answer: ${path}`)
    entries.set(path, bytes)
  }
}
