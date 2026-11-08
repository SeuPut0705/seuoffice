/**
 * @vitest-environment jsdom
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentSkillProposalPayload,
  AgentTemplateCheck,
  AgentWindowApi,
} from '../../src/shared/agent-api'
import { AgentSkillCard, type AgentSkillsBridge } from '../../src/renderer/src/agent/AgentSkillCard'
import { AgentInstallProposal } from '../../src/renderer/src/agent/AgentInstallProposal'

/**
 * The agent window's skill card and install proposal on screen (spec 6.3,
 * 6.4): the template is chosen among the session's candidates, "save as it
 * is" waits for the main process's redaction answer, and nothing is fetched
 * or installed before the person's clicks.
 */

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
actEnvironment.IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
let saveFromCard: ReturnType<typeof vi.fn>

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  saveFromCard = vi.fn(async () => ({ ok: true, id: 'app:report' }))
  ;(window as unknown as { aiOfficeUserSkills: unknown }).aiOfficeUserSkills = {
    suggestName: async () => 'report',
    checkName: async () => ({ ok: true }),
    saveFromCard,
    openSettings: async () => undefined,
  }
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const flush = async () => {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60))
    })
  }
}

const PAYLOAD: AgentSkillProposalPayload = {
  sessionId: 's1',
  proposal: {
    key: 'k1',
    title: 'Weekly report',
    name: 'weekly-report',
    description: 'Writes the weekly report.',
    body: 'Steps',
    wantsTemplate: true,
    target: undefined,
  },
  candidates: [
    { id: 'c0', title: 'open', fileName: 'open.docx', from: 'tab', unsaved: true },
    { id: 'c1', title: 'deck', fileName: 'deck.pptx', from: 'project', unsaved: false },
  ],
  selected: 'c1',
}

function agentApi(check: AgentTemplateCheck): AgentWindowApi {
  return {
    templateCheck: vi.fn(async () => check),
    templateAsIs: vi.fn(async () => ({
      ok: true as const,
      bytes: new Uint8Array([1, 2, 3]),
      fileName: 'deck.pptx',
    })),
    templateBlank: vi.fn(async () => ({ ok: true as const, tabId: 't9', previewId: 'p9' })),
  } as unknown as AgentWindowApi
}

const button = (text: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent === text) as
    HTMLButtonElement | undefined

describe('the skill card in the agent window', () => {
  it('starts on the suggested document and offers "no template"', async () => {
    const api = agentApi({ ok: true, redaction: 'none' })
    act(() => {
      root.render(
        createElement(AgentSkillCard, { lang: 'en', payload: PAYLOAD, api, skills: null }),
      )
    })
    await flush()
    const select = host.querySelector('select')!
    expect(select.value).toBe('c1')
    expect([...select.options].map((o) => o.textContent)).toEqual([
      'No template',
      'open.docx · Open in a tab',
      'deck.pptx · Project folder',
    ])
    expect(api.templateCheck).toHaveBeenCalledWith('k1', 'c1')
  })

  it('saves the document as it is only after the main process found no mark', async () => {
    const api = agentApi({ ok: true, redaction: 'none' })
    act(() => {
      root.render(
        createElement(AgentSkillCard, { lang: 'en', payload: PAYLOAD, api, skills: null }),
      )
    })
    await flush()
    const asIs = button('Save the document as it is')!
    expect(asIs.disabled).toBe(false)
    await act(async () => asIs.click())
    await flush()
    expect(api.templateAsIs).toHaveBeenCalledWith('k1', 'c1')
    expect(saveFromCard).toHaveBeenCalledTimes(1)
    expect(saveFromCard.mock.calls[0]![0]).toMatchObject({
      title: 'Weekly report',
      template: { bytes: new Uint8Array([1, 2, 3]), fileName: 'deck.pptx' },
    })
  })

  it('keeps "as it is" blocked, with the reason, when marks are found or cannot be ruled out', async () => {
    for (const redaction of ['redacted', 'unknown'] as const) {
      const api = agentApi({ ok: true, redaction })
      act(() => {
        root.render(
          createElement(AgentSkillCard, {
            key: redaction,
            lang: 'en',
            payload: PAYLOAD,
            api,
            skills: null,
          }),
        )
      })
      await flush()
      expect(button('Save the document as it is')!.disabled).toBe(true)
      expect(host.textContent).toMatch(
        redaction === 'unknown'
          ? /cannot tell here whether anything is withheld/
          : /withheld|redact/i,
      )
      expect(api.templateAsIs).not.toHaveBeenCalled()
    }
    expect(saveFromCard).not.toHaveBeenCalled()
  })

  it('opens the blank-template preview tab and continues there', async () => {
    const api = agentApi({ ok: true, redaction: 'none' })
    act(() => {
      root.render(
        createElement(AgentSkillCard, { lang: 'en', payload: PAYLOAD, api, skills: null }),
      )
    })
    await flush()
    await act(async () => button('Make a blank template')!.click())
    await flush()
    expect(api.templateBlank).toHaveBeenCalledWith(
      'k1',
      'c1',
      expect.objectContaining({ tabTitle: expect.stringContaining('deck') }),
    )
    expect(saveFromCard).not.toHaveBeenCalled()
  })
})

describe('an install the session proposed', () => {
  function skills(): AgentSkillsBridge & { [k: string]: ReturnType<typeof vi.fn> } {
    return {
      importGitHub: vi.fn(async () => ({
        ok: true,
        preview: {
          token: 'tok',
          origin: { kind: 'github', repo: 'o/r', ref: 'main', commit: 'c', path: '' },
          candidates: [
            {
              key: 'k',
              rel: 'find-skills',
              name: 'find-skills',
              title: 'Find skills',
              description: 'd',
              files: 1,
              bytes: 10,
              hasScripts: false,
              hasTemplate: false,
              urls: [],
              urlCount: 0,
              license: undefined,
              collision: false,
              problem: undefined,
            },
          ],
          rootLicense: undefined,
        },
      })),
      cancelImport: vi.fn(async () => undefined),
      install: vi.fn(async () => ({ ok: true, installed: [{ key: 'k', id: 'app:find-skills' }] })),
    } as never
  }

  it('reaches GitHub only on "Open preview", and installs only on Install', async () => {
    const bridge = skills()
    act(() => {
      root.render(
        createElement(AgentInstallProposal, {
          lang: 'en',
          address: 'o/r@find-skills',
          skills: bridge,
        }),
      )
    })
    await flush()
    expect(host.textContent).toContain('o/r@find-skills')
    expect(bridge.importGitHub).not.toHaveBeenCalled()
    await act(async () => button('Open preview')!.click())
    await flush()
    expect(bridge.importGitHub).toHaveBeenCalledWith('o/r@find-skills')
    expect(bridge.install).not.toHaveBeenCalled()
    await act(async () => button('Install')!.click())
    await flush()
    expect(bridge.install).toHaveBeenCalledWith('tok', ['k'], {})
  })

  it('installs nothing when the person closes it', async () => {
    const bridge = skills()
    act(() => {
      root.render(
        createElement(AgentInstallProposal, { lang: 'en', address: 'o/r@x', skills: bridge }),
      )
    })
    await flush()
    await act(async () => button('Close')!.click())
    await flush()
    expect(bridge.importGitHub).not.toHaveBeenCalled()
    expect(bridge.install).not.toHaveBeenCalled()
    expect(host.textContent).toContain('Not installed')
  })
})
