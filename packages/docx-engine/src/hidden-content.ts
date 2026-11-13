import { invokeAsync } from './engine'

/** Whether any part of the package (body, headers, footers, comments, notes) holds the mark. */
export async function docxHoldsHiddenContent(bytes: Uint8Array): Promise<boolean> {
  return invokeAsync('docxHoldsHiddenContent', [bytes]) as never
}
/**
 * The package with every mark taken off: the words stay, readable by anyone.
 * The namespace declaration stays too (an ignorable prefix must stay declared).
 * The marks are cut out of each part as it is: the decoded copy only tells
 * whether a trace is left (a name never holds a reference, so every mark
 * element is found in the part's own bytes), and the rest of the part keeps
 * every byte, its character references included. Throws when a trace of the
 * mark is left in a part, so that a copy never claims to be clear when it is not.
 */
export async function clearHiddenMarks(bytes: Uint8Array): Promise<Uint8Array> {
  return invokeAsync('clearHiddenMarks', [bytes, Date.now()]) as never
}
