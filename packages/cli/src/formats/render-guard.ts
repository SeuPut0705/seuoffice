import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import { REDACT_NAMESPACES } from '@seuoffice/agent-core/redact-range'
import { REDACT_EXT_URI } from '@seuoffice/pptx-engine'
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
 * hides. A part is judged by the mark's traces in its XML (the namespace the mark is
 * written in, a `redact` element, the deck extension's id), so a spelling the readers do
 * not understand still counts.
 */

const NUMERIC_REFERENCE = /&#(?:x([0-9a-fA-F]+)|(\d+));/g

/** the part's XML with numeric references spelled out, so a reference cannot hide a namespace */
function spelledOut(xml: string): string {
  if (!xml.includes('&#')) return xml
  return xml.replace(NUMERIC_REFERENCE, (all, hex: string | undefined, dec: string | undefined) => {
    const code = hex === undefined ? Number(dec) : Number.parseInt(hex, 16)
    return code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : all
  })
}

function holdsMark(xml: string): boolean {
  const text = spelledOut(xml)
  return (
    REDACT_NAMESPACES.some((ns) => text.includes(ns)) ||
    text.includes(REDACT_EXT_URI) ||
    /<(?:[\w.-]+:)?redact[\s/>]/.test(text)
  )
}

async function anyMarkIn(zip: JSZip, paths: string[]): Promise<boolean> {
  for (const path of paths) {
    const part = zip.file(path)
    if (part && holdsMark(await part.async('string'))) return true
  }
  return false
}

async function deckHoldsMark(bytes: Uint8Array, only: number | undefined): Promise<boolean> {
  const zip = await JSZip.loadAsync(bytes)
  const opened = await openDeck(bytes).catch(() => null)
  // a deck the engine cannot lay out is judged by every slide part it holds
  const slides = opened
    ? opened.deck.slides
        .filter((_, index) => only === undefined || index === only)
        .map((s) => s.path)
    : Object.keys(zip.files).filter((p) => /^ppt\/slides\/[^/]+\.xml$/.test(p))
  return anyMarkIn(zip, slides)
}

async function documentHoldsMark(bytes: Uint8Array): Promise<boolean> {
  const zip = await JSZip.loadAsync(bytes)
  const drawn = Object.keys(zip.files).filter((p) =>
    /^word\/(?:document|header\d*|footer\d*|footnotes|endnotes)\.xml$/.test(p),
  )
  return anyMarkIn(zip, drawn)
}

/**
 * Throws when rendering `path` (or its page `only`, a 0-based slide of a deck) would draw
 * content hidden from AI.
 */
export async function refuseHiddenContent(path: string, only?: number): Promise<void> {
  const ext = extname(path).slice(1).toLowerCase()
  if (!['pptx', 'docx', 'xlsx', 'xlsm'].includes(ext)) return
  const bytes = new Uint8Array(await readFile(path))
  const holds =
    ext === 'pptx'
      ? await deckHoldsMark(bytes, only)
      : ext === 'docx'
        ? await documentHoldsMark(bytes)
        : (await withheldCellsIn(bytes)) !== null
  if (!holds) return
  throw new CliError(
    EXIT.usage,
    `cannot render ${path}: it holds content hidden from AI, and a picture of the page would show it`,
    undefined,
    {
      reason: 'unsupported',
      suggestion:
        ext === 'pptx' && only === undefined
          ? 'render a slide that holds none (--page), or read the document with its read command, which gives a placeholder for the hidden content'
          : 'read the document with its read command, which gives a placeholder for the hidden content',
    },
  )
}
