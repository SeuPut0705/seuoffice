/**
 * The editor half of the ODT rules (see odt-gate.ts). Only active while an ODT
 * document is open; a docx document never sees any of this.
 *
 * - Protected cells: Hancom's locked table cells (`protectedCellsOf` of the
 *   bridge map) refuse every transaction that touches them — typing,
 *   formatting, cell attributes, row/column deletion, AI tools and MCP ops all
 *   arrive here as transactions. Selecting one says so ("protected cell").
 * - Locked placeholders (`odt-keep:` pictures): a transaction may delete one
 *   whole, never change it (size, crop, picture, rotation, position, alt text).
 * - Switched-off content kinds (text boxes, shapes, equations, charts, tables
 *   of contents, comments, tracked changes, captions, cross-references,
 *   citations) never land in the document: a paste keeps only what it shows
 *   (a picture or plain text), and anything another path inserts is turned
 *   into the same right after it lands.
 */
import { Extension } from '@tiptap/core'
import { Fragment, Slice, type Mark, type Node as PmNode, type Schema } from '@tiptap/pm/model'
import {
  NodeSelection,
  Plugin,
  PluginKey,
  type EditorState,
  type Transaction,
} from '@tiptap/pm/state'
import { TableMap } from '@tiptap/pm/tables'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'
import type { Step } from '@tiptap/pm/transform'
import type {
  FieldDisplay,
  FormulaDisplay,
  TableModel,
  TextboxDisplay,
} from '@genoffice/docx-engine'
import { protectedCellsOf, type ProtectedCellRef } from '@genoffice/odt-engine'
import {
  keepOfNode,
  notifyOdt,
  odtSession,
  recordOdtRefusal,
  type OdtRefusal,
  type OdtSession,
} from '../odt-gate'
import { t } from '../i18n/locale'
import { PHASED_APPEND } from './streaming-tail-guard'

// ---- positions a transaction touches ----

type Range = [number, number]

function stepRanges(step: Step): Range[] {
  const ranges: Range[] = []
  step.getMap().forEach((oldStart, oldEnd) => ranges.push([oldStart, oldEnd]))
  if (ranges.length > 0) return ranges
  // mark and attribute steps move nothing, so their map is empty
  const s = step as unknown as { from?: number; to?: number; pos?: number }
  if (typeof s.from === 'number' && typeof s.to === 'number') return [[s.from, s.to]]
  if (typeof s.pos === 'number') return [[s.pos, s.pos + 1]]
  return []
}

/** the ranges every step touches, in the coordinates of `tr.before` */
function touchedBefore(tr: Transaction): Range[] {
  const out: Range[] = []
  tr.steps.forEach((step, i) => {
    const back = i === 0 ? null : tr.mapping.slice(0, i).invert()
    for (const [a, b] of stepRanges(step)) {
      out.push(back ? [back.map(a, -1), back.map(b, 1)] : [a, b])
    }
  })
  return out
}

/** the ranges a group of transactions changed, in the coordinates of the last document */
function changedAfter(trs: readonly Transaction[]): Range[] {
  let ranges: Range[] = []
  for (const tr of trs) {
    if (!tr.docChanged) continue
    ranges = ranges.map(([a, b]) => [tr.mapping.map(a, -1), tr.mapping.map(b, 1)])
    tr.steps.forEach((step, i) => {
      const rest = tr.mapping.slice(i + 1)
      const own: Range[] = []
      step.getMap().forEach((_a, _b, newStart, newEnd) => own.push([newStart, newEnd]))
      if (own.length === 0) own.push(...stepRanges(step))
      for (const [a, b] of own) ranges.push([rest.map(a, -1), rest.map(b, 1)])
    })
  }
  return ranges
}

/** a step replaced the whole document */
function replacesWholeDocument(tr: Transaction): boolean {
  return tr.steps.some((step, i) => {
    const s = step as unknown as { from?: unknown; to?: unknown }
    return (
      typeof s.from === 'number' &&
      typeof s.to === 'number' &&
      s.from === 0 &&
      s.to >= tr.docs[i]!.content.size
    )
  })
}

/**
 * A load: the editor set new content (open, reload after a save, AI rollback,
 * a phased open's chunks). Select-all and type also replaces everything, but
 * that is an edit like any other.
 */
