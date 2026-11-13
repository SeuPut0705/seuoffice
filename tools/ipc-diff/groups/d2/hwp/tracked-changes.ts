/**
 * `apps/hwp/src/main/tracked-changes.ts` for the hwp groups: answers from the
 * case as the Rust fake `HwpEngine::tracked_changes_of` /
 * `without_tracked_changes` do (crates/shell-ipc/d2/src/hwp/mod.rs).
 */
import { world } from './common.ts'

export type TrackedChanges = 'none' | 'tracked' | 'unreadable'

export function trackedChangesOf(_file: Uint8Array): TrackedChanges {
  const w = world()
  w.log.push(['trackedChangesOf'])
  const a = w.answers.next('tracked_changes_of')
  return a === 'tracked' || a === 'unreadable' ? a : 'none'
}

export function withoutTrackedChanges(_file: Uint8Array): Uint8Array | null {
  const w = world()
  w.log.push(['withoutTrackedChanges'])
  const a = w.answers.next('without_tracked_changes')
  return typeof a === 'string' ? new Uint8Array(Buffer.from(a, 'utf8')) : null
}
