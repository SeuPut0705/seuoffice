import { brandText, PRODUCT_NAME } from '@genoffice/i18n'

/**
 * The names this product registers on a user's machine. The upstream GenOffice
 * may be installed beside it and registers `genoffice` everywhere, so every
 * name here is our own: nothing in this package reads, replaces or removes a
 * `genoffice` command, MCP entry, skill folder or `~/.genoffice`. Pure
 * constants (the renderer imports them through mcp-launch.ts).
 */

/** the terminal command, and the launcher file in <resources>/cli (Windows: `<name>.cmd`) */
export const CLI_COMMAND = 'ieumoffice'

/** the bundled CLI entry beside the launchers: a file inside the app, not a registered name */
export const CLI_BUNDLE_FILE = 'genoffice.cjs'

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

/**
 * The product name in static CLI / MCP text (command summaries, option and tool
 * descriptions), which keeps saying "GenOffice" in source like every other
 * dictionary. Never for a message that carries a path: a folder that really is
 * called GenOffice must be printed as it is, so those name PRODUCT_NAME directly.
 */
export function branded(text: string): string {
  return brandText(text, 'en')
}
