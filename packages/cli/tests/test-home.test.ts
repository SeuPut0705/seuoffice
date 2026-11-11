import { spawnSync } from 'node:child_process'
import { existsSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { auditLogPath } from '../src/audit'
import { HOME_DIR_NAME } from '../src/names'
import { run, tempDir } from './helpers'

// The runner gives every test process a throwaway home folder (vitest.config.ts
// loads tools/test-home.ts), so a test that forgets to redirect a per-user path
// cannot reach the folders of the person running the suite. Without it, each
// run of this suite appended some 1,500 lines to the real ~/.ieumoffice audit
// log and pushed it through its size rotation.

function isInside(parent: string, child: string): boolean {
  const rel = relative(realpathSync(parent), realpathSync(child))
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

describe('the home folder tests run with', () => {
  it('is a throwaway folder inside the OS temp dir', () => {
    expect(isInside(tmpdir(), homedir())).toBe(true)
  })

  it('takes the audit log of a command run with the inherited environment', async () => {
    const log = join(homedir(), HOME_DIR_NAME, 'cli-audit.jsonl')
    expect(auditLogPath(process.env)).toBe(log)
    const csv = join(tempDir(), 'a.csv')
    writeFileSync(csv, 'x,y\n1,2\n')
    expect((await run(['info', csv, '--json'])).code).toBe(0)
    expect(existsSync(log)).toBe(true)
  })

  it('is the home of a child process too', () => {
    const child = spawnSync(process.execPath, ['-p', 'require("node:os").homedir()'], {
      encoding: 'utf8',
    })
    expect(child.stdout.trim()).toBe(homedir())
  })
})
