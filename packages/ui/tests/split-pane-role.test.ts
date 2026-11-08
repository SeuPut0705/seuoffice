/** @vitest-environment jsdom */
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SPLIT_PANE_BRIDGE_KEY,
  effectiveAiPanelOpen,
  onAiRailClick,
  useSplitPaneFocusPing,
  useSplitPaneRole,
  type SplitPaneBridge,
  type SplitPaneRole,
} from '../src/split-pane-role'

const BRIDGE_KEY = 'aiOfficeSplit'

const setBridge = (value: unknown) => {
  ;(globalThis as Record<string, unknown>)[BRIDGE_KEY] = value
}

/** A split-pane bridge as an editor's preload exposes it, with the push side in hand. */
function fakeBridge(getRoleImpl: SplitPaneBridge['getRole'] = async () => null) {
  const handlers = new Set<(role: SplitPaneRole | null) => void>()
  const unsubscribed = vi.fn()
  const getRole = vi.fn(getRoleImpl)
  const requestFocus = vi.fn()
  const reportFocus = vi.fn()
  const onRoleChanged = vi.fn((handler: (role: SplitPaneRole | null) => void) => {
    handlers.add(handler)
    return () => {
      handlers.delete(handler)
      unsubscribed()
    }
  })
  const bridge: SplitPaneBridge = { getRole, onRoleChanged, requestFocus, reportFocus }
  return {
    bridge,
    getRole,
    requestFocus,
    reportFocus,
    unsubscribed,
    push: (role: SplitPaneRole | null) => {
      for (const handler of handlers) handler(role)
    },
  }
}

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  delete (globalThis as Record<string, unknown>)[BRIDGE_KEY]
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function renderRoleHook(): { get role(): SplitPaneRole | null; requestFocus: () => void } {
  let latest: ReturnType<typeof useSplitPaneRole> | null = null
  function Probe() {
    latest = useSplitPaneRole()
    return null
  }
  act(() => root.render(createElement(Probe)))
  return {
    get role() {
      return latest!.role
    },
    requestFocus: () => latest!.requestFocus(),
  }
}

function renderPingHook(): void {
  function Probe() {
    useSplitPaneFocusPing()
    return null
  }
  act(() => root.render(createElement(Probe)))
}

it('reads the bridge under the key the preloads expose', () => {
  expect(SPLIT_PANE_BRIDGE_KEY).toBe('aiOfficeSplit')
})

describe('useSplitPaneRole', () => {
  it('reads null when there is no bridge (a standalone editor)', () => {
    const hook = renderRoleHook()
    expect(hook.role).toBeNull()
    act(() => hook.requestFocus())
  })

  it('reads the role once through getRole()', async () => {
    const b = fakeBridge(async () => 'secondary')
    setBridge(b.bridge)
    const hook = renderRoleHook()
    await act(async () => {})
    expect(b.getRole).toHaveBeenCalledOnce()
    expect(hook.role).toBe('secondary')
  })

  it('follows onRoleChanged pushes, and a push wins over a late read', async () => {
    let release: (role: SplitPaneRole | null) => void = () => {}
    const b = fakeBridge(() => new Promise<SplitPaneRole | null>((resolve) => (release = resolve)))
    setBridge(b.bridge)
    const hook = renderRoleHook()
    // the split changes while the one-shot read is still in flight
    act(() => b.push('focus'))
    expect(hook.role).toBe('focus')
    await act(async () => {
      release('secondary')
    })
    expect(hook.role).toBe('focus')
  })

  it('follows later changes as well', async () => {
    const b = fakeBridge(async () => 'focus')
    setBridge(b.bridge)
    const hook = renderRoleHook()
    await act(async () => {})
    expect(hook.role).toBe('focus')
    act(() => b.push('secondary'))
    expect(hook.role).toBe('secondary')
    act(() => b.push(null))
    expect(hook.role).toBeNull()
  })

  it('keeps null when the read fails', async () => {
    const b = fakeBridge(async () => {
      throw new Error('no answer')
    })
    setBridge(b.bridge)
    const hook = renderRoleHook()
    await act(async () => {})
    expect(hook.role).toBeNull()
  })

  it('asks the shell for focus at click time', () => {
    const b = fakeBridge()
    setBridge(b.bridge)
    const hook = renderRoleHook()
    act(() => hook.requestFocus())
    expect(b.requestFocus).toHaveBeenCalledOnce()
  })

  it('releases the subscription when the screen goes away', () => {
    const b = fakeBridge()
    setBridge(b.bridge)
    renderRoleHook()
    act(() => root.unmount())
    expect(b.unsubscribed).toHaveBeenCalledOnce()
    root = createRoot(host)
  })
})

describe('useSplitPaneFocusPing', () => {
  it('reports every focus the window gains', () => {
    const b = fakeBridge()
    setBridge(b.bridge)
    renderPingHook()
    act(() => window.dispatchEvent(new Event('focus')))
    expect(b.reportFocus).toHaveBeenCalledOnce()
    act(() => window.dispatchEvent(new Event('focus')))
    expect(b.reportFocus).toHaveBeenCalledTimes(2)
  })

  it('stops reporting once the screen goes away', () => {
    const b = fakeBridge()
    setBridge(b.bridge)
    renderPingHook()
    act(() => root.unmount())
    root = createRoot(host)
    window.dispatchEvent(new Event('focus'))
    expect(b.reportFocus).not.toHaveBeenCalled()
  })

  it('does nothing without the bridge', () => {
    renderPingHook()
    expect(() => window.dispatchEvent(new Event('focus'))).not.toThrow()
  })
})

describe('effectiveAiPanelOpen', () => {
  it('forces a secondary pane shut and leaves every other state alone', () => {
    expect(effectiveAiPanelOpen(true, 'secondary')).toBe(false)
    expect(effectiveAiPanelOpen(false, 'secondary')).toBe(false)
    expect(effectiveAiPanelOpen(true, 'focus')).toBe(true)
    expect(effectiveAiPanelOpen(false, 'focus')).toBe(false)
    expect(effectiveAiPanelOpen(true, null)).toBe(true)
    expect(effectiveAiPanelOpen(false, null)).toBe(false)
  })
})

describe('onAiRailClick', () => {
  it('in a secondary pane asks for focus first, then remembers the panel open', () => {
    const order: string[] = []
    onAiRailClick(
      'secondary',
      false,
      (open) => order.push(`open:${open}`),
      () => order.push('focus'),
    )
    expect(order).toEqual(['focus', 'open:true'])
  })

  it('elsewhere toggles the panel and does not ask for focus', () => {
    const requestFocus = vi.fn()
    const opens: boolean[] = []
    onAiRailClick('focus', false, (open) => opens.push(open), requestFocus)
    onAiRailClick('focus', true, (open) => opens.push(open), requestFocus)
    onAiRailClick(null, true, (open) => opens.push(open), requestFocus)
    expect(opens).toEqual([true, false, false])
    expect(requestFocus).not.toHaveBeenCalled()
  })
})
