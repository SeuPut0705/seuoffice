/**
 * Where the person's skills are read from, and the list of them. The Codex
 * home (`~/.codex`, where Codex keeps its sign-in) is never read: a source or
 * skill folder whose path or real place is inside it is skipped before it is
 * opened.
 */
import type { Dirent } from 'node:fs'
import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { BUILTIN_SKILLS_MANIFEST } from './constants'
import { isInsideDir, readUserSkillFolder } from './folder'
import { isReservedUserSkillName } from './names'
import type { BuiltinSkillManifestEntry, UserSkill, UserSkillSourceDir } from './types'

export interface UserSkillSourceOptions {
  homeDir: string
  /** the app's builtin skills folder; left out when not given */
  builtinDir?: string | undefined
  /** the app's own skills folder; `~/.ieumoffice/skills` when not given */
  appSkillsDir?: string | undefined
  /** the agent window's project folder; its skills are read only when given */
  projectRoot?: string | undefined
}

/** `~/.codex`: Codex's own folder, which holds its sign-in */
export function codexHomeDir(homeDir: string): string {
  return join(homeDir, '.codex')
}

/**
 * Whether a folder is the Codex home or inside it, by its path and by its real
 * place (a link or junction pointing there counts). Resolving a real place
 * opens no folder and reads no file.
 */
export async function isInsideCodexHome(path: string, homeDir: string): Promise<boolean> {
  const codexHome = codexHomeDir(homeDir)
  if (isInsideDir(path, codexHome)) return true
  const codexReal = await realpath(codexHome).catch(() => codexHome)
  if (isInsideDir(path, codexReal)) return true
  const real = await realpath(path).catch(() => undefined)
  return real !== undefined && (isInsideDir(real, codexHome) || isInsideDir(real, codexReal))
}

/** The app's own skills folder, the only one the app writes to */
export function appSkillsDirOf(homeDir: string): string {
  return join(homeDir, '.ieumoffice', 'skills')
}

/**
 * Installed Claude plugins with a `skills` folder, from Claude Code's list of
 * installed plugins, ordered by plugin name. Missing or unreadable list: none.
 */
async function pluginSources(homeDir: string): Promise<UserSkillSourceDir[]> {
  const sources: UserSkillSourceDir[] = []
  try {
    const installed = JSON.parse(
      await readFile(join(homeDir, '.claude', 'plugins', 'installed_plugins.json'), 'utf8'),
    ) as { plugins?: Record<string, Array<{ installPath?: unknown }>> }
    for (const [plugin, installs] of Object.entries(installed.plugins ?? {})) {
      const path = Array.isArray(installs) ? installs.at(-1)?.installPath : undefined
      const name = plugin.split('@')[0]
      if (typeof path === 'string' && path && name) {
        sources.push({ source: 'plugin', dir: join(path, 'skills'), plugin: name })
      }
    }
  } catch {
    // no plugins installed, or a list this version cannot read: plugin skills are left out
  }
  const key = (entry: UserSkillSourceDir) => (entry.plugin ?? '').toLowerCase()
  return sources.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0))
}

/**
 * The skill sources in list order: builtin, the app's own, Claude's, each
 * Claude plugin, the shared agents folder, then the project's `.claude/skills`
 * and `.agents/skills`. Nothing inside `~/.codex` is ever included.
 */
export async function userSkillSources(
  options: UserSkillSourceOptions,
): Promise<UserSkillSourceDir[]> {
  const home = options.homeDir
  const sources: UserSkillSourceDir[] = []
  if (options.builtinDir) sources.push({ source: 'builtin', dir: options.builtinDir })
  sources.push({ source: 'app', dir: options.appSkillsDir ?? appSkillsDirOf(home) })
  sources.push({ source: 'user', dir: join(home, '.claude', 'skills') })
  sources.push(...(await pluginSources(home)))
  sources.push({ source: 'codex', dir: join(home, '.agents', 'skills') })
  if (options.projectRoot) {
    sources.push({ source: 'project', dir: join(options.projectRoot, '.claude', 'skills') })
    sources.push({ source: 'project', dir: join(options.projectRoot, '.agents', 'skills') })
  }
  const kept: UserSkillSourceDir[] = []
  for (const entry of sources) {
    if (!(await isInsideCodexHome(entry.dir, home))) kept.push(entry)
  }
  return kept
}

