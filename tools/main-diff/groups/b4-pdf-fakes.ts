/**
 * What group `b4-pdf` drives the PDF modules with: a scripted PDFium and a
 * scripted hb-subset instance, and the builders of the fonts its cases read.
 *
 * The fakes are mirrored line by line by `FakePdfium` and `FakeHb` of
 * `crates/main-core/src/calls/b4_pdf/fake.rs`: the same world (JSON) gives the
 * same answers and the same call log on both sides. Every call is recorded as
 * one line `Name(arg,...)=result`.
 */

export interface World {
  pages?: PageSpec[]
  meta?: Record<string, string>
  loadFail?: boolean
  password?: string
  saveFail?: boolean
  mallocFail?: number[]
  loadPageFail?: number[]
  metaShort?: boolean
  getTextZero?: boolean
  rawShort?: boolean
  blackoutFail?: 'create' | 'fill' | 'mode'
  bitmapFail?: boolean
  stridePad?: number
}

export interface PageSpec {
  w?: number
  h?: number
  loadFail?: boolean
  annots?: AnnotSpec[]
  flatten?: number
  noText?: boolean
  text?: TextSpec
  objects?: ObjSpec[]
  ink?: number[][]
  genFail?: boolean
  createAnnotFail?: boolean
  setRectFail?: boolean
  setColorFail?: boolean
  applyFail?: boolean
}

export interface AnnotSpec {
  objNum?: number
  subtype?: number
  rect?: number[] | null
  contents?: string
  removeFail?: boolean
  annotNull?: boolean
}

export interface ObjSpec {
  type?: number
  bounds?: number[] | null
  data?: string
  children?: ObjSpec[]
  null?: boolean
  alias?: number
}

export interface TextSpec {
  text?: string
  count?: number
  unicodes?: number[]
  generated?: number[]
  origins?: number[][]
  sizes?: number[]
}

const fmt = (x: number | string): string => (typeof x === 'string' ? JSON.stringify(x) : String(x))

interface AnnotNode {
  page: number
  objNum: number
  subtype: number
  rect: number[] | null
  contents: string | undefined
  removeFail: boolean
  null: boolean
}

interface ObjNode {
  type: number
  bounds: number[] | null
  data: Buffer
  children: number[]
  null: boolean
}

interface BitmapNode {
  w: number
  h: number
  stride: number
  ptr: number
}

const OBJ_BASE = 2_000_000
const ANNOT_BASE = 100_000

/** The PDFium module the TypeScript of the PDF app calls (`Pdfium` of text-edit.ts), scripted by a world. */
export class FakePdfium {
  readonly log: string[] = []
  readonly buffer = new ArrayBuffer(1 << 22)
  readonly HEAPU8 = new Uint8Array(this.buffer)
  readonly HEAPF32 = new Float32Array(this.buffer)
  readonly HEAPF64 = new Float64Array(this.buffer)
  readonly HEAP32 = new Int32Array(this.buffer)
  private next = 16
  private mallocCount = 0
  private loadCalls = 0
  private annots: AnnotNode[] = []
  private live: number[][] = []
  private objs: ObjNode[] = []
  private pageObjs: number[][] = []
  private bitmaps: BitmapNode[] = []
  private rectsMade = 0
  private saved = Buffer.alloc(0)

  constructor(private readonly world: World) {
    ;(world.pages ?? []).forEach((page, p) => {
      const live: number[] = []
      for (const a of page.annots ?? []) {
        live.push(this.annots.length)
        this.annots.push({
          page: p,
          objNum: a.objNum ?? 0,
          subtype: a.subtype ?? 0,
          rect: a.rect ?? null,
          contents: a.contents,
          removeFail: a.removeFail ?? false,
          null: a.annotNull ?? false,
        })
      }
      this.live.push(live)
      this.pageObjs.push((page.objects ?? []).map((o) => this.addObj(o)))
    })
  }

  private addObj(o: ObjSpec): number {
    if (o.alias !== undefined) return o.alias
    const id = this.objs.length
    this.objs.push({
      type: o.type ?? 0,
      bounds: o.bounds ?? null,
      data: Buffer.from(o.data ?? '', 'hex'),
      children: [],
      null: o.null ?? false,
    })
    this.objs[id]!.children = (o.children ?? []).map((k) => this.addObj(k))
    return id
  }

