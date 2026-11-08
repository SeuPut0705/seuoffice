import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import FpmTarget from 'app-builder-lib/out/targets/FpmTarget'

/**
 * What the deb declares as its package dependencies. Ubuntu 24.04 and Debian
 * 13 rebuilt part of electron-builder's default deb dependency set for 64-bit
 * time_t and renamed those packages with a "t64" suffix; where the old name is
 * gone (some of it on every architecture, the rest on 32-bit ones), apt
 * refuses the whole deb ("libnotify4 … is not installable"). Setting `depends`
 * makes electron-builder drop its default list wholesale, so
 * electron-builder.cjs spells the defaults out with "plain | t64"
 * alternatives. This test pins that list against the defaults of the
 * installed app-builder-lib — a version bump that changes them fails here,
 * not in the next release's installs — and against the renamed set.
 */

const require = createRequire(import.meta.url)
const SHELL = resolve(import.meta.dirname, '..')

/** The packaging config as a build host with this environment would load it
 * (same approach as product-identity.test.ts). */
function loadBuilderConfig() {
  const configModule = { exports: {} as ReturnType<typeof require> }
  runInNewContext(readFileSync(join(SHELL, 'electron-builder.cjs'), 'utf8'), {
    module: configModule,
    __dirname: SHELL,
    process: { platform: 'win32', arch: 'x64', env: {} },
    require: (id: string) =>
      id === 'node:fs' ? { ...require(id), existsSync: () => true } : require(id),
  })
  return configModule.exports
}

const config = loadBuilderConfig()

/** electron-builder's own default depends for deb (FpmTarget.getDefaultDepends). */
function electronBuilderDefaults(): string[] {
  const proto = FpmTarget.prototype as unknown as { getDefaultDepends(target: string): string[] }
  return proto.getDefaultDepends('deb')
}

/** Renamed in the time_t transition; only the t64 name installs where the
 * plain one was dropped, so each of these needs the alternative spelled out. */
const T64_RENAMED = ['libgtk-3-0', 'libnotify4', 'libxtst6', 'libatspi2.0-0', 'libsecret-1-0']

describe('the deb dependencies', () => {
  const depends: string[] = config.deb.depends

  it("keeps every name electron-builder's default list carries", () => {
    const defaults = electronBuilderDefaults()
    expect(defaults.length).toBeGreaterThan(0)
    for (const name of defaults) {
      expect(
        depends.some((entry) => entry === name || entry.startsWith(`${name} | `)),
        `${name} (an electron-builder default) is missing from deb.depends`,
      ).toBe(true)
    }
  })

  it('adds the t64 name next to every renamed dependency', () => {
    // Ubuntu 24.04's own apt ask: "libnotify4 … is not installable" (the 64-bit
    // time_t rename); "a | b" lets the distribution's apt pick.
    for (const name of T64_RENAMED) {
      expect(depends, name).toContain(`${name} | ${name}t64`)
    }
  })

  it('declares nothing beyond the defaults and their t64 alternatives', () => {
    const known = new Set(
      electronBuilderDefaults().flatMap((name) => [name, `${name} | ${name}t64`]),
    )
    for (const entry of depends) {
      expect(known.has(entry), entry).toBe(true)
    }
  })
})
