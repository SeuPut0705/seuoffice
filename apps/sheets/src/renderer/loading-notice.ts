/**
 * The loading notice of a workbook's status line: progress such as "Indexing
 * Data: 1,200 rows ready." while a sheet is still being read from the file.
 * The load that put it there takes it off when it ends; a load that showed
 * none leaves the line alone, so what a command wrote there stays.
 */

/** the sheet whose notice is on the status line, per open workbook */
const noticeSheets = new WeakMap<object, string>()

/** Puts `text` on the status line as the loading notice of `sheetId`. */
export function showLoadingNotice(
  workbook: object,
  sheetId: string,
  text: string,
  setMessage: (message: string) => void,
): void {
  noticeSheets.set(workbook, sheetId)
  setMessage(text)
}

/**
 * The load of `sheetId` ended (finished or failed): its notice goes, and
 * `message` takes its place. A notice of another sheet is not this load's to
 * take off, and without `message` the line is then left as it is.
 */
export function endLoadingNotice(
  workbook: object,
  sheetId: string,
  setMessage: (message: string) => void,
  message?: string,
): void {
  const own = noticeSheets.get(workbook) === sheetId
  if (own) noticeSheets.delete(workbook)
  if (message !== undefined) setMessage(message)
  else if (own) setMessage('')
}
