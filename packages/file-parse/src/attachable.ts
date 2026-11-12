/**
 * One shared attachable-format list for every editor's main process. The set
 * docs-main accepted before this list moved here is the baseline: the AI panel
 * shows what may be attached, so every editor must accept the same files.
 */
import { callEngine } from './engine'

/** plain-text extensions read as UTF-8 */
const TEXT_EXTS = [
  'txt',
  'md',
  'markdown',
  'csv',
  'tsv',
  'json',
  'yaml',
  'yml',
  'xml',
  'html',
  'htm',
  'log',
  'js',
  'ts',
  'tsx',
  'jsx',
  'py',
  'java',
  'c',
  'h',
  'cpp',
  'go',
  'rs',
  'rb',
  'sh',
  'sql',
  'css',
]

/** image extensions sent to the model as pictures, not extracted as text */
export const ATTACHABLE_IMAGE_EXTS: ReadonlySet<string> = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
])

/**
 * draw.io diagrams, read as the read table of their pages. The two picture
 * forms are known by their double extension (`diagramPictureExtOf`), so a
 * `.drawio.png` that holds its diagram is not taken for a picture; `.vsdx` is
 * not read.
 */
const DIAGRAM_EXTS = ['drawio', 'dio', 'drawio.svg', 'drawio.png']

/** the double extension of a draw.io diagram kept inside a picture */
export type DiagramPictureExt = 'drawio.svg' | 'drawio.png'

/**
 * `drawio.svg`/`drawio.png` when the file name ends so (any case), else null.
 * Only the name: whether the picture holds its diagram is for
 * `diagramPictureExtOf`, which reads the file.
 */
export function diagramPictureExtOfName(fileName: string): DiagramPictureExt | null {
  return callEngine<DiagramPictureExt | null>('diagramPictureExtOfName', [fileName])
}

/** office/pdf formats get text extracted via `parseFileToText`; images skip extraction and go multimodal */
export const ATTACHABLE_EXTS: ReadonlySet<string> = new Set([
  ...TEXT_EXTS,
  'doc',
  'docx',
  'odt',
  'pdf',
  'pptx',
  'ppt',
  'xlsx',
  'xlsm',
  'xls',
  'xmind',
  'hwp',
  'hwpx',
  'epub',
  ...DIAGRAM_EXTS,
  ...ATTACHABLE_IMAGE_EXTS,
])

/** the largest file read whole as an attachment (the formats `attachableMaxBytes` leaves uncapped excepted) */
export const ATTACHABLE_MAX_BYTES = 50 * 1024 * 1024
/** the largest picture sent to the model with a message */
export const ATTACHABLE_IMAGE_MAX_BYTES = 5 * 1024 * 1024

/**
 * The largest file with this extension that is read for the AI: a picture's
 * cap, no cap (`Infinity`) for the formats read at any size (zip-based
 * documents past `WHOLE_ZIP_READ_MAX_BYTES` are read for their text parts only,
 * a PDF's text without its images), else `ATTACHABLE_MAX_BYTES`.
 */
export function attachableMaxBytes(ext: string): number {
  // Infinity crosses as its spelling
  return Number(callEngine<number | string>('attachableMaxBytes', [ext]))
}

/** whether a file with this extension (with or without a leading dot) may be attached */
export function isAttachableExt(ext: string): boolean {
  return callEngine<boolean>('isAttachableExt', [ext])
}
