// Host steps of file-parse: PDF text, the parse5 half of html-redaction, and
// the readers of the engines not ported (odt, xmind, draw.io, EPUB opening).
export const FILEPARSE_STEPS: Record<string, (input: unknown) => unknown> = {}