  private pageSpec(page: number): PageSpec {
    return this.world.pages?.[page] ?? {}
  }

  private rec(name: string, args: (number | string)[], ret?: number): void {
    this.log.push(`${name}(${args.map(fmt).join(',')})${ret === undefined ? '' : `=${ret}`}`)
  }

  private cstr(ptr: number): string {
    let end = ptr
    while (end < this.HEAPU8.length && this.HEAPU8[end] !== 0) end++
    return Buffer.from(this.HEAPU8.subarray(ptr, end)).toString('utf8')
  }

  private alloc(size: number): number {
    const ptr = this.next
    const rounded = (Math.max(size, 1) + 7) & ~7
    if (ptr + rounded > this.HEAPU8.length) return 0
    this.next += rounded
    return ptr
  }

  private static pageOf = (handle: number): number => Math.max(handle - 1000, 0)

  private textPage = (handle: number): TextSpec => this.pageSpec(handle - 4000).text ?? {}

  private textUnits(page: number): number[] {
    const text = this.pageSpec(page).text?.text ?? ''
    return Array.from({ length: text.length }, (_, i) => text.charCodeAt(i))
  }

  private textCount(page: number): number {
    const spec = this.pageSpec(page).text ?? {}
    if (spec.count !== undefined) return spec.count | 0
    if (spec.unicodes) return spec.unicodes.length
    return this.textUnits(page).length
  }

  private objHandle = (id: number | undefined): number =>
    id === undefined || this.objs[id]!.null ? 0 : OBJ_BASE + id

  _PDFiumExt_Init(): void {
    /* the one-time init of the real module: not a call of a case */
  }

  _malloc(size: number): number {
    this.mallocCount++
    const fail = this.world.mallocFail?.includes(this.mallocCount) ?? false
    const ptr = fail ? 0 : this.alloc(size)
    this.rec('malloc', [size], ptr)
    return ptr
  }

  _free(ptr: number): void {
    this.rec('free', [ptr])
  }

  _PDFiumExt_OpenFileWriter(): number {
    this.rec('PDFiumExt_OpenFileWriter', [], 7)
    return 7
  }

  _PDFiumExt_SaveAsCopy(doc: number, writer: number): number {
    const r = this.world.saveFail ? 0 : 1
    if (r === 1) this.saved = Buffer.from(`SAVED:${this.log.length}`)
    this.rec('PDFiumExt_SaveAsCopy', [doc, writer], r)
    return r
  }

  _PDFiumExt_GetFileWriterSize(writer: number): number {
    const r = this.saved.length
    this.rec('PDFiumExt_GetFileWriterSize', [writer], r)
    return r
  }

  _PDFiumExt_GetFileWriterData(writer: number, buf: number, size: number): number {
    this.HEAPU8.set(this.saved, buf)
    this.rec('PDFiumExt_GetFileWriterData', [writer, buf, size], 1)
    return 1
  }

  _PDFiumExt_CloseFileWriter(writer: number): void {
    this.rec('PDFiumExt_CloseFileWriter', [writer])
  }

  _FPDF_LoadMemDocument(ptr: number, size: number, password: number): number {
    const pw = password === 0 ? null : this.cstr(password)
    const required = this.world.password
    const fail = this.world.loadFail || (required !== undefined && pw !== required)
    const r = fail ? 0 : 1
    this.rec('FPDF_LoadMemDocument', [ptr, size, pw === null ? 'null' : pw], r)
    return r
  }

  _FPDF_CloseDocument(doc: number): void {
    this.rec('FPDF_CloseDocument', [doc])
  }

  _FPDF_LoadPage(doc: number, index: number): number {
    index |= 0
    this.loadCalls++
    const failedNow = this.world.loadPageFail?.includes(this.loadCalls) ?? false
    const ok =
      index >= 0 &&
      index < (this.world.pages?.length ?? 0) &&
      !failedNow &&
      !this.pageSpec(index).loadFail
    const r = ok ? 1000 + index : 0
    this.rec('FPDF_LoadPage', [doc, index], r)
    return r
  }

  _FPDF_ClosePage(page: number): void {
    this.rec('FPDF_ClosePage', [page])
  }

