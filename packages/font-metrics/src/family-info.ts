/**
 * Per-family facts the font pickers need but the renderer's font enumeration
 * (queryLocalFonts) does not report: it lists every family under its English
 * name only, so the Korean name and the Hangul coverage are read from the font
 * files' own tables.
 */
import { closeSync, openSync } from 'node:fs'

import {
  faceOffsets,
  fontDirsGeneration,
  norm,
  readTable,
  readTableDir,
  scannedFontFiles,
} from './sfnt'

export interface FamilyInfo {
  /** Korean family name (name table, Windows langID 0x0412) when the font carries one */
  ko?: string
  /** the font declares Hangul coverage, or carries a Korean name */
  hangul: boolean
}

const KOREAN_LANG_ID = 0x0412
const HANGUL = /[ᄀ-ᇿ㄰-㆏가-힣]/

export interface FamilyNameRecord {
  /** 1 = family, 16 = typographic family */
  id: 1 | 16
  name: string
  korean: boolean
}

/** Family-name records (nameID 1/16) of a name table, Windows/Unicode platforms only */
export function parseFamilyNames(buf: Buffer): FamilyNameRecord[] {
  const out: FamilyNameRecord[] = []
  if (buf.length < 6) return out
  const count = buf.readUInt16BE(2)
  const strBase = buf.readUInt16BE(4)
  for (let i = 0; i < count; i++) {
    const r = 6 + 12 * i
    if (r + 12 > buf.length) break
    const platform = buf.readUInt16BE(r)
    const nameId = buf.readUInt16BE(r + 6)
    if ((nameId !== 1 && nameId !== 16) || (platform !== 0 && platform !== 3)) continue
    const len = buf.readUInt16BE(r + 8)
    const off = strBase + buf.readUInt16BE(r + 10)
    if (len === 0 || len % 2 !== 0 || off + len > buf.length) continue
    const name = Buffer.from(buf.subarray(off, off + len))
      .swap16()
      .toString('utf16le')
    out.push({
      id: nameId,
      name,
      korean: platform === 3 && buf.readUInt16BE(r + 4) === KOREAN_LANG_ID,
    })
  }
  return out
}

/** OS/2 ulCodePageRange1 bit 19 (Korean Wansung) or 21 (Korean Johab); absent before OS/2 v1 */
export function declaresHangul(os2: Buffer | null): boolean {
  if (!os2 || os2.length < 82) return false
  return (os2.readUInt32BE(78) & ((1 << 19) | (1 << 21))) !== 0
}

/** One family spelling of one face, with the Korean spelling of the same nameID */
export interface FaceFamily {
  name: string
  ko?: string
  hangul: boolean
}

/**
 * A Korean name is paired with the other spellings of the same nameID only: a
 * face whose family (1) is `X Bold` under the typographic family (16) `X` must
 * not label `X` with the Korean of `X Bold`.
 */
export function faceFamilies(
  records: readonly FamilyNameRecord[],
  hangulDeclared: boolean,
): FaceFamily[] {
  const out: FaceFamily[] = []
  for (const id of [16, 1] as const) {
    const names = records.filter((r) => r.id === id)
    const ko = names.find((r) => r.korean && HANGUL.test(r.name))?.name
    for (const { name } of names) {
      if (out.some((f) => f.name === name)) continue
      out.push(ko ? { name, ko, hangul: true } : { name, hangul: hangulDeclared })
    }
  }
  return out
}

// The OS groups weight/width/slope faces into one family and drops those words
// from its name (`KoPubDotum Bold` → `KoPubDotum`, `A2Z 1 Thin` → `A2Z 1`), so an
// enumerated family can be a face's family name minus a style suffix.
const STYLE_SUFFIX =
  /^(?:[\s-]+(?:extra|ultra|semi|demi)?[\s-]?(?:thin|hairline|light|regular|normal|book|medium|bold|heavy|black|italic|oblique|condensed|narrow|expanded))+$/i

