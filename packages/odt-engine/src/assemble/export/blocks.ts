/**
 * The body of a docx as the ODF writers take it: one `EditedItem` per body
 * element, with everything an ODT cannot hold already turned into what it
 * becomes.
 *
 * - Tracked changes: deleted text and blocks go, inserted text stays (the
 *   final text). Comments are left out.
 * - Character styles are folded into their runs (ODF runs get their own
 *   automatic styles; the docx character style has no ODF counterpart here).
 * - Charts, equations, shapes and text boxes become picture runs (rendered,
 *   fallback picture, or a label box); horizontal rules a thin picture.
 * - Fields shown as protected paragraphs (table of contents lines, other
 *   field results) become plain paragraphs; locked paragraphs the editor
 *   cannot read are rebuilt from their text runs and objects.
 * - A paragraph's section break (`w:sectPr`) is removed; sections are
 *   handled by the page writer.
 */
import type {
  Block,
  ParaFormat,
  ParsedDoc,
  Run,
  TableModel,
  TableParagraph,
} from '@genoffice/docx-engine'
import type { EditedItem } from '../../core/convert'
import { PrefixMap, decodeXmlEntities, walkElements } from '../../core/xml'
import { stripParagraphSectPr } from '../../page/sectpr'
import { readOoxmlPPr, readOoxmlRPr } from '../../text/styles'
import type { ReportBuilder } from '../report'
import {
  type ExportObjectKind,
  type RenderedObject,
  classifyObject,
  defaultSize,
  fallbackPictureRId,
  labelRun,
  objectSize,
  pictureRun,
  solidPng,
} from './objects'
import { withRowFloors } from './rows'

/** Reads package bytes of a document relationship (null when missing). */
export type MediaReader = (rId: string) => Promise<Uint8Array | null>

export interface NormaliseEnv {
  parsed: ParsedDoc
  media: MediaReader
  rendered: (key: string) => RenderedObject | undefined
  report: ReportBuilder
}

const IDENTITY = new PrefixMap()

/** A page break as the docx engine reads it in run text. */
const FF = '\f'

const RUN_STYLE_KEYS = [
  'bold',
  'italic',
  'underline',
  'strike',
  'color',
  'sizeHalfPoints',
  'font',
  'fontAscii',
  'eastAsiaFont',
  'charSpacingTwips',
  'caps',
  'shading',
] as const

/**
 * A drawing without the bridge's identity names (`odt-pic:`, `odt-keep:`):
 * in a new document every picture is new content.
 */
