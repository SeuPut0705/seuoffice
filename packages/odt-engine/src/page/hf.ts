/**
 * Header/footer write-back: which parts of the edited docx changed, and the
 * ODF of a master page region rebuilt from an edited part.
 *
 * The editor regenerates a header part from its paragraph model whenever the
 * header is edited (style references and hidden bookmarks go), so a changed
 * part is compared paragraph by paragraph against the bridge part read the
 * same way (`baselineParagraphs`). Paragraphs that read back the same keep
 * their original ODF bytes; the others go through the text layer's
 * `paragraphToOdf` with the original paragraph as origin. Non-paragraph
 * children of the region (tables, frames) keep their bytes and places.
 */
import { type HfParagraph, PAGE_MARK, TOTAL_PAGES_MARK, parseDocx } from '@genoffice/docx-engine'
import JSZip from 'jszip'
import type {
  BridgeParagraph,
  EditedParagraph,
  OoxmlToOdfContext,
  ParagraphWriteEnv,
  RunWriter,
} from '../core/convert'
import type { OdtMasterPageRegion } from '../core/styles'
import { escapeXmlAttr } from '../core/xml'
import { paragraphStyleInfo } from '../text/paragraph-ooxml'
import { paragraphToOdf } from '../text/paragraph-odf'
import { PAGE_OWNER, type PageExt, type PageHfPart } from './model'
import { childElements } from './odf'

const REL_BASE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

/** An edited header/footer part as the write-back sees it. */
export interface EditedPart {
  rId: string
  /** byte-identical to the bridge part */
  unchanged: boolean
  /** paragraphs of the edited part (tables are display-only rows and left out) */
  paragraphs: HfParagraph[]
}

/** Reads the header/footer parts the edited sections reference. */
export async function readEditedParts(
  rctx: OoxmlToOdfContext,
  ext: PageExt,
  rIds: Iterable<string>,
): Promise<Map<string, EditedPart>> {
  const out = new Map<string, EditedPart>()
  const wanted = [...new Set(rIds)]
  if (!wanted.length) return out
  const zip = await JSZip.loadAsync(rctx.edited.internal.originalBytes)
  const relsXml = (await zip.file('word/_rels/document.xml.rels')?.async('string')) ?? ''
  const targets = new Map<string, string>()
  for (const m of relsXml.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = /\bId="([^"]*)"/.exec(m[0])?.[1]
    const target = /\bTarget="([^"]*)"/.exec(m[0])?.[1]
    if (id && target) targets.set(id, target)
  }
  for (const rId of wanted) {
    const paragraphs = (rctx.edited.hfParts?.[rId]?.paras ?? []).filter((p) => !p.cells)
    const bridge = ext.parts[rId]
    let unchanged = false
    if (bridge) {
      const target = targets.get(rId)
      const path = target
        ? target.startsWith('/')
          ? target.slice(1)
          : `word/${target.replace(/^\.\//, '')}`
        : bridge.path
      const xml = await zip.file(path)?.async('string')
      unchanged = xml === bridge.xml
    }
    out.set(rId, { rId, unchanged, paragraphs })
  }
  return out
}

/**
 * The bridge parts read back by the docx engine (with the edited docx's
 * styles), so edited paragraphs can be compared with what the editor was given.
 */
export async function baselineParagraphs(
  parts: readonly PageHfPart[],
  stylesXml: string | null | undefined,
): Promise<Map<string, HfParagraph[]>> {
  const out = new Map<string, HfParagraph[]>()
  if (!parts.length) return out
  const zip = new JSZip()
  const decl = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  const ct = 'application/vnd.openxmlformats-officedocument.wordprocessingml'
  zip.file(
    '[Content_Types].xml',
    `${decl}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      `<Override PartName="/word/document.xml" ContentType="${ct}.document.main+xml"/>` +
      `<Override PartName="/word/styles.xml" ContentType="${ct}.styles+xml"/>` +
      parts
        .map((p) => `<Override PartName="/${p.path}" ContentType="${ct}.${p.kind}+xml"/>`)
        .join('') +
      '</Types>',
  )
  zip.file(
    '_rels/.rels',
    `${decl}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="${REL_BASE}/officeDocument" Target="word/document.xml"/></Relationships>`,
  )
  zip.file(
    'word/_rels/document.xml.rels',
    `${decl}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rIdStyles" Type="${REL_BASE}/styles" Target="styles.xml"/>` +
      parts
        .map(
          (p) =>
            `<Relationship Id="${escapeXmlAttr(p.rId)}" Type="${REL_BASE}/${p.kind}" Target="${escapeXmlAttr(p.path.replace(/^word\//, ''))}"/>`,
        )
        .join('') +
      '</Relationships>',
  )
  zip.file(
    'word/styles.xml',
    stylesXml ??
      `${decl}<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>`,
  )
  zip.file(
    'word/document.xml',
    `${decl}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ` +
      `xmlns:r="${REL_BASE}"><w:body><w:p/><w:sectPr>` +
      parts
        .map((p) => `<w:${p.kind}Reference w:type="default" r:id="${escapeXmlAttr(p.rId)}"/>`)
        .join('') +
      '</w:sectPr></w:body></w:document>',
  )
  for (const p of parts) zip.file(p.path, p.xml)
  const parsed = await parseDocx(await zip.generateAsync({ type: 'uint8array' }))
  for (const p of parts)
    out.set(
      p.rId,
      (parsed.hfParts?.[p.rId]?.paras ?? []).filter((x) => !x.cells),
    )
  return out
}

