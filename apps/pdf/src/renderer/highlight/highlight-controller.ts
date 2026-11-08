/**
 * The AI highlight suggestions of the open document (reading-assist spec
 * 4.6): the newest run and its blocks read from the result store, placed on
 * the pages for the preview, dismissed at once in the store, and accepted as
 * highlights whose `accepted` state is written only after the PDF save that
 * contains them succeeded (save-confirmations.ts).
 *
 * Nothing here sends anything: reading the store, the page fingerprints and
 * the viewer's text index is local. One instance per tab; the screen
 * subscribes to `snapshot()` (useSyncExternalStore).
 */
import type {
  HighlightBlockEntry,
  HighlightRun,
} from '../../../../../packages/pdf-structure/src/store/reading'
import type { PdfStoreApi } from '../../shared/ipc'
import type { SaveConfirmations } from '../reading/save-confirmations'
import { blockKeyString } from '../../../../../packages/pdf-structure/src/store/keys'
import type { SearchIndex } from '../search'
import { suggestionKey, suggestionViews, type SuggestionView } from './locate'

export type HighlightStoreApi = Pick<
  PdfStoreApi,
  'docHash' | 'pageFingerprints' | 'latestHighlight' | 'highlightRuns' | 'write'
>

/** the open file as the store channels take it */
export interface HighlightFile {
  path: string
  password?: string
}

export interface HighlightSnapshot {
  docHash: string | null
  /** the newest run (the only one shown), or null */
  run: HighlightRun | null
  blocks: readonly HighlightBlockEntry[]
  /** page fingerprints in original page order; null until read */
  fingerprints: readonly string[] | null
  /** every suggestion of the run with its place; null until placed (preview on) */
  views: readonly SuggestionView[] | null
  /** suggestion key → id of the highlight it became, waiting for a save */
  accepting: ReadonlyMap<string, string>
}

const EMPTY: HighlightSnapshot = {
  docHash: null,
  run: null,
  blocks: [],
  fingerprints: null,
  views: null,
  accepting: new Map(),
}

export class HighlightSuggestions {
  private readonly store: HighlightStoreApi | null
  private readonly file: () => HighlightFile | null
  private readonly searchIndex: () => Promise<SearchIndex> | null
  private readonly confirmations: SaveConfirmations
  private state: HighlightSnapshot = EMPTY
  private readonly listeners = new Set<() => void>()
  private loadSeq = 0
  private placing = false

  constructor(o: {
    store: HighlightStoreApi | null
    file: () => HighlightFile | null
    /** the viewer's text index of the loaded document */
    searchIndex: () => Promise<SearchIndex> | null
    confirmations: SaveConfirmations
  }) {
    this.store = o.store
    this.file = o.file
    this.searchIndex = o.searchIndex
    this.confirmations = o.confirmations
  }

  /** whether the store channel exists (not in a standalone pdf window) */
  get available(): boolean {
    return this.store !== null
  }

