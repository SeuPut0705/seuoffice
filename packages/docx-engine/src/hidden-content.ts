import { invokeAsync } from './engine'

/** Whether any part of the package (body, headers, footers, comments, notes) holds the mark. */
export async function docxHoldsHiddenContent(bytes: Uint8Array): Promise<boolean> {
  return invokeAsync('docxHoldsHiddenContent', [bytes]) as never
}
/**
 * The package with every mark taken off: the words stay, readable by anyone.
 * The namespace declaration stays too (an ignorable prefix must stay declared).
 * Throws when a trace of the mark is left in a part, so that a copy never
 * claims to be clear when it is not.
 */
export async function clearHiddenMarks(bytes: Uint8Array): Promise<Uint8Array> {
  return invokeAsync('clearHiddenMarks', [bytes, Date.now()]) as never
}
