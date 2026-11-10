/**
 * What a peer sends is untrusted: one editor's steps and outside-state
 * entries reach every page of the session, viewers included. The renderer
 * writes some attribute values into the DOM as markup (MathML through
 * innerHTML), as URLs (link targets, picture sources, CSS `url()`) and as
 * style text (colours, faces and sizes concatenated into `style`). Every
 * remote value goes through here before the editor or the App sees it.
 *
 * Values are judged by the key that holds them, at any depth of a node's or
 * mark's attributes (nested table, chart, text box and header models carry
 * the same keys):
 * - `mathml` is rebuilt from the `omml` beside it with the converter that
 *   made it in the first place, so a legitimate equation comes out unchanged.
 * - link targets keep http, https, mailto and in-document `#` anchors.
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
 * every page, so the pages that receive it agree.
 */
import { ommlToMathML } from '@genoffice/docx-engine'
import type { Json } from '@seuoffice/collab/client'
import { inlineMathML } from '../renderer/editor/equation'

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
const SAFE_LINK = /^(https?:|mailto:|#)/i
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
  /** for a fingerprint: drop `mathml` (a function of `omml`) instead of rebuilding it */
  hashing?: boolean
  /** only links, pictures and markup: entries the App shows through React alone */
  urlsOnly?: boolean
}

/** The step's JSON with every value it brings safe; `Step.fromJSON` still rejects a malformed one */
export function safeStep(step: Json): Json {
  if (!isObject(step)) return step
  let out = step
  if (isObject(step.slice)) out = { ...out, slice: safeSlice(step.slice) }
  if (isObject(step.mark)) out = { ...out, mark: safeNode(step.mark, {}) }
  if ((step.stepType === 'attr' || step.stepType === 'docAttr') && typeof step.attr === 'string')
    out = { ...out, value: step.attr === 'mathml' ? '' : safeValue(step.value, step.attr, {}) }
  return out
}

function safeSlice(slice: JsonObject): JsonObject {
  if (!Array.isArray(slice.content)) return slice
  return { ...slice, content: slice.content.map((node) => safeNode(node, {})) }
}

/** A node or mark JSON (`{ type, attrs, content, marks }`) with safe attributes */
export function safeNode(node: Json, how: Safety): Json {
  if (!isObject(node)) return node
  let out = node
  if (isObject(node.attrs)) {
    const attrs = safeObject(node.attrs, how, node.type === 'docInlineMath')
    if (attrs !== node.attrs) out = { ...out, attrs }
  }
  for (const key of ['content', 'marks'] as const) {
    const list = node[key]
    if (!Array.isArray(list)) continue
    const children = list.map((child) => safeNode(child, how))
    if (children.some((child, i) => child !== list[i])) out = { ...out, [key]: children }
  }
  return out
}

/** An outside-state entry's value, judged as the attributes are */
export function safeEntry(key: string, value: Json, how: Safety = {}): Json {
  // the bibliography and Zotero data are free text the App shows through React
  const urlsOnly = how.urlsOnly || key === 'sources' || key === 'zotero'
  return safeValue(value, key, { ...how, urlsOnly })
}

/**
 * `inline`: the attributes of an inline formula, whose markup is the inline
 * form of its OMML; a display equation's (`formulaDisplay`) is the block form
 */
function safeObject(object: JsonObject, how: Safety, inline = false): JsonObject {
  let out = object
  for (const [key, value] of Object.entries(object)) {
    const next = safeValue(value, key, how)
    if (next !== value) out = { ...out, [key]: next }
  }
  if (typeof object.mathml === 'string') {
    if (how.hashing) return withoutKey(out, 'mathml')
    const omml = typeof object.omml === 'string' ? object.omml : ''
    const mathml = object.mathml && omml ? rebuilt(omml, inline) : ''
    if (mathml !== object.mathml) out = { ...out, mathml }
  }
  return out
}

function safeValue(value: Json, key: string, how: Safety): Json {
  if (Array.isArray(value)) {
    const items = value.map((item) => safeValue(item, key, how))
    return items.some((item, i) => item !== value[i]) ? items : value
  }
  if (isObject(value)) {
    // a node model kept in an attribute (a text box's content, a header's paragraphs)
    if (typeof value.type === 'string' && isObject(value.attrs)) return safeNode(value, how)
    return safeObject(value, how)
  }
  if (typeof value !== 'string') return value
  if (key === 'mathml') return value
  if (LINK_KEY.test(key)) return value === '' || SAFE_LINK.test(value.trim()) ? value : ''
  if (PICTURE_KEY.test(key)) return safePicture(value)
  if (how.urlsOnly || FREE_TEXT.has(key) || XML_KEY.test(key)) return value
  const json = jsonIn(value)
  if (json !== undefined) {
    const next = safeValue(json, key, how)
    return next === json ? value : JSON.stringify(next)
  }
  return UNSAFE_TOKEN.test(value) ? '' : value
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

/** MathML from OMML, memoised: a fingerprint asks again for every equation */
const mathml = new Map<string, string>()
function rebuilt(omml: string, inline: boolean): string {
  const key = `${inline ? 'i' : 'b'}${omml}`
  let markup = mathml.get(key)
  if (markup === undefined) {
    markup = inline ? inlineMathML(omml) : ommlToMathML(omml)
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

function withoutKey(object: JsonObject, key: string): JsonObject {
  const { [key]: _dropped, ...rest } = object
  return rest
}
