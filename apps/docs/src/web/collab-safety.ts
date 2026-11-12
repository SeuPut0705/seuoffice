/**
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
 * A step's nodes and marks are judged by `collab-attr-classes.ts`: the class
 * written there for each attribute of each node and mark type. An attribute
 * that table does not name is dropped, a node or mark type it does not name
 * cannot be made safe, and nothing is judged by what its name looks like.
 *
 * Outside-state entries (headers, comments, styles, numbering) are judged by
 * the key that holds each value, at any depth:
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
import { ommlToMathML } from '@genoffice/docx-engine'
import type { Json } from '@seuoffice/collab/client'
import { inlineMathML } from '../renderer/editor/equation'
import { MARK_ATTRS, NODE_ATTRS, type AttrClass, type Fields } from './collab-attr-classes'

type JsonObject = { [key: string]: Json }

/** an entry's text shown as text, titles or data attributes; never part of style, markup or a URL */
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
 * an entry's OOXML fragments, kept for the save; the renderer only tests or
 * stores them (`oldRPr`: a run's properties before a tracked format change)
 */
const XML_KEY = /xml$|^raw|^original|^oldRPr$/i
const LINK_KEY = /href$/i
const PICTURE_KEY = /(src|url)$/i
/** a token that could end a declaration, open a string, block or comment, or load something */
const UNSAFE_TOKEN =
  /[;"'{}\\<>\n\r\f]|\/\*|url\s*\(|image-set|expression\s*\(|@import|javascript:/i
/** what ends a CSS string whose quotes and backslashes are escaped */
const LINE_BREAK = /[\n\r\f]/
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

/** inside a value whose own class is a leaf, every name is a token */
const NO_FIELDS: Fields = {}

/**
 * The class of a node attribute by its name alone: an attribute step names
 * the attribute but not the node type. `null` where two node types give one
 * name different classes: such a step cannot be judged, so it is refused
 * (the table's test keeps every name to one class).
 */
const ATTR_BY_NAME = new Map<string, AttrClass | null>()
for (const fields of Object.values(NODE_ATTRS)) {
  for (const [name, cls] of Object.entries(fields)) {
    const seen = ATTR_BY_NAME.get(name)
    ATTR_BY_NAME.set(name, seen === undefined || seen === cls ? cls : null)
  }
}

/**
 * The step's JSON with every value it brings safe: the same object when
 * nothing needed changing. `Step.fromJSON` still rejects a malformed one.
 */
export function safeStep(step: Json): Json {
  wellFormed(step, 0)
  if (!isObject(step)) return step
  const attrStep = step.stepType === 'attr' || step.stepType === 'docAttr'
  return changed(step, (key, value) => {
    if (key === 'slice' && isObject(value)) {
      return changed(value, (part, content) =>
        part === 'content' ? nodes(content) : judge(content, 'token', NO_FIELDS),
      )
    }
    if (key === 'mark') return safeMark(value)
    if (key === 'value' && attrStep) return attrValue(step.stepType, step.attr, value)
    // positions, flags, the step's type and the attribute's name
    return judge(value, 'token', NO_FIELDS)
  })
}

/** A node's JSON (a document, a block), judged as a step's content is */
export function safeNode(node: Json): Json {
  wellFormed(node, 0)
  return nodeOf(node)
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

/** the value an attribute step sets, judged as that attribute of the node it lands on */
function attrValue(stepType: Json, attr: Json, value: Json): Json {
  const cls =
    typeof attr !== 'string'
      ? undefined
      : stepType === 'docAttr'
        ? own(NODE_ATTRS.doc, attr)
        : ATTR_BY_NAME.get(attr)
  // an attribute the schema lacks sets nothing; one the table cannot class is refused
  if (!cls) return null
  // no edit sets an equation's markup alone: it always comes with its OMML
  if (cls === 'mathml' || cls === 'inlineMathml') return value === '' || value === null ? value : ''
  return judge(value, cls, NO_FIELDS)
}

function nodes(content: Json): Json {
  return Array.isArray(content) ? same(content, nodeOf) : judge(content, 'token', NO_FIELDS)
}

/** A node as ProseMirror reads it: its type, attributes, marks, text and children */
function nodeOf(node: Json): Json {
  if (!isObject(node)) return judge(node, 'token', NO_FIELDS)
  const fields = typeof node.type === 'string' ? own(NODE_ATTRS, node.type) : undefined
  if (!fields) throw new UnsafeValue(`not a node of the schema: ${String(node.type)}`)
  return changed(node, (key, value) => {
    if (key === 'type') return value
    if (key === 'attrs') return attrsOf(value, fields)
    if (key === 'content') return nodes(value)
    if (key === 'marks' && Array.isArray(value)) return same(value, safeMark)
    // a text node's words: ProseMirror draws them as text
    if (key === 'text' && typeof value === 'string') return value
    // nothing else of a node reaches the editor
    return judge(value, 'token', NO_FIELDS)
  })
}

function safeMark(mark: Json): Json {
  if (!isObject(mark)) return judge(mark, 'token', NO_FIELDS)
  const fields = typeof mark.type === 'string' ? own(MARK_ATTRS, mark.type) : undefined
  if (!fields) throw new UnsafeValue(`not a mark of the schema: ${String(mark.type)}`)
  return changed(mark, (key, value) =>
    key === 'type'
      ? value
      : key === 'attrs'
        ? attrsOf(value, fields)
        : judge(value, 'token', NO_FIELDS),
  )
}

/**
 * A node's or mark's attributes: each judged by its class, one the table
 * lacks dropped. Nothing below an attribute is judged by this table: the
 * names inside a value are the value's own.
 */
function attrsOf(attrs: Json, fields: Fields): Json {
  if (!isObject(attrs)) return judge(attrs, 'token', NO_FIELDS)
  let out = attrs
  for (const [key, value] of Object.entries(attrs)) {
    const cls = own(fields, key)
    const next = cls ? field(attrs, value, cls, NO_FIELDS) : undefined
    if (next === value) continue
    if (out === attrs) out = { ...attrs }
    if (next === undefined) delete out[key]
    else out[key] = next
  }
  return out
}

/**
 * `value` judged as `cls`. An array is judged item by item; an object found
 * where a leaf class stands is judged field by field through `fields`, the
 * table in force around it.
 */
function judge(value: Json, cls: AttrClass, fields: Fields): Json {
  if (typeof cls === 'object') return structure(value, cls.fields)
  if (cls === 'marks') return markList(value)
  if (Array.isArray(value)) return same(value, (item) => judge(item, cls, fields))
  if (isObject(value)) return judgedFields(value, fields)
  if (typeof value !== 'string') return value
  switch (cls) {
    case 'kept':
    case 'text':
      return value
    case 'link':
      return safeLink(value) ? value : ''
    case 'picture':
      return safePicture(value)
    case 'cssString':
      return LINE_BREAK.test(value) ? '' : value
    case 'mathml':
    case 'inlineMathml':
      // markup comes only from the OMML beside it (`judgedFields`), never on its own
      return ''
    case 'token':
      return UNSAFE_TOKEN.test(value) ? '' : value
  }
}

/** An object's fields, each judged by the class `fields` gives its name: a token when it gives none */
function judgedFields(object: JsonObject, fields: Fields): JsonObject {
  return changed(object, (key, value) => field(object, value, own(fields, key) ?? 'token', fields))
}

/** One field of `object`: markup is made from the OMML beside it, anything else judged as `cls` */
function field(object: JsonObject, value: Json, cls: AttrClass, fields: Fields): Json {
  if (cls !== 'mathml' && cls !== 'inlineMathml') return judge(value, cls, fields)
  // The markup is a pure function of the OMML: the same converter makes it on every page.
  // Anything but a string (an array, an object) would reach innerHTML through String().
  if (value === null) return value
  const inline = cls === 'inlineMathml'
  return typeof value === 'string' && value && typeof object.omml === 'string' && object.omml
    ? rebuilt(object.omml, inline, inline && object.display === true)
    : ''
}

/** A `struct`: an object or an array of them, as it is or as JSON text; anything else is a token */
function structure(value: Json, fields: Fields): Json {
  if (typeof value !== 'string') return members(value, fields)
  const json = jsonIn(value)
  if (json === undefined) return judge(value, 'token', fields)
  wellFormed(json, 0)
  const next = members(json, fields)
  return next === json ? value : JSON.stringify(next)
}

function members(value: Json, fields: Fields): Json {
  if (Array.isArray(value)) return same(value, (item) => members(item, fields))
  return isObject(value) ? judgedFields(value, fields) : judge(value, 'token', fields)
}

/** A list of marks, as it is or as JSON text */
function markList(value: Json): Json {
  if (value === null) return value
  const json = typeof value === 'string' ? jsonIn(value) : value
  if (!Array.isArray(json)) return null
  if (json !== value) wellFormed(json, 0)
  const next = same(json, safeMark)
  return next === json ? value : typeof value === 'string' ? JSON.stringify(next) : next
}

/**
 * An outside-state entry's value, judged by the keys that hold its values.
 * Its key's parts become App field and record keys (`style:<styleId>`), so a
 * reserved one throws as a reserved key inside the value does.
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
 * Every key of an entry's `object` judged, whatever shape it has: a node
 * (`type` and `attrs`) gets no pass for its other keys. `inline`: the
 * attributes of an inline formula, whose markup is the inline form of its
 * OMML (display math-style when its `display` attribute is set); a display
 * equation's (`formulaDisplay`) is the block form.
 */
function safeObject(object: JsonObject, how: Safety, inline = false): JsonObject {
  let out = object
  const node = typeof object.type === 'string'
  for (const [key, value] of Object.entries(object)) {
    if (key === 'mathml') continue
    let next: Json
    if (key === 'attrs' && node && isObject(value)) {
      next = safeObject(value, how, object.type === 'docInlineMath')
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

/** `object` with each value replaced by what `judged` makes of it: `object` itself when none changed */
function changed(object: JsonObject, judged: (key: string, value: Json) => Json): JsonObject {
  let out = object
  for (const [key, value] of Object.entries(object)) {
    const next = judged(key, value)
    if (next !== value) out = { ...out, [key]: next }
  }
  return out
}

/** `items` with each replaced by what `judged` makes of it: `items` itself when none changed */
function same(items: Json[], judged: (item: Json) => Json): Json[] {
  const next = items.map(judged)
  return next.some((item, i) => item !== items[i]) ? next : items
}

/** what `table` holds under `key` itself, not what its prototype does (`constructor`, `toString`) */
function own<T>(table: { readonly [key: string]: T }, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined
}

function isObject(value: Json | undefined): value is JsonObject {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
