import { describe, expect, it, vi } from 'vitest'
import { CommandRegistry } from '../src/registry'
import { run } from './helpers'

const env = { ...process.env, GENOFFICE_AUDIT_LOG: 'off' }

function probe() {
  const invoke = vi.fn(async () => ({ summary: 'invoked' }))
  const registry = new CommandRegistry().register({
    name: 'probe',
    summary: 'test command',
    usage: 'probe [--force]',
    options: [{ name: 'force', description: 'test boolean' }],
    run: invoke,
  })
  return { invoke, registry }
}

describe('runCli syntax errors stay inside the result contract', () => {
  it.each([
    ['probe', '--force=false', '--json'],
    ['--json', 'probe', '--force=true'],
    ['probe', '--force=', '--json'],
    ['probe', '--json=false', '--json'],
    ['probe', '--help=true', '--json'],
    ['probe', '--version=1', '--json'],
  ])('returns a JSON usage error for %j without invoking a command', async (...argv) => {
    const { invoke, registry } = probe()
    const r = await run(argv, { registry, env })
    expect(r.code).toBe(1)
    expect(r.json()).toMatchObject({
      status: 'error',
      command: null,
      code: 1,
      error: 'invalid_argument',
    })
    expect(r.json().message).toContain('boolean flag')
    expect(r.stderr).toBe('')
    expect(invoke).not.toHaveBeenCalled()
  })

  it.each([
    ['probe', '--force=false'],
    ['probe', '--force=false', '--', '--json'],
  ])('returns a human usage error for %j', async (...argv) => {
    const { invoke, registry } = probe()
    const r = await run(argv, { registry, env })
    expect(r.code).toBe(1)
    expect(r.stdout).toBe('')
    expect(r.stderr).toContain('boolean flag')
    expect(r.stderr).not.toContain('at parseArgs')
    expect(invoke).not.toHaveBeenCalled()
  })

  it.each([
    ['--json', 'probe', '--force'],
    ['probe', '--json', '--', '--force=false'],
  ])('keeps valid flags and literal post-terminator tokens for %j', async (...argv) => {
    const { invoke, registry } = probe()
    const r = await run(argv, { registry, env })
    expect(r.code).toBe(0)
    expect(r.json()).toMatchObject({ status: 'ok', command: 'probe', summary: 'invoked' })
    expect(invoke).toHaveBeenCalledTimes(1)
  })
})
