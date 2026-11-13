// Group `parse` of comparison (f): parse.ts and master-edit.ts of
// packages/pptx-engine. The Rust side answers in
// crates/office-wasm/src/calls/pptx_parse.rs to `pptxParse.<module>.<TypeScript name>`.
//
// parse.ts exports five functions, so its private ones are proven through the
// slides that reach them: every entry of parse-inputs/*.ts is wrapped into a
// slide part and parsed against two built base contexts, and every slide of
// every deck the gate opens is parsed with the context index.ts gives it.
//
// A context crosses as JSON (`toWire`): a Map as its [key, value] pairs, a Set
// as its values, `null` for no key. Both sides read that same JSON: `call`
// rebuilds the Maps from it, the Rust deserializes ParseContextData.
//
// Ids: `uid` counts from a counter of parse.ts's module that no caller can
// reset. Each `call` parses a probe slide that takes exactly one id, makes the
// real call, and rewrites every element id `<prefix>_<k>` to
// `<prefix>_<(k - next) in base 36>`, `next` the counter after the probe: the
// ids a counter from 0 gives, which is how the Rust is called.
import { readFileSync } from 'node:fs'
import { listMasterParts, parseMasterPart } from './reference/master-edit'
import { MODEL3D_REL_TYPE } from './reference/model3d'
import {
  type DecorationOptions,
  layoutDiagramFallback,
  type ParseContext,
  parseBackground,
  parseDecorations,
  parseSlide,
  sliceGroupChildXmls,
} from './reference/parse'
import {
  parseDefaultTextStyle,
  parseMasterTextStyles,
  parsePlaceholderMap,
} from './reference/placeholder'
import { parseClrMap, parseTheme } from './reference/theme'
import type { Slide, SlideElement } from './reference/types'
import { PackageArchive, resolveTarget } from './reference/zip'
import type { CallSpec, Input } from '../docx-diff/calls-spec'
import { SLIDES as DIAGRAM_SLIDES } from './parse-inputs/diagram'
import { SLIDES as FILL_SLIDES } from './parse-inputs/fill'
import { SLIDES as PICTURE_SLIDES } from './parse-inputs/picture'
import { SLIDES as SHAPE_SLIDES } from './parse-inputs/shape'
import { SLIDES as SLIDE_SLIDES } from './parse-inputs/slide'
import { SLIDES as TABLE_SLIDES } from './parse-inputs/table'
import { SLIDES as TEXT_SLIDES } from './parse-inputs/text'

type Parts = Array<[string, string]>
type Wire = Record<string, unknown>

interface SlideEntry {
  name: string
  spTree: string
  ctx?: Record<string, unknown>
  seed?: boolean
}

const ENTRIES: SlideEntry[] = [
  ...SLIDE_SLIDES,
  ...SHAPE_SLIDES,
  ...PICTURE_SLIDES,
  ...DIAGRAM_SLIDES,
  ...TABLE_SLIDES,
  ...FILL_SLIDES,
  ...TEXT_SLIDES,
]

// ── The context as JSON ───────────────────────────────────────────────

const MAP_KEYS = new Set([
  'mediaRels',
  'hlinkRels',
  'chartXmls',
  'chartUserShapes',
  'avRels',
  'model3dRels',
  'diagramDatas',
  'diagramDrawings',
  'diagramLayouts',
  'diagramColors',
  'layoutMediaRels',
  'masterMediaRels',
  'themeMediaRels',
  'chartThemeOverrides',
  'vmlPreviews',
])
const MAP_OF_MAPS_KEYS = new Set(['chartMediaRels', 'diagramMediaRels'])

/** A ParseContext as the Rust reads it (ParseContextData). */
function toWire(ctx: ParseContext): Wire {
  const out: Wire = {}
  for (const [key, value] of Object.entries(ctx)) {
    if (value instanceof Map) {
      out[key] = [...value].map(([k, v]) => [k, v instanceof Map ? [...v] : v])
    } else if (value instanceof Set) {
      out[key] = [...value]
    } else {
      out[key] = value
    }
  }
  return JSON.parse(JSON.stringify(out)) as Wire
}

/** The ParseContext of a wire context; a `null` key is no key, as serde reads it. */
function fromWire(wire: unknown): ParseContext {
  const ctx: Record<string, unknown> = {}
  for (const [key, value] of Object.entries((wire ?? {}) as Wire)) {
    if (value === null || value === undefined) continue
    if (MAP_OF_MAPS_KEYS.has(key)) {
      ctx[key] = new Map(
        (value as Array<[string, Parts]>).map(([k, inner]) => [k, new Map(inner)]),
      )
    } else if (MAP_KEYS.has(key)) {
      ctx[key] = new Map(value as Array<[string, unknown]>)
    } else if (key === 'chartStyleRels') {
      ctx[key] = new Set(value as string[])
    } else {
      ctx[key] = value
    }
  }
  return ctx as ParseContext
}

/** `args.opts` as DecorationOptions: `hfTypes` crosses as a list. */
function decorationOptions(opts: unknown): DecorationOptions | undefined {
  if (opts === undefined || opts === null) return undefined
  const { hfTypes, slideNum, hideShapes } = opts as {
    hfTypes?: string[] | null
    slideNum?: number | null
    hideShapes?: boolean | null
  }
  return {
    ...(hfTypes != null ? { hfTypes: new Set(hfTypes) } : {}),
    ...(slideNum != null ? { slideNum } : {}),
    ...(hideShapes != null ? { hideShapes } : {}),
  }
}

// ── Ids ───────────────────────────────────────────────────────────────

const PROBE = '<p:sld><p:cSld><p:spTree><p:sp><p:spPr/></p:sp></p:spTree></p:cSld></p:sld>'

/** The result of `call` with its element ids as a counter that starts at 0 gives them. */
function fromZero<T>(call: () => T): T {
  const probe = parseSlide({ path: 'probe', slideXml: PROBE, ctx: {} }).elements[0]!
  const next = parseInt(probe.id.slice(probe.id.lastIndexOf('_') + 1), 36) + 1
  const result = call()
  const rebase = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) rebase(item)
      return
    }
    if (node === null || typeof node !== 'object') return
    const object = node as Record<string, unknown>
    if ('anchor' in object && typeof object.id === 'string') {
      const m = /^(.*)_([0-9a-z]+)$/.exec(object.id)
      if (m) object.id = `${m[1]}_${(parseInt(m[2]!, 36) - next).toString(36)}`
    }
    for (const value of Object.values(object)) rebase(value)
  }
  rebase(result)
  return result
}

// ── Archives ──────────────────────────────────────────────────────────

/** The private constructor, as `open` calls it once the zip is read. */
const Archive = PackageArchive as unknown as new (
  entries: Map<string, Uint8Array>,
  originalHash: string,
) => PackageArchive

/** An archive of `parts`, then the text under `textPart`: that part is what mutations change. */
function archiveOf(parts: Iterable<[string, string]>, text?: string, textPart?: unknown) {
  const encoder = new TextEncoder()
  const entries = new Map<string, Uint8Array>()
  for (const [name, part] of parts) entries.set(name, encoder.encode(part))
  if (typeof textPart === 'string') entries.set(textPart, encoder.encode(text ?? ''))
  return new Archive(entries, 'gate')
}

const archiveOfArgs = (text: string, args: Record<string, unknown>): PackageArchive =>
  archiveOf((args.parts ?? []) as Parts, text, args.textPart)

/** `[name, text]` of `parts` but `name`, and the text of `name`. */
function splitOff(parts: Parts, name: string): { text: string; args: Wire } {
  return {
    text: parts.find(([n]) => n === name)?.[1] ?? '',
    args: { parts: parts.filter(([n]) => n !== name), textPart: name },
  }
}

// ── The context index.ts builds (parseSlideFromArchive, buildDecorations) ─

/** index.ts `partMediaRels`. */
function partMediaRels(archive: PackageArchive, partPath: string): Map<string, string> {
  const media = new Map<string, string>()
  for (const rel of archive.readRels(partPath).values()) {
    if (rel.type.endsWith('/image')) media.set(rel.id, resolveTarget(partPath, rel.target))
  }
  return media
}

interface DeckSlide {
  path: string
  archive: PackageArchive
  slideXml: string
  layoutPath?: string
  masterPath?: string
  layoutXml?: string
  masterXml?: string
  ctx: ParseContext
}

