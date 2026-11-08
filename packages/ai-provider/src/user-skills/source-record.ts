/**
 * The GitHub source record (`.ieum-source.json`) at the top of a skill
 * installed from GitHub: where it came from and what its folder held then.
 * The update check reads it; export leaves it out.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { IEUM_SOURCE_FILE } from './constants'

export interface IeumSourceRecord {
  kind: 'github'
  /** `owner/repo` */
  repo: string
  /** the branch name settled when the skill was taken */
  ref: string
  /** the skill folder inside the repository, `''` for the top */
  path: string
  commit: string
  /** ISO time, whole seconds, UTC (`2026-10-21T09:00:00Z`) */
  installedAt: string
  /** `skillContentHash` of the installed folder */
  contentHash: string
}

/** `2026-10-21T09:00:00Z`: ISO time without the milliseconds */
export function isoSeconds(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/** The record as written to disk, keys in the documented order */
export function renderIeumSourceRecord(record: IeumSourceRecord): string {
  const ordered: IeumSourceRecord = {
    kind: 'github',
    repo: record.repo,
    ref: record.ref,
    path: record.path,
    commit: record.commit,
    installedAt: record.installedAt,
    contentHash: record.contentHash,
  }
  return `${JSON.stringify(ordered, null, 2)}\n`
}

/** Read a skill folder's record; `undefined` when missing or not of the documented shape */
export async function readIeumSourceRecord(
  skillDir: string,
): Promise<IeumSourceRecord | undefined> {
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(join(skillDir, IEUM_SOURCE_FILE), 'utf8'))
  } catch {
    return undefined
  }
  if (!raw || typeof raw !== 'object') return undefined
  const value = raw as Record<string, unknown>
  const text = (key: string) =>
    typeof value[key] === 'string' ? (value[key] as string) : undefined
  const repo = text('repo')
  const ref = text('ref')
  const path = text('path')
  const commit = text('commit')
  if (value.kind !== 'github' || !repo || !ref || path === undefined || !commit) return undefined
  return {
    kind: 'github',
    repo,
    ref,
    path,
    commit,
    installedAt: text('installedAt') ?? '',
    contentHash: text('contentHash') ?? '',
  }
}
