/**
 * Group `b3b4-rest`: the last modules of batches B3 and B4 of decision 0030.
 * The shell's file index and folder tree, the shell's document links, drops
 * and headless export, the editors' recovery modules and the slides
 * transaction core. Each part lives in `b3b4-rest/` beside its Rust part in
 * crates/main-core/src/calls/b3b4_rest/.
 */
import '../electron-fake.ts'
import type { Group } from '../types.ts'

// loaded after electron-fake.ts has registered its hooks
const parts = await Promise.all([
  import('./b3b4-rest/index-core.ts'),
  import('./b3b4-rest/index-store.ts'),
  import('./b3b4-rest/shell-rest.ts'),
  import('./b3b4-rest/recovery.ts'),
])

export const group: Group = Object.assign({}, ...parts.map((part) => part.part))
