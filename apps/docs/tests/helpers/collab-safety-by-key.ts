/**
 * TEST ORACLE, not product code: the co-editing safety rules as they stood
 * before attributes were classed by `src/web/collab-attr-classes.ts` (the
 * file at 239c9bbf5, unchanged but for this note and one import path). It
 * judged a node's and a mark's attributes by the key's name. Kept so
 * `collab-attr-classes.test.ts` can show the table refuses everything these
 * rules refused. Do not fix or extend it.
 *
 * What a peer sends is untrusted: one editor's steps and outside-state
 * entries reach every page of the session, viewers included. The renderer
 * writes some attribute values into the DOM as markup (MathML through
 * innerHTML), as URLs (link targets, picture sources, CSS `url()`) and as
 * style text (colours, faces and sizes concatenated into `style`). The same
 * rules judge both directions: a remote value is made safe before the editor
 * or the App sees it, and a local edit holding a value they would change is
 * refused, so no page ever holds a value another page would replace and
 * every page saves the same file.
 *
 * Values are judged by the key that holds them, at any depth of a node's or
 * mark's attributes (nested table, chart, text box and header models carry
 * the same keys):
 * - `mathml` is rebuilt from the `omml` beside it with the converter that
 *   made it in the first place, so a legitimate equation comes out unchanged.
 * - link targets keep the schemes a document's hyperlinks use (http, https,
 *   mailto, tel, ftp, file) and scheme-less targets (relative paths, `#`
 *   anchors); a script-running scheme (javascript, vbscript, data) does not.
 * - picture sources keep the data URLs the app makes: base64 raster images,
 *   and SVG shapes (percent-encoded, as the VML and drawing readers write
 *   them) made only of drawing elements.
 * - free text, OOXML and JSON-carrying keys stay as they are (JSON is read
 *   and its values judged by their own keys); the renderer shows them as
 *   text, data attributes and titles only.
 * - every other string is a style token (a colour, a face, a size, an id) and
 *   must not be able to end a CSS declaration, open a string or a comment,
 *   or load anything.
 * A value that fails is replaced by an inert one ('' or nothing), the same on
 * every page. An object key that names the prototype chain cannot be made
 * safe: `UnsafeValue` is thrown.
 */
import { ommlToMathML } from '@seuoffice/docx-engine'
import type { Json } from '@seuoffice/collab/client'
import { inlineMathML } from '../../src/renderer/editor/equation'

type JsonObject = { [key: string]: Json }

/** text shown as text, titles or data attributes; never part of style, markup or a URL */
const FREE_TEXT = new Set([
  'text',
  'texts',
  'tokens',
  'left',
  'right',
  'num',
  'title',
  'name',
  'categories',
  'label',
  'previewText',
  'tooltip',
  'instr',
  'term',
  'base',
  'rt',
  'latex',
  'author',
  'initials',
  'altText',
  'caption',
  'description',
  'tblCaption',
  'tblDescription',
  'imageLeadingText',
  'headerText',
  'footerText',
  'blockText',
  'alias',
  'tag',
  'placeholder',
  'numFmt',
  'customFormat',
  'formatCode',
  'omml',
  'sdtPr',
])

/**
 * OOXML fragments, and the opened table's signatures the save compares
 * against (`originalStructure`), kept for the save; the renderer only tests
 * or stores them
 */
