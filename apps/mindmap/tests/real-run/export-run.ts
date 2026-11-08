/**
 * Real-run check of export, print and the preview picture a save writes.
 *
 * Part of `driver.ts` (see there for how to run it); MINDMAP_REAL_RUN_ONLY=export
 * runs it alone. It opens a map built here with the engine (a folded branch,
 * pictures from inside and from outside the file, a title with angle brackets,
 * style values that are not colours) in the built editor and:
 *
 * - exports the sheet as PNG with the app light and with the app dark, at two
 *   zoom levels, and compares the pictures pixel by pixel;
 * - exports it as PDF and prints it (the print call is turned into a PDF of the
 *   same window here, so no printer is needed) and reads the pages back;
 * - exports the Markdown outline with an edit not yet saved, and compares it
 *   with the engine's outline of what the save then writes;
 * - reads the preview picture from the saved file, once from an app in the
 *   dark and once from one in the light, and compares them;
 * - counts the requests that left the app on the way: none, and none at the
 *   web server the file points at.
 *
 * Everything it writes goes to `export/` in the evidence folder.
 */
import type { ElectronApplication, Page } from '@playwright/test'
import JSZip from 'jszip'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import pixelmatch from 'pixelmatch'
import { PNG } from 'pngjs'
import { PDFDocument } from 'pdf-lib'
import {
  DEFAULT_THEME_ID,
  openXmind,
  sheetsToOutline,
  writeSheetTheme,
  type XmindSheet,
  type XmindTopic,
} from '@genoffice/xmind-engine'
import {
  chartSvg,
  landscape,
  leavesTheApp,
  type LookRunTools,
  startOutside,
  watchRequests,
  withResources,
} from './look-run'

const WINDOW = { width: 1280, height: 820 }
const VISIBLE = '.mm-sheet-host:not([hidden])'
const EXPORTED = '내보냈습니다'
const HOSTILE_TITLE = '<img src=x onerror=alert(1)> 꺾쇠 제목'
const FOLDED_CHILD = '접혀서 안 보이는 토픽'
const UNSAVED_TITLE = '저장 안 한 토픽'
/** Texts of the app's chrome that must never appear on a printed or exported page. */
const CHROME_TEXTS = ['자동 저장', '다른 이름으로 저장', '모두 접기']
/** A4 in points. */
const A4 = { long: 841.89, short: 595.28 }

let made = 0
const nextId = (): string => `80000000-0000-4000-8000-${(++made).toString(16).padStart(12, '0')}`

function topic(title: string, extra: Record<string, unknown> = {}, attached: XmindTopic[] = []) {
  const out: XmindTopic = { id: nextId(), class: 'topic', title, ...extra }
  if (attached.length > 0) out.children = { attached }
  return out
}

function exportSheets(outside: string): XmindSheet[] {
  const first: XmindSheet = {
    id: nextId(),
    class: 'sheet',
    title: '내보내기 시트',
    rootTopic: topic('내보내기 지도', {}, [
      topic('첫 가지', {}, [topic('하나'), topic('둘')]),
      topic('접힌 가지', { branch: 'folded' }, [topic(FOLDED_CHILD)]),
      topic('그림', {}, [
        topic('파일 안의 그림', {
          image: { src: 'xap:resources/landscape.png', width: 160, height: 96 },
        }),
        topic('파일 안의 SVG', { image: { src: 'xap:resources/chart.svg' } }),
        topic('바깥 그림은 자리만', {
          image: { src: `${outside}/outside.png`, width: 120, height: 80 },
        }),
      ]),
      topic(HOSTILE_TITLE, { labels: ['라벨'] }),
      topic('색 꼴이 아닌 스타일', {
        style: {
          id: nextId(),
          properties: {
            'svg:fill': `url(${outside}/from-style.png)`,
            'fo:color': `red; background:url(${outside}/from-color.png)`,
          },
        },
      }),
    ]),
  }
  writeSheetTheme(first, DEFAULT_THEME_ID)
  const second: XmindSheet = {
    id: nextId(),
    class: 'sheet',
    title: '둘째 시트',
    rootTopic: topic('둘째 지도', {}, [topic('가지')]),
  }
  return [first, second]
}

// ---- driving ----

