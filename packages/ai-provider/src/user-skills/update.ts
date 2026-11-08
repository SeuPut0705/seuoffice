/**
 * The update check of a skill installed from GitHub, run only when the person
 * asks: the recorded branch's commit now, and whether the skill folder at the
 * recorded path differs from what was installed. Applying an update replaces
 * the folder as a whole (same folder name) and writes a new source record;
 * on/off states live in the settings file and are not touched here.
 */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { extractSkillArchive } from './archive'
import { IEUM_SOURCE_FILE, MAX_USER_SKILL_BYTES, MAX_USER_SKILL_FILES } from './constants'
import { SkillImportError } from './errors'
import { isInsideDir, listSkillFolderFiles, skillContentHash, type SkillFolderFile } from './folder'
import {
  MAX_SKILL_ARCHIVE_BYTES,
  downloadGitHubArchive,
  githubRefCommit,
  parseGitHubSkillAddress,
  type SkillFetch,
} from './github'
import {
  appSkillFoldersByName,
  commitSkillInstall,
  describeSkillCandidate,
  disposeSkillImport,
  findSkillFolders,
  type CommitSkillInstallOptions,
  type InstalledSkill,
  type SkillImport,
} from './import'
import { readIeumSourceRecord, type IeumSourceRecord } from './source-record'

/** One file that differs between the installed skill and the new one */
export interface SkillFileChange {
  /** the path inside the skill folder, `/` between parts */
  rel: string
  change: 'added' | 'removed' | 'modified'
}

interface UpdateCheckBase {
  record: IeumSourceRecord
  /** the commit the recorded branch points at now */
  commit: string
  /** the installed folder differs from what was installed (the person changed it) */
  locallyEdited: boolean
}

export type GitHubSkillUpdateCheck =
  | (UpdateCheckBase & { status: 'up-to-date' })
  | (UpdateCheckBase & {
      status: 'changed'
      changedFiles: SkillFileChange[]
      /**
       * The new version, with one candidate for the preview. Pass it to
       * `applyGitHubSkillUpdate`, or to `disposeSkillImport` when the person
       * does not update.
       */
      update: SkillImport
    })

export interface CheckGitHubSkillUpdateOptions {
  /** the installed skill's folder (inside the app's skills folder) */
  skillDir: string
  appSkillsDir: string
  fetch: SkillFetch
  /** where the check's temporary folder is made */
  tempDir: string
  signal?: AbortSignal | undefined
  maxArchiveBytes?: number | undefined
}

const LIMITS = { files: MAX_USER_SKILL_FILES, bytes: MAX_USER_SKILL_BYTES }

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function filesByRel(dir: string): Promise<Map<string, SkillFolderFile>> {
  const listed = await listSkillFolderFiles(dir, LIMITS)
  if (!listed) throw new SkillImportError('failed', `Cannot read ${dir}`)
  if (listed.tooLarge) throw new SkillImportError('too-large', 'A skill folder is too large')
  return new Map(
    listed.files.filter((file) => file.rel !== IEUM_SOURCE_FILE).map((file) => [file.rel, file]),
  )
}

/** The files that differ between two skill folders (the source record left out), sorted */
export async function diffSkillFolders(
  installedDir: string,
  newDir: string,
): Promise<SkillFileChange[]> {
  const before = await filesByRel(installedDir)
  const after = await filesByRel(newDir)
  const changes: SkillFileChange[] = []
  for (const [rel, file] of after) {
    const old = before.get(rel)
    if (!old) {
      changes.push({ rel, change: 'added' })
      continue
    }
    if (old.size !== file.size) {
      changes.push({ rel, change: 'modified' })
      continue
    }
    const [a, b] = await Promise.all([readFile(old.path), readFile(file.path)])
    if (sha256(a) !== sha256(b)) changes.push({ rel, change: 'modified' })
  }
  for (const rel of before.keys()) {
    if (!after.has(rel)) changes.push({ rel, change: 'removed' })
  }
  return changes.sort((x, y) => (x.rel < y.rel ? -1 : x.rel > y.rel ? 1 : 0))
}

/**
 * Check an installed GitHub skill for an update. Connects only to the three
 * GitHub hosts and only when called. The archive is downloaded only when the
 * branch has moved since the install.
 */
