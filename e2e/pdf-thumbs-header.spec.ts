import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

test('the thumbnail header stays at the top while the list scrolls', async ({ page }) => {
  const css = readFileSync(resolve('apps/pdf/src/renderer/styles.css'), 'utf8')
  await page.setContent(`<!doctype html>
    <style>${css}</style>
    <div style="display:flex">
      <div class="pdf-thumbs pdf-outline-pane" style="height:300px;width:150px">
        <div class="pdf-outline-header"><span>Label</span><button class="rb-icon">X</button></div>
      </div>
      <div id="thumbs" class="pdf-thumbs" style="height:300px;width:150px">
        <div class="pdf-outline-header pdf-thumbs-header"><span>Label</span><button class="rb-icon">X</button></div>
        ${Array.from(
          { length: 20 },
          (_, i) =>
            `<div class="pdf-thumb" data-idx="${i}"><div class="pdf-thumb-box" style="aspect-ratio:3 / 4"></div><span class="pdf-thumb-no">${i + 1}</span></div>`,
        ).join('')}
      </div>
    </div>
  `)
  /** label and button boxes relative to their pane, outline pane first */
  const headerLayout = () =>
    page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLElement>('.pdf-thumbs'), (pane) => {
        const p = pane.getBoundingClientRect()
        return Array.from(pane.querySelectorAll('.pdf-outline-header > *'), (el) => {
          const r = el.getBoundingClientRect()
          return { left: r.left - p.left, top: r.top - p.top, right: p.right - r.right }
        })
      }),
    )
  const [outline, thumbs] = await headerLayout()
  expect(thumbs).toEqual(outline)

  // scroll until a thumbnail's page box runs under the whole header
  const pane = page.locator('#thumbs')
  await page.locator('.pdf-thumb[data-idx="5"] .pdf-thumb-box').evaluate((box) => {
    const scroller = box.closest<HTMLElement>('.pdf-thumbs')!
    scroller.scrollTop +=
      box.getBoundingClientRect().top - scroller.getBoundingClientRect().top + 10
  })
  expect(await pane.evaluate((el) => el.scrollTop)).toBeGreaterThan(0)
  expect((await headerLayout())[1]).toEqual(outline)
  // the button is what a click there hits, not the page box behind it
  // (Locator.click would first scroll the sticky button "into view", back to the top)
  const hit = await pane.evaluate((el) => {
    const r = el.querySelector('.pdf-thumbs-header button')!.getBoundingClientRect()
    return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.tagName
  })
  expect(hit).toBe('BUTTON')

  // scrolling back up to a thumbnail leaves it below the header, not under it
  const header = (await page.locator('.pdf-thumbs-header').boundingBox())!
  const thumb = page.locator('.pdf-thumb[data-idx="3"]')
  await thumb.evaluate((el) => el.scrollIntoView({ block: 'nearest' }))
  // (1px slack: scrollTop is whole pixels, thumbnail heights are not)
  expect((await thumb.boundingBox())!.y).toBeGreaterThan(header.y + header.height - 1)
})
