/**
 * The passage cards of the open document (reading-assist spec 4.2, 5.2): read
 * from the result store when the document opens, found again on their pages by
 * page fingerprint, made by one model call, overwritten by "Regenerate",
 * deleted from the store only, and confirmed as kept notes after a save.
 *
 * Nothing here sends by itself: `generate` and `regenerate` run only when the
 * screen calls them after a person's action and the send gate. Opening the
 * document reads the store (and the page fingerprints only when a card exists).
 *
 * The screen side subscribes to `snapshot()` (useSyncExternalStore); the
 * annotation panel reads the same instance: `list()`, `pageOf(card)`.
 */
import type { AgentStreamRequest } from '@genoffice/agent-core'
import type {
  PassageCard,
  PassageCardInput,
} from '../../../../../packages/pdf-structure/src/store/reading'
import type { PdfStoreApi } from '../../shared/ipc'
import { passageTargetKey, sameCard, type PassageTarget } from './passage-cards'
import { passageAnswer, passageRequest, type PassageKind } from './passage-prompt'
import { passageContext, passageHash } from './passage-text'

export type PassageStoreApi = Pick<
  PdfStoreApi,
  'docHash' | 'passages' | 'pageFingerprints' | 'write'
>

/** the open file as the store channels take it */
export interface PassageFile {
  path: string
  password?: string
}

/** what a card is made from: the selection on one page and the page's text */
export interface PassageSource {
  /** original page index (0-based) of the passage */
  origIdx: number
  /** the passage on that page, PDF user space */
  quads: number[][]
  excerpt: string
  /** that page's text as the text layer reads it */
  pageText: string
  /** document title, '' when none */
  title: string
}

/** a request ready to send: the card to make (or overwrite) and its source */
export interface PreparedPassage {
  target: PassageTarget
  source: PassageSource
  /** 1-based original page */
  page: number
  /** set when the request overwrites a card ("Regenerate") */
  id?: string
}

/** one tool-less model call: the answer and who gave it */
export type PassageAsk = (
  request: AgentStreamRequest,
  signal: AbortSignal,
) => Promise<{ text: string; provider: string; model: string }>

export interface PassageSnapshot {
  docHash: string | null
  cards: readonly PassageCard[]
  /** page fingerprints in original page order; null until read */
  fingerprints: readonly string[] | null
}

const EMPTY: PassageSnapshot = { docHash: null, cards: [], fingerprints: null }