function isLoad(tr: Transaction): boolean {
  if (tr.getMeta(PHASED_APPEND)) return true
  return tr.getMeta('preventUpdate') !== undefined && replacesWholeDocument(tr)
}

const overlaps = ([a, b]: Range, from: number, to: number): boolean =>
  a === b ? a > from && a < to : a < to && b > from

// ---- protected cells ----

/** a locked cell: `pos` is the top-level editor cell that is locked or that holds the locked nested cell */
interface CellLock {
  pos: number
  ref: ProtectedCellRef
}

function topLevelTables(doc: PmNode): number[] {
  const out: number[] = []
  doc.forEach((node, offset) => {
    if (node.type.name === 'docTable') out.push(offset)
  })
  return out
}

/** absolute position of the cell whose top-left grid slot is (row, col), or null */
function cellAt(doc: PmNode, tablePos: number, row: number, col: number): number | null {
  const table = doc.nodeAt(tablePos)
  if (!table || table.type.name !== 'docTable') return null
  let map: TableMap
  try {
    map = TableMap.get(table)
  } catch {
    return null
  }
  if (row < 0 || col < 0 || row >= map.height || col >= map.width) return null
  const rel = map.map[row * map.width + col]
  const rect = map.findCell(rel)
  if (rect.top !== row || rect.left !== col) return null
  return tablePos + 1 + rel
}

/** grid (row, col) of a top-level cell */
function gridOf(
  doc: PmNode,
  tablePos: number,
  cellPos: number,
): { row: number; col: number } | null {
  const table = doc.nodeAt(tablePos)
  if (!table) return null
  try {
    const rect = TableMap.get(table).findCell(cellPos - tablePos - 1)
    return { row: rect.top, col: rect.left }
  } catch {
    return null
  }
}

/** locks of the open document: its tables still carry the bridge's element index */
function identifyByBridge(doc: PmNode, s: OdtSession): CellLock[] {
  const refs = protectedCellsOf(s.bridge)
  if (refs.length === 0) return []
  const tables = new Map<number, number>()
  for (const pos of topLevelTables(doc)) {
    const index = doc.nodeAt(pos)?.attrs.docxIndex
    if (typeof index === 'number') tables.set(index, pos)
  }
  const locks: CellLock[] = []
  for (const ref of refs) {
    const tablePos = tables.get(ref.table)
    if (tablePos === undefined) continue
    const host = ref.path[0]
    const pos = cellAt(doc, tablePos, host ? host.row : ref.row, host ? host.col : ref.col)
    if (pos !== null) locks.push({ pos, ref })
  }
  return locks
}

/**
 * A reload replaced the document with the same content read back from the
 * saved docx: the locks follow their table's order and grid slot.
 */
function carryLocks(before: PmNode, after: PmNode, locks: readonly CellLock[]): CellLock[] {
  const oldTables = topLevelTables(before)
  const newTables = topLevelTables(after)
  const out: CellLock[] = []
  for (const lock of locks) {
    let tableIndex = -1
    oldTables.forEach((p, i) => {
      if (p < lock.pos) tableIndex = i
    })
    if (tableIndex < 0 || tableIndex >= newTables.length) continue
    const grid = gridOf(before, oldTables[tableIndex], lock.pos)
    if (!grid) continue
    const pos = cellAt(after, newTables[tableIndex], grid.row, grid.col)
    if (pos !== null) out.push({ pos, ref: lock.ref })
  }
  return out
}

/** the w:tc index of the cell covering grid column `col` in a model row */
function tcOfCol(model: TableModel, row: number, col: number): number {
  const cells = model.rows[row] ?? []
  let at = 0
  for (let i = 0; i < cells.length; i++) {
    const span = cells[i].colSpan ?? 1
    if (col >= at && col < at + span) return i
    at += span
  }
  return -1
}

/** the locked nested cell of `lock` inside its host cell, as plain JSON (null = gone) */
function nestedCellJson(host: PmNode | null | undefined, ref: ProtectedCellRef): string | null {
  if (!host) return null
  const nested: PmNode[] = []
  host.forEach((child) => {
    if (child.type.name === 'docNestedTable') nested.push(child)
  })
  let model = nested[ref.path[0].index]?.attrs.model as TableModel | null | undefined
  for (const step of ref.path.slice(1)) {
    if (!model) return null
    const cell = model.rows[step.row]?.[tcOfCol(model, step.row, step.col)]
    model = cell?.nestedTables?.[step.index]
  }
  const cell = model?.rows[ref.row]?.[ref.tc]
  return cell ? JSON.stringify(cell) : null
}

