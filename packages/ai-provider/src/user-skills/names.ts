/**
 * Skill names and identifiers: reading names, the strict rule for names the
 * app gives new skills, name suggestions, and `source:name` identifiers.
 */
import { randomBytes } from 'node:crypto'
import {
  NEW_USER_SKILL_NAME_MAX,
  RESERVED_USER_SKILL_NAMES,
  USER_SKILL_NAME,
  USER_SKILL_SOURCES,
} from './constants'
import type { UserSkillSource } from './types'

/** `genoffice` and `ieumoffice`, in any case, are never read or made */
export function isReservedUserSkillName(name: string): boolean {
  return RESERVED_USER_SKILL_NAMES.has(name.trim().toLowerCase())
}

/** A name the list accepts from any source */
export function isValidUserSkillName(name: string): boolean {
  return USER_SKILL_NAME.test(name)
}

export type NewUserSkillNameProblem =
  'empty' | 'too-long' | 'characters' | 'hyphen-edge' | 'double-hyphen' | 'reserved'

/**
 * The strict rule for a name the app writes: lowercase letters, digits and
 * hyphens, 1 to 64 characters, no hyphen at either end, no `--`. Returns the
 * first problem, or `undefined` when the name is fine.
 */
export function validateNewUserSkillName(name: string): NewUserSkillNameProblem | undefined {
  if (name.length === 0) return 'empty'
  if (name.length > NEW_USER_SKILL_NAME_MAX) return 'too-long'
  if (/[^a-z0-9-]/.test(name)) return 'characters'
  if (name.startsWith('-') || name.endsWith('-')) return 'hyphen-edge'
  if (name.includes('--')) return 'double-hyphen'
  if (isReservedUserSkillName(name)) return 'reserved'
  return undefined
}

const RANDOM_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'

function randomSuffix(): string {
  return Array.from(randomBytes(6), (byte) => RANDOM_ALPHABET[byte % RANDOM_ALPHABET.length]).join(
    '',
  )
}

function trimToLength(name: string, max: number): string {
  return name.slice(0, max).replace(/-+$/, '')
}

export interface SuggestUserSkillNameOptions {
  /** names already used; compared without case */
  taken?: Iterable<string>
  /** the short random part of `skill-<random>`; lowercase letters and digits */
  random?: () => string
}

/**
 * An English name for a new skill made from its title. A title with no Latin
 * letters or digits gives `skill-<short random>`. A name already taken gets
 * `-2`, `-3`, ... The result passes `validateNewUserSkillName`.
 */
export function suggestUserSkillName(
  title: string,
  options: SuggestUserSkillNameOptions = {},
): string {
  const slug = trimToLength(
    title
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, ''),
    NEW_USER_SKILL_NAME_MAX,
  )
  const base =
    slug && !isReservedUserSkillName(slug)
      ? slug
      : trimToLength(`skill-${(options.random ?? randomSuffix)()}`, NEW_USER_SKILL_NAME_MAX)
  const taken = new Set(Array.from(options.taken ?? [], (name) => name.toLowerCase()))
  if (!taken.has(base)) return base
  for (let n = 2; ; n++) {
    const suffix = `-${n}`
    const candidate = `${trimToLength(base, NEW_USER_SKILL_NAME_MAX - suffix.length)}${suffix}`
    if (!taken.has(candidate)) return candidate
  }
}

/** The identifier of a skill: `source:name`, `plugin:<plugin>:<name>` for plugins */
export function userSkillId(source: UserSkillSource, name: string, plugin?: string): string {
  return source === 'plugin' ? `plugin:${plugin ?? ''}:${name}` : `${source}:${name}`
}

export interface ParsedUserSkillId {
  source: UserSkillSource
  name: string
  plugin?: string
}

/** Read an identifier back; `undefined` for anything not of the known shapes */
export function parseUserSkillId(id: string): ParsedUserSkillId | undefined {
  const first = id.indexOf(':')
  if (first <= 0) return undefined
  const source = id.slice(0, first) as UserSkillSource
  if (!USER_SKILL_SOURCES.includes(source)) return undefined
  const rest = id.slice(first + 1)
  if (source === 'plugin') {
    const last = rest.lastIndexOf(':')
    if (last <= 0) return undefined
    const plugin = rest.slice(0, last)
    const name = rest.slice(last + 1)
    return isValidUserSkillName(name) ? { source, plugin, name } : undefined
  }
  return isValidUserSkillName(rest) ? { source, name: rest } : undefined
}
