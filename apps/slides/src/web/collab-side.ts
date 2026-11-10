/**
 * The page side of co-editing a deck: the adapter over the page's session, and the bridge
 * members that send a person's edits through it. Only the edits the web build supports are
 * synced (text, slides added and deleted, notes); every other edit is refused with a message,
 * as are undo, redo and AI edits, which restore or hold whole deck snapshots no other page has.
 */
import { slideDurableId } from '@genoffice/pptx-engine'
import { webLanguage } from '@seuoffice/web-platform'
import type { CollabAdapter } from '@seuoffice/collab/client'
import { showToast } from '../renderer/components/toast-bus'
import { buildSlideUpdate, rebuildSlide } from '../main/session-state'
import type { SlideUpdate, SlidesApi } from '../shared/ipc'
import {
  createSlidesCollab,
  drawnOf,
  redrawFrom,
  slideEdit,
  textEdit,
  type Drawn,
} from './collab-adapter'
import { slideIdAt, slideIndexOf, type SlidesEdit, type SlidesOp } from './collab-ops'
import { currentSession, forPage, renderDeck } from './session'

/** What the renderer hands over once the co-edited deck is on screen */
export interface SlidesCollabHandles {
  /** the path of the deck the renderer shows */
  path: string
}

type Notice = 'frozen' | 'gone' | 'target' | 'history' | 'ai' | 'blocked' | 'viewOnly'

const NOTICES: Record<'ko' | 'en', Record<Notice, string>> = {
  ko: {
    frozen: '지금은 고칠 수 없습니다. 저장하는 중이거나 함께 편집이 멈췄습니다.',
    gone: '다른 사람이 지운 슬라이드나 개체에 한 편집은 반영되지 않았습니다.',
    target: '이 텍스트 상자를 찾지 못해 편집이 반영되지 않았습니다.',
    history: '함께 편집하는 동안에는 실행 취소와 다시 실행을 쓸 수 없습니다.',
    ai: '함께 편집하는 동안에는 AI가 프레젠테이션을 고칠 수 없습니다.',
    blocked:
      '함께 편집하는 동안에는 이 편집을 쓸 수 없습니다. 글자, 슬라이드 추가와 삭제, 슬라이드 노트만 고칠 수 있습니다.',
    viewOnly: '이 프레젠테이션은 보기만 할 수 있습니다.',
  },
  en: {
    frozen:
      'The presentation cannot be edited right now: it is being saved, or co-editing stopped.',
    gone: 'An edit to a slide or object someone else deleted was not kept.',
    target: 'This text box could not be found, so the edit was not kept.',
    history: 'Undo and redo are not available while editing together.',
    ai: 'AI cannot edit the presentation while editing together.',
    blocked:
      'This edit is not available while editing together. You can change text, add and delete slides, and write speaker notes.',
    viewOnly: 'This presentation is view only.',
  },
}

/** A refusal is explained once per burst of attempts, not on every drag frame */
const NOTICE_GAP_MS = 3000
const lastShown = new Map<Notice, number>()

function notice(kind: Notice): void {
  const now = Date.now()
  if (now - (lastShown.get(kind) ?? -Infinity) < NOTICE_GAP_MS) return
  lastShown.set(kind, now)
  const lang = webLanguage().startsWith('ko') ? 'ko' : 'en'
  showToast(NOTICES[lang][kind], 'error')
}

/** Copying reads the deck; it is not an edit to refuse */
const READS: Partial<Record<keyof SlidesApi, true>> = {
  copyElements: true,
  copyElementsImage: true,
  copySlides: true,
  clipboardExternal: true,
  nativeClipboard: true,
}

/** What the renderer is told when the deck changed under it */
export interface Redraw {
  /** the order and the slides that draw differently; absent: the whole deck */
  update?: SlideUpdate
  /** part paths that now hold another slide than the renderer knew under that path */
  replaced?: string[]
  /** the canvas shows something the deck does not hold (a refused drag): build it again */
  rebuild?: boolean
}

/** A refused gesture is undone on the canvas once its burst of attempts is over */
const REBUILD_AFTER_MS = 120

/**
 * The adapter for the deck the page opened at `path`. `editMembers` are the bridge's editing
 * members; `install` puts the co-editing ones on the bridge. After other people's edits
 * `redraw` gets the slides that draw differently and the order.
 */
