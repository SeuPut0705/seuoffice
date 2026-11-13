import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'

// the script only runs git; this file imports nothing of the CLI, which needs the engine wasm
const tempDir = (): string => mkdtempSync(join(tmpdir(), 'changed-files-base-'))

const SCRIPT = join(__dirname, '../../../tools/changed-files-base.mjs')

let repo: string

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf-8' }).trim()
}

function commit(file: string): string {
  writeFileSync(join(repo, file), file)
  git('add', file)
  git('commit', '-q', '-m', file)
  return git('rev-parse', 'HEAD')
}

function base(env: Record<string, string>): { ok: boolean; out: string } {
  const r = spawnSync(process.execPath, [SCRIPT], {
    cwd: repo,
    encoding: 'utf-8',
    env: { PATH: process.env.PATH, ...env },
  })
  return { ok: r.status === 0, out: r.stdout.trim() }
}

describe('changed-files-base', () => {
  let mainTip: string

  beforeEach(() => {
    repo = tempDir()
    git('init', '-q', '-b', 'main')
    git('config', 'user.email', 'ci@example.com')
    git('config', 'user.name', 'ci')
    commit('a')
    mainTip = commit('b')
    git('update-ref', 'refs/remotes/origin/main', mainTip)
  })

  it('a run started by hand on main compares with the last commit that passed CI', () => {
    const green = git('rev-parse', 'HEAD~1')
    commit('c')
    const r = base({
      GITHUB_EVENT_NAME: 'workflow_dispatch',
      GITHUB_REF: 'refs/heads/main',
      LAST_GREEN_MAIN: green,
    })
    expect(r).toEqual({ ok: true, out: green })
  })

  it('fails on main when no passing commit is known, instead of checking no file', () => {
    for (const event of ['workflow_dispatch', 'push']) {
      expect(base({ GITHUB_EVENT_NAME: event, GITHUB_REF: 'refs/heads/main' }).ok).toBe(false)
    }
  })

  it('fails when the given base is not a commit of the checkout', () => {
    const r = base({
      GITHUB_EVENT_NAME: 'push',
      GITHUB_REF: 'refs/heads/main',
      LAST_GREEN_MAIN: '0123456789abcdef0123456789abcdef01234567',
    })
    expect(r.ok).toBe(false)
  })

  it('a branch compares with where it left main, also when started by hand', () => {
    git('checkout', '-q', '-b', 'feat/x')
    commit('c')
    commit('d')
    const r = base({ GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/feat/x' })
    expect(r).toEqual({ ok: true, out: mainTip })
  })

  it('a pull request compares with the first parent of its merge commit', () => {
    git('checkout', '-q', '-b', 'feat/y')
    commit('c')
    git('checkout', '-q', 'main')
    git('merge', '-q', '--no-ff', '-m', 'merge', 'feat/y')
    const r = base({ GITHUB_EVENT_NAME: 'pull_request', GITHUB_REF: 'refs/pull/1/merge' })
    expect(r).toEqual({ ok: true, out: mainTip })
  })
})
