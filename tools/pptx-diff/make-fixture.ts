/**
 * Writes packages/pptx-engine/tests/fixtures/06_corpus_gaps.pptx: one deck of our own content
 * holding the kinds the other tracked decks lack (custom geometry, a 3D model, durable ids,
 * nested groups, redaction marks, a chart with its workbook, a styled table, animations), so
 * the parity gate's corpus comparison feeds real-document input to the functions that read them.
 *
 * The deck starts from the engine's blank deck and every fragment comes from the engine's own
 * writers where one exists; parts, relationships and content types mirror the engine's insert
 * paths. The output is deterministic: fixed UUIDs, fixed zip dates, no clock, no randomness.
 *
 *   node node_modules/tsx/dist/cli.mjs tools/pptx-diff/make-fixture.ts
 */
import JSZip from 'jszip'
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { crc32, deflateSync } from 'node:zlib'
import { buildTimingXml, type SlideAnimation } from './reference/animation'
import { BLANK_SLIDE_XML, createBlankPptx } from './reference/blank'
import { buildChartSpaceXml, type NewChartOptions } from './reference/chart-insert'
import {
  CHART_WORKBOOK_REL_TYPE,
  XLSX_CONTENT_TYPE,
  chartWorkbookXlsx,
} from './reference/chart-workbook'
import { custGeomXml } from './reference/custgeom'
import { generateParagraphXml, generateXfrmXml } from './reference/generate'
import { glbBounds } from './reference/glb-bounds'
import {
  buildGrpSpXml,
  buildSpXml,
  buildTableXml,
  nextCNvPrId,
  type NewElementOptions,
} from './reference/insert'
import { GLB_CONTENT_TYPE, MODEL3D_REL_TYPE, model3dXml } from './reference/model3d'
import { setRedactExt } from './reference/redaction-xml'
import { TABLE_STYLE_PRESETS, ensureTableStyleXml } from './reference/table-edit'
import type { EmuRect, Paragraph, Slide } from './reference/types'
import { creationIdXml, escapeXmlAttr, maxRelationshipIdNumber } from './reference/xml-utils'

const here = dirname(fileURLToPath(import.meta.url))
const OUT = join(here, '../../packages/pptx-engine/tests/fixtures/06_corpus_gaps.pptx')

/** Every zip entry carries this timestamp (JSZip writes DOS time from the UTC fields). */
const ZIP_DATE = new Date(Date.UTC(2026, 0, 1, 0, 0, 0))

const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const C_NS = 'http://schemas.openxmlformats.org/drawingml/2006/chart'
const IMAGE_REL_TYPE = `${R_NS}/image`
const SLIDE_REL_TYPE = `${R_NS}/slide`
const LAYOUT_REL_TYPE = `${R_NS}/slideLayout`
const CHART_REL_TYPE = `${R_NS}/chart`
const TABLE_STYLES_REL_TYPE = `${R_NS}/tableStyles`
const SLIDE_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml'
const CHART_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml'
const TABLE_STYLES_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.presentationml.tableStyles+xml'
const XMLDECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'
const EMPTY_RELS =
  XMLDECL +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>'

/** Medium Style 2 - Accent 1, PowerPoint's default for a new table (and insert.ts's). */
const BUILTIN_TABLE_STYLE_ID = '{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}'

// ── Fixed UUIDs ─────────────────────────────────────────────────────────
// creationIdXml mints its GUID with crypto.randomUUID; for the length of the build that call
// hands out a fixed sequence instead, so the engine's own writer produces stable bytes. The
// counter leads the GUID because identity.ts keys an element by the GUID's first 8 digits.

function withFixedUuids<T>(build: () => Promise<T>): Promise<T> {
  let n = 0
  const fixed = () => {
    n++
    const uuid = `${(0x06c0de00 + n).toString(16).padStart(8, '0')}-0ff1-4ce0-8000-${n.toString(16).padStart(12, '0')}`
    return uuid as `${string}-${string}-${string}-${string}-${string}`
  }
  Object.defineProperty(globalThis.crypto, 'randomUUID', { value: fixed, configurable: true })
  return build().finally(() => {
    Reflect.deleteProperty(globalThis.crypto, 'randomUUID')
  })
}

// ── Binary media of our own ─────────────────────────────────────────────

function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 0)
  return Buffer.concat([head, data, crc])
}

/**
 * An RGB PNG from a pixel function. IDAT is deflated at level 0 (stored blocks), whose bytes
 * do not depend on the zlib build, so the image is the same on every machine.
 */
