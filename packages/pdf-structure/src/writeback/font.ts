/**
 * Fonts for the translated text: finding an installed face that draws the
 * target language, measuring advances from its own tables, and subsetting
 * it for embedding.
 *
 * The installed-font lookup is the one the PDF editor's text editing uses
 * (@genoffice/font-metrics, coverage gated by the editor's cmap reader).
 * Only TrueType (glyf) faces are taken: PDFium embeds them as FontFile2
 * as they are, while CFF faces need a FontFile3 relabel pass afterwards.
 */
import { fontCoversText } from '../../../../apps/pdf/src/main/font-cmap'
import { findFontCovering, findSystemFont, isTruetype } from '../../../font-metrics/src/font-locate'
import type { CompiledWasmModule, HbSubsetWasm } from './types'

// ── installed fonts ──

type Face = readonly [psName: string, family: string]

const LATIN_FACES: readonly Face[] = [
  ['ArialMT', 'Arial'],
  ['SegoeUI', 'Segoe UI'],
  ['Helvetica', 'Helvetica'],
  ['LiberationSans-Regular', 'Liberation Sans'],
  ['DejaVuSans', 'DejaVu Sans'],
]

/** regional faces first: Han characters are drawn differently per language */
const REGIONAL_FACES: Record<string, readonly Face[]> = {
  ko: [
    ['MalgunGothic', 'Malgun Gothic'],
    ['AppleSDGothicNeo-Regular', 'Apple SD Gothic Neo'],
    ['NanumGothic', 'NanumGothic'],
    ['NotoSansCJKkr-Regular', 'Noto Sans CJK KR'],
  ],
  ja: [
    ['YuGothic-Regular', 'Yu Gothic'],
    ['Meiryo', 'Meiryo'],
    ['MSGothic', 'MS Gothic'],
    ['HiraginoSans-W3', 'Hiragino Sans'],
    ['NotoSansCJKjp-Regular', 'Noto Sans CJK JP'],
  ],
  zh: [
    ['MicrosoftYaHei', 'Microsoft YaHei'],
    ['SimSun', 'SimSun'],
    ['PingFangSC-Regular', 'PingFang SC'],
    ['NotoSansCJKsc-Regular', 'Noto Sans CJK SC'],
  ],
  'zh-TW': [
    ['MicrosoftJhengHeiRegular', 'Microsoft JhengHei'],
    ['PMingLiU', 'PMingLiU'],
    ['PingFangTC-Regular', 'PingFang TC'],
    ['NotoSansCJKtc-Regular', 'Noto Sans CJK TC'],
  ],
  th: [
    ['LeelawadeeUI', 'Leelawadee UI'],
    ['Tahoma', 'Tahoma'],
    ['Thonburi', 'Thonburi'],
  ],
}

const usable = (bytes: Buffer | null, text: string): bytes is Buffer =>
  bytes !== null && isTruetype(bytes) && fontCoversText(bytes, text)

/**
 * An installed TrueType face that maps every char of `text`: the target
 * language's regional faces, then common Latin faces, then any installed face.
 */
export function defaultWritebackFontLocator(text: string, lang: string): Uint8Array | null {
  const regional = REGIONAL_FACES[lang] ?? REGIONAL_FACES[lang.split('-')[0]!] ?? []
  for (const [ps, family] of [...regional, ...LATIN_FACES]) {
    const bytes = findSystemFont(ps, family)
    if (usable(bytes, text)) return bytes
  }
  const any = findFontCovering(text)
  return usable(any, text) ? any : null
}

/** the locator's answer, checked: a TrueType face covering the text */
export function checkedFont(bytes: Uint8Array | null, text: string): Buffer | null {
  if (!bytes) return null
  const buf = Buffer.isBuffer(bytes)
    ? bytes
    : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length)
  return usable(buf, text) ? buf : null
}

// ── metrics ──

/** advance widths and vertical extents read from a face's own tables */
export class FaceMetrics {
  private readonly view: DataView
  private readonly unitsPerEm: number
  private readonly numberOfHMetrics: number
  private readonly hmtx: number
  private readonly cmap: { offset: number; format: number } | null
  private readonly cache = new Map<number, number>()
  /** ascender and descender (positive) as a share of the em */
  readonly ascent: number
  readonly descent: number

