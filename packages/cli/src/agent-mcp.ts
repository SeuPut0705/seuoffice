import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync } from 'node:fs'
import { basename, delimiter, dirname, isAbsolute, join } from 'node:path'
import { OLD_CLI_COMMANDS, OLD_MCP_SERVER_NAMES } from '@seuoffice/i18n'
import { agentConfigDir, type AgentId } from './agent-skills'
import { realizedPath, writeOutput } from './fs'
import { withCompactSchemas, type McpLaunch } from './mcp-launch'
import { APP_BINARY_NAME, CLI_BUNDLE_FILE, CLI_COMMAND, MCP_SERVER_NAME } from './names'

/**
 * Registering `seuoffice mcp` (stdio) in each coding agent's MCP config, the
 * MCP twin of agent-skills.ts. One key per file is set or removed; an entry
 * named seuoffice that starts something other than an seuoffice launcher is
 * never replaced unless forced. Paths and shapes follow each agent's docs.
 * Our entry under a key this product used before (`OLD_MCP_SERVER_NAMES`)
 * counts as ours: it is reported, moved to the current key by a write and
 * removed by a remove; another program's entry under such a key is left alone.
 * Another app registers those old names too, so an entry that uses one is
 * ours only when it provably starts this product (`isSeuofficeLauncher`).
 * The upstream app's `genoffice` entry is another program's: never read as
 * ours, never replaced, never removed.
 */

export { MCP_SERVER_NAME }

export type McpEntryStatus =
  /** no seuoffice entry in the file */
  | 'absent'
  /** seuoffice entry starting our launcher, exactly as this CLI would write it */
  | 'registered'
  /** an seuoffice launcher, but another path or extra fields */
  | 'stale'
  /** an entry named seuoffice that starts something else */
  | 'occupied'
  /** the file cannot be edited safely (unparsable, or a shape we do not know) */
  | 'manual'

export interface McpEntryState {
  status: McpEntryStatus
  /** the program the existing entry starts, when readable */
  command: string | null
  /**
   * Set when a registered entry asks for compact tool schemas (`mcp install
   * --compact-schemas`): the same launcher plus one env toggle, not a stale entry.
   */
  compactSchemas?: boolean
}

interface JsonShape {
  kind: 'json'
  /** top-level key holding the server map */
  key: string
  entry: (launch: McpLaunch) => Record<string, unknown>
  /** what an existing entry starts */
  launchOf: (entry: unknown) => { command: string | null; args: string[] }
}

interface TomlShape {
  kind: 'toml'
}

/** The DSH Cordis profile patch: a YAML array of `{ insert: [...] }` blocks,
    each insert carrying a server entry with its own id and transport config.
    A scalar union won't do — the file has no top-level key to hang a map on. */
interface YamlShape {
  kind: 'yaml-cordis'
}