function png(w: number, h: number, pixel: (x: number, y: number) => [number, number, number]) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // color type RGB
  const raw = Buffer.alloc(h * (1 + w * 3))
  for (let y = 0; y < h; y++) {
    const row = y * (1 + w * 3)
    for (let x = 0; x < w; x++) raw.set(pixel(x, y), row + 1 + x * 3)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 0 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/** Diagonal stripes in two blues. */
const STRIPES_PNG = png(16, 16, (x, y) => ((x + y) & 4 ? [31, 56, 100] : [214, 228, 240]))

/** The 3D model's rendering: a light triangle on a dark ground. */
const POSTER_PNG = png(16, 16, (x, y) =>
  y >= 3 && y <= 13 && Math.abs(x - 7.5) <= (y - 3) * 0.6 ? [196, 62, 28] : [58, 58, 66],
)

/**
 * A tetrahedron as glTF binary: a root node with a translation whose child node holds the
 * mesh with a translation of its own; POSITION carries min/max, indices are uint16.
 */
function tetrahedronGlb(): Buffer {
  const verts = [
    [0, 0.5, 0],
    [-0.5, -0.25, 0.29],
    [0.5, -0.25, 0.29],
    [0, -0.25, -0.58],
  ].map((v) => v.map((c) => Math.fround(c)))
  const indices = [0, 1, 2, 0, 2, 3, 0, 3, 1, 1, 3, 2]
  const positions = Buffer.alloc(verts.length * 12)
  verts.forEach((v, i) => v.forEach((c, k) => positions.writeFloatLE(c, i * 12 + k * 4)))
  const index = Buffer.alloc(indices.length * 2)
  indices.forEach((v, i) => index.writeUInt16LE(v, i * 2))
  const bin = Buffer.concat([positions, index])
  const min = [0, 1, 2].map((k) => Math.min(...verts.map((v) => v[k]!)))
  const max = [0, 1, 2].map((k) => Math.max(...verts.map((v) => v[k]!)))
  const gltf = {
    asset: { version: '2.0', generator: 'SeuOffice make-fixture' },
    scene: 0,
    scenes: [{ name: 'Scene', nodes: [0] }],
    nodes: [
      { name: 'Root', translation: [0, 0.25, 0], children: [1] },
      { name: 'Tetrahedron', mesh: 0, translation: [0.1, 0, 0] },
    ],
    meshes: [
      {
        name: 'Tetrahedron',
        primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0, mode: 4 }],
      },
    ],
    materials: [
      {
        name: 'Blue',
        pbrMetallicRoughness: {
          baseColorFactor: [0.27, 0.45, 0.77, 1],
          metallicFactor: 0,
          roughnessFactor: 0.6,
        },
      },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: verts.length, type: 'VEC3', min, max },
      { bufferView: 1, componentType: 5123, count: indices.length, type: 'SCALAR' },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positions.length, target: 34962 },
      { buffer: 0, byteOffset: positions.length, byteLength: index.length, target: 34963 },
    ],
    buffers: [{ byteLength: bin.length }],
  }
  const pad = (b: Buffer, fill: number) =>
    b.length % 4 ? Buffer.concat([b, Buffer.alloc(4 - (b.length % 4), fill)]) : b
  const json = pad(Buffer.from(JSON.stringify(gltf), 'utf8'), 0x20)
  const body = pad(bin, 0)
  const chunk = (type: number, data: Buffer) => {
    const head = Buffer.alloc(8)
    head.writeUInt32LE(data.length, 0)
    head.writeUInt32LE(type, 4)
    return Buffer.concat([head, data])
  }
  const chunks = Buffer.concat([chunk(0x4e4f534a, json), chunk(0x004e4942, body)])
  const header = Buffer.alloc(12)
  header.writeUInt32LE(0x46546c67, 0) // "glTF"
  header.writeUInt32LE(2, 4)
  header.writeUInt32LE(12 + chunks.length, 8)
  return Buffer.concat([header, chunks])
}

// ── Package bookkeeping (mirrors the engine's insert paths) ─────────────

class Package {
  readonly parts = new Map<string, string | Uint8Array>()

  text(path: string): string {
    const v = this.parts.get(path)
    if (typeof v !== 'string') throw new Error(`no text part ${path}`)
    return v
  }

  /** ensureDefaultContentType (media-insert.ts) */
  defaultType(ext: string, mime: string): void {
    const ct = this.text('[Content_Types].xml')
    if (ct.includes(`Extension="${ext}"`)) return
    this.parts.set(
      '[Content_Types].xml',
      ct.replace('</Types>', () => `<Default Extension="${ext}" ContentType="${mime}"/></Types>`),
    )
  }

  /** the Override addChart / ensureTableStylePart / slide insertion write */
  overrideType(path: string, mime: string): void {
    const ct = this.text('[Content_Types].xml')
    this.parts.set(
      '[Content_Types].xml',
      ct.replace('</Types>', () => `<Override PartName="/${path}" ContentType="${mime}"/></Types>`),
    )
  }

  /** appendRelationship (notes.ts): max rId + 1, rels part created when missing */
  rel(partPath: string, type: string, target: string): string {
    const slash = partPath.lastIndexOf('/')
    const relsPath = `${partPath.slice(0, slash)}/_rels/${partPath.slice(slash + 1)}.rels`
    const current = this.parts.get(relsPath)
    const xml = typeof current === 'string' ? current : EMPTY_RELS
    const rid = `rId${maxRelationshipIdNumber(xml) + 1}`
    this.parts.set(
      relsPath,
      xml.replace(
        '</Relationships>',
        () =>
          `<Relationship Id="${rid}" Type="${type}" Target="${escapeXmlAttr(target)}"/></Relationships>`,
      ),
    )
    return rid
  }

