/**
 * The one folder of the archive a picture may live in, and what a name inside
 * it may look like. The editor draws only these (a web address or a path on
 * this computer is never loaded), and reconciling writes only these: a picture
 * the file does not hold, or one named so that it could leave the folder, is
 * refused rather than saved as a reference nothing can show.
 */

export const RESOURCE_FOLDER = 'resources/'

/** Whether `name` is a plain file entry under `resources/`, with nowhere to climb out. */
export function isResourceEntry(name: unknown): name is string {
  if (typeof name !== 'string' || !name.startsWith(RESOURCE_FOLDER)) return false
  const rest = name.slice(RESOURCE_FOLDER.length)
  if (rest === '' || rest.includes('\\') || rest.includes(':')) return false
  // no way up or out of the folder, and no empty step
  if (rest.split('/').some((step) => step === '' || step === '.' || step === '..')) return false
  for (let at = 0; at < rest.length; at++) if (rest.charCodeAt(at) < 0x20) return false
  return true
}