interface McpAgentDef {
  id: AgentId
  /** config file, relative to the agent's dotfolder unless the agent keeps it elsewhere */
  file: (configDir: string, home: string, explicit: boolean) => string
  shape: JsonShape | TomlShape | YamlShape
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []

const plainLaunch: JsonShape['launchOf'] = (entry) =>
  isRecord(entry)
    ? {
        command: typeof entry.command === 'string' ? entry.command : null,
        args: strings(entry.args),
      }
    : { command: null, args: [] }

const withEnv = (launch: McpLaunch) => (launch.env ? { env: launch.env } : {})

const stdioEntry: JsonShape = {
  kind: 'json',
  key: 'mcpServers',
  entry: (l) => ({ type: 'stdio', command: l.command, args: l.args, ...withEnv(l) }),
  launchOf: plainLaunch,
}

const bareEntry: JsonShape = {
  kind: 'json',
  key: 'mcpServers',
  entry: (l) => ({ command: l.command, args: l.args, ...withEnv(l) }),
  launchOf: plainLaunch,
}

const MCP_AGENTS: readonly McpAgentDef[] = [
  {
    id: 'claude-code',
    // `claude mcp add --scope user` writes ~/.claude.json, or <CLAUDE_CONFIG_DIR>/.claude.json
    file: (dir, home, explicit) => join(explicit ? dir : home, '.claude.json'),
    shape: stdioEntry,
  },
  { id: 'codex', file: (dir) => join(dir, 'config.toml'), shape: { kind: 'toml' } },
  { id: 'cursor', file: (dir) => join(dir, 'mcp.json'), shape: stdioEntry },
  { id: 'gemini', file: (dir) => join(dir, 'settings.json'), shape: bareEntry },
  {
    id: 'copilot',
    file: (dir) => join(dir, 'mcp-config.json'),
    shape: {
      kind: 'json',
      key: 'mcpServers',
      entry: (l) => ({
        type: 'local',
        command: l.command,
        args: l.args,
        ...withEnv(l),
        tools: ['*'],
      }),
      launchOf: plainLaunch,
    },
  },
  {
    id: 'opencode',
    file: (dir) => join(dir, 'opencode.json'),
    shape: {
      kind: 'json',
      key: 'mcp',
      entry: (l) => ({
        type: 'local',
        command: [l.command, ...l.args],
        enabled: true,
        ...(l.env ? { environment: l.env } : {}),
      }),
      launchOf: (entry) => {
        const words = isRecord(entry) ? strings(entry.command) : []
        return { command: words[0] ?? null, args: words.slice(1) }
      },
    },
  },
  { id: 'windsurf', file: (dir) => join(dir, 'mcp_config.json'), shape: bareEntry },
  {
    id: 'dsh',
    // DSH_HOME (default ~/.dsh): the home-level patch outranks every profile
    file: (dir) => join(dir, 'cordis.patch.yml'),
    shape: { kind: 'yaml-cordis' },
  },
]

export function mcpAgentIds(): AgentId[] {
  return MCP_AGENTS.map((a) => a.id)
}

export interface McpConfigOptions {
  env?: NodeJS.ProcessEnv
  home?: string
  /** use this folder as the agent's dotfolder instead of the probed one */
  dir?: string
}

/** Where `id` keeps its MCP servers; null for an unknown agent. */
export function mcpConfigFile(id: AgentId, opts: McpConfigOptions = {}): string | null {
  const def = MCP_AGENTS.find((a) => a.id === id)
  if (!def) return null
  const env = opts.env ?? process.env
  const home = opts.home ?? homeOf(env)
  const dir = opts.dir ?? agentConfigDir(id, env, home)
  if (!dir) return null
  const explicit = opts.dir !== undefined || (id === 'claude-code' && !!env.CLAUDE_CONFIG_DIR)
  return def.file(dir, home, explicit)
}

function homeOf(env: NodeJS.ProcessEnv): string {
  return env.SEUOFFICE_HOME || env.HOME || env.USERPROFILE || ''
}

/** What a person pastes when the file cannot be edited for them. */
export function mcpSnippet(id: AgentId, launch: McpLaunch): string {
  const def = MCP_AGENTS.find((a) => a.id === id)!
  if (def.shape.kind === 'toml') return tomlTable(launch)
  if (def.shape.kind === 'yaml-cordis') return cordisSnippet(launch)
  return JSON.stringify(
    { [def.shape.key]: { [MCP_SERVER_NAME]: def.shape.entry(launch) } },
    null,
    2,
  )
}

export function readMcpEntry(
  id: AgentId,
  file: string,
  launch: McpLaunch,
  env: NodeJS.ProcessEnv = process.env,
): McpEntryState {
  const def = MCP_AGENTS.find((a) => a.id === id)!
  if (!existsSync(file)) {
    return def.shape.kind === 'json' && existsSync(jsoncTwin(file))
      ? { status: 'manual', command: null }
      : { status: 'absent', command: null }
  }
  const text = readFileSync(file, 'utf-8')
  if (def.shape.kind === 'toml') return tomlState(text, launch, env)
  if (def.shape.kind === 'yaml-cordis') return cordisState(text, launch, env)
  if (!text.trim()) return { status: 'absent', command: null }
  const doc = parseJsonObject(text)
  if (!doc) return { status: 'manual', command: null }
  const shape = def.shape
  const map = doc[shape.key]
  if (map === undefined) return { status: 'absent', command: null }
  if (!isRecord(map)) return { status: 'manual', command: null }
  const entry = map[MCP_SERVER_NAME]
  const old = ownOldKeys(map, shape.launchOf, env)[0]
  return withOldEntry(
    entry === undefined
      ? { status: 'absent', command: null }
      : jsonState(shape, entry, launch, env),
    old === undefined ? undefined : shape.launchOf(map[old]),
  )
}

function jsonState(
  shape: JsonShape,
  entry: unknown,
  launch: McpLaunch,
  env: NodeJS.ProcessEnv,
): McpEntryState {
  const { command, args } = shape.launchOf(entry)
  // an entry written with --compact-schemas is the same launch plus one env toggle
  for (const [compactSchemas, candidate] of [
    [false, launch],
    [true, withCompactSchemas(launch)],
  ] as const) {
    if (JSON.stringify(entry) === JSON.stringify(shape.entry(candidate))) {
      return compactSchemas
        ? { status: 'registered', command, compactSchemas: true }
        : { status: 'registered', command }
    }
  }
  return { status: isSeuofficeLauncher(command, args, env) ? 'stale' : 'occupied', command }
}

/**
 * Our entry under an old key needs a write: alone it reads as stale (never
 * absent, so nobody adds a second one), and beside a current entry the agent
 * would start the server twice, so the pair is not yet what this CLI writes.
 */
function withOldEntry(
  current: McpEntryState,
  old: { command: string | null } | undefined,
): McpEntryState {
  if (!old) return current
  if (current.status === 'absent') return { status: 'stale', command: old.command }
  if (current.status === 'registered') return { ...current, status: 'stale' }
  return current
}

/** Old keys of `map` holding an entry that starts one of our launchers */
function ownOldKeys(
  map: Record<string, unknown>,
  launchOf: JsonShape['launchOf'],
  env: NodeJS.ProcessEnv,
): string[] {
  return OLD_MCP_SERVER_NAMES.filter((key) => {
    if (map[key] === undefined) return false
    const { command, args } = launchOf(map[key])
    return isSeuofficeLauncher(command, args, env)
  })
}

/**
 * Set the seuoffice entry (replacing any existing one) and drop our entry under
 * an old key in the same write; the caller has already decided that is allowed.
 */
export function writeMcpEntry(
  id: AgentId,
  file: string,
  launch: McpLaunch,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const def = MCP_AGENTS.find((a) => a.id === id)!
  const text = existsSync(file) ? readFileSync(file, 'utf-8') : ''
  if (def.shape.kind === 'toml') {
    const stripped = removeTomlTables(text, [MCP_SERVER_NAME, ...ownOldTomlNames(text, env)])
    const body = stripped.length && !stripped.endsWith('\n') ? `${stripped}\n` : stripped
    save(file, `${body}${body.trim().length ? '\n' : ''}${tomlTable(launch)}`)
    return
  }
  if (def.shape.kind === 'yaml-cordis') {
    save(file, cordisUpsert(text, launch, env))
    return
  }
  const doc = text.trim() ? parseJsonObject(text) : {}
  if (!doc) throw new Error(`${file} is not a JSON object`)
  const map = isRecord(doc[def.shape.key]) ? (doc[def.shape.key] as Record<string, unknown>) : {}
  const old = new Set(ownOldKeys(map, def.shape.launchOf, env))
  const kept = Object.fromEntries(Object.entries(map).filter(([key]) => !old.has(key)))
  doc[def.shape.key] = { ...kept, [MCP_SERVER_NAME]: def.shape.entry(launch) }
  save(file, `${JSON.stringify(doc, null, 2)}\n`)
}

/** Remove the seuoffice entry and ours under an old key; false when there was none. Other keys stay. */
export function removeMcpEntry(
  id: AgentId,
  file: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const def = MCP_AGENTS.find((a) => a.id === id)!
  if (!existsSync(file)) return false
  const text = readFileSync(file, 'utf-8')
  if (def.shape.kind === 'toml') {
    const next = removeTomlTables(text, [MCP_SERVER_NAME, ...ownOldTomlNames(text, env)])
    if (next === text) return false
    save(file, next)
    return true
  }
  if (def.shape.kind === 'yaml-cordis') {
    const next = cordisRemove(text, env)
    if (next === text) return false
    save(file, next)
    return true
  }
  if (!text.trim()) return false
  const doc = parseJsonObject(text)
  if (!doc) throw new Error(`${file} is not a JSON object`)
  const map = doc[def.shape.key]
  if (!isRecord(map)) return false
  const drop = new Set(ownOldKeys(map, def.shape.launchOf, env))
  if (MCP_SERVER_NAME in map) drop.add(MCP_SERVER_NAME)
  if (!drop.size) return false
  doc[def.shape.key] = Object.fromEntries(Object.entries(map).filter(([key]) => !drop.has(key)))
  save(file, `${JSON.stringify(doc, null, 2)}\n`)
  return true
}

// ---- the DSH Cordis patch (yaml-cordis shape) ----
// The file is a YAML array of `{ insert: [...] }` blocks; this converter only
// owns the block whose insert carries `id: mcp-<MCP_SERVER_NAME>`. Hand-rolled line
// walker, not a YAML parser: the format DSH reads is a strict subset of YAML
// (one nesting shape, no anchors, no multi-line scalars in practice), and a
// targeted line edit can never reorder or reformat entries the way a full
// parse-serialize round trip would.

/** YAML indentation depth of a non-empty, non-comment line (0-based, 2-space steps). */
function yamlIndent(line: string): number {
  const trimmed = line.trimStart()
  return line.length - trimmed.length === 0 ? 0 : Math.floor((line.length - trimmed.length) / 2)
}

/** A single-quoted YAML scalar: a quote inside it is escaped by doubling. */
function yamlScalar(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/** A Windows path in the patch: DSH reads the forward-slash form. */
function yamlPath(value: string): string {
  return value.replace(/\\/g, '/')
}

/**
 * The top-level blocks of the patch: each starts at indent 0 with `- `, with
 * the line range it spans. A block ends before the next one starts, and the
 * blank lines and comments after its last line belong to the file, not to the
 * block — so splicing one out leaves the rest of the file byte for byte.
 */
function cordisBlockRanges(lines: string[]): Array<[number, number]> {
  const starts: number[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (line.trim() === '' || line.trim().startsWith('#')) continue
    if (yamlIndent(line) === 0 && line.trimStart().startsWith('- ')) starts.push(i)
  }
  return starts.map((start, k) => {
    const limit = k + 1 < starts.length ? starts[k + 1]! : lines.length
    let end = limit
    while (end > start) {
      const last = lines[end - 1]!.trim()
      if (last !== '' && !last.startsWith('#')) break
      end--
    }
    return [start, end] as [number, number]
  })
}

/** The flow-style empty sequence DSH initialises the patch with. */
function cordisIsEmptyFlowSequence(lines: string[]): boolean {
  const content = lines.filter((line) => line.trim() !== '' && !line.trim().startsWith('#'))
  return content.length === 1 && content[0]!.trim() === '[]'
}

/**
 * The patch is a top-level YAML sequence of insert blocks (block style, or
 * the empty `[]`). Anything else (a top-level mapping, say) we do not edit:
 * appending an insert block to it would not be YAML, so the file is reported
 * for a manual edit instead.
 */
function cordisIsSequence(lines: string[]): boolean {
  if (cordisIsEmptyFlowSequence(lines)) return true
  for (const line of lines) {
    if (line.trim() === '' || line.trim().startsWith('#')) continue
    return yamlIndent(line) === 0 && line.trimStart().startsWith('- ')
  }
  return true
}

/** The `id:` and `serverName:` values inside one insert block. */
function cordisBlockInfo(block: string[]): { id: string | null; serverName: string | null } {
  let id: string | null = null
  let serverName: string | null = null
  for (const line of block) {
    const idMatch = /^\s*-?\s*id:\s*(.+)$/.exec(line)
    if (idMatch && id === null) id = idMatch[1]!.trim().replace(/^['"]|['"]$/g, '')
    const nameMatch = /^\s*serverName:\s*(.+)$/.exec(line)
    if (nameMatch && serverName === null)
      serverName = nameMatch[1]!.trim().replace(/^['"]|['"]$/g, '')
  }
  return { id, serverName }
}

/** Our insert block's id; the upstream app's `mcp-genoffice` block is another program's. */
const CORDIS_BLOCK_ID = `mcp-${MCP_SERVER_NAME}`

/**
 * Whether one insert block is this app's: under our id or server name; or under
 * the name an earlier version wrote it with (`OLD_MCP_SERVER_NAMES`) while it
 * starts our launcher, since another program may use that name too.
 */
function isOwnCordisBlock(block: string[], env: NodeJS.ProcessEnv): boolean {
  const { id, serverName } = cordisBlockInfo(block)
  if (id === CORDIS_BLOCK_ID || serverName === MCP_SERVER_NAME) return true
  if (!OLD_MCP_SERVER_NAMES.some((name) => id === `mcp-${name}` || serverName === name)) {
    return false
  }
  const { command, args } = cordisLaunchOf(block)
  return isSeuofficeLauncher(command, args, env)
}

/**
 * The line ranges of the blocks this app owns, in file order: one, or two
 * after an install that did not yet see the block an earlier version wrote.
 */
function cordisOwnRanges(lines: string[], env: NodeJS.ProcessEnv): [number, number][] {
  return cordisBlockRanges(lines).filter(([start, end]) =>
    isOwnCordisBlock(lines.slice(start, end), env),
  )
}

/** `lines` without the ranges given (in file order) */
function withoutRanges(lines: string[], ranges: [number, number][]): string[] {
  return lines.filter((_, i) => !ranges.some(([start, end]) => i >= start && i < end))
}

/** The `command:` and `args:` of one insert block. */
function cordisLaunchOf(block: string[]): { command: string | null; args: string[] } {
  const commandLine = block.find((l) => /^\s*command:\s*/.test(l))
  const command = commandLine
    ? commandLine
        .replace(/^\s*command:\s*/, '')
        .trim()
        .replace(/^['"]|['"]$/g, '')
    : null
  const argsLine = block.find((l) => /^\s*args:\s*/.test(l))
  const args: string[] = []
  if (argsLine) {
    const raw = argsLine.replace(/^\s*args:\s*/, '').trim()
    const inner = raw.startsWith('[') && raw.endsWith(']') ? raw.slice(1, -1) : ''
    for (const part of inner.split(',')) {
      const value = part.trim().replace(/^['"]|['"]$/g, '')
      if (value) args.push(value)
    }
  }
  return { command, args }
}

function cordisState(text: string, launch: McpLaunch, env: NodeJS.ProcessEnv): McpEntryState {
  const lines = text.split('\n')
  if (!cordisIsSequence(lines)) return { status: 'manual', command: null }
  const owned = cordisOwnRanges(lines, env)
  if (owned.length === 0) return { status: 'absent', command: null }
  const blocks = owned.map(([start, end]) => lines.slice(start, end))
  // the one under our current id, if there is one: an older one beside it goes on update
  const block =
    blocks.find((b) => cordisBlockInfo(b).id === CORDIS_BLOCK_ID) ?? (blocks[0] as string[])
  const { command, args } = cordisLaunchOf(block)
  // the block is ours by id: registered when it says exactly what we would write
  const written = block.join('\n').trim()
  const entryText = (l: McpLaunch) => cordisEntryLines(l).join('\n').trim()
  const alone = blocks.length === 1
  if (alone && written === entryText(launch)) return { status: 'registered', command }
  // ... including the env toggle `mcp install --compact-schemas` writes
  if (alone && written === entryText(withCompactSchemas(launch)))
    return { status: 'registered', command, compactSchemas: true }
  // ours, but written for another install path or under an earlier name:
  // stale, and ours to update. A foreign command under our id is occupied —
  // not ours to overwrite.
  return { status: isSeuofficeLauncher(command, args, env) ? 'stale' : 'occupied', command }
}

function cordisEntryLines(launch: McpLaunch): string[] {
  const command = yamlPath(launch.command)
  const args = launch.args.map((a) => yamlScalar(yamlPath(a))).join(', ')
  const env = Object.entries(launch.env ?? {})
  return [
    '- insert:',
    `  - id: ${CORDIS_BLOCK_ID}`,
    "    name: '@deepseek-ai/dsh-mcp-client'",
    '    config:',
    `      serverName: ${MCP_SERVER_NAME}`,
    '      transport: stdio',
    `      command: ${command}`,
    `      args: [${args}]`,
    // the packaged Windows app runs as Node; without the env DSH would start
    // the GUI instead of the MCP server
    ...(env.length ? ['      env:', ...env.map(([k, v]) => `        ${k}: ${yamlScalar(v)}`)] : []),
    '      toolCallTimeoutMs: 180000',
    '      failOnStartupError: false',
  ]
}

function cordisSnippet(launch: McpLaunch): string {
  return cordisEntryLines(launch).join('\n')
}

/**
 * Splice our block into the patch where our first block stood (any other of
 * ours, such as the one an earlier version wrote, goes), leaving every other
 * line byte for byte.
 */
function cordisUpsert(text: string, launch: McpLaunch, env: NodeJS.ProcessEnv): string {
  const lines = text.split('\n')
  if (!cordisIsSequence(lines)) return text
  const ours = cordisEntryLines(launch)
  const owned = cordisOwnRanges(lines, env)
  const first = owned[0]
  if (!first) {
    // `[]` cannot take a block item appended to it: the item replaces it.
    if (cordisIsEmptyFlowSequence(lines)) {
      const comments = lines.filter((line) => line.trim().startsWith('#'))
      return [...comments, ...ours].join('\n') + '\n'
    }
    const head = text.length === 0 || text.endsWith('\n') ? text : `${text}\n`
    return `${head}${ours.join('\n')}\n`
  }
  const rest = owned.slice(1)
  return [
    ...lines.slice(0, first[0]),
    ...ours,
    ...withoutRanges(
      lines.slice(first[1]),
      rest.map(([start, end]) => [start - first[1], end - first[1]]),
    ),
  ].join('\n')
}

/** Drop our blocks; every other line keeps its bytes. */
function cordisRemove(text: string, env: NodeJS.ProcessEnv): string {
  const lines = text.split('\n')
  if (!cordisIsSequence(lines)) return text
  const owned = cordisOwnRanges(lines, env)
  if (owned.length === 0) return text
  return withoutRanges(lines, owned).join('\n')
}

const LAUNCHER_NAMES = new Set(
  [CLI_COMMAND, `${CLI_COMMAND}.cmd`, `${APP_BINARY_NAME}.exe`].map((n) => n.toLowerCase()),
)

const OLD_LAUNCHER_NAMES = new Set(
  OLD_CLI_COMMANDS.flatMap((command) => [command, `${command}.cmd`]).map((n) => n.toLowerCase()),
)

/** What an upstream entry starts: its launcher scripts, or its app binary run as Node on its bundle. */
const UPSTREAM_LAUNCHER_NAMES = new Set(['genoffice', 'genoffice.cmd', 'genoffice.exe'])

/**
 * Any seuoffice launcher, whatever install it came from (an older app path is
 * ours to update): the launcher scripts, or our app run as Node on the CLI
 * bundle. Another app registers the names this product used before, so a
 * launcher under an old command name is ours only when it sits in an install
 * of this product (a bare name: where PATH takes it), and an old bundle name
 * proves nothing: the binary that runs it decides.
 */
export function isSeuofficeLauncher(
  command: string | null,
  args: string[] = [],
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!command) return false
  const program = fileName(command)
  if (LAUNCHER_NAMES.has(program)) return true
  if (OLD_LAUNCHER_NAMES.has(program)) {
    const launcher = /[\\/]/.test(command) ? command : onPath(command, env)
    return launcher !== null && inOurInstall(launcher)
  }
  if (UPSTREAM_LAUNCHER_NAMES.has(program)) return false
  return args.some((a) => fileName(a) === CLI_BUNDLE_FILE)
}

/**
 * `<install>/resources/cli/<launcher>`, the install folder named after this
 * product (`<name>.app/Contents` on macOS). The shape of the path decides, not
 * the disk: an entry outlives the install it names, and a config is read on
 * machines where that path does not exist.
 */
function inOurInstall(launcher: string): boolean {
  const [cli, resources, above, app] = launcher
    .toLowerCase()
    .split(/[\\/]+/)
    .slice(-5, -1)
    .reverse()
  if (cli !== 'cli' || resources !== 'resources') return false
  const name = APP_BINARY_NAME.toLowerCase()
  return above === 'contents' ? app === `${name}.app` : above === name
}

/** The file a bare command name runs, found on PATH with its links followed; null when nothing is there */
function onPath(command: string, env: NodeJS.ProcessEnv): string | null {
  const names = process.platform === 'win32' ? [command, `${command}.cmd`] : [command]
  for (const dir of (env.PATH ?? env.Path ?? '').split(delimiter)) {
    for (const name of dir ? names : []) {
      try {
        lstatSync(join(dir, name))
      } catch {
        continue
      }
      return followLinks(join(dir, name))
    }
  }
  return null
}

/** basename for either path flavour: Windows entries are read on any host */
function fileName(p: string): string {
  return p.slice(Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')) + 1).toLowerCase()
}

/** A symlinked config (stow, nix) is written through to its target so the link survives the rename. */
function save(file: string, content: string): void {
  const real = followLinks(file)
  mkdirSync(dirname(real), { recursive: true })
  writeOutput(real, content)
}

/**
 * Like realpath, but a dangling link resolves to where its target would be.
 * Each hop is taken from the real parent directory, so a relative link inside
 * a symlinked folder lands where the filesystem would take it.
 */
function followLinks(file: string): string {
  let cur = join(realizedPath(dirname(file)), basename(file))
  for (let i = 0; i < 32; i++) {
    let target: string
    try {
      if (!lstatSync(cur).isSymbolicLink()) return cur
      target = readlinkSync(cur)
    } catch {
      return cur
    }
    const next = isAbsolute(target) ? target : join(dirname(cur), target)
    cur = join(realizedPath(dirname(next)), basename(next))
  }
  return cur
}

function jsoncTwin(file: string): string {
  return file.replace(/\.json$/, '.jsonc')
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const raw: unknown = JSON.parse(text)
    return isRecord(raw) ? raw : null
  } catch {
    return null
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/** `[mcp_servers.<name>]` and its sub-tables (`[mcp_servers.<name>.env]`), the key bare or quoted */
function tomlHeader(name: string): RegExp {
  const key = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(
    `^\\s*\\[\\s*mcp_servers\\s*\\.\\s*(?:"${key}"|'${key}'|${key})\\s*(\\.[^\\]]*)?\\]`,
  )
}

/** `env` becomes the `[mcp_servers.seuoffice.env]` sub-table Codex reads its `env` map from. */
function tomlTable(launch: McpLaunch): string {
  const head = `[mcp_servers.${MCP_SERVER_NAME}]\ncommand = ${JSON.stringify(launch.command)}\nargs = ${JSON.stringify(launch.args)}\n`
  const env = Object.entries(launch.env ?? {})
  if (!env.length) return head
  const body = env.map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join('\n')
  return `${head}\n[mcp_servers.${MCP_SERVER_NAME}.env]\n${body}\n`
}

/** The `[mcp_servers.<name>]` table and its sub-tables, as line ranges. */
function tomlTableLines(lines: string[], name: string): Array<[number, number]> {
  const header = tomlHeader(name)
  const out: Array<[number, number]> = []
  for (let i = 0; i < lines.length; i++) {
    if (!header.test(lines[i]!)) continue
    let end = i + 1
    while (end < lines.length && !/^\s*\[/.test(lines[end]!)) end++
    out.push([i, end])
    i = end - 1
  }
  return out
}

/** The lines of the `[mcp_servers.<name>]` table itself, without its sub-tables */
function tomlMainBlock(lines: string[], name: string): string[] {
  const header = tomlHeader(name)
  const own = tomlTableLines(lines, name).find(([start]) => !header.exec(lines[start]!)?.[1])
  return own ? lines.slice(own[0], own[1]) : []
}

const meaningful = (lines: string[]) =>
  lines.map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))

function tomlState(text: string, launch: McpLaunch, env: NodeJS.ProcessEnv): McpEntryState {
  const lines = text.split('\n')
  const old = ownOldTomlNames(text, env)[0]
  return withOldEntry(
    currentTomlState(lines, launch, env),
    old === undefined ? undefined : { command: tomlString(tomlMainBlock(lines, old), 'command') },
  )
}

function currentTomlState(
  lines: string[],
  launch: McpLaunch,
  env: NodeJS.ProcessEnv,
): McpEntryState {
  const ranges = tomlTableLines(lines, MCP_SERVER_NAME)
  if (!ranges.length) return { status: 'absent', command: null }
  const block = tomlMainBlock(lines, MCP_SERVER_NAME)
  const command = tomlString(block, 'command')
  const written = ranges.flatMap(([s, e]) => meaningful(lines.slice(s, e))).join('\n')
  const tableText = (l: McpLaunch) => meaningful(tomlTable(l).split('\n')).join('\n')
  // an entry written with --compact-schemas adds one env row; it is still ours
  if (written === tableText(launch)) return { status: 'registered', command }
  if (written === tableText(withCompactSchemas(launch)))
    return { status: 'registered', command, compactSchemas: true }
  const args = tomlStrings(block, 'args')
  return { status: isSeuofficeLauncher(command, args, env) ? 'stale' : 'occupied', command }
}

/** Old keys whose table starts one of our launchers */
function ownOldTomlNames(text: string, env: NodeJS.ProcessEnv): string[] {
  const lines = text.split('\n')
  return OLD_MCP_SERVER_NAMES.filter((name) => {
    const block = tomlMainBlock(lines, name)
    return (
      block.length > 0 &&
      isSeuofficeLauncher(tomlString(block, 'command'), tomlStrings(block, 'args'), env)
    )
  })
}

function tomlValue(block: string[], key: string): string | null {
  const line = block.find((l) => new RegExp(`^\\s*${key}\\s*=`).test(l))
  return line ? line.replace(new RegExp(`^\\s*${key}\\s*=\\s*`), '').trim() : null
}

function tomlString(block: string[], key: string): string | null {
  const m = /^("(?:[^"\\]|\\.)*"|'[^']*')\s*(?:#.*)?$/.exec(tomlValue(block, key) ?? '')
  if (!m) return null
  const lit = m[1]!
  if (lit.startsWith("'")) return lit.slice(1, -1)
  try {
    return JSON.parse(lit) as string
  } catch {
    return null
  }
}

function tomlStrings(block: string[], key: string): string[] {
  const raw = tomlValue(block, key)
  if (!raw) return []
  try {
    return strings(JSON.parse(raw.replace(/,\s*\]$/, ']')))
  } catch {
    return []
  }
}

function removeTomlTables(text: string, names: readonly string[]): string {
  const lines = text.split('\n')
  const ranges = names.flatMap((name) => tomlTableLines(lines, name)).sort((a, b) => a[0] - b[0])
  if (!ranges.length) return text
  const keep: string[] = []
  let i = 0
  for (const [start, end] of ranges) {
    keep.push(...lines.slice(i, start))
    i = end
  }
  keep.push(...lines.slice(i))
  return keep.join('\n').replace(/\n{3,}/g, '\n\n')
}