// ---- locked placeholders ----

function keepsIn(doc: PmNode, ranges: readonly Range[]): Map<string, string> {
  const found = new Map<string, string>()
  const size = doc.content.size
  for (const [a, b] of ranges) {
    const from = Math.max(0, Math.min(a, b, size))
    const to = Math.min(size, Math.max(a, b))
    // an empty range still sits next to (and may address) an atom
    doc.nodesBetween(from, Math.min(size, Math.max(to, from + 1)), (node) => {
      const keep = keepOfNode(node)
      if (keep) found.set(keep.id, attrsKey(node))
      return true
    })
  }
  return found
}

const attrsKey = (node: PmNode): string => `${node.type.name}:${JSON.stringify(node.attrs)}`

function keepsByIdIn(doc: PmNode, ids: ReadonlySet<string>): Map<string, string[]> {
  const out = new Map<string, string[]>()
  doc.descendants((node) => {
    const keep = keepOfNode(node)
    if (keep && ids.has(keep.id)) out.set(keep.id, [...(out.get(keep.id) ?? []), attrsKey(node)])
    return true
  })
  return out
}

// ---- switched-off content kinds ----

const OFF_FIELD =
  /^\s*(?:TOC|SEQ|REF|PAGEREF|NOTEREF|CITATION|BIBLIOGRAPHY|ADDIN\s+(?:ZOTERO_|CSL_|EN\.))/i

function disallowedProtected(node: PmNode): boolean {
  const a = node.attrs
  if (a.blockType === 'image') return false
  const boxes = a.textboxes as TextboxDisplay[] | null
  return (
    a.blockType === 'chart' ||
    !!a.genChart ||
    !!a.chartDisplay ||
    !!a.formulaDisplay ||
    !!a.diagramDisplay ||
    (Array.isArray(boxes) && boxes.length > 0) ||
    (a.fieldDisplay as FieldDisplay | null)?.kind === 'tocLine'
  )
}

/** what a switched-off block shows, as plain text lines */
function visibleLines(node: PmNode): string[] {
  const a = node.attrs
  const field = a.fieldDisplay as FieldDisplay | null
  if (field?.kind === 'tocLine') return [[field.left, field.right].filter(Boolean).join('\t')]
  const formula = a.formulaDisplay as FormulaDisplay | null
  if (formula) return [formula.latex || formula.tokens.join('')]
  const preview = String(a.previewText ?? '')
  return preview ? preview.split('\n') : []
}

/**
 * The replacement of a node of a switched-off kind (null = keep the node).
 * `known` = comment ids the document may keep; null drops every comment.
 */
function replacementOf(node: PmNode, schema: Schema, known: Set<string> | null): Fragment | null {
  const name = node.type.name
  if (name === 'docInlineMath') {
    const text = String(node.attrs.latex ?? '') || String(node.attrs.text ?? '')
    return text ? Fragment.from(schema.text(text, cleanMarks(node.marks, known))) : Fragment.empty
  }
  if (name === 'docCellBoxes') return Fragment.empty
  if (name === 'docProtected' && disallowedProtected(node)) {
    const src = String(node.attrs.imageDataUrl ?? '')
    if (src.startsWith('data:image/') && !src.startsWith('data:image/svg')) {
      return Fragment.from(
        schema.nodes.docProtected.create({
          blockType: 'image',
          label: 'Image',
          imageDataUrl: src,
          imageWidthPx: node.attrs.imageWidthPx ?? null,
          imageHeightPx: node.attrs.imageHeightPx ?? null,
        }),
      )
    }
    const paragraph = schema.nodes.docParagraph
    return Fragment.from(
      visibleLines(node).map((line) => paragraph.create(null, line ? schema.text(line) : null)),
    )
  }
  if (node.isText) {
    if (node.marks.some((m) => m.type.name === 'del')) return Fragment.empty
    const marks = cleanMarks(node.marks, known)
    if (marks.length === node.marks.length && marks.every((m, i) => m === node.marks[i]))
      return null
    return Fragment.from(schema.text(node.text ?? '', marks))
  }
  return null
}

