/** File formats the Word editor opens and saves; the extension decides which. */
export type DocFormat = 'docx' | 'odt'

/** Save As choices: the document's own formats, or a copy written by an export */
export type SaveAsKind = DocFormat | 'pdf' | 'hwp' | 'hwpx' | 'html' | 'md' | 'png'

/**
 * A format that cannot hold the mark that hides content from AI: what is
 * written reads as plain words to every reader. `hwp` stands for .hwp and .hwpx.
 */
export type MarkedExportFormat = 'odt' | 'pdf' | 'hwp' | 'html' | 'md' | 'png'

/** `.docx` → docx, `.odt` → odt, anything else → null (not a Word-editor document) */
export function docFormatOfPath(filePath: string): DocFormat | null {
  if (/\.docx$/i.test(filePath)) return 'docx'
  if (/\.odt$/i.test(filePath)) return 'odt'
  return null
}

/**
 * Legacy Word 97-2003 `.doc`/`.dot`: the Word editor opens one only as a
 * converted `.docx` copy (docs-main prepareDocumentForOpen), never in place.
 */
export function isWord97Path(filePath: string): boolean {
  return /\.(doc|dot)$/i.test(filePath)
}

export function findDocxPath(argv: readonly string[]): string | null {
  return (
    argv.find((arg) => {
      const value = arg.trim()
      return (
        value.length > 0 &&
        !value.startsWith('-') &&
        (docFormatOfPath(value) !== null || isWord97Path(value))
      )
    }) ?? null
  )
}
