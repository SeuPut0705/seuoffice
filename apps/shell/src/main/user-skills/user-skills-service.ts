/**
 * The person's skills in the shell's main process (spec 4, 5.1-5.3, 5.6,
 * 5.8): the list with its states, state changes, the app-owned skill folder's
 * writes, imports, GitHub updates, export, and the AI's reads. No Electron
 * here; the IPC layer adds dialogs, the OS trash and who may ask.
 *
 * Writes go only to the app's skills folder (`~/.ieumoffice/skills`); other
 * sources are read only. Imports and update checks also use their own
 * temporary folder under the OS temp folder.
 */
import { randomBytes } from 'node:crypto'
import {
  copyFile,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path'
import {
  skillEditorScope,
  skillEditorsChoiceOf,
  skillEditorsOf,
  type SkillEditorId,
} from '@genoffice/agent-core/skill-editors'
import {
  IEUM_EDITORS_KEY,
  IEUM_SOURCE_FILE,
  IEUM_TEMPLATE_KEY,
  IEUM_TITLE_KEY,
  SKILL_STAGING_PREFIX,
  SKILL_TEXT_EXTENSIONS,
  SkillImportError,
  appSkillFoldersByName,
  appSkillsDirOf,
  applyGitHubSkillUpdate,
  checkGitHubSkillUpdate,
  commitSkillInstall,
  disposeSkillImport,
  exportSkillBundleZip,
  exportSkillZip,
  initialUserSkillState,
  installImportedSkills,
  isInsideDir,
  listSkillFolderFiles,
  listUserSkills,
  mcpServersOfSkillMd,
  parseSkillMd,
  parseUserSkillId,
  pickEnabledUserSkills,
  prepareSkillImport,
  readIeumSourceRecord,
  readListedSkillMd,
  renderSkillMd,
  resolveUserSkillStates,
  skillExportInfo,
  suggestUserSkillName,
  userSkillId,
  validateNewUserSkillName,
  MAX_USER_SKILL_BYTES,
  MAX_USER_SKILL_FILES,
  type GitHubSkillUpdateCheck,
  type ResolvedUserSkill,
  type SkillFetch,
  type SkillImport,
  type SkillImportCandidate,
  type SkillImportSource,
  type UserSkillInvoke,
  type UserSkillSettings,
  type UserSkillSource,
} from '@genoffice/ai-provider'
import {
  USER_SKILL_PREVIEW_TEXT_MAX_CHARS,
  type UserSkillAiRead,
  type UserSkillCardSaveInput,
  type UserSkillContent,
  type UserSkillEditorsValue,
  type UserSkillImportCandidateView,
  type UserSkillImportContent,
  type UserSkillImportPreview,
  type UserSkillImportText,
  type UserSkillInstallRequest,
  type UserSkillNameProblem,
  type UserSkillSaveInput,
  type UserSkillStatePatch,
  type UserSkillTemplateInput,
  type UserSkillView,
  type UserSkillsFail,
  type UserSkillsFailReason,
  type UserSkillsResult,
} from '@genoffice/electron-utils/user-skills-channels'
import { readSkillSettings, updateSkillSettings } from '../app-settings'

/** Largest skill file the AI may read in one call (spec 5.8; tunable) */
export const AI_SKILL_FILE_MAX_BYTES = 200 * 1024

/** Largest template document a skill card saves (the folder limit) */
export const SKILL_TEMPLATE_MAX_BYTES = MAX_USER_SKILL_BYTES

/**
 * Documents a template may be (spec 5.7): the formats the app's editors open.
 * JSON is left out on purpose: no settings or sign-in file becomes a template.
 */
const TEMPLATE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.docx',
  '.odt',
  '.xlsx',
  '.xlsm',
  '.xls',
  '.csv',
  '.tsv',
  '.pptx',
  '.pdf',
  '.md',
  '.markdown',
  '.txt',
  '.html',
  '.htm',
  '.xmind',
  '.hwp',
  '.hwpx',
])

const FOLDER_LIMITS = { files: MAX_USER_SKILL_FILES, bytes: MAX_USER_SKILL_BYTES }

export interface UserSkillsServiceDeps {
  homeDir: () => string
  /** the builtin skills folder; none in a build without it */
  builtinDir: () => string | undefined
  /** userData/app-settings.json */
  settingsPath: () => string
  /** where imports and update checks make their temporary folders */
  tempDir: () => string
  /** moves a folder to the OS trash */
  trash: (path: string) => Promise<void>
  /** GitHub requests (the core allows only the three GitHub hosts) */
  fetch: SkillFetch
  aiFileMaxBytes?: number | undefined
}

/** An enabled skill as the agent session's bundle takes it */
export interface AgentEnabledSkill {
  id: string
  source: UserSkillSource
  plugin: string | undefined
  name: string
  title: string
  description: string
  /** the skill folder */
  dir: string
  invoke: UserSkillInvoke
  agentOnly: boolean
}

function fail(reason: UserSkillsFailReason, problem?: string): UserSkillsFail {
  return problem === undefined ? { ok: false, reason } : { ok: false, reason, problem }
}

/** A thrown error as a result: the core's kinds pass through, the rest is a failure */
export function failureOf(error: unknown): UserSkillsFail {
  if (error instanceof SkillImportError) return fail(error.kind as UserSkillsFailReason)
  return fail('failed')
}

function sameName(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

/** Write a file by a temporary name beside it and a rename, so it is never half written */
async function writeFileAtomic(path: string, data: string | Uint8Array): Promise<void> {
  const temp = join(dirname(path), `.${basename(path)}.${randomBytes(4).toString('hex')}.tmp`)
  try {
    await writeFile(temp, data, { flag: 'wx' })
    await rename(temp, path)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined)
    throw error
  }
}

