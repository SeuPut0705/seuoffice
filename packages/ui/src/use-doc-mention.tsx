import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { Lang } from '@genoffice/i18n'
import {
  docFileName,
  docMentionFirstRow,
  docMentionListCall,
  docMentionListOf,
  docMentionStepRow,
  docMentionTriggerAt,
  filterDocMentions,
  insertDocMentions,
  isDocMentionPickable,
  relocateDocMentions,
  sameDocPath,
  type DocMentionDoc,
  type DocMentionSpan,
  type DocMentionTrigger,
} from './doc-mention-model'
import type { DocMentionItem } from './doc-mention-types'
import { DocMentionPicker, docMentionOptionId } from './DocMentionPicker'
import { skillPickerKeyAction } from './skill-picker-model'
import {
  useSkillPickerInput,
  type AiComposerSkills,
  type SkillPickerInput,
} from './use-composer-skills'

// ---- what an editor hands the input -----------------------------------

/** An attachment on the composer, for the same-name rule */
export interface DocMentionAttachment {
  path: string
  /** the file name shown on the attachment row; the path's last part when absent */
  name?: string | undefined
}

/**
 * What AiComposer (or a panel's own input) needs for the `@` document list.
 * The editor attaches; this package only calls these.
 */
export interface AiComposerDocs {
  lang: Lang
  /**
   * Attach the paths the way the attach buttons do. Resolves to the paths that
   * are attachments after the call (one already attached counts); a refused
   * path is left out and the editor shows why on its attachment row.
   */
  attach: (paths: string[]) => Promise<readonly string[]>
  /**
   * Open the document picker window and attach what was picked, as the
   * "Attach from documents" button does. Resolves to the paths attached;
   * null or [] when cancelled, busy (the editor shows that note) or refused.
   */
  pickMore: () => Promise<readonly string[] | null | undefined>
  /** the composer's current attachments */
  attachments: readonly DocMentionAttachment[]
}

// ---- the input's side ---------------------------------------------------

/** The base `@` the list belongs to, and what it holds */
interface Anchor {
  /** the input text `start` refers to */
  value: string
  start: number | null
  /** closed with Esc */
  dismissed: boolean
  /** the shell's list for this `@`; null until it is read */
  items: DocMentionItem[] | null
  /** the list still has to be read */
  wanted: boolean
  /** bumped whenever the `@` is replaced, so a late answer is dropped */
  seq: number
}

const NO_ANCHOR = { start: null, dismissed: false, items: null, wanted: false } as const

export type DocMentionInput = Omit<SkillPickerInput, 'chipRow'>

const NO_INPUT_PROPS: SkillPickerInput['inputProps'] = {}

/**
 * The `@` document list on one input. A new base `@` (docMentionTriggerAt)
 * reads the list from the shell once; the list stays closed while it is read
 * and an answer for an `@` that has since changed is dropped. While open it
 * filters by file name, takes ↑/↓/Enter/Tab/Esc (Esc never stops a run, and
 * keeps that `@` closed until it changes), and a pick attaches through the
 * editor and puts `@<name>` in place of what was typed only for what was
 * attached. Picked mentions are remembered with their place so the list does
 * not reopen on them. With no `docs`, no bridge, or `suppressed` it never
 * opens and the input behaves as before.
 */