  /** newMediaPart (media-insert.ts): ppt/media/{prefix}N.ext, N = max over the whole media dir + 1 */
  mediaPart(prefix: string, ext: string, bytes: Uint8Array): string {
    let max = 0
    for (const path of this.parts.keys()) {
      const m = /^ppt\/media\/[a-zA-Z]+(\d+)\./.exec(path)
      if (m) max = Math.max(max, Number(m[1]))
    }
    const path = `ppt/media/${prefix}${max + 1}.${ext}`
    this.parts.set(path, bytes)
    return path
  }

  /** addImageMediaAndRel (insert.ts): identical bytes share one imageN part, numbered over imageN only */
  imagePart(bytes: Uint8Array, ext: string): string {
    let max = 0
    for (const [path, existing] of this.parts) {
      const m = /^ppt\/media\/image(\d+)\./.exec(path)
      if (!m) continue
      max = Math.max(max, Number(m[1]))
      if (
        path.endsWith(`.${ext}`) &&
        Buffer.compare(Buffer.from(existing), Buffer.from(bytes)) === 0
      )
        return path
    }
    const path = `ppt/media/image${max + 1}.${ext}`
    this.parts.set(path, bytes)
    return path
  }
}

// ── Slide assembly ──────────────────────────────────────────────────────

/**
 * One slide under construction. `seen` holds every fragment written so far, placed or not
 * (a group's children), so nextCNvPrId hands out ids no other fragment on the slide holds.
 */
class SlideDraft {
  private seen = ''
  private readonly top: string[] = []
  timing = ''

  constructor(
    readonly pkg: Package,
    readonly path: string,
  ) {}

  /** The Slide the engine's writers read: only originalXml and elements matter to them. */
  stub(): Slide {
    return {
      path: this.path,
      originalXml: BLANK_SLIDE_XML + this.seen,
      elements: [],
    } as unknown as Slide
  }

  nextId(): number {
    return nextCNvPrId(this.stub())
  }

  /** Register a fragment's ids without placing it (a child of a group). */
  hold(xml: string): string {
    this.seen += xml
    return xml
  }

  /** Place a fragment at the top of the spTree. */
  place(xml: string): string {
    this.top.push(this.hold(xml))
    return xml
  }

  sp(opts: NewElementOptions): string {
    return this.hold(buildSpXml(this.stub(), opts))
  }

  title(text: string): void {
    this.place(
      buildSpXml(this.stub(), {
        kind: 'textbox',
        offset: { x: 457200, y: 228600, cx: 11277600, cy: 685800 },
        paragraphs: [{ runs: [{ text, fontSize: 28, bold: true }] }],
      }),
    )
  }

  /** A picture as addPicture writes it; `spPr` lets the caller mark the shape properties. */
  picture(bytes: Uint8Array, offset: EmuRect, spPr: (xml: string) => string = (x) => x): string {
    const media = this.pkg.imagePart(bytes, 'png')
    this.pkg.defaultType('png', 'image/png')
    const rid = this.pkg.rel(
      this.path,
      IMAGE_REL_TYPE,
      `../media/${media.slice('ppt/media/'.length)}`,
    )
    const id = this.nextId()
    return this.hold(
      `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="Picture ${id}">${creationIdXml()}</p:cNvPr>` +
        '<p:cNvPicPr/><p:nvPr/></p:nvPicPr>' +
        `<p:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>` +
        spPr(
          `<p:spPr>${generateXfrmXml({ offset, rot: 0, flipH: false, flipV: false })}` +
            '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>',
        ) +
        '</p:pic>',
    )
  }

  xml(): string {
    const body = BLANK_SLIDE_XML.replace('</p:spTree>', () => `${this.top.join('')}</p:spTree>`)
    return this.timing ? body.replace('</p:sld>', () => `${this.timing}</p:sld>`) : body
  }
}

const rect = (x: number, y: number, cx: number, cy: number): EmuRect => ({ x, y, cx, cy })
const para = (text: string, fontSize = 14): Paragraph => ({ runs: [{ text, fontSize }] })

/** A shape written by buildSpXml whose preset geometry is swapped for `geom`. */
function custShape(d: SlideDraft, offset: EmuRect, fill: string, label: string, geom: string) {
  const xml = buildSpXml(d.stub(), {
    kind: 'rect',
    offset,
    fillColor: fill,
    stroke: { color: '#1F3864', widthEmu: 12700 },
    paragraphs: [para(label, 12)],
  })
  const preset = '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>'
  if (!xml.includes(preset)) throw new Error('buildSpXml no longer writes a rect preset')
  d.place(xml.replace(preset, () => geom))
}

