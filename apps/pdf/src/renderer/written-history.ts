/**
 * Undo and Redo of a change written to the file at once (Replace pages, Page
 * size, Crop, Insert PDF): the file as it was is kept, and stepping writes it
 * back. Every kept file is a whole copy of the document in this renderer, so
 * they arrive in slices and their total is bounded; a step that no longer fits
 * is dropped, and what is left is what the Undo and Redo buttons offer.
 */
import type { RestoreFileRequest, RestoreFileResult } from '../shared/ipc'
import { readFileBytesWithin, type PdfFileChunkApi } from './file-bytes'

export interface WrittenHistoryApi extends PdfFileChunkApi {
  restoreFile(request: RestoreFileRequest): Promise<RestoreFileResult>
}

/** Whole files, nearest step last: Undo writes back the last of `undo`, Redo the last of `redo` */
export interface WrittenSteps {
  undo: Uint8Array[]
  redo: Uint8Array[]
}

export const NO_WRITTEN_STEPS: WrittenSteps = { undo: [], redo: [] }

export const MAX_WRITTEN_STEPS = 10
/**
 * All kept files together. Ten steps of a 25 MiB document fit, a document up
 * to this size still gets one step, and a larger one gets none: its page
 * operations are then not undoable, instead of a renderer holding gigabytes.
 */
export const WRITTEN_HISTORY_BUDGET_BYTES = 256 * 1024 * 1024

export interface WrittenLimits {
  bytes: number
  steps: number
}

const DEFAULT_LIMITS: WrittenLimits = {
  bytes: WRITTEN_HISTORY_BUDGET_BYTES,
  steps: MAX_WRITTEN_STEPS,
}

/** Drops the steps furthest from the file as it is now until the rest fits */
function fit(steps: WrittenSteps, limits: WrittenLimits): WrittenSteps {
  const undo = [...steps.undo]
  const redo = [...steps.redo]
  let bytes = 0
  for (const each of undo) bytes += each.byteLength
  for (const each of redo) bytes += each.byteLength
  while (bytes > limits.bytes || undo.length + redo.length > limits.steps) {
    const dropped = (undo.length >= redo.length ? undo : redo).shift()
    if (!dropped) break
    bytes -= dropped.byteLength
  }
  return { undo, redo }
}

/** The file before a change is written to it; null when it is too large to keep */
export async function readWrittenSnapshot(
  api: PdfFileChunkApi,
  path: string,
  limits: WrittenLimits = DEFAULT_LIMITS,
): Promise<Uint8Array | null> {
  return readFileBytesWithin(api, path, limits.bytes)
}

/**
 * The steps once a change is written: the file from before it is the newest
 * Undo step and Redo is over. `before` null (the file was too large to keep)
 * leaves nothing: an older step would put back a file from two changes ago.
 */
export function recordWritten(
  steps: WrittenSteps,
  before: Uint8Array | null,
  limits: WrittenLimits = DEFAULT_LIMITS,
): WrittenSteps {
  if (!before) return NO_WRITTEN_STEPS
  return fit({ undo: [...steps.undo, before], redo: [] }, limits)
}

export type WrittenStepResult = { ok: true; steps: WrittenSteps } | { ok: false; error: string }

/**
 * Undo or Redo one step: the file as it is now becomes the step for the way
 * back, then the kept file is written over it. The caller offers the step
 * only when there is one.
 */
export async function stepWrittenFile(
  api: WrittenHistoryApi,
  path: string,
  steps: WrittenSteps,
  direction: 'undo' | 'redo',
  limits: WrittenLimits = DEFAULT_LIMITS,
): Promise<WrittenStepResult> {
  const from = direction === 'undo' ? steps.undo : steps.redo
  const back = direction === 'undo' ? steps.redo : steps.undo
  const bytes = from[from.length - 1]
  if (!bytes) return { ok: false, error: `pdf: nothing to ${direction}` }
  let current: Uint8Array | null
  try {
    current = await readFileBytesWithin(api, path, limits.bytes)
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  // the slices were copied into a buffer of the reported size: send exactly the file
  const whole = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
  const result = await api.restoreFile({
    path,
    bytes: (whole
      ? bytes.buffer
      : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)) as ArrayBuffer,
  })
  if (!result.ok) return result
  const rest = from.slice(0, -1)
  // a file too large to keep ends the way back, the steps behind it included
  const wayBack = current ? [...back, current] : []
  return {
    ok: true,
    steps: fit(
      direction === 'undo' ? { undo: rest, redo: wayBack } : { undo: wayBack, redo: rest },
      limits,
    ),
  }
}