  _FPDF_GetPageCount(doc: number): number {
    const r = this.world.pages?.length ?? 0
    this.rec('FPDF_GetPageCount', [doc], r)
    return r
  }

  _FPDF_GetPageWidthF(page: number): number {
    const r = Math.fround(this.pageSpec(FakePdfium.pageOf(page)).w ?? 612)
    this.rec('FPDF_GetPageWidthF', [page], r)
    return r
  }

  _FPDF_GetPageHeightF(page: number): number {
    const r = Math.fround(this.pageSpec(FakePdfium.pageOf(page)).h ?? 792)
    this.rec('FPDF_GetPageHeightF', [page], r)
    return r
  }

  _FPDF_GetMetaText(doc: number, tag: number, buffer: number, bufferLen: number): number {
    const key = this.cstr(tag)
    const value = this.world.meta?.[key] ?? ''
    const bytes = Buffer.concat([Buffer.from(value, 'utf16le'), Buffer.from([0, 0])])
    const size = bytes.length
    let r = size
    if (buffer !== 0 && bufferLen >= size) {
      this.HEAPU8.set(bytes, buffer)
      if (this.world.metaShort) r = 0
    }
    this.rec('FPDF_GetMetaText', [doc, key, buffer, bufferLen], r)
    return r
  }

  _FPDFText_LoadPage(page: number): number {
    const none = this.pageSpec(FakePdfium.pageOf(page)).noText ?? false
    const r = none ? 0 : 4000 + FakePdfium.pageOf(page)
    this.rec('FPDFText_LoadPage', [page], r)
    return r
  }

  _FPDFText_ClosePage(textPage: number): void {
    this.rec('FPDFText_ClosePage', [textPage])
  }

  _FPDFText_CountChars(textPage: number): number {
    const r = this.textCount(textPage - 4000)
    this.rec('FPDFText_CountChars', [textPage], r)
    return r
  }

  _FPDFText_GetText(textPage: number, start: number, count: number, buffer: number): number {
    const units = this.textUnits(textPage - 4000)
    const take = Math.min(Math.max(count, 0), units.length)
    const bytes = Buffer.alloc(take * 2 + 2)
    for (let i = 0; i < take; i++) bytes.writeUInt16LE(units[i]!, i * 2)
    this.HEAPU8.set(bytes, buffer)
    const r = this.world.getTextZero ? 0 : take + 1
    this.rec('FPDFText_GetText', [textPage, start, count, buffer], r)
    return r
  }

  _FPDFText_GetCharOrigin(textPage: number, index: number, x: number, y: number): number {
    const o = this.textPage(textPage).origins?.[Math.max(index, 0)] ?? [0, 0]
    this.HEAPF64.set([o[0] ?? 0], x >> 3)
    this.HEAPF64.set([o[1] ?? 0], y >> 3)
    this.rec('FPDFText_GetCharOrigin', [textPage, index, x, y], 1)
    return 1
  }

  _FPDFText_GetFontSize(textPage: number, index: number): number {
    const r = Math.fround(this.textPage(textPage).sizes?.[Math.max(index, 0)] ?? 12)
    this.rec('FPDFText_GetFontSize', [textPage, index], r)
    return r
  }

  _FPDFText_IsGenerated(textPage: number, index: number): number {
    const r = this.textPage(textPage).generated?.includes(index) ? 1 : 0
    this.rec('FPDFText_IsGenerated', [textPage, index], r)
    return r
  }

  _FPDFText_GetUnicode(textPage: number, index: number): number {
    const spec = this.textPage(textPage)
    const r = spec.unicodes
      ? (spec.unicodes[Math.max(index, 0)] ?? 0)
      : (this.textUnits(textPage - 4000)[Math.max(index, 0)] ?? 0)
    this.rec('FPDFText_GetUnicode', [textPage, index], r)
    return r
  }

  _FPDFBitmap_Create(width: number, height: number, alpha: number): number {
    const pad = this.world.stridePad ?? 0
    let r = 0
    if (!this.world.bitmapFail) {
      const stride = width * 4 + pad
      const ptr = this.alloc(stride * height)
      this.bitmaps.push({ w: width, h: height, stride, ptr })
      r = 8000 + this.bitmaps.length
    }
    this.rec('FPDFBitmap_Create', [width, height, alpha], r)
    return r
  }