  constructor(readonly bytes: Buffer) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const head = this.table('head')
    const hhea = this.table('hhea')
    const hmtx = this.table('hmtx')
    if (head < 0 || hhea < 0 || hmtx < 0) throw new Error('font lacks head/hhea/hmtx')
    this.unitsPerEm = this.u16(head + 18) || 1000
    this.numberOfHMetrics = this.u16(hhea + 34)
    this.hmtx = hmtx
    const os2 = this.table('OS/2')
    // typographic extents when present: hhea's are often padded for accents
    const asc = os2 >= 0 ? this.view.getInt16(os2 + 68) : this.view.getInt16(hhea + 4)
    const desc = os2 >= 0 ? this.view.getInt16(os2 + 70) : this.view.getInt16(hhea + 6)
    this.ascent = clamp(asc / this.unitsPerEm, 0.6, 1.1)
    this.descent = clamp(-desc / this.unitsPerEm, 0.1, 0.4)
    this.cmap = this.cmapSubtable()
  }

  /** advance of a codepoint in em units (1 = font size) */
  advance(cp: number): number {
    let w = this.cache.get(cp)
    if (w === undefined) {
      const gid = this.glyph(cp)
      const i = Math.min(gid, Math.max(0, this.numberOfHMetrics - 1))
      w = this.u16(this.hmtx + i * 4) / this.unitsPerEm
      this.cache.set(cp, w)
    }
    return w
  }

  /** width of a string in em units */
  measure(text: string): number {
    let w = 0
    for (const ch of text) w += this.advance(ch.codePointAt(0)!)
    return w
  }

  private u16(o: number): number {
    return o + 2 <= this.view.byteLength ? this.view.getUint16(o) : 0
  }

  private u32(o: number): number {
    return o + 4 <= this.view.byteLength ? this.view.getUint32(o) : 0
  }

  private table(tag: string): number {
    const n = this.u16(4)
    for (let i = 0; i < n; i++) {
      const rec = 12 + i * 16
      const t = String.fromCharCode(
        this.view.getUint8(rec),
        this.view.getUint8(rec + 1),
        this.view.getUint8(rec + 2),
        this.view.getUint8(rec + 3),
      )
      if (t === tag) return this.u32(rec + 8)
    }
    return -1
  }

  private cmapSubtable(): { offset: number; format: number } | null {
    const cmap = this.table('cmap')
    if (cmap < 0) return null
    let best: { offset: number; format: number } | null = null
    for (let i = 0; i < this.u16(cmap + 2); i++) {
      const rec = cmap + 4 + i * 8
      const platform = this.u16(rec)
      const encoding = this.u16(rec + 2)
      if (platform !== 0 && !(platform === 3 && (encoding === 1 || encoding === 10))) continue
      const offset = cmap + this.u32(rec + 4)
      const format = this.u16(offset)
      if (format === 12) return { offset, format }
      if (format === 4 && !best) best = { offset, format }
    }
    return best
  }

  private glyph(cp: number): number {
    const sub = this.cmap
    if (!sub) return 0
    const o = sub.offset
    if (sub.format === 12) {
      const groups = this.u32(o + 12)
      for (let i = 0; i < groups; i++) {
        const g = o + 16 + i * 12
        if (cp < this.u32(g)) return 0
        if (cp <= this.u32(g + 4)) return this.u32(g + 8) + (cp - this.u32(g))
      }
      return 0
    }
    if (cp > 0xffff) return 0
    const segX2 = this.u16(o + 6)
    const ends = o + 14
    const starts = ends + segX2 + 2
    const deltas = starts + segX2
    const rangeOffs = deltas + segX2
    for (let s = 0; s < segX2; s += 2) {
      if (cp > this.u16(ends + s)) continue
      if (cp < this.u16(starts + s)) return 0
      const delta = this.view.getInt16(deltas + s)
      const ro = this.u16(rangeOffs + s)
      if (ro === 0) return (cp + delta) & 0xffff
      const gi = this.u16(rangeOffs + s + ro + (cp - this.u16(starts + s)) * 2)
      return gi === 0 ? 0 : (gi + delta) & 0xffff
    }
    return 0
  }
}