// ---------------------------------------------------------------------------
// Paragraph comparison

const PARAGRAPH_ONLY = new Set([
  'runs',
  'cells',
  'row',
  'lineOnly',
  'frameXAlign',
  'boxAnchored',
  'box',
  'ptabAligns',
])

/** The paragraph-format part of a header paragraph. */
export function hfFormat(p: HfParagraph): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(p)) if (!PARAGRAPH_ONLY.has(k) && v !== undefined) out[k] = v
  return out
}

const canonical = (value: unknown): string =>
  JSON.stringify(value, (_k, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>)
            .filter(([, x]) => x !== undefined)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        )
      : v,
  )

const sameFormat = (a: HfParagraph, b: HfParagraph) =>
  canonical(hfFormat(a)) === canonical(hfFormat(b))
const sameParagraph = (a: HfParagraph, b: HfParagraph) =>
  sameFormat(a, b) && canonical(a.runs) === canonical(b.runs)

const textOf = (p: HfParagraph) => p.runs.map((r) => r.text).join('')

/**
 * Pairs original paragraphs with edited ones: equal texts in order (LCS),
 * then a lone leftover on each side of a gap. Returns, per original, the
 * edited index or -1 (deleted).
 */
export function pairParagraphs(original: readonly string[], edited: readonly string[]): number[] {
  const n = original.length
  const m = edited.length
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i][j] =
        original[i] === edited[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
  const pair = new Array<number>(n).fill(-1)
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (original[i] === edited[j]) {
      pair[i++] = j++
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) i++
    else j++
  }
  // gaps between pairs: pair leftovers positionally
  let lastO = -1
  let lastE = -1
  const fill = (toO: number, toE: number) => {
    const os: number[] = []
    for (let o = lastO + 1; o < toO; o++) if (pair[o] < 0) os.push(o)
    const es: number[] = []
    for (let e = lastE + 1; e < toE; e++) es.push(e)
    for (let k = 0; k < Math.min(os.length, es.length); k++) pair[os[k]] = es[k]
  }
  for (let o = 0; o < n; o++) {
    if (pair[o] < 0) continue
    fill(o, pair[o])
    lastO = o
    lastE = pair[o]
  }
  fill(n, m)
  return pair
}

// ---------------------------------------------------------------------------
// Region rebuild

/** Header runs with page fields split out, so the field run writer sees them alone. */
function splitFieldRuns(p: HfParagraph): HfParagraph['runs'] {
  const out: HfParagraph['runs'] = []
  for (const run of p.runs) {
    if (!run.text.includes(PAGE_MARK) && !run.text.includes(TOTAL_PAGES_MARK)) {
      out.push(run)
      continue
    }
    for (const piece of run.text.split(/([])/)) if (piece) out.push({ ...run, text: piece })
  }
  return out
}

/**
 * The inner XML of a region rebuilt from an edited part. `source` is the
 * original region the part showed (its paragraphs are `records`, read back as
 * `baseline`), or null for a part with no original content.
 */
