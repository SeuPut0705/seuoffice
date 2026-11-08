import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Simulates Windows' Controlled Folder Access on <root>/Documents: a create
// there fails with ENOENT although the parent exists. A recursive mkdirSync
// would retry that forever on Windows, so treat any recursive call as a hang.
const blocked = { prefix: '' }
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const mkdirSync = ((path: string, options?: { recursive?: boolean }) => {
    if (options?.recursive)
      throw new Error('recursive mkdirSync spins under Controlled Folder Access')
    if (blocked.prefix && String(path).startsWith(blocked.prefix)) {
      throw Object.assign(new Error(`ENOENT: no such file or directory, mkdir '${path}'`), {
        code: 'ENOENT',
      })
    }
    return actual.mkdirSync(path)
  }) as typeof actual.mkdirSync
  return { ...actual, mkdirSync, default: { ...actual, mkdirSync } }
})

const { isUsableSaveDir, resolveDefaultSaveDir } = await import('../src/default-save-dir')

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'genoffice-save-dir-blocked-'))
  blocked.prefix = join(root, 'Documents')
})

afterEach(() => {
  blocked.prefix = ''
  rmSync(root, { recursive: true, force: true })
})

describe('default save dir under Controlled Folder Access', () => {
  it('reports a blocked folder as unusable instead of retrying the create', () => {
    expect(isUsableSaveDir(join(root, 'Documents', 'IeumOffice'))).toBe(false)
  })

  it('still creates nested missing folders one level at a time', () => {
    const nested = join(root, 'home', 'IeumOffice', 'drafts')
    expect(isUsableSaveDir(nested)).toBe(true)
    expect(existsSync(nested)).toBe(true)
  })

  it('falls through to the next fallback when Documents is blocked', () => {
    const home = join(root, 'home', 'IeumOffice')
    expect(resolveDefaultSaveDir(null, [join(root, 'Documents', 'IeumOffice'), home])).toBe(home)
  })
})
