/**
 * The two buttons of a provider that is not connected: sign in (the CLI's own
 * login command) and install (the vendor's fixed install command in a terminal
 * window the user can see).
 */
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import {
  SUBSCRIPTION_INSTALL_COMMANDS,
  SUBSCRIPTION_INSTALL_URLS,
  SUBSCRIPTION_LOGIN_ARGS_ENV,
  SUBSCRIPTION_LOGIN_EXE_ENV,
  SUBSCRIPTION_LOGOUT_TIMEOUT_MS,
  createSubscriptionChildRegistry,
  launchSubscriptionInstall,
  launchSubscriptionLogin,
  launchSubscriptionLogout,
  notifySubscriptionLoginChange,
  onSubscriptionLoginChange,
  subscriptionInstallCommandLine,
  type SubscriptionProgram,
} from '../src/subscription'
import type { AiSubscriptionCliId, AiSubscriptionProviderId } from '../src/types'

class FakeChild extends EventEmitter {
  unrefs = 0
  constructor(readonly pid: number | undefined) {
    super()
  }
  kill(): boolean {
    return true
  }
  unref(): void {
    this.unrefs++
  }
}

interface SpawnCall {
  command: string
  args: string[]
  options: Record<string, unknown>
  child: FakeChild
}

function recorder(): {
  calls: SpawnCall[]
  spawn: (command: string, args: string[], options: object) => FakeChild
} {
  const calls: SpawnCall[] = []
  return {
    calls,
    spawn: (command, args, options) => {
      const child = new FakeChild(4321)
      calls.push({ command, args, options: options as Record<string, unknown>, child })
      return child
    },
  }
}

const SYSTEM32 = 'C:\\Windows\\System32'
const POWERSHELL = `${SYSTEM32}\\WindowsPowerShell\\v1.0\\powershell.exe`
const WINDOWS = { SystemRoot: 'C:\\Windows' }
/** Values a system directory must not be taken from: completed from the working directory, or not a path */
const NOT_FULL_PATHS = [
  '.',
  'Windows',
  '\\Windows',
  'C:Windows',
  'C:\\x" & calc.exe & "',
  'C:\\%X%',
]

function program(provider: AiSubscriptionCliId): SubscriptionProgram {
  const command = provider === 'codex' ? 'C:\\npm\\codex.exe' : 'C:\\npm\\claude.exe'
  return { provider, command, prefixArgs: [], env: {}, entry: command, source: 'npm' }
}

function envOf(call: SpawnCall): NodeJS.ProcessEnv {
  return call.options.env as NodeJS.ProcessEnv
}