function cleanMarks(marks: readonly Mark[], known: Set<string> | null): readonly Mark[] {
  const out: Mark[] = []
  for (const mark of marks) {
    const name = mark.type.name
    if (name === 'ins' || name === 'del' || name === 'refField') continue
    if (name === 'instrField' && OFF_FIELD.test(String(mark.attrs.instr ?? ''))) continue
    if (name === 'comment') {
      const ids = String(mark.attrs.ids ?? '')
        .split(/\s+/)
        .filter((id) => id && known?.has(id))
      if (ids.length === 0) continue
      if (ids.join(' ') !== mark.attrs.ids) {
        out.push(mark.type.create({ ...mark.attrs, ids: ids.join(' ') }))
        continue
      }
    }
    out.push(mark)
  }
  return out
}

/** a pasted fragment with every switched-off kind turned into what it shows */
export function cleanOdtFragment(fragment: Fragment, schema: Schema): Fragment {
  const out: PmNode[] = []
  fragment.forEach((child) => {
    const replacement = replacementOf(child, schema, null)
    if (replacement) {
      replacement.forEach((n) => out.push(n))
      return
    }
    if (child.isLeaf || child.content.size === 0) {
      out.push(child)
      return
    }
    const content = cleanOdtFragment(child.content, schema)
    if (child.type.validContent(content)) out.push(child.copy(content))
    else {
      const filled = child.type.createAndFill(child.attrs, content, child.marks)
      if (filled) out.push(filled)
    }
  })
  return Fragment.from(out)
}

/**
 * A paste into an ODT document (the document editor's transformPasted calls
 * this first): switched-off kinds become what they show. Outside an ODT
 * document the slice comes back unchanged.
 */
export function cleanOdtPaste(slice: Slice, schema: Schema): Slice {
  if (!odtSession()) return slice
  const content = cleanOdtFragment(slice.content, schema)
  return content.eq(slice.content) ? slice : new Slice(content, slice.openStart, slice.openEnd)
}

/** the fix-up transaction for switched-off content that landed in `ranges`, or null */
function sanitizeRanges(
  state: EditorState,
  ranges: readonly Range[],
  s: OdtSession,
): Transaction | null {
  const { doc, schema } = state
  const size = doc.content.size
  const fixes = new Map<number, { to: number; fragment: Fragment }>()
  for (const [a, b] of ranges) {
    const from = Math.max(0, Math.min(a, b, size))
    const to = Math.min(size, Math.max(a, b))
    if (to <= from) continue
    doc.nodesBetween(from, to, (node, pos, parent) => {
      if (fixes.has(pos)) return false
      const replacement = replacementOf(node, schema, s.commentIds)
      if (!replacement) return true
      let fragment = replacement
      // a cell keeps at least one block
      if (fragment.size === 0 && parent && parent.childCount === 1 && !node.isInline) {
        fragment = Fragment.from(schema.nodes.docParagraph.create())
      }
      fixes.set(pos, { to: pos + node.nodeSize, fragment })
      return false
    })
  }
  if (fixes.size === 0) return null
  const tr = state.tr
  for (const pos of [...fixes.keys()].sort((x, y) => y - x)) {
    const fix = fixes.get(pos)!
    tr.replaceWith(pos, fix.to, fix.fragment)
  }
  return tr.docChanged ? tr : null
}

// ---- the plugin ----

interface GuardState {
  locks: CellLock[]
  /** `odt-keep` classes, mapped and rescanned where the document changed */
  keeps: DecorationSet
  decorations: DecorationSet
}

const EMPTY_STATE: GuardState = {
  locks: [],
  keeps: DecorationSet.empty,
  decorations: DecorationSet.empty,
}

function withDecorations(doc: PmNode, locks: CellLock[], keeps: DecorationSet): GuardState {
  const decorations = DecorationSet.create(doc, [...lockDecorations(doc, locks), ...keeps.find()])
  return { locks, keeps, decorations }
}

export const odtGuardKey = new PluginKey<GuardState>('odtGuard')