  _FPDFBitmap_Destroy(bitmap: number): void {
    this.rec('FPDFBitmap_Destroy', [bitmap])
  }

  _FPDFBitmap_FillRect(
    bitmap: number,
    left: number,
    top: number,
    width: number,
    height: number,
    color: number,
  ): void {
    const b = this.bitmaps[bitmap - 8001]!
    const c = color >>> 0
    const px = [c & 0xff, (c >>> 8) & 0xff, (c >>> 16) & 0xff, (c >>> 24) & 0xff]
    for (let y = Math.max(top, 0); y < Math.min(top + height, b.h); y++) {
      for (let x = Math.max(left, 0); x < Math.min(left + width, b.w); x++) {
        this.HEAPU8.set(px, b.ptr + y * b.stride + x * 4)
      }
    }
    this.rec('FPDFBitmap_FillRect', [bitmap, left, top, width, height, c])
  }

  _FPDFBitmap_GetBuffer(bitmap: number): number {
    const r = this.bitmaps[bitmap - 8001]!.ptr
    this.rec('FPDFBitmap_GetBuffer', [bitmap], r)
    return r
  }

  _FPDFBitmap_GetStride(bitmap: number): number {
    const r = this.bitmaps[bitmap - 8001]!.stride
    this.rec('FPDFBitmap_GetStride', [bitmap], r)
    return r
  }

  _FPDF_RenderPageBitmap(
    bitmap: number,
    page: number,
    startX: number,
    startY: number,
    sizeX: number,
    sizeY: number,
    rotate: number,
    flags: number,
  ): void {
    const b = this.bitmaps[bitmap - 8001]!
    for (const v of this.pageSpec(FakePdfium.pageOf(page)).ink ?? []) {
      if (v.length < 5) continue
      for (let y = Math.max(v[1]!, 0); y < Math.min(v[3]!, b.h); y++) {
        for (let x = Math.max(v[0]!, 0); x < Math.min(v[2]!, b.w); x++) {
          const g = v[4]! & 0xff
          this.HEAPU8.set([g, g, g, 255], b.ptr + y * b.stride + x * 4)
        }
      }
    }
    this.rec('FPDF_RenderPageBitmap', [bitmap, page, startX, startY, sizeX, sizeY, rotate, flags])
  }

  _FPDFPage_CountObjects(page: number): number {
    const r = this.pageObjs[FakePdfium.pageOf(page)]!.length
    this.rec('FPDFPage_CountObjects', [page], r)
    return r
  }

  _FPDFPage_GetObject(page: number, index: number): number {
    index |= 0
    const r = this.objHandle(
      index >= 0 ? this.pageObjs[FakePdfium.pageOf(page)]![index] : undefined,
    )
    this.rec('FPDFPage_GetObject', [page, index], r)
    return r
  }

  _FPDFPage_InsertObject(page: number, obj: number): void {
    this.rec('FPDFPage_InsertObject', [page, obj])
  }

  _FPDFPage_GenerateContent(page: number): number {
    const r = this.pageSpec(FakePdfium.pageOf(page)).genFail ? 0 : 1
    this.rec('FPDFPage_GenerateContent', [page], r)
    return r
  }

  _FPDFPageObj_GetType(obj: number): number {
    const r = this.objs[obj - OBJ_BASE]?.type ?? 0
    this.rec('FPDFPageObj_GetType', [obj], r)
    return r
  }

  _FPDFFormObj_CountObjects(form: number): number {
    const r = this.objs[form - OBJ_BASE]?.children.length ?? 0
    this.rec('FPDFFormObj_CountObjects', [form], r)
    return r
  }

  _FPDFFormObj_GetObject(form: number, index: number): number {
    index |= 0
    const r = this.objHandle(index >= 0 ? this.objs[form - OBJ_BASE]?.children[index] : undefined)
    this.rec('FPDFFormObj_GetObject', [form, index], r)
    return r
  }

  _FPDFPageObj_Destroy(obj: number): void {
    this.rec('FPDFPageObj_Destroy', [obj])
  }