/** index.ts `parseSlideFromArchive` up to its parseSlide call, line for line. */
function deckSlide(archive: PackageArchive, slidePath: string): DeckSlide | undefined {
  const slideXml = archive.readText(slidePath)
  if (slideXml == null) return undefined

  const chain = archive.resolveSlideChain(slidePath)
  const ctx: ParseContext = {}
  const layoutXml = (chain.layoutPath ? archive.readText(chain.layoutPath) : undefined) ?? undefined
  const masterXml = (chain.masterPath ? archive.readText(chain.masterPath) : undefined) ?? undefined
  if (chain.themePath) {
    const themeXml = archive.readText(chain.themePath)
    if (themeXml) {
      ctx.theme = parseTheme(themeXml)
      ctx.theme.clrMap = parseClrMap(masterXml, layoutXml, slideXml)
      ctx.themeMediaRels = partMediaRels(archive, chain.themePath)
    }
  }
  if (layoutXml) {
    if (chain.layoutPath) ctx.layoutMediaRels = partMediaRels(archive, chain.layoutPath)
    ctx.layoutPlaceholders = parsePlaceholderMap(layoutXml, ctx.theme, ctx.layoutMediaRels)
    ctx.layoutBg = layoutXml
  }
  if (masterXml) {
    if (chain.masterPath) ctx.masterMediaRels = partMediaRels(archive, chain.masterPath)
    ctx.masterPlaceholders = parsePlaceholderMap(masterXml, ctx.theme, ctx.masterMediaRels)
    ctx.masterTextStyles = parseMasterTextStyles(masterXml, ctx.theme, ctx.masterMediaRels)
    ctx.masterBg = masterXml
  }
  const presXml = archive.readText('ppt/presentation.xml')
  if (presXml) ctx.defaultTextStyle = parseDefaultTextStyle(presXml, ctx.theme)
  const rels = archive.readRels(slidePath)
  const mediaRels = new Map<string, string>()
  const chartXmls = new Map<string, string>()
  const chartMediaRels = new Map<string, Map<string, string>>()
  const chartUserShapes = new Map<string, string>()
  const chartStyleRels = new Set<string>()
  const chartThemeOverrides = new Map<string, string>()
  const avRels = new Map<string, { target: string; external?: boolean }>()
  const diagramDrawings = new Map<string, string>()
  const diagramDatas = new Map<string, string>()
  const diagramMediaRels = new Map<string, Map<string, string>>()
  const diagramLayouts = new Map<string, string>()
  const diagramColors = new Map<string, string>()
  const vmlPreviews = new Map<string, string>()
  const hlinkRels = new Map<string, string>()
  const model3dRels = new Map<string, string>()
  let slideOrder: string[] | undefined
  for (const rel of rels.values()) {
    if (rel.type.endsWith('/hyperlink')) {
      hlinkRels.set(rel.id, rel.target)
    } else if (rel.type.endsWith('/slide')) {
      slideOrder ??= archive.readPresentation().slidePaths
      const idx = slideOrder.indexOf(resolveTarget(slidePath, rel.target))
      if (idx >= 0) hlinkRels.set(rel.id, `slide:${idx}`)
    } else if (rel.type.endsWith('/image')) {
      mediaRels.set(rel.id, resolveTarget(slidePath, rel.target))
    } else if (rel.type.endsWith('/chart') || rel.type.endsWith('/chartEx')) {
      const target = resolveTarget(slidePath, rel.target)
      const xml = archive.readText(target)
      if (xml) {
        chartXmls.set(rel.id, xml)
        chartMediaRels.set(rel.id, partMediaRels(archive, target))
        for (const sub of archive.readRels(target).values()) {
          if (sub.type.endsWith('/chartUserShapes')) {
            const usXml = archive.readText(resolveTarget(target, sub.target))
            if (usXml) chartUserShapes.set(rel.id, usXml)
          }
          if (sub.type.endsWith('/chartStyle')) chartStyleRels.add(rel.id)
          if (sub.type.endsWith('/themeOverride')) {
            const ovXml = archive.readText(resolveTarget(target, sub.target))
            if (ovXml) chartThemeOverrides.set(rel.id, ovXml)
          }
        }
      }
    } else if (/\/(?:video|audio|media)$/.test(rel.type)) {
      const external = rel.targetMode === 'External'
      avRels.set(rel.id, {
        target: external ? rel.target : resolveTarget(slidePath, rel.target),
        ...(external ? { external: true } : {}),
      })
    } else if (rel.type === MODEL3D_REL_TYPE) {
      model3dRels.set(rel.id, resolveTarget(slidePath, rel.target))
    } else if (rel.type.endsWith('/vmlDrawing')) {
      const vmlPath = resolveTarget(slidePath, rel.target)
      const vml = archive.readText(vmlPath)
      if (vml) {
        const vmlRels = archive.readRels(vmlPath)
        for (const m of vml.matchAll(/<v:shape\b([^>]*)>([\s\S]*?)<\/v:shape>/g)) {
          const relid = /<v:imagedata\b[^>]*\bo:relid="([^"]+)"/.exec(m[2]!)?.[1]
          const imgRel = relid ? vmlRels.get(relid) : undefined
          if (!imgRel) continue
          const target = resolveTarget(vmlPath, imgRel.target)
          for (const key of ['id', 'o:spid']) {
            const v = new RegExp(`\\b${key}="([^"]+)"`).exec(m[1]!)?.[1]
            if (v) vmlPreviews.set(v, target)
          }
        }
      }
    } else if (rel.type.endsWith('/diagramData')) {
      const dataPath = resolveTarget(slidePath, rel.target)
      const dataXml = archive.readText(dataPath)
      if (dataXml) diagramDatas.set(rel.id, dataXml)
      const relId = dataXml
        ? /<dsp:dataModelExt\b[^>]*\brelId="([^"]+)"/.exec(dataXml)?.[1]
        : undefined
      if (relId) {
        const drawRel = rels.get(relId) ?? archive.readRels(dataPath).get(relId)
        const basePath = rels.get(relId) ? slidePath : dataPath
        const drawingPath = drawRel ? resolveTarget(basePath, drawRel.target) : undefined
        const drawingXml = drawingPath ? archive.readText(drawingPath) : undefined
        if (drawingXml && drawingPath) {
          diagramDrawings.set(rel.id, drawingXml)
          diagramMediaRels.set(rel.id, partMediaRels(archive, drawingPath))
        }
      }
    } else if (rel.type.endsWith('/diagramLayout')) {
      const xml = archive.readText(resolveTarget(slidePath, rel.target))
      if (xml) diagramLayouts.set(rel.id, xml)
    } else if (rel.type.endsWith('/diagramColors')) {
      const xml = archive.readText(resolveTarget(slidePath, rel.target))
      if (xml) diagramColors.set(rel.id, xml)
    }
  }
  ctx.mediaRels = mediaRels
  ctx.chartXmls = chartXmls
  if (chartMediaRels.size) ctx.chartMediaRels = chartMediaRels
  if (chartUserShapes.size) ctx.chartUserShapes = chartUserShapes
  if (chartStyleRels.size) ctx.chartStyleRels = chartStyleRels
  ctx.chartThemeOverrides = chartThemeOverrides
  if (hlinkRels.size) ctx.hlinkRels = hlinkRels
  if (avRels.size) ctx.avRels = avRels
  if (model3dRels.size) ctx.model3dRels = model3dRels
  if (diagramDrawings.size) ctx.diagramDrawings = diagramDrawings
  if (diagramDatas.size) ctx.diagramDatas = diagramDatas
  if (diagramMediaRels.size) ctx.diagramMediaRels = diagramMediaRels
  if (diagramLayouts.size) ctx.diagramLayouts = diagramLayouts
  if (diagramColors.size) ctx.diagramColors = diagramColors
  if (vmlPreviews.size) ctx.vmlPreviews = vmlPreviews
  ctx.tableStyles = archive.readText('ppt/tableStyles.xml') ?? undefined

  return {
    path: slidePath,
    archive,
    slideXml,
    layoutPath: chain.layoutPath,
    masterPath: chain.masterPath,
    layoutXml,
    masterXml,
    ctx,
  }
}