export function openSlidesCollab(
  handles: SlidesCollabHandles,
  page: {
    fileName: string
    path: string
    canEdit: boolean
    editMembers: ReadonlyArray<keyof SlidesApi>
    install(members: Partial<SlidesApi>): void
    redraw(change: Redraw): void
  },
): CollabAdapter<SlidesOp> {
  const session = currentSession()
  if (!session || session.path !== page.path || handles.path !== page.path) {
    throw new Error('the editor does not show the co-edited presentation')
  }
  const deck = session.opened
  /** what the renderer shows, read just before other people's edits change the deck */
  let shown: Drawn = new Map()
  const collab = createSlidesCollab({
    session,
    fileName: page.fileName,
    changing: () => {
      shown = drawnOf(renderDeck() ?? [])
    },
    refresh: (replaced) =>
      page.redraw({
        update: redrawFrom(shown, renderDeck() ?? []),
        replaced: deck.deck.slides
          .filter((slide) => replaced.includes(slideDurableId(slide)))
          .map((slide) => slide.path),
      }),
    refused: notice,
  })
  const newId = (): string => crypto.randomUUID()
  const before = (): string[] => deck.deck.slides.map((s) => s.path)

  const addSlide = async (
    edit: Extract<SlidesEdit, { kind: 'duplicateSlide' | 'blankSlide' }>,
    fitWidthPx: number,
  ): Promise<(SlideUpdate & { index: number }) | null> => {
    const order = before()
    const done = collab.edit(() => slideEdit(session, newId(), edit))
    if (!done?.applied.made) return null
    session.fitWidthPx = fitWidthPx
    const index = slideIndexOf(deck, done.applied.made)
    return forPage({ ...buildSlideUpdate(session, order), index })
  }

  const deleteSlides = async (indexes: number[]): Promise<SlideUpdate | null> => {
    const slides = [...new Set(indexes)].map((i) => slideIdAt(deck, i))
    const present = slides.filter((s): s is string => s !== null)
    if (present.length === 0 || present.length < slides.length) return null
    const order = before()
    const done = collab.edit(() =>
      slideEdit(session, newId(), { kind: 'deleteSlides', slides: present }),
    )
    return done ? forPage(buildSlideUpdate(session, order)) : null
  }

  const synced: Partial<SlidesApi> = {
    editText: async (input) => {
      const at = collab.refOf(input.sourceId, input.groupId)
      if (!at) {
        notice('target')
        return null
      }
      const done = collab.edit(() => textEdit(session, newId(), at, input.paragraphs))
      if (!done) return null
      const index = slideIndexOf(deck, at.slide)
      // the renderer puts the result on the slide it shows at `slideIndex`: when other people's
      // edits moved this one, it gets the whole deck instead
      if (index === input.slideIndex) return forPage(rebuildSlide(session, index))
      page.redraw({})
      return null
    },
    addSlide: async (input) => {
      const slide = slideIdAt(deck, input.sourceIndex)
      if (!slide) return null
      const clearText = input.clearText === true
      return addSlide({ kind: 'duplicateSlide', slide, clearText, made: '' }, input.fitWidthPx)
    },
    addBlankSlide: async (input) => {
      const slide = slideIdAt(deck, input.sourceIndex)
      if (!slide) return null
      const edit = { kind: 'blankSlide', slide, before: input.before === true, made: '' } as const
      return addSlide(edit, input.fitWidthPx)
    },
    deleteSlide: (slideIndex) => deleteSlides([slideIndex]),
    deleteSlides: (input) => deleteSlides(input.slideIndexes),
    setNotes: async (input) => {
      const slide = slideIdAt(deck, input.slideIndex)
      return (
        !!slide &&
        !!collab.edit(() => slideEdit(session, newId(), { kind: 'notes', slide, text: input.text }))
      )
    },
    undo: async () => {
      notice('history')
      return null
    },
    redo: async () => {
      notice('history')
      return null
    },
    // the AI panel's edits are held and restored as whole snapshots (decision 0012)
    applyTxn: async () => {
      notice('ai')
      return null
    },
  }

  /**
   * An AI run and a history batch hold and restore whole-deck snapshots no other page has. These
   * are not editing members, so the page's own (deck-edits.ts) would stay in place: none begins,
   * and there is never one to end, hold, accept, reject or restore.
   */
  const held: Partial<SlidesApi> = {
    beginHistoryBatch: async () => false,
    endHistoryBatch: async () => null,
    aiRunBegin: async () => false,
    aiRunHold: async () => null,
    aiProposalAccept: async () => null,
    aiProposalReject: async () => false,
    aiSnapshotRestore: async () => null,
  }

  let rebuilding: ReturnType<typeof setTimeout> | undefined
  const refuse = (kind: Notice) => async (): Promise<never> => {
    notice(kind)
    // The canvas may show what the renderer asked for (a handle or a border where it was
    // dragged). A drag asks many times: the canvas is built again once, after the last refusal.
    clearTimeout(rebuilding)
    rebuilding = setTimeout(
      () => page.redraw({ update: { order: before(), slides: [] }, rebuild: true }),
      REBUILD_AFTER_MS,
    )
    throw new Error(NOTICES.en[kind])
  }
  const members: Partial<SlidesApi> = { ...held }
  for (const name of page.editMembers) {
    if (READS[name]) continue
    if (!page.canEdit) Object.assign(members, { [name]: refuse('viewOnly') })
    else Object.assign(members, { [name]: synced[name] ?? refuse('blocked') })
  }
  page.install(members)
  return collab.adapter
}
