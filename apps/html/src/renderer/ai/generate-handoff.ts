import { useEffect, useRef, useState } from 'react'
import type { AttachmentAddResult, AttachmentMeta, HtmlGenerateHandoff } from '../../shared/ipc'

/**
 * The generate hand-off (8.5) in the AI panel of a new HTML tab.
 *
 * The shell opens a new untitled tab when the user presses "make" and leaves
 * the request for it. On its first mount the panel takes that request, once:
 * the materials go into the composer through the same route as the user's own
 * attachments, the request goes into the composer, the blank-document intent
 * is the designed page, and then the panel's own send runs — through the
 * shared send gate like any send, with the provider chosen as usual. A gate
 * that holds or refuses leaves the text and the attachments where they are.
 *
 * Nothing is taken by a tab opened on a file, by a remount or a reload (the
 * main process hands a request out once), or without a shell (the take
 * rejects or answers null).
 */

export interface GenerateHandoffPanel {
  /** the document the panel was opened on; a tab with a file never takes */
  filePath: string | null
  /** the composer text as last rendered */
  composer: string
  /** put attachments into the composer as a pick or a drop would */
  attach(result: AttachmentAddResult): void
  setComposer(text: string): void
  /** the blank-document intent for this run: the designed page */
  designIntent(): void
  /** the panel's send, as its send button calls it; false when nothing started */
  send(text: string): boolean
  /** a request was taken (the app may bring the panel into view) */
  onTaken?: (() => void) | undefined
}

export interface GenerateHandoffController {
  /**
   * The panel admitted a run with these attachments. The first such run with
   * a handed-over material among them is reported to the main process, which
   * keeps the record; a run with all of them removed is not a start.
   */
  runAdmitted(attachments: readonly AttachmentMeta[]): void
}

/** Windows paths: the same file whatever the case or the slash */
function samePath(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/\//g, '\\').toLowerCase()
  return norm(a) === norm(b)
}

export function useGenerateHandoff(panel: GenerateHandoffPanel): GenerateHandoffController {
  const panelRef = useRef(panel)
  panelRef.current = panel
  /** this panel has asked already (survives a development double effect) */
  const askedRef = useRef(false)
  const takenRef = useRef<HtmlGenerateHandoff | null>(null)
  const reportedRef = useRef(false)
  /** the request to send once it is in the composer */
  const [pending, setPending] = useState<string | null>(null)

  useEffect(() => {
    if (askedRef.current) return
    askedRef.current = true
    if (panelRef.current.filePath) return
    void (async () => {
      let handoff: HtmlGenerateHandoff | null
      try {
        handoff = (await window.htmlApi.takeGenerateHandoff()) ?? null
      } catch {
        // no handler (standalone, older shell): nothing was left for this tab
        return
      }
      if (!handoff) return
      takenRef.current = handoff
      panelRef.current.onTaken?.()
      const paths = handoff.materials.map((m) => m.path)
      if (paths.length > 0) {
        try {
          panelRef.current.attach(await window.htmlApi.addAttachmentPaths(paths))
        } catch {
          // the request still goes into the composer; the user can attach by hand
        }
      }
      const live = panelRef.current
      live.designIntent()
      live.setComposer(handoff.text)
      setPending(handoff.text)
    })()
  }, [])

  // the materials and the request are on screen now: send them as the send button would
  useEffect(() => {
    if (pending === null || panel.composer !== pending) return
    setPending(null)
    panelRef.current.send(pending)
  }, [pending, panel.composer])

  return {
    runAdmitted: (attachments) => {
      const handoff = takenRef.current
      if (!handoff || reportedRef.current) return
      const paths = attachments.map((a) => a.path)
      const handed = paths.some((p) => handoff.materials.some((m) => samePath(m.path, p)))
      if (!handed) return
      reportedRef.current = true
      void window.htmlApi
        .reportGenerateRunStarted(paths)
        .then((recorded) => {
          if (!recorded) reportedRef.current = false
        })
        .catch(() => {
          reportedRef.current = false
        })
    },
  }
}
