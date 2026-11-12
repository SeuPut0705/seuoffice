/**
 * The status line while a sheet is still being read from the file. A notice
 * such as "Indexing Data: 1,200 rows ready." is progress: it goes when the
 * load it speaks of ends. Found on Windows: a four-row workbook kept
 * "Streaming ...: 4 rows available." on the line after it had loaded.
 */
import { describe, expect, it } from 'vitest'
import { endLoadingNotice, showLoadingNotice } from '../src/renderer/loading-notice'

/** a status line that starts with what a command left on it */
function statusLine(initial = 'Opened Budget.xlsx') {
  const line = { text: initial, writes: 0 }
  const set = (text: string): void => {
    line.text = text
    line.writes++
  }
  return { line, set }
}

describe('the loading notice of the status line', () => {
  it('goes when the load that showed it ends', () => {
    const workbook = {}
    const { line, set } = statusLine()
    showLoadingNotice(workbook, 'sheet-1', 'Indexing Data: 100 rows ready.', set)
    showLoadingNotice(workbook, 'sheet-1', 'Indexing Data: 900 rows ready.', set)
    expect(line.text).toBe('Indexing Data: 900 rows ready.')
    endLoadingNotice(workbook, 'sheet-1', set)
    expect(line.text).toBe('')
  })

  it('a load that showed no notice leaves the line as it is when it ends', () => {
    const { line, set } = statusLine()
    endLoadingNotice({}, 'sheet-1', set)
    expect(line).toEqual({ text: 'Opened Budget.xlsx', writes: 0 })
  })

  it('stays while the sheet it speaks of is still loading, whatever other sheet finishes', () => {
    const workbook = {}
    const { line, set } = statusLine()
    showLoadingNotice(workbook, 'sheet-2', 'Indexing Big: 5,000 rows ready.', set)
    endLoadingNotice(workbook, 'sheet-1', set)
    expect(line.text).toBe('Indexing Big: 5,000 rows ready.')
    endLoadingNotice(workbook, 'sheet-2', set)
    expect(line.text).toBe('')
  })

  it('is taken off once: a second end of the same load does not wipe what came after', () => {
    const workbook = {}
    const { line, set } = statusLine()
    showLoadingNotice(workbook, 'sheet-1', 'Indexing Data: 100 rows ready.', set)
    endLoadingNotice(workbook, 'sheet-1', set)
    set('Sorted by column A.')
    endLoadingNotice(workbook, 'sheet-1', set)
    expect(line.text).toBe('Sorted by column A.')
  })

  it('belongs to its workbook: the end of a load in another workbook leaves it', () => {
    const first = {}
    const { line, set } = statusLine()
    showLoadingNotice(first, 'sheet-1', 'Indexing Data: 100 rows ready.', set)
    endLoadingNotice({}, 'sheet-1', set)
    expect(line.text).toBe('Indexing Data: 100 rows ready.')
  })
})
