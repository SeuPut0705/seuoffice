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
