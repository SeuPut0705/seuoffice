/**
 * docx → ODT Save As: charts, equations, shapes and text boxes become pictures
 * in the ODT. The Word editor hands `docxToOdt` what the page shows for each
 * of them (`renderedObjects`), keyed the way the engine numbers them:
 * `"<docxIndex>:<n>"` = the n-th such object (document order, table cells
 * included) inside the body element with that `Block.docxIndex` of the docx
 * being converted.
 *
 * The editor's live document and the freshly built docx are walked in the same
 * order; when their object kinds line up one for one, each key gets the
 * picture of its node. When they do not (an object the editor shows as part of
 * a locked block, a nested table), no picture is passed at all and the engine
 * uses the file's fallback picture or a labelled box — never a wrong picture.
 */
import type { Editor } from '@tiptap/core'
import type { Node as PmNode } from '@tiptap/pm/model'
import type { Block, ParsedDocFull, Run, TableModel } from '@genoffice/docx-engine'
import type { RenderedObject } from '@genoffice/odt-engine'

export type ExportObjectKind = 'chart' | 'equation' | 'shape' | 'textbox'

/** the chosen branch of an mc:AlternateContent, else the fragment itself */
function chosen(xml: string): string {
  const choice = /<mc:Choice\b[^>]*>([\s\S]*?)<\/mc:Choice>/.exec(xml)?.[1]
  return choice ?? xml
}

/** Same classification as the engine's docx → ODT export (pictures stay pictures). */
export function classifyObjectXml(xml: string): ExportObjectKind | 'picture' | null {
  const x = chosen(xml)
  if (/<m:oMath\b/.test(x)) return 'equation'
  if (/<w:object\b|<o:OLEObject\b/.test(x)) {
    const prog = /\bProgID="([^"]*)"/.exec(x)?.[1] ?? ''
    if (/^Equation\./i.test(prog)) return 'equation'
    if (/Chart|Excel/i.test(prog)) return 'chart'
    return 'shape'
  }
  if (/graphicData\s+uri="[^"]*\/(?:chart|chartex)"|<c:chart\b|<cx:chart\b/.test(x)) return 'chart'
  if (/<wps:txbx\b|<v:textbox\b|<w:txbxContent\b/.test(x)) return 'textbox'
  if (/<wps:wsp\b|<wpg:wgp\b|<wpc:wpc\b|<dgm:|graphicData\s+uri="[^"]*\/diagram"/.test(x))
    return 'shape'
  if (/<pic:pic\b|<a:blip\b/.test(x)) return 'picture'
  if (/<v:imagedata\b/.test(x)) return 'picture'
  if (/<v:(?:shape|rect|roundrect|oval|line|polyline|arc|curve|group)\b/.test(x)) return 'shape'
  return null
}

function runObjectKind(run: Run): ExportObjectKind | null {
  if (run.del) return null
  if (run.math) return 'equation'
  if (!run.image || run.image.rule) return null
  const kind = classifyObjectXml(run.image.xml)
  return kind && kind !== 'picture' ? kind : null
}

export interface ObjectSlot {
  key: string
  kind: ExportObjectKind
}

/**
 * The keys `docxToOdt` gives the objects of editable paragraphs and table
 * cells, in document order. Locked blocks (fields, passthrough XML) are left
 * out: the editor shows them as one block, not object by object.
 */
export function exportObjectSlots(parsed: Pick<ParsedDocFull, 'blocks'>): ObjectSlot[] {
  const slots: ObjectSlot[] = []
  const fromRuns = (runs: readonly Run[], counter: { index: number; n: number }) => {
    for (const run of runs) {
      const kind = runObjectKind(run)
      if (kind) slots.push({ key: `${counter.index}:${counter.n++}`, kind })
    }
  }
  const fromTable = (model: TableModel, counter: { index: number; n: number }) => {
    for (const row of model.rows) {
      for (const cell of row) {
        for (const para of cell.richParas ?? []) fromRuns(para.runs, counter)
        for (const nested of cell.nestedTables ?? []) fromTable(nested, counter)
      }
    }
  }
  for (const b of parsed.blocks as Block[]) {
    if (b.hidden || b.invisibleMarker || b.blockRevision?.kind === 'del') continue
    const counter = { index: b.docxIndex ?? -1, n: 0 }
    if (b.type === 'paragraph' || b.type === 'heading' || b.type === 'listItem') {
      fromRuns(b.runs ?? [], counter)
    } else if (b.type === 'table' && b.table) {
      fromTable(b.table, counter)
    }
  }
  return slots
}

