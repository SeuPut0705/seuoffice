// Group `media` of comparison (f): media-insert.ts, narration.ts,
// chart-insert.ts and hyperlink.ts of packages/pptx-engine. The Rust side
// answers in crates/office-wasm/src/calls/pptx_media.rs to
// `pptxMedia.<module>.<TypeScript name>`.
//
// Media bytes cross as base64 in `args`. The a16:creationId of a new element
// takes `crypto.randomUUID()`: every call that mints one runs inside
// `withUuid` and gives the Rust side the same `uuid` argument. A function on
// an opened deck goes through deck-ops.ts (`deckOp`, `deckInput`).
import { inflateSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import {
  buildChartSpaceXml,
  type NewChartOptions,
  addChart,
  writeChartWorkbook,
} from '../../packages/pptx-engine/src/chart-insert'
import {
  decodeRunLink,
  encodeRunLink,
  ensureRunLinkRels,
  getElementLink,
  getRunLinks,
  getSlideLinks,
  type LinkTarget,
  setElementLink,
} from '../../packages/pptx-engine/src/hyperlink'
import { reparseDeck } from '../../packages/pptx-engine/src/index'
import {
  addMedia,
  addModel3d,
  ensureDefaultContentType,
  model3dPartOf,
  type NewMediaOptions,
  type NewModel3dOptions,
  setModel3dView,
  solidPng,
} from '../../packages/pptx-engine/src/media-insert'
import {
  addNarration,
  clearNarration,
  narrationSpids,
  setShowNarration,
} from '../../packages/pptx-engine/src/narration'
import type { OpenedPptx } from '../../packages/pptx-engine/src/index'
import type { Slide } from '../../packages/pptx-engine/src/types'
import type { CallSpec, Input } from '../docx-diff/calls-spec'
import { deckInput, deckOp } from './deck-ops'
import { withUuid } from './calls-leaves'

type Args = Record<string, unknown>

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/**
 * A PNG with its IDAT chunks inflated: the other chunks as they are, then the pixels. The deflate
 * streams of two zlibs are different bytes of one image, so the gate compares this (the Rust
 * side: media_insert.rs `png_pixels`). null where the bytes are not a PNG that this reads whole.
 */
function pngPixels(bytes: Uint8Array): Buffer | null {
  const png = Buffer.from(bytes)
  if (png.length < 8 || !png.subarray(0, 8).equals(PNG_SIGNATURE)) return null
  const head: Buffer[] = []
  const idat: Buffer[] = []
  let at = 8
  while (at < png.length) {
    if (png.length - at < 12) return null
    const length = png.readUInt32BE(at)
    const end = at + 12 + length
    if (end > png.length) return null
    if (png.toString('latin1', at + 4, at + 8) === 'IDAT') idat.push(png.subarray(at + 8, at + 8 + length))
    else head.push(png.subarray(at, end))
    at = end
  }
  if (idat.length === 0) return null
  try {
    return Buffer.concat([...head, inflateSync(Buffer.concat(idat))])
  } catch {
    return null
  }
}

/** `run` under `withUuid`, then every PNG it added to the archive replaced by its `pngPixels`. */
function withUuidAndPixels<T>(opened: OpenedPptx, run: () => T): T {
  const known = new Set(opened.archive.entries.keys())
  const result = withUuid(UUID, run)
  for (const [path, bytes] of [...opened.archive.entries]) {
    if (known.has(path)) continue
    const pixels = pngPixels(bytes)
    if (pixels) opened.archive.entries.set(path, pixels)
  }
  return result
}

const UUID = '6f1d2c3b-4a59-4687-9e0d-1c2b3a495867'
const BLANK = 'blank deck'
const GENERATED = 'pptxgenjs text, shape, table and two slides'

const b64 = (bytes: number[]): string => Buffer.from(bytes).toString('base64')
const fromB64 = (text: unknown): Uint8Array => new Uint8Array(Buffer.from(text as string, 'base64'))

/** A media or poster as the TypeScript reads it: `bytes` in base64 in the arguments. */
const bytesOf = <T extends { bytes?: unknown }>(value: T | undefined): unknown =>
  value && { ...value, bytes: fromB64(value.bytes) }

const mediaOptions = (opts: Args): NewMediaOptions =>
  ({
    ...opts,
    bytes: fromB64(opts.bytes),
    ...(opts.poster ? { poster: bytesOf(opts.poster as { bytes: string }) } : {}),
  }) as unknown as NewMediaOptions

const modelOptions = (opts: Args): NewModel3dOptions =>
  ({
    ...opts,
    bytes: fromB64(opts.bytes),
    ...(opts.poster ? { poster: bytesOf(opts.poster as { bytes: string }) } : {}),
  }) as unknown as NewModel3dOptions

const OFFSET = { x: 100, y: 200, cx: 3000, cy: 2000 }
const BYTES = b64([1, 2, 3, 4, 5, 6, 7, 8])
const POSTER = { bytes: b64([0x89, 0x50, 0x4e, 0x47, 9, 9]), ext: 'PNG' }
const JPG_POSTER = { bytes: b64([0xff, 0xd8, 0xff, 1]), ext: 'jpg' }

/** The slide index and the element's indexes an input names. */
const at = (args: Args) => args as { slide: number; element: number }

/** Only the new element's id leaves the call: the slide is in the `deck` of the answer. */
const added = (r: { elementId: string } | null): string | null => (r ? r.elementId : null)

// ── A minimal GLB: the JSON chunk of a one-node scene with a mesh position accessor ──

function glb(json: unknown): string {
  const text = Buffer.from(JSON.stringify(json), 'utf8')
  const padded = Buffer.concat([text, Buffer.alloc((4 - (text.length % 4)) % 4, 0x20)])
  const head = Buffer.alloc(20)
  head.writeUInt32LE(0x46546c67, 0)
  head.writeUInt32LE(2, 4)
  head.writeUInt32LE(20 + padded.length, 8)
  head.writeUInt32LE(padded.length, 12)
  head.writeUInt32LE(0x4e4f534a, 16)
  return Buffer.concat([head, padded]).toString('base64')
}

const GLB_BOX = glb({
  asset: { version: '2.0' },
  scenes: [{ nodes: [0] }],
  nodes: [{ mesh: 0 }],
  meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
  accessors: [{ min: [-1, -2, -3], max: [1, 2, 3] }],
})

// ── Slides: shapes with hlinkClick forms, a group, text runs ──────────

const NS =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'

const sld = (tree: string, suffix = ''): string =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:sld ${NS}><p:cSld><p:spTree>` +
  '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>' +
  `${tree}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>${suffix}</p:sld>`

const xfrm = '<a:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="100"/></a:xfrm>'

const sp = (id: number, cNvPr: string, body = 'x'): string =>
  `<p:sp><p:nvSpPr>${cNvPr.replace('{id}', String(id))}<p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
  `<p:spPr>${xfrm}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>` +
  `<p:txBody><a:bodyPr/><a:lstStyle/><a:p>${body}</a:p></p:txBody></p:sp>`

const run = (text: string, hlink = ''): string =>
  `<a:r><a:rPr lang="en-US">${hlink}</a:rPr><a:t>${text}</a:t></a:r>`

const hl = (attrs: string): string => `<a:hlinkClick ${attrs}/>`

const PLAIN = sp(2, '<p:cNvPr id="{id}" name="Plain"/>')
const PAIRED = sp(3, '<p:cNvPr id="{id}" name="Paired"><a:extLst><a:ext uri="x"/></a:extLst></p:cNvPr>')
const LINKED = sp(
  4,
  '<p:cNvPr id="{id}" name="Linked">' +
    '<a:hlinkClick xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="rId7" tooltip="a &amp; b &#x41;"/></p:cNvPr>',
)
const ACTION_LINKED = sp(
  5,
  '<p:cNvPr id="{id}" name="Act"><a:hlinkClick r:id="" action="ppaction://hlinkshowjump?jump=nextslide"/></p:cNvPr>',
)
const QUOTED = sp(
  6,
  "<p:cNvPr id='{id}' name='Quoted'><a:hlinkClick r:id='rId8' action='ppaction://hlinksldjump' tooltip='q'></a:hlinkClick></p:cNvPr>",
)
const NO_CNVPR = '<p:sp><p:nvSpPr><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/></p:sp>'
const RUNS = sp(
  7,
  '<p:cNvPr id="{id}" name="Runs"/>',
  run('a', hl('r:id="rId7" tooltip="tip"')) +
    run('b', hl('r:id="rId8"')) +
    run('c', hl('r:id="" action="ppaction://hlinkshowjump?jump=lastslide" tooltip="act"')) +
    run('d', hl('r:id="rId99"')) +
    run('e', hl('r:id="rId9"')) +
    run('f'),
)
const GROUP =
  '<p:grpSp><p:nvGrpSpPr><p:cNvPr id="20" name="Group"><a:hlinkClick r:id="rId7"/></p:cNvPr><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
  '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1" cy="1"/><a:chOff x="0" y="0"/><a:chExt cx="1" cy="1"/></a:xfrm></p:grpSpPr>' +
  sp(21, '<p:cNvPr id="{id}" name="Child1"><a:hlinkClick r:id="rId8"/></p:cNvPr>') +
  sp(22, '<p:cNvPr id="{id}" name="Child2"/>') +
  '</p:grpSp>'

const RELS_NS = 'http://schemas.openxmlformats.org/package/2006/relationships'
const REL_T = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
/** The slide rels the link readers resolve against: a url, a slide, a missing slide, a layout. */
const SLIDE_RELS =
  `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${RELS_NS}">` +
  `<Relationship Id="rId1" Type="${REL_T}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>` +
  `<Relationship Id="rId7" Type="${REL_T}/hyperlink" Target="https://example.com/?a=1&amp;b=2" TargetMode="External"/>` +
  `<Relationship Id="rId8" Type="${REL_T}/slide" Target="slide2.xml"/>` +
  `<Relationship Id="rId9" Type="${REL_T}/slide" Target="slide99.xml"/>` +
  `<Relationship Id="rId10" Type="${REL_T}/image" Target="../media/image1.png"/>` +
  '</Relationships>'

const SLIDE_PART = 'ppt/slides/slide1.xml'
const RELS_PART = 'ppt/slides/_rels/slide1.xml.rels'

/** Links the way another producer may spell them: the id and the tooltip are the decoded values. */
const ODD_LINKS = sld(
  sp(2, '<p:cNvPr id="{id}" name="A"><a:hlinkClick r:id = "R7&#97;" tooltip=\'t &amp;amp; u\'/></p:cNvPr>') +
    sp(3, '<p:cNvPr id="{id}" name="B"><a:hlinkClick r:id="a&amp;b"/></p:cNvPr>') +
    sp(4, '<p:cNvPr id="{id}" name="C"><a:hlinkClick note="x>y" r:id="rId7" action = \'\' tooltip=""/></p:cNvPr>') +
    sp(5, '<p:cNvPr id="{id}" name="D"><a:hlinkClick r:id="rId&#55;"/></p:cNvPr>') +
    sp(
      6,
      '<p:cNvPr id="{id}" name="E"/>',
      run('a', hl("r:id = 'R7a' tooltip = \"q&quot;\"")) +
        run('b', hl('r:id="a&amp;b" action="ppaction://hlinksldjump"')) +
        run('c', hl('r:id="" action=\'ppaction://hlinkshowjump?jump=lastslide\'')) +
        run('d', hl('action="ppaction://hlinkshowjump?jump=nextslide"')),
    ),
)
const ODD_RELS = SLIDE_RELS.replace(
  '</Relationships>',
  `<Relationship Id="R7a" Type="${REL_T}/hyperlink" Target="https://odd.example/" TargetMode="External"/>` +
    `<Relationship Id="a&amp;b" Type="${REL_T}/slide" Target="slide2.xml"/></Relationships>`,
)

const SLIDE_TEXTS = [
  sld(PLAIN + PAIRED + LINKED + ACTION_LINKED + QUOTED + NO_CNVPR + RUNS + GROUP),
  sld(PLAIN),
  sld(LINKED + GROUP),
  sld(''),
]

/** An input on the deck `GENERATED` with `text` as its first slide. */
const onSlide = (text: string, rest: Args = {}, deck = GENERATED): Input => ({
  ...deckInput(deck, rest, { part: SLIDE_PART, text }),
})

/** The same, with the slide rels replaced (the deck reparsed before the call). */
const withRels = (text: string, rest: Args = {}): Input =>
  onSlide(text, { setRels: SLIDE_RELS, ...rest })

/** The same, with the extra relationships `ODD_LINKS` names. */
const withOddRels = (rest: Args = {}): Input => onSlide(ODD_LINKS, { setRels: ODD_RELS, ...rest })

/** What a call does first: the slide rels `args.setRels` written, the deck reparsed (as `reparse_deck` does). */
const prepare = (opened: Parameters<typeof reparseDeck>[0], args: Args): void => {
  if (typeof args.setRels === 'string') {
    opened.archive.entries.set(RELS_PART, new TextEncoder().encode(args.setRels))
    opened.deck = reparseDeck(opened).deck
  }
}

const slideOf = (opened: { deck: { slides: Slide[] } }, args: Args): Slide =>
  opened.deck.slides[at(args).slide]!

// ── Chart option sets ─────────────────────────────────────────────────

const CHART_OFFSET = { x: 10, y: 20, cx: 3000, cy: 2000 }
const CATS = ['Q1', 'Q2', '', 'Q4']
const SERIES = [
  { name: 'A', values: [1, 2, 3.5, 4] },
  { name: '', values: [4, Number.NaN, 2, 1e21] },
  { name: 'C & <D>', values: [0.1, -2, 3] },
]
const KINDS = [
  'bar',
  'barStacked',
  'barPercentStacked',
  'line',
  'area',
  'pie',
  'doughnut',
  'scatter',
  'radar',
  'comboBarLine',
  'pie3D',
  'bar3D',
]

/** `Number.NaN` does not cross JSON: a value the cache leaves out is a null, as `numCacheXml` reads it. */
const chartOptions = (args: Args): NewChartOptions => {
  const opts = args.opts as NewChartOptions
  return {
    ...opts,
    series: opts.series.map((s) => ({
      ...s,
      values: s.values.map((v) => (v === null ? Number.NaN : v)),
    })),
  }
}

const chartCase = (extra: Record<string, unknown> = {}, series = SERIES, categories = CATS) => ({
  opts: { kind: 'bar', categories, series, offset: CHART_OFFSET, ...extra },
})

const CHART_OPTS: Args[] = [
  ...KINDS.map((kind) => chartCase({ kind })),
  ...KINDS.map((kind) =>
    chartCase({
      kind,
      title: 'Sales & <Co>',
      legendPos: 'r',
      dataLabels: true,
      gridlines: true,
      catAxisTitle: 'Quarter',
      valAxisTitle: 'Units',
      gapWidthPct: 12.5,
      barDir: 'bar',
      holeSizePct: 120,
      pointColors: [[undefined, '#ff0000', '00ff00'], undefined, ['#abc']],
      colorScheme: ['#336699', 'ff8800', '#1234567'],
    }),
  ),
  chartCase({ kind: 'comboBarLine' }, SERIES.slice(0, 1)),
  chartCase({ kind: 'comboBarLine' }, SERIES.slice(0, 2)),
  chartCase({ kind: 'doughnut', holeSizePct: 0 }),
  chartCase({ kind: 'doughnut', holeSizePct: 50.5 }),
  chartCase({ kind: 'scatter' }, SERIES, ['1', ' 2.5 ', 'x', '', '1e3', '0x10']),
  chartCase({ kind: 'bar', legendPos: 'none', title: '', catAxisTitle: '', valAxisTitle: '' }),
  chartCase({ kind: 'line', legendPos: 't', colorScheme: [] }),
  chartCase({ kind: 'bar3D' }, SERIES, ['', '']),
  chartCase({ kind: 'bar', pointColors: [[]] }, SERIES, ['\uD55C', '\u{1F600}']),
]

const chartInput = (opts: Args): Input => ({ text: '', args: opts })

// ── The specs ─────────────────────────────────────────────────────────

const MEDIA_CASES: Args[] = [
  { opts: { kind: 'video', bytes: BYTES, ext: 'mp4', offset: OFFSET } },
  { opts: { kind: 'audio', bytes: BYTES, ext: 'MP3', offset: OFFSET, name: 'Clip & <1>' } },
  { opts: { kind: 'video', bytes: BYTES, ext: 'webm', offset: OFFSET, poster: POSTER } },
  { opts: { kind: 'audio', bytes: BYTES, ext: 'm4a', offset: OFFSET, poster: JPG_POSTER } },
  { opts: { kind: 'video', bytes: BYTES, ext: 'mov', offset: OFFSET, poster: { ...POSTER, ext: 'jpeg' } } },
  { opts: { kind: 'video', bytes: BYTES, ext: 'avi', offset: OFFSET, name: '' } },
  { opts: { kind: 'audio', bytes: BYTES, ext: 'wav', offset: OFFSET } },
  { opts: { kind: 'audio', bytes: BYTES, ext: 'ogg', offset: OFFSET } },
  { opts: { kind: 'audio', bytes: BYTES, ext: 'aac', offset: OFFSET } },
  { opts: { kind: 'video', bytes: BYTES, ext: 'm4v', offset: OFFSET } },
  // an unknown extension and a missing slide answer null
  { opts: { kind: 'video', bytes: BYTES, ext: 'flv', offset: OFFSET } },
  { opts: { kind: 'video', bytes: BYTES, ext: '', offset: OFFSET } },
  // the table answers its own extensions only
  ...['constructor', 'toString', '__proto__', 'hasOwnProperty'].map((ext) => ({
    opts: { kind: 'video', bytes: BYTES, ext, offset: OFFSET },
  })),
  { slide: 9, opts: { kind: 'video', bytes: BYTES, ext: 'mp4', offset: OFFSET } },
  // fractional and huge geometry
  { opts: { kind: 'video', bytes: BYTES, ext: 'mp4', offset: { x: 0.5, y: -1, cx: 1e21, cy: 1e-7 } } },
]

const MODEL_CASES: Args[] = [
  { opts: { bytes: GLB_BOX, ext: 'glb', offset: OFFSET } },
  { opts: { bytes: GLB_BOX, ext: 'GLB', offset: OFFSET, name: 'Duck & <1>', poster: POSTER } },
  {
    opts: {
      bytes: GLB_BOX,
      ext: 'glb',
      offset: OFFSET,
      poster: JPG_POSTER,
      rot: { ax: 1.5, ay: -2, az: 3_600_000 },
    },
  },
  { opts: { bytes: BYTES, ext: 'glb', offset: OFFSET } },
  { opts: { bytes: BYTES, ext: 'gltf', offset: OFFSET } },
  { slide: 9, opts: { bytes: GLB_BOX, ext: 'glb', offset: OFFSET } },
]

const NARRATION = { bytes: BYTES, ext: 'wav', durationMs: 4200 }
const NARRATED = sld(
  PLAIN,
  '<p:timing><p:tnLst><p:par><p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot"><p:childTnLst>' +
    '<p:audio isNarration="1"><p:cMediaNode vol="80000"><p:cTn id="3" fill="hold"><p:stCondLst><p:cond delay="indefinite"/></p:stCondLst></p:cTn>' +
    '<p:tgtEl><p:spTgt spid="2"/></p:tgtEl></p:cMediaNode></p:audio>' +
    '<p:audio isNarration="true"><p:cMediaNode><p:tgtEl><p:spTgt spid="3"/></p:tgtEl></p:cMediaNode></p:audio>' +
    '<p:audio><p:cMediaNode><p:tgtEl><p:spTgt spid="4"/></p:tgtEl></p:cMediaNode></p:audio>' +
    '</p:childTnLst></p:cTn></p:par></p:tnLst></p:timing>',
)

const PRES_PROPS_FORMS = [
  '<p:presentationPr xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>',
  '<p:presentationPr xmlns:p="x"><p:showPr loop="1"/></p:presentationPr>',
  '<p:presentationPr xmlns:p="x"><p:showPr showNarration="0" useTimings="0" loop="1"></p:showPr></p:presentationPr>',
  '<p:presentationPr xmlns:p="x"><p:showPr showNarration="1"/><p:clrMru/></p:presentationPr>',
  '<p:presentationPr xmlns:p="x"><p:clrMru/></p:presentationPr>',
  '<p:presentationPr xmlns:p="x"><p:extLst/></p:presentationPr>',
  '<p:presentationPr xmlns:p="x"><p:prnPr/></p:presentationPr>',
  '<p:presentationPr xmlns:p="x" a="$&amp;"><p:showPr x="$&amp;$1"/></p:presentationPr>',
  '<p:presentationPr xmlns:p="x"><p:showPr useTimings=\'0\' showNarration="$$"/></p:presentationPr>',
  '<p:other/>',
  '',
]

const PRES_REL = (target: string): string =>
  `<?xml version="1.0"?><Relationships xmlns="${RELS_NS}"><Relationship Id="rId1" Type="${REL_T}/presProps" Target="${target}"/></Relationships>`

export const MEDIA: CallSpec[] = [
  // ── media-insert.ts ──
  {
    fn: 'pptxMedia.media-insert.solidPng',
    // the deflate streams are different bytes of one inflated image: compare the header and what they inflate to
    call: (_text, args) => {
      const png = solidPng(args.w as number, args.h as number, args.rgb as [number, number, number])
      const idatAt = png.indexOf('IDAT')
      const length = png.readUInt32BE(idatAt - 4)
      const raw = inflateSync(png.subarray(idatAt + 4, idatAt + 4 + length))
      return {
        head: png.subarray(0, 33).toString('hex'),
        raw: createHash('sha256').update(raw).digest('hex'),
        rawLength: raw.length,
        tail: png.subarray(png.length - 12).toString('hex'),
      }
    },
    built: [
      [16, 9, [38, 38, 44]],
      [16, 16, [240, 240, 244]],
      [1, 1, [0, 0, 0]],
      [3, 2, [255, 128, 7]],
      [0, 0, [1, 2, 3]],
      [64, 1, [255, 255, 255]],
      [1, 64, [10, 20, 30]],
      [300, 200, [9, 99, 199]],
    ].map(([w, h, rgb]): Input => ({ args: { w, h, rgb } })),
    mutation: 'none',
  },
  {
    fn: 'pptxMedia.media-insert.ensureDefaultContentType',
    call: (text, args) =>
      deckOp(text, args, (opened) => {
        ensureDefaultContentType(opened, args.ext as string, args.mime as string)
        return null
      }),
    built: [
      ['mp4', 'video/mp4'],
      ['png', 'image/png'],
      ['xml', 'application/xml'],
      ['glb', 'model/gltf.binary'],
      ['a+b', 'x/y'],
      ['', 'x/y'],
      ['a$&b', 'x/$&'],
    ].flatMap(([ext, mime]) =>
      [BLANK, GENERATED].map((deck): Input => deckInput(deck, { ext, mime })),
    ),
  },
  {
    fn: 'pptxMedia.media-insert.addMedia',
    call: (text, args) =>
      deckOp(text, args, (opened) =>
        withUuidAndPixels(opened, () =>
          added(
            addMedia(opened, (args.slide as number | undefined) ?? 0, mediaOptions(args.opts as Args)),
          ),
        ),
      ),
    built: MEDIA_CASES.flatMap((c) =>
      [BLANK, GENERATED].map((deck): Input => deckInput(deck, c)),
    ),
    mutation: 'none',
  },
  {
    fn: 'pptxMedia.media-insert.addModel3d',
    call: (text, args) =>
      deckOp(text, args, (opened) =>
        withUuidAndPixels(opened, () =>
          added(
            addModel3d(
              opened,
              (args.slide as number | undefined) ?? 0,
              modelOptions(args.opts as Args),
            ),
          ),
        ),
      ),
    built: MODEL_CASES.flatMap((c) =>
      [BLANK, GENERATED].map((deck): Input => deckInput(deck, c)),
    ),
    mutation: 'none',
  },
  {
    fn: 'pptxMedia.media-insert.setModel3dView',
    // a model picture is added first (the view turns what `addModel3d` wrote), then viewed
    call: (text, args) =>
      deckOp(text, args, (opened, deckAt) =>
        withUuidAndPixels(opened, () => {
          const slide = (args.slide as number | undefined) ?? 0
          let id: string
          if (args.model !== false) {
            const model = addModel3d(opened, slide, modelOptions(args.model as Args))
            id = model ? model.elementId : ''
          } else {
            id = deckAt.element(slide, (args.element as number | undefined) ?? 0)
          }
          return setModel3dView(opened, opened.deck.slides[slide]!, id, {
            rot: args.rot as never,
            ...(args.poster ? { poster: bytesOf(args.poster as { bytes: string }) as never } : {}),
          })
        }),
      ),
    built: [
      ...[undefined, POSTER, JPG_POSTER].flatMap((poster) =>
        [BLANK, GENERATED].map(
          (deck): Input =>
            deckInput(deck, {
              model: { bytes: GLB_BOX, ext: 'glb', offset: OFFSET },
              rot: { ax: 100.5, ay: -7, az: 0 },
              ...(poster ? { poster } : {}),
            }),
        ),
      ),
      // not a model: a text shape, a missing element
      deckInput(GENERATED, { model: false, element: 0, rot: { ax: 1, ay: 2, az: 3 } }),
      deckInput(GENERATED, { model: false, element: 9, rot: { ax: 1, ay: 2, az: 3 } }),
    ],
    mutation: 'none',
  },
  {
    fn: 'pptxMedia.media-insert.model3dPartOf',
    call: (text) => model3dPartOf({ descr: text }),
    built: [
      { text: 'aislides-3d:ppt/media/model3d1.glb' },
      { text: 'aislides-3d:a b\u{1F600}' },
      { text: 'aislides-3d:' },
      { text: 'aislides-3d:x\ny' },
      { text: 'xaislides-3d:a' },
      { text: '' },
    ],
  },

  // ── narration.ts ──
  {
    fn: 'pptxMedia.narration.narrationSpids',
    call: (text, args) =>
      deckOp(text, args, (opened) => narrationSpids(slideOf(opened, args))),
    built: [onSlide(NARRATED, { slide: 0 }), onSlide(SLIDE_TEXTS[1]!, { slide: 0 })],
  },
  {
    fn: 'pptxMedia.narration.clearNarration',
    call: (text, args) =>
      deckOp(text, args, (opened) => clearNarration(opened, (args.slide as number) ?? 0)),
    built: [
      onSlide(NARRATED, { slide: 0 }),
      onSlide(SLIDE_TEXTS[1]!, { slide: 0 }),
      onSlide(NARRATED, { slide: 9 }),
    ],
  },
  {
    fn: 'pptxMedia.narration.addNarration',
    call: (text, args) =>
      deckOp(text, args, (opened) =>
        withUuidAndPixels(opened, () => {
          const audio = { ...(args.audio as Args), bytes: fromB64((args.audio as Args).bytes) }
          return added(addNarration(opened, (args.slide as number) ?? 0, audio as never))
        }),
      ),
    built: [
      onSlide(NARRATED, { slide: 0, audio: NARRATION }),
      onSlide(SLIDE_TEXTS[1]!, { slide: 0, audio: NARRATION }),
      onSlide(SLIDE_TEXTS[1]!, { slide: 0, audio: { ...NARRATION, ext: 'mp3', durationMs: 0 } }),
      onSlide(SLIDE_TEXTS[1]!, { slide: 0, audio: { ...NARRATION, ext: 'flac' } }),
      onSlide(SLIDE_TEXTS[1]!, { slide: 9, audio: NARRATION }),
      deckInput(BLANK, { slide: 0, audio: { ...NARRATION, ext: 'm4a', durationMs: 1e6 } }),
      deckInput(GENERATED, { slide: 1, audio: NARRATION }),
    ],
    mutation: 'none',
  },
  {
    fn: 'pptxMedia.narration.setShowNarration',
    call: (text, args) =>
      deckOp(text, args, (opened) => {
        if (typeof args.presProps === 'string') {
          opened.archive.entries.set('ppt/presProps.xml', new TextEncoder().encode(args.presProps))
        }
        if (typeof args.presRels === 'string') {
          opened.archive.entries.set(
            'ppt/_rels/presentation.xml.rels',
            new TextEncoder().encode(args.presRels),
          )
        }
        if (args.dropPresentation === true) opened.archive.entries.delete('ppt/presentation.xml')
        setShowNarration(opened)
        return null
      }),
    built: [
      deckInput(BLANK),
      deckInput(GENERATED),
      ...PRES_PROPS_FORMS.map((presProps) =>
        deckInput(GENERATED, { presProps, presRels: PRES_REL('presProps.xml') }),
      ),
      ...PRES_PROPS_FORMS.slice(0, 3).map((presProps) =>
        deckInput(BLANK, { presProps, presRels: PRES_REL('/ppt/presProps.xml') }),
      ),
      // the part the relationship names is missing
      deckInput(GENERATED, { presRels: PRES_REL('gone.xml') }),
      deckInput(BLANK, { dropPresentation: true }),
    ],
    mutation: 'none',
  },

  // ── chart-insert.ts ──
  {
    fn: 'pptxMedia.chart-insert.buildChartSpaceXml',
    call: (_text, args) =>
      buildChartSpaceXml(chartOptions(args), args.externalDataRId as string | undefined),
    built: [
      ...CHART_OPTS.map(chartInput),
      ...CHART_OPTS.slice(0, 3).map((opts): Input => ({ args: { ...opts, externalDataRId: 'rId3' } })),
      { args: { ...CHART_OPTS[0]!, externalDataRId: '' } },
      { args: { ...CHART_OPTS[0]!, externalDataRId: 'r&Id"<1>' } },
    ],
    mutation: 'none',
  },
  {
    fn: 'pptxMedia.chart-insert.writeChartWorkbook',
    // the workbook is stored (no deflate): its bytes are compared as the parts' hash
    call: (text, args) =>
      deckOp(text, args, (opened) => {
        if (typeof args.chartText === 'string') {
          opened.archive.entries.set(args.chartPath as string, new TextEncoder().encode(args.chartText))
        }
        if (typeof args.chartRels === 'string') {
          opened.archive.entries.set(
            `ppt/charts/_rels/${(args.chartPath as string).split('/').pop()}.rels`,
            new TextEncoder().encode(args.chartRels),
          )
        }
        for (const [name, bytes] of (args.entries ?? []) as Array<[string, string]>) {
          opened.archive.entries.set(name, fromB64(bytes))
        }
        return writeChartWorkbook(opened, args.chartPath as string, chartOptions(args))
      }),
    built: [
      ...CHART_OPTS.slice(0, 2).map((opts): Input => deckInput(BLANK, { ...opts, chartPath: 'ppt/charts/chart1.xml' })),
      deckInput(GENERATED, { ...CHART_OPTS[7]!, chartPath: 'ppt/charts/chart2.xml' }),
      // a workbook already linked, in place
      deckInput(GENERATED, {
        ...CHART_OPTS[0]!,
        chartPath: 'ppt/charts/chart1.xml',
        chartText: '<c:chartSpace><c:externalData r:id="rId1"><c:autoUpdate val="0"/></c:externalData></c:chartSpace>',
        chartRels: `<?xml version="1.0"?><Relationships xmlns="${RELS_NS}"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/package" Target="../embeddings/Book.xlsx"/></Relationships>`,
        entries: [['ppt/embeddings/Book.xlsx', BYTES]],
      }),
      // a linked file (external) and an OLE object: dropped, a new workbook written
      deckInput(GENERATED, {
        ...CHART_OPTS[0]!,
        chartPath: 'ppt/charts/chart1.xml',
        chartText: '<c:chartSpace><c:externalData r:id="rId1"/></c:chartSpace>',
        chartRels: `<?xml version="1.0"?><Relationships xmlns="${RELS_NS}"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/package" Target="file:///c:/book.xlsx" TargetMode="External"/></Relationships>`,
      }),
      deckInput(GENERATED, {
        ...CHART_OPTS[0]!,
        chartPath: 'ppt/charts/chart1.xml',
        chartText: '<c:chartSpace><c:externalData r:id="rId5"/></c:chartSpace>',
        chartRels: `<?xml version="1.0"?><Relationships xmlns="${RELS_NS}"><Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/oleObject" Target="../embeddings/o.bin"/></Relationships>`,
        entries: [['ppt/embeddings/o.bin', BYTES]],
      }),
      // the id as XML reads it: single quotes, spaced `=`, a reference, other attributes before it
      ...[
        `<c:chartSpace><c:externalData r:id = 'rId1'/></c:chartSpace>`,
        '<c:chartSpace><c:externalData note="a>b" r:id="rId&#49;"/></c:chartSpace>',
        '<c:chartSpace><c:externalData r:id=""/></c:chartSpace>',
        '<c:chartSpace><c:externalData/></c:chartSpace>',
      ].map((chartText) =>
        deckInput(GENERATED, {
          ...CHART_OPTS[0]!,
          chartPath: 'ppt/charts/chart1.xml',
          chartText,
          chartRels: `<?xml version="1.0"?><Relationships xmlns="${RELS_NS}"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/package" Target="../embeddings/Book.xlsx"/></Relationships>`,
          entries: [['ppt/embeddings/Book.xlsx', BYTES]],
        }),
      ),
      // an id the rels do not have; names taken in the embeddings dir
      deckInput(GENERATED, {
        ...CHART_OPTS[0]!,
        chartPath: 'ppt/charts/chart1.xml',
        chartText: '<c:chartSpace><c:externalData r:id="rId9"/></c:chartSpace>',
        entries: [
          ['ppt/embeddings/Microsoft_Excel_Worksheet1.xlsx', BYTES],
          ['ppt/embeddings/Microsoft_Excel_Worksheet2.xlsx', BYTES],
        ],
      }),
    ],
    mutation: 'none',
  },
  {
    fn: 'pptxMedia.chart-insert.addChart',
    call: (text, args) =>
      deckOp(text, args, (opened) => {
        for (const [name, content] of (args.entries ?? []) as Array<[string, string]>) {
          opened.archive.entries.set(name, new TextEncoder().encode(content))
        }
        return withUuid(UUID, () =>
          added(addChart(opened, (args.slide as number | undefined) ?? 0, chartOptions(args))),
        )
      }),
    built: [
      ...CHART_OPTS.map((opts): Input => deckInput(GENERATED, opts)),
      ...CHART_OPTS.slice(0, 4).map((opts): Input => deckInput(BLANK, opts)),
      // numbered after the charts a deck has
      deckInput(GENERATED, {
        ...CHART_OPTS[0]!,
        entries: [
          ['ppt/charts/chart3.xml', '<c:chartSpace/>'],
          ['ppt/charts/chart10.xml', '<c:chartSpace/>'],
          ['ppt/charts/chartx.xml', '<c:chartSpace/>'],
        ],
      }),
      // no categories, no series, no such slide: null
      deckInput(GENERATED, { opts: { ...(CHART_OPTS[0]!.opts as Args), categories: [] } }),
      deckInput(GENERATED, { opts: { ...(CHART_OPTS[0]!.opts as Args), series: [] } }),
      deckInput(GENERATED, { ...CHART_OPTS[0]!, slide: 9 }),
      deckInput(GENERATED, { ...CHART_OPTS[0]!, slide: 1 }),
    ],
    mutation: 'none',
  },

  // ── hyperlink.ts ──
  {
    fn: 'pptxMedia.hyperlink.setElementLink',
    call: (text, args) =>
      deckOp(text, args, (opened, deckAt) => {
        prepare(opened, args)
        const { slide, element } = at(args)
        const id = deckAt.element(slide, element)
        const r = setElementLink(opened, slide, id, args.target as LinkTarget | null)
        return r !== null
      }),
    built: LINK_INPUTS(),
    mutation: 'none',
  },
  {
    fn: 'pptxMedia.hyperlink.decodeRunLink',
    call: (text) => decodeRunLink(text),
    built: [
      'slide:0',
      'slide:12',
      'slide:00',
      'slide:-1',
      'slide:1.5',
      'slide:99999999999999999999',
      'slide:',
      'action:nextslide',
      'action:previousslide',
      'action:firstslide',
      'action:lastslide',
      'action:lastslideviewed',
      'action:endshow',
      'action:unknown',
      'action:',
      'action:a b',
      'action:next\nslide',
      'https://example.com/a?b=c',
      'slide:1\n',
      '',
      'mailto:a@b.c',
      'Slide:1',
    ].map((text): Input => ({ text })),
  },
  {
    fn: 'pptxMedia.hyperlink.encodeRunLink',
    call: (_text, args) => encodeRunLink(args.target as LinkTarget),
    built: [
      { kind: 'url', url: 'https://x.y' },
      { kind: 'url', url: '', tooltip: 't' },
      { kind: 'slide', slideIndex: 3 },
      { kind: 'slide', slideIndex: 0, tooltip: 't' },
      { kind: 'action', action: 'nextslide' },
      { kind: 'action', action: 'endshow', tooltip: 'x' },
    ].map((target): Input => ({ args: { target } })),
    mutation: 'none',
  },
  {
    fn: 'pptxMedia.hyperlink.ensureRunLinkRels',
    call: (text, args) =>
      deckOp(text, args, (opened) => {
        prepare(opened, args)
        const paragraphs = JSON.parse(JSON.stringify(args.paragraphs)) as Parameters<
          typeof ensureRunLinkRels
        >[2]
        const changed = ensureRunLinkRels(opened, (args.slide as number) ?? 0, paragraphs)
        return { changed, paragraphs }
      }),
    built: [
      ...RUN_LINK_PARAGRAPHS().map((paragraphs): Input =>
        onSlide(SLIDE_TEXTS[1]!, { slide: 0, paragraphs }),
      ),
      ...RUN_LINK_PARAGRAPHS().map((paragraphs): Input =>
        withRels(SLIDE_TEXTS[1]!, { slide: 0, paragraphs }),
      ),
      onSlide(SLIDE_TEXTS[1]!, { slide: 9, paragraphs: RUN_LINK_PARAGRAPHS()[0] }),
      deckInput(BLANK, { slide: 0, paragraphs: RUN_LINK_PARAGRAPHS()[0] }),
    ],
    mutation: 'none',
  },
  {
    fn: 'pptxMedia.hyperlink.getRunLinks',
    call: (text, args) =>
      deckOp(text, args, (opened) => {
        prepare(opened, args)
        return getRunLinks(opened, (args.slide as number) ?? 0)
      }),
    fromDocument: undefined,
    built: [
      withRels(SLIDE_TEXTS[0]!, { slide: 0 }),
      withRels(SLIDE_TEXTS[0]!, { slide: 1 }),
      withRels(SLIDE_TEXTS[0]!, { slide: 9 }),
      onSlide(SLIDE_TEXTS[0]!, { slide: 0 }),
      onSlide(SLIDE_TEXTS[1]!, { slide: 0 }),
      withOddRels({ slide: 0 }),
      deckInput(BLANK, { slide: 0 }),
    ],
  },
  {
    fn: 'pptxMedia.hyperlink.getElementLink',
    call: (text, args) =>
      deckOp(text, args, (opened, deckAt) => {
        prepare(opened, args)
        const { slide, element } = at(args)
        return getElementLink(opened, slide, deckAt.element(slide, element))
      }),
    built: [
      ...[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((element) =>
        withRels(SLIDE_TEXTS[0]!, { slide: 0, element }),
      ),
      ...[0, 1].map((element) => withRels(SLIDE_TEXTS[2]!, { slide: 0, element })),
      ...[0, 1, 2, 3, 4].map((element) => withOddRels({ slide: 0, element })),
      withRels(SLIDE_TEXTS[0]!, { slide: 9, element: 0 }),
      onSlide(SLIDE_TEXTS[0]!, { slide: 0, element: 2 }),
      onSlide(SLIDE_TEXTS[0]!, { slide: 0, element: 4 }),
    ],
  },
  {
    fn: 'pptxMedia.hyperlink.getSlideLinks',
    call: (text, args) =>
      deckOp(text, args, (opened) => {
        prepare(opened, args)
        return getSlideLinks(opened, (args.slide as number) ?? 0)
      }),
    built: [
      withRels(SLIDE_TEXTS[0]!, { slide: 0 }),
      withRels(SLIDE_TEXTS[2]!, { slide: 0 }),
      withRels(SLIDE_TEXTS[3]!, { slide: 0 }),
      withRels(SLIDE_TEXTS[0]!, { slide: 9 }),
      withOddRels({ slide: 0 }),
      onSlide(SLIDE_TEXTS[0]!, { slide: 0 }),
      deckInput(BLANK, { slide: 0 }),
    ],
  },
]

/** Inputs of `setElementLink`: every target kind on every element shape, and the ways it answers null. */
function LINK_INPUTS(): Input[] {
  const targets: Array<LinkTarget | null> = [
    null,
    { kind: 'url', url: 'https://example.com/a?b=1&c="2"' },
    { kind: 'url', url: 'https://x.y', tooltip: 'Tip & <1>' },
    { kind: 'url', url: '', tooltip: '' },
    { kind: 'slide', slideIndex: 1 },
    { kind: 'slide', slideIndex: 0, tooltip: 'self' },
    { kind: 'slide', slideIndex: 9 },
    { kind: 'slide', slideIndex: -1 },
    { kind: 'slide', slideIndex: 1.5 },
    { kind: 'action', action: 'nextslide' },
    { kind: 'action', action: 'endshow', tooltip: 't' },
  ]
  const out: Input[] = []
  for (const element of [0, 1, 2, 3, 4, 5, 6, 8, 9]) {
    for (const target of targets) {
      out.push(withRels(SLIDE_TEXTS[0]!, { slide: 0, element, target }))
    }
  }
  // a group, and a fragment with no cNvPr
  for (const target of targets.slice(0, 5)) {
    out.push(withRels(SLIDE_TEXTS[2]!, { slide: 0, element: 1, target }))
    out.push(withRels(SLIDE_TEXTS[2]!, { slide: 0, element: 0, target }))
  }
  out.push(withRels(SLIDE_TEXTS[0]!, { slide: 0, element: 5, target: targets[1] }))
  // a missing slide and a missing element
  out.push(withRels(SLIDE_TEXTS[0]!, { slide: 9, element: 0, target: targets[1] }))
  out.push(withRels(SLIDE_TEXTS[0]!, { slide: 0, element: 99, target: targets[1] }))
  // the deck's own slides, no rels part to extend
  out.push(deckInput(BLANK, { slide: 0, element: 0, target: targets[1] }))
  // a link with a tooltip another producer spelled: kept as the value it reads
  for (const element of [0, 1, 2]) {
    for (const target of targets.slice(1, 5)) out.push(withOddRels({ slide: 0, element, target }))
  }
  return out
}

/** Paragraph sets of `ensureRunLinkRels`: every hyperlink form a run can hold. */
function RUN_LINK_PARAGRAPHS(): unknown[][] {
  const r = (extra: Record<string, unknown>) => ({ text: 'x', ...extra })
  return [
    [{ runs: [r({ hyperlink: 'https://example.com/a?b=1&c=2' })] }],
    [{ runs: [r({ hyperlink: 'slide:1' }), r({ hyperlink: 'slide:0' })] }],
    [{ runs: [r({ hyperlink: 'slide:9' }), r({ hyperlink: 'slide:-1' })] }],
    [{ runs: [r({ hyperlink: 'action:nextslide' }), r({ hyperlink: 'action:bogus' })] }],
    [{ runs: [r({ hyperlink: 'https://x.y', hyperlinkRId: 'rId5', hyperlinkAction: 'a' })] }],
    [{ runs: [r({ hyperlink: 'https://x.y', hyperlinkRId: '' })] }],
    [
      { runs: [r({ hyperlink: 'https://a.b', hyperlinkAction: 'keep' }), r({})] },
      { runs: [] },
      { runs: [r({ hyperlink: '' }), r({ hyperlink: 'slide:1', hyperlinkAction: 'old' })] },
    ],
    [],
    [{ runs: [r({ hyperlink: 'a & <b> "c" $&' })] }],
  ]
}