/** index.ts `hfState`. */
function hfState(xml: string | undefined, attr: 'ftr' | 'sldNum' | 'dt'): 'on' | 'off' | 'unset' {
  if (!xml) return 'unset'
  const hf = /<p:hf\b[^>]*\/?>/.exec(xml)?.[0]
  if (!hf) return 'unset'
  if (new RegExp(`\\b${attr}="(?:1|true)"`).test(hf)) return 'on'
  if (new RegExp(`\\b${attr}="(?:0|false)"`).test(hf)) return 'off'
  return 'unset'
}

interface DecorationCall {
  xml: string
  ctx: ParseContext
  opts: { hfTypes: string[]; hideShapes: boolean; slideNum?: number }
}

/** The parseDecorations calls of index.ts `buildDecorations`, line for line. */
function buildDecorationCalls(s: DeckSlide, slide: Slide): DecorationCall[] {
  const { archive, layoutXml, masterXml } = s
  const out: DecorationCall[] = []
  let slideNum: number | undefined
  try {
    const idx = archive.readPresentation().slidePaths.indexOf(s.path)
    if (idx >= 0) slideNum = idx + 1
  } catch {
    /* missing slide-number substitution is acceptable */
  }
  const HF_ALL = ['ftr', 'sldNum', 'dt'] as const
  const enabled = new Set(
    HF_ALL.filter((k) => {
      const l = hfState(layoutXml, k)
      const m = hfState(masterXml, k)
      if (l === 'off' || m === 'off') return false
      return l === 'on' || m === 'on'
    }),
  )
  const slidePh = new Set(
    slide.elements.map((e) => (e as { placeholder?: string }).placeholder).filter(Boolean),
  )
  const hasPh = (xml: string | undefined, type: string) =>
    !!xml && new RegExp(`<p:ph\\b[^>]*type="${type}"`).test(xml)
  const slideHidesInherited = /<p:sld\b[^>]*showMasterSp=(?:"(?:0|false)"|'(?:0|false)')/.test(
    s.slideXml,
  )
  const masterShown =
    !slideHidesInherited &&
    !(
      layoutXml && /<p:sldLayout\b[^>]*showMasterSp=(?:"(?:0|false)"|'(?:0|false)')/.test(layoutXml)
    )
  const theme = s.ctx.theme
  if (masterXml && s.masterPath) {
    const hfTypes = [...enabled].filter((k) => !slidePh.has(k) && !hasPh(layoutXml, k))
    if (masterShown || hfTypes.length) {
      out.push({
        xml: masterXml,
        ctx: {
          theme,
          mediaRels: partMediaRels(archive, s.masterPath),
          defaultTextStyle: s.ctx.defaultTextStyle,
        },
        opts: { hfTypes, hideShapes: !masterShown, ...(slideNum != null ? { slideNum } : {}) },
      })
    }
  }
  if (layoutXml && s.layoutPath) {
    const hfTypes = [...enabled].filter((k) => !slidePh.has(k))
    if (!slideHidesInherited || hfTypes.length) {
      out.push({
        xml: layoutXml,
        ctx: {
          theme,
          mediaRels: partMediaRels(archive, s.layoutPath),
          masterPlaceholders: s.ctx.masterPlaceholders,
          masterTextStyles: s.ctx.masterTextStyles,
          defaultTextStyle: s.ctx.defaultTextStyle,
        },
        opts: {
          hfTypes,
          hideShapes: slideHidesInherited,
          ...(slideNum != null ? { slideNum } : {}),
        },
      })
    }
  }
  return out
}

const SLIDE_PART = /^ppt\/slides\/[^/]+\.xml$/
const LAYOUT_PART = /^ppt\/slideLayouts\/[^/]+\.xml$/
const MASTER_PART = /^ppt\/slideMasters\/[^/]+\.xml$/

const corpusCache = new WeakMap<ReadonlyMap<string, string>, DeckSlide[]>()

/** Every slide of a deck with the context index.ts gives it; a slide index.ts refuses is no input. */
function corpusSlides(parts: ReadonlyMap<string, string>): DeckSlide[] {
  const cached = corpusCache.get(parts)
  if (cached) return cached
  const archive = archiveOf(parts)
  const out: DeckSlide[] = []
  for (const path of [...parts.keys()].filter((name) => SLIDE_PART.test(name))) {
    try {
      const s = deckSlide(archive, path)
      if (s) out.push(s)
    } catch {
      /* openPptx throws for this deck */
    }
  }
  corpusCache.set(parts, out)
  return out
}

const slideArgs = (s: DeckSlide, ctx: Wire = toWire(s.ctx)): Wire => ({
  path: s.path,
  ...(s.layoutPath !== undefined ? { layoutPath: s.layoutPath } : {}),
  ...(s.masterPath !== undefined ? { masterPath: s.masterPath } : {}),
  ctx,
})

// ── Slide parts ───────────────────────────────────────────────────────

const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const NS_P = 'http://schemas.openxmlformats.org/presentationml/2006/main'
const NAMESPACES =
  `xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}" ` +
  'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" ' +
  'xmlns:a14="http://schemas.microsoft.com/office/drawing/2010/main" ' +
  'xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main" ' +
  'xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram" ' +
  'xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"'
const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
const TREE_HEAD =
  '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
  '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>'

/** A slide part around the inner XML of its `<p:spTree>`. */
const slidePart = (spTree: string, bg = '', attrs = ''): string =>
  `${XML_DECLARATION}<p:sld ${NAMESPACES}${attrs}><p:cSld>${bg}<p:spTree>${TREE_HEAD}${spTree}</p:spTree></p:cSld>` +
  '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>'

/** A layout or master part around the inner XML of its `<p:spTree>`. */
const shapeTreePart = (root: string, spTree: string, head = '', tail = '', attrs = ''): string =>
  `${XML_DECLARATION}<p:${root} ${NAMESPACES}${attrs}><p:cSld${head}><p:spTree>${TREE_HEAD}${spTree}</p:spTree></p:cSld>${tail}</p:${root}>`

const xfrm = (x: number, y: number, cx: number, cy: number): string =>
  `<a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>`
const runs = (inner: string): string =>
  `<p:txBody><a:bodyPr/><a:lstStyle/><a:p>${inner}</a:p></p:txBody>`
const run = (text: string): string => `<a:r><a:rPr lang="en-US"/><a:t>${text}</a:t></a:r>`
const field = (type: string, text: string): string =>
  `<a:fld id="{B6F15528-21DE-4FAA-801E-634DDDAF4B2B}" type="${type}"><a:rPr lang="en-US"/><a:t>${text}</a:t></a:fld>`

/** A `<p:sp>`, a placeholder when `ph` is given. */
const shape = (id: number, name: string, ph: string, geometry: string, body = ''): string =>
  `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr/><p:nvPr>${ph}</p:nvPr></p:nvSpPr>` +
  `<p:spPr>${geometry}${geometry ? '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>' : ''}</p:spPr>${body}</p:sp>`

const picture = (id: number, rId: string, ph = ''): string =>
  `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="Picture ${id}"/><p:cNvPicPr/><p:nvPr>${ph}</p:nvPr></p:nvPicPr>` +
  `<p:blipFill><a:blip r:embed="${rId}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>` +
  `<p:spPr>${xfrm(100, 100, 900, 600)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`

const CONNECTOR =
  '<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="40" name="Line 40"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr>' +
  `<p:spPr>${xfrm(0, 6400000, 12192000, 0)}<a:prstGeom prst="line"><a:avLst/></a:prstGeom>` +
  '<a:ln w="12700"><a:solidFill><a:schemeClr val="accent1"/></a:solidFill></a:ln></p:spPr></p:cxnSp>'

const group = (id: number, ...children: string[]): string =>
  `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="${id}" name="Group ${id}"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
  `<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="2000" cy="1000"/><a:chOff x="0" y="0"/><a:chExt cx="2000" cy="1000"/></a:xfrm></p:grpSpPr>` +
  `${children.join('')}</p:grpSp>`

// ── The built deck: base context B and the master-edit archives ───────

const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const rels = (...items: string[]): string =>
  `${XML_DECLARATION}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items.join('')}</Relationships>`
const rel = (id: string, type: string, target: string, extra = ''): string =>
  `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"${extra}/>`

