/** @vitest-environment jsdom */
// The memo column beside the document (MemoSide.tsx): what it remembers (open state,
// the old shared dock's memo mode, width), and that closing it hides the column but
// keeps the panel mounted, so the list and the memo editor's locks survive.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { AgentBridge } from '../src/renderer/ai/agent-bridge'
import { LocaleProvider } from '../src/renderer/i18n/locale'
import {
  LEGACY_DOCK_MODE_KEY,
  MEMO_OPEN_KEY,
  MEMO_WIDTH_DEFAULT,
  MEMO_WIDTH_KEY,
  MEMO_WIDTH_MAX,
  MEMO_WIDTH_MIN,
  MemoSide,
  MemoToggle,
  clampMemoWidth,
  loadMemoWidth,
  memoPanelInitiallyOpen,
  rememberMemoPanelOpen,
} from '../src/renderer/MemoSide'
import type { HwpApi } from '../src/shared/ipc'

function memoryStorage(seed: Record<string, string> = {}) {
  const data = new Map(Object.entries(seed))
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  }
}

describe('what the memo column remembers', () => {
  it('starts closed with nothing saved, and follows the saved flag after that', () => {
    expect(memoPanelInitiallyOpen(memoryStorage())).toBe(false)
    expect(memoPanelInitiallyOpen(memoryStorage({ [MEMO_OPEN_KEY]: '1' }))).toBe(true)
    expect(memoPanelInitiallyOpen(memoryStorage({ [MEMO_OPEN_KEY]: '0' }))).toBe(false)
  })

  it('keeps a memo panel left out in the old shared dock out, once', () => {
    expect(memoPanelInitiallyOpen(memoryStorage({ [LEGACY_DOCK_MODE_KEY]: 'memo' }))).toBe(true)
    expect(memoPanelInitiallyOpen(memoryStorage({ [LEGACY_DOCK_MODE_KEY]: 'ai' }))).toBe(false)
    // the new flag wins over the old mode
    expect(
      memoPanelInitiallyOpen(
        memoryStorage({ [LEGACY_DOCK_MODE_KEY]: 'memo', [MEMO_OPEN_KEY]: '0' }),
      ),
    ).toBe(false)
  })

  it('writes the new flag and drops the old dock mode', () => {
    const storage = memoryStorage({ [LEGACY_DOCK_MODE_KEY]: 'memo' })
    rememberMemoPanelOpen(false, storage)
    expect(storage.data.get(MEMO_OPEN_KEY)).toBe('0')
    expect(storage.data.has(LEGACY_DOCK_MODE_KEY)).toBe(false)
    rememberMemoPanelOpen(true, storage)
    expect(storage.data.get(MEMO_OPEN_KEY)).toBe('1')
  })

  it('keeps the width within its bounds and a share of the window', () => {
    expect(clampMemoWidth(100, 1600)).toBe(MEMO_WIDTH_MIN)
    expect(clampMemoWidth(2000, 1600)).toBe(MEMO_WIDTH_MAX)
    expect(clampMemoWidth(450, 1000)).toBe(400)
    // a very narrow window still leaves the column usable
    expect(clampMemoWidth(300, 300)).toBe(MEMO_WIDTH_MIN)
  })

  it('reads a saved width, and the default for nothing or nonsense', () => {
    expect(loadMemoWidth(memoryStorage())).toBe(MEMO_WIDTH_DEFAULT)
    expect(loadMemoWidth(memoryStorage({ [MEMO_WIDTH_KEY]: 'wide' }))).toBe(MEMO_WIDTH_DEFAULT)
    expect(loadMemoWidth(memoryStorage({ [MEMO_WIDTH_KEY]: '333' }))).toBe(333)
    expect(loadMemoWidth(memoryStorage({ [MEMO_WIDTH_KEY]: '9999' }))).toBe(MEMO_WIDTH_MAX)
  })
})

