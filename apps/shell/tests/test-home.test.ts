import { realpathSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

// The runner gives every test process a throwaway home folder (vitest.config.ts
// loads tools/test-home.ts), so a test that forgets to redirect a per-user path
// cannot reach the folders of the person running the suite. Without it the MCP
// acceptance test, which runs the real CLI in process, appended to the real
// ~/.seuoffice audit log on every run.

describe('the home folder tests run with', () => {
  it('is a throwaway folder inside the OS temp dir', () => {
    const rel = relative(realpathSync(tmpdir()), realpathSync(homedir()))
    expect(rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)).toBe(true)
  })
})
