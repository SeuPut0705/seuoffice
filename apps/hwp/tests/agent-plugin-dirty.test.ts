/**
 * The unsaved state the plugin passes on to the app: the editor's change, as the editor makes
 * it. The app's close prompt reads its copy, so a key typed just before closing must be in it.
 */
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { DIRTY_EVENT, agentPlugin, type AgentPluginHost } from '../studio-plugin/agent-plugin.mjs'

function editor() {
  const handlers = new Map<string, ((payload?: unknown) => void)[]>()
  const host = {
    read: () => undefined,
    transaction: () => undefined,
    events: {
      on: (name: string, handler: (payload?: unknown) => void) => {
        handlers.set(name, [...(handlers.get(name) ?? []), handler])
        return () => undefined
      },
    },
    automation: { execute: () => ({ ok: false }) },
  } as unknown as AgentPluginHost
  agentPlugin.activate(host)
  /** the editor's event, as its event bus sends it */
  const emit = (name: string, payload?: unknown) => {
    for (const handler of handlers.get(name) ?? []) handler(payload)
  }
  return { emit }
}

const fired: unknown[] = []
const scope = globalThis as { dispatchEvent?: (event: Event) => boolean }
const original = scope.dispatchEvent
scope.dispatchEvent = (event: Event) => {
  if (event.type === DIRTY_EVENT) fired.push((event as CustomEvent).detail)
  return true
}

afterEach(() => {
  fired.length = 0
})

describe('the unsaved state the plugin passes on', () => {
  it('fires each change of the editor at once, with the new state', () => {
    const { emit } = editor()
    emit('document-dirty-changed', { dirty: true, reason: 'document-changed' })
    expect(fired).toEqual([true])
    emit('document-dirty-changed', { dirty: false, reason: 'host-save' })
    expect(fired).toEqual([true, false])
  })

  it('takes a change without a state for a clean document', () => {
    const { emit } = editor()
    emit('document-dirty-changed')
    expect(fired).toEqual([false])
  })

  it('fires nothing for other editor events', () => {
    const { emit } = editor()
    emit('document-changed')
    emit('command-state-changed')
    expect(fired).toEqual([])
  })

  it('ignores a memo probe when the host has no document yet', () => {
    vi.useFakeTimers()
    try {
      const { emit } = editor()
      emit('document-changed')
      // the memo probe runs after typing stops; a host without a document has
      // nothing to read, and that must stay quiet instead of failing a timer
      expect(() => vi.advanceTimersByTime(1000)).not.toThrow()
    } finally {
      vi.useRealTimers()
    }
  })
})

afterAll(() => {
  if (original === undefined) delete scope.dispatchEvent
  else scope.dispatchEvent = original
})