export interface EditorObject {
  kind: ExportObjectKind
  /** document position of the node (for its DOM) */
  pos: number
  node: PmNode
}

/** The editor's objects in document order, skipping locked blocks (as exportObjectSlots does). */
export function editorObjects(doc: PmNode): EditorObject[] {
  const out: EditorObject[] = []
  doc.descendants((node, pos) => {
    if (node.type.name === 'docProtected') return false
    if (node.type.name === 'docInlineMath') {
      out.push({ kind: 'equation', pos, node })
      return false
    }
    if (node.type.name === 'docInlineImage') {
      if (node.attrs.rule) return false
      const kind = classifyObjectXml(String(node.attrs.xml ?? ''))
      if (kind && kind !== 'picture') out.push({ kind, pos, node })
      return false
    }
    return true
  })
  return out
}

/** Pictures one on-screen element; null when it cannot be captured whole. */
export type ElementRasterizer = (
  el: HTMLElement,
  object: EditorObject,
) => Promise<RenderedObject | null>

const EMU_PER_PX = 9525

/** two frames: layout and paint after a scroll */
const nextPaint = () =>
  new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  )

/**
 * The default rasterizer: scroll the element into view and capture its
 * on-screen rectangle (main process `capturePage`). The size handed to the ODT
 * is the document size: a picture's own size, else the screen size without
 * the editor zoom.
 */
export const captureOnScreen: ElementRasterizer = async (el, object) => {
  el.scrollIntoView({ block: 'center', inline: 'center' })
  await nextPaint()
  const r = el.getBoundingClientRect()
  if (r.width < 1 || r.height < 1) return null
  // only a fully visible element: a clipped picture would be wrong
  if (r.left < 0 || r.top < 0 || r.right > window.innerWidth || r.bottom > window.innerHeight) {
    return null
  }
  const png = await window.desktop.captureRect({
    x: r.left,
    y: r.top,
    width: r.width,
    height: r.height,
  })
  if (!png || png.byteLength === 0) return null
  const zoom = (el as HTMLElement & { currentCSSZoom?: number }).currentCSSZoom || 1
  const widthPx = Number(object.node.attrs.widthPx) || r.width / zoom
  const heightPx = Number(object.node.attrs.heightPx) || r.height / zoom
  return {
    png: new Uint8Array(png),
    widthEmu: Math.round(widthPx * EMU_PER_PX),
    heightEmu: Math.round(heightPx * EMU_PER_PX),
  }
}

/** scroll offsets of the editor's scrolling ancestors, restored after the captures */
function rememberScroll(from: Element): () => void {
  const saved: Array<[Element, number, number]> = []
  for (let el: Element | null = from; el; el = el.parentElement) {
    saved.push([el, el.scrollTop, el.scrollLeft])
  }
  return () => {
    for (const [el, top, left] of saved) {
      el.scrollTop = top
      el.scrollLeft = left
    }
  }
}

/**
 * `renderedObjects` for `docxToOdt(docx)`: the on-screen look of each chart,
 * equation, shape and text box of the editor, keyed for the built docx
 * (`builtDocx` = that docx parsed). Empty when the two do not line up.
 */
export async function captureRenderedObjects(
  editor: Editor,
  builtDocx: Pick<ParsedDocFull, 'blocks'>,
  rasterize: ElementRasterizer = captureOnScreen,
): Promise<Record<string, RenderedObject>> {
  const slots = exportObjectSlots(builtDocx)
  if (slots.length === 0) return {}
  const objects = editorObjects(editor.state.doc)
  if (
    objects.length !== slots.length ||
    objects.some((object, i) => object.kind !== slots[i].kind)
  ) {
    return {}
  }
  const rendered: Record<string, RenderedObject> = {}
  const root = editor.view.dom
  const restoreScroll = rememberScroll(root)
  // the dark page view recolours the page on screen only: capture it as printed
  const darkWorkspace = root.closest('.workspace.page-dark')
  darkWorkspace?.classList.remove('page-dark')
  try {
    for (let i = 0; i < objects.length; i++) {
      const dom = editor.view.nodeDOM(objects[i].pos)
      if (!(dom instanceof HTMLElement)) continue
      const picture = await rasterize(dom, objects[i]).catch(() => null)
      if (picture) rendered[slots[i].key] = picture
    }
  } finally {
    darkWorkspace?.classList.add('page-dark')
    restoreScroll()
  }
  return rendered
}