export function regionInnerXml(
  rctx: OoxmlToOdfContext,
  source: OdtMasterPageRegion | null,
  records: readonly BridgeParagraph[],
  baseline: readonly HfParagraph[] | undefined,
  edited: readonly HfParagraph[],
): string {
  const info = rctx.part('styles.xml')
  const xml = info.xml
  const base = baseline && baseline.length === records.length ? baseline : records.map(() => null)
  const pair = pairParagraphs(
    records.map((r) => r.text),
    edited.map(textOf),
  )
  const styleIdOf = (r: BridgeParagraph | null) =>
    r ? paragraphStyleInfo(rctx, 'styles.xml', r.styleName).styleId : undefined
  const write = (
    para: HfParagraph,
    origin: BridgeParagraph | null,
    baselinePara: HfParagraph | null,
    follows: BridgeParagraph | null,
    neighbour: BridgeParagraph | null,
  ): string => {
    if (origin && baselinePara && sameParagraph(para, baselinePara))
      return xml.slice(origin.start, origin.end)
    const template = origin ?? follows ?? neighbour
    const edit: EditedParagraph = {
      type: 'paragraph',
      runs: splitFieldRuns(para),
      format: hfFormat(para) as EditedParagraph['format'],
      styleId: styleIdOf(template),
      ...(origin && baselinePara && sameFormat(para, baselinePara) ? { rawPPr: origin.pPr } : {}),
    }
    return paragraphToOdf(rctx, edit, origin, {
      part: 'styles.xml',
      neighbour: origin ? null : neighbour,
      follows: origin ? null : follows,
    })
  }

  let out = ''
  let nextEdited = 0
  let follows: BridgeParagraph | null = null
  const emitNew = (upTo: number, neighbour: BridgeParagraph | null) => {
    for (; nextEdited < upTo; nextEdited++)
      out += write(edited[nextEdited], null, null, follows, follows ?? neighbour)
  }
  const byStart = new Map(records.map((r, i) => [r.start, i]))
  const children =
    source && !source.selfClosing
      ? childElements(xml, info.prefixes, source.openEnd, source.closeStart)
      : []
  for (const child of children) {
    const index = byStart.get(child.start)
    if (index === undefined) {
      out += xml.slice(child.start, child.end)
      continue
    }
    const record = records[index]
    const target = pair[index]
    if (target < 0) {
      out += hiddenObjects(xml, record)
      continue
    }
    emitNew(target, record)
    out += write(edited[target], record, base[index], null, null)
    nextEdited = target + 1
    follows = record
  }
  emitNew(edited.length, records[records.length - 1] ?? null)
  return out
}

/**
 * What a deleted header/footer paragraph must still leave behind: the objects
 * the editor never showed (a framed table, a text box, a picture stay out of
 * the bridge docx as `keep` markers), so deleting the paragraph in the editor
 * cannot be meant to delete them. A paragraph holding only such objects keeps
 * its bytes; one with text too keeps its start tag and the objects. '' when it
 * held none.
 */
function hiddenObjects(xml: string, record: BridgeParagraph): string {
  const kept = record.markers.filter((m) => m.kind === 'keep')
  if (!kept.length) return ''
  if (!record.text.trim()) return xml.slice(record.start, record.end)
  const source = xml.slice(record.start, record.end)
  const open = /^<[^>]*>/.exec(source)?.[0] ?? ''
  const tag = /^<([^\s/>]+)/.exec(open)?.[1] ?? record.element
  return `${open}${kept.map((m) => xml.slice(m.start, m.end)).join('')}</${tag}>`
}

/** The inner XML of a region as it is now. */
export function regionInner(rctx: OoxmlToOdfContext, region: OdtMasterPageRegion): string {
  return region.selfClosing
    ? ''
    : rctx.part('styles.xml').xml.slice(region.openEnd, region.closeStart)
}

// ---------------------------------------------------------------------------
// Page number fields

const fieldCounters = new WeakMap<ParagraphWriteEnv, Map<string, number>>()

/**
 * Writes the page number / page count runs of edited header paragraphs: the
 * original `text:page-number` / `text:page-count` element when the paragraph
 * had one at that rank, else a new field.
 */
export const pageFieldRunWriter: RunWriter = {
  id: PAGE_OWNER,
  match(run) {
    return run.text === PAGE_MARK || run.text === TOTAL_PAGES_MARK
  },
  toOdf(rctx, run, env) {
    const name = run.text === PAGE_MARK ? 'text:page-number' : 'text:page-count'
    let counters = fieldCounters.get(env)
    if (!counters) fieldCounters.set(env, (counters = new Map()))
    const rank = counters.get(name) ?? 0
    counters.set(name, rank + 1)
    const own = (env.origin?.markers ?? []).filter(
      (m) => m.kind === 'handler' && m.owner === PAGE_OWNER && m.name === name,
    )
    const original = own[rank]
    if (original && env.origin)
      return rctx.part(env.origin.part).xml.slice(original.start, original.end)
    return name === 'text:page-number'
      ? '<text:page-number text:select-page="current">1</text:page-number>'
      : '<text:page-count>1</text:page-count>'
  },
}
