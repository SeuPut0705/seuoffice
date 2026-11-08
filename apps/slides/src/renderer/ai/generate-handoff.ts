/**
 * The AI panel's way in from outside the tab (spec 8.5): the shell's "make"
 * window opened this untitled deck and left a request for it. On the panel's
 * first mount the request is taken — once per tab; a remount or a reload gets
 * nothing — and handled the way a user would: the materials are added as
 * composer attachments through the same check as a dropped or picked file
 * (`addAttachmentPaths`), the request text goes into the composer, and the run
 * is asked for through the panel's own send path, so the send gate decides as
 * usual. When the gate refuses ("not connected") or holds the request (the
 * first-connection notice, a status check), nothing is cleared: the text and
 * the attachments stay in the composer for the user to send.
 *
 * It also reports "a run started": each run admitted in this tab (a new user
 * message) is reported with the attachments it went out with, until the main
 * process records one — the shared queue counts only a run that carries at
 * least one handed-over material, and only the first.
 *
 * The ribbon's presets are a different way in and are not touched here.
 */
import { useEffect, useRef } from 'react'
import type { AttachmentAddResult, SlidesApi } from '../../shared/ipc'

type TakenHandoff = NonNullable<Awaited<ReturnType<NonNullable<SlidesApi['takeGenerateHandoff']>>>>

/** per renderer (per tab load): a reload starts over and the main process then has nothing left */
interface HandoffState {
  /** the one take, shared by every mount (StrictMode runs effects twice; the panel remounts by key) */
  take: Promise<TakenHandoff | null> | null
  /** a mounted panel put the request in its composer */
  applied: boolean
  /** a request was taken here and no run was recorded as its start yet */
  reportOpen: boolean
}

const freshState = (): HandoffState => ({ take: null, applied: false, reportOpen: false })
let state = freshState()

/** tests only: a fresh renderer */
export function resetGenerateHandoffForTest(): void {
  state = freshState()
}

function takeOnce(): Promise<TakenHandoff | null> {
  state.take ??= Promise.resolve()
    .then(() => window.slidesApi?.takeGenerateHandoff?.() ?? null)
    .catch(() => null)
  return state.take
}

export interface GenerateHandoffPanel {
  /** the panel's live messages: a new user message is a run the send gate admitted */
  readonly chat: ReadonlyArray<{
    readonly role: string
    readonly attachments?: ReadonlyArray<{ readonly path: string }>
  }>
  /** whether the panel is expanded */
  readonly open: boolean
  /** expand the collapsed panel */
  readonly expand: () => void
  /** merge checked attachments into the composer (synchronously visible to `send`) */
  readonly attach: (result: AttachmentAddResult) => void
  /** put text in the composer */
  readonly fill: (text: string) => void
  /** the panel's own send path with the composer's attachments (goes through the send gate) */
  readonly send: (text: string) => void
}

export function useGenerateHandoff(panel: GenerateHandoffPanel): void {
  const panelRef = useRef(panel)
  panelRef.current = panel

  useEffect(() => {
    if (state.applied) return
    let alive = true
    const s = state
    void takeOnce().then(async (handoff) => {
      if (!alive || !handoff || s.applied) return
      let added: AttachmentAddResult
      try {
        added = await window.desktop.addAttachmentPaths(handoff.materials.map((m) => m.path))
      } catch {
        added = { accepted: [], rejected: handoff.materials.map((m) => m.name) }
      }
      // a remount while the check ran: the live panel applies it instead
      if (!alive || s.applied) return
      s.applied = true
      s.reportOpen = true
      const p = panelRef.current
      if (!p.open) p.expand()
      p.attach(added)
      p.fill(handoff.text)
      // the request was to make it from the materials: with none attached, the
      // composer keeps the text (and the notice names what was refused) for the user
      if (added.accepted.length > 0 && handoff.text.trim()) p.send(handoff.text.trim())
    })
    return () => {
      alive = false
    }
  }, [])

  /** user messages already looked at; drops back when the chat is cleared or cut */
  const userCountRef = useRef(0)
  useEffect(() => {
    const users = panel.chat.filter((e) => e.role === 'user')
    const seen = Math.min(userCountRef.current, users.length)
    userCountRef.current = users.length
    if (!state.reportOpen) return
    const s = state
    for (const entry of users.slice(seen)) {
      const paths = (entry.attachments ?? []).map((a) => a.path)
      if (paths.length === 0) continue
      void Promise.resolve()
        .then(() => window.slidesApi?.reportGenerateRunStarted?.(paths))
        .then((recorded) => {
          if (recorded) s.reportOpen = false
        })
        .catch(() => {})
    }
  }, [panel.chat])
}
