import { isDeepStrictEqual } from 'node:util'
import { keyOrderDifferences } from './key-order'

export interface ObservedDifference {
  fn: string
  text: string
  args: object
  typescript: unknown
  rust: unknown
}

export interface ListedDifference extends ObservedDifference {
  id: string
  reason: string
}

const listed = new Map<string, ListedDifference>()
export const observedDifferences: ObservedDifference[] = []
let observing = false
// differences kept per function; a gate whose answers are whole decks would
// otherwise hold every one of thousands in memory
let perFunction = Number.POSITIVE_INFINITY
const kept = new Map<string, number>()

export function observeDifferences(limitPerFunction = Number.POSITIVE_INFINITY): void {
  observing = true
  perFunction = limitPerFunction
}

export function registerDifferences(entries: ListedDifference[]): void {
  for (const entry of entries) {
    const key = JSON.stringify([entry.fn, entry.text, entry.args])
    if (listed.has(key)) throw new Error(`duplicate listed input: ${entry.id}`)
    listed.set(key, entry)
  }
}

/** Accepts only a ledger input whose two complete answers still match. */
export function listedDifference(observed: ObservedDifference): string | null {
  if (observing) {
    const count = kept.get(observed.fn) ?? 0
    if (count < perFunction) {
      observedDifferences.push(observed)
      kept.set(observed.fn, count + 1)
    }
  }
  const entry = listed.get(JSON.stringify([observed.fn, observed.text, observed.args]))
  if (!entry) return null
  for (const side of ['typescript', 'rust'] as const) {
    if (
      !isDeepStrictEqual(entry[side], observed[side]) ||
      keyOrderDifferences(entry[side], observed[side]).length > 0
    )
      return null
  }
  return entry.id
}
