/**
 * A file carries a "withheld from the model" mark this reader could not turn
 * into a `{{label}}` marker.
 *
 * Everything in this package that honours such marks fails closed: when a mark
 * is there and what it withholds cannot be pinned down, the text is not handed
 * over at all. `parseFileToText` turns this into `{ ok: false, error }`; the
 * per-format functions let it throw. Returning the original text instead would
 * send exactly the words the reader chose to keep from a model.
 */
export class RedactionMarkError extends Error {
  constructor(detail: string) {
    super(`Redaction marks in this file could not be processed (${detail}); the file was not read`)
    this.name = 'RedactionMarkError'
  }
}