function lockDecorations(doc: PmNode, locks: readonly CellLock[]): Decoration[] {
  const decos: Decoration[] = []
  const tip = t('appOdtProtectedCellTip')
  for (const lock of locks) {
    if (lock.ref.path.length > 0) continue
    const node = doc.nodeAt(lock.pos)
    if (!node) continue
    decos.push(
      Decoration.node(lock.pos, lock.pos + node.nodeSize, {
        class: 'odt-protected-cell',
        'data-odt-protected-cell': '',
        title: tip,
      }),
    )
  }
  return decos
}

/** placeholders in [from, to) get the `odt-keep` class (no resize / move handles) */
function keepDecorations(doc: PmNode, from: number, to: number): Decoration[] {
  const decos: Decoration[] = []
  const size = doc.content.size
  doc.nodesBetween(Math.max(0, from), Math.min(size, to), (node, pos) => {
    if (node.isText) return false
    if (keepOfNode(node))
      decos.push(Decoration.node(pos, pos + node.nodeSize, { class: 'odt-keep' }))
    return true
  })
  return decos
}

function refuse(kind: OdtRefusal): false {
  recordOdtRefusal(kind)
  notifyOdt(kind === 'protectedCell' ? 'appOdtProtectedCell' : 'appOdtLockedObject')
  return false
}

/** may this transaction change the document (protected cells, locked placeholders)? */
function allowed(tr: Transaction, locks: readonly CellLock[]): boolean {
  const ranges = touchedBefore(tr)
  if (ranges.length === 0) return true
  const before = tr.before
  for (const lock of locks) {
    const node = before.nodeAt(lock.pos)
    if (!node) continue
    const end = lock.pos + node.nodeSize
    if (!ranges.some((r) => overlaps(r, lock.pos, end))) continue
    if (lock.ref.path.length === 0) return refuse('protectedCell')
    const mapped = tr.mapping.mapResult(lock.pos, 1)
    const after = mapped.deleted ? null : tr.doc.nodeAt(mapped.pos)
    const was = nestedCellJson(node, lock.ref)
    if (was !== null && was !== nestedCellJson(after, lock.ref)) return refuse('protectedCell')
  }
  const keeps = keepsIn(before, ranges)
  if (keeps.size > 0) {
    const now = keepsByIdIn(tr.doc, new Set(keeps.keys()))
    for (const [id, key] of keeps) {
      const present = now.get(id)
      // deleted whole: fine; still there: unchanged
      if (present && !present.includes(key)) return refuse('lockedObject')
    }
  }
  return true
}

/** nested locked cells: their own <td> in the nested table's node view */
function markNestedCells(view: EditorView, locks: readonly CellLock[]): void {
  const tip = t('appOdtProtectedCellTip')
  for (const lock of locks) {
    if (lock.ref.path.length !== 1) continue
    const host = view.state.doc.nodeAt(lock.pos)
    if (!host) continue
    let seen = -1
    let nestedPos = -1
    host.forEach((child, offset) => {
      if (child.type.name !== 'docNestedTable') return
      seen++
      if (seen === lock.ref.path[0].index) nestedPos = lock.pos + 1 + offset
    })
    if (nestedPos < 0) continue
    const model = view.state.doc.nodeAt(nestedPos)?.attrs.model as TableModel | null
    const dom = view.nodeDOM(nestedPos) as HTMLElement | null
    const root = dom?.querySelector?.('table')
    if (!model || !root) continue
    // the node view's own cells, in model order without vertical-merge continuations
    let flat = 0
    let index = -1
    model.rows.forEach((row, r) =>
      row.forEach((cell, c) => {
        if (cell.vMerge === 'continue') return
        if (r === lock.ref.row && c === lock.ref.tc) index = flat
        flat++
      }),
    )
    const tds = Array.from(root.querySelectorAll('td')).filter((td) => td.closest('table') === root)
    const td = tds[index]
    if (!td || td.hasAttribute('data-odt-protected-cell')) continue
    td.setAttribute('contenteditable', 'false')
    td.setAttribute('data-odt-protected-cell', '')
    td.setAttribute('title', tip)
  }
}

