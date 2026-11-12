import { PRODUCT_NAME } from '@seuoffice/i18n'

/**
 * The names this product registers on a user's machine. Every name here is our
 * own: the upstream GenOffice may be installed beside this product, and nothing
 * in this package reads, replaces or removes what that upstream app registered
 * (its command, MCP entry, skill folder or home folder). The names this product
 * itself used before it took its own are in @seuoffice/i18n (old-names.ts).
 * Pure constants (the renderer imports them through mcp-launch.ts).
 */

/** the terminal command, and the launcher file in <resources>/cli (Windows: `<name>.cmd`) */
export const CLI_COMMAND = 'seuoffice'

/** the bundled CLI entry beside the launchers: a file inside the app, not a registered name */
export const CLI_BUNDLE_FILE = 'seuoffice.cjs'

/** key of the stdio server in every agent's MCP config (`[mcp_servers.<name>]` for Codex) */
export const MCP_SERVER_NAME = CLI_COMMAND

/** the agent skill: its `name:` and its folder under an agent's skills directory */
export const SKILL_NAME = CLI_COMMAND

/** per-user folder under the home directory: launcher record, CLI audit log */
export const HOME_DIR_NAME = `.${CLI_COMMAND}`

/** the installed app binary (`<name>.exe` on Windows, `<name>.app/Contents/MacOS/<name>` on macOS) */
export const APP_BINARY_NAME = PRODUCT_NAME

/** the launcher file for a platform */
export function launcherFileName(platform: string): string {
  return platform === 'win32' ? `${CLI_COMMAND}.cmd` : CLI_COMMAND
}
