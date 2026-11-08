/**
 * Before a Codex agent session opens, the app checks on this PC that Codex's
 * sandbox starts and keeps a denied folder out of reach, with no model call:
 * `codex sandbox` runs `findstr` on two marker files under the session's own
 * profile, one in a folder the probe may read and one in a folder it denies.
 *
 * - both found: the deny is not enforced → the session does not start;
 * - only the readable one: contained;
 * - neither: the sandbox did not start (a Windows without MXC, a policy that
 *   forbids it) → the session does not start, and the person is told why.
 *
 * With commands' internet access on, the probe's profile opens the network too,
 * so a sandbox that cannot start that way is found here.
 *
 * Windows only; elsewhere Codex's own sandbox is not checked this way.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SubscriptionProgram } from '../subscription/locate'
import {
  killProcessTree,
  spawnSubscriptionProgram,
  type SubscriptionChildRegistry,
  type SubscriptionSpawn,
} from '../subscription/process'

export type CodexSandboxProbeResult = 'contained' | 'not-contained' | 'unavailable'

const PROBE_PROFILE = 'ieumoffice-probe'
const MARKER = 'ieumoffice-sandbox-probe'
/** ASCII names: `findstr` prints paths in the console code page, so only the names are compared */
const READABLE_NAME = 'ieumoffice-probe-readable.txt'
const DENIED_NAME = 'ieumoffice-probe-denied.txt'
const PROBE_TIMEOUT_MS = 60_000
const OUTPUT_LIMIT = 16_000

/** A TOML inline table of the profile; JSON strings are valid TOML basic strings */
export function tomlInlineTable(values: Record<string, string>): string {
  return `{${Object.entries(values)
    .map(([key, value]) => `${JSON.stringify(key)} = ${JSON.stringify(value)}`)
    .join(', ')}}`
}

export function codexSandboxProbeArgs(
  filesystem: Record<string, 'read' | 'write' | 'deny'>,
  probeDir: string,
  network = false,
): { args: string[]; readable: string; denied: string } {
  const readable = join(probeDir, READABLE_NAME)
  const deniedDir = join(probeDir, 'denied')
  const denied = join(deniedDir, DENIED_NAME)
  const profile = { ...filesystem, [probeDir]: 'read', [deniedDir]: 'deny' }
  return {
    readable,
    denied,
    args: [
      'sandbox',
      '-c',
      'windows.sandbox="mxc"',
      '-c',
      `default_permissions="${PROBE_PROFILE}"`,
      '-c',
      `permissions.${PROBE_PROFILE}.filesystem=${tomlInlineTable(profile)}`,
      ...(network ? ['-c', `permissions.${PROBE_PROFILE}.network.enabled=true`] : []),
      '--',
      'findstr.exe',
      '/m',
      MARKER,
      readable,
      denied,
    ],
  }
}

/** What the probe's output says, by the marker files `findstr` could open */
export function codexSandboxProbeVerdict(stdout: string): CodexSandboxProbeResult {
  const found = stdout
    .split(/\r?\n/)
    .map((line) => line.trim().toLowerCase())
    .filter(Boolean)
  const named = (name: string): boolean =>
    found.some((line) => line.endsWith(`\\${name}`) || line.endsWith(`/${name}`))
  if (named(DENIED_NAME)) return 'not-contained'
  return named(READABLE_NAME) ? 'contained' : 'unavailable'
}

export interface CodexSandboxProbeDeps {
  spawn?: SubscriptionSpawn | undefined
  registry?: SubscriptionChildRegistry | null | undefined
  baseEnv?: NodeJS.ProcessEnv | undefined
  killTree?: ((child: { readonly pid?: number | undefined }) => void) | undefined
  timeoutMs?: number | undefined
  /** probe the profile with the network open, as the session will run it */
  network?: boolean | undefined
}

export async function probeCodexSandbox(
  program: SubscriptionProgram,
  filesystem: Record<string, 'read' | 'write' | 'deny'>,
  probeDir: string,
  deps: CodexSandboxProbeDeps = {},
): Promise<CodexSandboxProbeResult> {
  const { args, readable, denied } = codexSandboxProbeArgs(
    filesystem,
    probeDir,
    deps.network === true,
  )
  await mkdir(join(probeDir, 'denied'), { recursive: true })
  await writeFile(readable, `${MARKER}\n`)
  await writeFile(denied, `${MARKER}\n`)
  const killTree = deps.killTree ?? ((target) => killProcessTree(target, { force: true }))
  return new Promise((resolve) => {
    let stdout = ''
    let settled = false
    const finish = (result: CodexSandboxProbeResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    let child: ReturnType<typeof spawnSubscriptionProgram>
    try {
      child = spawnSubscriptionProgram(program, args, {
        cwd: probeDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        baseEnv: deps.baseEnv,
        spawn: deps.spawn,
        registry: deps.registry,
        platform: 'win32',
      })
    } catch {
      resolve('unavailable')
      return
    }
    const timer = setTimeout(() => {
      killTree(child)
      finish('unavailable')
    }, deps.timeoutMs ?? PROBE_TIMEOUT_MS)
    timer.unref?.()
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < OUTPUT_LIMIT) stdout += chunk.toString()
    })
    // drained so a chatty failure cannot block the process on a full pipe
    child.stderr?.resume()
    child.once('error', () => finish('unavailable'))
    child.once('close', () => finish(codexSandboxProbeVerdict(stdout)))
  })
}