describe('launchSubscriptionLogin', () => {
  it("opens the CLI's own login command in a console window of its own", async () => {
    const scripts: string[] = []
    for (const [provider, args] of [
      ['claude-code', 'auth\nlogin'],
      ['codex', 'login'],
    ] as const) {
      const { calls, spawn } = recorder()
      const result = await launchSubscriptionLogin(provider, {
        locate: async () => program(provider),
        spawn,
        platform: 'win32',
        baseEnv: { ...WINDOWS, ANTHROPIC_API_KEY: 'sk-ant', OPENAI_API_KEY: 'sk-oai', KEEP: '1' },
        registry: null,
      })
      expect(result).toEqual({ ok: true })
      expect(calls).toHaveLength(1)
      const call = calls[0]!
      // Start-Process is what gives the login a window; the launcher itself stays hidden
      expect(call.command).toBe(POWERSHELL)
      expect(call.args.at(-2)).toBe('-Command')
      expect(call.args.at(-1)).toContain('Start-Process')
      expect(call.options.shell).toBeUndefined()
      expect(call.options.windowsHide).toBe(true)
      // not the folder the app was started in (the document's, on a double-click)
      expect(call.options.cwd).toBe(SYSTEM32)
      expect(call.options.cwd).not.toBe(process.cwd())
      scripts.push(call.args.at(-1)!)
      // the program and its arguments travel as data, not as script text
      expect(envOf(call)[SUBSCRIPTION_LOGIN_EXE_ENV]).toBe(program(provider).command)
      expect(envOf(call)[SUBSCRIPTION_LOGIN_ARGS_ENV]).toBe(args)
      expect(call.args.join(' ')).not.toContain(program(provider).command)
      expect(envOf(call).ANTHROPIC_API_KEY).toBeUndefined()
      expect(envOf(call).OPENAI_API_KEY).toBeUndefined()
      expect(envOf(call).KEEP).toBe('1')
    }
    // one constant script, whatever is being started
    expect(new Set(scripts).size).toBe(1)
  })

  it('a hostile configured path cannot become part of the script', async () => {
    const hostile = 'C:\\x\\codex.exe"; Remove-Item -Recurse C:\\ #'
    const { calls, spawn } = recorder()
    await launchSubscriptionLogin('codex', {
      locate: async () => ({ ...program('codex'), command: hostile }),
      spawn,
      platform: 'win32',
      baseEnv: WINDOWS,
      registry: null,
    })
    const plain = recorder()
    await launchSubscriptionLogin('codex', {
      locate: async () => program('codex'),
      spawn: plain.spawn,
      platform: 'win32',
      baseEnv: WINDOWS,
      registry: null,
    })
    expect(calls[0]!.args).toEqual(plain.calls[0]!.args)
    expect(envOf(calls[0]!)[SUBSCRIPTION_LOGIN_EXE_ENV]).toBe(hostile)
  })

  it('registers the login for shutdown, so it does not outlive the app', async () => {
    const killed: number[] = []
    const registry = createSubscriptionChildRegistry({ killTree: (pid) => killed.push(pid) })
    const { calls, spawn } = recorder()
    await launchSubscriptionLogin('claude-code', {
      locate: async () => program('claude-code'),
      spawn,
      platform: 'win32',
      baseEnv: WINDOWS,
      registry,
    })
    expect(registry.size).toBe(1)
    registry.shutdown()
    expect(killed).toEqual([calls[0]!.child.pid])
  })

  it('elsewhere starts the CLI directly; its login runs in the browser it opens', async () => {
    const { calls, spawn } = recorder()
    const result = await launchSubscriptionLogin('claude-code', {
      locate: async () => program('claude-code'),
      spawn,
      platform: 'darwin',
      baseEnv: { ANTHROPIC_API_KEY: 'sk-ant' },
      registry: null,
    })
    expect(result).toEqual({ ok: true })
    expect(calls[0]!.command).toBe(program('claude-code').command)
    expect(calls[0]!.args).toEqual(['auth', 'login'])
    expect(calls[0]!.options.shell).toBeUndefined()
    expect(calls[0]!.options.cwd).toBe(tmpdir())
    expect(calls[0]!.options.cwd).not.toBe(process.cwd())
    expect(envOf(calls[0]!).ANTHROPIC_API_KEY).toBeUndefined()
  })

  it('does not take the system directory from a value that is not a full path', async () => {
    for (const SystemRoot of NOT_FULL_PATHS) {
      const { calls, spawn } = recorder()
      await launchSubscriptionLogin('codex', {
        locate: async () => program('codex'),
        spawn,
        platform: 'win32',
        baseEnv: { SystemRoot },
        registry: null,
      })
      expect(calls[0]!.command).toBe(POWERSHELL)
      expect(calls[0]!.options.cwd).toBe(SYSTEM32)
    }
  })

  it('keeps the launcher arguments of a CLI that runs on a Node runtime', async () => {
    const { calls, spawn } = recorder()
    await launchSubscriptionLogin('codex', {
      locate: async () => ({
        ...program('codex'),
        command: 'C:\\app\\app.exe',
        prefixArgs: ['C:\\npm\\codex.js'],
        env: { ELECTRON_RUN_AS_NODE: '1' },
      }),
      spawn,
      platform: 'win32',
      baseEnv: WINDOWS,
      registry: null,
    })
    expect(envOf(calls[0]!)[SUBSCRIPTION_LOGIN_EXE_ENV]).toBe('C:\\app\\app.exe')
    expect(envOf(calls[0]!)[SUBSCRIPTION_LOGIN_ARGS_ENV]).toBe('C:\\npm\\codex.js\nlogin')
    expect(envOf(calls[0]!).ELECTRON_RUN_AS_NODE).toBe('1')
  })

  it('quotes an argument with a space, which Start-Process would otherwise split', async () => {
    const { calls, spawn } = recorder()
    await launchSubscriptionLogin('codex', {
      locate: async () => ({
        ...program('codex'),
        command: 'C:\\Program Files\\nodejs\\node.exe',
        prefixArgs: ['C:\\Users\\Ana María\\npm\\codex.js'],
      }),
      spawn,
      platform: 'win32',
      baseEnv: WINDOWS,
      registry: null,
    })
    expect(envOf(calls[0]!)[SUBSCRIPTION_LOGIN_EXE_ENV]).toBe('C:\\Program Files\\nodejs\\node.exe')
    expect(envOf(calls[0]!)[SUBSCRIPTION_LOGIN_ARGS_ENV]).toBe(
      '"C:\\Users\\Ana María\\npm\\codex.js"\nlogin',
    )
  })

  it('reports a missing program instead of starting anything', async () => {
    const { calls, spawn } = recorder()
    const result = await launchSubscriptionLogin('claude-code', {
      locate: async () => null,
      spawn,
      platform: 'win32',
    })
    expect(result).toEqual({
      ok: false,
      reason: 'not-installed',
      installUrl: SUBSCRIPTION_INSTALL_URLS['claude-code'],
    })
    expect(calls).toEqual([])
  })

  it('reports a login that could not be started', async () => {
    const result = await launchSubscriptionLogin('codex', {
      locate: async () => program('codex'),
      spawn: () => {
        throw new Error('spawn EPERM')
      },
      platform: 'win32',
      registry: null,
    })
    expect(result).toMatchObject({ ok: false, reason: 'failed' })
    expect(result.error).toContain('EPERM')
  })

  it('tells the caller when the login window is gone, so the status can be read again', async () => {
    const { calls, spawn } = recorder()
    let exits = 0
    await launchSubscriptionLogin('codex', {
      locate: async () => program('codex'),
      spawn,
      platform: 'win32',
      baseEnv: WINDOWS,
      registry: null,
      onExit: () => exits++,
    })
    expect(exits).toBe(0)
    calls[0]!.child.emit('exit', 0, null)
    expect(exits).toBe(1)
  })

  it('passes the configured path to the lookup', async () => {
    const seen: Array<string | undefined> = []
    await launchSubscriptionLogin('codex', {
      configuredPath: 'D:\\codex.exe',
      locate: async (_provider, options) => {
        seen.push(options?.configuredPath)
        return null
      },
      platform: 'win32',
    })
    expect(seen).toEqual(['D:\\codex.exe'])
  })

  it('rejects anything that is not a subscription provider', async () => {
    const { calls, spawn } = recorder()
    const result = await launchSubscriptionLogin('anthropic' as AiSubscriptionProviderId, {
      spawn,
      platform: 'win32',
    })
    expect(result).toEqual({ ok: false, reason: 'invalid' })
    expect(calls).toEqual([])
  })
})