export function useDocMentionInput({
  docs,
  value,
  onChange,
  textareaRef,
  suppressed = false,
  maxQuery,
  onCaretMoved,
}: {
  docs: AiComposerDocs | undefined
  value: string
  onChange: (next: string) => void
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
  /** another list (skills) is open on this input */
  suppressed?: boolean | undefined
  /** longest query; defaults to DOC_MENTION_QUERY_MAX */
  maxQuery?: number | undefined
  /** the caret was put after inserted mentions (lets another list read the new caret) */
  onCaretMoved?: ((el: HTMLTextAreaElement) => void) | undefined
}): DocMentionInput {
  const listId = useId()
  const [caret, setCaret] = useState<number | null>(null)
  const [composing, setComposing] = useState(false)
  const [selection, setSelection] = useState({ key: '', index: 0 })
  const [, setTick] = useState(0)
  const pendingCaretRef = useRef<number | null>(null)
  const pickingRef = useRef(false)
  const liveRef = useRef(true)
  const valueRef = useRef(value)
  valueRef.current = value
  const docsRef = useRef(docs)
  docsRef.current = docs
  const onCaretMovedRef = useRef(onCaretMoved)
  onCaretMovedRef.current = onCaretMoved

  // picked mentions follow the text: re-found after every change
  const spansRef = useRef<{ value: string; spans: DocMentionSpan[] }>({ value, spans: [] })
  if (spansRef.current.value !== value) {
    spansRef.current = {
      value,
      spans: relocateDocMentions(spansRef.current.value, value, spansRef.current.spans),
    }
  }

  const listCall = docs ? docMentionListCall() : null
  const enabled = listCall !== null
  const live =
    enabled && caret !== null
      ? docMentionTriggerAt(value, caret, { mentions: spansRef.current.spans, composing, maxQuery })
      : null
  // a composition never opens the list; one already open keeps its last filter until it ends
  const frozenRef = useRef<DocMentionTrigger | null>(null)
  if (!composing) frozenRef.current = live
  const trigger = composing ? frozenRef.current : live

  // The base `@` the list was read for. It follows earlier edits like a picked
  // mention; leaving it (blur, caret elsewhere) and coming back is the same `@`.
  // Its Esc dismissal and its list last until it is edited or removed, or a
  // different base `@` is used.
  const anchorRef = useRef<Anchor>({ value, ...NO_ANCHOR, seq: 0 })
  const anchor = anchorRef.current
  if (anchor.value !== value) {
    if (anchor.start !== null) {
      const kept = relocateDocMentions(anchor.value, value, [{ start: anchor.start, text: '@' }])
      if (kept[0]) anchor.start = kept[0].start
      else Object.assign(anchor, NO_ANCHOR, { seq: anchor.seq + 1 })
    }
    anchor.value = value
  }
  if (trigger && trigger.start !== anchor.start) {
    Object.assign(anchor, NO_ANCHOR, { start: trigger.start, wanted: true, seq: anchor.seq + 1 })
  }

  const items = trigger && trigger.start === anchor.start ? anchor.items : null
  // the latest list, for the same-name rule when a pick resolves
  const fetchedRef = useRef<DocMentionItem[] | null>(null)
  if (items) fetchedRef.current = items
  const matches = trigger && items ? filterDocMentions(items, trigger.query) : []
  const ready = !!trigger && !suppressed && matches.length > 0 && !anchor.dismissed
  // a composition never opens the list: only one already open stays open
  const wasOpenRef = useRef(false)
  const open = composing ? wasOpenRef.current && ready : ready
  if (!composing) wasOpenRef.current = open
  const key = trigger ? `${trigger.start}:${trigger.query}` : ''
  const first = docMentionFirstRow(matches)
  const chosen = selection.key === key ? selection.index : first
  const active =
    chosen === matches.length || (matches[chosen] && isDocMentionPickable(matches[chosen]))
      ? chosen
      : first

  useEffect(() => {
    liveRef.current = true
    return () => {
      liveRef.current = false
    }
  }, [])

  // read the list once per new base `@`; an answer for an `@` since replaced is dropped
  useEffect(() => {
    const a = anchorRef.current
    if (!a.wanted || a.start === null || !listCall) return
    a.wanted = false
    const seq = a.seq
    const settle = (next: DocMentionItem[]) => {
      const current = anchorRef.current
      if (!liveRef.current || current.seq !== seq) return
      current.items = next
      setTick((t) => t + 1)
    }
    void listCall()
      .then((raw) => settle(docMentionListOf(raw) ?? []))
      .catch(() => settle([]))
  })

  // put the caret after the inserted mentions
  useLayoutEffect(() => {
    const at = pendingCaretRef.current
    const ta = textareaRef.current
    if (at === null || !ta) return
    if (ta.value !== value) return
    pendingCaretRef.current = null
    ta.setSelectionRange(at, at)
    setCaret(at)
    onCaretMovedRef.current?.(ta)
  }, [value, textareaRef])

  const insert = (at: { start: number; end: number; typed: string }, picked: DocMentionDoc[]) => {
    const current = valueRef.current
    // the typed `@query` is no longer where it was: leave the text alone
    if (current.slice(at.start, at.end) !== at.typed) return
    const accepted = picked.filter((d): d is { path: string; name: string } => d.path !== null)
    if (accepted.length === 0) return
    const pool: DocMentionDoc[] = [
      ...(fetchedRef.current ?? []),
      ...(docsRef.current?.attachments ?? []).map((a) => ({
        path: a.path,
        name: a.name ?? docFileName(a.path),
      })),
    ]
    const next = insertDocMentions(current, at, accepted, pool)
    const kept =
      spansRef.current.value === current
        ? spansRef.current.spans
        : relocateDocMentions(spansRef.current.value, current, spansRef.current.spans)
    spansRef.current = {
      value: next.value,
      spans: [...relocateDocMentions(current, next.value, kept), ...next.spans],
    }
    pendingCaretRef.current = next.caret
    onChange(next.value)
  }

  const pick = (index: number) => {
    const d = docsRef.current
    if (!d || !trigger || pickingRef.current) return
    const more = index === matches.length
    const item = more ? undefined : matches[index]
    if (!more && (!item || !isDocMentionPickable(item))) return
    const at = {
      start: trigger.start,
      end: trigger.end,
      typed: value.slice(trigger.start, trigger.end),
    }
    pickingRef.current = true
    void (async () => {
      try {
        let picked: DocMentionDoc[] = []
        if (item && item.path !== null) {
          const path = item.path
          const accepted = await d.attach([path]).catch(() => [] as readonly string[])
          if (accepted.some((p) => sameDocPath(p, path))) picked = [{ path, name: item.name }]
        } else {
          const accepted = await d.pickMore().catch(() => null)
          const seen: string[] = []
          for (const p of accepted ?? []) {
            if (typeof p !== 'string' || seen.some((s) => sameDocPath(s, p))) continue
            seen.push(p)
            const listed = fetchedRef.current?.find((i) => sameDocPath(i.path, p))
            picked.push({ path: p, name: listed?.name ?? docFileName(p) })
          }
        }
        if (liveRef.current && picked.length > 0) insert(at, picked)
      } finally {
        pickingRef.current = false
      }
    })()
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
    const action = skillPickerKeyAction({
      key: e.key,
      shiftKey: e.shiftKey,
      isComposing: e.nativeEvent.isComposing || composing,
      open,
    })
    if (!action || !trigger) return false
    e.preventDefault()
    // an Esc that closes the list must not reach a handler that stops the run
    e.stopPropagation()
    if (action === 'next') setSelection({ key, index: docMentionStepRow(matches, active, 1) })
    else if (action === 'prev') setSelection({ key, index: docMentionStepRow(matches, active, -1) })
    else if (action === 'close') {
      anchorRef.current.dismissed = true
      setTick((t) => t + 1)
    } else pick(active)
    return true
  }

  const track = (el: HTMLTextAreaElement) => {
    if (!docsRef.current) return
    setCaret(el.selectionStart === el.selectionEnd ? el.selectionStart : null)
  }

  const inputProps: SkillPickerInput['inputProps'] = open
    ? {
        'aria-expanded': true,
        'aria-controls': listId,
        'aria-activedescendant': docMentionOptionId(listId, active),
        'aria-autocomplete': 'list',
      }
    : NO_INPUT_PROPS

  const popup =
    open && docs ? (
      <div className="ai-doc-mention-anchor">
        <DocMentionPicker
          lang={docs.lang}
          listId={listId}
          items={matches}
          active={active}
          onPick={pick}
          onHover={(index) => setSelection({ key, index })}
        />
      </div>
    ) : null

  return {
    onKeyDown,
    track,
    onCompositionStart: () => setComposing(true),
    onCompositionEnd: (e) => {
      setComposing(false)
      track(e.currentTarget)
    },
    onBlur: () => setCaret(null),
    inputProps,
    popup,
    open,
  }
}