  _FPDFPageObj_GetBounds(obj: number, l: number, b: number, r: number, t: number): number {
    const v = this.objs[obj - OBJ_BASE]?.bounds
    let ret = 0
    if (v) {
      this.HEAPF32[l >> 2] = v[0]!
      this.HEAPF32[b >> 2] = v[1]!
      this.HEAPF32[r >> 2] = v[2]!
      this.HEAPF32[t >> 2] = v[3]!
      ret = 1
    }
    this.rec('FPDFPageObj_GetBounds', [obj, l, b, r, t], ret)
    return ret
  }

  _FPDFImageObj_GetImageDataRaw(obj: number, buffer: number, buflen: number): number {
    const data = this.objs[obj - OBJ_BASE]?.data ?? Buffer.alloc(0)
    const size = data.length
    let r = size
    if (buffer !== 0 && buflen >= size) {
      this.HEAPU8.set(data, buffer)
      if (this.world.rawShort) r = Math.max(size - 1, 0)
    }
    this.rec('FPDFImageObj_GetImageDataRaw', [obj, buffer, buflen], r)
    return r
  }

  _FPDFPageObj_SetFillColor(obj: number, r: number, g: number, b: number, a: number): number {
    const ret = this.world.blackoutFail === 'fill' ? 0 : 1
    this.rec('FPDFPageObj_SetFillColor', [obj, r, g, b, a], ret)
    return ret
  }

  _FPDFPageObj_CreateNewRect(x: number, y: number, width: number, height: number): number {
    let r = 0
    if (this.world.blackoutFail !== 'create') {
      this.rectsMade++
      r = 3_000_000 + this.rectsMade
    }
    this.rec(
      'FPDFPageObj_CreateNewRect',
      [Math.fround(x), Math.fround(y), Math.fround(width), Math.fround(height)],
      r,
    )
    return r
  }

  _FPDFPath_SetDrawMode(path: number, fillMode: number, stroke: number): number {
    const r = this.world.blackoutFail === 'mode' ? 0 : 1
    this.rec('FPDFPath_SetDrawMode', [path, fillMode, stroke], r)
    return r
  }

  _FPDFPage_GetAnnotCount(page: number): number {
    const r = this.live[FakePdfium.pageOf(page)]!.length
    this.rec('FPDFPage_GetAnnotCount', [page], r)
    return r
  }

  _FPDFPage_Flatten(page: number, flags: number): number {
    const p = FakePdfium.pageOf(page)
    const r = this.pageSpec(p).flatten ?? 1
    if (r === 1) this.live[p] = []
    this.rec('FPDFPage_Flatten', [page, flags], r)
    return r
  }

  _FPDFPage_GetAnnot(page: number, index: number): number {
    index |= 0
    const idx = index >= 0 ? this.live[FakePdfium.pageOf(page)]![index] : undefined
    const r = idx === undefined || this.annots[idx]!.null ? 0 : ANNOT_BASE + idx
    this.rec('FPDFPage_GetAnnot', [page, index], r)
    return r
  }

  _FPDFPage_CloseAnnot(annot: number): void {
    this.rec('FPDFPage_CloseAnnot', [annot])
  }

  _FPDFPage_RemoveAnnot(page: number, index: number): number {
    index |= 0
    const p = FakePdfium.pageOf(page)
    let r = 0
    const idx = index >= 0 ? this.live[p]![index] : undefined
    if (idx !== undefined && !this.annots[idx]!.removeFail) {
      this.live[p]!.splice(index, 1)
      r = 1
    }
    this.rec('FPDFPage_RemoveAnnot', [page, index], r)
    return r
  }

  _FPDFPage_CreateAnnot(page: number, subtype: number): number {
    const p = FakePdfium.pageOf(page)
    let r = 0
    if (!this.pageSpec(p).createAnnotFail) {
      this.annots.push({
        page: p,
        objNum: 0,
        subtype,
        rect: null,
        contents: undefined,
        removeFail: false,
        null: false,
      })
      r = ANNOT_BASE + this.annots.length - 1
    }
    this.rec('FPDFPage_CreateAnnot', [page, subtype], r)
    return r
  }

  _FPDFAnnot_SetRect(annot: number, rect: number): number {
    const vals = [0, 1, 2, 3].map((k) => this.HEAPF32[(rect >> 2) + k]!)
    const page = this.annots[annot - ANNOT_BASE]!.page
    const r = this.pageSpec(page).setRectFail ? 0 : 1
    this.rec('FPDFAnnot_SetRect', [annot, ...vals], r)
    return r
  }

