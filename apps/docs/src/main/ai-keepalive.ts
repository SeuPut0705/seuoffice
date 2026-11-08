// Wire-activity keepalive for a request that may wait a long time for its first
// token. A local AI server loads the model on the first request, and the
// renderer treats a silent stream as a dead one; a ping every five seconds lets
// it tell "the model is still loading" from "the connection died".
//
// No Electron here: the timer is plain and testable, and the caller owns the
// chunk it sends. The caller must stop it when the request ends (the main
// handler does so in `finally`), so no timer outlives a turn.

/** how often a waiting local request tells the renderer it is still alive */
export const AI_KEEPALIVE_INTERVAL_MS = 5_000

/**
 * Call `send` once per interval until the returned function is called. The
 * first ping arrives after one full interval, not immediately: a fast answer
 * needs no keepalive at all. Stopping twice is safe.
 */
export function startAiKeepalive(
  send: () => void,
  intervalMs: number = AI_KEEPALIVE_INTERVAL_MS,
): () => void {
  const timer = setInterval(send, intervalMs)
  let stopped = false
  return () => {
    if (stopped) return
    stopped = true
    clearInterval(timer)
  }
}

/**
 * A keepalive that lasts until the first answer chunk, not merely until the
 * response headers. A local server can send headers while it is still loading
 * the model; stopping at that point lets the renderer's silence watchdog cancel
 * a request the main process is still waiting for.
 */
export function startFirstChunkKeepalive(
  send: () => void,
  intervalMs: number = AI_KEEPALIVE_INTERVAL_MS,
): { firstChunk: () => void; stop: () => void } {
  const stop = startAiKeepalive(send, intervalMs)
  let done = false
  return {
    firstChunk: () => {
      if (done) return
      done = true
      stop()
    },
    stop,
  }
}