export const OdtGuardExtension = Extension.create({
  name: 'odtGuard',
  addProseMirrorPlugins() {
    return [
      new Plugin<GuardState>({
        key: odtGuardKey,
        state: {
          init: (_config, state) => {
            const s = odtSession()
            if (!s) return EMPTY_STATE
            const locks = s.bridgeIndexes ? identifyByBridge(state.doc, s) : []
            const keeps = DecorationSet.create(
              state.doc,
              keepDecorations(state.doc, 0, state.doc.content.size),
            )
            return withDecorations(state.doc, locks, keeps)
          },
          apply: (tr, value, oldState, newState) => {
            const s = odtSession()
            if (!s) return value === EMPTY_STATE ? value : EMPTY_STATE
            const refresh = tr.getMeta(odtGuardKey) === true
            if (!tr.docChanged && !refresh) return value
            const doc = newState.doc
            if (isLoad(tr) || refresh) {
              const locks = s.bridgeIndexes
                ? identifyByBridge(doc, s)
                : carryLocks(oldState.doc, doc, value.locks)
              const keeps = DecorationSet.create(doc, keepDecorations(doc, 0, doc.content.size))
              return withDecorations(doc, locks, keeps)
            }
            const locks: CellLock[] = []
            for (const lock of value.locks) {
              const mapped = tr.mapping.mapResult(lock.pos, 1)
              if (mapped.deleted) continue
              const node = doc.nodeAt(mapped.pos)
              if (
                node &&
                (node.type.name === 'docTableCell' || node.type.name === 'docTableHeader')
              )
                locks.push({ pos: mapped.pos, ref: lock.ref })
            }
            let keeps = value.keeps.map(tr.mapping, doc)
            for (const [a, b] of changedAfter([tr])) {
              const from = Math.max(0, Math.min(a, b) - 1)
              const to = Math.min(doc.content.size, Math.max(a, b) + 1)
              keeps = keeps.remove(keeps.find(from, to)).add(doc, keepDecorations(doc, from, to))
            }
            return withDecorations(doc, locks, keeps)
          },
        },
        filterTransaction: (tr, state) => {
          if (!odtSession() || !tr.docChanged || isLoad(tr)) return true
          return allowed(tr, odtGuardKey.getState(state)?.locks ?? [])
        },
        appendTransaction: (trs, _oldState, newState) => {
          const s = odtSession()
          if (!s || !trs.some((tr) => tr.docChanged)) return null
          if (trs.some(isLoad)) return null
          return sanitizeRanges(newState, changedAfter(trs), s)
        },
        props: {
          decorations: (state) => odtGuardKey.getState(state)?.decorations ?? null,
          handleDOMEvents: {
            mousedown: (view, event) => {
              if (!odtSession()) return false
              const target = event.target as HTMLElement | null
              if (target?.closest?.('[data-odt-protected-cell]')) notifyOdt('appOdtProtectedCell')
              // a placeholder is selected (to delete it), never dragged or resized
              const keepEl = target?.closest?.('.odt-keep') as HTMLElement | null
              if (!keepEl || event.button !== 0) return false
              let pos = -1
              view.state.doc.descendants((node, p) => {
                if (pos !== -1) return false
                if (view.nodeDOM(p) === keepEl) pos = p
                return pos === -1
              })
              if (pos < 0) return false
              event.preventDefault()
              view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, pos)))
              view.focus()
              return true
            },
          },
        },
        view: (view) => {
          let lastCell = -1
          markNestedCells(view, odtGuardKey.getState(view.state)?.locks ?? [])
          return {
            update: (v, prev) => {
              const locks = odtGuardKey.getState(v.state)?.locks ?? []
              if (v.state.doc !== prev.doc || locks.length > 0) markNestedCells(v, locks)
              if (!odtSession() || v.state.selection.eq(prev.selection)) return
              const at = v.state.selection.from
              const inside = locks.find((lock) => {
                if (lock.ref.path.length > 0) return false
                const node = v.state.doc.nodeAt(lock.pos)
                return !!node && at > lock.pos && at < lock.pos + node.nodeSize
              })
              const cell = inside ? inside.pos : -1
              if (cell !== -1 && cell !== lastCell) notifyOdt('appOdtProtectedCell')
              lastCell = cell
            },
          }
        },
      }),
    ]
  },
})

/** Re-read the locks after the session changed without a content swap (tests, format change). */
export function refreshOdtGuard(view: EditorView): void {
  view.dispatch(view.state.tr.setMeta(odtGuardKey, true))
}
