import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { HomeApi } from '../src/shared/home-api'
import { HOME_CHANNELS } from '../src/shared/home-api'

const electronMocks = vi.hoisted(() => ({
  exposed: new Map<string, unknown>(),
  invoke: vi.fn(),
}))

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (name: string, api: unknown) => electronMocks.exposed.set(name, api),
  },
  ipcRenderer: {
    invoke: electronMocks.invoke,
    send: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
  },
  // the preload imports @genoffice/electron-utils (drop-open bridge), which
  // binds webUtils at module scope even though node env never installs it
  webUtils: { getPathForFile: () => '' },
}))

/**
 * The shell no longer sends usage statistics, asks for a GitHub star, lists
 * cloud projects, or signs in to an account of its own. These checks keep the
 * removed modules, their IPC and their callers from coming back (e.g. with an
 * upstream merge).
 */

const SRC = join(__dirname, '../src')

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return /\.(ts|tsx|css|html)$/.test(entry.name) ? [path] : []
  })
}

const files = sourceFiles(SRC).map((path) => ({
  name: relative(SRC, path).replace(/\\/g, '/'),
  text: readFileSync(path, 'utf8'),
}))

/** the files (relative to src) whose text matches */
function matching(pattern: RegExp, skip: (name: string) => boolean = () => false): string[] {
  return files.filter((file) => !skip(file.name) && pattern.test(file.text)).map((f) => f.name)
}

/** the dictionary still carries retired texts until they are pruned; nothing renders them */
const isDictionary = (name: string) =>
  name === 'renderer/src/strings.ts' || name.startsWith('renderer/src/i18n/')

describe('removed shell modules', () => {
  it.each([
    'main/analytics.ts',
    'main/star-prompt.ts',
    'main/cloud-projects.ts',
    'renderer/src/StarPromptCard.tsx',
    'renderer/src/star-prompt.css',
  ])('%s is gone', (name) => {
    expect(existsSync(join(SRC, name))).toBe(false)
  })

  it('have no importer left', () => {
    expect(
      matching(/from\s+['"][^'"]*\/(analytics|star-prompt|cloud-projects|StarPromptCard)['"]/),
    ).toEqual([])
    expect(matching(/star-prompt\.css/)).toEqual([])
  })

  it('leave no call site behind in the main process', () => {
    const main = (name: string) => !name.startsWith('main/')
    expect(matching(/\banalytics\b|\btrack\(\s*['"]/i, main)).toEqual([])
    expect(matching(/StarPrompt|starPrompt|fetchGithubStars|stargazers/, main)).toEqual([])
    expect(matching(/cloudProject|CloudProject/, main)).toEqual([])
    expect(matching(/CREDIT_USAGE_URL|credit-usage/, main)).toEqual([])
    expect(matching(/startGenofficeLogin|genofficeLogout/)).toEqual([])
  })

  it('leave no caller behind in the renderer and the preload', () => {
    const removed =
      /\b(accountStatus|accountLogin|onAccountLogin|openLoginUrl|accountLogout|getAnalyticsEnabled|setAnalyticsEnabled|openCreditUsage|githubStars|starPromptShouldShow|starPromptAction|cloudProjectsCached|cloudProjectsSync|openCloudProject)\b/
    expect(matching(removed, isDictionary)).toEqual([])
    expect(
      matching(/AccountStatus|AccountLoginEvent|CloudProjectsSnapshot|StarPromptShow/),
    ).toEqual([])
  })
})

describe('home IPC contract', () => {
  it('has no channel of a removed feature', () => {
    const names = Object.keys(HOME_CHANNELS).join(' ')
    expect(names).not.toMatch(/account|analytics|starPrompt|githubStars|cloud|credit/i)
    expect(Object.values(HOME_CHANNELS).join(' ')).not.toMatch(
      /account|analytics|star-prompt|github-stars|cloud|credit/i,
    )
    // the onboarding flag and the link to the project stay
    expect(HOME_CHANNELS.setOnboardingSeen).toBe('home:set-onboarding-seen')
    expect(HOME_CHANNELS.openGitHubRepo).toBe('home:open-github-repo')
  })
})

describe('home preload API', () => {
  let homeApi: HomeApi

  beforeAll(async () => {
    await import('../src/preload/index')
    homeApi = electronMocks.exposed.get('aiOffice') as HomeApi
  })

  it('exposes no member of a removed feature', () => {
    const members = Object.keys(homeApi)
    expect(members.filter((name) => /account|analytics|star|cloud|credit/i.test(name))).toEqual([
      'starred',
      'starredGroups',
      'setStarredGroup',
      'toggleStar',
      'unstarPaths',
    ])
  })

  it('still records that the onboarding was finished', async () => {
    electronMocks.invoke.mockResolvedValue(true)
    await expect(homeApi.setOnboardingSeen()).resolves.toBe(true)
    expect(electronMocks.invoke).toHaveBeenLastCalledWith(HOME_CHANNELS.setOnboardingSeen)
  })
})