/** The save dialog of the main process answers with the paths queued here, in order. */
async function stubSaveDialog(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ dialog }) => {
    const state = globalThis as unknown as {
      __saveTargets: string[]
      __dialogs: { defaultPath?: string; filters?: unknown }[]
    }
    state.__saveTargets = []
    state.__dialogs = []
    dialog.showSaveDialog = (async (...args: unknown[]) => {
      const options = args.find(
        (arg) => typeof arg === 'object' && arg !== null && 'filters' in arg,
      ) as { defaultPath?: string; filters?: unknown } | undefined
      state.__dialogs.push({ defaultPath: options?.defaultPath, filters: options?.filters })
      const next = state.__saveTargets.shift()
      return next ? { canceled: false, filePath: next } : { canceled: true, filePath: '' }
    }) as typeof dialog.showSaveDialog
  })
}

async function queueSaveTarget(app: ElectronApplication, path: string): Promise<void> {
  await app.evaluate((_electron, target) => {
    ;(globalThis as unknown as { __saveTargets: string[] }).__saveTargets.push(target)
  }, path)
}

const lastDialog = (app: ElectronApplication) =>
  app.evaluate(() => {
    const dialogs = (globalThis as unknown as { __dialogs: { defaultPath?: string }[] }).__dialogs
    return dialogs.at(-1) ?? null
  })

/** Print is turned into a PDF of the very window that would print, with the options print was given. */
async function stubPrint(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ app: electronApp }) => {
    const state = globalThis as unknown as {
      __printed: { options: unknown; pdf: string; shown: boolean }[]
    }
    state.__printed = []
    electronApp.on('browser-window-created', (_event, win) => {
      win.webContents.print = ((
        options: { landscape?: boolean; pageSize?: string } = {},
        callback?: (success: boolean, reason: string) => void,
      ) => {
        win.webContents
          .printToPDF({
            landscape: options.landscape,
            pageSize: options.pageSize as 'A4',
            printBackground: true,
            preferCSSPageSize: true,
            margins: { top: 0, bottom: 0, left: 0, right: 0 },
          })
          .then((pdf) => {
            state.__printed.push({
              options: JSON.parse(JSON.stringify(options)),
              pdf: pdf.toString('base64'),
              shown: win.isVisible(),
            })
            callback?.(true, '')
          })
          .catch((error: unknown) => callback?.(false, String(error)))
      }) as typeof win.webContents.print
    })
  })
}

/** Sends what the shell's menu sends. */
async function menu(app: ElectronApplication, channel: string, ...args: unknown[]): Promise<void> {
  await app.evaluate(
    ({ BrowserWindow }, message) => {
      BrowserWindow.getAllWindows()
        .find((win) => win.isVisible())
        ?.webContents.send(message.channel, ...message.args)
    },
    { channel, args },
  )
}

async function setAppTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  await page.evaluate((value) => document.documentElement.setAttribute('data-theme', value), theme)
  await page.waitForTimeout(200)
}

async function waitForFile(path: string, timeout = 30_000): Promise<Buffer> {
  const until = Date.now() + timeout
  while (Date.now() < until) {
    if (existsSync(path)) {
      // the writer renames into place: the file is whole once it is there
      return readFileSync(path)
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`nothing was written to ${path}`)
}

async function waitForStatus(page: Page, text: string): Promise<void> {
  await page.waitForFunction(
    (wanted) => document.querySelector('.mm-save-status')?.textContent === wanted,
    text,
    { timeout: 30_000 },
  )
}

async function exportFromToolbar(page: Page, format: string): Promise<void> {
  await page.locator('[data-action="export"]').click()
  await page.locator(`[data-export="${format}"]`).click()
}

// ---- reading what was written ----

function decodePng(bytes: Buffer): PNG {
  return PNG.sync.read(bytes)
}

function pixelDifference(first: PNG, second: PNG): number {
  if (first.width !== second.width || first.height !== second.height)
    return Number.POSITIVE_INFINITY
  return pixelmatch(first.data, second.data, undefined, first.width, first.height, { threshold: 0 })
}

async function pdfPages(bytes: Buffer): Promise<{ width: number; height: number }[]> {
  const pdf = await PDFDocument.load(bytes)
  return pdf.getPages().map((page) => page.getSize())
}

async function pdfText(bytes: Buffer): Promise<string> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: true }).promise
  const texts: string[] = []
  for (let number = 1; number <= pdf.numPages; number++) {
    const content = await (await pdf.getPage(number)).getTextContent()
    texts.push(content.items.map((item) => ('str' in item ? item.str : '')).join(''))
  }
  return texts.join('\n')
}

