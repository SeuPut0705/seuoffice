import type { XmindSheet } from './types'

/**
 * Reads a JSON entry such as `content.json`. Throws when the bytes are not
 * UTF-8 or not JSON.
 *
 * Decoding is strict: a lenient decoder would swap broken bytes for a
 * replacement character, and the next save would write that into the file. A
 * leading byte order mark is dropped.
 */
export function parseJsonBytes(bytes: Uint8Array): unknown {
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
}

/**
 * `content.json` the way the format is written: one line of JSON, no byte order
 * mark. Throws for a tree that cannot be written (nested too deep, or cyclic).
 *
 * Parsing and writing with the platform's JSON keeps every value as it was:
 * unknown keys, key order, strings and any number a double holds exactly. The
 * program the format comes from writes the same way, so its files round-trip
 * to the letter. Two things can differ in a file from elsewhere once it is
 * rewritten: digits beyond a double's precision, and keys that are whole
 * numbers, which sort to the front of their object.
 */
export function serializeSheets(sheets: readonly XmindSheet[]): string {
  return JSON.stringify(sheets)
}