const THEME_XML =
  `${XML_DECLARATION}<a:theme xmlns:a="${NS_A}" xmlns:r="${NS_R}" name="Gate"><a:themeElements>` +
  '<a:clrScheme name="Gate"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>' +
  '<a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1F2A44"/></a:dk2>' +
  '<a:lt2><a:srgbClr val="E7E6E6"/></a:lt2><a:accent1><a:srgbClr val="4472C4"/></a:accent1>' +
  '<a:accent2><a:srgbClr val="ED7D31"/></a:accent2><a:accent3><a:srgbClr val="A5A5A5"/></a:accent3>' +
  '<a:accent4><a:srgbClr val="FFC000"/></a:accent4><a:accent5><a:srgbClr val="5B9BD5"/></a:accent5>' +
  '<a:accent6><a:srgbClr val="70AD47"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink>' +
  '<a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme>' +
  '<a:fontScheme name="Gate"><a:majorFont><a:latin typeface="Georgia"/><a:ea typeface=""/><a:cs typeface=""/>' +
  '<a:font script="Jpan" typeface="Yu Gothic"/></a:majorFont><a:minorFont><a:latin typeface="Verdana"/>' +
  '<a:ea typeface="Malgun Gothic"/><a:cs typeface="Arial"/><a:font script="Hang" typeface="Malgun Gothic"/></a:minorFont></a:fontScheme>' +
  '<a:fmtScheme name="Gate"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
  '<a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:tint val="50000"/></a:schemeClr></a:gs>' +
  '<a:gs pos="100000"><a:schemeClr val="phClr"><a:shade val="80000"/></a:schemeClr></a:gs></a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill>' +
  '<a:blipFill><a:blip r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></a:blipFill></a:fillStyleLst>' +
  '<a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>' +
  '<a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>' +
  '<a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>' +
  '<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle>' +
  '<a:effectStyle><a:effectLst><a:outerShdw blurRad="57150" dist="19050" dir="5400000" algn="ctr" rotWithShape="0">' +
  '<a:srgbClr val="000000"><a:alpha val="63000"/></a:srgbClr></a:outerShdw></a:effectLst></a:effectStyle></a:effectStyleLst>' +
  '<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
  '<a:pattFill prst="pct20"><a:fgClr><a:schemeClr val="phClr"/></a:fgClr><a:bgClr><a:srgbClr val="FFFFFF"/></a:bgClr></a:pattFill>' +
  '<a:blipFill><a:blip r:embed="rId1"/><a:tile tx="0" ty="0" sx="100000" sy="100000" flip="none" algn="tl"/></a:blipFill>' +
  '</a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>'

const SLIDE_NUMBER = field('slidenum', '\u2039#\u203A')

/** Footer, date and number placeholders, the decoration shapes, both in a master and a layout. */
const masterTree = (prefix: string): string =>
  shape(2, 'Title Placeholder 1', '<p:ph type="title"/>', xfrm(457200, 274638, 8229600, 1143000), runs(run(`${prefix} title`))) +
  shape(3, 'Text Placeholder 2', '<p:ph type="body" idx="1"/>', xfrm(457200, 1600200, 8229600, 4525963), runs(run(`${prefix} text`))) +
  shape(4, 'Date Placeholder 3', '<p:ph type="dt" sz="half" idx="2"/>', xfrm(457200, 6356350, 2133600, 365125), runs(field('datetime1', '11/12/2026'))) +
  shape(5, 'Footer Placeholder 4', '<p:ph type="ftr" sz="quarter" idx="3"/>', xfrm(3124200, 6356350, 2895600, 365125), runs(run(`${prefix} footer`))) +
  shape(6, 'Slide Number Placeholder 5', '<p:ph type="sldNum" sz="quarter" idx="4"/>', xfrm(6553200, 6356350, 2133600, 365125), runs(SLIDE_NUMBER)) +
  picture(7, 'rId3') +
  shape(8, `${prefix} band`, '', xfrm(0, 0, 12192000, 200000), runs(run('Page ') + SLIDE_NUMBER)) +
  CONNECTOR

const MASTER_XML = shapeTreePart(
  'sldMaster',
  masterTree('Master'),
  ' name="Gate Master"><p:bg><p:bgRef idx="1002"><a:schemeClr val="accent2"/></p:bgRef></p:bg',
  '<p:clrMap bg1="dk1" tx1="lt1" bg2="dk2" tx2="lt2" accent1="accent1" accent2="accent2" accent3="accent3" ' +
    'accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>' +
    '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>' +
    '<p:hf hdr="0" ftr="1" dt="1" sldNum="1"/>' +
    '<p:txStyles><p:titleStyle><a:lvl1pPr algn="l"><a:defRPr sz="4400"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill>' +
    '<a:latin typeface="+mj-lt"/></a:defRPr></a:lvl1pPr></p:titleStyle><p:bodyStyle><a:lvl1pPr marL="228600" indent="-228600">' +
    '<a:buFont typeface="Arial"/><a:buChar char="\u2022"/><a:defRPr sz="2800"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill>' +
    '</a:defRPr></a:lvl1pPr><a:lvl2pPr marL="685800"><a:defRPr sz="2400"/></a:lvl2pPr></p:bodyStyle>' +
    '<p:otherStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:otherStyle></p:txStyles>',
)

const LAYOUT_TREE =
  shape(2, 'Title 1', '<p:ph type="title"/>', '') +
  shape(3, 'Content Placeholder 2', '<p:ph idx="1"/>', '') +
  shape(4, 'Date Placeholder 3', '<p:ph type="dt" sz="half" idx="10"/>', '', runs(field('datetime1', '11/12/2026'))) +
  shape(5, 'Footer Placeholder 4', '<p:ph type="ftr" sz="quarter" idx="11"/>', '') +
  shape(6, 'Slide Number Placeholder 5', '<p:ph type="sldNum" sz="quarter" idx="12"/>', '', runs(SLIDE_NUMBER)) +
  shape(9, 'Layout band', '', xfrm(0, 6600000, 12192000, 258000), runs(run('Layout band')))

const layoutPart = (attrs = ''): string =>
  shapeTreePart(
    'sldLayout',
    LAYOUT_TREE,
    ' name="Title and Content"><p:bg><p:bgPr><a:blipFill><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></a:blipFill><a:effectLst/></p:bgPr></p:bg',
    '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>',
    ` type="obj" preserve="1"${attrs}`,
  )

const PRESENTATION_XML =
  `${XML_DECLARATION}<p:presentation ${NAMESPACES}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>` +
  '<p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/>' +
  '<p:defaultTextStyle><a:defPPr><a:defRPr lang="en-US"/></a:defPPr><a:lvl1pPr marL="0" algn="l" defTabSz="914400">' +
  '<a:defRPr sz="1800" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/>' +
  '<a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl1pPr><a:lvl2pPr marL="457200"><a:defRPr sz="1600"/></a:lvl2pPr>' +
  '</p:defaultTextStyle></p:presentation>'

const MASTER_PATH = 'ppt/slideMasters/slideMaster1.xml'
const LAYOUT_PATH = 'ppt/slideLayouts/slideLayout1.xml'
const MASTER_RELS = 'ppt/slideMasters/_rels/slideMaster1.xml.rels'
const LAYOUT_RELS = 'ppt/slideLayouts/_rels/slideLayout1.xml.rels'
const THEME_PATH = 'ppt/theme/theme1.xml'

const BUILT_DECK: Parts = [
  ['ppt/presentation.xml', PRESENTATION_XML],
  [
    'ppt/_rels/presentation.xml.rels',
    rels(
      rel('rId1', 'slideMaster', 'slideMasters/slideMaster1.xml'),
      rel('rId2', 'slide', 'slides/slide1.xml'),
      rel('rId3', 'theme', 'theme/theme1.xml'),
      rel('rId4', 'tableStyles', 'tableStyles.xml'),
    ),
  ],
  ['ppt/slides/slide1.xml', slidePart('')],
  [
    'ppt/slides/_rels/slide1.xml.rels',
    rels(
      rel('rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'),
      rel('rId2', 'image', '../media/image1.png'),
      rel('rId3', 'hyperlink', 'https://example.com/', ' TargetMode="External"'),
      rel('rId4', 'slide', 'slide1.xml'),
    ),
  ],
  [LAYOUT_PATH, layoutPart()],
  [
    LAYOUT_RELS,
    rels(
      rel('rId1', 'slideMaster', '../slideMasters/slideMaster1.xml'),
      rel('rId2', 'image', '../media/image2.png'),
    ),
  ],
  [MASTER_PATH, MASTER_XML],
  [
    MASTER_RELS,
    rels(
      rel('rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'),
      rel('rId2', 'theme', '../theme/theme1.xml'),
      rel('rId3', 'image', '../media/image3.png'),
    ),
  ],
  [THEME_PATH, THEME_XML],
  ['ppt/theme/_rels/theme1.xml.rels', rels(rel('rId1', 'image', '../media/image4.png'))],
  [
    'ppt/tableStyles.xml',
    `${XML_DECLARATION}<a:tblStyleLst xmlns:a="${NS_A}" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>`,
  ],
]

