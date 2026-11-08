/**
 * Folders the app makes for attachments it fetched itself. The folder right
 * under one of these is a random or file id, meaningless to the person:
 * `<temp>/ieumoffice-drive-attach/<random>/name`, `<data>/drive-cache/<file id>/name`.
 */
const APP_MADE_PARENTS: ReadonlySet<string> = new Set(['ieumoffice-drive-attach', 'drive-cache'])

const DRIVE_ROOT = /^[A-Za-z]:$/

/**
 * The name of the folder directly containing the file at `path`, used to tell
 * apart attachments that share a file name. Both `\` and `/` separate. Returns
 * '' when there is no folder to name: a bare file name, a file at a drive or
 * filesystem root, or a file inside an app-made attachment folder. Pure: the
 * same path always gives the same label.
 */
export function attachmentFolderLabel(path: string): string {
  const parts = path.split(/[\\/]/).filter((part) => part !== '')
  if (parts.length < 2) return ''
  const folder = parts[parts.length - 2] ?? ''
  if (folder === '.' || folder === '..' || DRIVE_ROOT.test(folder)) return ''
  const parent = parts.length >= 3 ? parts[parts.length - 3] : undefined
  if (parent !== undefined && APP_MADE_PARENTS.has(parent)) return ''
  return folder
}
