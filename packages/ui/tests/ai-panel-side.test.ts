/** @vitest-environment jsdom */
import { beforeAll, afterEach, describe, expect, it, vi } from 'vitest'
import {
  aiPanelInitiallyOpen,
  rememberAiPanelOpen,
  applyAiPanelPrefs,
  aiPanelWidthAtPointer,
} from '../src/ai-panel-prefs-store'
import {
  DEFAULT_AI_PANEL_PREFS,
  aiPanelStartOf,
  aiPanelStartPatch,
  type AiPanelPrefs,
} from '../src/ai-panel-prefs'

beforeAll(() => {
  // jsdom's opaque origin has no localStorage; the initial-open tests need it
  let store: Record<string, string> = {}
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => {
        store[k] = v
      },
      removeItem: (k: string) => {
        delete store[k]
      },
      clear: () => {
        store = {}
      },
    },
  })
})

afterEach(() => {
  applyAiPanelPrefs({})
  vi.unstubAllGlobals()
})

describe('AI panel side in the renderer', () => {
  it('moves the layout on a side-only update and restores the default', () => {
    applyAiPanelPrefs({ side: 'right' })
    expect(document.documentElement.dataset.aiPanelSide).toBe('right')
    applyAiPanelPrefs({ side: 'left' })
    expect(document.documentElement.dataset.aiPanelSide).not.toBe('right')
  })

  it('measures width inward from the selected window edge', () => {
    vi.stubGlobal('innerWidth', 1200)
    applyAiPanelPrefs({ side: 'left' })
    expect(aiPanelWidthAtPointer(350)).toBe(350)
    applyAiPanelPrefs({ side: 'right' })
    expect(aiPanelWidthAtPointer(850)).toBe(350)
    expect(aiPanelWidthAtPointer(750)).toBe(450)
  })
})

describe('AI panel start choice', () => {
  const prefs = (patch: Partial<AiPanelPrefs>): AiPanelPrefs => ({
    ...DEFAULT_AI_PANEL_PREFS,
    ...patch,
  })

  it('reads one choice from the two stored switches', () => {
    expect(aiPanelStartOf(prefs({ showAiSidebar: false }))).toBe('off')
    expect(aiPanelStartOf(prefs({ openInNewDocs: false }))).toBe('collapsed')
    expect(aiPanelStartOf(prefs({}))).toBe('last')
    // fields missing from an old or partial payload read as the defaults
    expect(aiPanelStartOf({} as AiPanelPrefs)).toBe('last')
  })

  it('maps the choice back to the switches so no new settings field is needed', () => {
    expect(aiPanelStartPatch('off')).toEqual({ showAiSidebar: false, openInNewDocs: false })
    expect(aiPanelStartPatch('collapsed')).toEqual({ showAiSidebar: true, openInNewDocs: false })
    expect(aiPanelStartPatch('last')).toEqual({ showAiSidebar: true, openInNewDocs: true })
  })
})

describe('AI panel initial open state', () => {
  afterEach(() => localStorage.clear())

  it('never opens when the AI sidebar is disabled outright', () => {
    applyAiPanelPrefs({ showAiSidebar: true })
    expect(aiPanelInitiallyOpen('k')).toBe(true)
    applyAiPanelPrefs({ showAiSidebar: false })
    expect(aiPanelInitiallyOpen('k')).toBe(false)
    // flipping it back on restores the remembered state
    applyAiPanelPrefs({ showAiSidebar: true })
    expect(aiPanelInitiallyOpen('k')).toBe(true)
  })

  it('follows the remembered per-app state while the setting is on', () => {
    applyAiPanelPrefs({ openInNewDocs: true })
    expect(aiPanelInitiallyOpen('k')).toBe(true)
    localStorage.setItem('k', '0')
    expect(aiPanelInitiallyOpen('k')).toBe(false)
  })

  it('starts collapsed regardless of the remembered state when off', () => {
    applyAiPanelPrefs({ openInNewDocs: false })
    localStorage.setItem('k', '1')
    expect(aiPanelInitiallyOpen('k')).toBe(false)
  })

  it('leaves the remembered state alone while off so turning it back on restores it', () => {
    applyAiPanelPrefs({ openInNewDocs: true })
    rememberAiPanelOpen('k', true)
    applyAiPanelPrefs({ openInNewDocs: false })
    rememberAiPanelOpen('k', false)
    applyAiPanelPrefs({ openInNewDocs: true })
    expect(aiPanelInitiallyOpen('k')).toBe(true)
    rememberAiPanelOpen('k', false)
    expect(aiPanelInitiallyOpen('k')).toBe(false)
  })
})