  _EPDFAnnot_SetColor(annot: number, type: number, r: number, g: number, b: number): number {
    const page = this.annots[annot - ANNOT_BASE]!.page
    const ret = this.pageSpec(page).setColorFail ? 0 : 1
    this.rec('EPDFAnnot_SetColor', [annot, type, r, g, b], ret)
    return ret
  }

  _FPDFAnnot_GetSubtype(annot: number): number {
    const r = this.annots[annot - ANNOT_BASE]!.subtype
    this.rec('FPDFAnnot_GetSubtype', [annot], r)
    return r
  }

  _FPDFAnnot_GetRect(annot: number, rect: number): number {
    const v = this.annots[annot - ANNOT_BASE]!.rect
    let r = 0
    if (v) {
      v.forEach((x, k) => {
        this.HEAPF32[(rect >> 2) + k] = x
      })
      r = 1
    }
    this.rec('FPDFAnnot_GetRect', [annot, rect], r)
    return r
  }

  _FPDFAnnot_GetStringValue(annot: number, key: number, buffer: number, buflen: number): number {
    const name = this.cstr(key)
    const contents = this.annots[annot - ANNOT_BASE]!.contents
    let r = 0
    if (name === 'Contents' && contents !== undefined) {
      const bytes = Buffer.concat([Buffer.from(contents, 'utf16le'), Buffer.from([0, 0])])
      if (buffer !== 0 && buflen >= bytes.length) this.HEAPU8.set(bytes, buffer)
      r = bytes.length
    }
    this.rec('FPDFAnnot_GetStringValue', [annot, name, buffer, buflen], r)
    return r
  }

  _EPDFPage_GetAnnotByObjectNumber(page: number, objNum: number): number {
    objNum |= 0
    const idx = this.live[FakePdfium.pageOf(page)]!.find((i) => this.annots[i]!.objNum === objNum)
    const r = idx === undefined ? 0 : ANNOT_BASE + idx
    this.rec('EPDFPage_GetAnnotByObjectNumber', [page, objNum], r)
    return r
  }

  _EPDFPage_RemoveAnnotByObjectNumber(page: number, objNum: number): number {
    objNum |= 0
    const p = FakePdfium.pageOf(page)
    const at = this.live[p]!.findIndex((i) => this.annots[i]!.objNum === objNum)
    let r = 0
    if (at >= 0 && !this.annots[this.live[p]![at]!]!.removeFail) {
      this.live[p]!.splice(at, 1)
      r = 1
    }
    this.rec('EPDFPage_RemoveAnnotByObjectNumber', [page, objNum], r)
    return r
  }

  _EPDFAnnot_ApplyRedaction(page: number, annot: number): number {
    const r = this.pageSpec(FakePdfium.pageOf(page)).applyFail ? 0 : 1
    this.rec('EPDFAnnot_ApplyRedaction', [page, annot], r)
    return r
  }
}

export interface HbWorld {
  result?: string
  emptyResult?: boolean
  inputFail?: boolean
  subsetFail?: boolean
  memorySize?: number
}

/** The hb-subset.wasm exports `subsetTtf` calls, scripted by a world. */
export class FakeHb {
  readonly log: string[] = []
  readonly memory: { buffer: ArrayBuffer }
  private readonly bytes: Uint8Array
  private next = 16
  private blobs = 0
  private faces = 0
  private readonly result: Buffer

  constructor(private readonly world: HbWorld) {
    this.memory = { buffer: new ArrayBuffer(world.memorySize ?? 1_048_576) }
    this.bytes = new Uint8Array(this.memory.buffer)
    this.result = Buffer.from(world.result ?? '', 'hex')
  }

  private rec(name: string, args: number[], ret?: number): void {
    this.log.push(`${name}(${args.join(',')})${ret === undefined ? '' : `=${ret}`}`)
  }

  malloc(size: number): number {
    const ptr = this.next
    this.next += (Math.max(size, 1) + 7) & ~7
    this.rec('malloc', [size], ptr)
    return ptr
  }

  free(ptr: number): void {
    this.rec('free', [ptr])
  }

