/**
 * Exporting one of the app's skills as `<name>.zip`: the skill folder as it
 * is, under a top folder named after the skill (the layout skill uploads
 * expect, and one the zip import reads back), without the GitHub source
 * record. The caller warns before the save dialog when a template document
 * goes in.
 */
import { randomBytes } from 'node:crypto'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import JSZip from 'jszip'
import { IEUM_SOURCE_FILE, MAX_USER_SKILL_BYTES, MAX_USER_SKILL_FILES } from './constants'
import { SkillImportError } from './errors'
import { listSkillFolderFiles, readUserSkillFolder, type SkillFolderLimits } from './folder'

export interface SkillExportInfo {
  /** the skill's name, also the top folder inside the zip */
  name: string
  /** `<name>.zip`, the save dialog's suggestion */
  fileName: string
  /** a template document is in the folder and goes into the zip */
  includesTemplate: boolean
  /** files that go into the zip */
  files: number
  bytes: number
}

const DEFAULT_LIMITS: SkillFolderLimits = {
  files: MAX_USER_SKILL_FILES,
  bytes: MAX_USER_SKILL_BYTES,
}

async function readForExport(skillDir: string, limits: SkillFolderLimits) {
  const skill = await readUserSkillFolder(skillDir, { source: 'app' })
  if (!skill) throw new SkillImportError('not-installable', 'This skill cannot be exported')
  const listed = await listSkillFolderFiles(skillDir, limits)
  if (!listed) throw new SkillImportError('failed', `Cannot read ${skillDir}`)
  if (listed.tooLarge) throw new SkillImportError('too-large', 'The skill folder is too large')
  const files = listed.files.filter((file) => file.rel !== IEUM_SOURCE_FILE)
  const info: SkillExportInfo = {
    name: skill.name,
    fileName: `${skill.name}.zip`,
    includesTemplate: skill.template !== undefined && skill.templateExists,
    files: files.length,
    bytes: files.reduce((sum, file) => sum + file.size, 0),
  }
  return { info, files }
}

/** What an export of this skill would hold, for the warning and the save dialog */
export async function skillExportInfo(
  skillDir: string,
  limits: SkillFolderLimits = DEFAULT_LIMITS,
): Promise<SkillExportInfo> {
  return (await readForExport(skillDir, limits)).info
}

/** The zip bytes of a skill export */
export async function buildSkillExportZip(
  skillDir: string,
  limits: SkillFolderLimits = DEFAULT_LIMITS,
): Promise<{ bytes: Uint8Array; info: SkillExportInfo }> {
  const { info, files } = await readForExport(skillDir, limits)
  const zip = new JSZip()
  for (const file of files) {
    zip.file(`${info.name}/${file.rel}`, await readFile(file.path))
  }
  const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
  return { bytes, info }
}

/**
 * Write a skill export to `outPath` (the place the person chose). The zip is
 * written next to it under a temporary name first, then renamed, so a failed
 * export leaves no broken file.
 */
export async function exportSkillZip(
  skillDir: string,
  outPath: string,
  limits: SkillFolderLimits = DEFAULT_LIMITS,
): Promise<SkillExportInfo> {
  const { bytes, info } = await buildSkillExportZip(skillDir, limits)
  const partial = join(
    dirname(outPath),
    `.${basename(outPath)}.${randomBytes(4).toString('hex')}.part`,
  )
  try {
    await writeFile(partial, bytes, { flag: 'wx' })
    await rename(partial, outPath)
  } catch {
    await rm(partial, { force: true }).catch(() => undefined)
    throw new SkillImportError('failed', `Could not write ${outPath}`)
  }
  return info
}