const without = (parts: Parts, ...names: string[]): Parts =>
  parts.filter(([name]) => !names.includes(name))
const replacing = (parts: Parts, name: string, text: string): Parts => [
  ...without(parts, name),
  [name, text],
]

// ── Base contexts ─────────────────────────────────────────────────────

interface Base {
  layoutPath?: string
  masterPath?: string
  wire: Wire
}

function baseOf(archive: PackageArchive, slidePath: string): Base {
  const s = deckSlide(archive, slidePath)
  if (!s) throw new Error(`the base slide ${slidePath} is missing`)
  return { layoutPath: s.layoutPath, masterPath: s.masterPath, wire: toWire(s.ctx) }
}

const DECK_01 = await PackageArchive.open(
  readFileSync(
    new URL('../../packages/pptx-engine/tests/fixtures/01_standard_business.pptx', import.meta.url),
  ),
)

/**
 * A: the theme, layout and master of a tracked deck (its master background is a
 * bgRef). B: the built deck (a dark clrMap, a layout picture background).
 */
const BASES: Base[] = [
  baseOf(DECK_01, 'ppt/slides/slide2.xml'),
  baseOf(archiveOf(BUILT_DECK), 'ppt/slides/slide1.xml'),
]
const [BASE_A, BASE_B] = BASES as [Base, Base]

const slideInput = (base: Base, text: string, ctx: Wire = {}, seed?: boolean): Input => ({
  text,
  args: {
    path: 'ppt/slides/slide1.xml',
    ...(base.layoutPath !== undefined ? { layoutPath: base.layoutPath } : {}),
    ...(base.masterPath !== undefined ? { masterPath: base.masterPath } : {}),
    ctx: { ...base.wire, ...ctx },
  },
  ...(seed === false ? { seed: false as const } : {}),
})

// ── parseSlide ────────────────────────────────────────────────────────

const ONE_SHAPE = shape(2, 'Box', '', xfrm(0, 0, 100, 100), runs(run('box')))
const solidBg = (hex: string): string =>
  `<p:bg><p:bgPr><a:solidFill><a:srgbClr val="${hex}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>`

/** What the slide part around the tree decides: its own background and showMasterSp. */
const SLIDE_FORMS: string[] = [
  slidePart(ONE_SHAPE, solidBg('0000FF')),
  slidePart(ONE_SHAPE, '<p:bg><p:bgPr><a:effectLst/></p:bgPr></p:bg>'),
  slidePart(ONE_SHAPE, '<p:bg/>'),
  slidePart(ONE_SHAPE, '<p:bg ><p:bgPr><a:solidFill><a:srgbClr val="00FF00"/></a:solidFill></p:bgPr></p:bg>'),
  slidePart(ONE_SHAPE, '<p:bg><p:bgRef idx="1001"><a:schemeClr val="bg2"/></p:bgRef></p:bg>'),
  slidePart(ONE_SHAPE, '<p:bg><p:bgRef idx="7"><a:srgbClr val="123456"/></p:bgRef></p:bg>'),
  slidePart(
    ONE_SHAPE,
    '<!-- <p:bg><p:bgPr><a:solidFill><a:srgbClr val="FF00FF"/></a:solidFill></p:bgPr></p:bg> -->',
  ),
  slidePart(ONE_SHAPE, solidBg('111111') + solidBg('222222')),
  slidePart(ONE_SHAPE, '', ' showMasterSp="0"'),
  slidePart(ONE_SHAPE, '', ' showMasterSp="false"'),
  slidePart(ONE_SHAPE, '', " showMasterSp='0'"),
  slidePart(ONE_SHAPE, '', ' showMasterSp="1"'),
  slidePart(ONE_SHAPE, '', ' show="1" showMasterSp="0" showPhAnim="1"'),
  slidePart(ONE_SHAPE, '', ' showMasterSp = "0"'),
  slidePart(ONE_SHAPE, '', ' xshowMasterSp="0"'),
  slidePart(ONE_SHAPE, solidBg('333333'), ' showMasterSp="0"'),
  shapeTreePart('sldLayout', ONE_SHAPE, '', '', ' showMasterSp="0"'),
  `\uFEFF${slidePart(ONE_SHAPE)}`,
  `<p:sld ${NAMESPACES}><p:cSld><p:spTree>${ONE_SHAPE}</p:spTree><p:spTree>${ONE_SHAPE}</p:spTree></p:cSld></p:sld>`,
  `<p:sld ${NAMESPACES}><p:cSld/></p:sld>`,
  `<p:sld ${NAMESPACES}><p:cSld><p:spTree>${ONE_SHAPE}`,
  `<p:sld ${NAMESPACES}><p:cSld><p:spTree></p:sp></p:spTree></p:cSld></p:sld>`,
  '',
]

const PARSE_SLIDE_BUILT: Input[] = [
  ...BASES.flatMap((base) => [
    ...ENTRIES.map((entry) =>
      slideInput(base, slidePart(entry.spTree), entry.ctx as Wire | undefined, entry.seed),
    ),
    ...SLIDE_FORMS.map((text) => slideInput(base, text)),
  ]),
  ...SLIDE_FORMS.map((text): Input => ({ text, args: { path: 'ppt/slides/slide9.xml', ctx: {} } })),
]

// ── parseBackground ───────────────────────────────────────────────────

const bgRef = (idx: string, color = '<a:schemeClr val="accent1"/>'): string =>
  `<p:bg><p:bgRef idx="${idx}">${color}</p:bgRef></p:bg>`

const BACKGROUNDS: string[] = [
  '',
  slidePart(ONE_SHAPE),
  solidBg('FF0000'),
  '<p:bg><p:bgPr><a:solidFill><a:schemeClr val="bg1"><a:lumMod val="85000"/></a:schemeClr></a:solidFill></p:bgPr></p:bg>',
  '<p:bg><p:bgPr><a:gradFill><a:gsLst><a:gs pos="0"><a:srgbClr val="000000"/></a:gs><a:gs pos="100000"><a:schemeClr val="accent1"/></a:gs></a:gsLst><a:lin ang="2700000"/></a:gradFill></p:bgPr></p:bg>',
  '<p:bg><p:bgPr><a:blipFill dpi="0" rotWithShape="1"><a:blip r:embed="rId2"/><a:srcRect/><a:tile tx="0" ty="0" sx="50000" sy="50000" flip="xy" algn="ctr"/></a:blipFill></p:bgPr></p:bg>',
  '<p:bg><p:bgPr><a:blipFill><a:blip r:embed="rIdMissing"/><a:stretch><a:fillRect/></a:stretch></a:blipFill></p:bgPr></p:bg>',
  '<p:bg><p:bgPr><a:pattFill prst="dkDnDiag"><a:fgClr><a:srgbClr val="FF0000"/></a:fgClr><a:bgClr><a:schemeClr val="bg1"/></a:bgClr></a:pattFill></p:bgPr></p:bg>',
  '<p:bg><p:bgPr><a:noFill/></p:bgPr></p:bg>',
  '<p:bg><p:bgPr/></p:bg>',
  '<p:bg><p:bgPr></p:bgPr></p:bg>',
  '<p:bg><p:bgPr><a:grpFill/></p:bgPr></p:bg>',
  '<p:bg bwMode="white"><p:bgPr><a:solidFill><a:srgbClr val=\'00FF00\'/></a:solidFill></p:bgPr><p:bgRef idx="1"><a:srgbClr val="0000FF"/></p:bgRef></p:bg>',
  ...['1001', '1002', '1003', '1004', '1', '2', '3', '4', '0', '-1', '', 'abc', '1001.9', ' 1002', '+2', '1e3', '0x3EA', '99999999999999999999', 'constructor'].map((idx) => bgRef(idx)),
  bgRef('1001', '<a:schemeClr val="phClr"/>'),
  bgRef('1001', '<a:srgbClr val="ABCDEF"><a:alpha val="50000"/></a:srgbClr>'),
  bgRef('1001', '<a:prstClr val="red"/>'),
  bgRef('2', '<a:sysClr val="window" lastClr="FFFFFF"/>'),
  bgRef('1003', ''),
  bgRef('0', ''),
  bgRef('9', '<a:schemeClr val="accent9"/>'),
  '<p:bg><p:bgRef><a:schemeClr val="tx2"/></p:bgRef></p:bg>',
  '<p:bg><p:bgRef>text</p:bgRef></p:bg>',
  '<p:bg>text only</p:bg>',
  '<p:bg/><p:bg><p:bgPr><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></p:bgPr></p:bg>',
  '<p:bgx><p:bgPr><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></p:bgPr></p:bgx>',
  '<p:bg-x><p:bgPr><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></p:bgPr></p:bg-x></p:bg>',
  '<p:bg><p:bgPr><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></p:bg>',
  '<p:bg><p:bgPr><a:solidFill><a:srgbClr val="FF0000"></p:bgPr></p:bg>',
  '<p:bg><p:bgPr><a:solidFill><a:srgbClr val="\uD55C\u{1F600}"/></a:solidFill></p:bgPr></p:bg>',
]