export async function checkGitHubSkillUpdate(
  options: CheckGitHubSkillUpdateOptions,
): Promise<GitHubSkillUpdateCheck> {
  const { skillDir, appSkillsDir } = options
  if (!isInsideDir(skillDir, appSkillsDir) || isInsideDir(appSkillsDir, skillDir)) {
    throw new SkillImportError('invalid-source', 'Only skills of the app folder are updated')
  }
  const record = await readIeumSourceRecord(skillDir)
  if (!record) throw new SkillImportError('not-github', 'The skill has no GitHub source record')
  const address = parseGitHubSkillAddress(record.repo)
  if (!address || address.skill !== undefined) {
    throw new SkillImportError('not-github', 'The source record names no repository')
  }
  const pathParts = record.path ? record.path.split('/') : []
  if (pathParts.some((part) => !part || part === '.' || part === '..' || part.includes('\\'))) {
    throw new SkillImportError('not-github', 'The source record has an unusable path')
  }
  const request = { fetch: options.fetch, signal: options.signal }
  const commit = await githubRefCommit(address.owner, address.repo, record.ref, request)
  const installedHash = await skillContentHash(skillDir)
  const locallyEdited = installedHash !== record.contentHash
  if (commit === record.commit) return { status: 'up-to-date', record, commit, locallyEdited }

  const archive = await downloadGitHubArchive(address.owner, address.repo, commit, {
    ...request,
    maxBytes: options.maxArchiveBytes ?? MAX_SKILL_ARCHIVE_BYTES,
  })
  if (options.signal?.aborted) throw new SkillImportError('cancelled', 'Cancelled')
  await mkdir(options.tempDir, { recursive: true })
  const work = await mkdtemp(join(options.tempDir, 'ieum-skill-update-'))
  const update: SkillImport = {
    origin: {
      kind: 'github',
      repo: record.repo,
      ref: record.ref,
      commit,
      path: record.path,
    },
    root: join(work, 'repo'),
    candidates: [],
    rootLicense: undefined,
    tempDir: work,
  }
  try {
    await mkdir(update.root)
    await extractSkillArchive(archive, update.root, { stripTopFolder: true, subPath: record.path })
    if (options.signal?.aborted) throw new SkillImportError('cancelled', 'Cancelled')
    const newDir = record.path ? join(update.root, ...pathParts) : update.root
    const found = (await stat(newDir).catch(() => undefined))?.isDirectory()
      ? await findSkillFolders(update.root, record.path, { maxDepth: 0 })
      : []
    if (found.length === 0) throw new SkillImportError('no-skills', 'The skill is no longer there')
    const newHash = await skillContentHash(newDir)
    if (newHash === record.contentHash || newHash === installedHash) {
      await disposeSkillImport(update)
      return { status: 'up-to-date', record, commit, locallyEdited }
    }
    const existing = await appSkillFoldersByName(appSkillsDir)
    const candidate = await describeSkillCandidate(newDir, record.path, existing, [skillDir])
    if (!candidate) throw new SkillImportError('no-skills', 'The skill is no longer there')
    update.candidates.push(candidate)
    const changedFiles = await diffSkillFolders(skillDir, newDir)
    return { status: 'changed', record, commit, locallyEdited, changedFiles, update }
  } catch (error) {
    await rm(work, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}

export interface ApplyGitHubSkillUpdateOptions extends CommitSkillInstallOptions {
  appSkillsDir: string
  /** the installed skill's folder; the update takes its place under the same folder name */
  skillDir: string
}

/**
 * Replace an installed GitHub skill with the version a check found, under the
 * same folder name, with a new source record. The check's temporary folder is
 * removed whether this succeeds or not.
 */
export async function applyGitHubSkillUpdate(
  check: Extract<GitHubSkillUpdateCheck, { status: 'changed' }>,
  options: ApplyGitHubSkillUpdateOptions,
): Promise<InstalledSkill> {
  try {
    const candidate = check.update.candidates[0]
    if (!candidate) throw new SkillImportError('no-skills', 'Nothing to update')
    if (candidate.problem === 'too-large') {
      throw new SkillImportError('too-large', `${candidate.name} is too large`)
    }
    if (candidate.problem) {
      throw new SkillImportError('not-installable', `${candidate.name} cannot be installed`)
    }
    const folderName = basename(options.skillDir)
    const [dir] = await commitSkillInstall(
      options.appSkillsDir,
      [
        {
          candidate,
          folderName,
          replaceDirs: [options.skillDir],
          source: {
            repo: check.record.repo,
            ref: check.record.ref,
            path: check.record.path,
            commit: check.commit,
          },
        },
      ],
      options,
    )
    return { key: candidate.key, name: candidate.name, dir: dir!, replaced: true }
  } finally {
    await disposeSkillImport(check.update)
  }
}
