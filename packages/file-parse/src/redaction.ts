/**
 * What a reader outside this package needs to keep text hidden from AI out of
 * what it hands over (the command line's `slides read` and `sheet read`). A
 * subpath of its own so such a reader does not load every format parser.
 */
export { redactPptxPartXml } from './pptx-redaction'
export { xlsxWithheldCells } from './xlsx'
export { UNKNOWN_CELL_MARKER } from './xlsx-redaction'
export { RedactionMarkError } from './redaction-error'