/** The background calls parseSlide makes for one slide: its own, its layout's, its master's. */
function backgroundInputs(s: DeckSlide): Input[] {
  const ctx = s.ctx
  const out: Input[] = [{ text: s.slideXml, args: { ctx: toWire(ctx) } }]
  if (ctx.layoutBg) {
    out.push({
      text: ctx.layoutBg,
      args: { ctx: toWire({ ...ctx, mediaRels: ctx.layoutMediaRels ?? ctx.mediaRels }) },
    })
  }
  if (ctx.masterBg) {
    out.push({
      text: ctx.masterBg,
      args: { ctx: toWire({ ...ctx, mediaRels: ctx.masterMediaRels ?? ctx.mediaRels }) },
    })
  }
  return out
}

const BACKGROUND_CONTEXTS: Wire[] = [
  BASE_A.wire,
  BASE_B.wire,
  { ...BASE_B.wire, themeMediaRels: null, mediaRels: [['rId1', 'ppt/media/slide.png']] },
  {},
]

// ── sliceGroupChildXmls ───────────────────────────────────────────────

/** Every `<p:grpSp>…</p:grpSp>` of `xml`, nested ones too, outermost first. */
function groupsOf(xml: string): string[] {
  const out: Array<[number, string]> = []
  const open: number[] = []
  for (const m of xml.matchAll(/<(\/?)p:grpSp\b(?:"[^"]*"|'[^']*'|[^"'>])*?(\/?)>/g)) {
    if (m[2]) continue
    if (!m[1]) {
      open.push(m.index!)
    } else {
      const start = open.pop()
      if (start !== undefined) out.push([start, xml.slice(start, m.index! + m[0].length)])
    }
  }
  return out.sort(([a], [b]) => a - b).map(([, group]) => group)
}

const GROUPS: string[] = [
  group(3, ONE_SHAPE, CONNECTOR, picture(4, 'rId2')),
  group(3, group(4, ONE_SHAPE, group(5, ONE_SHAPE)), ONE_SHAPE),
  group(3, '<p:sp/><p:pic/><p:grpSp/><p:graphicFrame/><p:cxnSp/>'),
  group(3, '<!-- <p:sp>commented</p:sp> -->', ONE_SHAPE, '<![CDATA[<p:sp>]]>', '<?pi <p:sp> ?>'),
  group(3, '<p:sp name="a>b"><p:spPr/></p:sp>', "<p:pic descr='<x>'/>"),
  group(3, '< p:sp ><p:spPr/></p:sp>', '<p:sp\n\t><p:spPr/></p:sp>'),
  group(3, '<p:extLst><p:ext uri="x"><p:sp/></p:ext></p:extLst>', '<mc:AlternateContent><mc:Choice><p:sp/></mc:Choice></mc:AlternateContent>'),
  group(3, '<p:sp>', ONE_SHAPE),
  group(3, '</p:sp></p:sp>', ONE_SHAPE),
  group(3),
  '<p:grpSp/>',
  '<p:sp><p:spPr/></p:sp>',
  '<p:grpSp><p:sp></p:grpSp>',
  `<p:grpSp>${'<p:sp/>'.repeat(3)}\uD55C\u{1F600}<p:sp><a:t>\u{1F600}</a:t></p:sp></p:grpSp>`,
  'text',
  '',
]

// ── layoutDiagramFallback ─────────────────────────────────────────────

const DGM = 'http://schemas.openxmlformats.org/drawingml/2006/diagram'
const dataModel = (pts: string, cxns: string): string =>
  `<dgm:dataModel xmlns:dgm="${DGM}" xmlns:a="${NS_A}"><dgm:ptLst>${pts}</dgm:ptLst><dgm:cxnLst>${cxns}</dgm:cxnLst><dgm:bg/><dgm:whole/></dgm:dataModel>`
const point = (id: string, text: string, attrs = ''): string =>
  `<dgm:pt modelId="${id}"${attrs}><dgm:prSet/><dgm:spPr/><dgm:t><a:bodyPr/><a:lstStyle/>` +
  `<a:p><a:r><a:rPr lang="en-US" sz="1400"/><a:t>${text}</a:t></a:r></a:p></dgm:t></dgm:pt>`
const link = (id: string, src: string, dest: string, ord: string, attrs = ''): string =>
  `<dgm:cxn modelId="${id}" srcId="${src}" destId="${dest}" srcOrd="${ord}" destOrd="0"${attrs}/>`
const DOC = '<dgm:pt modelId="0" type="doc"><dgm:prSet/><dgm:spPr/><dgm:t><a:bodyPr/><a:p/></dgm:t></dgm:pt>'

const FLAT = dataModel(
  DOC + point('1', 'Plan') + point('2', 'Build') + point('3', '\uD55C\uAE00 \u{1F600}'),
  link('c1', '0', '1', '0') + link('c2', '0', '2', '1') + link('c3', '0', '3', '2'),
)
const TREE = dataModel(
  DOC +
    point('1', 'Root') +
    point('2', 'Assistant', ' type="asst"') +
    point('3', 'Left') +
    point('4', 'Leaf') +
    point('5', 'Right', ' type="node"') +
    '<dgm:pt modelId="p1" type="pres"><dgm:prSet presAssocID="3" presStyleLbl="node2" presStyleIdx="1"><dgm:presLayoutVars><dgm:hierBranch val="hang"/></dgm:presLayoutVars></dgm:prSet><dgm:spPr/></dgm:pt>' +
    '<dgm:pt modelId="t1" type="parTrans"><dgm:prSet/><dgm:spPr/></dgm:pt>',
  link('c1', '0', '1', '0') +
    link('c2', '1', '2', '0') +
    link('c3', '1', '3', '1') +
    link('c4', '3', '4', '0') +
    link('c5', '1', '5', 'x') +
    link('c6', '5', '9', '0') +
    link('c7', '1', '4', '2', ' type="presOf"'),
)
const DIAGRAM_DATAS = [
  FLAT,
  TREE,
  dataModel(DOC, ''),
  dataModel(point('1', 'No document point'), ''),
  `<dgm:dataModel xmlns:dgm="${DGM}"><dgm:ptLst>${DOC}`,
  '',
]
const LAYOUT_IDS: Array<string | undefined> = [
  undefined,
  'default',
  'cycle4',
  'arrow5',
  'hProcess3',
  'hList1',
  'hList3',
  'pList1',
  'list1',
  'vList5',
  'Bracket1',
  'vProcess5',
  'vList2',
  'bList2',
  'process4',
  'process1',
  'lProcess2',
  'equation1',
  'pyramid1',
  'Picture1',
  'chevron2',
  'chevron1',
  'cycle2',
  'radial1',
  'orgChart1',
  'hierarchy1',
  'constructor',
]
const COLORS_XML =
  `<dgm:colorsDef xmlns:dgm="${DGM}" xmlns:a="${NS_A}" uniqueId="urn:microsoft.com/office/officeart/2005/8/colors/accent1_2">` +
  '<dgm:styleLbl name="node0"><dgm:fillClrLst meth="repeat"><a:schemeClr val="accent1"/></dgm:fillClrLst><dgm:txFillClrLst><a:schemeClr val="lt1"/></dgm:txFillClrLst></dgm:styleLbl>' +
  '<dgm:styleLbl name="node2"><dgm:fillClrLst meth="cycle"><a:schemeClr val="accent2"/><a:schemeClr val="accent3"/></dgm:fillClrLst></dgm:styleLbl></dgm:colorsDef>'

const diagramInput = (
  dataXml: string,
  ctx: Wire,
  frame: [number, number],
  layoutId?: string,
  colorsXml?: string,
  layoutXml?: string,
): Input => ({
  text: dataXml,
  args: {
    ctx,
    frameCx: frame[0],
    frameCy: frame[1],
    ...(layoutId !== undefined ? { layoutId } : {}),
    ...(colorsXml !== undefined ? { colorsXml } : {}),
    ...(layoutXml !== undefined ? { layoutXml } : {}),
  },
})

/** The data parts of the entries' contexts, laid out as graphicFramePassthrough lays them out. */
const ENTRY_DIAGRAMS: Input[] = ENTRIES.flatMap((entry) => {
  const ctx = (entry.ctx ?? {}) as Wire
  const datas = (ctx.diagramDatas ?? []) as Parts
  const layoutXml = ((ctx.diagramLayouts ?? []) as Parts)[0]?.[1]
  const colorsXml = ((ctx.diagramColors ?? []) as Parts)[0]?.[1]
  const uniqueId = layoutXml
    ? /\buniqueId="([^"]+)"/.exec(layoutXml)?.[1]?.split('/').pop()
    : undefined
  return datas.map(([, dataXml]) =>
    diagramInput(dataXml, { ...BASE_B.wire, ...ctx }, [6096000, 4064000], uniqueId, colorsXml, layoutXml),
  )
})