function mergeFaces(
  family: string,
  hits: readonly FaceFamily[],
  suffixOf?: (f: FaceFamily) => string,
) {
  let ko: string | undefined
  let hangul = false
  for (const f of hits) {
    hangul ||= f.hangul
    if (ko !== undefined || !f.ko) continue
    const suffix = suffixOf?.(f) ?? ''
    if (!f.ko.toLowerCase().endsWith(suffix.toLowerCase())) continue
    const name = f.ko.slice(0, f.ko.length - suffix.length).trim()
    if (name && norm(name) !== norm(family)) ko = name
  }
  return ko ? { ko, hangul } : { hangul }
}

/** Info for each enumerated family that is Korean in name or coverage; the rest are left out. */
export function resolveFamilyInfo(
  families: readonly string[],
  faces: readonly FaceFamily[],
): Array<[string, FamilyInfo]> {
  const exact = new Map<string, FaceFamily[]>()
  for (const f of faces) {
    const key = norm(f.name)
    const list = exact.get(key)
    if (list) list.push(f)
    else exact.set(key, [f])
  }
  const out: Array<[string, FamilyInfo]> = []
  for (const family of families) {
    const hits = exact.get(norm(family))
    let info: FamilyInfo
    if (hits) info = mergeFaces(family, hits)
    else {
      const lower = family.toLowerCase()
      const suffixOf = (f: FaceFamily) => f.name.slice(family.length)
      info = mergeFaces(
        family,
        faces.filter(
          (f) => f.name.toLowerCase().startsWith(lower) && STYLE_SUFFIX.test(suffixOf(f)),
        ),
        suffixOf,
      )
    }
    if (info.hangul || info.ko) out.push([family, info])
  }
  return out
}

function scanFile(path: string, faces: FaceFamily[], seen: Set<string>): void {
  let fd: number
  try {
    fd = openSync(path, 'r')
  } catch {
    return
  }
  try {
    for (const offset of faceOffsets(fd)) {
      const tables = readTableDir(fd, offset)
      if (!tables) continue
      const name = readTable(fd, tables, 'name', 1 << 20)
      if (!name) continue
      const hangul = declaresHangul(readTable(fd, tables, 'OS/2', 512))
      for (const f of faceFamilies(parseFamilyNames(name), hangul)) {
        // the faces of one family repeat the same spellings
        const key = `${f.name}\0${f.ko ?? ''}\0${f.hangul}`
        if (seen.has(key)) continue
        seen.add(key)
        faces.push(f)
      }
    }
  } catch {
    /* unreadable or malformed file: skip */
  } finally {
    closeSync(fd)
  }
}

let scan: Promise<FaceFamily[]> | null = null
let scanGeneration = -1

/** Scanned once per process (fonts installed later show up after a restart), yielding
 * between batches: the whole scan is ~0.5s of small reads, too long for one main-process turn.
 * Naming the app's own font folders (configureExtraFontDirs) starts it over. */
function installedFaces(): Promise<FaceFamily[]> {
  if (scanGeneration !== fontDirsGeneration()) {
    scan = null
    scanGeneration = fontDirsGeneration()
  }
  scan ??= (async () => {
    const faces: FaceFamily[] = []
    const seen = new Set<string>()
    let n = 0
    for (const path of scannedFontFiles()) {
      scanFile(path, faces, seen)
      if (++n % 16 === 0) await new Promise<void>((r) => setImmediate(r))
    }
    return faces
  })()
  return scan
}

const MAX_FAMILIES = 5000
const MAX_FAMILY_CHARS = 256

/** IPC entry: `families` is the renderer's enumeration, so it is validated as untrusted input. */
export async function familyInfoFor(families: unknown): Promise<Array<[string, FamilyInfo]>> {
  if (!Array.isArray(families)) return []
  const names = families
    .filter((f): f is string => typeof f === 'string' && f.length <= MAX_FAMILY_CHARS)
    .slice(0, MAX_FAMILIES)
  return resolveFamilyInfo(names, await installedFaces())
}