const XML_KEY = /xml$|^raw|^original/i
const LINK_KEY = /href$/i
const PICTURE_KEY = /(src|url)$/i
/** a token that could end a declaration, open a string, block or comment, or load something */
const UNSAFE_TOKEN =
  /[;"'{}\\<>\n\r\f]|\/\*|url\s*\(|image-set|expression\s*\(|@import|javascript:/i
/** a scheme a document's hyperlink may use; any other (javascript:, data:) is refused */
const LINK_SCHEMES = new Set(['http', 'https', 'mailto', 'tel', 'ftp', 'file'])
/** keys that reach an object's prototype when an App or renderer copies the object */
const RESERVED = new Set(['__proto__', 'constructor', 'prototype'])
/**
 * Nesting no document reaches: the deepest fixture (tables nested in tables)
 * is 53 levels, and Word nests tables far deeper than any of them
 */
const MAX_DEPTH = 512

/** A value no rule can make safe */
export class UnsafeValue extends Error {}
const RASTER = /^data:image\/(?!svg)[a-z0-9.+-]+;base64,[a-z0-9+/]*=*$/i
/** what encodeURIComponent leaves: no quote or backslash, so the URL is safe in `url("...")` too */
const SVG_URL = /^data:image\/svg\+xml(?:;charset=utf-8)?,([a-z0-9\-_.!~*'()%]*)$/i
const SVG_ELEMENTS = new Set([
  'svg',
  'g',
  'defs',
  'linearGradient',
  'radialGradient',
  'stop',
  'path',
  'rect',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'text',
  'tspan',
  'title',
  'desc',
  'clipPath',
])

export interface Safety {
  /** only links, pictures and markup: entries the App shows through React alone */
  urlsOnly?: boolean
}

/**
 * The step's JSON with every value it brings safe: the same object when
 * nothing needed changing. `Step.fromJSON` still rejects a malformed one.
 */
export function safeStep(step: Json): Json {
  wellFormed(step, 0)
  // only the step itself sets an attribute: a step-shaped object anywhere below is plain data
  return isObject(step) ? safeObject(step, {}, false, true) : step
}

/** A node or mark JSON, judged as a step's content is */
export function safeNode(node: Json, how: Safety): Json {
  wellFormed(node, 0)
  return safeValue(node, '', how)
}

/**
 * Throws `UnsafeValue` for what no rule can make safe and the renderer would
 * trip over on every replay: a key naming the prototype chain, a number JSON
 * cannot hold (`1e999` parses to Infinity), nesting deeper than any document.
 */
function wellFormed(json: Json, depth: number): void {
  if (depth > MAX_DEPTH) throw new UnsafeValue('nested deeper than any document')
  if (typeof json === 'number') {
    if (!Number.isFinite(json)) throw new UnsafeValue(`not a finite number: ${json}`)
  } else if (Array.isArray(json)) {
    for (const item of json) wellFormed(item, depth + 1)
  } else if (isObject(json)) {
    for (const [key, value] of Object.entries(json)) {
      if (RESERVED.has(key)) throw new UnsafeValue(`a reserved key: ${key}`)
      wellFormed(value, depth + 1)
    }
  }
}

/**
 * An outside-state entry's value, judged as the attributes are. Its key's
 * parts become App field and record keys (`style:<styleId>`), so a reserved
 * one throws as a reserved key inside the value does.
 */
export function safeEntry(key: string, value: Json, how: Safety = {}): Json {
  for (const part of key.split(':'))
    if (RESERVED.has(part)) throw new UnsafeValue(`a reserved entry key: ${key}`)
  wellFormed(value, 0)
  // the bibliography and Zotero data are free text the App shows through React
  const urlsOnly = how.urlsOnly || key === 'sources' || key === 'zotero'
  return safeValue(value, key, { ...how, urlsOnly })
}

/**
 * Every key of `object` judged, whatever shape it has: a node (`type` and
 * `attrs`) gets no pass for its other keys. `inline`: the attributes of an
 * inline formula, whose markup is the inline form of its OMML (display
 * math-style when its `display` attribute is set); a display
 * equation's (`formulaDisplay`) is the block form. `step`: `object` is the
 * step itself, whose `value` an attribute step judges as the attribute it sets.
 */
function safeObject(object: JsonObject, how: Safety, inline = false, step = false): JsonObject {
  let out = object
  const node = typeof object.type === 'string'
  const attrStep = step && (object.stepType === 'attr' || object.stepType === 'docAttr')
  for (const [key, value] of Object.entries(object)) {
    if (key === 'mathml') continue
    let next: Json
    if (key === 'attrs' && node && isObject(value)) {
      next = safeObject(value, how, object.type === 'docInlineMath')
    } else if (key === 'value' && attrStep && typeof object.attr === 'string') {
      // no edit sets an equation's markup alone: it always comes with its OMML
      next =
        object.attr === 'mathml'
          ? value === '' || value === null
            ? value
            : ''
          : safeValue(value, object.attr, how)
    } else {
      next = safeValue(value, key, how)
    }
    if (next !== value) out = { ...out, [key]: next }
  }
  if (Object.hasOwn(object, 'mathml')) {
    // The markup is a pure function of the OMML: the same converter makes it on every page.
    // Anything but a string (an array, an object) would reach innerHTML through String().
    const markup = object.mathml
    const omml = typeof object.omml === 'string' ? object.omml : ''
    const mathml =
      markup === null
        ? null
        : typeof markup === 'string' && markup && omml
          ? rebuilt(omml, inline, inline && object.display === true)
          : ''
    if (mathml !== markup) out = { ...out, mathml }
  }
  return out
}

function safeValue(value: Json, key: string, how: Safety): Json {
  if (Array.isArray(value)) {
    const items = value.map((item) => safeValue(item, key, how))
    return items.some((item, i) => item !== value[i]) ? items : value
  }
  if (isObject(value)) return safeObject(value, how)
  if (typeof value !== 'string') return value
  if (LINK_KEY.test(key)) return safeLink(value) ? value : ''
  if (PICTURE_KEY.test(key)) return safePicture(value)
  // a numbering format's text is drawn as an attribute and inside a CSS string
  // (`cssString` escapes quotes and backslashes): only a line break would end that string
  if (key === 'lvlText') return /[\n\r\f]/.test(value) ? '' : value
  if (how.urlsOnly || FREE_TEXT.has(key) || XML_KEY.test(key)) return value
  const json = jsonIn(value)
  if (json !== undefined) {
    wellFormed(json, 0)
    const next = safeValue(json, key, how)
    return next === json ? value : JSON.stringify(next)
  }
  return UNSAFE_TOKEN.test(value) ? '' : value
}

function safeLink(href: string): boolean {
  // a browser drops tabs, newlines and leading controls before it reads the scheme
  const bare = Array.from(href)
    .filter((char) => char > ' ' && char !== '\u007f')
    .join('')
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(bare)
  return !scheme || LINK_SCHEMES.has(scheme[1].toLowerCase())
}

function safePicture(url: string): string {
  if (url === '' || RASTER.test(url)) return url
  const svg = SVG_URL.exec(url)
  if (!svg) return ''
  let markup: string
  try {
    markup = decodeURIComponent(svg[1])
  } catch {
    return ''
  }
  return drawingOnly(markup) ? url : ''
}

/** An SVG made of drawing elements only: no script, style sheet, foreign content, link or load */
function drawingOnly(markup: string): boolean {
  const doc = new DOMParser().parseFromString(markup, 'image/svg+xml')
  if (doc.getElementsByTagName('parsererror').length > 0) return false
  const loads = (text: string) => /url\s*\(\s*['"]?\s*[^#'"\s]|javascript:|@import/i.test(text)
  const elements = [doc.documentElement, ...doc.documentElement.querySelectorAll('*')]
  for (const element of elements) {
    if (element.namespaceURI !== 'http://www.w3.org/2000/svg') return false
    if (!SVG_ELEMENTS.has(element.localName)) return false
    for (const { name, value } of element.attributes) {
      if (/^on/i.test(name)) return false
      if (/(^|:)href$/i.test(name) && !value.startsWith('#')) return false
      if (loads(value)) return false
    }
  }
  return true
}

/** MathML from OMML, memoised: every step that copies an equation (a paste, an undo) asks again */
const mathml = new Map<string, string>()
function rebuilt(omml: string, inline: boolean, display: boolean): string {
  const key = `${inline ? (display ? 'd' : 'i') : 'b'}${omml}`
  let markup = mathml.get(key)
  if (markup === undefined) {
    markup = inline ? inlineMathML(omml, display) : ommlToMathML(omml)
    if (mathml.size >= 2000) mathml.clear()
    mathml.set(key, markup)
  }
  return markup
}

function jsonIn(text: string): Json | undefined {
  if (!/^\s*[[{]/.test(text)) return undefined
  try {
    return JSON.parse(text) as Json
  } catch {
    return undefined
  }
}

function isObject(value: Json | undefined): value is JsonObject {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