  hb_blob_create(
    data: number,
    len: number,
    mode: number,
    userData: number,
    destroy: number,
  ): number {
    this.blobs++
    const r = 100 + this.blobs
    this.rec('hb_blob_create', [data, len, mode, userData, destroy], r)
    return r
  }

  hb_blob_destroy(blob: number): void {
    this.rec('hb_blob_destroy', [blob])
  }

  hb_blob_get_data(blob: number, len: number): number {
    const ptr = this.next
    this.next += (Math.max(this.result.length, 1) + 7) & ~7
    if (ptr + this.result.length <= this.bytes.length) this.bytes.set(this.result, ptr)
    this.rec('hb_blob_get_data', [blob, len], ptr)
    return ptr
  }

  hb_blob_get_length(blob: number): number {
    const r = this.world.emptyResult ? 0 : this.result.length
    this.rec('hb_blob_get_length', [blob], r)
    return r
  }

  hb_face_create(blob: number, index: number): number {
    this.faces++
    const r = 200 + this.faces
    this.rec('hb_face_create', [blob, index], r)
    return r
  }

  hb_face_destroy(face: number): void {
    this.rec('hb_face_destroy', [face])
  }

  hb_face_reference_blob(face: number): number {
    this.rec('hb_face_reference_blob', [face], 400)
    return 400
  }

  hb_set_add(set: number, value: number): void {
    this.rec('hb_set_add', [set, value])
  }

  hb_set_clear(set: number): void {
    this.rec('hb_set_clear', [set])
  }

  hb_set_invert(set: number): void {
    this.rec('hb_set_invert', [set])
  }

  hb_subset_input_create_or_fail(): number {
    const r = this.world.inputFail ? 0 : 11
    this.rec('hb_subset_input_create_or_fail', [], r)
    return r
  }

  hb_subset_input_destroy(input: number): void {
    this.rec('hb_subset_input_destroy', [input])
  }

  hb_subset_input_set(input: number, setType: number): number {
    this.rec('hb_subset_input_set', [input, setType], 31)
    return 31
  }

  hb_subset_input_unicode_set(input: number): number {
    this.rec('hb_subset_input_unicode_set', [input], 32)
    return 32
  }

  hb_subset_or_fail(face: number, input: number): number {
    const r = this.world.subsetFail ? 0 : 300
    this.rec('hb_subset_or_fail', [face, input], r)
    return r
  }
}

// ---- font builders ---------------------------------------------------------

const u16 = (n: number): number[] => [(n >> 8) & 0xff, n & 0xff]
const u32 = (n: number): number[] => [
  (n >>> 24) & 0xff,
  (n >> 16) & 0xff,
  (n >> 8) & 0xff,
  n & 0xff,
]
const hex = (bytes: number[]): string => Buffer.from(bytes).toString('hex')
const tag = (s: string): number[] => [...Buffer.from(s, 'latin1')]

/** an sfnt: header and table directory, the tables laid out one after another */
export function sfnt(flavor: number, tables: [string, number[]][]): number[] {
  const head = [...u32(flavor), ...u16(tables.length), 0, 0, 0, 0, 0, 0]
  let offset = 12 + 16 * tables.length
  const dir: number[] = []
  const body: number[] = []
  for (const [name, data] of tables) {
    dir.push(...tag(name), 0, 0, 0, 0, ...u32(offset), ...u32(data.length))
    body.push(...data)
    offset += data.length
  }
  return [...head, ...dir, ...body]
}

/** a format 4 subtable; every segment `[start, end, idDelta, rangeOffset, glyphIds?]` */
export function cmap4(
  segments: [number, number, number, number][],
  glyphIdArray: number[] = [],
): number[] {
  const segCount = segments.length + 1
  const all = [...segments, [0xffff, 0xffff, 1, 0] as [number, number, number, number]]
  const body = [
    ...u16(segCount * 2),
    0,
    0,
    0,
    0,
    0,
    0,
    ...all.flatMap(([, end]) => u16(end)),
    ...u16(0),
    ...all.flatMap(([start]) => u16(start)),
    ...all.flatMap(([, , delta]) => u16(delta & 0xffff)),
    ...all.flatMap(([, , , ro]) => u16(ro)),
    ...glyphIdArray.flatMap((g) => u16(g)),
  ]
  const length = 6 + body.length
  return [...u16(4), ...u16(length), ...u16(0), ...body]
}