const isLandscapeA4 = (size: { width: number; height: number }): boolean =>
  Math.abs(size.width - A4.long) < 2 && Math.abs(size.height - A4.short) < 2

async function thumbnailOf(path: string): Promise<Buffer | null> {
  const zip = await JSZip.loadAsync(readFileSync(path))
  const entry = zip.file('Thumbnails/thumbnail.png')
  return entry ? Buffer.from(await entry.async('uint8array')) : null
}

/** Adds a topic under "둘" by the keyboard, with the given title, and leaves the edit box. */
async function addTopicUnderTwo(page: Page): Promise<void> {
  await page.locator(`${VISIBLE} me-tpc`, { hasText: /^둘$/ }).click()
  await page.keyboard.press('Tab')
  await page.waitForSelector('#input-box')
  await page.keyboard.type(UNSAVED_TITLE)
  await page.keyboard.press('Enter')
  await page.waitForSelector('#input-box', { state: 'detached' })
  await page.waitForTimeout(400)
}

export async function exportRun(tools: LookRunTools): Promise<void> {
  const { check, results } = tools
  console.log('\n[E] export, print and the preview picture')
  const dir = join(tools.out, 'export')
  mkdirSync(dir, { recursive: true })
  const outside = await startOutside()
  const original = await withResources(exportSheets(outside.url), {
    'resources/landscape.png': landscape(),
    'resources/chart.svg': chartSvg(outside.url),
  })
  const mapPath = join(dir, 'map-exports.xmind')
  const darkPath = join(dir, 'map-dark-app.xmind')
  const lightPath = join(dir, 'map-light-app.xmind')
  for (const path of [mapPath, darkPath, lightPath]) writeFileSync(path, original)
  const originalThumbnail = await thumbnailOf(mapPath)
  const out: Record<string, unknown> = {}
  results.export = out

  // ---- run 1: every export, print, and a save from a dark app ----
  const { app, page } = await tools.launch(mapPath, { size: WINDOW })
  const refused: string[] = []
  const collect = (chunk: Buffer): void => {
    for (const line of chunk.toString().split('\n')) {
      if (line.includes('export window: refused')) refused.push(line.trim())
    }
  }
  app.process().stdout?.on('data', collect)
  app.process().stderr?.on('data', collect)
  const consoleLog: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      consoleLog.push(`${message.type()}: ${message.text()}`)
      console.log(`  [renderer ${message.type()}] ${message.text()}`)
    }
  })
  try {
    const requests = await watchRequests(app)
    await stubSaveDialog(app)
    await stubPrint(app)
    await page.waitForSelector(`${VISIBLE} me-root me-tpc`)
    await page.waitForFunction(
      (visible) =>
        [...document.querySelectorAll<HTMLImageElement>(`${visible} .mm-picture img`)].every(
          (img) => img.complete && img.naturalWidth > 0,
        ),
      VISIBLE,
    )
    await page.waitForTimeout(500)

    // PNG with the app light, at the zoom it opened with, from the toolbar
    await setAppTheme(page, 'light')
    await page.locator('[data-action="export"]').click()
    await page.screenshot({ path: join(dir, '01-toolbar-export-menu-light-app.png') })
    await page.keyboard.press('Escape')
    await page.locator('[data-action="export"]').click()
    const pngLight = join(dir, 'sheet-light-app.png')
    await queueSaveTarget(app, pngLight)
    await page.locator('[data-export="png"]').click()
    const lightBytes = await waitForFile(pngLight)
    await waitForStatus(page, EXPORTED)
    const offered = await lastDialog(app)
    out.pngDialog = offered
    check(
      offered?.defaultPath?.endsWith('map-exports - 내보내기 시트.png') === true,
      'the dialog offers the map name and the sheet title, with .png, in the folder of the map',
    )

    // PNG with the app dark, zoomed in, from the menu
    await setAppTheme(page, 'dark')
    for (let step = 0; step < 5; step++) await page.locator('[data-action="zoom-in"]').click()
    await page.waitForTimeout(300)
    await page.locator('[data-action="export"]').click()
    await page.screenshot({ path: join(dir, '02-toolbar-export-menu-dark-app-zoomed.png') })
    await page.keyboard.press('Escape')
    const pngDark = join(dir, 'sheet-dark-app')
    await queueSaveTarget(app, pngDark)
    await menu(app, 'mindmap:export-request', 'png')
    const darkBytes = await waitForFile(`${pngDark}.png`)
    check(true, 'a name picked without an extension is written with .png')
    const light = decodePng(lightBytes)
    const dark = decodePng(darkBytes)
    const differing = pixelDifference(light, dark)
    out.png = { width: light.width, height: light.height, differingPixels: differing }
    check(
      differing === 0,
      `the PNG from a light app and from a dark, zoomed-in app are pixel-identical (${light.width}x${light.height})`,
    )
    const drawn = await page.evaluate((visible) => {
      const nodes = document.querySelector<HTMLElement>(`${visible} me-nodes`)!
      const card = document.querySelector<HTMLElement>('.mm-card')!.getBoundingClientRect()
      return {
        width: nodes.offsetWidth,
        height: nodes.offsetHeight,
        cardWidth: card.width,
        cardHeight: card.height,
      }
    }, VISIBLE)
    out.drawn = drawn
    check(
      light.width >= drawn.width * 2 && light.height >= drawn.height * 2,
      'the picture is the whole sheet at twice its size, not the part in view',
    )
    const ground = [light.data[0], light.data[1], light.data[2], light.data[3]]
    out.pngCorner = ground
    check(ground[3] === 255, 'the picture has the map ground, not a transparent one')

    // PDF, from the menu, with the app dark
    const pdfPath = join(dir, 'sheet.pdf')
    await queueSaveTarget(app, pdfPath)
    await menu(app, 'mindmap:export-request', 'pdf')
    const pdfBytes = await waitForFile(pdfPath)
    await waitForStatus(page, EXPORTED)
    const pages = await pdfPages(pdfBytes)
    out.pdfPages = pages
    check(pages.length === 1, 'the PDF is one page')
    check(isLandscapeA4(pages[0]!), 'the page is landscape A4')
    const pdfWords = await pdfText(pdfBytes)
    out.pdfText = pdfWords
    check(pdfWords.includes('내보내기 지도'), 'the PDF holds the map as text')
    check(pdfWords.includes(HOSTILE_TITLE), 'a title with angle brackets is its own characters')
    check(!pdfWords.includes(FOLDED_CHILD), 'a folded branch is folded in the PDF')
    check(
      CHROME_TEXTS.every((text) => !pdfWords.includes(text)),
      'and nothing of the app around the map is on the page',
    )

    // print: the menu's Print, turned into a PDF of the print window
    await menu(app, 'mindmap:print-request')
    await page.waitForFunction(() => true)
    const printed = await (async () => {
      const until = Date.now() + 30_000
      while (Date.now() < until) {
        const jobs = await app.evaluate(
          () =>
            (globalThis as unknown as { __printed: { options: unknown; pdf: string }[] }).__printed,
        )
        if (jobs.length > 0) return jobs[0]!
        await new Promise((resolve) => setTimeout(resolve, 200))
      }
      throw new Error('nothing was printed')
    })()
    const printPdf = Buffer.from(printed.pdf, 'base64')
    writeFileSync(join(dir, 'print-job.pdf'), printPdf)
    out.printOptions = printed.options
    const printPages = await pdfPages(printPdf)
    const printWords = await pdfText(printPdf)
    out.printPages = printPages
    check(
      (printed.options as { landscape?: boolean; pageSize?: string }).landscape === true &&
        (printed.options as { pageSize?: string }).pageSize === 'A4',
      'print asks the system for landscape A4',
    )
    check(
      printPages.length === 1 && isLandscapeA4(printPages[0]!),
      'the print job is one landscape A4 page',
    )
    check(
      printWords.includes('내보내기 지도') &&
        !printWords.includes(FOLDED_CHILD) &&
        CHROME_TEXTS.every((text) => !printWords.includes(text)),
      'it is the sheet, folded as on screen, without the app around it',
    )

    // the outline, with an edit not saved yet; folding plays no part
    await addTopicUnderTwo(page)
    const mdPath = join(dir, 'outline')
    await queueSaveTarget(app, mdPath)
    await exportFromToolbar(page, 'markdown')
    const markdown = (await waitForFile(`${mdPath}.md`)).toString('utf8')
    await waitForStatus(page, EXPORTED)
    check(markdown.includes(UNSAVED_TITLE), 'the outline holds the edit that is not saved yet')
    check(markdown.includes(FOLDED_CHILD), 'and the folded branch, in full')
    check(markdown.includes('# 둘째 시트'), 'and every sheet of the file')
    out.markdownDialog = await lastDialog(app)
    check(
      (out.markdownDialog as { defaultPath?: string }).defaultPath?.endsWith('map-exports.md') ===
        true,
      'the outline is offered under the name of the map, with .md',
    )

    // the save after it (Ctrl+S, the app still dark) writes what the outline showed
    await page.keyboard.press('Control+S')
    await waitForStatus(page, '저장됨')
    const saved = await openXmind(new Uint8Array(readFileSync(mapPath)))
    if (saved.status !== 'ok') throw new Error('the saved map does not open')
    check(
      markdown === sheetsToOutline(saved.document.sheets),
      "the exported outline is exactly the engine's outline of the map as saved",
    )
    const savedThumbnail = await thumbnailOf(mapPath)
    check(savedThumbnail !== null, 'the changed save wrote a preview picture')
    writeFileSync(join(dir, 'thumbnail-after-exports.png'), savedThumbnail!)
    check(
      originalThumbnail === null || !savedThumbnail!.equals(originalThumbnail),
      'a new one, not the one the file had',
    )
    const thumb = decodePng(savedThumbnail!)
    out.thumbnail = { width: thumb.width, height: thumb.height }
    check(thumb.width <= 800 && thumb.height <= 600, 'a small picture')

    // unfolded, the picture grows: the folded branch was really left out before
    await menu(app, 'mindmap:menu-command', 'unfold-all')
    await page.waitForTimeout(400)
    const unfoldedPath = join(dir, 'sheet-unfolded.png')
    await queueSaveTarget(app, unfoldedPath)
    await exportFromToolbar(page, 'png')
    const unfolded = decodePng(await waitForFile(unfoldedPath))
    out.unfoldedPng = { width: unfolded.width, height: unfolded.height }
    check(
      unfolded.height > light.height || unfolded.width > light.width,
      'a folded branch is folded in the PNG (unfolded, the picture is larger)',
    )

    // cancelling the dialog writes nothing and says nothing went wrong
    await exportFromToolbar(page, 'pdf')
    await page.waitForTimeout(800)
    check(
      (await page.locator('.mm-save-status').textContent()) !== '내보내지 못했습니다',
      'a cancelled export is no failure',
    )

    await page.screenshot({ path: join(dir, '03-after-exports-dark-app.png') })
    const seen = await requests()
    out.requestsLeavingTheApp = seen.filter(leavesTheApp)
    out.refusedInExportWindow = refused
    check(seen.filter(leavesTheApp).length === 0, 'the app asked for no address outside itself')
    check(refused.length === 0, 'and the export windows did not even try to')
    check(outside.hits.length === 0, 'the web server the file points at was never visited')
  } finally {
    writeFileSync(join(dir, 'renderer-console.log'), consoleLog.map((line) => `${line}\n`).join(''))
    await app.close()
  }

  // ---- runs 2 and 3: the same steps from a light and from a dark app; the theme is all that differs ----
  const editAndSave = async (path: string, theme: 'light' | 'dark'): Promise<Buffer> => {
    const run = await tools.launch(path, { size: WINDOW })
    try {
      await run.page.waitForSelector(`${VISIBLE} me-root me-tpc`)
      await run.page.waitForFunction(
        (visible) =>
          [...document.querySelectorAll<HTMLImageElement>(`${visible} .mm-picture img`)].every(
            (img) => img.complete && img.naturalWidth > 0,
          ),
        VISIBLE,
      )
      await setAppTheme(run.page, theme)
      await run.page.waitForTimeout(300)
      await addTopicUnderTwo(run.page)
      await run.page.keyboard.press('Control+S')
      await waitForStatus(run.page, '저장됨')
      await run.page.screenshot({ path: join(dir, `04-saved-from-${theme}-app.png`) })
    } finally {
      await run.app.close()
    }
    const thumbnail = await thumbnailOf(path)
    if (!thumbnail) throw new Error(`no preview picture in ${path}`)
    writeFileSync(join(dir, `thumbnail-${theme}-app.png`), thumbnail)
    return thumbnail
  }
  const lightThumbnail = await editAndSave(lightPath, 'light')
  const darkThumbnail = await editAndSave(darkPath, 'dark')
  outside.server.close()
  const thumbnailDifference = pixelDifference(decodePng(lightThumbnail), decodePng(darkThumbnail))
  out.thumbnailDifferingPixels = thumbnailDifference
  check(
    thumbnailDifference === 0,
    'the preview picture from a light app and from a dark app is pixel-identical',
  )
  check(outside.hits.length === 0, 'and saving it visited no web server either')
}