  snapshot = (): HighlightSnapshot => this.state

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * Read the open file's newest run and its blocks (and the page
   * fingerprints when it has suggestions). Accepted suggestions whose save
   * already confirmed them are forgotten here; the store now says accepted.
   */
  async load(): Promise<void> {
    const seq = ++this.loadSeq
    const file = this.file()
    const accepting = this.stillAccepting()
    // the places belong to the pages read before: none is shown (or accepted) until placed again
    if (this.state.views || this.state.fingerprints) {
      this.set({ ...this.state, views: null, fingerprints: null, accepting })
    }
    if (!this.store || !file) {
      this.set({ ...EMPTY, accepting })
      return
    }
    const hash = await this.store.docHash(file.path).catch(() => null)
    if (seq !== this.loadSeq) return
    if (!hash?.ok) {
      this.set({ ...EMPTY, accepting })
      return
    }
    const latest = await this.store.latestHighlight(hash.docHash).catch(() => null)
    if (seq !== this.loadSeq) return
    const run = latest?.ok ? latest.run : null
    const blocks = latest?.ok && run ? latest.blocks : []
    this.set({ ...EMPTY, docHash: hash.docHash, run, blocks, accepting })
    if (!run || !blocks.some((b) => b.suggestions.length > 0)) return
    const fps = await this.store
      .pageFingerprints({
        path: file.path,
        ...(file.password !== undefined ? { password: file.password } : {}),
      })
      .catch(() => null)
    if (seq !== this.loadSeq || !fps?.ok) return
    this.set({ ...this.state, fingerprints: fps.fingerprints })
    if (this.placing) await this.place()
  }

  /** the preview went on (place the suggestions) or off */
  setPlacing(on: boolean): void {
    this.placing = on
    if (on && !this.state.views) void this.place()
  }

  /** put every suggestion on its page with the viewer's text index */
  async place(): Promise<void> {
    const { run, blocks, fingerprints } = this.state
    if (!run || !fingerprints) return
    const seq = this.loadSeq
    const index = await (this.searchIndex() ?? Promise.resolve(null)).catch(() => null)
    if (seq !== this.loadSeq || this.state.run !== run) return
    this.set({ ...this.state, views: suggestionViews(run, blocks, fingerprints, index) })
  }

  /** suggestions still to decide: pending in the store, not accepted in this session */
  pending(): SuggestionView[] {
    const { views, accepting } = this.state
    return (views ?? []).filter((v) => v.state === 'pending' && !accepting.has(v.key))
  }

  /** "Dismiss": written to the store at once (the file is not involved); false when it failed */
  async dismiss(views: readonly SuggestionView[]): Promise<boolean> {
    const { run, docHash } = this.state
    if (!this.store || !run || !docHash || views.length === 0) return false
    const byBlock = new Map<string, { view: SuggestionView; ids: string[] }>()
    for (const v of views) {
      const k = blockKeyString(v.blockKey)
      const entry = byBlock.get(k) ?? { view: v, ids: [] }
      entry.ids.push(v.id)
      byBlock.set(k, entry)
    }
    let ok = true
    const done = new Set<string>()
    for (const { view, ids } of byBlock.values()) {
      const out = await this.store
        .write({
          kind: 'highlightSuggestionStates',
          docHash,
          runId: run.runId,
          key: view.blockKey,
          states: Object.fromEntries(ids.map((id) => [id, 'dismissed' as const])),
        })
        .catch(() => null)
      if (!out?.ok) {
        ok = false
        continue
      }
      for (const id of ids) done.add(suggestionKey(view.blockKey, id))
    }
    if (this.state.run !== run || done.size === 0) return ok
    this.set({
      ...this.state,
      blocks: this.state.blocks.map((b) => ({
        ...b,
        suggestions: b.suggestions.map((s) =>
          done.has(suggestionKey(b.key, s.id)) ? { ...s, state: 'dismissed' as const } : s,
        ),
      })),
      views:
        this.state.views?.map((v) =>
          done.has(v.key) ? { ...v, state: 'dismissed' as const } : v,
        ) ?? null,
    })
    return ok
  }

  /**
   * "Accept": `add` puts a highlight in the editing document and answers its
   * id (null when it could not). Each one waits for a save that writes it;
   * then `accepted` is written under the saved file's hash. Suggestions with
   * no place are skipped. Answers how many were accepted.
   */
  accept(views: readonly SuggestionView[], add: (view: SuggestionView) => string | null): number {
    const { run } = this.state
    if (!this.store || !run) return 0
    const store = this.store
    const accepting = new Map(this.state.accepting)
    let count = 0
    for (const view of views) {
      if (!view.found || view.state !== 'pending' || accepting.has(view.key)) continue
      const markupId = add(view)
      if (!markupId) continue
      accepting.set(view.key, markupId)
      count++
      this.confirmations.register(markupId, async (docHash) => {
        const out = await store.write({
          kind: 'highlightSuggestionStates',
          docHash,
          runId: run.runId,
          key: view.blockKey,
          states: { [view.id]: 'accepted' },
        })
        if (!out.ok) throw new Error(out.message ?? out.error)
      })
    }
    if (count > 0) this.set({ ...this.state, accepting })
    return count
  }

  /**
   * The editing document's highlights now: an accepted suggestion whose
   * highlight was removed again (undo, delete) before any save goes back to
   * pending, and its confirmation is dropped. A highlight a successful save
   * wrote (held) left the editing document for the file: it keeps waiting.
   */
  prune(liveMarkupIds: ReadonlySet<string>): void {
    let changed = false
    const accepting = new Map(this.state.accepting)
    for (const [key, markupId] of accepting) {
      if (liveMarkupIds.has(markupId) || !this.confirmations.isPending(markupId)) continue
      if (this.confirmations.isHeld(markupId)) continue
      this.confirmations.cancel(markupId)
      accepting.delete(key)
      changed = true
    }
    if (changed) this.set({ ...this.state, accepting })
  }

  /** every readable run of the document, newest first (the start window asks about old ones) */
  async runs(): Promise<HighlightRun[]> {
    const docHash = this.state.docHash ?? (await this.freshDocHash())
    if (!this.store || !docHash) return []
    const out = await this.store.highlightRuns(docHash).catch(() => null)
    return out?.ok ? out.runs : []
  }

  /** the open file's document hash as the store computes it now */
  async freshDocHash(): Promise<string | null> {
    const file = this.file()
    if (!this.store || !file) return null
    const out = await this.store.docHash(file.path).catch(() => null)
    return out?.ok ? out.docHash : null
  }

  /** accepted suggestions whose highlight still waits for a save */
  private stillAccepting(): Map<string, string> {
    return new Map(
      [...this.state.accepting].filter(([, markupId]) => this.confirmations.isPending(markupId)),
    )
  }

  private set(next: HighlightSnapshot): void {
    this.state = next
    for (const listener of [...this.listeners]) listener()
  }
}