let container: HTMLDivElement
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  localStorage.clear()
  Object.assign(window, {
    hwpApi: {
      getMemoModalOpen: async () => false,
      setMemoModalOpen: vi.fn(),
      getAuthorName: async () => ({ value: 'Mina', fallback: 'pc-account' }),
      onLanguageChanged: () => () => undefined,
    } as unknown as HwpApi,
  })
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  container.remove()
  delete (window as { hwpApi?: unknown }).hwpApi
  vi.restoreAllMocks()
})

async function settle(turns = 6): Promise<void> {
  for (let turn = 0; turn < turns; turn++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

function bridge(): AgentBridge {
  return {
    listMemos: vi.fn(async () => ({ count: 0, memos: [] })),
    showMemoAnchors: vi.fn(async (shown: boolean) => ({ ok: true as const, shown })),
    selectMemo: vi.fn(async (id: number | null) => ({ ok: true as const, id })),
    setMemoLock: vi.fn(async (locked: boolean) => ({ ok: true as const, locked })),
  } as unknown as AgentBridge
}

async function mountSide(open: boolean): Promise<AgentBridge> {
  const memoBridge = bridge()
  root = createRoot(container)
  await act(async () => {
    root!.render(
      createElement(LocaleProvider, {
        initial: 'en',
        children: createElement(MemoSide, {
          open,
          bridge: memoBridge,
          onCollapse: () => {},
          onModalOpenChange: () => {},
          onNotice: () => {},
        }),
      }),
    )
  })
  await settle()
  return memoBridge
}

describe('the memo column on screen', () => {
  it('hides the column while closed but keeps the panel mounted and quiet', async () => {
    const memoBridge = await mountSide(false)
    const side = container.querySelector<HTMLElement>('.memo-side')
    expect(side?.classList.contains('collapsed')).toBe(true)
    expect(side?.querySelector('.memo-panel')?.getAttribute('aria-hidden')).toBe('true')
    expect(side?.querySelector('.memo-side-resizer')).toBeNull()
    expect(memoBridge.listMemos).not.toHaveBeenCalled()
  })

  it('shows the panel with a resize edge while open', async () => {
    const memoBridge = await mountSide(true)
    const side = container.querySelector<HTMLElement>('.memo-side')
    expect(side?.classList.contains('collapsed')).toBe(false)
    expect(side?.style.width).toBe(`${MEMO_WIDTH_DEFAULT}px`)
    expect(side?.querySelector('.memo-side-resizer')).not.toBeNull()
    expect(memoBridge.listMemos).toHaveBeenCalled()
  })

  it('follows a drag of its edge and remembers the width', async () => {
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1600)
    Object.assign(HTMLElement.prototype, { setPointerCapture: () => {} })
    await mountSide(true)
    const resizer = container.querySelector<HTMLElement>('.memo-side-resizer')!
    await act(async () => {
      resizer.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 300 }))
    })
    await act(async () => {
      window.dispatchEvent(new MouseEvent('pointermove', { clientX: 360 }))
      window.dispatchEvent(new MouseEvent('pointerup', { clientX: 360 }))
    })
    expect(container.querySelector<HTMLElement>('.memo-side')?.style.width).toBe(
      `${MEMO_WIDTH_DEFAULT + 60}px`,
    )
    expect(localStorage.getItem(MEMO_WIDTH_KEY)).toBe(String(MEMO_WIDTH_DEFAULT + 60))
  })

  it('has a top-bar button that says whether the column is out', async () => {
    const onToggle = vi.fn()
    root = createRoot(container)
    await act(async () => {
      root!.render(
        createElement(LocaleProvider, {
          initial: 'ko',
          children: createElement(MemoToggle, { open: true, onToggle }),
        }),
      )
    })
    const button = container.querySelector<HTMLButtonElement>('.memo-toggle')!
    expect(button.getAttribute('aria-pressed')).toBe('true')
    expect(button.textContent).toBe('메모')
    await act(async () => button.click())
    expect(onToggle).toHaveBeenCalledTimes(1)
  })
})
