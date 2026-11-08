/**
 * The editor's wiring of AI highlights (reading-assist spec 4.3, 4.6): one
 * `HighlightSuggestions` per tab over the shell's store channel, read when
 * the open file is ready (reading the store sends nothing), placed on the
 * pages only while the preview is on, kept in step with the editing
 * document's highlights, and the categories (/Subj) of the file's accepted
 * highlights for the annotation panel, read only while the panel is shown.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import type { SaveConfirmations } from '../reading/save-confirmations'
import type { SearchIndex } from '../search'
import { HighlightSuggestions } from './highlight-controller'

const PREVIEW_PREF = 'genoffice-pdf-highlight-preview'

/** the remembered preview switch (default on) */
export function loadHighlightPreview(): boolean {
  try {
    return window.localStorage.getItem(PREVIEW_PREF) !== '0'
  } catch {
    return true
  }
}

export function saveHighlightPreview(on: boolean): void {
  try {
    window.localStorage.setItem(PREVIEW_PREF, on ? '1' : '0')
  } catch {
    // a missing storage only forgets the switch
  }
}

/**
 * The preview switch: the person's remembered choice, and an "on" a finished
 * run turns on for this session only (it never overwrites the choice).
 */
export interface PreviewSwitch {
  saved: boolean
  session: boolean
}

export const previewShown = (s: PreviewSwitch): boolean => s.saved || s.session

/** the view-tab button: the person's choice, remembered */
export function togglePreview(s: PreviewSwitch): PreviewSwitch {
  return previewShown(s) ? { saved: false, session: false } : { saved: true, session: false }
}

/** a run ended: its suggestions are shown now, the remembered choice stays */
export function showPreviewForSession(s: PreviewSwitch): PreviewSwitch {
  return s.session ? s : { ...s, session: true }
}

export function useAiHighlights(o: {
  filePath: string
  password: string | undefined
  /** the document is loaded */
  ready: boolean
  /** the loaded document (a save reloads it) */
  doc: PDFDocumentProxy | null
  searchIndex: () => Promise<SearchIndex> | null
  confirmations: SaveConfirmations
  /** the preview is on */
  preview: boolean
  /** ids of the editing document's unsaved highlights */
  markupIds: readonly string[]
  /** the annotation panel is shown */
  panelOpen: boolean
  /**
   * Bumped when the open file was rewritten in place under the same path (a
   * page operation): the suggestions are read and placed again
   */
  revision?: number
}): { suggestions: HighlightSuggestions; subjects: ReadonlyMap<number, string> } {
  const live = useRef(o)
  live.current = o
  const suggestions = useMemo(
    () =>
      new HighlightSuggestions({
        store: window.pdfApi?.store ?? null,
        file: () => {
          const { filePath, password } = live.current
          return filePath
            ? { path: filePath, ...(password !== undefined ? { password } : {}) }
            : null
        },
        searchIndex: () => live.current.searchIndex(),
        confirmations: o.confirmations,
      }),
    // one per tab: the confirmations instance is the tab's too
    [],
  )

  // reads the store only: opening a document never sends anything
  useEffect(() => {
    if (o.ready && o.filePath) void suggestions.load()
  }, [suggestions, o.ready, o.filePath, o.revision])

  useEffect(() => {
    suggestions.setPlacing(o.preview && o.ready)
  }, [suggestions, o.preview, o.ready])

  const markupKey = o.markupIds.join('\n')
  useEffect(() => {
    suggestions.prune(new Set(markupKey ? markupKey.split('\n') : []))
  }, [suggestions, markupKey])

  // the file's /Subj categories, once per loaded document while the panel is shown
  const [subjects, setSubjects] = useState<{
    doc: PDFDocumentProxy
    map: ReadonlyMap<number, string>
  } | null>(null)
  useEffect(() => {
    const { doc, filePath, panelOpen } = o
    if (!doc || !filePath || !panelOpen || subjects?.doc === doc) return
    const read = window.pdfApi?.annotSubjects
    if (!read) return
    let alive = true
    void read(filePath)
      .then((list) => {
        if (alive) setSubjects({ doc, map: new Map(list.map((s) => [s.objNum, s.subj])) })
      })
      .catch(() => {})
    return () => {
      alive = false
    }
    // per document and panel: `subjects` is read, not a reason to read again
  }, [o.doc, o.filePath, o.panelOpen])

  return {
    suggestions,
    subjects: subjects && subjects.doc === o.doc ? subjects.map : EMPTY_SUBJECTS,
  }
}

const EMPTY_SUBJECTS: ReadonlyMap<number, string> = new Map()