const DIAGRAM_BUILT: Input[] = [
  ...[FLAT, TREE].flatMap((dataXml) =>
    LAYOUT_IDS.map((layoutId) => diagramInput(dataXml, BASE_B.wire, [8128000, 5418667], layoutId)),
  ),
  ...DIAGRAM_DATAS.map((dataXml) => diagramInput(dataXml, BASE_A.wire, [1000, 1000])),
  diagramInput(TREE, BASE_A.wire, [8128000, 5418667], 'hierarchy1', COLORS_XML),
  diagramInput(FLAT, BASE_B.wire, [8128000, 5418667], 'process1', COLORS_XML),
  diagramInput(FLAT, {}, [0, 0], 'hList1'),
  diagramInput(TREE, {}, [-500, 3e12], 'orgChart1'),
  diagramInput(FLAT, BASE_B.wire, [12.5, 7.25], 'chevron2', '<dgm:colorsDef/>', '<dgm:layoutDef/>'),
  ...ENTRY_DIAGRAMS,
]

// ── parseDecorations ──────────────────────────────────────────────────

const DECORATION_TREE =
  masterTree('Deco') +
  shape(10, 'Body without type', '<p:ph idx="10"/>', xfrm(0, 0, 10, 10), runs(run('body'))) +
  shape(11, 'Empty ph', '<p:ph/>', xfrm(0, 0, 10, 10), runs(run('empty ph'))) +
  shape(12, 'Odd ph', '<p:ph type="constructor"/>', xfrm(0, 0, 10, 10), runs(SLIDE_NUMBER)) +
  shape(13, 'Proto ph', '<p:ph type="__proto__"/>', xfrm(0, 0, 10, 10), runs(run('proto'))) +
  shape(14, 'Quoted number', "<p:ph type='sldNum'/>", xfrm(0, 0, 10, 10), runs(SLIDE_NUMBER + SLIDE_NUMBER)) +
  shape(15, 'Comment ph', '<!-- <p:ph/> -->', xfrm(0, 0, 10, 10), runs(run('looks like a placeholder'))) +
  picture(16, 'rId3', '<p:ph type="pic" idx="13"/>') +
  group(17, shape(18, 'Grouped number', '', xfrm(0, 0, 10, 10), runs(run('No. ') + SLIDE_NUMBER)), CONNECTOR) +
  group(19, shape(20, 'Grouped footer', '<p:ph type="ftr"/>', xfrm(0, 0, 10, 10), runs(run('f')))) +
  '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="21" name="Unknown"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>' +
  `<p:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="100"/></p:xfrm><a:graphic><a:graphicData uri="urn:unknown"/></a:graphic></p:graphicFrame>` +
  shape(22, 'Other field', '', xfrm(0, 0, 10, 10), runs(field('slidenumx', '9') + field('SLIDENUM', '8')))

const DECORATION_PARTS: string[] = [
  shapeTreePart('sldMaster', DECORATION_TREE),
  shapeTreePart('sldLayout', LAYOUT_TREE),
  MASTER_XML,
  `<p:sldMaster ${NAMESPACES}><p:cSld/></p:sldMaster>`,
  '',
]

const DECORATION_OPTIONS: Array<Wire | undefined> = [
  undefined,
  {},
  { hfTypes: [] },
  { hfTypes: ['ftr', 'sldNum', 'dt'] },
  { hfTypes: ['sldNum'], slideNum: 7 },
  { hfTypes: ['dt', 'ftr'], hideShapes: true },
  { hideShapes: true, slideNum: 0 },
  { slideNum: -3.5 },
  { slideNum: 1e21 },
  { hfTypes: ['body', 'title', 'constructor', '__proto__'], slideNum: 12, hideShapes: false },
]

const decorationContexts = (base: Base): Wire[] => [
  base.wire,
  { theme: base.wire.theme, mediaRels: base.wire.masterMediaRels, defaultTextStyle: base.wire.defaultTextStyle },
]

const DECORATIONS_BUILT: Input[] = [BASE_A, BASE_B].flatMap((base) =>
  decorationContexts(base).flatMap((ctx) =>
    DECORATION_PARTS.flatMap((text) =>
      DECORATION_OPTIONS.map((opts): Input => ({ text, args: { ctx, ...(opts ? { opts } : {}) } })),
    ),
  ),
)

/** The calls buildDecorations makes for each slide, then each layout and master with every footer type. */
function corpusDecorations(parts: ReadonlyMap<string, string>): Input[] {
  const slides = corpusSlides(parts)
  const out: Input[] = []
  for (const s of slides) {
    let slide: Slide
    try {
      slide = parseSlide({
        path: s.path,
        slideXml: s.slideXml,
        layoutPath: s.layoutPath,
        masterPath: s.masterPath,
        ctx: s.ctx,
      })
    } catch {
      continue
    }
    for (const { xml, ctx, opts } of buildDecorationCalls(s, slide)) {
      out.push({ text: xml, args: { ctx: toWire(ctx), opts } })
    }
  }
  const first = slides[0]
  if (first) {
    const ctx = toWire({
      theme: first.ctx.theme,
      masterPlaceholders: first.ctx.masterPlaceholders,
      masterTextStyles: first.ctx.masterTextStyles,
      defaultTextStyle: first.ctx.defaultTextStyle,
    })
    for (const [name, xml] of parts) {
      if (!LAYOUT_PART.test(name) && !MASTER_PART.test(name)) continue
      out.push({
        text: xml,
        args: { ctx, opts: { hfTypes: ['ftr', 'sldNum', 'dt'], slideNum: 3 } },
      })
    }
  }
  return out
}

// ── master-edit ───────────────────────────────────────────────────────

