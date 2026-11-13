// The steps the engines leave to the host (crates/seu-host), as the screens
// will supply them: one map, by step name, for every gate's engine.
import { EPUB_STEPS } from './host-steps-epub'
import { FILEPARSE_STEPS } from './host-steps-fileparse'

export const HOST_STEPS: Record<string, (input: unknown) => unknown> = {
  ...FILEPARSE_STEPS,
  ...EPUB_STEPS,
}
