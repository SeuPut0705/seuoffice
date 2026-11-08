/**
 * AI edit review (seuoffice): the state of one AI request's held edits, seen from the panel.
 *
 * The AI edits the live deck while it runs. When the request ends, the main process takes
 * those edits back out of the deck (snapshot history) and keeps them; the panel shows them
 * as a proposal the person accepts or rejects. The main process owns the snapshots and the
 * staleness check; this module owns the transitions and the preview, over an injected backend.
 */
import type { RenderSlide } from '@genoffice/pptx-render'
import type { SlidesApi } from '../../shared/ipc'

export interface ProposalBackend {
  /** Take the finished run's edits out of the deck: the pre-run deck, or null when nothing was held. */
  hold(): Promise<RenderSlide[] | null>
  /** Re-apply the held edits unless the deck changed since the revert (null: refused). */
  accept(): Promise<{ slides: RenderSlide[]; snapshotId: number } | null>
  reject(): Promise<unknown>
}

export function slidesApiBackend(
  api: Pick<SlidesApi, 'aiRunHold' | 'aiProposalAccept' | 'aiProposalReject'>,
): ProposalBackend {
  return {
    hold: () => api.aiRunHold(),
    accept: () => api.aiProposalAccept(),
    reject: () => api.aiProposalReject(),
  }
}

/** One slide the run touched; a missing side means the run added or removed that slide. */
export interface SlideChange {
  key: string
  /** 1-based position: in the run's result, or in the pre-run deck for a removed slide */
  position: number
  before?: RenderSlide
  after?: RenderSlide
}

interface Held {
  /** The deck as it is now (before the run) and as the run left it */
  before: RenderSlide[]
  after: RenderSlide[]
  changes: SlideChange[]
}

export type ProposalState =
  { kind: 'none' } | ({ kind: 'pending' } & Held) | ({ kind: 'stale' } & Held)

export const NO_PROPOSAL: ProposalState = { kind: 'none' }

const slideKey = (slide: RenderSlide, index: number): string => slide.partPath ?? `#${index}`

/** The slides that differ between two decks, matched by part path and compared by content. */
export function changedSlides(before: RenderSlide[], after: RenderSlide[]): SlideChange[] {
  const beforeByKey = new Map(before.map((s, i) => [slideKey(s, i), s]))
  const changes: SlideChange[] = []
  const seen = new Set<string>()
  after.forEach((slide, i) => {
    const key = slideKey(slide, i)
    seen.add(key)
    const old = beforeByKey.get(key)
    if (!old) changes.push({ key, position: i + 1, after: slide })
    else if (JSON.stringify(old) !== JSON.stringify(slide)) {
      changes.push({ key, position: i + 1, before: old, after: slide })
    }
  })
  before.forEach((slide, i) => {
    const key = slideKey(slide, i)
    if (!seen.has(key)) changes.push({ key, position: i + 1, before: slide })
  })
  return changes
}

/**
 * Run end. `live` is the deck as the run left it (the editor's current slides). When the
 * run changed the deck, the backend reverts it: `deck` is what the editor must show now.
 */
export async function holdRun(
  backend: ProposalBackend,
  live: RenderSlide[],
): Promise<{ state: ProposalState; deck: RenderSlide[] | null }> {
  const before = await backend.hold()
  if (!before) return { state: NO_PROPOSAL, deck: null }
  return {
    state: { kind: 'pending', before, after: live, changes: changedSlides(before, live) },
    deck: before,
  }
}

/**
 * Accept. `deck` is the deck to show afterwards (null: unchanged) and `snapshotId` the AI
 * rollback point of the reply's undo control. A refused accept leaves the deck alone and
 * marks the proposal stale; it stays on screen until the person dismisses it.
 */
export async function accept(
  state: ProposalState,
  backend: ProposalBackend,
): Promise<{ state: ProposalState; deck: RenderSlide[] | null; snapshotId: number | null }> {
  if (state.kind !== 'pending') return { state, deck: null, snapshotId: null }
  const accepted = await backend.accept()
  if (!accepted) return { state: { ...state, kind: 'stale' }, deck: null, snapshotId: null }
  return { state: NO_PROPOSAL, deck: accepted.slides, snapshotId: accepted.snapshotId }
}

/** Reject (or dismiss a stale proposal): the held edits are dropped, the deck stays as it is. */
export async function reject(
  state: ProposalState,
  backend: ProposalBackend,
): Promise<ProposalState> {
  if (state.kind === 'none') return state
  await backend.reject()
  return NO_PROPOSAL
}
