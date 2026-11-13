// Group `save`: the internal functions of patch.ts and its helpers, ported
// (crates/docx-engine/src/save/).
import type { CallSpec } from './calls-spec'
import { SAVE_FEATURES } from './calls-save-features'
import { SAVE_PARTS } from './calls-save-parts'
import { SAVE_SAVE } from './calls-save-save'

export const SAVE: CallSpec[] = [...SAVE_SAVE, ...SAVE_PARTS, ...SAVE_FEATURES]
