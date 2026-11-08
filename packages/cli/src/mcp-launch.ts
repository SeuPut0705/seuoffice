import { APP_BINARY_NAME, CLI_BUNDLE_FILE, CLI_COMMAND } from './names'

export { MCP_SERVER_NAME, SKILL_NAME } from './names'

/**
 * How an MCP client starts `ieumoffice mcp`. Shared by the app's Settings snippet
 * and `ieumoffice mcp install` so the two cannot drift. Clients spawn without a
 * shell, so on Windows neither ieumoffice.cmd nor `cmd /c` is safe (a path with
 * a space splits); the entry does what ieumoffice.cmd does instead: the app
 * binary as Node on the bundled CLI. Pure string code: the renderer imports it.
 */
export interface McpLaunch {
  command: string
  args: string[]
  env?: Record<string, string>
}

const isWindowsPath = (p: string) => p.includes('\\')

/** The app's snippet: the bare name once ieumoffice is on the PATH, else the launcher itself. */
export function mcpLaunch(cli: {
  status: string
  launcherDir: string
  pathHint?: string
}): McpLaunch {
  const dir = cli.launcherDir
  if (isWindowsPath(dir)) return windowsAppLaunch(dir)
  const onPath = cli.status === 'present' && !cli.pathHint
  return { command: onPath ? CLI_COMMAND : `${dir}/${CLI_COMMAND}`, args: ['mcp'] }
}

function windowsAppLaunch(dir: string): McpLaunch {
  return {
    command: `${dir}\\..\\..\\${APP_BINARY_NAME}.exe`,
    args: [`${dir}\\${CLI_BUNDLE_FILE}`, 'mcp'],
    env: { ELECTRON_RUN_AS_NODE: '1' },
  }
}

export interface LauncherLaunchOptions {
  platform?: string
  /** test seam for the packaged-app probe */
  exists?: (path: string) => boolean
}

/**
 * `mcp install`: always the absolute launcher, never the bare name. On Windows
 * the packaged app is run as Node (same entry as the app's snippet); a checkout
 * has no IeumOffice.exe beside it and runs the bundle on the system node, as the
 * bin/ieumoffice script does. An upstream GenOffice.exe is never started.
 */
export function mcpLaunchFromLauncher(
  launcher: string,
  opts: LauncherLaunchOptions = {},
): McpLaunch {
  const win = isWindowsPath(launcher) || opts.platform === 'win32'
  if (!win) return { command: launcher, args: ['mcp'] }
  const sep = isWindowsPath(launcher) ? '\\' : '/'
  const dir = launcher.slice(0, Math.max(launcher.lastIndexOf('\\'), launcher.lastIndexOf('/')))
  const exists = opts.exists ?? (() => false)
  if (exists(`${dir}${sep}..${sep}..${sep}${APP_BINARY_NAME}.exe`)) return windowsAppLaunch(dir)
  const bundle = exists(`${dir}${sep}${CLI_BUNDLE_FILE}`)
    ? `${dir}${sep}${CLI_BUNDLE_FILE}`
    : `${dir}${sep}..${sep}dist${sep}${CLI_BUNDLE_FILE}`
  return { command: 'node', args: [bundle, 'mcp'] }
}
