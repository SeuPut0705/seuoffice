import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const SHELL = resolve(import.meta.dirname, '..')
const OVERLAY = resolve(SHELL, 'electron-builder.seuoffice.cjs')
const BASE = resolve(SHELL, 'electron-builder.cjs')
const ENV_NAMES = [
  'CSC_LINK',
  'APPLE_ID',
  'APPLE_APP_SPECIFIC_PASSWORD',
  'APPLE_TEAM_ID',
  'GENOFFICE_MAC_X64',
  'GENOFFICE_WIN_ARM64',
  'SEUOFFICE_UPDATE_CHANNEL',
]
const saved = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]))

/** The release config as a build host with this environment loads it. */
function loadRelease(env: Record<string, string> = {}) {
  for (const name of ENV_NAMES) delete process.env[name]
  Object.assign(process.env, env)
  delete require.cache[OVERLAY]
  delete require.cache[BASE]
  return require(OVERLAY)
}

afterEach(() => {
  for (const name of ENV_NAMES) {
    if (saved[name] === undefined) delete process.env[name]
    else process.env[name] = saved[name]
  }
  delete require.cache[OVERLAY]
  delete require.cache[BASE]
})

// electron-builder's Arch enum: x64 = 1, arm64 = 3
const X64 = 1
const ARM64 = 3

describe('the seuoffice release packages', () => {
  it('are an Apple Silicon Mac dmg and update zip and an x64 Windows installer, nothing else', () => {
    const config = loadRelease()
    expect(config.mac.target).toEqual([
      { target: 'dmg', arch: ['arm64'] },
      { target: 'zip', arch: ['arm64'] },
    ])
    expect(config.win.target).toEqual([{ target: 'nsis', arch: ['x64'] }])
    for (const key of ['linux', 'deb', 'rpm', 'appImage']) expect(config[key], key).toBeUndefined()
  })

  it('refuses to pack any other platform or CPU', async () => {
    const config = loadRelease()
    for (const [platform, arch] of [
      ['linux', X64],
      ['darwin', X64],
      ['win32', ARM64],
    ] as const) {
      await expect(
        config.beforePack({ electronPlatformName: platform, arch }),
        `${platform} ${arch}`,
      ).rejects.toThrow(/does not release/)
    }
  })

  it('refuses the upstream switches for the Intel Mac and ARM Windows packages', () => {
    expect(() => loadRelease({ GENOFFICE_MAC_X64: '1' })).toThrow(/does not release/)
    expect(() => loadRelease({ GENOFFICE_WIN_ARM64: '1' })).toThrow(/does not release/)
  })

  it('names the stable build so both builds fit in one release', () => {
    const latest = loadRelease()
    const stable = loadRelease({ SEUOFFICE_UPDATE_CHANNEL: 'stable' })
    expect(stable.publish[0].channel).toBe('stable')
    expect(stable.dmg.artifactName).not.toBe(latest.dmg.artifactName)
    expect(stable.mac.artifactName).toContain('-stable')
    expect(stable.nsis.artifactName).not.toBe(latest.nsis.artifactName)
  })
})

describe('Mac signing', () => {
  it('stays ad hoc without a certificate', () => {
    const config = loadRelease()
    expect(config.mac.identity).toBe('-')
    expect(config.mac.notarize).toBe(false)
    expect(config.dmg.sign).toBe(false)
  })

  it('signs with the Developer ID certificate and notarizes when one is given', () => {
    const config = loadRelease({
      CSC_LINK: 'base64-p12',
      APPLE_ID: 'dev@example.test',
      APPLE_APP_SPECIFIC_PASSWORD: 'secret',
      APPLE_TEAM_ID: 'TEAM123456',
    })
    expect('identity' in config.mac).toBe(false)
    expect(config.mac.hardenedRuntime).toBe(true)
    expect(config.mac.notarize).toBe(true)
    expect(config.dmg.sign).toBe(true)
  })

  it('refuses a certificate without the notarization credentials', () => {
    expect(() => loadRelease({ CSC_LINK: 'base64-p12', APPLE_ID: 'dev@example.test' })).toThrow(
      /APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID/,
    )
  })
})
