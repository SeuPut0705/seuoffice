/**
 * The design template a document is made with, on the renderer side: which
 * built-in template or saved style is selected, and the requests the user
 * added on top of it ("mostly blue"). This is the one place that holds it. The
 * main process remembers it per document (the two preload calls); the AI skill
 * reads it to generate, and the picker shows and changes it.
 *
 * Also here: what a selection means for generation (its style text, whether
 * the template's devices override the page writer's ban rules) and how the
 * added requests are attached to a style text.
 */
import { useSyncExternalStore } from 'react'
import { listSlideTemplates, type SlideTemplate } from '@genoffice/pipelines/slides/templates'
import type {
  TemplateSelection,
  TemplateSelectionInput,
  TemplateSelectionKind,
} from '../../shared/ipc'
import { normalizeTemplateAdjustments } from '../../shared/template-selection'
import type { LayoutSkeleton } from './layout-skeleton'

/** A saved style as the main process answers it (ai:load-style-template) */
export interface SavedStyleRecord {
  ok: boolean
  styleSkill?: string
  topic?: string
  layout?: LayoutSkeleton
  /** Id of the built-in template the style was saved from; absent in styles saved any other way */
  basedOn?: string
  error?: string
}

/** The preload calls the state goes through */
export interface TemplateSelectionBridge {
  getTemplateSelection(): Promise<TemplateSelection | null>
  setTemplateSelection(selection: TemplateSelectionInput | null): Promise<TemplateSelection | null>
  /** Only asked whether a remembered saved style still exists */
  loadStyleTemplate(name: string): Promise<{ ok: boolean }>
}

export interface TemplateSelectionState {
  /**
   * The document's selection as last read, with its added requests. Null when
   * nothing is selected, or what was remembered no longer exists (a deleted
   * saved style, a template this version does not have).
   */
  current(): TemplateSelection | null
  /** Read the document's selection again from the main process */
  refresh(): Promise<TemplateSelection | null>
  /**
   * Select a template, or change to another one: the added requests of the
   * previous selection are dropped. Selecting what is already selected changes nothing.
   */
  select(kind: TemplateSelectionKind, key: string): Promise<TemplateSelection | null>
  /** Remove the selection, and the added requests with it */
  remove(): Promise<void>
  /** Keep one more request the user made on top of the selected template; ignored without a selection */
  addRequest(text: string): Promise<TemplateSelection | null>
  /** Drop the added requests and keep the selection */
  clearRequests(): Promise<TemplateSelection | null>
  /** Called after every change of `current()`; returns the unsubscribe function */
  subscribe(listener: () => void): () => void
}

/** The built-in template with exactly this id */
export function builtinTemplateById(id: string): SlideTemplate | undefined {
  return listSlideTemplates().find((tpl) => tpl.id === id)
}

/** A request as it is kept: one line, single spaces */
export function normalizeRequestText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * The added requests with one more, as the store keeps them (oldest dropped
 * beyond the cap). A request stated again becomes the latest one, which is
 * the one that wins a conflict, instead of being kept twice.
 */
export function withAddedRequest(requests: readonly string[], text: string): string[] {
  const request = normalizeRequestText(text)
  if (!request) return [...requests]
  const earlier = requests.filter((kept) => kept.toLowerCase() !== request.toLowerCase())
  return normalizeTemplateAdjustments([...earlier, request])
}

function sameSelection(a: TemplateSelection | null, b: TemplateSelection | null): boolean {
  if (a === null || b === null) return a === b
  return (
    a.kind === b.kind &&
    a.key === b.key &&
    a.updatedAt === b.updatedAt &&
    a.adjustments.length === b.adjustments.length &&
    a.adjustments.every((text, i) => text === b.adjustments[i])
  )
}

