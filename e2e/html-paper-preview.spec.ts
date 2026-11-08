import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from '@playwright/test'
import { launchShell, closeAndSaveVideo, waitForPageWithUrl, screenshotPath } from './helpers'

// forced breaks make the sheet count independent of the fonts on the machine
const SOURCE = `<!doctype html>
<html>
<head>
<style>
@page{size:A4 portrait;margin:15mm}
body{margin:0;font:12pt/1.5 sans-serif}
.pb{break-before:page}
.print-only{display:none}
@media print{.print-only{display:block}.screen-only{display:none}}
.narrow{display:none}
@media screen and (max-width:1px){.narrow{display:block}}
@media not screen and (max-width:1px){.not-screen{color:rgb(1, 2, 3)}}
.wide{width:50vw;height:10px;background:#888}
</style>
</head>
<body>
<section id="one"><h1>First sheet</h1><p class="screen-only">Screen only.</p><p class="print-only">Print only.</p><p class="narrow">Narrow screens only.</p><p class="not-screen">Not a narrow screen.</p><div class="wide"></div></section>
<section id="two" class="pb"><h2>Second sheet</h2><p id="edit">Edit me.</p></section>
<section id="three" class="pb"><h2>Third sheet</h2></section>
</body>
</html>
`

test.describe('html editor: paper preview', () => {
  test('the Printed page device lays the document out on its sheets and stays editable', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'genoffice-html-'))
    const htmlPath = join(dir, 'handout.html')
    await writeFile(htmlPath, SOURCE)

    const launched = await launchShell({
      onboardingSeen: true,
      videoDir: 'html-paper-preview',
      openFile: htmlPath,
    })
    const { app } = launched
    try {
      const editorPage = await waitForPageWithUrl(app, '://html/')
      await expect(editorPage.locator('.ribbon-body')).toBeVisible()
      const frame = editorPage.frameLocator('.preview-frame')
      await expect(frame.locator('#one')).toBeVisible()
      // continuous page: print rules do not apply
      await expect(frame.locator('.print-only')).toBeHidden()

      await editorPage.locator('.device-dd .gs-dd-btn').click()
      await editorPage.locator('.gs-dd-item', { hasText: 'Printed page' }).click()

      // three forced sheets, reported in the status bar and labelled between the sheets
      await expect(editorPage.locator('.status-right')).toContainText('Pages: 3')
      await expect(frame.locator('[data-gx-inspector-pageno]')).toHaveText([
        '1 / 3',
        '2 / 3',
        '3 / 3',
      ])
      // print styles hold on paper
      await expect(frame.locator('.print-only')).toBeVisible()
      await expect(frame.locator('.screen-only')).toBeHidden()
      // a screen query stays false whatever its conditions; a negated one keeps its negation
      await expect(frame.locator('.narrow')).toBeHidden()
      await expect(frame.locator('.not-screen')).toHaveCSS('color', 'rgb(1, 2, 3)')

      // the frame is the page content box: A4 minus 15mm margins, and vw resolves against it
      const A4_CONTENT = { width: 680, height: (267 * 96) / 25.4 }
      const SHEET_PERIOD = (297 * 96) / 25.4 + 24
      const metrics = await frame.locator('body').evaluate(() => {
        const top = (sel: string) =>
          document.querySelector(sel)!.getBoundingClientRect().top + window.scrollY
        return {
          viewport: window.innerWidth,
          wide: document.querySelector('.wide')!.getBoundingClientRect().width,
          tops: ['#one', '#two h2', '#three h2'].map(top),
        }
      })
      expect(metrics.viewport).toBe(A4_CONTENT.width)
      expect(metrics.wide).toBeCloseTo(A4_CONTENT.width / 2, 0)
      // each forced break starts on the next sheet, exactly one sheet further down
      expect(metrics.tops.map((y) => Math.floor((y - 24) / SHEET_PERIOD))).toEqual([0, 1, 2])
      expect(metrics.tops[2]! - metrics.tops[1]!).toBeCloseTo(SHEET_PERIOD, 0)
      await editorPage.screenshot({ path: screenshotPath('html-paper-preview') })

      // the measurement the AI's print check reads: one answer per request, sids from the source
      const measure = await editorPage.evaluate(
        () =>
          new Promise<Record<string, unknown>>((resolve) => {
            const frame = document.querySelector<HTMLIFrameElement>('.preview-frame')!
            window.addEventListener('message', function onMessage(event) {
              if (event.source !== frame.contentWindow || event.data?.type !== 'gx:pageReport')
                return
              window.removeEventListener('message', onMessage)
              resolve(event.data)
            })
            frame.contentWindow!.postMessage({ type: 'gx:measurePages' }, '*')
          }),
      )
      const sidOf = (selector: string) =>
        frame.locator(selector).evaluate((el) => Number(el.getAttribute('data-gx-sid')))
      expect(measure.pages).toBe(3)
      expect(measure.starts).toEqual([
        await sidOf('#one'),
        await sidOf('#two'),
        await sidOf('#three'),
      ])
      expect(measure.breaks).toEqual([
        [await sidOf('#two'), 1],
        [await sidOf('#three'), 2],
      ])
      // nothing is cut, and three short sections leave every sheet mostly empty
      expect(measure.splits).toEqual([])
      const fill = measure.fill as number[]
      expect(fill).toHaveLength(3)
      for (const used of fill) {
        expect(used).toBeGreaterThan(0)
        expect(used).toBeLessThan(0.3)
      }

      // editing on a sheet writes the text and nothing of the paper view into the source
      await editorPage.locator('.ribbon').getByRole('tab', { name: /Split/ }).click()
      const content = editorPage.locator('.source-editor .cm-content')
      // on the words themselves: a click beside them only selects the paragraph
      await frame.locator('#edit').click({ position: { x: 12, y: 10 } })
      await expect(frame.locator('#edit')).toHaveAttribute('contenteditable', 'true')
      await editorPage.keyboard.press('ControlOrMeta+A')
      await editorPage.keyboard.type('Edited on paper.')
      await frame.locator('body').press('Escape')
      await expect(content).toContainText('<p id="edit">Edited on paper.</p>')
      await expect(content).not.toContainText('data-gx')
      await expect(content).not.toContainText('column')
      // the reload after the edit comes back on paper
      await expect(frame.locator('[data-gx-inspector-pageno]')).toHaveCount(3)
      await expect(frame.locator('#edit')).toHaveText('Edited on paper.')

      // the rail down the side shows the printed pages, marks the one in view and jumps on a click
      const rail = editorPage.getByRole('navigation', { name: 'Page thumbnails' })
      const thumbs = rail.locator('.page-thumb')
      await expect(thumbs).toHaveCount(3)
      await expect(rail.locator('.page-thumb-sheet img')).toHaveCount(3)
      const drawn = await rail
        .locator('.page-thumb-sheet img')
        .first()
        .evaluate((img: HTMLImageElement) => img.decode().then(() => img.naturalWidth))
      expect(drawn).toBeGreaterThan(100)
      await rail.getByRole('button', { name: 'Go to page 3' }).click()
      await expect(thumbs.nth(2)).toHaveAttribute('aria-current', 'page')
      await expect(thumbs.nth(0)).not.toHaveAttribute('aria-current', 'page')
      const scrolled = await frame.locator('body').evaluate(() => window.scrollY)
      expect(scrolled).toBeCloseTo(2 * SHEET_PERIOD, 0)
      await editorPage.screenshot({ path: screenshotPath('html-paper-rail') })

      // back to the continuous page: screen rules again, no sheets
      await editorPage.locator('.device-dd .gs-dd-btn').click()
      await editorPage.locator('.gs-dd-item', { hasText: 'Desktop' }).click()
      await expect(frame.locator('[data-gx-inspector-pageno]')).toHaveCount(0)
      await expect(frame.locator('.print-only')).toBeHidden()
      await expect(frame.locator('.screen-only')).toBeVisible()
      await expect(editorPage.locator('.status-right')).not.toContainText('Pages:')
      await expect(rail).toHaveCount(0)
    } finally {
      await closeAndSaveVideo(launched)
    }
  })
})
