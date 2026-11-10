/**
 * What a co-editing page may run outside Univer's commands (collab-refusals.ts):
 * shared edits pass, edits only this page's journal would hold do not, and a
 * command nobody has checked is refused.
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  editRefusal,
  ribbonCommandAllowed,
  setEditRefusalRule,
} from '../src/renderer/sheet-protection'
import { refusalIsSilent, sharedWhileCoEditing } from '../src/web/collab-refusals'

afterEach(() => setEditRefusalRule(null))

describe('what a co-editing page refuses', () => {
  it('lets through commands that only run Univer mutations or change nothing a save writes', () => {
    for (const command of [
      'bold',
      'align:center',
      'font-size:14',
      'format:0.00',
      'insert-row-here',
      'paste-special:value',
      'insert-function-open:math',
      'undo',
      'find',
      'zoom:150',
      'op:insert_rows',
      'op:set_freeze',
    ]) {
      expect(sharedWhileCoEditing(command), command).toBe(true)
    }
  })

  it('refuses every edit the renderer journals itself, and anything it does not know', () => {
    for (const command of [
      // charts, shapes, pictures, sparklines
      'insert-chart:bar',
      'chart-title:Sales',
      'chart-delete',
      'insert-shape:rect',
      'insert-textbox',
      'insert-picture',
      'shape-fill:#ff0000',
      'visual:delete',
      'sparkline:line',
      'direct:chart-edit',
      'direct:shape-edit',
      'direct:insert-picture',
      // pivots and tables
      'pivot-open',
      'pivot-edit',
      'refresh-all',
      'slicer-open',
      'format-as-table',
      'format-as-table:TableStyleMedium2',
      'table-rename:Sales',
      // page setup, themes, view flags kept in the journal
      'page-layout:orientation:landscape',
      'page-layout:theme:office',
      'header-footer-open',
      'toggle-headings',
      'toggle-show-formulas',
      'toggle-page-break-preview',
      // hyperlinks, protection, outlines, comments
      'link-open',
      'link-set:https%3A%2F%2Fexample.com',
      'clear-hyperlinks',
      'sheet-protect',
      'workbook-protect',
      'allow-edit-ranges-open',
      'cellprot:locked-off',
      'outline-group:rows',
      'direct:outline',
      'comment-new',
      'comments-pane-toggle',
      'note-insert-picture',
      // the executor operations behind the same features
      'op:add_chart',
      'op:add_pivot',
      'op:add_sparkline',
      'op:set_hyperlink',
      'op:set_page_setup',
      'op:protect_sheet',
      'op:fill_range',
      // names that only look like a shared one, and names nobody has checked
      'merge-workbooks',
      'fill-series-open',
      'sort-by-color',
      'op:some_new_operation',
    ]) {
      expect(sharedWhileCoEditing(command), command).toBe(false)
    }
  })

  it('reaches the ribbon gate through the renderer’s rule, and leaves a read-only open as it was', () => {
    const asked: string[] = []
    setEditRefusalRule((kind) => {
      asked.push(kind)
      return sharedWhileCoEditing(kind) ? null : 'refused'
    })
    expect(ribbonCommandAllowed(false, 'bold')).toBe(true)
    expect(ribbonCommandAllowed(false, 'insert-chart:bar')).toBe(false)
    expect(editRefusal('op:add_chart')).toBe('refused')
    expect(editRefusal('op:insert_rows')).toBeNull()
    // a viewer's page keeps its own allow-list and is not asked
    asked.length = 0
    expect(ribbonCommandAllowed(true, 'copy')).toBe(true)
    expect(ribbonCommandAllowed(true, 'bold')).toBe(false)
    expect(asked).toEqual([])
    setEditRefusalRule(null)
    expect(ribbonCommandAllowed(false, 'insert-chart:bar')).toBe(true)
  })

  it('leaves out a full column’s default format without a message: the cells themselves are shared', () => {
    expect(sharedWhileCoEditing('direct:column-default-style')).toBe(false)
    expect(refusalIsSilent('direct:column-default-style')).toBe(true)
    expect(refusalIsSilent('insert-chart:bar')).toBe(false)
  })
})