const gd = (name: string, fmla: string) => `<a:gd name="${name}" fmla="${fmla}"/>`
const pt = (x: string | number, y: string | number) => `<a:pt x="${x}" y="${y}"/>`
const moveTo = (x: string | number, y: string | number) => `<a:moveTo>${pt(x, y)}</a:moveTo>`
const lnTo = (x: string | number, y: string | number) => `<a:lnTo>${pt(x, y)}</a:lnTo>`
const arcTo = (wR: string, hR: string, stAng: string, swAng: string) =>
  `<a:arcTo wR="${wR}" hR="${hR}" stAng="${stAng}" swAng="${swAng}"/>`
const custGeom = (avLst: string, gdLst: string, rectLtrb: string, paths: string) =>
  `<a:custGeom><a:avLst>${avLst}</a:avLst><a:gdLst>${gdLst}</a:gdLst><a:ahLst/><a:cxnLst/>` +
  `<a:rect ${rectLtrb}/><a:pathLst>${paths}</a:pathLst></a:custGeom>`

function customGeometrySlide(d: SlideDraft): void {
  d.title('Custom geometry')
  // Block arrow: adjust values in avLst, guides that chain (pin, */, +-, min, ?:)
  custShape(
    d,
    rect(457200, 1219200, 3352800, 1828800),
    '#4472C4',
    'Arrow',
    custGeom(
      gd('adj1', 'val 50000') + gd('adj2', 'val 40000'),
      gd('a1', 'pin 0 adj1 100000') +
        gd('th', '*/ h a1 200000') +
        gd('y1', '+- vc 0 th') +
        gd('y2', '+- vc th 0') +
        gd('dx', '*/ ss adj2 100000') +
        gd('maxHead', '*/ w 2 3') +
        gd('head', 'min dx maxHead') +
        gd('x1', '+- r 0 head') +
        gd('flag', '+- head 0 wd8') +
        gd('tip', '?: flag r x1'),
      'l="l" t="y1" r="x1" b="y2"',
      '<a:path>' +
        moveTo('l', 'y1') +
        lnTo('x1', 'y1') +
        lnTo('x1', 't') +
        lnTo('tip', 'vc') +
        lnTo('x1', 'b') +
        lnTo('x1', 'y2') +
        lnTo('l', 'y2') +
        '<a:close/></a:path>',
    ),
  )
  // Tab with two rounded corners: arcTo with guide radii (abs, sqrt, +/ chained)
  custShape(
    d,
    rect(4267200, 1219200, 3352800, 1828800),
    '#ED7D31',
    'Tab',
    custGeom(
      '',
      gd('r0', '*/ ss 1 5') +
        gd('neg', '+- 0 0 r0') +
        gd('r1', 'abs neg') +
        gd('sq', '*/ r1 r1 1') +
        gd('rad', 'sqrt sq') +
        gd('x1', '+- r 0 rad') +
        gd('midX', '+/ l r 2'),
      'l="l" t="rad" r="r" b="b"',
      '<a:path>' +
        moveTo('l', 'b') +
        lnTo('l', 'rad') +
        arcTo('rad', 'rad', 'cd2', 'cd4') +
        lnTo('x1', 't') +
        arcTo('rad', 'rad', '3cd4', 'cd4') +
        lnTo('r', 'b') +
        lnTo('midX', 'b') +
        '<a:close/></a:path>',
    ),
  )
  // Star from polar guides (cos, sin) and a stroke-only diagonal from at2/mod/cat2/sat2/tan
  const star = [16200000, 3240000, 11880000, 20520000, 7560000]
  let starGuides = gd('rx', '*/ w 1 2') + gd('ry', '*/ h 1 2')
  star.forEach((ang, i) => {
    starGuides +=
      gd(`dx${i}`, `cos rx ${ang}`) +
      gd(`dy${i}`, `sin ry ${ang}`) +
      gd(`x${i}`, `+- hc dx${i} 0`) +
      gd(`y${i}`, `+- vc dy${i} 0`)
  })
  starGuides +=
    gd('diag', 'mod wd2 hd2 0') +
    gd('ang', 'at2 w h') +
    gd('ex', 'cat2 diag w h') +
    gd('ey', 'sat2 diag w h') +
    gd('lean', 'tan wd8 2700000') +
    gd('ex2', '+- hc ex lean') +
    gd('ey2', '+- vc ey 0')
  custShape(
    d,
    rect(8077200, 1219200, 3048000, 1828800),
    '#FFC000',
    'Star',
    custGeom(
      '',
      starGuides,
      'l="l" t="t" r="r" b="b"',
      '<a:path>' +
        moveTo('x0', 'y0') +
        star
          .slice(1)
          .map((_, i) => lnTo(`x${i + 1}`, `y${i + 1}`))
          .join('') +
        '<a:close/></a:path>' +
        `<a:path fill="none">${moveTo('hc', 'vc')}${lnTo('ex2', 'ey2')}</a:path>`,
    ),
  )
  // Three paths, each with its own w/h: a filled triangle, a stroke-only wave
  // (cubicBezTo then quadBezTo, fill="none") and a fill-only square (stroke="0")
  custShape(
    d,
    rect(457200, 3657600, 3352800, 1828800),
    '#70AD47',
    'Paths',
    custGeom(
      '',
      '',
      'l="l" t="t" r="r" b="b"',
      '<a:path w="1000" h="1000">' +
        moveTo(0, 1000) +
        lnTo(500, 0) +
        lnTo(1000, 1000) +
        '<a:close/></a:path>' +
        '<a:path w="2000" h="1000" fill="none">' +
        moveTo(0, 500) +
        `<a:cubicBezTo>${pt(333, 0)}${pt(666, 1000)}${pt(1000, 500)}</a:cubicBezTo>` +
        `<a:quadBezTo>${pt(1500, 0)}${pt(2000, 500)}</a:quadBezTo>` +
        '</a:path>' +
        '<a:path w="1000" h="1000" stroke="0">' +
        moveTo(400, 700) +
        lnTo(600, 700) +
        lnTo(600, 900) +
        lnTo(400, 900) +
        '<a:close/></a:path>',
    ),
  )
  // What Edit Points writes back (custgeom.ts custGeomXml): one path in its own w/h space
  custShape(
    d,
    rect(4267200, 3657600, 3352800, 1828800),
    '#A5A5A5',
    'Edited',
    custGeomXml({
      w: 400,
      h: 300,
      cmds: [
        { op: 'M', pts: [0, 150] },
        { op: 'Q', pts: [100, 0, 200, 150] },
        { op: 'C', pts: [250, 225, 350, 300, 400, 150] },
        { op: 'L', pts: [400, 300] },
        { op: 'L', pts: [0, 300] },
        { op: 'Z', pts: [] },
      ],
    }),
  )
  // Pie: an elliptical arcTo (wR != hR) swept 270 degrees from the right edge
  custShape(
    d,
    rect(8077200, 3657600, 3048000, 1828800),
    '#C43E1C',
    'Pie',
    custGeom(
      gd('adj', 'val 16200000'),
      gd('sweep', 'pin 0 adj 21599999'),
      'l="l" t="t" r="r" b="b"',
      '<a:path>' +
        moveTo('r', 'vc') +
        arcTo('wd2', 'hd2', '0', 'sweep') +
        lnTo('hc', 'vc') +
        '<a:close/></a:path>',
    ),
  )
}

