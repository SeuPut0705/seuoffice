/**
 * Undo and Redo of a change written to the file at once (Replace pages, Page
 * size, Crop, Insert PDF, Paste pages): the file as it was is kept, and
 * stepping writes it back. Every kept file is a whole copy of the document in
 * this renderer, so they arrive in slices and their total is bounded; a step
 * that no longer fits is dropped, and what is left is what the Undo and Redo
 * buttons offer. A file too large to keep at all is the one case the person is
 * asked about first: the change, or the Undo, that follows cannot be taken back.
 */
import type { RestoreFileRequest, RestoreFileResult } from '../shared/ipc'
import { readFileWithin, type BoundedFileRead, type PdfFileChunkApi } from './file-bytes'

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

/** Whether the person agreed, for the open document, to what one question asks */
export interface NoUndoConsent {
  given: boolean
}

/** What the person is asked before a write that cannot be taken back */
export interface NoUndoQuestion {
  /** the file that is too large to keep */
  fileBytes: number
  /** the largest file kept as a step */
  limitBytes: number
}

/**
 * The question before a write that cannot be taken back, and its answer. A
 * change that cannot be undone and an Undo that cannot be redone are two
 * questions: each has its own gate, so that agreeing to one is not taken for
 * the other.
 */
export interface NoUndoGate {
  /** one per open document: set here once the person agrees, so they are asked once */
  consent: NoUndoConsent
  /** false cancels the write */
  confirm(question: NoUndoQuestion): boolean | Promise<boolean>
  limits?: WrittenLimits
}

/**
 * Whether a change may be written to a file of this size. One larger than the
 * budget gets no Undo step, so the change could not be taken back: the person
 * is asked first, once per document. A file that fits is never asked about;
 * its oldest step falling off the bound is ordinary Undo depth.
 */
async function agreesToNoUndo(
  fileBytes: number,
  { consent, confirm, limits = DEFAULT_LIMITS }: NoUndoGate,
): Promise<boolean> {
  if (fileBytes <= limits.bytes || consent.given) return true
  if (!(await confirm({ fileBytes, limitBytes: limits.bytes }))) return false
  consent.given = true
  return true
}

/** Edits not in the file yet: they are saved to it before a change is written in place */
export interface PendingEdits {
  /** the file's size as the document was read: what the person is asked about before the save */
  fileBytes: number
  /** writes them to the file; false when that failed */
  save(): Promise<boolean>
}

export type InPlaceWrite<R> =
  /** the person chose not to go on: `write` was not called. `flushed`: the pending edits
   *  were saved all the same, because only their save made the file too large */
  | { status: 'declined'; flushed: boolean }
  /** the pending edits could not be saved: `write` was not called */
  | { status: 'unsaved' }
  /** `before`: the file from before the change, null when it was too large to keep */
  | { status: 'run'; result: R; before: Uint8Array | null }

/**
 * Writes a change to the file in place, after the pending edits are saved to
 * it. The file as it is then is read first, for Undo; when it is too large to
 * keep, nothing is written unless the person agrees to a change that cannot
 * be undone. With edits pending they are asked before the save, so that
 * Cancel leaves the file as it is.
 */
export async function writeInPlace<R>(
  api: PdfFileChunkApi,
  path: string,
  write: () => Promise<R>,
  gate: NoUndoGate,
  pending?: PendingEdits,
): Promise<InPlaceWrite<R>> {
  if (pending) {
    if (!(await agreesToNoUndo(pending.fileBytes, gate))) {
      return { status: 'declined', flushed: false }
    }
    if (!(await pending.save())) return { status: 'unsaved' }
  }
  const kept = await readFileWithin(api, path, (gate.limits ?? DEFAULT_LIMITS).bytes)
  if (kept.bytes === null && !(await agreesToNoUndo(kept.fileSize, gate))) {
    return { status: 'declined', flushed: pending !== undefined }
  }
  return { status: 'run', result: await write(), before: kept.bytes }
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

export type WrittenStepResult =
  | { ok: true; steps: WrittenSteps }
  /** nothing was written: another program changed or removed the file the step was taken from */
  | { ok: false; reason: 'disk-changed' }
  /** nothing was written: the step could not be taken back, and the person chose not to take it */
  | { ok: false; reason: 'declined' }
  | { ok: false; reason: 'failed'; error: string }

export interface WrittenStepOptions {
  /** the notice that another program changed or removed the file is up */
  diskChanged: boolean
  /** asked before a step that cannot be taken back: the file as it is now is too large to keep */
  gate: NoUndoGate
}

/**
 * Undo or Redo one step: the file as it is now becomes the step for the way
 * back, then the kept file is written over it. A file too large to keep leaves
 * no way back (an Undo that cannot be redone), so the person is asked first,
 * once per document. The kept file holds nothing another program wrote since,
 * so nothing is asked for while that is known, and the main process refuses
 * (`external-modified`) when it finds out first. The caller offers the step
 * only when there is one.
 */
export async function stepWrittenFile(
  api: WrittenHistoryApi,
  path: string,
  steps: WrittenSteps,
  direction: 'undo' | 'redo',
  { diskChanged, gate }: WrittenStepOptions,
): Promise<WrittenStepResult> {
  const limits = gate.limits ?? DEFAULT_LIMITS
  const from = direction === 'undo' ? steps.undo : steps.redo
  const back = direction === 'undo' ? steps.redo : steps.undo
  const bytes = from[from.length - 1]
  if (!bytes) return { ok: false, reason: 'failed', error: `pdf: nothing to ${direction}` }
  if (diskChanged) return { ok: false, reason: 'disk-changed' }
  let now: BoundedFileRead
  try {
    now = await readFileWithin(api, path, limits.bytes)
  } catch {
    // it could be read when the step was taken: gone or locked is another program's doing
    return { ok: false, reason: 'disk-changed' }
  }
  if (now.bytes === null && !(await agreesToNoUndo(now.fileSize, gate))) {
    return { ok: false, reason: 'declined' }
  }
  const current = now.bytes
  // the slices were copied into a buffer of the reported size: send exactly the file
  const whole = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
  const result = await api.restoreFile({
    path,
    bytes: (whole
      ? bytes.buffer
      : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)) as ArrayBuffer,
  })
  if (!result.ok) {
    return result.error === 'external-modified'
      ? { ok: false, reason: 'disk-changed' }
      : { ok: false, reason: 'failed', error: result.error }
  }
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
