/** @vitest-environment jsdom */
// The AI dock follows the shell's split-pane role (decision 0036): as the
// secondary pane the panel is forced to the rail even while its own state says
// open, and clicking that rail asks the shell to focus this pane first so the
// panel it opens is the visible one. Without the bridge nothing changes.
import { act, createElement, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  SplitPaneBridge,
  SplitPaneRole,
} from '@genoffice/electron-utils/split-pane-bridge'
import { useAiDock, type AiDockState } from '../src/renderer/ai/use-ai-dock'

const BRIDGE_KEY = 'aiOfficeSplit'

/** A split-pane bridge as an editor's preload exposes it, with the push side in hand. */
function fakeBridge(getRoleImpl: SplitPaneBridge['getRole'] = async () => null) {
  const handlers = new Set<(role: SplitPaneRole | null) => void>()
  const requestFocus = vi.fn()
  const bridge: SplitPaneBridge = {
    getRole: vi.fn(getRoleImpl),
    onRoleChanged: (handler) => {
      handlers.add(handler)
      return () => {
        handlers.delete(handler)
      }
    },
    requestFocus,
    reportFocus: vi.fn(),
  }
  return {
    bridge,
    requestFocus,
    push: (role: SplitPaneRole | null) => {
      for (const handler of handlers) handler(role)
    },
  }
}

const setBridge = (value: unknown) => {
  ;(globalThis as Record<string, unknown>)[BRIDGE_KEY] = value
}

let host: HTMLDivElement

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  host = document.createElement('div')
  document.body.append(host)
})

afterEach(() => {
  host.remove()
  delete (globalThis as Record<string, unknown>)[BRIDGE_KEY]
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** Mounts the hook exactly as the dock uses it: a local open state behind it. */
function mountDock(initialOpen: boolean) {
  let latest: AiDockState | null = null
  const setCalls: boolean[] = []
  function Probe() {
    const [open, setOpen] = useState(initialOpen)
    latest = useAiDock(open, (next) => {
      setCalls.push(next)
      setOpen(next)
    })
    return null
  }
  const root = createRoot(host)
  act(() => root.render(createElement(Probe)))
  return {
    get open(): boolean {
      return latest!.open
    },
    clickRail: () => act(() => latest!.onExpand()),
    setCalls,
    unmount: () => {
      act(() => root.unmount())
    },
  }
}

describe('the AI dock under the split-pane role', () => {
  it('without the bridge follows its own open state', () => {
    const dock = mountDock(false)
    expect(dock.open).toBe(false)
    dock.clickRail()
    expect(dock.open).toBe(true)
    expect(dock.setCalls).toEqual([true])
    dock.unmount()
  })

  it('elsewhere the rail click closes an open panel', () => {
    const dock = mountDock(true)
    dock.clickRail()
    expect(dock.open).toBe(false)
    expect(dock.setCalls).toEqual([false])
    dock.unmount()
  })

  it('as the secondary pane forces the panel to the rail and asks for focus on a rail click', async () => {
    const b = fakeBridge(async () => 'secondary')
    setBridge(b.bridge)
    const dock = mountDock(true)
    await act(async () => {})
    // forced shut even though the panel's own state says open
    expect(dock.open).toBe(false)
    dock.clickRail()
    expect(b.requestFocus).toHaveBeenCalledOnce()
    // the choice is remembered, so the panel appears once focus arrives
    expect(dock.setCalls).toEqual([true])
    expect(dock.open).toBe(false)
    act(() => b.push('focus'))
    expect(dock.open).toBe(true)
    dock.unmount()
  })

  it('keeps a closed panel closed when the shell gives this pane focus', async () => {
    const b = fakeBridge(async () => 'secondary')
    setBridge(b.bridge)
    const dock = mountDock(false)
    await act(async () => {})
    act(() => b.push('focus'))
    expect(dock.open).toBe(false)
    dock.unmount()
  })
})