function model3dSlide(d: SlideDraft): void {
  d.title('3D model')
  // addModel3d (media-insert.ts): model part, poster part, both Defaults, model then image rel
  const glb = tetrahedronGlb()
  const modelPath = d.pkg.mediaPart('model3d', 'glb', glb)
  d.pkg.defaultType('glb', GLB_CONTENT_TYPE)
  const posterPath = d.pkg.mediaPart('image', 'png', POSTER_PNG)
  d.pkg.defaultType('png', 'image/png')
  const modelRId = d.pkg.rel(d.path, MODEL3D_REL_TYPE, `../media/${modelPath.split('/').pop()}`)
  const posterRId = d.pkg.rel(d.path, IMAGE_REL_TYPE, `../media/${posterPath.split('/').pop()}`)
  const id = d.nextId()
  d.place(
    model3dXml({
      id,
      name: `3D Model ${id}`,
      offset: rect(3657600, 1371600, 4572000, 4572000),
      modelRId,
      posterRId,
      bounds: glbBounds(glb),
      rot: { ax: 1200000, ay: 2100000, az: 0 },
    }),
  )
}

function durableIdsSlide(d: SlideDraft): void {
  d.title('Durable ids')
  d.place(
    d.sp({
      kind: 'roundRect',
      offset: rect(457200, 1371600, 3048000, 1524000),
      fillColor: '#4472C4',
      paragraphs: [para('Shape with a16:creationId')],
    }),
  )
  d.place(
    d.sp({
      kind: 'ellipse',
      offset: rect(4267200, 1371600, 3048000, 1524000),
      fillColor: '#ED7D31',
      paragraphs: [para('Another one')],
    }),
  )
  d.place(d.picture(STRIPES_PNG, rect(8077200, 1371600, 1524000, 1524000)))
  // A group whose children each carry their own creationId
  const a = d.sp({
    kind: 'rect',
    offset: rect(457200, 3657600, 2286000, 1371600),
    fillColor: '#70AD47',
    paragraphs: [para('Child A')],
  })
  const b = d.sp({
    kind: 'rect',
    offset: rect(3048000, 3657600, 2286000, 1371600),
    fillColor: '#FFC000',
    paragraphs: [para('Child B')],
  })
  d.place(buildGrpSpXml(d.stub(), rect(457200, 3657600, 4876800, 1371600), a + b))
}