export function createTemplateSelectionState(
  bridge: TemplateSelectionBridge,
): TemplateSelectionState {
  let current: TemplateSelection | null = null
  // Counts the writes started, so a read that began before one cannot put the old value back
  let writes = 0
  const listeners = new Set<() => void>()

  const publish = (next: TemplateSelection | null): void => {
    if (sameSelection(current, next)) return
    current = next
    for (const listener of [...listeners]) listener()
  }

  /** Whether what is remembered can still be used; anything that cannot be checked counts as gone */
  const exists = async (selection: TemplateSelection): Promise<boolean> => {
    if (selection.kind === 'builtin') return builtinTemplateById(selection.key) !== undefined
    try {
      return (await bridge.loadStyleTemplate(selection.key)).ok === true
    } catch {
      return false
    }
  }

  /** The main process stores it and answers what it holds afterwards; a failed call changes nothing */
  const write = async (input: TemplateSelectionInput | null): Promise<TemplateSelection | null> => {
    writes += 1
    try {
      publish(await bridge.setTemplateSelection(input))
    } catch {
      // not remembered: the screen keeps showing what is
    }
    return current
  }

  return {
    current: () => current,
    refresh: async () => {
      const at = writes
      let stored: TemplateSelection | null
      try {
        stored = await bridge.getTemplateSelection()
        if (stored && !(await exists(stored))) stored = null
      } catch {
        stored = null
      }
      if (at === writes) publish(stored)
      return current
    },
    select: async (kind, key) => {
      if (current && current.kind === kind && current.key === key) return current
      if (kind === 'builtin' && !builtinTemplateById(key)) return current
      return write({ kind, key })
    },
    remove: async () => {
      await write(null)
    },
    addRequest: async (text) => {
      if (!current || !normalizeRequestText(text)) return current
      return write({
        kind: current.kind,
        key: current.key,
        adjustments: withAddedRequest(current.adjustments, text),
      })
    },
    clearRequests: async () => {
      if (!current || current.adjustments.length === 0) return current
      return write({ kind: current.kind, key: current.key, adjustments: [] })
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

/**
 * The state of this window's document. The preload is looked up at call time,
 * and a call it does not have (a stale preload) reads as no selection.
 */
export const templateSelectionState: TemplateSelectionState = createTemplateSelectionState({
  getTemplateSelection: async () => window.slidesApi.getTemplateSelection(),
  setTemplateSelection: async (selection) => window.slidesApi.setTemplateSelection(selection),
  loadStyleTemplate: async (name) => window.slidesApi.loadStyleTemplate(name),
})

/** The current selection for a component; re-renders when it changes */
export function useTemplateSelection(
  state: TemplateSelectionState = templateSelectionState,
): TemplateSelection | null {
  return useSyncExternalStore(state.subscribe, state.current, state.current)
}

// ── What a selection means for generation ─────────────────────────────

/** A selection resolved to what the generator needs */
export interface AppliedTemplate {
  kind: TemplateSelectionKind
  /** The built-in template's id, or the saved style's name */
  key: string
  /** The name to show and to tell the model */
  name: string
  /** The style text, without the added requests */
  styleText: string
  /** Saved styles only: the chrome skeleton saved with the style */
  layout?: LayoutSkeleton
  /**
   * Id of the built-in template whose devices override the page writer's ban
   * rules: the template itself, or the one a saved style was saved from.
   * Absent for any other saved style.
   */
  basedOn?: string
  /** The added requests, oldest first */
  requests: string[]
}

export function appliedBuiltinTemplate(
  template: SlideTemplate,
  requests: readonly string[] = [],
): AppliedTemplate {
  return {
    kind: 'builtin',
    key: template.id,
    name: template.name,
    styleText: template.styleSheet,
    basedOn: template.id,
    requests: [...requests],
  }
}

/** Null when the record holds no style text to generate with */
export function appliedSavedStyle(
  name: string,
  record: SavedStyleRecord,
  requests: readonly string[] = [],
): AppliedTemplate | null {
  if (!record.ok || !record.styleSkill) return null
  const origin =
    typeof record.basedOn === 'string' ? builtinTemplateById(record.basedOn) : undefined
  return {
    kind: 'saved',
    key: name,
    name,
    styleText: record.styleSkill,
    ...(record.layout ? { layout: record.layout } : {}),
    ...(origin ? { basedOn: origin.id } : {}),
    requests: [...requests],
  }
}

/**
 * What the selection means for generation, or null when there is none or it
 * no longer exists. A saved style is read through `loadSaved`.
 */
export async function resolveAppliedTemplate(
  selection: TemplateSelection | null,
  loadSaved?: (name: string) => Promise<SavedStyleRecord>,
): Promise<AppliedTemplate | null> {
  if (!selection) return null
  if (selection.kind === 'builtin') {
    const template = builtinTemplateById(selection.key)
    return template ? appliedBuiltinTemplate(template, selection.adjustments) : null
  }
  if (!loadSaved) return null
  try {
    return appliedSavedStyle(selection.key, await loadSaved(selection.key), selection.adjustments)
  } catch {
    return null
  }
}

const ADDED_REQUESTS_HEADING =
  '## Requests the user added to this style (oldest first)\n' +
  'Where a request conflicts with the style above, the request wins; where two requests conflict, the later one wins. Everything the requests do not mention stays as the style sets it: keep its fonts and its layouts unless a request says to change them.'

/** The style text the planner and the page writer read: the template's text, then the added requests as a block of their own */
export function styleWithRequests(styleText: string, requests: readonly string[]): string {
  if (requests.length === 0) return styleText
  const list = requests.map((request, i) => `${i + 1}. ${request}`).join('\n')
  return `${styleText}\n\n${ADDED_REQUESTS_HEADING}\n${list}`
}
