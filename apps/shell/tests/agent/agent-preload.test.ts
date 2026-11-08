/**
 * The Home preload and the agent window's preload share no module. A module
 * both import is split into a chunk, a sandboxed preload cannot load a chunk,
 * and the whole Home preload then fails to run (it happened while building
 * agent mode). Read from the sources, so it holds without a build.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const preload = (name: string) => readFileSync(join(__dirname, '../../src/preload', name), 'utf8')

function localImports(source: string): string[] {
  return [...source.matchAll(/^import\s+(?!type\b)[^'"]*from\s+'(\.[^']+)'/gm)].map((m) => m[1]!)
}

describe('preload bundles', () => {
  it('give Home only the agent window channel name, from its own file', () => {
    const home = localImports(preload('index.ts'))
    expect(home).toContain('../shared/agent-home-channel')
    expect(home).not.toContain('../shared/agent-api')
  })

  it('share no local module between the Home and agent preloads', () => {
    const home = new Set(localImports(preload('index.ts')))
    const shared = localImports(preload('agent.ts')).filter((path) => home.has(path))
    expect(shared).toEqual([])
  })
})
