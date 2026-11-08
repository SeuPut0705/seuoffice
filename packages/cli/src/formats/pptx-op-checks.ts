/**
 * Input checks the slide ops of `@genoffice/pptx-ops` do not make, applied
 * by the CLI before an op reaches the engine. Each one refuses a value that
 * writes a deck PowerPoint reports as damaged (the repair prompt): a page
 * size outside its accepted range, and a section list that names a slide
 * twice or a slide the deck does not have. pptx-ops stays as it is, so saved
 * output for valid input is unchanged.
 */
import { parseLength } from '@genoffice/pptx-ops'

/** The smallest and largest page edge PowerPoint accepts, in EMU (1 and 56 inches); apps/slides uses the same bounds. */
export const MIN_SLIDE_EMU = 914_400
export const MAX_SLIDE_EMU = 51_206_400

type OpLike = { op: string } & Record<string, unknown>

/** A length as the executor will see it: a bare number is EMU, a string may carry a unit. */
function asEmu(value: unknown): unknown {
  return typeof value === 'string' ? (parseLength(value) ?? value) : value
}

function checkSlideSize(op: OpLike): string | undefined {
  for (const key of ['cx', 'cy'] as const) {
    const value = asEmu(op[key])
    // a missing or non-numeric edge is the engine's own "needs cx/cy" error
    if (typeof value !== 'number') continue
    if (!Number.isInteger(value) || value < MIN_SLIDE_EMU || value > MAX_SLIDE_EMU) {
      return `op "setSlideSize": "${key}" must be a whole number of EMU from ${MIN_SLIDE_EMU} (1 inch) to ${MAX_SLIDE_EMU} (56 inches), got ${String(value)}.`
    }
  }
  return undefined
}

function checkSections(op: OpLike, slideCount: number | undefined): string | undefined {
  // a section list that is not an array is the engine's own "needs sections" error
  if (!Array.isArray(op.sections)) return undefined
  const seen = new Set<number>()
  for (const section of op.sections as unknown[]) {
    const indices = (section as { slideIndices?: unknown } | null)?.slideIndices
    if (!Array.isArray(indices)) {
      return 'op "setSections": every section needs "slideIndices" (an array).'
    }
    for (const index of indices as unknown[]) {
      if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) {
        return `op "setSections": slide indices are whole numbers from 0, got ${String(index)}.`
      }
      if (slideCount !== undefined && index >= slideCount) {
        return `op "setSections": slide index ${index} is out of range (the deck has ${slideCount} slides, 0-${slideCount - 1}).`
      }
      // a slide listed twice is written to the file twice
      if (seen.has(index)) {
        return `op "setSections": slide ${index} is listed in more than one place; every slide belongs to exactly one section.`
      }
      seen.add(index)
    }
  }
  return undefined
}

/**
 * The reason an op must not run, or undefined. `slideCount` is the deck's
 * slide count when the op will run; pass undefined when earlier ops of the
 * same batch may still add or remove slides, which skips the range check.
 */
export function refuseOp(op: unknown, slideCount: number | undefined): string | undefined {
  if (typeof op !== 'object' || op === null) return undefined
  const named = op as OpLike
  if (named.op === 'setSlideSize') return checkSlideSize(named)
  if (named.op === 'setSections') return checkSections(named, slideCount)
  return undefined
}
