import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import { REDACT_NAMESPACES } from '@seuoffice/agent-core/redact-range'
import { REDACT_EXT_URI } from '@seuoffice/pptx-engine'
import JSZip from 'jszip'
import { CliError, EXIT } from '../result'
import { decodeText } from '../fs'
import { decodeHtmlBytes } from './html-text'
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

const RELATIONSHIP = /<Relationship\b(?:[^>"']|"[^"]*"|'[^']*')*>/g
const attribute = (tag: string, name: string): string | undefined =>
  new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i')
    .exec(tag)
    ?.slice(1)
    .find((v) => v !== undefined)

/** where a relationship's target is, in the package, from the part that names it */
function resolveTarget(from: string, target: string): string {
  const parts = (
    target.startsWith('/') ? target.slice(1) : `${from.replace(/[^/]*$/, '')}${target}`
  ).split('/')
  const out: string[] = []
  for (const part of parts) {
    if (part === '..') out.pop()
    else if (part !== '.' && part !== '') out.push(part)
  }
  return out.join('/')
}

/** the parts a package part points at through its relationships, internal ones only */
async function relatedParts(zip: JSZip, part: string): Promise<string[]> {
  const rels = zip.file(part.replace(/([^/]*)$/, '_rels/$1.rels'))
  if (!rels) return []
  const xml = await rels.async('string')
  return [...xml.matchAll(RELATIONSHIP)]
    .filter((m) => attribute(m[0], 'TargetMode')?.toLowerCase() !== 'external')
    .map((m) => attribute(m[0], 'Target'))
    .filter((t): t is string => t !== undefined)
    .map((t) => resolveTarget(part, t))
}

/**
 * What the renderer draws for a slide besides its own XML: the chart parts (their titles, axis
 * titles and data labels are rich text) and the diagram parts (SmartArt data and drawing) the
 * slide points at, and the drawings those charts point at in turn (user shapes).
 */
async function drawnWith(zip: JSZip, slide: string): Promise<string[]> {
  const direct = (await relatedParts(zip, slide)).filter((p) =>
    /^ppt\/(?:charts|diagrams|drawings)\/.*\.xml$/.test(p),
  )
  const nested = await Promise.all(direct.map((p) => relatedParts(zip, p)))
  return [
    ...direct,
    ...nested.flat().filter((p) => /^ppt\/(?:drawings|diagrams)\/.*\.xml$/.test(p)),
  ]
}

async function deckHoldsMark(
  zip: JSZip,
  bytes: Uint8Array,
  only: number | undefined,
): Promise<boolean> {
  const opened = await openDeck(bytes).catch(() => null)
  // a deck the engine cannot lay out is judged by every slide part it holds
  const slides = opened
    ? opened.deck.slides
        .filter((_, index) => only === undefined || index === only)
        .map((s) => s.path)
    : Object.keys(zip.files).filter((p) => /^ppt\/slides\/[^/]+\.xml$/.test(p))
  for (const slide of slides) {
    if (await anyMarkIn(zip, [slide, ...(await drawnWith(zip, slide))])) return true
  }
  return false
}

async function documentHoldsMark(zip: JSZip): Promise<boolean> {
  // every part of the document, comments and notes included: the printer may draw any of them
  return anyMarkIn(
    zip,
    Object.keys(zip.files).filter((p) => /^word\/.*\.xml$/.test(p)),
  )
}

const HOLDERS = ['pptx', 'docx', 'xlsx', 'xlsm', 'md', 'markdown', 'html', 'htm']

/** the HTML app's three marks: an element, an attribute's value, a script literal (apps/html marked-html.ts) */
const HTML_MARK = /data-gx-redact|gx:redact:/i
/** the markdown app's persisted span (apps/markdown editor/Redaction.ts) */
const MARKDOWN_MARK = /<span\b[^>]*\bdata-redaction\b/i

/** Whether a Markdown file's text holds a span hidden from AI. */
export function markdownHoldsMark(text: string): boolean {
  return MARKDOWN_MARK.test(text)
}

/** Whether an HTML page's text holds any mark of the HTML app. */
export function htmlHoldsMark(text: string): boolean {
  return HTML_MARK.test(text)
}

/** Whether `path` (or its slide `only`, 0-based, of a deck) holds content hidden from AI. */
export async function holdsHiddenContent(path: string, only?: number): Promise<boolean> {
  const ext = extname(path).slice(1).toLowerCase()
  if (!HOLDERS.includes(ext)) return false
  const bytes = new Uint8Array(await readFile(path))
  if (ext === 'md' || ext === 'markdown') return markdownHoldsMark(decodeText(bytes))
  if (ext === 'html' || ext === 'htm') return htmlHoldsMark(decodeHtmlBytes(bytes))
  if (ext === 'pptx' || ext === 'docx') {
    // not a package at all: it holds no mark, and the route that reads it fails as it always did
    const zip = await JSZip.loadAsync(bytes).catch(() => null)
    if (!zip) return false
    return ext === 'pptx' ? deckHoldsMark(zip, bytes, only) : documentHoldsMark(zip)
  }
  return (await withheldCellsIn(bytes)) !== null
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
