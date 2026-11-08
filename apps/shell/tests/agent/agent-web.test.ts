/**
 * The agent window's web rules in the shell (spec 7): Codex choices per
 * project folder reaching the session, answers that last the session, and
 * what the window offers and warns about.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentSession,
  AgentSessionEvent,
  AgentSessionOptions,
} from '@genoffice/ai-provider/agent-session'
import type { AiSubscriptionStatus } from '@genoffice/ai-provider'
import { normalizeAiSettings } from '@genoffice/ai-provider'
import { createAgentManager } from '../../src/main/agent/agent-sessions'
import {
  DEFAULT_AGENT_PROJECT_PREFS,
  agentProjectPrefsPatch,
  type AgentActionView,
} from '../../src/shared/agent-api'
import {
  agentPermissionChoices,
  agentSessionAllowLabel,
  agentWebPermissionLabel,
  codexNetworkWarningShown,
} from '../../src/renderer/src/agent/agent-web'
import { agentWebStrings, agentWebText } from '../../src/renderer/src/i18n/strings-agent-web'
import { readAgentProjectPref, writeAgentProjectPref } from '../../src/main/app-settings'

vi.mock('electron', () => ({
  BrowserWindow: class {},
  dialog: {},
  ipcMain: { handle: vi.fn() },
  shell: {},
}))
const { agentCodexStartChoices, agentPermissionAnswer } =
  await import('../../src/main/agent/agent-window')

const roots: string[] = []
const managers: Array<{ stopAll(): void }> = []
afterEach(() => {
  for (const m of managers.splice(0)) m.stopAll()
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-web-test-'))
  roots.push(dir)
  return dir
}

const ready = (provider: 'claude-code' | 'codex'): AiSubscriptionStatus =>
  ({ provider, state: 'ready', meteredAccepted: false }) as AiSubscriptionStatus

function manager() {
  const home = temp()
  const project = join(home, 'Project')
  mkdirSync(project)
  const answer = vi.fn()
  const session: AgentSession = {
    provider: 'claude-code',
    send: async () => undefined,
    answer,
    setOpenDocuments: () => undefined,
    stop: () => undefined,
  }
  const claude = vi.fn(
    async (_options: AgentSessionOptions, _onEvent: (e: AgentSessionEvent) => void) => session,
  )
  const codex = vi.fn(
    async (
      _options: AgentSessionOptions & {
        meteredAccepted: boolean
        webSearch: string
        network: boolean
      },
    ) => ({ ...session, provider: 'codex' as const }),
  )
  const m = createAgentManager({
    runners: { claude, codex },
    statuses: () => ({ 'claude-code': ready('claude-code'), codex: ready('codex') }),
    aiSettings: () => normalizeAiSettings({ providers: {} }),
    openDocuments: () => [],
    userData: join(home, 'AppData', 'IeumOffice'),
    homeDir: home,
    language: () => 'ko',
    emit: () => undefined,
  })
  managers.push(m)
  return { m, project, home, claude, codex, answer }
}

describe('Codex choices of a project folder', () => {
  it('reach the Codex session: its web search and the network of its profile', async () => {
    const { m, project, codex } = manager()
    await m.start(1, {
      provider: 'codex',
      projectRoot: project,
      mode: 'ask-commands',
      codex: { webSearch: 'live', network: true },
    })
    expect(codex.mock.calls[0]![0]).toMatchObject({ webSearch: 'live', network: true })
  })

  it('start from the Codex app defaults for a folder with nothing remembered', async () => {
    const { m, project, codex } = manager()
    await m.start(1, { provider: 'codex', projectRoot: project, mode: 'trust-project' })
    expect(codex.mock.calls[0]![0]).toMatchObject({ webSearch: 'cached', network: false })
  })

  it('are read per folder from the app settings and given to Codex only', () => {
    const home = temp()
    const settings = join(home, 'app-settings.json')
    const a = join(home, 'A')
    const b = join(home, 'B')
    expect(readAgentProjectPref(settings, a)).toEqual(DEFAULT_AGENT_PROJECT_PREFS)
    writeAgentProjectPref(settings, a, { codexNetwork: true, codexWebSearch: 'disabled' })
    // another folder does not inherit what was turned on for this one
    expect(readAgentProjectPref(settings, b)).toEqual(DEFAULT_AGENT_PROJECT_PREFS)
    expect(agentCodexStartChoices('codex', readAgentProjectPref(settings, a))).toEqual({
      webSearch: 'disabled',
      network: true,
    })
    expect(agentCodexStartChoices('codex', readAgentProjectPref(settings, b))).toEqual({
      webSearch: 'cached',
      network: false,
    })
    expect(agentCodexStartChoices('claude-code', readAgentProjectPref(settings, a))).toBe(undefined)
  })

  it('take only known values from the window', () => {
    expect(agentProjectPrefsPatch({ codexWebSearch: 'live', codexNetwork: true })).toEqual({
      codexWebSearch: 'live',
      codexNetwork: true,
    })
    expect(agentProjectPrefsPatch({ codexWebSearch: 'everything', codexNetwork: 'yes' })).toEqual(
      {},
    )
    expect(agentProjectPrefsPatch(null)).toEqual({})
  })
})

describe('answers to a permission request', () => {
  it('last the session only when the person chose so, and only when allowing', () => {
    expect(agentPermissionAnswer(true, 'session')).toEqual({ allow: true, scope: 'session' })
    expect(agentPermissionAnswer(true, undefined)).toEqual({ allow: true, scope: 'once' })
    expect(agentPermissionAnswer(true, 'forever')).toEqual({ allow: true, scope: 'once' })
    expect(agentPermissionAnswer(false, 'session')).toEqual({ allow: false })
    expect(agentPermissionAnswer('true', 'session')).toEqual({ allow: false })
  })

  it('reach the session as given', async () => {
    const { m, project, answer } = manager()
    const started = await m.start(1, {
      provider: 'claude-code',
      projectRoot: project,
      mode: 'ask-commands',
    })
    if (!started.ok) throw new Error('did not start')
    m.answer(1, started.sessionId, 'r1', agentPermissionAnswer(true, 'session'))
    expect(answer).toHaveBeenCalledWith('r1', { allow: true, scope: 'session' })
  })
})

describe('the window', () => {
  const search: AgentActionView = { kind: 'web-search', tool: 'WebSearch', paths: [], target: 'q' }
  const page: AgentActionView = {
    kind: 'web-fetch',
    tool: 'WebFetch',
    paths: [],
    target: 'https://example.com/a',
    host: 'example.com',
  }

  it('offers a session-long allow for a search and for a page of a known site', () => {
    expect(agentPermissionChoices(search)).toEqual(['deny', 'allow-session', 'allow'])
    expect(agentPermissionChoices(page)).toEqual(['deny', 'allow-session', 'allow'])
    expect(agentSessionAllowLabel(search)).toBe('permAllowSearchSession')
    expect(agentSessionAllowLabel(page)).toBe('permAllowSiteSession')
    expect(agentPermissionChoices({ ...page, host: undefined })).toEqual(['deny', 'allow'])
    expect(agentPermissionChoices({ kind: 'command', tool: 'Bash', paths: [] })).toEqual([
      'deny',
      'allow',
    ])
    expect(agentWebPermissionLabel(search)).toBe('permWebSearch')
    expect(agentWebPermissionLabel(page)).toBe('permWebFetch')
    expect(agentWebPermissionLabel({ kind: 'read', tool: 'Read', paths: [] })).toBeUndefined()
  })

  it('warns when commands may reach the internet, and not otherwise', () => {
    expect(codexNetworkWarningShown({ codexWebSearch: 'cached', codexNetwork: true })).toBe(true)
    expect(codexNetworkWarningShown({ codexWebSearch: 'live', codexNetwork: false })).toBe(false)
    expect(codexNetworkWarningShown(null)).toBe(false)
    expect(agentWebText('ko', 'codexNetworkWarning')).toBe(
      "켜면 Codex가 실행하는 명령이 인터넷에 닿습니다. '이 프로젝트는 믿고 맡기기'에서는 묻지 않고 닿습니다. 받은 문서에 숨은 지시가 자료를 밖으로 보내게 할 수 있습니다.",
    )
    expect(agentWebText('ko', 'permAllowSearchSession')).toBe('이번 세션 동안 검색 허락')
    expect(agentWebText('ko', 'permAllowSiteSession')).toBe('이번 세션 동안 이 사이트 허락')
  })

  it('has every web string in all 21 languages', () => {
    const langs = Object.keys(agentWebStrings)
    expect(langs).toHaveLength(21)
    const keys = Object.keys(agentWebStrings.zh)
    for (const lang of langs) {
      const dict = agentWebStrings[lang as keyof typeof agentWebStrings] as Record<string, string>
      expect(Object.keys(dict).sort()).toEqual([...keys].sort())
      for (const key of keys) expect(dict[key]!.trim()).not.toBe('')
    }
  })
})