describe('launchSubscriptionInstall', () => {
  it('uses exactly the vendor commands of spec 4.1', () => {
    expect(SUBSCRIPTION_INSTALL_COMMANDS).toEqual({
      'claude-code': 'irm https://claude.ai/install.ps1 | iex',
      codex: 'winget install OpenAI.Codex',
    })
  })

  it('the command line is a constant per provider, built from the vendor command alone', () => {
    // PowerShell by full path: `start` looks for a bare name in the working directory first
    expect(subscriptionInstallCommandLine('claude-code', WINDOWS)).toBe(
      `start "" "${POWERSHELL}" -NoLogo -NoExit -Command "irm https://claude.ai/install.ps1 | iex"`,
    )
    expect(subscriptionInstallCommandLine('codex', WINDOWS)).toBe(
      `start "" "${POWERSHELL}" -NoLogo -NoExit -Command "winget install OpenAI.Codex"`,
    )
    expect(subscriptionInstallCommandLine('codex', { SystemRoot: 'D:\\WinNT' })).toBe(
      'start "" "D:\\WinNT\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoLogo -NoExit -Command "winget install OpenAI.Codex"',
    )
  })

  it('a system directory that is not a full path never reaches the command line', () => {
    const standard = subscriptionInstallCommandLine('codex', WINDOWS)
    for (const SystemRoot of NOT_FULL_PATHS) {
      expect(subscriptionInstallCommandLine('codex', { SystemRoot })).toBe(standard)
    }
    expect(subscriptionInstallCommandLine('codex', {})).toBe(standard)
  })

  it('runs the fixed command in a new terminal window that stays open', async () => {
    for (const provider of ['claude-code', 'codex'] as const) {
      const { calls, spawn } = recorder()
      const result = await launchSubscriptionInstall(provider, {
        spawn,
        platform: 'win32',
        env: WINDOWS,
      })
      expect(result).toEqual({ ok: true })
      expect(calls).toHaveLength(1)
      const call = calls[0]!
      // the only shell in the module: cmd.exe by full path, given one constant line
      expect(call.options.shell).toBe('C:\\Windows\\System32\\cmd.exe')
      expect(call.command).toBe(subscriptionInstallCommandLine(provider, WINDOWS))
      expect(call.command).toContain(`"${POWERSHELL}"`)
      // not the folder the app was started in (the document's, on a double-click)
      expect(call.options.cwd).toBe(SYSTEM32)
      expect(call.options.cwd).not.toBe(process.cwd())
      expect(call.args).toEqual([])
      expect(call.command).toContain('-NoExit')
      // the installer window belongs to the user: the app does not hold on to it
      expect(call.child.unrefs).toBe(1)
    }
  })

  it('has no parameter through which other text could reach the command line', async () => {
    const { calls, spawn } = recorder()
    const hostile = 'codex; Remove-Item -Recurse C:\\' as unknown as AiSubscriptionProviderId
    const result = await launchSubscriptionInstall(hostile, { spawn, platform: 'win32' })
    expect(result).toMatchObject({ ok: false, reason: 'invalid' })
    expect(calls).toEqual([])

    await launchSubscriptionInstall('codex', {
      spawn,
      platform: 'win32',
      env: { ...WINDOWS, PATH: 'C:\\evil & calc.exe' },
      ...({ command: 'calc.exe', args: ['x'], configuredPath: 'calc.exe' } as object),
    })
    expect(calls[0]!.command).toBe(subscriptionInstallCommandLine('codex', WINDOWS))
    expect(calls[0]!.args).toEqual([])
    expect(calls[0]!.command).not.toContain('calc')
  })

  it('a command that cannot be started leaves the install page as the way forward', async () => {
    const result = await launchSubscriptionInstall('codex', {
      spawn: () => {
        throw new Error('spawn ENOENT')
      },
      platform: 'win32',
    })
    expect(result).toMatchObject({
      ok: false,
      reason: 'failed',
      installUrl: SUBSCRIPTION_INSTALL_URLS.codex,
    })
  })

  it('a terminal that fails to start is reported too', async () => {
    // a child process that could not be started has no pid and reports the reason afterwards
    const child = new FakeChild(undefined)
    const pending = launchSubscriptionInstall('claude-code', {
      spawn: () => child,
      platform: 'win32',
    })
    setTimeout(() => child.emit('error', new Error('spawn ENOENT')), 5)
    expect(await pending).toMatchObject({
      ok: false,
      reason: 'failed',
      installUrl: SUBSCRIPTION_INSTALL_URLS['claude-code'],
    })
  })

  it('where the vendor command does not apply, points at the install page instead', async () => {
    const { calls, spawn } = recorder()
    const result = await launchSubscriptionInstall('codex', { spawn, platform: 'darwin' })
    expect(result).toEqual({
      ok: false,
      reason: 'unsupported',
      installUrl: SUBSCRIPTION_INSTALL_URLS.codex,
    })
    expect(calls).toEqual([])
  })

  it('links each provider to its vendor install page', () => {
    for (const url of Object.values(SUBSCRIPTION_INSTALL_URLS)) {
      expect(url).toMatch(/^https:\/\//)
    }
    expect(Object.keys(SUBSCRIPTION_INSTALL_URLS).sort()).toEqual(['claude-code', 'codex'])
  })
})

/** A child that prints, then ends: what `runSubscriptionProgram` reads */
class FakeCommand extends FakeChild {
  readonly stdout = new EventEmitter()
  readonly stderr = new EventEmitter()
  finish(code: number | null, stdout = '', stderr = ''): void {
    if (stdout) this.stdout.emit('data', Buffer.from(stdout))
    if (stderr) this.stderr.emit('data', Buffer.from(stderr))
    this.emit('exit', code)
    this.emit('close', code)
  }
}

function commandRecorder(end: (child: FakeCommand) => void = (child) => child.finish(0)): {
  calls: SpawnCall[]
  spawn: (command: string, args: string[], options: object) => FakeCommand
} {
  const calls: SpawnCall[] = []
  return {
    calls,
    spawn: (command, args, options) => {
      const child = new FakeCommand(4322)
      calls.push({ command, args, options: options as Record<string, unknown>, child })
      setImmediate(() => end(child))
      return child
    },
  }
}

describe('launchSubscriptionLogout', () => {
  it("runs the CLI's own logout command: the located file, no shell, no billing-route variables", async () => {
    for (const [provider, args] of [
      ['claude-code', ['auth', 'logout']],
      ['codex', ['logout']],
    ] as const) {
      const { calls, spawn } = commandRecorder()
      const result = await launchSubscriptionLogout(provider, {
        locate: async () => program(provider),
        spawn,
        baseEnv: { ...WINDOWS, ANTHROPIC_API_KEY: 'sk-ant', OPENAI_API_KEY: 'sk-oai', KEEP: '1' },
      })
      expect(result).toEqual({ ok: true })
      expect(calls).toHaveLength(1)
      const call = calls[0]!
      expect(call.command).toBe(program(provider).command)
      expect(call.args).toEqual(args)
      expect(call.options.shell).toBeUndefined()
      expect(call.options.windowsHide).toBe(true)
      // nothing waits on a prompt: stdin is closed from the start
      expect((call.options.stdio as unknown[])[0]).toBe('ignore')
      expect(call.options.cwd).toBe(tmpdir())
      expect(envOf(call).ANTHROPIC_API_KEY).toBeUndefined()
      expect(envOf(call).OPENAI_API_KEY).toBeUndefined()
      expect(envOf(call).KEEP).toBe('1')
    }
  })

  it('uses the configured path of the CLI and its wrapper arguments', async () => {
    const { calls, spawn } = commandRecorder()
    const asked: unknown[] = []
    await launchSubscriptionLogout('codex', {
      configuredPath: 'D:\\tools\\codex.exe',
      locate: async (provider, options) => {
        asked.push([provider, options?.configuredPath])
        return { ...program('codex'), command: 'C:\\node.exe', prefixArgs: ['D:\\codex\\cli.js'] }
      },
      spawn,
      baseEnv: WINDOWS,
    })
    expect(asked).toEqual([['codex', 'D:\\tools\\codex.exe']])
    expect(calls[0]!.command).toBe('C:\\node.exe')
    expect(calls[0]!.args).toEqual(['D:\\codex\\cli.js', 'logout'])
  })

  it('a logout the CLI reports as failed is a plain failure, without what it printed', async () => {
    const { spawn } = commandRecorder((child) =>
      child.finish(1, '', 'Error: could not sign out jun.il@school.kr (Acme Org)\n'),
    )
    const result = await launchSubscriptionLogout('claude-code', {
      locate: async () => program('claude-code'),
      spawn,
      baseEnv: WINDOWS,
    })
    expect(result).toEqual({ ok: false, reason: 'failed' })
    expect(JSON.stringify(result)).not.toMatch(/school|Acme/)
  })

  it('gives up on a CLI that does not finish, and ends it', async () => {
    const { calls, spawn } = commandRecorder(() => undefined)
    const started = Date.now()
    const result = await launchSubscriptionLogout('codex', {
      locate: async () => program('codex'),
      spawn,
      baseEnv: WINDOWS,
      timeoutMs: 30,
    })
    expect(result).toMatchObject({ ok: false, reason: 'failed' })
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(calls).toHaveLength(1)
  })

  it('has a bounded time to finish by default', () => {
    expect(SUBSCRIPTION_LOGOUT_TIMEOUT_MS).toBeGreaterThan(0)
    expect(SUBSCRIPTION_LOGOUT_TIMEOUT_MS).toBeLessThanOrEqual(60_000)
  })

  it('reports a missing CLI and a failing lookup without starting anything', async () => {
    const { calls, spawn } = commandRecorder()
    expect(await launchSubscriptionLogout('codex', { locate: async () => null, spawn })).toEqual({
      ok: false,
      reason: 'not-installed',
      installUrl: SUBSCRIPTION_INSTALL_URLS.codex,
    })
    expect(
      await launchSubscriptionLogout('codex', {
        locate: async () => {
          throw new Error('EACCES')
        },
        spawn,
      }),
    ).toMatchObject({ ok: false, reason: 'failed' })
    expect(await launchSubscriptionLogout('openai' as never, { spawn })).toEqual({
      ok: false,
      reason: 'invalid',
    })
    expect(calls).toEqual([])
  })

  it('tells the bridges that the login changed, after a logout and after a login window closed', async () => {
    const changed: string[] = []
    const stop = onSubscriptionLoginChange((provider) => changed.push(provider))
    try {
      const { spawn } = commandRecorder()
      await launchSubscriptionLogout('codex', {
        locate: async () => program('codex'),
        spawn,
        baseEnv: WINDOWS,
      })
      expect(changed).toEqual(['codex'])

      const login = recorder()
      await launchSubscriptionLogin('claude-code', {
        locate: async () => program('claude-code'),
        spawn: login.spawn,
        platform: 'win32',
        baseEnv: WINDOWS,
        registry: null,
      })
      // nothing changed while the window is open
      expect(changed).toEqual(['codex'])
      login.calls[0]!.child.emit('exit', 0)
      expect(changed).toEqual(['codex', 'claude-code'])
    } finally {
      stop()
    }
    notifySubscriptionLoginChange('codex')
    expect(changed).toEqual(['codex', 'claude-code'])
  })
})