/** A folder of the app's skills folder handed to the core installer as an import candidate */
function stagedCandidate(dir: string, name: string): SkillImportCandidate {
  return {
    key: name,
    rel: '',
    dir,
    name,
    title: name,
    description: '',
    files: 0,
    bytes: 0,
    hasScripts: false,
    hasTemplate: false,
    urls: [],
    urlCount: 0,
    license: undefined,
    warnings: [],
    warningCount: 0,
    collision: false,
    emptyBody: false,
    problem: undefined,
  }
}

/** A template file name as it goes under `assets/`: one plain name with a document extension */
export function templateFileNameOf(raw: string): string | undefined {
  const last = raw.split(/[\\/]/).pop() ?? ''
  const cleaned = last
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"|?*\u0000-\u001f\u007f]/g, '')
    .trim()
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '')
  if (!cleaned || cleaned.length > 150) return undefined
  const ext = extname(cleaned).toLowerCase()
  if (!TEMPLATE_EXTENSIONS.has(ext) || cleaned.length === ext.length) return undefined
  return cleaned
}

function viewOf(
  skill: ResolvedUserSkill,
  github: UserSkillView['github'],
  shadowedBy: string | undefined,
  /** an own skill whose folder really is in the app's skills folder (not a link leading out) */
  owned: boolean,
): UserSkillView {
  const other = skill.source === 'user' || skill.source === 'plugin' || skill.source === 'codex'
  return {
    id: skill.id,
    source: skill.source,
    plugin: skill.plugin,
    name: skill.name,
    title: skill.title,
    description: skill.description,
    enabled: skill.enabled,
    invoke: skill.invoke,
    hidden: skill.hidden,
    hasScripts: skill.hasScripts,
    mcpServers: skill.mcpServers,
    template: skill.template,
    templateExists: skill.templateExists,
    agentOnly: skill.agentOnly,
    ...(skill.editors ? { editors: skill.editors } : {}),
    unreadable: skill.unreadable,
    files: skill.files,
    bytes: skill.bytes,
    github,
    owned,
    can: {
      edit: owned,
      copyToMine: skill.source === 'builtin' || other,
      export: owned,
      checkUpdate: owned && skill.github,
      openFolder: owned || other,
      remove: owned,
      hide: skill.source === 'builtin',
    },
    shadowedBy,
  }
}

function candidateView(candidate: SkillImportCandidate): UserSkillImportCandidateView {
  return {
    key: candidate.key,
    rel: candidate.rel,
    name: candidate.name,
    title: candidate.title,
    description: candidate.description,
    files: candidate.files,
    bytes: candidate.bytes,
    hasScripts: candidate.hasScripts,
    hasTemplate: candidate.hasTemplate,
    urls: candidate.urls,
    urlCount: candidate.urlCount,
    license: candidate.license,
    warnings: candidate.warnings.map((warning) => ({
      messageKey: warning.messageKey,
      file: warning.file,
      line: warning.line,
      excerpt: warning.excerpt,
    })),
    warningCount: candidate.warningCount,
    collision: candidate.collision,
    emptyBody: candidate.emptyBody,
    problem: candidate.problem,
  }
}

/** What an import preview shows (no folder paths) */
export function importPreviewOf(imported: SkillImport, token: string): UserSkillImportPreview {
  const origin = imported.origin
  return {
    token,
    origin:
      origin.kind === 'github'
        ? {
            kind: 'github',
            repo: origin.repo,
            ref: origin.ref,
            commit: origin.commit,
            path: origin.path,
          }
        : { kind: origin.kind },
    candidates: imported.candidates.map(candidateView),
    rootLicense: imported.rootLicense,
  }
}

/** Drop the saved state of a skill so it starts as its source starts */
function clearState(settings: UserSkillSettings, id: string): void {
  for (const key of Object.keys(settings.states)) {
    if (sameName(key, id)) delete settings.states[key]
  }
}

/**
 * Keep only what differs from the initial state of the source. A where-used
 * choice that says what the skill's file says is not kept either.
 */
function setStateValue(
  settings: UserSkillSettings,
  id: string,
  source: UserSkillSource,
  patch: { enabled?: boolean; invoke?: UserSkillInvoke; editors?: UserSkillEditorsValue },
  fileEditors?: readonly SkillEditorId[] | undefined,
): void {
  const initial = initialUserSkillState(source)
  const { editors, ...rest } = patch
  const next = { ...settings.states[id], ...rest }
  if (editors !== undefined) {
    const choice = skillEditorsChoiceOf(editors)
    const sameAsFile = String(skillEditorScope(choice, fileEditors)) === String(fileEditors)
    if (choice && !sameAsFile) next.editors = choice
    else delete next.editors
  }
  if (next.enabled === initial.enabled) delete next.enabled
  if (next.invoke === initial.invoke) delete next.invoke
  clearState(settings, id)
  if (Object.keys(next).length > 0) settings.states[id] = next
}

/**
 * The `metadata.ieum-editors` text a save writes: unchanged when the choice
 * says what the file says (ids this app does not know stay), `null` (taken
 * out) for every editor.
 */
function editorsTextOf(
  choice: UserSkillEditorsValue | undefined,
  base: string | undefined,
): string | null | undefined {
  if (choice === undefined) return undefined
  const written = base === undefined ? undefined : parseSkillMd(base)?.metadata[IEUM_EDITORS_KEY]
  const wanted = skillEditorScope(skillEditorsChoiceOf(choice), undefined)
  if (String(wanted) === String(skillEditorsOf(written))) return undefined
  return wanted ? wanted.join(' ') : null
}

/** Text cut at the preview's display limit, never in the middle of a character pair */
function cutForPreview(text: string, more: boolean): UserSkillImportText {
  const max = USER_SKILL_PREVIEW_TEXT_MAX_CHARS
  if (text.length <= max) return { text, truncated: more }
  const last = text.charCodeAt(max - 1)
  const end = last >= 0xd800 && last <= 0xdbff ? max - 1 : max
  return { text: text.slice(0, end), truncated: true }
}

