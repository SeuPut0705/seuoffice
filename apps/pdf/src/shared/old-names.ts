/**
 * Spellings an earlier version wrote into PDF files (decision 0024). A saved
 * PDF keeps them for ever, so readers accept them beside the current ones.
 */

/** Start of the /Contents of a visual signature, before the name of the field it signs */
export const OLD_VISUAL_SIGNATURE_CONTENT_PREFIXES: readonly string[] = [
  'GenOffice visual signature field: ',
]
