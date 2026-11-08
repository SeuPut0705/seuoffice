import { WebUnsupportedError } from '@seuoffice/web-platform'

/**
 * The web build's stand-in for the save stages in src/main that need desktop
 * engines (pdfium with system fonts, the file system). The web config points
 * those modules here; the web save refuses requests that reach them, so a call
 * means a request part the refusal missed.
 */
const desktopOnly =
  (stage: string) =>
  (..._args: unknown[]): never => {
    throw new WebUnsupportedError(`pdf.save ${stage}`)
  }

// ./atomic-write
export const writePdfAtomically = desktopOnly('write file')
// ./redaction
export const redactPdf = desktopOnly('redaction')
// ./text-edit
export const applyTextEdits = desktopOnly('text edits')
export const applyTextInserts = desktopOnly('text inserts')
export const verifyTextEdits = desktopOnly('text edits')
// ./image-edit
export const applyImageEdits = desktopOnly('image edits')
export const verifyImageEdits = desktopOnly('image edits')
// ./annot-delete
export const applyAnnotDeletes = desktopOnly('annotation removal')
// ./annot-flatten
export const flattenAnnotsBytes = desktopOnly('flatten annotations')
