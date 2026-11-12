/**
 * Every name this product registered on a user's machine, or wrote where
 * another program reads it, before it took its own names (decision 0024,
 * 2026-11). Code that still honours one imports it from here, so deleting
 * this file lists every compatibility read as a compile error.
 *
 * No other source file writes one of these names: the rename tool
 * (~/.seuoffice-program/rename) leaves files called `old-names*` alone and
 * rewrites the old spelling everywhere else.
 */

/** Environment variables were `GENOFFICE_*`; they are `SEUOFFICE_*` now. */
export const OLD_ENV_PREFIX = 'GENOFFICE_'
export const ENV_PREFIX = 'SEUOFFICE_'

/**
 * The variables a person was told to set: by the in-app help, the agent skill,
 * the command's own help, README and error messages, the privacy and security
 * pages or docs/contracts.md. Only these are taken over from the old prefix;
 * the ones for building, developing and testing were renamed with nothing
 * left behind.
 */
export const OLD_ENV_NAMES: readonly string[] = [
  'AI_SETTINGS',
  'ALLOWED_ROOTS',
  'APP_BIN',
  'AUDIT_LOG',
  'AUTH_DIR',
  'HB_SUBSET_WASM',
  'HOME',
  'LANG',
  'MCP_COMPACT_SCHEMAS',
  'MCP_TOKEN',
  'PDFIUM_WASM',
  'RHWP_WASM',
  'TRUST_PROXY_HEADERS',
  'USER_DATA',
]

/**
 * Give `GENOFFICE_X` in `env` to `SEUOFFICE_X` for every X in `OLD_ENV_NAMES`,
 * unless `SEUOFFICE_X` is already there (an empty value counts as set).
 * Returns the new names it set. `old-names-env.ts` runs it on the process.
 */
export function adoptOldEnv(env: Record<string, string | undefined>): string[] {
  const adopted: string[] = []
  for (const name of OLD_ENV_NAMES) {
    const value = env[OLD_ENV_PREFIX + name]
    if (value === undefined || env[ENV_PREFIX + name] !== undefined) continue
    env[ENV_PREFIX + name] = value
    adopted.push(ENV_PREFIX + name)
  }
  return adopted
}

/** `~/<name>`: the launcher record, the CLI audit log, the skills a user made */
export const OLD_HOME_DIR_NAMES: readonly string[] = ['.ieumoffice']

/** `<project folder>/<name>`: project.json, instructions, memory, ignore, chats */
export const OLD_PROJECT_DATA_DIR_NAMES: readonly string[] = ['.ieumoffice']

/** The terminal command, and the launcher files beside the bundle (`<name>`, `<name>.cmd`) */
export const OLD_CLI_COMMANDS: readonly string[] = ['ieumoffice']

/** The bundled CLI entry: an MCP entry written on Windows names it in its arguments */
export const OLD_CLI_BUNDLE_FILES: readonly string[] = ['genoffice.cjs']

/** Key of the stdio server in an agent's MCP config (`[mcp_servers.<name>]` for Codex) */
export const OLD_MCP_SERVER_NAMES: readonly string[] = ['ieumoffice']

/** The in-app server as agent sessions, pasted client configs and saved chats name it */
export const OLD_APP_MCP_SERVER_NAMES: readonly string[] = ['ieumoffice-editor']

/** The agent skill: its folder under an agent's skills directory and its `name:` */
export const OLD_SKILL_NAMES: readonly string[] = ['ieumoffice']

/** MCP tools that were renamed, old name to new: a client may have the old one in an allow list */
export const OLD_MCP_TOOL_NAMES: Readonly<Record<string, string>> = {
  open_in_genoffice: 'open_in_seuoffice',
}

/**
 * Scheme of the MCP resources (`<scheme>://guide/…`): the agent skill an
 * earlier version installed names the guides under it
 */
export const OLD_MCP_RESOURCE_SCHEMES: readonly string[] = ['ieumoffice']

/**
 * The name to use for something that may exist under an old name: the current
 * one when it is in use (`inUse`, by default: it exists); else the first old
 * name that exists (what an earlier version left is used where it is, never
 * copied or moved); else the current one, which the caller then creates.
 *
 * The current name wins once it is in use, so nothing made later under an old
 * name, by an earlier version or by another program that uses that name, can
 * hide what this version already wrote. A folder that only exists (made by
 * hand, as the help describes, with nothing in it yet) hides nothing either:
 * a caller for a folder passes `inUse` as "holds data".
 */
export function existingOrCurrent(
  current: string,
  oldNames: readonly string[],
  exists: (name: string) => boolean,
  inUse: (name: string) => boolean = exists,
): string {
  if (inUse(current)) return current
  return oldNames.find(exists) ?? current
}