/**
 * The builtin skills list (`builtin-skills.json`). Entries without a name are
 * dropped; a missing or malformed file gives an empty list.
 */
export async function readBuiltinSkillsManifest(
  builtinDir: string,
): Promise<BuiltinSkillManifestEntry[]> {
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(join(builtinDir, BUILTIN_SKILLS_MANIFEST), 'utf8'))
  } catch {
    return []
  }
  if (!Array.isArray(raw)) return []
  const text = (value: unknown) => (typeof value === 'string' ? value : '')
  const entries: BuiltinSkillManifestEntry[] = []
  for (const item of raw as unknown[]) {
    if (!item || typeof item !== 'object') continue
    const entry = item as Record<string, unknown>
    if (typeof entry.name !== 'string' || !entry.name) continue
    entries.push({
      name: entry.name,
      source: text(entry.source),
      path: text(entry.path),
      commit: text(entry.commit),
      license: text(entry.license),
      agentOnly: entry.agentOnly === true,
      modified: entry.modified === true,
    })
  }
  return entries
}

/** Child folders of a source (links to folders followed), sorted by name */
async function skillFolders(dir: string): Promise<string[]> {
  let entries: Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const names: string[] = []
  for (const entry of entries) {
    if (isReservedUserSkillName(entry.name)) continue
    // hidden folders are not skills: the install staging folder lives here a moment
    if (entry.name.startsWith('.')) continue
    if (entry.isDirectory()) {
      names.push(entry.name)
    } else if (entry.isSymbolicLink()) {
      const info = await stat(join(dir, entry.name)).catch(() => undefined)
      if (info?.isDirectory()) names.push(entry.name)
    }
  }
  const key = (name: string) => name.toLowerCase()
  return names.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0))
}

export interface ReadUserSkillsOptions {
  homeDir: string
  /** builtin names only the agent window uses */
  agentOnlyNames?: ReadonlySet<string> | undefined
}

/**
 * Read the skills of the given sources, in source order. Within one source a
 * second skill with an identifier already seen is left out (so the project's
 * `.claude/skills` wins over its `.agents/skills`). Reserved names and folders
 * inside `~/.codex` never appear.
 */
export async function readUserSkillsFrom(
  sources: UserSkillSourceDir[],
  options: ReadUserSkillsOptions,
): Promise<UserSkill[]> {
  const skills: UserSkill[] = []
  const seen = new Set<string>()
  for (const source of sources) {
    // checked before the source folder is opened
    if (await isInsideCodexHome(source.dir, options.homeDir)) continue
    for (const folder of await skillFolders(source.dir)) {
      const dir = join(source.dir, folder)
      if (await isInsideCodexHome(dir, options.homeDir)) continue
      const skill = await readUserSkillFolder(dir, {
        source: source.source,
        plugin: source.plugin,
        agentOnlyNames: options.agentOnlyNames,
      })
      if (!skill) continue
      const key = skill.id.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      skills.push(skill)
    }
  }
  return skills
}

/** Every skill of every source the options name, with builtin flags read from the builtin list */
export async function listUserSkills(options: UserSkillSourceOptions): Promise<UserSkill[]> {
  const manifest = options.builtinDir ? await readBuiltinSkillsManifest(options.builtinDir) : []
  return readUserSkillsFrom(await userSkillSources(options), {
    homeDir: options.homeDir,
    agentOnlyNames: new Set(manifest.filter((entry) => entry.agentOnly).map((entry) => entry.name)),
  })
}
