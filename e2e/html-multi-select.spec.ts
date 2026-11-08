import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from '@playwright/test'
import { launchShell, closeAndSaveVideo, waitForPageWithUrl, screenshotPath } from './helpers'

// boxes with room around them: the words sit at the left, the rest of each box only selects
const SOURCE = `<!doctype html>
<html>
<head>
<style>
body{margin:0;padding:40px;font:16px/1.5 sans-serif}
.card{width:360px;margin:0 0 24px;padding:16px;border:1px solid #888}
</style>
</head>
<body>
<div class="card" id="a"><p id="a1">Alpha</p></div>
<div class="card" id="b"><p id="b1">Beta</p></div>
<div class="card" id="c"><p id="c1">Gamma</p></div>
<div class="card" id="d"><p id="d1">Delta</p></div>
</body>
</html>
`

test.describe('html editor: selecting several elements', () => {
  test('shift / ctrl+click and a rubber band select several elements; edits reach all of them', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'genoffice-html-'))
    const htmlPath = join(dir, 'cards.html')
    await writeFile(htmlPath, SOURCE)

    const launched = await launchShell({
      onboardingSeen: true,
      videoDir: 'html-multi-select',
      openFile: htmlPath,
    })
    const { app } = launched
    try {
      const editorPage = await waitForPageWithUrl(app, '://html/')
      await expect(editorPage.locator('.ribbon-body')).toBeVisible()
      const frame = editorPage.frameLocator('.preview-frame')
      await expect(frame.locator('#a')).toBeVisible()
      await editorPage.locator('.ribbon').getByRole('tab', { name: /Split/ }).click()
      const content = editorPage.locator('.source-editor .cm-content')
      const float = editorPage.locator('.hx-float')
      const boxes = frame.locator('[data-gx-inspector-overlay="select"]:visible')
      // the right side of a card: inside its box, away from its words
      const beside = { position: { x: 300, y: 20 } }

      // one click selects one; shift+click adds, and the toolbar says how many it acts on
      await frame.locator('#a').click(beside)
      await expect(boxes).toHaveCount(1)
      await expect(float.locator('.hx-float-count')).toHaveCount(0)
      // the split view halves the stage: park the style panel so it does not sit over the cards
      // (synthetic click: the panel itself may cover the toolbar toggle)
      await float.getByRole('button', { name: /Style panel/ }).dispatchEvent('click')
      await expect(editorPage.locator('.hx-panel')).toHaveCount(0)
      await frame.locator('#b').click({ ...beside, modifiers: ['Shift'] })
      await frame.locator('#c').click({ ...beside, modifiers: ['ControlOrMeta'] })
      await expect(boxes).toHaveCount(3)
      await expect(float.locator('.hx-float-count')).toHaveText('3 selected')
      // tools for one element step aside; resizing is not offered either
      await expect(float.getByRole('button', { name: 'Move up' })).toBeDisabled()
      await expect(frame.locator('[data-gx-inspector-handle]:visible')).toHaveCount(0)

      // ctrl+click on a selected one takes it out again
      await frame.locator('#c').click({ ...beside, modifiers: ['ControlOrMeta'] })
      await expect(boxes).toHaveCount(2)
      await expect(float.locator('.hx-float-count')).toHaveText('2 selected')

      // a style edit lands on both, and the reload that follows keeps both selected
      await float.getByRole('button', { name: 'Increase font size' }).click()
      await expect(content).toContainText(/id="a" style="font-size: \d+px"/)
      await expect(content).toContainText(/id="b" style="font-size: \d+px"/)
      await expect(content).not.toContainText(/id="c" style/)
      await float.getByRole('button', { name: 'Duplicate element' }).click()
      await expect(frame.locator('.card')).toHaveCount(6)
      await expect(boxes).toHaveCount(2)
      // the originals stay selected, not the copy that slid into the second one's place
      const selectedIds = () =>
        frame.locator('body').evaluate(() => {
          const marks = [...document.querySelectorAll('[data-gx-inspector-overlay="select"]')]
            .filter((box) => (box as HTMLElement).style.display !== 'none')
            .map((box) => Math.round(box.getBoundingClientRect().top))
          return [...document.querySelectorAll('.card')]
            .map((card, i) => ({ i, top: Math.round(card.getBoundingClientRect().top) }))
            .filter((card) => marks.includes(card.top))
            .map((card) => card.i)
        })
      await expect.poll(selectedIds).toEqual([0, 2])
      await editorPage.screenshot({ path: screenshotPath('html-multi-select') })

      // Delete removes the whole selection in one step
      await frame.locator('body').press('Delete')
      await expect(frame.locator('.card')).toHaveCount(4)
      await expect(boxes).toHaveCount(0)

      // rubber band from the empty margin: what it fully encloses is selected, not what it grazes
      const first = (await frame.locator('.card').nth(0).boundingBox())!
      const second = (await frame.locator('.card').nth(1).boundingBox())!
      const third = (await frame.locator('.card').nth(2).boundingBox())!
      await editorPage.mouse.move(first.x - 20, first.y - 20)
      await editorPage.mouse.down()
      await editorPage.mouse.move(first.x + 100, first.y + 40, { steps: 4 })
      await expect(frame.locator('[data-gx-inspector-band]')).toBeVisible()
      await editorPage.mouse.move(second.x + second.width + 20, third.y + 10, { steps: 6 })
      await editorPage.mouse.up()
      await expect(frame.locator('[data-gx-inspector-band]')).toHaveCount(0)
      await expect(boxes).toHaveCount(2)
      await expect(float.locator('.hx-float-count')).toHaveText('2 selected')
      // a band only selects: every card is still there
      await expect(frame.locator('.card')).toHaveCount(4)
      await frame.locator('body').press('Delete')
      await expect(frame.locator('.card')).toHaveCount(2)

      // Escape lets go of everything
      await frame.locator('.card').nth(0).click(beside)
      await frame
        .locator('.card')
        .nth(1)
        .click({ ...beside, modifiers: ['Shift'] })
      await expect(boxes).toHaveCount(2)
      await frame.locator('body').press('Escape')
      await expect(boxes).toHaveCount(0)
      await expect(float).toHaveCount(0)
    } finally {
      await closeAndSaveVideo(launched)
    }
  })
})