/** a format 12 subtable; every group `[start, end, glyph]` */
export function cmap12(groups: [number, number, number][]): number[] {
  const length = 16 + groups.length * 12
  return [
    ...u16(12),
    ...u16(0),
    ...u32(length),
    ...u32(0),
    ...u32(groups.length),
    ...groups.flatMap(([a, b, g]) => [...u32(a), ...u32(b), ...u32(g)]),
  ]
}

/** a cmap table over subtables `[platform, encoding, subtable]` */
export function cmapTable(subtables: [number, number, number[]][]): number[] {
  let offset = 4 + 8 * subtables.length
  const records: number[] = []
  const bodies: number[] = []
  for (const [platform, encoding, data] of subtables) {
    records.push(...u16(platform), ...u16(encoding), ...u32(offset))
    bodies.push(...data)
    offset += data.length
  }
  return [...u16(0), ...u16(subtables.length), ...records, ...bodies]
}

/** an OS/2 table of `length` bytes with the weight class and the four PANOSE bytes that are read */
export function os2Table(
  weight: number,
  panose: [number, number, number, number],
  length = 78,
): number[] {
  const out = new Array<number>(length).fill(0)
  out[4] = (weight >> 8) & 0xff
  out[5] = weight & 0xff
  out.splice(32, 4, ...panose)
  return out
}

export interface CffSpec {
  cid?: boolean
  fmt?: number
  nGlyphs?: number
  /** the bytes of the charset, format byte first; default: a valid one for `fmt` */
  charset?: number[]
  /** extra bytes after the charset (room for a rewrite) */
  charsetOffset?: number
  charStringsOffset?: number
  noCharsetOp?: boolean
  noCharStringsOp?: boolean
  realOperand?: boolean
  emptyTop?: boolean
  offSize?: number
  hdrSize?: number
  truncate?: number
}

const dictInt = (n: number): number[] => [29, ...u32(n)]

/** an OTTO font with one `CFF ` table, shaped by `spec` */
export function cffFont(spec: CffSpec): number[] {
  const nGlyphs = spec.nGlyphs ?? 10
  const fmt = spec.fmt ?? 2
  let charset: number[]
  if (spec.charset) charset = spec.charset
  else if (fmt === 0)
    charset = [0, ...Array.from({ length: nGlyphs - 1 }, (_, i) => u16(100 + i)).flat()]
  else if (fmt === 1) charset = [1, ...u16(100), nGlyphs - 2]
  else charset = [2, ...u16(100), ...u16(nGlyphs - 2)]
  const hdrSize = spec.hdrSize ?? 4
  const header = [1, 0, hdrSize, 1]
  const name = [...u16(1), 1, 1, 5, ...tag('Test')]
  // the top dict is built twice: its size decides where the charset sits
  const dict = (charsetOff: number, charStringsOff: number): number[] => {
    const ops: number[] = []
    if (spec.cid ?? true) ops.push(...dictInt(391), ...dictInt(391), ...dictInt(0), 12, 30)
    if (!spec.noCharsetOp) {
      if (spec.realOperand) ops.push(30, 0x1f, 15)
      else ops.push(...dictInt(charsetOff), 15)
    }
    if (!spec.noCharStringsOp) ops.push(...dictInt(charStringsOff), 17)
    return ops
  }
  const probe = dict(0, 0)
  const topIndexLen = 2 + 1 + 2 + probe.length
  const charsetOff = spec.charsetOffset ?? hdrSize + name.length + topIndexLen + 2
  const charStringsOff = spec.charStringsOffset ?? charsetOff + charset.length
  const top = dict(charsetOff, charStringsOff)
  const topIndex = spec.emptyTop ? u16(0) : [...u16(1), 1, 1, 1 + top.length, ...top]
  const strings = u16(0)
  const charStrings = [...u16(nGlyphs), 1, 1]
  const cff = [...header, ...name, ...topIndex, ...strings, ...charset, ...charStrings]
  if (spec.offSize !== undefined) cff[hdrSize + 2] = spec.offSize
  const font = sfnt(0x4f54544f, [['CFF ', cff]])
  return spec.truncate === undefined ? font : font.slice(0, spec.truncate)
}

export const fontHex = (bytes: number[]): string => hex(bytes)
