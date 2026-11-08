import { test, expect, type Page } from '@playwright/test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchShell, closeAndSaveVideo, waitForPageWithUrl } from './helpers'

interface Bounds {
  startRow: number
  endRow: number
  startColumn: number
  endColumn: number
}

type DebugWindow = Window & {
  __genofficeDebug: {
    univerAPI: {
      getActiveWorkbook(): {
        getActiveRange(): { getRange(): Bounds }
        getActiveSheet(): {
          getRange(
            row: number,
            column: number,
            rows: number,
            columns: number,
          ): {
            getCellRect(): { x: number; y: number; width: number; height: number }
          }
        }
      }
    }
  }
}

async function selection(sheets: Page): Promise<Bounds> {
  return sheets.evaluate(() => {
    const range = (window as unknown as DebugWindow).__genofficeDebug.univerAPI
      .getActiveWorkbook()
      .getActiveRange()
      .getRange()
    const { startRow, endRow, startColumn, endColumn } = range
    return { startRow, endRow, startColumn, endColumn }
  })
}

async function cellCenter(sheets: Page, row: number, column: number) {
  return sheets.evaluate(
    ({ row, column }) => {
      const canvas = [...document.querySelectorAll('#univer-container canvas')].find((el) => {
        const rect = el.getBoundingClientRect()
        return rect.width > 500 && rect.height > 300
      })
      if (!canvas) throw new Error('worksheet canvas not found')
      const grid = canvas.getBoundingClientRect()
      const rect = (window as unknown as DebugWindow).__genofficeDebug.univerAPI
        .getActiveWorkbook()
        .getActiveSheet()
        .getRange(row, column, 1, 1)
        .getCellRect()
      return { x: grid.x + rect.x + rect.width / 2, y: grid.y + rect.y + rect.height / 2 }
    },
    { row, column },
  )
}

test('sheets: Ask AI opens the composer without changing a single cell or dragged range', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'genoffice-ai-context-menu-'))
  const launched = await launchShell({
    onboardingSeen: true,
    settings: { aiPanelSide: 'right', aiPanelShowSidebar: false },
    env: { GENOFFICE_DEBUG_HOOKS: '1' },
    videoDir: 'sheets-ai-context-menu',
    recordVideo: false,
  })
  let diagnosticPage: Page | undefined
  try {
    await launched.app.evaluate(({ app }, dir) => app.setPath('documents', dir), scratch)
    await launched.page.locator('.quick-card').nth(1).click()
    const sheets = await waitForPageWithUrl(launched.app, '://sheets/')
    diagnosticPage = sheets
    await sheets.waitForFunction(() => !!(window as unknown as DebugWindow).__genofficeDebug)
    await expect(sheets.locator('#univer-container')).toContainText('Sheet1')
    await expect(sheets.locator('.copilot')).toHaveCount(0)
    await sheets.bringToFront()

    const input = sheets.locator('.copilot textarea')
    const scope = sheets.locator('.ai-scope-hint')
    const askAt = async (row: number, column: number, expected: Bounds, label: string) => {
      const point = await cellCenter(sheets, row, column)
      await sheets.mouse.click(point.x, point.y, { button: 'right' })
      expect(await selection(sheets)).toEqual(expected)
      await sheets.getByText('Ask AI', { exact: true }).click()
      await expect(input).toBeFocused()
      await expect(scope).toContainText(label)
      expect(await selection(sheets)).toEqual(expected)
      await expect(sheets.locator('.ai-ask-trigger, .ai-ask-pop')).toHaveCount(0)
    }

    // Ordinary clicks never summon AI. The explicit menu action scopes B2,
    // even with the sidebar setting off and an otherwise empty workbook.
    const single = { startRow: 1, endRow: 1, startColumn: 1, endColumn: 1 }
    // The facade and sheet tabs mount before the canvas accepts input.
    await expect(async () => {
      const b2 = await cellCenter(sheets, 1, 1)
      await sheets.mouse.click(b2.x, b2.y)
      expect(await selection(sheets)).toEqual(single)
    }).toPass({ timeout: 15_000 })
    await expect(sheets.locator('.copilot, .ai-ask-trigger')).toHaveCount(0)
    await askAt(1, 1, single, 'B2')
    const panelBox = await sheets.locator('.copilot').boundingBox()
    const gridBox = await sheets.locator('.sheet-main').boundingBox()
    expect(panelBox!.x).toBeGreaterThanOrEqual(gridBox!.x + gridBox!.width - 1)

    // Reopening an already-open panel preserves a draft and re-arms a scope
    // the user dismissed. No menu action sends the draft.
    await input.fill('Keep this draft')
    await scope.locator('button').click()
    await expect(scope).toHaveCount(0)
    await askAt(1, 1, single, 'B2')
    await expect(input).toHaveValue('Keep this draft')

    // A real drag followed by a right click INSIDE the block keeps the entire
    // selection, including when the click is not on its original active cell.
    await sheets.locator('.ai-panel-collapse').click()
    await expect(sheets.locator('.copilot')).toHaveCount(0)
    const start = await cellCenter(sheets, 2, 1)
    const end = await cellCenter(sheets, 4, 3)
    await sheets.mouse.move(start.x, start.y)
    await sheets.mouse.down()
    await sheets.mouse.move(end.x, end.y, { steps: 12 })
    await sheets.mouse.up()
    const block = { startRow: 2, endRow: 4, startColumn: 1, endColumn: 3 }
    await expect.poll(() => selection(sheets)).toEqual(block)
    await expect(sheets.locator('.copilot, .ai-ask-trigger, .ai-ask-pop')).toHaveCount(0)
    await askAt(3, 2, block, 'B3:D5')
    await expect(input).toHaveValue('Keep this draft')

    // A right click outside the block targets that cell instead of the old
    // range. Typing in the composer leaves the new selection intact.
    const outside = { startRow: 6, endRow: 6, startColumn: 4, endColumn: 4 }
    await askAt(6, 4, outside, 'E7')
    await input.fill('Change only this cell')
    expect(await selection(sheets)).toEqual(outside)
    await expect(sheets.locator('.ai-msg-user')).toHaveCount(0)
  } catch (error) {
    if (diagnosticPage) {
      await test.info().attach('sheet', {
        body: await diagnosticPage.screenshot(),
        contentType: 'image/png',
      })
    }
    throw error
  } finally {
    await closeAndSaveVideo(launched, 'sheets-ai-context-menu')
  }
})
