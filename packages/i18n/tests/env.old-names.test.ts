import { describe, expect, it, vi } from 'vitest'
import { adoptOldEnv, existingOrCurrent, OLD_ENV_NAMES } from '../src/index'

describe('environment variables a person was told to set under the old prefix', () => {
  it('are honoured under the new name', () => {
    const env: Record<string, string | undefined> = {
      GENOFFICE_USER_DATA: '/data/profile',
      GENOFFICE_ALLOWED_ROOTS: '/a:/b',
      PATH: '/usr/bin',
    }
    expect(adoptOldEnv(env).sort()).toEqual(['SEUOFFICE_ALLOWED_ROOTS', 'SEUOFFICE_USER_DATA'])
    expect(env.SEUOFFICE_USER_DATA).toBe('/data/profile')
    expect(env.SEUOFFICE_ALLOWED_ROOTS).toBe('/a:/b')
    expect(env.PATH).toBe('/usr/bin')
  })

  it('are every one of them taken over', () => {
    const env: Record<string, string | undefined> = {}
    for (const name of OLD_ENV_NAMES) env[`GENOFFICE_${name}`] = `value of ${name}`
    adoptOldEnv(env)
    for (const name of OLD_ENV_NAMES) expect(env[`SEUOFFICE_${name}`]).toBe(`value of ${name}`)
  })

  it('include the home and language a person set for the command and the app (docs/operations.md)', () => {
    const env: Record<string, string | undefined> = {
      GENOFFICE_HOME: '/Users/kim/agent-home',
      GENOFFICE_LANG: 'ko',
    }
    expect(adoptOldEnv(env).sort()).toEqual(['SEUOFFICE_HOME', 'SEUOFFICE_LANG'])
    expect(env.SEUOFFICE_HOME).toBe('/Users/kim/agent-home')
    expect(env.SEUOFFICE_LANG).toBe('ko')
  })

  it('never override a value set under the new name, even an empty one', () => {
    const env: Record<string, string | undefined> = {
      GENOFFICE_AUDIT_LOG: '/old/audit.jsonl',
      SEUOFFICE_AUDIT_LOG: 'off',
      GENOFFICE_MCP_TOKEN: 'old-token',
      SEUOFFICE_MCP_TOKEN: '',
    }
    expect(adoptOldEnv(env)).toEqual([])
    expect(env.SEUOFFICE_AUDIT_LOG).toBe('off')
    expect(env.SEUOFFICE_MCP_TOKEN).toBe('')
  })

  it('leave the old variable in place for a child process that still reads it', () => {
    const env: Record<string, string | undefined> = { GENOFFICE_APP_BIN: '/opt/app' }
    adoptOldEnv(env)
    expect(env.GENOFFICE_APP_BIN).toBe('/opt/app')
  })

  it('do not include the build, development and test variables, which were only renamed', () => {
    const env: Record<string, string | undefined> = {
      GENOFFICE_FAKE_UPDATE: '1',
      GENOFFICE_WIN_ARM64: '1',
      GENOFFICE_NODE: '/usr/bin/node',
    }
    expect(adoptOldEnv(env)).toEqual([])
    expect(Object.keys(env).filter((key) => key.startsWith('SEUOFFICE_'))).toEqual([])
  })

  it('reach a process whose entry point loads the take-over module, and no other way', async () => {
    const saved = { ...process.env }
    try {
      process.env.GENOFFICE_MCP_TOKEN = 'set-by-the-user'
      delete process.env.SEUOFFICE_MCP_TOKEN
      vi.resetModules()
      await import('../src/index')
      expect(process.env.SEUOFFICE_MCP_TOKEN).toBeUndefined()
      await import('../src/old-names-env')
      expect(process.env.SEUOFFICE_MCP_TOKEN).toBe('set-by-the-user')
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
      for (const [key, value] of Object.entries(saved)) process.env[key] = value
    }
  })
})

describe('a location that may exist under an old name', () => {
  it('is the old one when only that exists, so nothing is copied or moved', () => {
    expect(existingOrCurrent('.seuoffice', ['.ieumoffice'], (name) => name === '.ieumoffice')).toBe(
      '.ieumoffice',
    )
  })

  it('is the current one on a machine that never had the old one', () => {
    expect(existingOrCurrent('.seuoffice', ['.ieumoffice'], () => false)).toBe('.seuoffice')
  })

  it('is the current one when both exist, so an old one made later hides nothing', () => {
    expect(existingOrCurrent('.seuoffice', ['.ieumoffice'], () => true)).toBe('.seuoffice')
  })
})