/**
 * The skill list (`/`, `$`) and the `@` document list on one input; only one
 * is open at a time. When both would open, the trigger nearer the caret wins.
 * A skill trigger runs from the last whitespace to the caret with none in
 * between, and a base `@` sits at the input start or after whitespace, so an
 * open skill list is always the nearer one: the document list yields to it.
 * Same shape as useSkillPickerInput; with no `docs` it behaves exactly like it.
 */
export function useComposerPickers({
  skills,
  docs,
  value,
  onChange,
  textareaRef,
}: {
  skills: AiComposerSkills | undefined
  docs: AiComposerDocs | undefined
  value: string
  onChange: (next: string) => void
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
}): SkillPickerInput {
  const skill = useSkillPickerInput({ skills, value, onChange, textareaRef })
  const doc = useDocMentionInput({
    docs,
    value,
    onChange,
    textareaRef,
    suppressed: skill.open,
    onCaretMoved: skill.track,
  })
  return {
    onKeyDown: (e) => skill.onKeyDown(e) || doc.onKeyDown(e),
    track: (el) => {
      skill.track(el)
      doc.track(el)
    },
    onCompositionStart: () => {
      skill.onCompositionStart()
      doc.onCompositionStart()
    },
    onCompositionEnd: (e) => {
      skill.onCompositionEnd(e)
      doc.onCompositionEnd(e)
    },
    onBlur: () => {
      skill.onBlur()
      doc.onBlur()
    },
    inputProps: doc.open ? doc.inputProps : skill.inputProps,
    popup: skill.popup ?? doc.popup,
    chipRow: skill.chipRow,
    open: skill.open || doc.open,
  }
}