function groupsSlide(d: SlideDraft): void {
  d.title('Groups')
  // Children live in a child space half the group's size (chExt = ext / 2), offset from 0,0
  const child = d.sp({
    kind: 'rect',
    offset: rect(0, 0, 1600000, 900000),
    fillColor: '#4472C4',
    paragraphs: [para('Child shape', 12)],
  })
  const pic = d.picture(STRIPES_PNG, rect(1800000, 0, 900000, 900000))
  // The nested group keeps the identity transform buildGrpSpXml writes (chOff = off)
  const n1 = d.sp({
    kind: 'ellipse',
    offset: rect(0, 1100000, 1300000, 900000),
    fillColor: '#ED7D31',
    paragraphs: [para('Nested 1', 10)],
  })
  const n2 = d.sp({
    kind: 'triangle',
    offset: rect(1500000, 1100000, 1200000, 900000),
    fillColor: '#70AD47',
    paragraphs: [para('Nested 2', 10)],
  })
  const nested = d.hold(buildGrpSpXml(d.stub(), rect(0, 1100000, 2700000, 900000), n1 + n2))
  const id = d.nextId()
  d.place(
    '<p:grpSp>' +
      `<p:nvGrpSpPr><p:cNvPr id="${id}" name="Group ${id}">${creationIdXml()}</p:cNvPr><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
      '<p:grpSpPr><a:xfrm><a:off x="1219200" y="1371600"/><a:ext cx="5400000" cy="4000000"/>' +
      '<a:chOff x="0" y="0"/><a:chExt cx="2700000" cy="2000000"/></a:xfrm></p:grpSpPr>' +
      child +
      pic +
      nested +
      '</p:grpSp>',
  )
}

/** Mark the rPr of the run whose text is `text` (the run as generateParagraphXml writes it). */
function markRun(xml: string, text: string, mark: (rPr: string) => string): string {
  const re = new RegExp(`<a:r>(<a:rPr\\b[^>]*?(?:/>|>[\\s\\S]*?</a:rPr>))<a:t>${text}</a:t></a:r>`)
  const m = re.exec(xml)
  if (!m) throw new Error(`run "${text}" not found`)
  return (
    xml.slice(0, m.index) +
    `<a:r>${mark(m[1]!)}<a:t>${text}</a:t></a:r>` +
    xml.slice(m.index + m[0].length)
  )
}

/** An extension of ours that is not the redaction mark, to sit beside it in one extLst. */
const OTHER_RUN_EXT =
  '<a:extLst><a:ext uri="{6E0C2B1A-3D4F-4E5A-9B8C-7D6E5F4A3B2C}">' +
  '<sf:note xmlns:sf="urn:seuoffice:fixture" value="kept beside the mark"/></a:ext></a:extLst>'

function redactionSlide(d: SlideDraft): void {
  d.title('Redaction marks')
  let text = d.sp({
    kind: 'textbox',
    offset: rect(457200, 1371600, 7315200, 1828800),
    paragraphs: [
      {
        runs: [
          { text: 'Account holder: ', fontSize: 20 },
          { text: 'Jane Placeholder', fontSize: 20, underline: true, underlineStyle: 'sng' },
        ],
      },
      {
        runs: [
          { text: 'Account number: ', fontSize: 20 },
          { text: '0000-1111-2222', fontSize: 20, underline: true, underlineStyle: 'sng' },
        ],
      },
    ],
  })
  text = markRun(text, 'Jane Placeholder', (rPr) => setRedactExt(rPr, 'NAME'))
  // the second mark lands in an extLst that already holds another extension
  text = markRun(text, '0000-1111-2222', (rPr) =>
    setRedactExt(
      rPr.endsWith('/>')
        ? rPr.replace(/\/>$/, `>${OTHER_RUN_EXT}</a:rPr>`)
        : rPr.replace('</a:rPr>', `${OTHER_RUN_EXT}</a:rPr>`),
      'ACCOUNT',
    ),
  )
  d.place(text)
  d.place(
    d.picture(STRIPES_PNG, rect(8229600, 1371600, 2743200, 2743200), (spPr) =>
      setRedactExt(spPr, 'PHOTO'),
    ),
  )
}

function chartSlide(d: SlideDraft): void {
  d.title('Chart')
  // addChart (chart-insert.ts) with writeChartWorkbook: chart part + workbook + Default/Override + rels
  const opts: NewChartOptions = {
    kind: 'bar',
    title: 'Units per quarter',
    categories: ['Q1', 'Q2', 'Q3', 'Q4'],
    series: [
      { name: 'North', values: [12, 18, 9, 21] },
      { name: 'South', values: [7, 11.5, 16, 13] },
    ],
    offset: rect(1371600, 1219200, 9144000, 5029200),
    gridlines: true,
  }
  const chartPath = 'ppt/charts/chart1.xml'
  const workbook = 'ppt/embeddings/Microsoft_Excel_Worksheet1.xlsx'
  d.pkg.parts.set(workbook, chartWorkbookXlsx({ categories: opts.categories, series: opts.series }))
  d.pkg.defaultType('xlsx', XLSX_CONTENT_TYPE)
  const workbookRId = d.pkg.rel(
    chartPath,
    CHART_WORKBOOK_REL_TYPE,
    '../embeddings/Microsoft_Excel_Worksheet1.xlsx',
  )
  d.pkg.parts.set(chartPath, buildChartSpaceXml(opts, workbookRId))
  d.pkg.overrideType(chartPath, CHART_CONTENT_TYPE)
  const rid = d.pkg.rel(d.path, CHART_REL_TYPE, '../charts/chart1.xml')
  const id = d.nextId()
  const o = opts.offset
  d.place(
    `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="${escapeXmlAttr(`Chart ${id} - ${opts.title}`)}" descr="aislides-chart">${creationIdXml()}</p:cNvPr>` +
      '<p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>' +
      `<p:xfrm><a:off x="${o.x}" y="${o.y}"/><a:ext cx="${o.cx}" cy="${o.cy}"/></p:xfrm>` +
      `<a:graphic><a:graphicData uri="${C_NS}">` +
      `<c:chart xmlns:c="${C_NS}" xmlns:r="${R_NS}" r:id="${rid}"/>` +
      '</a:graphicData></a:graphic></p:graphicFrame>',
  )
}

/** Medium Style 2 - Accent 1 written out, as PowerPoint stores a built-in style it has applied. */
const BUILTIN_TABLE_STYLE_DEF = (() => {
  const line = (w: number, clr: string) =>
    `<a:ln w="${w}" cmpd="sng"><a:solidFill><a:schemeClr val="${clr}"/></a:solidFill></a:ln>`
  const edges = (w: number, clr: string) =>
    ['left', 'right', 'top', 'bottom', 'insideH', 'insideV']
      .map((e) => `<a:${e}>${line(w, clr)}</a:${e}>`)
      .join('')
  const tint = (pct: number) =>
    `<a:fill><a:solidFill><a:schemeClr val="accent1"><a:tint val="${pct}"/></a:schemeClr></a:solidFill></a:fill>`
  const txt = (clr: string, bold = false) =>
    `<a:tcTxStyle${bold ? ' b="on"' : ''}><a:fontRef idx="minor"><a:prstClr val="black"/></a:fontRef><a:schemeClr val="${clr}"/></a:tcTxStyle>`
  const solid = '<a:fill><a:solidFill><a:schemeClr val="accent1"/></a:solidFill></a:fill>'
  return (
    `<a:tblStyle styleId="${BUILTIN_TABLE_STYLE_ID}" styleName="Medium Style 2 - Accent 1">` +
    `<a:wholeTbl>${txt('dk1')}<a:tcStyle><a:tcBdr>${edges(12700, 'lt1')}</a:tcBdr>${tint(20000)}</a:tcStyle></a:wholeTbl>` +
    `<a:band1H><a:tcStyle><a:tcBdr/>${tint(40000)}</a:tcStyle></a:band1H>` +
    `<a:band2H><a:tcStyle><a:tcBdr/></a:tcStyle></a:band2H>` +
    `<a:lastRow>${txt('lt1', true)}<a:tcStyle><a:tcBdr><a:top>${line(38100, 'lt1')}</a:top></a:tcBdr>${solid}</a:tcStyle></a:lastRow>` +
    `<a:firstRow>${txt('lt1', true)}<a:tcStyle><a:tcBdr><a:bottom>${line(38100, 'lt1')}</a:bottom></a:tcBdr>${solid}</a:tcStyle></a:firstRow>` +
    '</a:tblStyle>'
  )
})()

/** Fill buildTableXml's empty cells (<a:p/>) in row-major order. */
function fillCells(xml: string, cells: string[]): string {
  let i = 0
  return xml.replace(/<a:p\/>/g, () => generateParagraphXml(para(cells[i++] ?? '', 12)))
}

function tableSlide(d: SlideDraft): void {
  d.title('Table style')
  // buildTableXml writes the built-in Medium Style 2 - Accent 1 id
  d.place(
    fillCells(
      buildTableXml(d.stub(), {
        rows: 3,
        cols: 3,
        offset: rect(457200, 1371600, 5257800, 1371600),
      }),
      ['Region', 'Q1', 'Q2', 'North', '12', '18', 'South', '7', '11.5'],
    ),
  )
  // a ribbon preset: its tblPr names a custom style the deck's tableStyles.xml defines
  const preset = TABLE_STYLE_PRESETS.zebraBlue!
  const zebra = buildTableXml(d.stub(), {
    rows: 4,
    cols: 2,
    offset: rect(6248400, 1371600, 5486400, 1828800),
  })
  d.place(
    fillCells(
      zebra.replace(/<a:tblPr\b[\s\S]*?<\/a:tblPr>/, () => preset.tblPrXml),
      ['Item', 'Count', 'Bolts', '120', 'Nuts', '96', 'Washers', '240'],
    ),
  )
  // ensureTableStyleXml sees the built-in id in the list's def attribute and would add nothing,
  // so the built-in definition is spliced first and the preset ensured after it
  let styles = ensureTableStyleXml(undefined, preset.styleId!, preset.styleDefXml!)
  styles = styles.replace(/(<a:tblStyleLst\b[^>]*>)/, (open) => `${open}${BUILTIN_TABLE_STYLE_DEF}`)
  if (
    !styles.includes(`styleId="${BUILTIN_TABLE_STYLE_ID}"`) ||
    !styles.includes(`styleId="${preset.styleId}"`)
  )
    throw new Error('tableStyles.xml lacks a definition')
  // ensureTableStylePart (index.ts): the part, its Override and the presentation rel
  d.pkg.parts.set('ppt/tableStyles.xml', styles)
  d.pkg.overrideType('ppt/tableStyles.xml', TABLE_STYLES_CONTENT_TYPE)
  d.pkg.rel('ppt/presentation.xml', TABLE_STYLES_REL_TYPE, 'tableStyles.xml')
}

function animationSlide(d: SlideDraft): void {
  d.title('Animations')
  const shapes = [
    { kind: 'rect', fill: '#4472C4', label: 'Fades in on click' },
    { kind: 'ellipse', fill: '#ED7D31', label: 'Flies in from the left after' },
    { kind: 'star5', fill: '#FFC000', label: 'Pulses with the previous' },
  ]
  const spids = shapes.map((s, i) => {
    const id = d.nextId()
    d.place(
      d.sp({
        kind: s.kind,
        offset: rect(457200 + i * 3810000, 2286000, 3352800, 2286000),
        fillColor: s.fill,
        paragraphs: [para(s.label)],
      }),
    )
    return id
  })
  const anims: SlideAnimation[] = [
    { spid: spids[0]!, effect: 'fade', trigger: 'onClick', durationMs: 500, delayMs: 0 },
    {
      spid: spids[1]!,
      effect: 'flyIn',
      trigger: 'afterPrev',
      durationMs: 750,
      delayMs: 250,
      direction: 'left',
    },
    { spid: spids[2]!, effect: 'pulse', trigger: 'withPrev', durationMs: 1000, delayMs: 0 },
  ]
  d.timing = buildTimingXml(anims)
}

const SLIDES: Array<(d: SlideDraft) => void> = [
  customGeometrySlide,
  model3dSlide,
  durableIdsSlide,
  groupsSlide,
  redactionSlide,
  chartSlide,
  tableSlide,
  animationSlide,
]

async function buildFixture(): Promise<Uint8Array> {
  const blank = await JSZip.loadAsync(await createBlankPptx())
  const pkg = new Package()
  for (const [path, file] of Object.entries(blank.files)) {
    if (!file.dir) pkg.parts.set(path, await file.async('string'))
  }

  // presentation: slide 1 keeps its part and rId2; slides 2..8 follow it
  const slideLayoutRels = pkg.text('ppt/slides/_rels/slide1.xml.rels')
  const sldIds: string[] = []
  await withFixedUuids(async () => {
    SLIDES.forEach((build, i) => {
      const path = `ppt/slides/slide${i + 1}.xml`
      if (i > 0) {
        pkg.parts.set(`ppt/slides/_rels/slide${i + 1}.xml.rels`, slideLayoutRels)
        pkg.overrideType(path, SLIDE_CONTENT_TYPE)
      }
      const rid =
        i === 0
          ? 'rId2'
          : pkg.rel('ppt/presentation.xml', SLIDE_REL_TYPE, `slides/slide${i + 1}.xml`)
      sldIds.push(`<p:sldId id="${256 + i}" r:id="${rid}"/>`)
      const draft = new SlideDraft(pkg, path)
      build(draft)
      pkg.parts.set(path, draft.xml())
    })
  })
  if (!pkg.text('ppt/slides/_rels/slide1.xml.rels').includes(LAYOUT_REL_TYPE))
    throw new Error('slide 1 lost its layout')
  pkg.parts.set(
    'ppt/presentation.xml',
    pkg
      .text('ppt/presentation.xml')
      .replace(
        /<p:sldIdLst>[\s\S]*?<\/p:sldIdLst>/,
        () => `<p:sldIdLst>${sldIds.join('')}</p:sldIdLst>`,
      ),
  )

  const zip = new JSZip()
  const order = [
    '[Content_Types].xml',
    '_rels/.rels',
    ...[...pkg.parts.keys()]
      .filter((p) => p !== '[Content_Types].xml' && p !== '_rels/.rels')
      .sort(),
  ]
  for (const path of order)
    zip.file(path, pkg.parts.get(path)!, { date: ZIP_DATE, createFolders: false })
  return zip.generateAsync({
    type: 'uint8array',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  })
}

const bytes = await buildFixture()
writeFileSync(OUT, bytes)
console.log(
  `${OUT}\n${bytes.length} bytes\nsha256 ${createHash('sha256').update(bytes).digest('hex')}`,
)
