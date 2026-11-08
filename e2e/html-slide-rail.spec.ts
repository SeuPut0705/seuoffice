import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from '@playwright/test'
import { launchShell, closeAndSaveVideo, waitForPageWithUrl, screenshotPath } from './helpers'

// a deck as chat assistants write them: slides on top of each other, one faded in, keys turn them
const SOURCE = `<!doctype html>
<html>
<head>
<style>
body{margin:0;font:24px/1.4 sans-serif}
.deck{position:relative;width:100vw;height:100vh;overflow:hidden}
.slide{position:absolute;inset:0;padding:60px;opacity:0;visibility:hidden;transition:opacity .4s,visibility .4s}
.slide.active{opacity:1;visibility:visible}
.s1{background:#fde68a}.s2{background:#bfdbfe}.s3{background:#bbf7d0}.s4{background:#fecaca}
</style>
</head>
<body>
<div class="deck">
<div class="slide s1 active"><h1>One</h1><p>First body</p></div>
<div class="slide s2"><h1>Two</h1><p>Second body</p></div>
<div class="slide s3"><h1 id="three">Three</h1><p id="third">Third body</p></div>
<div class="slide s4"><h1>Four</h1><p>Fourth body</p></div>
</div>
<script>
let at = 0
const slides = document.querySelectorAll('.slide')
const show = (i) => {
  at = Math.max(0, Math.min(slides.length - 1, i))
  slides.forEach((s, n) => s.classList.toggle('active', n === at))
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowRight' || e.key === ' ') { e.preventDefault(); show(at + 1) }
  if (e.key === 'ArrowLeft') show(at - 1)
})
</script>
</body>
</html>
`

test.describe('html editor: slide rail', () => {
  test('a deck gets a slide list, keeps its slide while text is typed and after a reload', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'genoffice-html-'))
    const htmlPath = join(dir, 'deck.html')
    await writeFile(htmlPath, SOURCE)

    const launched = await launchShell({
      onboardingSeen: true,
      videoDir: 'html-slide-rail',
      openFile: htmlPath,
    })
    const { app } = launched
    try {
      const editorPage = await waitForPageWithUrl(app, '://html/')
      await expect(editorPage.locator('.ribbon-body')).toBeVisible()
      const frame = editorPage.frameLocator('.preview-frame')
      const shown = frame.locator('.slide.active h1')
      await expect(shown).toHaveText('One')

      // the rail lists the four slides, each drawn by the deck itself
      const rail = editorPage.getByRole('navigation', { name: 'Slides' })
      const thumbs = rail.locator('.page-thumb')
      await expect(thumbs).toHaveCount(4)
      await expect(thumbs.nth(0)).toHaveAttribute('aria-current', 'page')
      const thumbFrame = (i: number) => rail.locator('.slide-thumb-frame').nth(i).contentFrame()
      await expect(thumbFrame(2).locator('.slide.active h1')).toHaveText('Three')
      await expect(thumbFrame(3).locator('.slide.active h1')).toHaveText('Four')

      // a click on a thumbnail turns the preview to that slide with the deck's own keys
      await rail.getByRole('button', { name: 'Go to slide 3' }).click()
      await expect(shown).toHaveText('Three')
      await expect(thumbs.nth(2)).toHaveAttribute('aria-current', 'page')

      // typing a space into the slide's text does not turn the slide
      await frame.locator('#three').click({ position: { x: 20, y: 20 } })
      await expect(frame.locator('#three')).toHaveAttribute('contenteditable', 'true')
      await editorPage.keyboard.press('End')
      await editorPage.keyboard.type(' and more')
      await frame.locator('body').press('Escape')
      await expect(shown).toHaveText('Three and more')
      await editorPage.waitForTimeout(500)
      await expect(shown).toHaveText('Three and more')

      // an edit that reloads the preview comes back to the same slide, not the first
      // beside the words: the paragraph is selected, not opened for typing
      await frame.locator('#third').click({ position: { x: 220, y: 10 } })
      await frame.locator('body').press('Delete')
      await expect(frame.locator('#third')).toHaveCount(0)
      await expect(shown).toHaveText('Three and more')
      await expect(thumbs.nth(2)).toHaveAttribute('aria-current', 'page')
      await editorPage.waitForTimeout(1500)
      await editorPage.screenshot({ path: screenshotPath('html-slide-rail') })
    } finally {
      await closeAndSaveVideo(launched)
    }
  })
})
