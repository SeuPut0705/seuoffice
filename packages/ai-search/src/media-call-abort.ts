/**
 * Cancellation of the generate_image / analyze_media calls a window started.
 * Such a call can run a subscription program, so it must end when its window
 * goes away or when the user stops the AI run that asked for it. The calls in
 * flight are kept per window for the whole process: the stop message
 * (`ai:stream-cancel`) is answered by one main for every editor, whichever
 * main answers the media call itself.
 */

/** Structural subset of Electron's WebContents, so this stays Electron-free and unit-testable. */
export interface MediaCallSender {
  readonly id: number
  isDestroyed(): boolean
  once(event: 'destroyed', listener: () => void): unknown
  removeListener(event: 'destroyed', listener: () => void): unknown
}

const inFlightMediaCalls = new Map<number, Set<AbortController>>()

/**
 * Runs one media tool call for `sender`. The signal handed to `run` aborts
 * when the window is destroyed or abortMediaCalls() names it; the call is
 * forgotten as soon as it settles.
 */
export async function withMediaCallSignal<T>(
  sender: MediaCallSender,
  run: (signal: AbortSignal) => T | Promise<T>,
): Promise<T> {
  const controller = new AbortController()
  const calls = inFlightMediaCalls.get(sender.id) ?? new Set<AbortController>()
  inFlightMediaCalls.set(sender.id, calls)
  calls.add(controller)
  const onDestroyed = () => controller.abort()
  if (sender.isDestroyed()) controller.abort()
  else sender.once('destroyed', onDestroyed)
  try {
    return await run(controller.signal)
  } finally {
    sender.removeListener('destroyed', onDestroyed)
    calls.delete(controller)
    if (!calls.size && inFlightMediaCalls.get(sender.id) === calls) {
      inFlightMediaCalls.delete(sender.id)
    }
  }
}

/**
 * The user stopped the AI run of the window `senderId`: ends its media calls.
 * A run executes its tools after its model turn ended, so the stop message
 * that reaches the main process names a turn that is already over; the calls
 * are found by their window instead.
 */
export function abortMediaCalls(senderId: number): void {
  for (const controller of inFlightMediaCalls.get(senderId) ?? []) controller.abort()
}
