import { readFile } from 'node:fs/promises'
import { extname, posix } from 'node:path'
import {
  fileHoldsHiddenContent,
  HIDDEN_CONTENT_EXTENSIONS,
  packageHoldsMark,
  xmlHoldsMark,
} from '@seuoffice/file-parse/hidden-content'
import JSZip from 'jszip'
import { CliError, EXIT } from '../result'
import { openDeck } from './pptx'
import { withheldCellsIn } from './xlsx'

/**
 * A picture of a page is something no placeholder can stand in for: the renderer draws the
 * words a person hid from AI. Rendering is for the agent's eyes (the PNGs come back as
 * images), so a document that holds hidden content is not rendered, the way the slide
 * editor sends the model no screenshot of a slide that withholds anything.
 *
 * This runs before the app is started, and reads only whether a mark is there, not what it
 * hides (@seuoffice/file-parse/hidden-content, which the app's own headless export reads too).
 */

/**
 * A slide's own part and the SmartArt parts it points to: a diagram's words
 * (and their marks) live in its data part, which the slide draws from.
 */
async function slideParts(zip: JSZip, slidePath: string): Promise<string[]> {
  const relsPath = slidePath.replace(/([^/]+)$/, '_rels/$1.rels')
  const rels = (await zip.file(relsPath)?.async('string')) ?? ''
  const targets = [...rels.matchAll(/\bTarget\s*=\s*(?:"([^"]*)"|'([^']*)')/g)]
    .map((m) => posix.normalize(posix.join(posix.dirname(slidePath), m[1] ?? m[2] ?? '')))
    .filter((path) => path.startsWith('ppt/diagrams/'))
  return [slidePath, ...targets]
}

/** a deck's slides (or its slide `only`), a deck the engine cannot lay out judged by every slide and diagram part */
async function deckHoldsMark(bytes: Uint8Array, only: number | undefined): Promise<boolean> {
  const zip = await JSZip.loadAsync(bytes).catch(() => null)
  if (!zip) return false
  const opened = await openDeck(bytes).catch(() => null)
  if (!opened) return packageHoldsMark(zip, /^ppt\/(?:slides|diagrams)\/[^/]+\.xml$/)
  for (const [index, slide] of opened.deck.slides.entries()) {
    if (only !== undefined && index !== only) continue
    for (const path of await slideParts(zip, slide.path)) {
      const part = zip.file(path)
      if (part && xmlHoldsMark(await part.async('string'))) return true
    }
  }
  return false
}

/** Whether `path` (or its slide `only`, 0-based, of a deck) holds content hidden from AI. */
export async function holdsHiddenContent(path: string, only?: number): Promise<boolean> {
  const ext = extname(path).slice(1).toLowerCase()
  if (!HIDDEN_CONTENT_EXTENSIONS.includes(ext)) return false
  const bytes = new Uint8Array(await readFile(path))
  // the command line's own errors for a workbook record it cannot read
  if (ext === 'xlsx' || ext === 'xlsm') return (await withheldCellsIn(bytes)) !== null
  if (ext === 'pptx') return deckHoldsMark(bytes, only)
  return fileHoldsHiddenContent(bytes, ext)
}

/**
 * Throws when `action` (rendering `path`, or its page `only`; or writing a copy of it in another
 * format) would hand over content hidden from AI that no placeholder can stand in for.
 */
export async function refuseHiddenContent(
  path: string,
  only?: number,
  action = 'render',
  alternative = 'read the document with its read command, which gives a placeholder for the hidden content',
): Promise<void> {
  if (!(await holdsHiddenContent(path, only))) return
  throw new CliError(
    EXIT.usage,
    `cannot ${action} ${path}: it holds content hidden from AI, and the result would show it`,
    undefined,
    {
      reason: 'unsupported',
      suggestion:
        extname(path).toLowerCase() === '.pptx' && only === undefined && action === 'render'
          ? `render a slide that holds none (--page), or ${alternative}`
          : alternative,
    },
  )
}
