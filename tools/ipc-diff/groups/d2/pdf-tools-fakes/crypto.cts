/**
 * `node:crypto` for the tools window: `randomUUID` counts, as the Rust
 * `PdfToolsShell::random_uuid` fake does, so the ids in the answers are the
 * same on both sides.
 */
import { state } from './state.cts'

export * from 'node:crypto'

export function randomUUID(): string {
  const s = state()
  s.uuids += 1
  return `00000000-0000-4000-8000-${String(s.uuids).padStart(12, '0')}`
}