const randomId = (): string =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID().replace(/-/g, '')
    : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`

const stripSavedAt = ({ savedAt: _savedAt, ...rest }: PassageCard): PassageCardInput => rest

export class PassageCards {
  private readonly store: PassageStoreApi | null
  private readonly file: () => PassageFile | null
  private readonly now: () => number
  private readonly newId: () => string
  private readonly uiLang: () => string
  private state: PassageSnapshot = EMPTY
  private readonly listeners = new Set<() => void>()
  private loadSeq = 0
  private fingerprintsLoad: Promise<readonly string[] | null> | null = null
  /** the fingerprints in the snapshot were read for this load (not kept from the one before) */
  private fingerprintsFresh = false
  /** requests whose model call is in flight, by passageTargetKey */
  private readonly inFlight = new Set<string>()

  constructor(o: {
    store: PassageStoreApi | null
    file: () => PassageFile | null
    now?: () => number
    newId?: () => string
    /** the language an explanation is written in (the UI language) */
    uiLang?: () => string
  }) {
    this.store = o.store
    this.file = o.file
    this.now = o.now ?? Date.now
    this.newId = o.newId ?? randomId
    this.uiLang = o.uiLang ?? (() => 'en')
  }

  /** whether the store channel exists (not in a standalone pdf window) */
  get available(): boolean {
    return this.store !== null
  }

  get docHash(): string | null {
    return this.state.docHash
  }

  snapshot = (): PassageSnapshot => this.state

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  list(): readonly PassageCard[] {
    return this.state.cards
  }

  get(id: string): PassageCard | undefined {
    return this.state.cards.find((c) => c.id === id)
  }

  /**
   * The card's page as an original page index of the open document, found by
   * page fingerprint (the nearest match to its stored page when pages repeat);
   * null when no page has that fingerprint (the page changed or was removed)
   * or the fingerprints are not read yet.
   */
  pageOf(card: Pick<PassageCard, 'pageFingerprint' | 'page'>): number | null {
    const fps = this.state.fingerprints
    if (!fps) return null
    let best: number | null = null
    for (let i = 0; i < fps.length; i++) {
      if (fps[i] !== card.pageFingerprint) continue
      if (best === null || Math.abs(i - (card.page - 1)) < Math.abs(best - (card.page - 1)))
        best = i
    }
    return best
  }

  /**
   * Read the open file's document hash and its cards; the page fingerprints
   * too when there is a card. False when there is no store or no file.
   *
   * By default the pages found before may have moved (a page operation), so
   * no card is placed until they are read again. `keepPlaces` (a save that
   * kept every page where it was) leaves the cards where they are until the
   * new fingerprints arrive, so their marks do not flicker; a request still
   * waits for the new ones.
   */
  async load(o: { keepPlaces?: boolean } = {}): Promise<boolean> {
    const seq = ++this.loadSeq
    this.fingerprintsLoad = null
    this.fingerprintsFresh = false
    if (!o.keepPlaces && this.state.fingerprints) this.set({ ...this.state, fingerprints: null })
    const file = this.file()
    if (!this.store || !file) {
      this.set(EMPTY)
      return false
    }
    const hash = await this.store.docHash(file.path).catch(() => null)
    if (seq !== this.loadSeq) return false
    if (!hash?.ok) {
      this.set(EMPTY)
      return false
    }
    const read = await this.store.passages(hash.docHash).catch(() => null)
    if (seq !== this.loadSeq) return false
    // the fingerprints now: null, kept from before (keepPlaces), or already read for this load
    this.set({
      docHash: hash.docHash,
      cards: read?.ok ? read.cards : [],
      fingerprints: this.state.fingerprints,
    })
    if (this.state.cards.length > 0) await this.fingerprints()
    return seq === this.loadSeq
  }

  /** the open file's document hash as the store computes it now (after a save: the new one) */
  async freshDocHash(): Promise<string | null> {
    const file = this.file()
    if (!this.store || !file) return null
    const out = await this.store.docHash(file.path).catch(() => null)
    return out?.ok ? out.docHash : null
  }

  /** the open file's page fingerprints, read once per load */
  private fingerprints(): Promise<readonly string[] | null> {
    if (this.fingerprintsFresh && this.state.fingerprints) {
      return Promise.resolve(this.state.fingerprints)
    }
    const file = this.file()
    if (!this.store || !file) return Promise.resolve(null)
    const seq = this.loadSeq
    this.fingerprintsLoad ??= this.store
      .pageFingerprints({
        path: file.path,
        ...(file.password !== undefined ? { password: file.password } : {}),
      })
      .catch(() => null)
      .then((out) => {
        if (!out?.ok || seq !== this.loadSeq) {
          if (seq === this.loadSeq) this.fingerprintsLoad = null
          return null
        }
        this.fingerprintsFresh = true
        this.set({ ...this.state, docHash: out.docHash, fingerprints: out.fingerprints })
        return out.fingerprints
      })
    return this.fingerprintsLoad
  }

  /** the key of the request a target names (what a pending answer is found by) */
  targetKey(target: PassageTarget): string {
    return passageTargetKey(target)
  }

  /**
   * The card to open or the request to send for a passage: the key of the
   * same request when its answer is still coming (a first answer, or
   * "Regenerate" over the stored card: nothing is sent, and the old card is
   * not shown as if it were the answer), the stored card of the same passage
   * when there is one (nothing is sent then either), else a prepared request.
   * Null when the store or the page cannot be read.
   */
  async prepare(
    kind: PassageKind,
    lang: string | undefined,
    source: PassageSource,
  ): Promise<{ existing: PassageCard } | { pending: string } | PreparedPassage | null> {
    if (!this.store || !this.state.docHash) return null
    const fps = await this.fingerprints()
    const pageFingerprint = fps?.[source.origIdx]
    if (!pageFingerprint) return null
    const target: PassageTarget = {
      pageFingerprint,
      passageHash: passageHash(source.excerpt),
      kind,
      ...(kind === 'translate' && lang ? { lang } : {}),
    }
    const key = passageTargetKey(target)
    if (this.inFlight.has(key)) return { pending: key }
    const existing = sameCard(this.state.cards, target)
    if (existing) return { existing }
    return { target, source, page: source.origIdx + 1 }
  }

  /**
   * Ask once and store the card (a new one, or the one `prepared.id` names).
   * While the answer is coming the request is in flight: `prepare` finds it
   * pending instead of preparing it again.
   */
  async generate(
    prepared: PreparedPassage,
    ask: PassageAsk,
    signal: AbortSignal,
  ): Promise<PassageCard> {
    const key = passageTargetKey(prepared.target)
    this.inFlight.add(key)
    try {
      return await this.askAndStore(prepared, ask, signal)
    } finally {
      this.inFlight.delete(key)
    }
  }

  private async askAndStore(
    prepared: PreparedPassage,
    ask: PassageAsk,
    signal: AbortSignal,
  ): Promise<PassageCard> {
    const { target, source } = prepared
    if (!this.store || !this.state.docHash) throw new Error('the result store is not available')
    const store = this.store
    const context = passageContext(source.pageText, source.excerpt)
    const reply = await ask(
      passageRequest({
        kind: target.kind,
        excerpt: source.excerpt,
        before: context.before,
        after: context.after,
        title: source.title,
        answerLanguage: target.kind === 'translate' ? (target.lang ?? 'en') : this.uiLang(),
      }),
      signal,
    )
    if (signal.aborted) throw signal.reason ?? new DOMException('stopped', 'AbortError')
    const text = passageAnswer(reply.text)
    if (!text) throw new Error('the answer was empty')
    const input: PassageCardInput = {
      id: prepared.id ?? this.newId(),
      kind: target.kind,
      page: prepared.page,
      pageFingerprint: target.pageFingerprint,
      quads: source.quads.map((q) => [...q]),
      excerpt: source.excerpt,
      passageHash: target.passageHash,
      ...(target.kind === 'translate' && target.lang ? { lang: target.lang } : {}),
      text,
      provider: reply.provider,
      model: reply.model,
      createdAt: this.now(),
    }
    // the file's hash now, not the one before the call: a save during the call
    // moved the store to the saved file's hash, and the card belongs there
    const hash = (await this.freshDocHash()) ?? this.state.docHash
    if (!hash) throw new Error('the result store is not available')
    const out = await store.write({ kind: 'passage', docHash: hash, card: input })
    if (!out.ok) throw new Error(out.message ?? out.error)
    const saved: PassageCard = { ...input, savedAt: this.now() }
    this.set({
      ...this.state,
      cards: [...this.state.cards.filter((c) => c.id !== saved.id), saved],
    })
    // the screen still reads the hash before that save: read the saved file's cards
    if (hash !== this.state.docHash) void this.load()
    return saved
  }

  /** "Regenerate": ask again for a stored card and overwrite it */
  async regenerate(
    id: string,
    source: PassageSource,
    ask: PassageAsk,
    signal: AbortSignal,
  ): Promise<PassageCard> {
    const card = this.get(id)
    if (!card) throw new Error('the card is gone')
    return this.generate(
      {
        target: {
          pageFingerprint: card.pageFingerprint,
          passageHash: card.passageHash,
          kind: card.kind,
          ...(card.lang ? { lang: card.lang } : {}),
        },
        source: { ...source, quads: card.quads, excerpt: card.excerpt },
        page: card.page,
        id,
      },
      ask,
      signal,
    )
  }

  /** delete a card from the store; a note it left in the document stays */
  async remove(id: string): Promise<boolean> {
    const hash = this.state.docHash
    if (!this.store || !hash) return false
    const out = await this.store
      .write({ kind: 'deletePassage', docHash: hash, id })
      .catch(() => null)
    if (!out?.ok) return false
    this.set({ ...this.state, cards: this.state.cards.filter((c) => c.id !== id) })
    return true
  }

  /** a save wrote the card's note: record it under the saved file's hash */
  async confirmNote(id: string, docHash: string): Promise<void> {
    const card = this.get(id)
    if (!this.store || !card) return
    const confirmed: PassageCardInput = { ...stripSavedAt(card), savedAsNote: true }
    const out = await this.store.write({ kind: 'passage', docHash, card: confirmed })
    if (!out.ok) throw new Error(out.message ?? out.error)
    this.set({
      ...this.state,
      cards: this.state.cards.map((c) => (c.id === id ? { ...c, savedAsNote: true } : c)),
    })
  }

  private set(next: PassageSnapshot): void {
    this.state = next
    for (const listener of [...this.listeners]) listener()
  }
}