/** The start of a text file, as much as a preview shows */
async function readFileHead(path: string): Promise<UserSkillImportText> {
  const handle = await open(path, 'r')
  try {
    // four bytes cover any one character, so the head holds at least the display limit
    const head = Buffer.alloc(USER_SKILL_PREVIEW_TEXT_MAX_CHARS * 4)
    const { bytesRead } = await handle.read(head, 0, head.length, 0)
    const { size } = await handle.stat()
    const more = bytesRead < size
    const text = head.subarray(0, bytesRead).toString('utf8')
    // a character cut by the end of the head reads as U+FFFD
    return cutForPreview(more ? text.replace(/\ufffd$/, '') : text, more)
  } finally {
    await handle.close()
  }
}

/** A path inside a skill folder as a caller gave it, `/` between parts; undefined when it leads out */
function skillRelOf(rel: string): string | undefined {
  const wanted = rel.replace(/\\/g, '/').replace(/^\.\//, '')
  const parts = wanted.split('/')
  const leadsOut =
    !wanted ||
    isAbsolute(rel) ||
    /^[A-Za-z]:/.test(wanted) ||
    parts.some((part) => part === '' || part === '.' || part === '..')
  return leadsOut ? undefined : wanted
}

/**
 * One text file of a skill folder by its path inside it, for the AI's read
 * and for the import preview. The file must be one the folder listing finds
 * (links leading out are never listed), its real place must be inside the
 * folder's, and it must be a text type.
 */
async function skillTextFileIn(
  dir: string,
  rel: string,
): Promise<{ path: string; size: number } | UserSkillsFail> {
  const wanted = skillRelOf(rel)
  if (!wanted) return fail('outside')
  if (!SKILL_TEXT_EXTENSIONS.has(extname(wanted).toLowerCase())) return fail('not-text')
  const listed = await listSkillFolderFiles(dir, FOLDER_LIMITS)
  if (!listed) return fail('unreadable')
  const file =
    listed.files.find((entry) => entry.rel === wanted) ??
    (process.platform === 'win32'
      ? listed.files.find((entry) => sameName(entry.rel, wanted))
      : undefined)
  if (!file) {
    const there = await stat(join(dir, ...wanted.split('/'))).catch(() => undefined)
    return fail(there ? 'outside' : 'not-found')
  }
  const root = await realpath(dir).catch(() => undefined)
  const real = await realpath(file.path).catch(() => undefined)
  if (!root || !real || !isInsideDir(real, root)) return fail('outside')
  return { path: file.path, size: file.size }
}

/** Whether a listed file is one of a skill's text files besides its SKILL.md and source record */
function isOtherTextFile(rel: string): boolean {
  return (
    rel !== 'SKILL.md' &&
    rel !== IEUM_SOURCE_FILE &&
    SKILL_TEXT_EXTENSIONS.has(extname(rel).toLowerCase())
  )
}

/** What an own skill hands on when another version takes its folder */
interface ReplacedSkill {
  id: string
  /** `metadata.ieum-editors` as its file wrote it; undefined when the file named none */
  editorsText: string | undefined
}

export function createUserSkillsService(deps: UserSkillsServiceDeps) {
  const appSkillsDir = () => appSkillsDirOf(deps.homeDir())
  const settingsPath = () => deps.settingsPath()
  const aiFileMax = deps.aiFileMaxBytes ?? AI_SKILL_FILE_MAX_BYTES

  async function resolved(projectRoot?: string): Promise<ResolvedUserSkill[]> {
    const skills = await listUserSkills({
      homeDir: deps.homeDir(),
      builtinDir: deps.builtinDir(),
      projectRoot,
    })
    return resolveUserSkillStates(skills, readSkillSettings(settingsPath()))
  }

  async function find(id: string): Promise<ResolvedUserSkill | undefined> {
    const parsed = parseUserSkillId(id)
    if (!parsed || parsed.source === 'project') return undefined
    const all = await resolved()
    return all.find((skill) => skill.id === id) ?? all.find((skill) => sameName(skill.id, id))
  }

  /**
   * An own skill's folder: a direct child of the app's skills folder whose
   * real place is inside the app's skills folder too. A linked folder leading
   * elsewhere is read, but never written, deleted or edited through.
   */
  async function ownedDir(skill: ResolvedUserSkill): Promise<string | undefined> {
    if (skill.source !== 'app') return undefined
    const root = appSkillsDir()
    const dir = resolve(skill.dir)
    const child = isInsideDir(dirname(dir), root) && isInsideDir(root, dirname(dir))
    if (!child || isInsideDir(root, dir)) return undefined
    const realRoot = await realpath(root).catch(() => undefined)
    const real = await realpath(dir).catch(() => undefined)
    if (!realRoot || !real) return undefined
    return isInsideDir(real, realRoot) && !isInsideDir(realRoot, real) ? dir : undefined
  }

  function changeSettings(change: (settings: UserSkillSettings) => void): void {
    updateSkillSettings(settingsPath(), change)
  }

  async function takenNames(): Promise<Map<string, string[]>> {
    return appSkillFoldersByName(appSkillsDir())
  }

  /** The strict rule for a name the app writes, and whether an own skill has it */
  async function nameProblem(
    name: string,
    except?: string,
  ): Promise<UserSkillNameProblem | 'taken' | undefined> {
    const problem = validateNewUserSkillName(name)
    if (problem) return problem
    const taken = (await takenNames()).get(name.toLowerCase()) ?? []
    const others = except ? taken.filter((dir) => !isInsideDir(dir, except)) : taken
    return others.length > 0 ? 'taken' : undefined
  }

  /** A card's template, or why it cannot be one: its bytes under a document file name */
  function templateOf(
    input: UserSkillTemplateInput,
  ): { bytes: Uint8Array; fileName: string } | UserSkillsFail {
    const fileName = templateFileNameOf(input.fileName)
    if (!fileName || !(input.bytes instanceof Uint8Array)) return fail('bad-template')
    if (input.bytes.byteLength > SKILL_TEMPLATE_MAX_BYTES) return fail('too-large')
    return { bytes: input.bytes, fileName }
  }

  /** A work folder inside the app's skills folder (hidden from the list) */
  async function makeWorkDir(): Promise<string> {
    await mkdir(appSkillsDir(), { recursive: true })
    const dir = join(
      appSkillsDir(),
      `${SKILL_STAGING_PREFIX}work-${randomBytes(6).toString('hex')}`,
    )
    await mkdir(dir)
    return dir
  }

  async function copyFolderInto(from: string, to: string): Promise<void> {
    const listed = await listSkillFolderFiles(from, FOLDER_LIMITS)
    if (!listed) throw new SkillImportError('failed', `Cannot read ${from}`)
    if (listed.tooLarge) throw new SkillImportError('too-large', 'The skill folder is too large')
    for (const file of listed.files) {
      if (file.rel === IEUM_SOURCE_FILE) continue
      const target = join(to, ...file.rel.split('/'))
      await mkdir(dirname(target), { recursive: true })
      await copyFile(file.path, target)
    }
  }

  async function readSkillMdText(dir: string): Promise<string | undefined> {
    return readFile(join(dir, 'SKILL.md'), 'utf8').catch(() => undefined)
  }

  /** An own skill as it is just before another version replaces it */
  async function replacedSkillOf(id: string): Promise<ReplacedSkill | undefined> {
    const skill = await find(id)
    if (!skill || skill.source !== 'app') return undefined
    const text = await readSkillMdText(skill.dir)
    const parsed = text === undefined ? undefined : parseSkillMd(text)
    return { id: skill.id, editorsText: parsed?.metadata[IEUM_EDITORS_KEY] }
  }

  /**
   * The one rule for what stays when another version takes an own skill's
   * place, by a reinstall over the same name or a GitHub update (decision
   * 0127). The saved state (on or off, when it is used) stays with the skill,
   * under its new identifier when the name changed. Where it is used is in the
   * file (decision 0122), so the replaced file's value goes into the new file
   * when that one names none; a value the new file brings wins.
   */
  async function keepAcrossReplace(
    old: ReplacedSkill,
    newId: string,
    newDir: string,
  ): Promise<void> {
    if (newId !== old.id) {
      changeSettings((settings) => {
        const kept = settings.states[old.id]
        clearState(settings, old.id)
        clearState(settings, newId)
        if (kept) settings.states[newId] = kept
      })
    }
    if (old.editorsText === undefined) return
    const base = await readSkillMdText(newDir)
    const parsed = base === undefined ? undefined : parseSkillMd(base)
    if (!parsed?.name || parsed.metadata[IEUM_EDITORS_KEY] !== undefined) return
    const text = renderSkillMd(
      {
        name: parsed.name,
        description: parsed.description ?? '',
        title: parsed.metadata[IEUM_TITLE_KEY],
        template: parsed.metadata[IEUM_TEMPLATE_KEY],
        editors: old.editorsText,
        body: parsed.body,
      },
      base,
    )
    // the new version is in place either way; a file that cannot be rewritten keeps what it brought
    await writeFileAtomic(join(newDir, 'SKILL.md'), text).catch(() => undefined)
  }

  interface WriteRequest {
    title: string
    name: string | undefined
    description: string
    body: string
    invoke: UserSkillInvoke | undefined
    template: UserSkillTemplateInput | undefined
    targetId: string | undefined
    overwrite: boolean
    editors: UserSkillEditorsValue | undefined
    /** the person agreed that enabled skills of other sources with this name are turned off */
    turnOffSameName: boolean
  }

  /** Turn another source's skill off: the own skill of its name is used instead */
  function turnOff(settings: UserSkillSettings, skill: ResolvedUserSkill): void {
    setStateValue(settings, skill.id, skill.source, { enabled: false })
  }

  /** Enabled skills of other sources that carry `name` (builtin, Claude, plugins, Codex) */
  async function enabledElsewhere(name: string, exceptId?: string): Promise<ResolvedUserSkill[]> {
    return (await resolved()).filter(
      (skill) =>
        skill.source !== 'app' &&
        skill.enabled &&
        sameName(skill.name, name) &&
        skill.id !== exceptId,
    )
  }

  /** Where the skills of `enabledElsewhere` come from, for the question the screen asks */
  function sourcesOf(skills: readonly ResolvedUserSkill[]): string {
    const sources = skills.map((skill) =>
      skill.source === 'plugin' ? `plugin:${skill.plugin ?? ''}` : skill.source,
    )
    return [...new Set(sources)].join(',')
  }

  /**
   * Put a finished folder into the app's skills folder under `name`, replacing
   * the given folders (they go to the OS trash).
   */
  async function place(work: string, name: string, replaceDirs: string[]): Promise<void> {
    await commitSkillInstall(
      appSkillsDir(),
      [{ candidate: stagedCandidate(work, name), folderName: name, replaceDirs }],
      { discardReplaced: (dir) => deps.trash(dir) },
    )
  }

  async function writeSkill(request: WriteRequest): Promise<UserSkillsResult<{ id: string }>> {
    const description = request.description.trim()
    if (!description) return fail('empty-description')
    if (!request.body.trim()) return fail('empty-body')

    let template: { bytes: Uint8Array; fileName: string } | undefined
    if (request.template) {
      const read = templateOf(request.template)
      if ('ok' in read) return read
      template = read
    }
    const templatePath = template ? `assets/${template.fileName}` : undefined

    const target = request.targetId ? await find(request.targetId) : undefined
    if (request.targetId && !target) return fail('not-found')
    // the title is the person's to give in any language; an empty one takes the key out
    const title = request.title.trim() || undefined

    // ---- an edit of an own skill: files rewritten in place, the folder renamed with the name
    if (target && target.source === 'app') {
      const dir = await ownedDir(target)
      if (!dir) return fail('not-owned')
      const name = request.name?.trim() || target.name
      if (name !== target.name) {
        const problem = await nameProblem(name, dir)
        if (problem === 'taken') return fail('name-taken')
        if (problem) return fail('bad-name', problem)
      }
      // a new name may be one another source's enabled skill has: ask before taking its place
      const elsewhere = name !== target.name ? await enabledElsewhere(name) : []
      if (elsewhere.length > 0 && !request.turnOffSameName) {
        return fail('same-name-on', sourcesOf(elsewhere))
      }
      const base = await readSkillMdText(dir)
      const text = renderSkillMd(
        {
          name,
          description,
          title,
          template: templatePath ?? target.template,
          editors: editorsTextOf(request.editors, base),
          body: request.body,
        },
        base,
      )
      try {
        if (template) {
          await mkdir(join(dir, 'assets'), { recursive: true })
          await writeFileAtomic(join(dir, 'assets', template.fileName), template.bytes)
        }
        await writeFileAtomic(join(dir, 'SKILL.md'), text)
        // an own skill's folder carries its name
        if (name !== target.name && basename(dir) !== name) {
          await rename(dir, join(appSkillsDir(), name))
        }
      } catch (error) {
        return failureOf(error)
      }
      const newId = userSkillId('app', name)
      changeSettings((settings) => {
        const kept = settings.states[target.id]
        if (newId !== target.id) {
          clearState(settings, target.id)
          clearState(settings, newId)
          if (kept) settings.states[newId] = kept
        }
        if (request.invoke) setStateValue(settings, newId, 'app', { invoke: request.invoke })
        for (const other of elsewhere) turnOff(settings, other)
      })
      return { ok: true, id: newId }
    }

    if (target && target.source === 'project') return fail('invalid')

    // ---- a new skill, or another source's skill copied in with the new text
    let name = request.name?.trim() ?? ''
    if (!target && !name) {
      name = suggestUserSkillName(title ?? '', { taken: (await takenNames()).keys() })
    }
    if (target && !name) name = target.name
    const keepsName = target !== undefined && name === target.name
    if (!keepsName) {
      const problem = validateNewUserSkillName(name)
      if (problem) return fail('bad-name', problem)
    }
    const taken = (await takenNames()).get(name.toLowerCase()) ?? []
    if (taken.length > 0) {
      if (!target) return fail('name-taken')
      if (!request.overwrite) return fail('exists')
    }
    if (target && target.unreadable === 'too-large') return fail('too-large')
    const elsewhere = await enabledElsewhere(name, target?.id)
    if (elsewhere.length > 0 && !request.turnOffSameName) {
      return fail('same-name-on', sourcesOf(elsewhere))
    }

    const work = await makeWorkDir()
    try {
      if (target) await copyFolderInto(target.dir, work)
      const base = target ? await readSkillMdText(target.dir) : undefined
      const keptTemplate = target && base !== undefined ? target.template : undefined
      const text = renderSkillMd(
        {
          name,
          description,
          title,
          template: templatePath ?? keptTemplate,
          editors: editorsTextOf(request.editors, base),
          body: request.body,
        },
        base,
      )
      if (template) {
        await mkdir(join(work, 'assets'), { recursive: true })
        await writeFile(join(work, 'assets', template.fileName), template.bytes)
      }
      await writeFile(join(work, 'SKILL.md'), text)
      await place(work, name, target ? taken : [])
    } catch (error) {
      return failureOf(error)
    } finally {
      await rm(work, { recursive: true, force: true }).catch(() => undefined)
    }
    const id = userSkillId('app', name)
    changeSettings((settings) => {
      clearState(settings, id)
      if (request.invoke) setStateValue(settings, id, 'app', { invoke: request.invoke })
      if (target) turnOff(settings, target)
      for (const other of elsewhere) turnOff(settings, other)
    })
    return { ok: true, id }
  }

  return {
    appSkillsDir,

    /** Every skill of the settings list (project skills are the agent window's only) */
    async list(): Promise<UserSkillView[]> {
      const all = await resolved()
      const { shadowed } = pickEnabledUserSkills(all)
      const pushedBack = new Map(shadowed.map((entry) => [entry.skill.id, entry.by]))
      const views: UserSkillView[] = []
      for (const skill of all) {
        let github: UserSkillView['github']
        if (skill.source === 'app' && skill.github) {
          const record = await readIeumSourceRecord(skill.dir)
          if (record) {
            github = {
              repo: record.repo,
              ref: record.ref,
              path: record.path,
              commit: record.commit,
            }
          }
        }
        const owned = skill.source === 'app' && (await ownedDir(skill)) !== undefined
        views.push(viewOf(skill, github, pushedBack.get(skill.id), owned))
      }
      return views
    },

    /** A skill's text for the read-only view and the editor */
    async read(id: string): Promise<UserSkillsResult<{ skill: UserSkillContent }>> {
      const skill = await find(id)
      if (!skill) return fail('not-found')
      const listed = await listSkillFolderFiles(skill.dir, FOLDER_LIMITS)
      if (!listed || listed.tooLarge) return fail(listed ? 'too-large' : 'unreadable')
      const text = await readSkillMdText(skill.dir)
      const parsed = text === undefined ? undefined : parseSkillMd(text)
      return {
        ok: true,
        skill: {
          id: skill.id,
          name: skill.name,
          title: skill.title,
          description: skill.description,
          body: parsed?.body ?? text ?? '',
          template: skill.template,
          ...(skill.fileEditors ? { editors: skill.fileEditors } : {}),
          files: listed.files
            .filter((file) => file.rel !== IEUM_SOURCE_FILE)
            .map((file) => ({ rel: file.rel, size: file.size })),
        },
      }
    },

    /** On/off, when it is used, and where; an own skill's where-used is in its file */
    async setState(id: string, patch: UserSkillStatePatch): Promise<UserSkillsResult> {
      const skill = await find(id)
      if (!skill) return fail('not-found')
      if (patch.enabled === true && skill.hidden) return fail('hidden')
      if (patch.enabled === true && skill.unreadable) return fail('unreadable')
      if (patch.editors !== undefined && (await ownedDir(skill))) return fail('invalid')
      changeSettings((settings) =>
        setStateValue(settings, skill.id, skill.source, patch, skill.fileEditors),
      )
      return { ok: true }
    },

    async hideBuiltin(id: string): Promise<UserSkillsResult> {
      const skill = await find(id)
      if (!skill) return fail('not-found')
      if (skill.source !== 'builtin') return fail('invalid')
      changeSettings((settings) => {
        if (!settings.hiddenBuiltins.some((name) => sameName(name, skill.name))) {
          settings.hiddenBuiltins.push(skill.name)
        }
        clearState(settings, skill.id)
      })
      return { ok: true }
    },

    /** Show hidden builtins again; each comes back in its initial state */
    unhideBuiltins(names?: readonly string[]): UserSkillsResult {
      changeSettings((settings) => {
        const shown = names
          ? settings.hiddenBuiltins.filter((hidden) => names.some((name) => sameName(name, hidden)))
          : [...settings.hiddenBuiltins]
        settings.hiddenBuiltins = settings.hiddenBuiltins.filter(
          (hidden) => !shown.includes(hidden),
        )
        for (const name of shown) clearState(settings, userSkillId('builtin', name))
      })
      return { ok: true }
    },

    /** An own skill to the OS trash; any other source is refused */
    async remove(id: string): Promise<UserSkillsResult> {
      const skill = await find(id)
      if (!skill) return fail('not-found')
      const dir = await ownedDir(skill)
      if (!dir) return fail('not-owned')
      try {
        await deps.trash(dir)
      } catch {
        return fail('failed')
      }
      changeSettings((settings) => clearState(settings, skill.id))
      return { ok: true }
    },

    /**
     * Copy a builtin or another program's skill into the app's folder under
     * the same name and turn the original off. A taken name needs `overwrite`
     * (the own skill it replaces goes to the OS trash).
     */
    async copyToMine(id: string, overwrite: boolean): Promise<UserSkillsResult<{ id: string }>> {
      const skill = await find(id)
      if (!skill) return fail('not-found')
      if (skill.source === 'app' || skill.source === 'project') return fail('invalid')
      if (skill.unreadable)
        return fail(skill.unreadable === 'too-large' ? 'too-large' : 'unreadable')
      const taken = (await takenNames()).get(skill.name.toLowerCase()) ?? []
      if (taken.length > 0 && !overwrite) return fail('exists')
      const work = await makeWorkDir()
      try {
        await copyFolderInto(skill.dir, work)
        // the copy is mine to edit: the person's where-used choice goes into its file
        const base = await readSkillMdText(work)
        const parsed = base === undefined ? undefined : parseSkillMd(base)
        const editors = editorsTextOf(skill.editors ?? 'all', base)
        if (parsed && editors !== undefined) {
          await writeFile(
            join(work, 'SKILL.md'),
            renderSkillMd(
              {
                name: parsed.name ?? skill.name,
                description: parsed.description ?? '',
                title: parsed.metadata[IEUM_TITLE_KEY],
                template: parsed.metadata[IEUM_TEMPLATE_KEY],
                editors,
                body: parsed.body,
              },
              base,
            ),
          )
        }
        await place(work, skill.name, taken)
      } catch (error) {
        return failureOf(error)
      } finally {
        await rm(work, { recursive: true, force: true }).catch(() => undefined)
      }
      const newId = userSkillId('app', skill.name)
      changeSettings((settings) => {
        clearState(settings, newId)
        turnOff(settings, skill)
      })
      return { ok: true, id: newId }
    },

    /** A free name for a new skill from its title */
    async suggestName(title: string): Promise<string> {
      return suggestUserSkillName(title, { taken: (await takenNames()).keys() })
    },

    /** The strict rule for a new name; `forId` is the own skill being renamed */
    async checkName(
      name: string,
      forId?: string,
    ): Promise<{ ok: true } | { ok: false; problem: UserSkillNameProblem | 'taken' }> {
      const skill = forId ? await find(forId) : undefined
      const except = skill ? await ownedDir(skill) : undefined
      const problem = await nameProblem(name, except)
      return problem ? { ok: false, problem } : { ok: true }
    },

    /** The settings editor's save: a new skill, or an edit of an own skill */
    async save(input: UserSkillSaveInput): Promise<UserSkillsResult<{ id: string }>> {
      if (input.id) {
        const target = await find(input.id)
        if (!target) return fail('not-found')
        if (target.source !== 'app') return fail('not-owned')
      }
      return writeSkill({
        title: input.title,
        name: input.name,
        description: input.description,
        body: input.body,
        invoke: undefined,
        template: undefined,
        targetId: input.id,
        overwrite: false,
        editors: input.editors,
        turnOffSameName: input.turnOffSameName === true,
      })
    },

    /**
     * A skill card's save (spec 5.6): a new skill, a change to an own skill
     * (its template kept unless a new one is given), or another source's
     * skill copied in with the new text and the original turned off.
     */
    saveFromCard(input: UserSkillCardSaveInput): Promise<UserSkillsResult<{ id: string }>> {
      return writeSkill({
        title: input.title,
        name: input.name,
        description: input.description,
        body: input.body,
        invoke: input.invoke,
        template: input.template,
        targetId: input.targetId,
        overwrite: input.overwrite === true,
        editors: input.editors,
        turnOffSameName: input.turnOffSameName === true,
      })
    },

    /** Find the skills of any import source for the preview (GitHub connects only for an address) */
    prepare(source: SkillImportSource, signal?: AbortSignal): Promise<SkillImport> {
      return prepareSkillImport(source, {
        appSkillsDir: appSkillsDir(),
        homeDir: deps.homeDir(),
        tempDir: deps.tempDir(),
        fetch: deps.fetch,
        signal,
      })
    },

    /**
     * Install the checked skills of a previewed import. A new skill starts on,
     * used on its own; one that replaces an own skill of the same name keeps
     * that skill's settings (`keepAcrossReplace`).
     */
    async install(
      imported: SkillImport,
      request: Pick<UserSkillInstallRequest, 'selected' | 'onCollision'>,
    ): Promise<
      UserSkillsResult<{ installed: Array<{ key: string; id: string }>; skipped: string[] }>
    > {
      try {
        const replacedByKey = new Map<string, ReplacedSkill>()
        for (const candidate of imported.candidates) {
          if (!request.selected.includes(candidate.key)) continue
          if (request.onCollision[candidate.key] !== 'replace') continue
          const old = await replacedSkillOf(userSkillId('app', candidate.name))
          if (old) replacedByKey.set(candidate.key, old)
        }
        const done = await installImportedSkills(imported, {
          appSkillsDir: appSkillsDir(),
          selected: request.selected,
          onCollision: request.onCollision,
          discardReplaced: (dir) => deps.trash(dir),
        })
        const installed: Array<{ key: string; id: string }> = []
        for (const skill of done.installed) {
          const id = userSkillId('app', skill.name)
          installed.push({ key: skill.key, id })
          const old = skill.replaced ? replacedByKey.get(skill.key) : undefined
          if (old) await keepAcrossReplace(old, id, skill.dir)
          else changeSettings((settings) => clearState(settings, id))
        }
        return { ok: true, installed, skipped: done.skipped }
      } catch (error) {
        return failureOf(error)
      }
    },

    dispose(imported: SkillImport): Promise<void> {
      return disposeSkillImport(imported)
    },

    /**
     * A found skill of a previewed import, opened to read before installing
     * (decision 0127): its SKILL.md after the front matter, cut at the display
     * limit, and the text files the preview can open. Reads only the import's
     * own files, as the folder listing finds them; nothing is installed.
     */
    async readImported(
      imported: SkillImport,
      key: string,
    ): Promise<UserSkillsResult<{ content: UserSkillImportContent }>> {
      const candidate = imported.candidates.find((found) => found.key === key)
      if (!candidate) return fail('not-found')
      if (candidate.problem === 'too-large') return fail('too-large')
      const listed = await listSkillFolderFiles(candidate.dir, FOLDER_LIMITS)
      if (!listed || listed.tooLarge) return fail(listed ? 'too-large' : 'unreadable')
      const text = await readListedSkillMd(candidate.dir)
      if (text === undefined) return fail('unreadable')
      return {
        ok: true,
        content: {
          body: cutForPreview(parseSkillMd(text)?.body ?? text, false),
          files: listed.files
            .filter((file) => isOtherTextFile(file.rel) && !sameName(file.rel, 'SKILL.md'))
            .map((file) => ({ rel: file.rel, size: file.size })),
        },
      }
    },

    /** One text file of a previewed import's skill, cut at the display limit */
    async readImportedFile(
      imported: SkillImport,
      key: string,
      rel: string,
    ): Promise<UserSkillsResult<{ file: UserSkillImportText }>> {
      const candidate = imported.candidates.find((found) => found.key === key)
      if (!candidate) return fail('not-found')
      if (candidate.problem === 'too-large') return fail('too-large')
      const file = await skillTextFileIn(candidate.dir, rel)
      if ('ok' in file) return file
      try {
        return { ok: true, file: await readFileHead(file.path) }
      } catch {
        return fail('unreadable')
      }
    },

    /** Check an own GitHub skill for an update; connects only when called */
    async checkUpdate(
      id: string,
      signal?: AbortSignal,
    ): Promise<{ ok: true; check: GitHubSkillUpdateCheck } | UserSkillsFail> {
      const skill = await find(id)
      if (!skill) return fail('not-found')
      const dir = await ownedDir(skill)
      if (!dir) return fail('not-owned')
      if (!skill.github) return fail('not-github')
      try {
        const check = await checkGitHubSkillUpdate({
          skillDir: dir,
          appSkillsDir: appSkillsDir(),
          fetch: deps.fetch,
          tempDir: deps.tempDir(),
          signal,
        })
        return { ok: true, check }
      } catch (error) {
        return failureOf(error)
      }
    },

    /** Apply a found update; the skill's settings stay as they were (`keepAcrossReplace`) */
    async applyUpdate(
      id: string,
      check: Extract<GitHubSkillUpdateCheck, { status: 'changed' }>,
    ): Promise<UserSkillsResult<{ id: string }>> {
      const skill = await find(id)
      const dir = skill ? await ownedDir(skill) : undefined
      if (!skill || !dir) {
        await disposeSkillImport(check.update)
        return fail(skill ? 'not-owned' : 'not-found')
      }
      try {
        const old = await replacedSkillOf(skill.id)
        const done = await applyGitHubSkillUpdate(check, {
          appSkillsDir: appSkillsDir(),
          skillDir: dir,
          discardReplaced: (replaced) => deps.trash(replaced),
        })
        const newId = userSkillId('app', done.name)
        await keepAcrossReplace(old ?? { id: skill.id, editorsText: undefined }, newId, done.dir)
        return { ok: true, id: newId }
      } catch (error) {
        return failureOf(error)
      }
    },

    async exportInfo(
      id: string,
    ): Promise<UserSkillsResult<{ fileName: string; includesTemplate: boolean }>> {
      const skill = await find(id)
      if (!skill) return fail('not-found')
      const dir = await ownedDir(skill)
      if (!dir) return fail('not-owned')
      try {
        const info = await skillExportInfo(dir)
        return { ok: true, fileName: info.fileName, includesTemplate: info.includesTemplate }
      } catch (error) {
        return failureOf(error)
      }
    },

    async exportTo(id: string, outPath: string): Promise<UserSkillsResult<{ path: string }>> {
      const skill = await find(id)
      if (!skill) return fail('not-found')
      const dir = await ownedDir(skill)
      if (!dir) return fail('not-owned')
      try {
        await exportSkillZip(dir, outPath)
        return { ok: true, path: outPath }
      } catch (error) {
        return failureOf(error)
      }
    },

    /** Write several own skills into one zip, a folder per skill */
    async exportBundleTo(
      ids: readonly string[],
      outPath: string,
    ): Promise<UserSkillsResult<{ path: string }>> {
      const dirs: string[] = []
      for (const id of ids) {
        const skill = await find(id)
        if (!skill) return fail('not-found')
        const dir = await ownedDir(skill)
        if (!dir) return fail('not-owned')
        dirs.push(dir)
      }
      try {
        await exportSkillBundleZip(dirs, outPath)
        return { ok: true, path: outPath }
      } catch (error) {
        return failureOf(error)
      }
    },

    /** The folder "open folder" shows: own skills and other programs' (not builtin) */
    async folderOf(id: string): Promise<UserSkillsResult<{ dir: string }>> {
      const skill = await find(id)
      if (!skill) return fail('not-found')
      if (skill.source === 'builtin' || skill.source === 'project') return fail('invalid')
      return { ok: true, dir: skill.dir }
    },

    /**
     * `use_skill` (spec 5.8): an enabled skill's body and its text files. A
     * skill that is off, hidden, unreadable or for the agent window only is
     * refused.
     */
    async aiRead(id: string): Promise<UserSkillsResult<{ skill: UserSkillAiRead }>> {
      const skill = await find(id)
      if (!skill) return fail('not-found')
      if (skill.agentOnly) return fail('agent-only')
      if (skill.unreadable) return fail('unreadable')
      if (!skill.enabled) return fail('disabled')
      const listed = await listSkillFolderFiles(skill.dir, FOLDER_LIMITS)
      if (!listed || listed.tooLarge) return fail(listed ? 'too-large' : 'unreadable')
      const text = await readSkillMdText(skill.dir)
      const parsed = text === undefined ? undefined : parseSkillMd(text)
      if (!parsed) return fail('unreadable')
      return {
        ok: true,
        skill: {
          id: skill.id,
          name: skill.name,
          title: skill.title,
          body: parsed.body,
          files: listed.files.map((file) => file.rel).filter(isOtherTextFile),
          template: skill.templateExists ? skill.template : undefined,
          hasScripts: skill.hasScripts,
          // read again from the text sent now, not the list's copy
          mcpServers: mcpServersOfSkillMd(parsed),
        },
      }
    },

    /**
     * The template document of an enabled skill (spec 5.7), for its copy in a
     * new tab: the file's absolute place, only when it is a document the
     * editors open and it lies inside the skill's folder. A skill whose
     * template file is gone answers `no-template`; nothing is read here.
     */
    async templateFile(
      id: string,
    ): Promise<UserSkillsResult<{ path: string; fileName: string; title: string }>> {
      const skill = await find(id)
      if (!skill) return fail('not-found')
      if (skill.agentOnly) return fail('agent-only')
      if (skill.unreadable) return fail('unreadable')
      if (!skill.enabled) return fail('disabled')
      if (!skill.template) return fail('no-template')
      const fileName = templateFileNameOf(skill.template)
      if (!fileName) return fail('bad-template')
      const path = join(skill.dir, ...skill.template.split('/'))
      const info = await stat(path).catch(() => undefined)
      if (!info?.isFile()) return fail('no-template')
      const root = await realpath(skill.dir).catch(() => undefined)
      const real = await realpath(path).catch(() => undefined)
      if (!root || !real || !isInsideDir(real, root)) return fail('bad-template')
      if (info.size > SKILL_TEMPLATE_MAX_BYTES) return fail('too-large')
      return { ok: true, path: real, fileName, title: skill.title }
    },

    /**
     * `read_skill_file` (spec 5.8): one text file inside an enabled skill's
     * folder, by its path inside the folder. The file must be one the folder
     * listing finds (links leading out are never listed), its real place must
     * be inside the folder's, and it must be a text file under the size limit.
     */
    async aiReadFile(id: string, rel: string): Promise<UserSkillsResult<{ text: string }>> {
      const skill = await find(id)
      if (!skill) return fail('not-found')
      if (skill.agentOnly) return fail('agent-only')
      if (skill.unreadable) return fail('unreadable')
      if (!skill.enabled) return fail('disabled')
      const file = await skillTextFileIn(skill.dir, rel)
      if ('ok' in file) return file
      if (file.size > aiFileMax) return fail('too-large')
      try {
        return { ok: true, text: await readFile(file.path, 'utf8') }
      } catch {
        return fail('unreadable')
      }
    },

    /**
     * The skills an agent session takes (spec 6.1): every enabled skill,
     * builtin, own, Claude's, plugins' and Codex's, plus the project's when a
     * folder is given. Off, hidden and unreadable skills are left out.
     */
    async enabledForAgent(projectRoot?: string): Promise<AgentEnabledSkill[]> {
      const all = await resolved(projectRoot)
      return all
        .filter((skill) => skill.enabled)
        .map((skill) => ({
          id: skill.id,
          source: skill.source,
          plugin: skill.plugin,
          name: skill.name,
          title: skill.title,
          description: skill.description,
          dir: skill.dir,
          invoke: skill.invoke,
          agentOnly: skill.agentOnly,
        }))
    },
  }
}

export type UserSkillsService = ReturnType<typeof createUserSkillsService>