const anonymous = (drawing: string | undefined): string | undefined =>
  drawing?.replace(/(<wp:docPr\b[^>]*\bname=")odt-[^"]*"/, '$1docx-picture"')

/** Objects of one body element are numbered in document order: `<docxIndex>:<n>`. */
class ObjectKeys {
  private n = 0
  constructor(private readonly index: number | null) {}
  next(): string {
    return `${this.index ?? -1}:${this.n++}`
  }
}

export class BlockNormaliser {
  revisions = 0

  constructor(private readonly env: NormaliseEnv) {}

  /** A run with its character style folded in. */
  private styled(run: Run): Run {
    if (!run.styleId) return run
    const display = this.env.parsed.styles.get(run.styleId)?.display
    if (!display) return run
    const out: Run = { ...run }
    const target = out as unknown as Record<string, unknown>
    const source = display as unknown as Record<string, unknown>
    for (const key of RUN_STYLE_KEYS) {
      if (target[key] === undefined && source[key] !== undefined && source[key] !== 'auto')
        target[key] = source[key]
    }
    if (out.fontCs === undefined && display.csFont) out.fontCs = display.csFont
    return out
  }

  /** The object a fragment becomes: rendered picture, fallback picture, or a label. */
  async objectRun(kind: ExportObjectKind, xml: string, key: string, text = ''): Promise<Run> {
    this.env.report.add('converted', kind)
    const rendered = this.env.rendered(key) ?? this.env.rendered(key.replace(/:0$/, ''))
    const size = objectSize(xml) ?? defaultSize(kind, text)
    if (rendered)
      return pictureRun(rendered.png, rendered.widthEmu, rendered.heightEmu, `docx-${kind}`)
    const rId = fallbackPictureRId(xml)
    const bytes = rId ? await this.env.media(rId) : null
    if (bytes?.length) return pictureRun(bytes, size.cx, size.cy, `docx-${kind}`)
    return labelRun(kind, size.cx, size.cy)
  }

  /** A picture run read from the package (its relationship), else from the engine's data URL. */
  private async pictureFromXml(xml: string, dataUrl: string | undefined): Promise<Run | null> {
    // a bridge docx's locked object (`odt-keep:<id>:<kind>`) is a picture here
    const keep = /<wp:docPr\b[^>]*\bname="odt-keep:[^":]*:([a-z]+)"/.exec(xml)?.[1]
    if (
      keep === 'chart' ||
      keep === 'equation' ||
      keep === 'shape' ||
      keep === 'textbox' ||
      keep === 'toc'
    )
      this.env.report.add('converted', keep)
    const rId =
      /<a:blip\b[^>]*\br:embed="([^"]+)"/.exec(xml)?.[1] ??
      /<v:imagedata\b[^>]*\br:id="([^"]+)"/.exec(xml)?.[1]
    const bytes = rId ? await this.env.media(rId) : null
    const size = objectSize(xml) ?? { cx: 914400, cy: 914400 }
    if (bytes?.length) {
      // keep the original drawing (anchoring, offsets) when it is one
      const drawing = anonymous(/<w:drawing>[\s\S]*?<\/w:drawing>/.exec(xml)?.[0])
      const run = pictureRun(bytes, size.cx, size.cy, 'docx-picture')
      if (drawing && run.image) run.image.xml = drawing
      return run
    }
    if (dataUrl && /^data:/.test(dataUrl)) {
      const drawing = anonymous(/<w:drawing>[\s\S]*?<\/w:drawing>/.exec(xml)?.[0])
      return {
        text: '',
        image: {
          dataUrl,
          xml:
            drawing ??
            `<w:drawing><wp:inline><wp:extent cx="${size.cx}" cy="${size.cy}"/></wp:inline></w:drawing>`,
        },
      }
    }
    return null
  }

  /** The runs as the ODT writer takes them. */
  async runs(runs: readonly Run[], keys = new ObjectKeys(null)): Promise<Run[]> {
    const out: Run[] = []
    for (const original of runs) {
      if (original.del) {
        this.revisions++
        continue
      }
      let run = original
      if (run.ins || run.rPrChange) {
        this.revisions++
        run = { ...run }
        delete run.ins
        delete run.rPrChange
      }
      run = this.styled(run)
      if (run.math) {
        out.push(await this.objectRun('equation', run.math.omml, keys.next(), run.text))
        continue
      }
      if (run.image) {
        if (run.image.rule) {
          const cx = /\bcx="(\d+)"/.exec(run.image.xml)?.[1]
          out.push(
            pictureRun(
              solidPng(0x80, 0x80, 0x80),
              cx ? parseInt(cx, 10) : 5400000,
              12700,
              'docx-rule',
            ),
          )
          continue
        }
        const kind = classifyObject(run.image.xml)
        if (kind && kind !== 'picture') {
          out.push(await this.objectRun(kind, run.image.xml, keys.next()))
          continue
        }
        const picture = await this.pictureFromXml(run.image.xml, run.image.dataUrl)
        if (picture) out.push(picture)
        continue
      }
      out.push(run)
    }
    return out
  }

  /** A paragraph-like block with its runs normalised. */
  private async paragraph(b: Block): Promise<Block> {
    const keys = new ObjectKeys(b.docxIndex)
    const runs = await this.runs(b.runs ?? [], keys)
    if (b.pPrChangeInfo) this.revisions++
    return { ...b, runs, rawPPr: undefined, originalXml: stripParagraphSectPr(b.originalXml ?? '') }
  }

  private async tableModel(model: TableModel, keys: ObjectKeys): Promise<TableModel> {
    const rows = []
    for (const row of model.rows) {
      const cells = []
      for (const cell of row) {
        const paras: TableParagraph[] = []
        for (const para of cell.richParas ?? [])
          paras.push({ ...para, runs: await this.runs(para.runs, keys) })
        const nested = []
        for (const t of cell.nestedTables ?? []) nested.push(await this.tableModel(t, keys))
        cells.push({
          ...cell,
          ...(cell.richParas ? { richParas: paras } : {}),
          ...(cell.nestedTables ? { nestedTables: nested } : {}),
        })
      }
      rows.push(cells)
    }
    return withRowFloors({ ...model, rows }, this.env.parsed)
  }

  /**
   * A protected paragraph rebuilt from its XML: text runs keep their own
   * formatting, drawings, VML and math become objects or pictures.
   */
  private async rebuilt(b: Block, xml: string): Promise<Block> {
    const keys = new ObjectKeys(b.docxIndex)
    const pPr = /^<w:p\b[^>]*>\s*(<w:pPr\b[^>]*>[\s\S]*?<\/w:pPr>)/.exec(xml)?.[1] ?? ''
    const styleId = /<w:pStyle\s+w:val="([^"]*)"/.exec(pPr)?.[1]
    const pieces: Array<{ kind: 'text'; run: Run } | { kind: 'object'; xml: string }> = []
    walkElements(xml, IDENTITY, {
      open(el, parent) {
        if (parent === null) return
        if (el.name === 'w:pPr' || el.name === 'w:del' || el.name === 'w:moveFrom') return 'skip'
        if (el.name === 'm:oMathPara' || el.name === 'm:oMath' || el.name === 'w:r') {
          el.data = true
          return 'skip'
        }
      },
      close(el) {
        if (!el.data) return
        const fragment = xml.slice(el.start, el.end)
        if (
          el.name !== 'w:r' ||
          /<w:drawing\b|<w:pict\b|<mc:AlternateContent\b|<w:object\b/.test(fragment)
        ) {
          pieces.push({ kind: 'object', xml: fragment })
          return
        }
        let text = ''
        walkElements(fragment, IDENTITY, {
          open(inner) {
            if (inner.name === 'w:t') {
              inner.data = true
              return 'skip'
            }
            if (inner.name === 'w:tab') text += '\t'
            else if (inner.name === 'w:br' || inner.name === 'w:cr')
              text += /w:type="page"/.test(fragment.slice(inner.start, inner.openEnd)) ? '\f' : '\n'
            else if (inner.name === 'w:noBreakHyphen') text += '‑'
            if (
              inner.name === 'w:rPr' ||
              inner.name === 'w:instrText' ||
              inner.name === 'w:delText'
            )
              return 'skip'
          },
          close(inner) {
            if (inner.data && !inner.selfClosing)
              text += decodeXmlEntities(fragment.slice(inner.openEnd, inner.closeStart))
          },
        })
        if (!text) return
        const rPr = /<w:rPr\b[^>]*>[\s\S]*?<\/w:rPr>/.exec(fragment)?.[0] ?? ''
        const rStyle = /<w:rStyle\s+w:val="([^"]*)"/.exec(rPr)?.[1]
        pieces.push({
          kind: 'text',
          run: { text, ...readOoxmlRPr(rPr), ...(rStyle ? { styleId: rStyle } : {}) },
        })
      },
    })
    const runs: Run[] = []
    for (const piece of pieces) {
      if (piece.kind === 'text') {
        runs.push(...(await this.runs([piece.run], keys)))
        continue
      }
      const kind = classifyObject(piece.xml)
      if (kind === 'picture') {
        const picture = await this.pictureFromXml(piece.xml, undefined)
        if (picture) runs.push(picture)
      } else if (kind) {
        const text = /<m:t\b[^>]*>([^<]*)/.exec(piece.xml)?.[1] ?? ''
        runs.push(await this.objectRun(kind, piece.xml, keys.next(), text))
      }
    }
    const format: ParaFormat = readOoxmlPPr(pPr)
    return {
      ...b,
      type: 'paragraph',
      runs,
      format,
      ...(styleId ? { styleId } : {}),
      rawPPr: undefined,
      originalXml: stripParagraphSectPr(xml),
    }
  }

  /** A page break (`\f`) seen at the end of the previous element, for the next one. */
  private pendingBreak = false

  /**
   * One body element → the items the writers take. A page break inside a
   * paragraph (`w:br w:type="page"`) splits it: the text after the break is a
   * paragraph of its own that starts a page (`fo:break-before`, which Hancom
   * and LibreOffice both honour). A break at the end starts the next element's
   * page; a paragraph holding only a break leaves no empty paragraph behind
   * (as Hancom reads such a docx).
   */
  async block(b: Block): Promise<EditedItem[]> {
    const one = await this.single(b)
    if (one) this.last = one
    if (!one) return []
    const block = one.blocks[0]
    const out: EditedItem[] = []
    const paragraphLike =
      block.type === 'paragraph' || block.type === 'heading' || block.type === 'listItem'
    if (!paragraphLike) {
      if (this.pendingBreak) {
        this.pendingBreak = false
        out.push({
          index: one.index,
          xml: '',
          blocks: [
            {
              ...block,
              type: 'paragraph',
              runs: [],
              table: undefined,
              format: { pageBreakBefore: true },
              rawPPr: undefined,
              originalXml: '',
            },
          ],
        })
      }
      out.push(one)
      return out
    }
    const pieces: Run[][] = [[]]
    for (const run of block.runs ?? []) {
      if (!run.text.includes(FF)) {
        pieces[pieces.length - 1].push(run)
        continue
      }
      run.text.split(FF).forEach((part, k) => {
        if (k > 0) pieces.push([])
        if (part) pieces[pieces.length - 1].push({ ...run, text: part })
      })
    }
    let breakBefore = this.pendingBreak
    this.pendingBreak = false
    pieces.forEach((runs, k) => {
      const last = k === pieces.length - 1
      if (pieces.length > 1 && !runs.length && (k === 0 || last)) {
        // a break at the start belongs to the next piece, one at the end to the next element
        if (last) this.pendingBreak = true
        else breakBefore = true
        return
      }
      const format = { ...(block.format ?? {}) }
      if (breakBefore || k > 0) format.pageBreakBefore = true
      breakBefore = false
      const piece: Block =
        k === 0
          ? { ...block, runs, format }
          : {
              ...block,
              runs,
              format,
              type: block.type === 'listItem' ? 'paragraph' : block.type,
              list: undefined,
            }
      out.push({ index: one.index, xml: k === 0 ? one.xml : '', blocks: [piece] })
    })
    return out
  }

  /**
   * After the last body element: a page break that ended the document starts
   * one more page, which holds the empty paragraph Word shows there.
   */
  end(): EditedItem[] {
    const last = this.last
    if (!this.pendingBreak || !last) return []
    this.pendingBreak = false
    const block: Block = {
      ...last.blocks[0],
      type: 'paragraph',
      runs: [],
      table: undefined,
      list: undefined,
      format: { pageBreakBefore: true },
      rawPPr: undefined,
      originalXml: '',
    }
    return [{ index: last.index, xml: '', blocks: [block] }]
  }

  /** The last element written. */
  private last: EditedItem | null = null

  /** One body element → the item the writers take (null: nothing to write). */
  private async single(b: Block): Promise<EditedItem | null> {
    if (b.hidden || b.invisibleMarker) return null
    if (b.blockRevision) {
      this.revisions++
      if (b.blockRevision.kind === 'del') return null
    }
    const index = b.docxIndex ?? -1
    const item = (block: Block): EditedItem => ({
      index,
      xml: block.originalXml ?? '',
      blocks: [block],
    })
    if (b.type === 'paragraph' || b.type === 'heading' || b.type === 'listItem')
      return item(await this.paragraph(b))
    if (b.type === 'table' && b.table) {
      const table = await this.tableModel(b.table, new ObjectKeys(b.docxIndex))
      return item({ ...b, table })
    }
    if (b.type === 'image') {
      const xml = b.originalXml ?? ''
      const picture = await this.pictureFromXml(xml, b.imageDataUrl)
      if (!picture) return null
      const pPr = /^<w:p\b[^>]*>\s*(<w:pPr\b[^>]*>[\s\S]*?<\/w:pPr>)/.exec(xml)?.[1] ?? ''
      const styleId = /<w:pStyle\s+w:val="([^"]*)"/.exec(pPr)?.[1]
      const format = readOoxmlPPr(pPr)
      if (!format.align && b.imageAlign) format.align = b.imageAlign
      return item({
        ...b,
        type: 'paragraph',
        runs: [picture],
        format,
        ...(styleId ? { styleId } : {}),
        rawPPr: undefined,
      })
    }
    // protected paragraphs: fields, objects, section breaks
    const fd = b.fieldDisplay
    if (fd) {
      if (fd.kind === 'pageBreak') return null
      if (fd.kind === 'tocLine') {
        // the field's first paragraph without an entry still takes a line
        if (!fd.left && !fd.right)
          return item({ ...b, type: 'paragraph', runs: [], rawPPr: undefined })
        const runs: Run[] = [{ text: fd.left ?? '', ...(fd.bold ? { bold: true } : {}) }]
        if (fd.right) runs.push({ text: `\t${fd.right}` })
        const format: ParaFormat = {
          ...(b.format ?? {}),
          tabStops: [
            { val: 'right', pos: 9000, leader: fd.leader ?? 'dot' },
          ] as ParaFormat['tabStops'],
        }
        const xml = b.originalXml ?? ''
        const pPr = /^<w:p\b[^>]*>\s*(<w:pPr\b[^>]*>[\s\S]*?<\/w:pPr>)/.exec(xml)?.[1] ?? ''
        Object.assign(format, readOoxmlPPr(pPr))
        const tabs = /<w:tab\b[^>]*w:val="right"[^>]*w:pos="(\d+)"/.exec(pPr)?.[1]
        if (tabs)
          format.tabStops = [
            { val: 'right', pos: parseInt(tabs, 10), leader: fd.leader ?? 'dot' },
          ] as ParaFormat['tabStops']
        return item({ ...b, type: 'paragraph', runs, format, rawPPr: undefined })
      }
      const runs: Run[] = fd.runs?.length
        ? fd.runs.map((r) => ({ ...r }) as Run)
        : [{ text: fd.left ?? '' }]
      return item({ ...b, type: 'paragraph', runs, rawPPr: undefined })
    }
    const xml = b.originalXml ?? ''
    if (/^<w:p[\s>/]/.test(xml)) return item(await this.rebuilt(b, xml))
    if (/^<w:tbl[\s>]/.test(xml) || !xml) return null
    // anything else drawable outside a paragraph (rare): its object picture
    const kind = classifyObject(xml)
    if (!kind) return null
    const keys = new ObjectKeys(b.docxIndex)
    const run =
      kind === 'picture'
        ? await this.pictureFromXml(xml, b.imageDataUrl)
        : await this.objectRun(kind, xml, keys.next())
    return run ? item({ ...b, type: 'paragraph', runs: [run], rawPPr: undefined }) : null
  }
}
