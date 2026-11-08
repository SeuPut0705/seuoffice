/**
 * The environment a subscription CLI is started with: a copy of the app's own
 * environment without the variables that would route the CLI to a billing path
 * other than the user's subscription.
 */
import { delimiter, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SUBSCRIPTION_STRIPPED_ENV_VARS, subscriptionChildEnv } from '../src/subscription'

const SPEC_LIST = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
]

describe('subscriptionChildEnv', () => {
  it('strips every variable the spec lists', () => {
    for (const name of SPEC_LIST) expect(SUBSCRIPTION_STRIPPED_ENV_VARS).toContain(name)
    const base: NodeJS.ProcessEnv = { KEEP_ME: 'yes' }
    for (const name of SPEC_LIST) base[name] = 'value'
    const env = subscriptionChildEnv({ base, platform: 'linux' })
    for (const name of SPEC_LIST) expect(name in env).toBe(false)
    expect(env.KEEP_ME).toBe('yes')
  })

  it('strips the same-purpose switches the CLIs document', () => {
    const added = [
      'CLAUDE_CODE_USE_FOUNDRY',
      'CLAUDE_CODE_USE_MANTLE',
      'CLAUDE_CODE_USE_ANTHROPIC_AWS',
      'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD',
      'ANTHROPIC_CUSTOM_HEADERS',
      'ANTHROPIC_PROFILE',
      'ANTHROPIC_FEDERATION_RULE_ID',
      'CODEX_API_KEY',
      'CODEX_ACCESS_TOKEN',
    ]
    const base: NodeJS.ProcessEnv = {}
    for (const name of added) base[name] = 'value'
    const env = subscriptionChildEnv({ base, platform: 'linux' })
    for (const name of added) expect(name in env).toBe(false)
    expect([...SUBSCRIPTION_STRIPPED_ENV_VARS].sort()).toEqual([...SPEC_LIST, ...added].sort())
  })

  it('never mutates the environment it copies, process.env included', () => {
    const base: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: 'sk-ant', PATH: '/usr/bin' }
    const snapshot = { ...base }
    subscriptionChildEnv({ base, platform: 'linux', command: '/opt/tools/claude' })
    expect(base).toEqual(snapshot)

    process.env.ANTHROPIC_API_KEY = 'sk-from-process'
    process.env.OPENAI_API_KEY = 'sk-openai'
    try {
      const env = subscriptionChildEnv()
      expect(env.ANTHROPIC_API_KEY).toBeUndefined()
      expect(env.OPENAI_API_KEY).toBeUndefined()
      expect(process.env.ANTHROPIC_API_KEY).toBe('sk-from-process')
      expect(process.env.OPENAI_API_KEY).toBe('sk-openai')
      expect(env).not.toBe(process.env)
    } finally {
      delete process.env.ANTHROPIC_API_KEY
      delete process.env.OPENAI_API_KEY
    }
  })

  it('matches names without regard to case on Windows, exactly elsewhere', () => {
    const base: NodeJS.ProcessEnv = { Anthropic_Api_Key: 'a', openai_api_key: 'b' }
    const windows = subscriptionChildEnv({ base, platform: 'win32' })
    expect(Object.keys(windows)).toEqual([])
    const linux = subscriptionChildEnv({ base, platform: 'linux' })
    expect(linux).toEqual(base)
  })

  it('gives Windows children a HOME when only USERPROFILE is set', () => {
    const env = subscriptionChildEnv({
      base: { USERPROFILE: 'C:\\Users\\tester' },
      platform: 'win32',
    })
    expect(env.HOME).toBe('C:\\Users\\tester')
    const kept = subscriptionChildEnv({
      base: { USERPROFILE: 'C:\\Users\\tester', HOME: 'D:\\home' },
      platform: 'win32',
    })
    expect(kept.HOME).toBe('D:\\home')
    const posix = subscriptionChildEnv({ base: { USERPROFILE: '/x' }, platform: 'linux' })
    expect(posix.HOME).toBeUndefined()
  })

  it("prepends the program's directory to PATH, keeping the existing key's spelling", () => {
    const command = join(process.cwd(), 'bin', 'codex.exe')
    const env = subscriptionChildEnv({ base: { Path: 'C:\\Windows' }, platform: 'win32', command })
    expect(env.Path).toBe(`${join(process.cwd(), 'bin')}${delimiter}C:\\Windows`)
    expect(env.PATH).toBeUndefined()
    const bare = subscriptionChildEnv({
      base: { PATH: '/usr/bin' },
      platform: 'linux',
      command: 'codex',
    })
    expect(bare.PATH).toBe('/usr/bin')
  })

  it('adds what the launch itself needs, after the stripping', () => {
    const env = subscriptionChildEnv({
      base: { ELECTRON_RUN_AS_NODE: '0' },
      platform: 'linux',
      extra: { ELECTRON_RUN_AS_NODE: '1' },
    })
    expect(env.ELECTRON_RUN_AS_NODE).toBe('1')
  })
})
