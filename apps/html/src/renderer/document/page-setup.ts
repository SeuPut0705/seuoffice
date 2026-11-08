/**
 * The paper a document prints on, read from its own `@page` rule. The preview
 * lays the page out against the same box the print engine uses: the content
 * area inside the margins is the viewport of a printed page (vw, vh and width
 * media queries resolve against it), so that is what `width` / `height` are.
 */
export interface PageSetup {
  /** page content box (inside the margins), CSS px */
  width: number
  height: number
  marginTop: number
  marginRight: number
  marginBottom: number
  marginLeft: number
}

const PX_PER_UNIT: Record<string, number> = {
  px: 1,
  in: 96,
  cm: 96 / 2.54,
  mm: 96 / 25.4,
  q: 96 / 101.6,
  pt: 96 / 72,
  pc: 16,
}
const mm = (n: number) => n * PX_PER_UNIT.mm!
const inch = (n: number) => n * 96

/** named sizes of CSS Paged Media, portrait [width, height] in px */
const NAMED_SIZES: Record<string, [number, number]> = {
  a5: [mm(148), mm(210)],
  a4: [mm(210), mm(297)],
  a3: [mm(297), mm(420)],
  b5: [mm(176), mm(250)],
  b4: [mm(250), mm(353)],
  'jis-b5': [mm(182), mm(257)],
  'jis-b4': [mm(257), mm(364)],
  letter: [inch(8.5), inch(11)],
  legal: [inch(8.5), inch(14)],
  ledger: [inch(11), inch(17)],
}
/** what PDF export passes to the print engine when the document says nothing */
const DEFAULT_SIZE = NAMED_SIZES.a4!
const DEFAULT_MARGIN = inch(0.6)
/** a page whose margins leave less than this is not a page anyone prints: fall back to the defaults */
const MIN_CONTENT = 48

function parseLength(token: string): number | null {
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+))([a-z]*)$/i.exec(token)
  if (!m) return null
  const value = Number(m[1])
  const unit = m[2]!.toLowerCase()
  if (!unit) return value === 0 ? 0 : null
  const scale = PX_PER_UNIT[unit]
  return scale === undefined ? null : value * scale
}

function parseSize(value: string): [number, number] | null {
  const tokens = value.toLowerCase().split(/\s+/).filter(Boolean)
  let size: [number, number] | null = null
  let orientation: 'portrait' | 'landscape' | null = null
  const lengths: number[] = []
  for (const token of tokens) {
    if (token === 'portrait' || token === 'landscape') orientation = token
    else if (token === 'auto') size = DEFAULT_SIZE
    else if (NAMED_SIZES[token]) size = NAMED_SIZES[token]!
    else {
      const length = parseLength(token)
      if (length === null || length <= 0) return null
      lengths.push(length)
    }
  }
  // explicit lengths are the page box as written; an orientation keyword only turns a named size
  if (lengths.length) return lengths.length <= 2 ? [lengths[0]!, lengths[1] ?? lengths[0]!] : null
  const [w, h] = size ?? DEFAULT_SIZE
  if (!size && !orientation) return null
  return orientation === 'landscape' ? [h, w] : [w, h]
}

const STYLE_BLOCK = /<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi
const CSS_COMMENT = /\/\*[\s\S]*?\*\//g

/** bodies of the unnamed `@page` rules, nested margin boxes removed */
function pageRuleBodies(css: string): string[] {
  const out: string[] = []
  const re = /@page\s*([^{};]*)\{/gi
  for (let m = re.exec(css); m; m = re.exec(css)) {
    let depth = 1
    let i = re.lastIndex
    let body = ''
    for (; i < css.length && depth > 0; i++) {
      const ch = css[i]!
      if (ch === '{') depth += 1
      else if (ch === '}') depth -= 1
      else if (depth === 1) body += ch
    }
    re.lastIndex = i
    // `@page :first`, `@page cover`: a subset of the pages, not the document's paper
    if (!m[1]!.trim()) out.push(body)
  }
  return out
}

/** how far apart the tops of two sheets are in the paper view, with `gap` of desk between them */
export function sheetPeriod(setup: PageSetup, gap: number): number {
  return setup.marginTop + setup.height + setup.marginBottom + gap
}

/** The page a reader is looking at: the one under a line a third of the way down the view. */
export function pageAtScroll(
  scrollY: number,
  viewHeight: number,
  period: number,
  pages: number,
): number {
  const page = Math.floor((scrollY + viewHeight / 3) / period)
  return Math.max(0, Math.min(pages - 1, page))
}

/** The document says what paper it is for: it carries a page rule of its own. */
export function declaresPaper(html: string): boolean {
  for (const style of html.matchAll(STYLE_BLOCK))
    if (pageRuleBodies(style[1]!.replace(CSS_COMMENT, ' ')).length) return true
  return false
}

/** Paper and margins the document declares; anything it leaves open is what PDF export uses. */
export function readPageSetup(html: string): PageSetup {
  let [sheetWidth, sheetHeight] = DEFAULT_SIZE
  const margin = [DEFAULT_MARGIN, DEFAULT_MARGIN, DEFAULT_MARGIN, DEFAULT_MARGIN]
  const SIDES = ['margin-top', 'margin-right', 'margin-bottom', 'margin-left']
  for (const style of html.matchAll(STYLE_BLOCK)) {
    const css = style[1]!.replace(CSS_COMMENT, ' ')
    for (const body of pageRuleBodies(css)) {
      for (const declaration of body.split(';')) {
        const colon = declaration.indexOf(':')
        if (colon < 0) continue
        const prop = declaration.slice(0, colon).trim().toLowerCase()
        const value = declaration
          .slice(colon + 1)
          .replace(/!\s*important\s*$/i, '')
          .trim()
        if (prop === 'size') {
          const size = parseSize(value)
          if (size) [sheetWidth, sheetHeight] = size
        } else if (prop === 'margin') {
          const parts = value.split(/\s+/).map(parseLength)
          if (parts.length < 1 || parts.length > 4 || parts.some((p) => p === null || p < 0))
            continue
          const [top, right = top, bottom = top, left = right] = parts as number[]
          margin.splice(0, 4, top!, right!, bottom!, left!)
        } else if (SIDES.includes(prop)) {
          const length = parseLength(value)
          if (length !== null && length >= 0) margin[SIDES.indexOf(prop)] = length
        }
      }
    }
  }
  let [top, right, bottom, left] = margin as [number, number, number, number]
  if (sheetWidth - left - right < MIN_CONTENT || sheetHeight - top - bottom < MIN_CONTENT)
    top = right = bottom = left = Math.min(DEFAULT_MARGIN, sheetWidth / 8, sheetHeight / 8)
  const round = (n: number) => Math.round(n * 100) / 100
  return {
    // whole px: the frame is this wide, and a fractional viewport would leave the root a hair wider than it
    width: Math.round(sheetWidth - left - right),
    height: round(sheetHeight - top - bottom),
    marginTop: round(top),
    marginRight: round(right),
    marginBottom: round(bottom),
    marginLeft: round(left),
  }
}