const MASTER_LISTS: Input[] = [
  splitOff(BUILT_DECK, MASTER_PATH),
  { args: { parts: BUILT_DECK } },
  { args: { parts: [] } },
  splitOff(
    [
      ...replacing(BUILT_DECK, MASTER_RELS, rels(
        rel('rId9', 'slideLayout', '../slideLayouts/slideLayout11.xml'),
        rel('rId2', 'theme', '../theme/theme1.xml'),
        rel('rId8', 'slideLayout', '../slideLayouts/slideLayout2.xml'),
        rel('rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'),
        rel('rId7', 'slideLayout', '/ppt/slideLayouts/layoutA.xml'),
        rel('rId6', 'slideLayout', '../slideLayouts/layout'),
        rel('rId5', 'slideLayoutX', '../slideLayouts/slideLayout3.xml'),
        rel('rId4', 'slideLayout', '../slideLayouts/slideLayout99999999999999999999999.xml'),
        rel('rId3', 'slideLayout', '../slideLayouts/slideLayout1.xml'),
      )),
      ['ppt/slideLayouts/slideLayout2.xml', shapeTreePart('sldLayout', '', ' name="Second &amp; \uD55C \u{1F600}"')],
      ['ppt/slideLayouts/slideLayout11.xml', shapeTreePart('sldLayout', '', " name='Single quoted'")],
      ['ppt/slideLayouts/layoutA.xml', '<p:sldLayout><p:cSldX name="Not cSld"/></p:sldLayout>'],
    ],
    MASTER_PATH,
  ),
  {
    text: MASTER_XML.replace(' name="Gate Master"', ' name=""'),
    args: {
      parts: [
        ...without(BUILT_DECK, MASTER_PATH),
        ['ppt/slideMasters/slideMaster10.xml', shapeTreePart('sldMaster', '', ' name="Tenth"')],
        ['ppt/slideMasters/slideMaster2.xml', '<p:sldMaster><p:cSld\nname="__proto__"/></p:sldMaster>'],
        ['ppt/slideMasters/slideMasterX.xml', MASTER_XML],
        ['ppt/slideMasters/slideMaster3.xml.bak', MASTER_XML],
        ['ppt/slideMasters/sub/slideMaster4.xml', MASTER_XML],
        ['/ppt/slideMasters/slideMaster5.xml', MASTER_XML],
        ['ppt/slideMasters/slideMaster6.xml', ''],
      ],
      textPart: MASTER_PATH,
    },
  },
  {
    text: '<p:sldMaster><p:cSld name="Broken rels"/></p:sldMaster>',
    args: {
      parts: [['ppt/slideMasters/_rels/slideMaster1.xml.rels', '<Relationships><']],
      textPart: MASTER_PATH,
    },
  },
]

function masterPartInput(parts: Parts, textPart: string, path = textPart): Input {
  const { text, args } = splitOff(parts, textPart)
  return { text, args: { ...args, path } }
}

const MASTER_PARTS: Input[] = [
  masterPartInput(BUILT_DECK, MASTER_PATH),
  masterPartInput(BUILT_DECK, LAYOUT_PATH),
  masterPartInput(replacing(BUILT_DECK, LAYOUT_PATH, layoutPart(' showMasterSp="0"')), LAYOUT_PATH),
  masterPartInput(replacing(BUILT_DECK, LAYOUT_PATH, layoutPart(" showMasterSp='false'")), LAYOUT_PATH),
  masterPartInput(replacing(BUILT_DECK, LAYOUT_PATH, layoutPart(' showMasterSp="1"')), LAYOUT_PATH),
  masterPartInput(
    replacing(BUILT_DECK, MASTER_PATH, shapeTreePart('sldMaster', masterTree('Plain').replace(/<p:pic>[\s\S]*<\/p:cxnSp>$/, ''))),
    LAYOUT_PATH,
  ),
  masterPartInput(without(BUILT_DECK, LAYOUT_RELS), LAYOUT_PATH),
  masterPartInput(replacing(BUILT_DECK, MASTER_RELS, rels(rel('rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'))), MASTER_PATH),
  masterPartInput(replacing(BUILT_DECK, MASTER_RELS, rels(rel('rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'))), LAYOUT_PATH),
  masterPartInput(replacing(BUILT_DECK, THEME_PATH, ''), LAYOUT_PATH),
  masterPartInput(replacing(BUILT_DECK, THEME_PATH, '<a:theme><a:themeElements><'), MASTER_PATH),
  masterPartInput(without(BUILT_DECK, MASTER_PATH), LAYOUT_PATH),
  masterPartInput(replacing(BUILT_DECK, MASTER_PATH, ''), LAYOUT_PATH),
  masterPartInput(without(BUILT_DECK, 'ppt/tableStyles.xml'), MASTER_PATH),
  masterPartInput(replacing(BUILT_DECK, 'ppt/tableStyles.xml', ''), LAYOUT_PATH),
  masterPartInput(replacing(BUILT_DECK, LAYOUT_PATH, '<p:sldLayout><p:cSld/></p:sldLayout>'), LAYOUT_PATH),
  masterPartInput(replacing(BUILT_DECK, LAYOUT_PATH, ''), LAYOUT_PATH),
  masterPartInput(BUILT_DECK, LAYOUT_PATH, 'ppt/slideLayouts/missing.xml'),
  masterPartInput(BUILT_DECK, MASTER_PATH, 'ppt/other/slideMasters/master.xml'),
  {
    text: MASTER_XML,
    args: { parts: without(BUILT_DECK, MASTER_PATH), textPart: 'x/slideMasters/a.xml', path: 'x/slideMasters/a.xml' },
  },
  masterPartInput(
    replacing(BUILT_DECK, LAYOUT_RELS, '<Relationships><'),
    LAYOUT_PATH,
  ),
]

/** Every master and layout of a deck, and a slide read as one. */
function corpusMasterParts(parts: ReadonlyMap<string, string>): Input[] {
  const all = [...parts]
  const names = all
    .map(([name]) => name)
    .filter((name) => MASTER_PART.test(name) || LAYOUT_PART.test(name))
  const slide = all.find(([name]) => SLIDE_PART.test(name))?.[0]
  return [...names, ...(slide ? [slide] : [])].map((name) => masterPartInput(all, name))
}

// ── The specs ─────────────────────────────────────────────────────────

const ctxOf = (args: Record<string, unknown>): ParseContext => fromWire(args.ctx)

export const PARSE: CallSpec[] = [
  {
    fn: 'pptxParse.parse.parseSlide',
    call: (text, args) =>
      fromZero(() =>
        parseSlide({
          path: args.path as string,
          slideXml: text,
          layoutPath: args.layoutPath as string | undefined,
          masterPath: args.masterPath as string | undefined,
          ctx: ctxOf(args),
        }),
      ),
    fromDocument: (parts) =>
      corpusSlides(parts).map((s): Input => ({ text: s.slideXml, args: slideArgs(s) })),
    built: PARSE_SLIDE_BUILT,
  },
  {
    fn: 'pptxParse.parse.parseBackground',
    call: (text, args) => parseBackground(text, ctxOf(args)),
    fromDocument: (parts) => corpusSlides(parts).flatMap(backgroundInputs),
    built: BACKGROUND_CONTEXTS.flatMap((ctx) =>
      BACKGROUNDS.map((text): Input => ({ text, args: { ctx } })),
    ),
  },
  {
    fn: 'pptxParse.parse.sliceGroupChildXmls',
    call: (text) => sliceGroupChildXmls(text),
    fromDocument: (parts) =>
      [...parts]
        .filter(([name]) => SLIDE_PART.test(name) || LAYOUT_PART.test(name) || MASTER_PART.test(name))
        .flatMap(([, xml]) => groupsOf(xml).map((text): Input => ({ text }))),
    built: [
      ...GROUPS.map((text): Input => ({ text })),
      ...ENTRIES.flatMap((entry) => groupsOf(entry.spTree).map((text): Input => ({ text }))),
    ],
  },
  {
    fn: 'pptxParse.parse.layoutDiagramFallback',
    call: (text, args) =>
      fromZero(() =>
        layoutDiagramFallback(
          text,
          ctxOf(args),
          args.frameCx as number,
          args.frameCy as number,
          args.layoutId as string | undefined,
          args.colorsXml as string | undefined,
          args.layoutXml as string | undefined,
        ),
      ),
    built: DIAGRAM_BUILT,
  },
  {
    fn: 'pptxParse.parse.parseDecorations',
    call: (text, args) =>
      fromZero((): SlideElement[] => {
        const opts = decorationOptions(args.opts)
        return opts === undefined
          ? parseDecorations(text, ctxOf(args))
          : parseDecorations(text, ctxOf(args), opts)
      }),
    fromDocument: corpusDecorations,
    built: DECORATIONS_BUILT,
  },
  {
    fn: 'pptxParse.master-edit.listMasterParts',
    call: (text, args) => listMasterParts(archiveOfArgs(text, args)),
    fromDocument: (parts) => {
      const all = [...parts]
      const master = all.find(([name]) => MASTER_PART.test(name))?.[0]
      return [master ? splitOff(all, master) : { args: { parts: all } }]
    },
    built: MASTER_LISTS,
  },
  {
    fn: 'pptxParse.master-edit.parseMasterPart',
    call: (text, args) =>
      fromZero(() => parseMasterPart(archiveOfArgs(text, args), args.path as string)),
    fromDocument: corpusMasterParts,
    built: MASTER_PARTS,
  },
]
