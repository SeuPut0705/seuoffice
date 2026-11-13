/**
 * Node globals the imported desktop modules expect. Import first, before any
 * module that touches Buffer or process at load time.
 */
import { Buffer } from 'buffer'

const scope = globalThis as Record<string, unknown>

scope.Buffer ??= Buffer
scope.process ??= {
  env: {},
  platform: 'browser',
  versions: {},
  cwd: () => '/web',
  // the AI provider's subscription code reads its start time when it loads
  uptime: () => performance.now() / 1000,
  nextTick: (callback: (...args: unknown[]) => void, ...args: unknown[]) =>
    queueMicrotask(() => callback(...args)),
}
scope.global ??= globalThis

// The slides session defers its history notice with setImmediate (session-state.ts). The page
// had it only as a side effect of JSZip's `setimmediate` dependency, which the Rust engine no
// longer loads: each callback runs as a task of its own, in the order it was queued.
if (typeof scope.setImmediate !== 'function') {
  const queue: Array<() => void> = []
  const channel = new MessageChannel()
  channel.port1.onmessage = () => queue.shift()?.()
  scope.setImmediate = (callback: (...args: unknown[]) => void, ...args: unknown[]) => {
    queue.push(() => callback(...args))
    channel.port2.postMessage(null)
  }
}
