/**
 * The annotation panel as the editor mounts it (reading-assist spec 4.3):
 * reads the open document's saved annotations once per loaded document (only
 * while the panel is shown; nothing is sent anywhere), the text under unsaved
 * markups, and the passage cards, and builds the list the panel shows.
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import type { LocalMarkup, PageGeom } from '../annotations'
import type { LocalDrawing } from '../DrawLayer'
import type { LocalAnnotDelete, LocalNoteEdit } from '../edit-state'
import type { PassageCards } from '../reading/passage-controller'
import { AnnotPanel, type AnnotPanelProps } from './AnnotPanel'
import { shellHostOnce } from './host-capability'
import {
  buildAnnotItems,
  type AnnotItemDraft,
  type SavedAnnotScan,
  type SavedMarkupRecord,
} from './items'
import { loadPageTextRuns, scanDocumentAnnots } from './scan'
import type { TextRun } from './text-under'

/** one scan per loaded document; a save reloads the document and so scans again */
const scans = new WeakMap<PDFDocumentProxy, Promise<SavedAnnotScan>>()
const pageTexts = new WeakMap<PDFDocumentProxy, Map<number, Promise<TextRun[]>>>()

function scanOnce(doc: PDFDocumentProxy): Promise<SavedAnnotScan> {
  let scan = scans.get(doc)
  if (!scan) {
    scan = scanDocumentAnnots(doc)
    scans.set(doc, scan)
  }
  return scan
}

function pageTextOnce(doc: PDFDocumentProxy, origIdx: number): Promise<TextRun[]> {
  let byPage = pageTexts.get(doc)
  if (!byPage) pageTexts.set(doc, (byPage = new Map()))
  let text = byPage.get(origIdx)
  if (!text) {
    text = loadPageTextRuns(doc, origIdx)
    byPage.set(origIdx, text)
  }
  return text
}

const EMPTY_SCAN: SavedAnnotScan = { markups: [], notes: [], others: [] }

export interface AnnotPanelHostProps extends Omit<AnnotPanelProps, 'items' | 'loading'> {
  doc: PDFDocumentProxy | null
  unsavedMarkups: readonly LocalMarkup[]
  /** the session's drawings; their notes are the unsaved notes */
  drawings: readonly LocalDrawing[]
  annotDeletes: readonly LocalAnnotDelete[]
  noteEdits: readonly LocalNoteEdit[]
  cards: PassageCards
  /** 1-based shown page of an original page; null when deleted */
  displayPage: (origIdx: number) => number | null
  geomOf?: (origIdx: number) => PageGeom
  languageName: (code: string) => string
  /** items from other features (e.g. AI highlight suggestions while previewed) */
  extraItems?: readonly AnnotItemDraft[]
  /** a saved markup's category (e.g. an accepted AI highlight's /Subj) */
  categoryOf?: (markup: SavedMarkupRecord) => string | undefined
  /** whether this window runs inside the shell; defaults to probing the store channel */
  probeShellHost?: () => Promise<boolean>
}

export function AnnotPanelHost(props: AnnotPanelHostProps) {
  const { doc, unsavedMarkups } = props
  const [scan, setScan] = useState<{ doc: PDFDocumentProxy; data: SavedAnnotScan } | null>(null)
  const [texts, setTexts] = useState<{ doc: PDFDocumentProxy; map: Map<number, TextRun[]> } | null>(
    null,
  )

  useEffect(() => {
    if (!doc) return
    let live = true
    void scanOnce(doc).then((data) => {
      if (live) setScan({ doc, data })
    })
    return () => {
      live = false
    }
  }, [doc])

  // the text under unsaved markups, read once per page
  const markupPages = useMemo(
    () => [...new Set(unsavedMarkups.map((m) => m.pageIndex))].sort((a, b) => a - b).join(','),
    [unsavedMarkups],
  )
  useEffect(() => {
    if (!doc || !markupPages) return
    let live = true
    const pages = markupPages.split(',').map(Number)
    void Promise.all(
      pages.map((p) => pageTextOnce(doc, p).then((runs) => [p, runs] as const)),
    ).then((entries) => {
      if (!live) return
      setTexts((prev) => {
        const map = new Map(prev && prev.doc === doc ? prev.map : [])
        for (const [p, runs] of entries) map.set(p, runs)
        return { doc, map }
      })
    })
    return () => {
      live = false
    }
  }, [doc, markupPages])

  // a Word document needs the shell; a standalone window shows why up front
  const [shellHost, setShellHost] = useState<boolean | null>(null)
  const probe = props.probeShellHost ?? shellHostOnce
  useEffect(() => {
    let live = true
    void probe().then((inShell) => {
      if (live) setShellHost(inShell)
    })
    return () => {
      live = false
    }
  }, [probe])

  const cardSnap = useSyncExternalStore(props.cards.subscribe, props.cards.snapshot)
  const saved = scan && scan.doc === doc ? scan.data : null

  const items = buildAnnotItems({
    saved: saved ?? EMPTY_SCAN,
    unsavedMarkups,
    pendingNotes: props.drawings.flatMap((d) =>
      d.input.kind === 'note' ? [{ id: d.id, input: d.input }] : [],
    ),
    deletedObjNums: new Set(props.annotDeletes.map((d) => d.annot.objNum)),
    editedNotes: new Map(props.noteEdits.map((e) => [e.annot.objNum, e.contents])),
    pageTexts: texts && texts.doc === doc ? texts.map : new Map(),
    cards: cardSnap.cards,
    cardPage: (c) => props.cards.pageOf(c),
    cardsLocated: cardSnap.fingerprints !== null || cardSnap.cards.length === 0,
    displayPage: props.displayPage,
    geomOf: props.geomOf,
    t: props.t,
    languageName: props.languageName,
    extra: props.extraItems,
    categoryOf: props.categoryOf,
  })

  const {
    doc: _doc,
    unsavedMarkups: _m,
    drawings: _d,
    annotDeletes: _a,
    noteEdits: _n,
    cards: _c,
    displayPage: _p,
    geomOf: _g,
    languageName: _l,
    extraItems: _x,
    categoryOf: _cat,
    probeShellHost: _probe,
    ...panel
  } = props
  return (
    <AnnotPanel
      {...panel}
      items={items}
      loading={doc !== null && saved === null}
      docxAvailable={shellHost}
    />
  )
}
