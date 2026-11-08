/**
 * The context check of the deck generation calls (style, outline, pages, page
 * redo). Those calls go straight to `ai:stream` instead of through the panel's
 * IPC transport, so they get the same 80% check here, with the same window
 * (`localContextLimit`) and the same dialog the transport uses.
 *
 * One question per run: the run is the AgentLoop's abort signal, which every
 * deck tool call of one request shares. A yes lets the rest of that run send;
 * a no refuses every later call of that run without asking again, so a retry,
 * a repair round or the next page never brings the dialog back. A call with no
 * run asks on its own.
 */
import { contextWarningFor, type ContextWarning } from '@genoffice/agent-core'

export interface DeckContextGateOptions<S> {
  /** the selected model's window; undefined skips the check (not a local model) */
  contextLimit(settings: S): { limit: number; known: boolean } | undefined
  /** ask the person; anything but true is a decline */
  confirm(warning: ContextWarning): boolean
}

export interface DeckContextGate<S> {
  /** true when this request may be sent; false means the model must not be called */
  allows(settings: S, system: string, user: string, run: AbortSignal | undefined): boolean
}

export function createDeckContextGate<S>(options: DeckContextGateOptions<S>): DeckContextGate<S> {
  /** each run's answer: true confirmed, false declined */
  const answers = new WeakMap<AbortSignal, boolean>()
  return {
    allows(settings, system, user, run) {
      // a declined run sends nothing more, large or small, as a declined job does
      if (run && answers.get(run) === false) return false
      const limit = options.contextLimit(settings)
      if (!limit) return true
      const warning = contextWarningFor(
        system,
        [{ role: 'user', text: user }],
        [],
        limit.limit,
        limit.known,
      )
      if (!warning) return true
      if (run && answers.get(run) === true) return true
      let confirmed: boolean
      try {
        confirmed = options.confirm(warning) === true
      } catch {
        // a broken dialog declines: nothing is sent without a yes
        confirmed = false
      }
      if (run) answers.set(run, confirmed)
      return confirmed
    },
  }
}
