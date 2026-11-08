/**
 * The names an export offers in the save dialog. The main process makes a
 * file name of them (no path characters, the extension of the format).
 */

/** The file name of a path, without its folder and without `.xmind`. */
function baseName(path: string): string {
  return path.replace(/^.*[/\\]/, '').replace(/\.xmind$/i, '')
}

/**
 * The name of the map: its file's name once it has one; before that the
 * central topic of the first sheet, as a first save offers it, unless that is
 * still the title every new map starts with.
 */
export function documentName(options: {
  path: string | null
  firstRootTitle: string
  defaultRootTitle: string
  untitled: string
}): string {
  const fromPath = options.path ? baseName(options.path).trim() : ''
  if (fromPath) return fromPath
  const root = options.firstRootTitle.replace(/\s+/g, ' ').trim()
  if (root && root !== options.defaultRootTitle) return root
  return options.untitled
}

/**
 * The name for a picture or a page of one sheet: the map's name, and the
 * sheet's title after it when the map has more than one sheet.
 */
export function sheetExportName(mapName: string, sheetTitle: string, sheetCount: number): string {
  const title = sheetTitle.replace(/\s+/g, ' ').trim()
  return sheetCount > 1 && title !== '' && title !== mapName ? `${mapName} - ${title}` : mapName
}