const clamp = (v: number, lo: number, hi: number): number =>
  Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : lo

// ── subsetting ──

/** the WebAssembly calls used here (this package compiles without the DOM typings) */
declare const WebAssembly: {
  compile(bytes: ArrayBuffer): Promise<CompiledWasmModule>
  instantiate(module: CompiledWasmModule): Promise<{ exports: unknown }>
}

/** hb-subset.wasm exports we call (numbers are pointers into its linear memory) */
interface HbSubset {
  memory: { buffer: ArrayBuffer }
  malloc(size: number): number
  free(ptr: number): void
  hb_blob_create(data: number, len: number, mode: number, userData: number, destroy: number): number
  hb_blob_destroy(blob: number): void
  hb_blob_get_data(blob: number, len: number): number
  hb_blob_get_length(blob: number): number
  hb_face_create(blob: number, index: number): number
  hb_face_destroy(face: number): void
  hb_face_reference_blob(face: number): number
  hb_set_add(set: number, value: number): void
  hb_set_clear(set: number): void
  hb_set_invert(set: number): void
  hb_subset_input_create_or_fail(): number
  hb_subset_input_destroy(input: number): void
  hb_subset_input_set(input: number, setType: number): number
  hb_subset_input_unicode_set(input: number): number
  hb_subset_or_fail(face: number, input: number): number
}

const HB_MEMORY_MODE_WRITABLE = 2
const HB_SUBSET_SETS_LAYOUT_FEATURE_TAG = 6

const instances = new WeakMap<object, Promise<HbSubset>>()

function loadHb(wasm: HbSubsetWasm): Promise<HbSubset> {
  let p = instances.get(wasm)
  if (!p) {
    p = (async () => {
      const module =
        wasm instanceof Uint8Array
          ? await WebAssembly.compile(Uint8Array.from(wasm).buffer)
          : wasm instanceof ArrayBuffer
            ? await WebAssembly.compile(wasm)
            : wasm
      const instance = await WebAssembly.instantiate(module)
      return instance.exports as unknown as HbSubset
    })()
    instances.set(wasm, p)
  }
  return p
}

/**
 * A subsetter over the given wasm: the face cut down to the glyphs `text`
 * needs, layout features kept (same hb-subset calls as the PDF editor's
 * font-subset.ts, with the wasm handed in instead of resolved from disk).
 */
export async function createSubsetter(
  wasm: HbSubsetWasm,
): Promise<(font: Buffer, text: string) => Buffer> {
  const hb = await loadHb(wasm)
  return (font, text) => {
    const input = hb.hb_subset_input_create_or_fail()
    if (!input) throw new Error('hb_subset_input_create_or_fail failed')
    const fontPtr = hb.malloc(font.byteLength)
    // views are re-taken after every alloc: malloc may grow (and detach) the memory
    new Uint8Array(hb.memory.buffer).set(font, fontPtr)
    const blob = hb.hb_blob_create(fontPtr, font.byteLength, HB_MEMORY_MODE_WRITABLE, 0, 0)
    const face = hb.hb_face_create(blob, 0)
    hb.hb_blob_destroy(blob)
    let subset = 0
    let result = 0
    try {
      const features = hb.hb_subset_input_set(input, HB_SUBSET_SETS_LAYOUT_FEATURE_TAG)
      hb.hb_set_clear(features)
      hb.hb_set_invert(features)
      const unicodes = hb.hb_subset_input_unicode_set(input)
      for (const ch of text) hb.hb_set_add(unicodes, ch.codePointAt(0)!)
      subset = hb.hb_subset_or_fail(face, input)
      if (!subset) throw new Error('hb_subset_or_fail failed (corrupt font?)')
      result = hb.hb_face_reference_blob(subset)
      const len = hb.hb_blob_get_length(result)
      if (!len) throw new Error('hb-subset produced an empty font')
      const data = hb.hb_blob_get_data(result, 0)
      return Buffer.from(new Uint8Array(hb.memory.buffer).slice(data, data + len))
    } finally {
      if (result) hb.hb_blob_destroy(result)
      if (subset) hb.hb_face_destroy(subset)
      hb.hb_face_destroy(face)
      hb.hb_subset_input_destroy(input)
      hb.free(fontPtr)
    }
  }
}
