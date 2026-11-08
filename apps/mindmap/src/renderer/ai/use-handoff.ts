/**
 * A generation request handed over by the shell (spec 8.5), on the renderer
 * side: a new untitled map tab takes it once, the AI panel opens, and the
 * request goes to the panel as one `MindmapAiRequest` — its files into the
 * composer's attachments, its text into the composer, then the panel's usual
 * send through the send gate. A blocked or held run leaves both in the panel.
 *
 * Once only, on both sides: the main process empties the slot at the first
 * take (a reload takes nothing), and here the taken request is handed to the
 * panel for exactly one render and then dropped, so a panel that mounts again
 * never sees it a second time. A map opened from a file never asks.
 *
 * Every admitted run that still has at least one handed-over file attached is
 * reported with those files' paths; the main process keeps the first.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { MindmapHandoffApi } from '../../shared/ipc'
import type { MindmapAiRequest, MindmapAiRunStart } from './AiPanel'

/** The hand-off part of the preload bridge; a preload from an older build may lack it. */
function handoffApi(): Partial<MindmapHandoffApi> {
  return (window.mindmapApi as Partial<MindmapHandoffApi> | undefined) ?? {}
}

export interface MapHandoffOptions {
  /** the map has finished opening */
  ready: boolean
  /** the map is a new untitled one (no file) */
  untitled: boolean
  /** shows the AI panel */
  openPanel(): void
}

export interface MapHandoff {
  /** the request for the panel: set for one render, null otherwise */
  request: MindmapAiRequest | null
  /** for the panel's `onRunStart` */
  onRunStart(run: MindmapAiRunStart): void
}

export function useMapHandoff({ ready, untitled, openPanel }: MapHandoffOptions): MapHandoff {
  const [request, setRequest] = useState<MindmapAiRequest | null>(null)
  const askedRef = useRef(false)
  /** the taken request: its id and the files it handed over */
  const takenRef = useRef<{ id: string; paths: Set<string> } | null>(null)
  const openPanelRef = useRef(openPanel)
  openPanelRef.current = openPanel
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  // the first moment the map is ready decides: a new map asks once, a map from a file never does
  useEffect(() => {
    if (!ready || askedRef.current) return
    askedRef.current = true
    if (!untitled) return
    const take = handoffApi().takeHandoff
    if (!take) return
    void take()
      .then((handoff) => {
        if (!mountedRef.current || !handoff) return
        const paths = Array.isArray(handoff.sourcePaths)
          ? handoff.sourcePaths.filter((p): p is string => typeof p === 'string' && p !== '')
          : []
        takenRef.current = { id: handoff.id, paths: new Set(paths) }
        openPanelRef.current()
        setRequest({
          nonce: 1,
          text: typeof handoff.prompt === 'string' ? handoff.prompt : '',
          attachmentPaths: paths,
        })
      })
      .catch(() => {
        // no shell behind this view (or no channel): there is nothing to take
      })
  }, [ready, untitled])

  // the panel took the request in the commit that showed it (its effects ran before this one)
  useEffect(() => {
    if (request) setRequest(null)
  }, [request])

  const onRunStart = useCallback((run: MindmapAiRunStart) => {
    const taken = takenRef.current
    if (!taken) return
    const attachedPaths = run.attachments.map((a) => a.path).filter((p) => taken.paths.has(p))
    // a run with every handed-over file removed is not the start of the hand-off's run
    if (attachedPaths.length === 0) return
    handoffApi().notifyHandoffRunStarted?.({
      id: taken.id,
      attachedSources: attachedPaths.length,
      attachedPaths,
    })
    // the first such run is the one that counts
    takenRef.current = null
  }, [])

  return { request, onRunStart }
}
