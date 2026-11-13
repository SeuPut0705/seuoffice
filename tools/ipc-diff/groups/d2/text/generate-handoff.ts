/**
 * The generate hand-off store as the HTML editor reaches it, answering from
 * the case as `HtmlShell::take_generate_handoff` and
 * `report_generate_run_started` do: `take_generate_handoff` maps a view to
 * its request, taken once.
 */
import { answers } from './fakes.ts'

export function takeGenerateHandoff(_target: string, webContentsId: number): unknown {
  const a = answers()
  const queued = a.c.take_generate_handoff
  if (queued === null || typeof queued !== 'object' || a.taken.has(webContentsId)) return null
  const handoff: unknown = Reflect.get(queued, String(webContentsId))
  if (handoff === null || typeof handoff !== 'object') return null
  a.taken.add(webContentsId)
  return { materials: [], ...handoff }
}

export function reportGenerateRunStarted(
  _target: string,
  webContentsId: number,
  paths: string[],
): unknown {
  const a = answers()
  a.log.push(['reportGenerateRunStarted', webContentsId, paths])
  return a.bool('report_generate_run_started', false) ? {} : null
}
