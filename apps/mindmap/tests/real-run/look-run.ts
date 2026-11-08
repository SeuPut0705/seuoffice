/**
 * Real-run check of the look of the map, and the pictures a person judges it by.
 *
 * Part of `driver.ts` (see there for how to run it). It builds one medium map
 * in Korean, opens it in the built editor and picks themes through the theme
 * panel the way a person would. The screenshots go to `look/` in the evidence
 * folder, named so they sort in the order they are meant to be looked at:
 *
 *   1  the same map in each of the four skeletons
 *   2  the pill skeleton in each of the eight colour bands
 *   3  one band on its three grounds
 *   4  the theme panel
 *   5  the toolbar, close up, in the light and the dark app
 *   6  a dark app around a light map, and a light app around a dark map
 *   7  markers, pictures and a topic's own style
 *   8  a file from another program in the default look (only when one is given)
 *   9  beyond what was asked for: the layouts to one side and downward
 *
 * Every map it writes is built here with the engine, and every picture in
 * them is drawn here. The one exception is step 8, which opens a file named by
 * MINDMAP_REAL_RUN_SAMPLE from a copy in the system's temp folder and keeps
 * nothing of it but a screenshot.
 */
import type { ElectronApplication, Page } from '@playwright/test'
import JSZip from 'jszip'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { crc32, deflateSync } from 'node:zlib'
import {
  createXmindDocumentFromSheets,
  DEFAULT_THEME_ID,
  openXmind,
  recogniseSheetTheme,
  THEME_BAND_IDS,
  THEME_SKELETON_IDS,
  THEME_VARIANT_IDS,
  type ThemeId,
  themeLook,
  writeSheetTheme,
  type XmindSheet,
  type XmindTopic,
} from '@genoffice/xmind-engine'

export interface LookRunTools {
  out: string
  launch(
    openFile?: string,
    options?: { scale?: number; size?: { width: number; height: number } },
  ): Promise<{ app: ElectronApplication; page: Page }>
  check(condition: unknown, what: string): void
  results: Record<string, unknown>
}

const WINDOW = { width: 1440, height: 900 }
const VISIBLE = '.mm-sheet-host:not([hidden])'

// ---- the sample map: built here, in Korean, about nothing in particular ----

let made = 0
const nextId = (): string => `70000000-0000-4000-8000-${(++made).toString(16).padStart(12, '0')}`

function topic(
  title: string,
  extra: Record<string, unknown> = {},
  attached: XmindTopic[] = [],
): XmindTopic {
  const out: XmindTopic = { id: nextId(), class: 'topic', title, ...extra }
  if (attached.length > 0) out.children = { ...((extra.children as object) ?? {}), attached }
  return out
}

const marker = (...ids: string[]): { markers: { markerId: string }[] } => ({
  markers: ids.map((markerId) => ({ markerId })),
})

/** A trip plan: a central topic, six main branches, two to three levels, and one of everything the editor shows. */
function sampleSheet(): XmindSheet {
  const summaryTopic = topic('3박 4일')
  const secondDay = topic('둘째 날 · 한라산', {}, [topic('성판악 코스'), topic('백록담')])
  const boots = topic('등산화', marker('task-done'))
  const sheet: XmindSheet = {
    id: nextId(),
    class: 'sheet',
    rootTopic: topic('가을 제주 여행', {}, [
      topic(
        '일정',
        {
          summaries: [{ id: nextId(), range: '(0,2)', topicId: summaryTopic.id }],
          children: { summary: [summaryTopic] },
        },
        [
          topic('첫째 날 · 동쪽 해안', {}, [topic('성산 일출봉'), topic('섭지코지')]),
          secondDay,
          topic('셋째 날 · 서쪽 오름'),
        ],
      ),
      topic('숙소', {}, [
        topic('성산 근처 2박', { labels: ['예약 완료'] }),
        topic('애월 1박', { labels: ['확인 필요'] }),
      ]),
      topic('교통', {}, [
        topic('항공권', { ...marker('priority-1'), href: 'https://example.com/flight' }),
        topic('렌터카', marker('task-half')),
        topic('버스 노선'),
      ]),
      topic('먹을 것', {}, [
        topic('흑돼지 구이', marker('star-yellow')),
        topic('고기국수'),
        topic('감귤 디저트'),
      ]),
      topic('준비물', {}, [
        boots,
        topic('우비'),
        topic('보조 배터리', { notes: { plain: { content: '기내에 들고 타야 한다.' } } }),
      ]),
      topic('예산', { labels: ['합계 100만 원'] }, [
        topic('항공 30만 원'),
        topic('숙박 45만 원'),
        topic('식비 25만 원'),
      ]),
    ]),
    title: '여행 계획',
    relationships: [{ id: nextId(), end1Id: secondDay.id, end2Id: boots.id, title: '꼭 챙기기' }],
  }
  writeSheetTheme(sheet, DEFAULT_THEME_ID)
  return sheet
}

/** Markers of every family, pictures from inside and from outside the file, and topics with style values of their own. */
function decorationSheet(outside: string): XmindSheet {
  const row = (title: string, ids: string[]): XmindTopic =>
    topic(
      title,
      {},
      ids.map((id) => topic(id, marker(id))),
    )
  const sheet: XmindSheet = {
    id: nextId(),
    class: 'sheet',
    rootTopic: topic('표식과 그림', {}, [
      row('우선순위', ['priority-1', 'priority-2', 'priority-3', 'priority-4', 'priority-5']),
      row('진행', ['task-start', 'task-quarter', 'task-half', 'task-3quar', 'task-done']),
      row('깃발과 별', ['flag-red', 'flag-green', 'flag-blue', 'star-yellow', 'star-purple']),
      topic('모르는 표식', {}, [
        topic('공통 표시 하나로 보인다', marker('symbol-made-up')),
        topic('여러 개가 나란히', marker('priority-2', 'task-half', 'flag-orange', 'other-thing')),
      ]),
      topic('그림', {}, [
        topic('파일 안의 그림 (PNG)', {
          image: { src: 'xap:resources/landscape.png', width: 160, height: 96 },
        }),
        topic('파일 안의 그림 (SVG)', { image: { src: 'xap:resources/chart.svg' } }),
        topic('웹 주소의 그림은 자리만', {
          image: { src: `${outside}/outside.png`, width: 120, height: 80 },
        }),
        topic('PC의 다른 경로도 자리만', { image: { src: 'file:///C:/Windows/win.ini' } }),
      ]),
      topic('토픽에 직접 준 모양', {}, [
        topic('채움과 글자색', {
          style: { id: nextId(), properties: { 'svg:fill': '#ffe08a', 'fo:color': '#5b3a00' } },
        }),
        topic('굵게, 크게', {
          style: {
            id: nextId(),
            properties: { 'fo:font-weight': 'bold', 'fo:font-size': '16pt' },
          },
        }),
        topic('색 꼴이 아닌 채움은 기본 모양', {
          style: {
            id: nextId(),
            properties: {
              'svg:fill': `url(${outside}/from-style.png)`,
              'fo:color': 'red; background:url(x)',
              'fo:font-size': 'calc(100px)',
            },
          },
        }),
      ]),
    ]),
    title: '표식과 그림',
  }
  writeSheetTheme(sheet, DEFAULT_THEME_ID)
  return sheet
}

/** Every glyph this app draws for a marker, family by family, and the common mark at the end. */
function glyphSheet(): XmindSheet {
  const colours = [
    'red',
    'orange',
    'yellow',
    'green',
    'dark-green',
    'blue',
    'dark-blue',
    'purple',
    'pink',
    'gray',
    'dark-gray',
  ]
  const sheet: XmindSheet = {
    id: nextId(),
    class: 'sheet',
    rootTopic: topic('표식 그림', {}, [
      topic(
        '우선순위 1–9',
        marker(...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((level) => `priority-${level}`)),
      ),
      topic(
        '진행 0–100%',
        marker(
          ...['start', 'oct', 'quarter', '3oct', 'half', '5oct', '3quar', '7oct', 'done'].map(
            (step) => `task-${step}`,
          ),
        ),
      ),
      topic('깃발', marker(...colours.map((colour) => `flag-${colour}`))),
      topic('별', marker(...colours.map((colour) => `star-${colour}`))),
      topic('모르는 표식은 이 하나', marker('symbol-made-up')),
    ]),
    title: '표식 그림',
  }
  writeSheetTheme(sheet, DEFAULT_THEME_ID)
  return sheet
}

// ---- pictures drawn here ----

/** A PNG of the given size, pixel by pixel. */
export function png(
  width: number,
  height: number,
  pixel: (x: number, y: number) => [number, number, number],
): Uint8Array {
  const raw = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1)
    raw[row] = 0
    for (let x = 0; x < width; x++) raw.set(pixel(x, y), row + 1 + x * 3)
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
    const out = Buffer.alloc(body.length + 8)
    out.writeUInt32BE(data.length, 0)
    body.copy(out, 4)
    out.writeUInt32BE(crc32(body), body.length + 4)
    return out
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.set([8, 2, 0, 0, 0], 8)
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', header),
      chunk('IDAT', deflateSync(raw)),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  )
}

/** A small landscape: sky, a sun, two hills. */
export function landscape(): Uint8Array {
  const mix = (from: number[], to: number[], share: number): [number, number, number] => [
    Math.round(from[0]! + (to[0]! - from[0]!) * share),
    Math.round(from[1]! + (to[1]! - from[1]!) * share),
    Math.round(from[2]! + (to[2]! - from[2]!) * share),
  ]
  const [width, height] = [320, 192]
  return png(width, height, (x, y) => {
    const far = 118 + 22 * Math.sin(x / 46)
    const near = 148 + 16 * Math.sin(x / 31 + 2)
    if (y > near) return [63, 125, 92]
    if (y > far) return [106, 163, 122]
    if (Math.hypot(x - 236, y - 62) < 26) return [242, 184, 75]
    return mix([207, 230, 245], [247, 239, 226], y / height)
  })
}

/**
 * A small chart as SVG, with two things in it a picture should never get to do:
 * a script, and a picture it would load from outside.
 */
export function chartSvg(outside: string): Uint8Array {
  return new TextEncoder().encode(
    `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="160" height="100" viewBox="0 0 160 100">
  <script>fetch('${outside}/from-svg-script')</script>
  <rect width="160" height="100" rx="10" fill="#eef3f8"/>
  <image href="${outside}/from-svg-image.png" x="150" y="90" width="1" height="1"/>
  <path d="M18 78 52 48 84 62 122 28 144 40" fill="none" stroke="#2f6fc4" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="122" cy="28" r="7" fill="#e0762b"/>
</svg>`,
  )
}

/** The bytes of a map file with pictures added under `resources/`. */
export async function withResources(
  sheets: XmindSheet[],
  resources: Record<string, Uint8Array>,
): Promise<Uint8Array> {
  const plain = await (await createXmindDocumentFromSheets(sheets)).save()
  const zip = await JSZip.loadAsync(plain)
  const manifest = JSON.parse(await zip.file('manifest.json')!.async('string')) as {
    'file-entries': Record<string, object>
  }
  for (const [name, bytes] of Object.entries(resources)) {
    zip.file(name, bytes)
    manifest['file-entries'][name] = {}
  }
  zip.file('manifest.json', JSON.stringify(manifest))
  const bytes = await zip.generateAsync({ type: 'uint8array' })
  const opened = await openXmind(bytes)
  if (opened.status !== 'ok')
    throw new Error(`the map with pictures does not open: ${opened.status}`)
  return bytes
}

// ---- a web server that must stay unvisited ----

export async function startOutside(): Promise<{ server: Server; url: string; hits: string[] }> {
  const hits: string[] = []
  const picture = png(8, 8, () => [200, 40, 40])
  const server = createServer((request, response) => {
    hits.push(request.url ?? '')
    response.writeHead(200, { 'content-type': 'image/png' })
    response.end(picture)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hits }
}

/** Records every address the app's session is asked for, from now on. */
export async function watchRequests(app: ElectronApplication): Promise<() => Promise<string[]>> {
  await app.evaluate(({ session }) => {
    const seen: string[] = []
    ;(globalThis as unknown as { __requests: string[] }).__requests = seen
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      seen.push(details.url)
      callback({})
    })
  })
  return () => app.evaluate(() => (globalThis as unknown as { __requests: string[] }).__requests)
}

/**
 * The app's own scheme serves its built page files by fetching them from
 * `out/renderer`, so those file reads show up in the request log too; they
 * stay inside the app. Anything else under `file:` does not.
 */
const OWN_RENDERER_FILES = /^file:\/\/\/.*\/apps\/mindmap\/out\/renderer\//i

/** Addresses that leave the app: anything but its own pages, and pictures it made itself. */
export const leavesTheApp = (url: string): boolean =>
  !/^(?:genoffice-app|blob|data|devtools):/i.test(url) && !OWN_RENDERER_FILES.test(url)

// ---- driving the theme panel ----

async function openPanel(page: Page): Promise<void> {
  if ((await page.locator('.mm-theme-panel').count()) === 0) {
    await page.locator('[data-action="theme"]').click()
    await page.waitForSelector('.mm-theme-panel')
  }
}

async function closePanel(page: Page): Promise<void> {
  if ((await page.locator('.mm-theme-panel').count()) > 0) {
    await page.locator('[data-action="theme-close"]').click()
    await page.waitForSelector('.mm-theme-panel', { state: 'detached' })
  }
}

const drawnTheme = (page: Page): Promise<string | undefined> =>
  page
    .locator(`${VISIBLE} .map-container`)
    .evaluate((container) => (container as HTMLElement).dataset.mmTheme)

/** Picks one part of the theme in the panel and waits until the map is drawn with it. */
async function pick(
  page: Page,
  kind: 'skeleton' | 'band' | 'variant',
  value: string,
): Promise<void> {
  await openPanel(page)
  await page.locator(`[data-theme-pick="${kind}:${value}"]`).click()
  await page.waitForFunction(
    ([selector, part]) =>
      (document.querySelector<HTMLElement>(selector!)?.dataset.mmTheme ?? '')
        .split('/')
        .includes(part!),
    [`${VISIBLE} .map-container`, value] as const,
  )
}

/** The whole map in view at its real size when it fits, scaled down to fit when it does not. */
async function frame(page: Page): Promise<void> {
  await page.locator('[data-action="zoom-reset"]').click()
  await page.waitForTimeout(120)
  const fits = await page.evaluate((visible) => {
    const card = document.querySelector('.mm-card')!.getBoundingClientRect()
    const map = document.querySelector(`${visible} me-nodes`)!.getBoundingClientRect()
    return map.width <= card.width && map.height <= card.height
  }, VISIBLE)
  if (!fits) {
    await page.locator('[data-action="zoom-fit"]').click()
    await page.waitForTimeout(120)
  }
  // nothing selected, nothing focused and the pointer off the map: no ring, no hover handle
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.keyboard.press('Escape')
  await page.mouse.move(4, 4)
  await page.waitForTimeout(350)
}

const hexToRgb = (hex: string): string => {
  const value = Number.parseInt(hex.slice(1), 16)
  return `rgb(${value >> 16}, ${(value >> 8) & 0xff}, ${value & 0xff})`
}

/** What differs between two readings of `mapColours`, for the report of a failed check. */
function colourDifferences(first: string, second: string): unknown[] {
  const a = JSON.parse(first) as unknown[]
  const b = JSON.parse(second) as unknown[]
  const out: unknown[] = []
  for (let at = 0; at < Math.max(a.length, b.length); at++) {
    if (JSON.stringify(a[at]) !== JSON.stringify(b[at]))
      out.push({ at, first: a[at], second: b[at] })
  }
  return out
}

/** The colours the map is drawn with right now, read off the page. */
const mapColours = (page: Page): Promise<string> =>
  page.evaluate((visible) => {
    const root = document.querySelector(visible)!
    const pickStyle = (element: Element | null): string[] => {
      if (!element) return ['(none)']
      const style = getComputedStyle(element)
      return [style.color, style.backgroundColor, style.borderTopColor, style.boxShadow]
    }
    const out: unknown[] = [pickStyle(root.querySelector('.map-container'))]
    out.push(pickStyle(root.querySelector('me-root me-tpc')))
    for (const topic of root.querySelectorAll('me-main > me-wrapper > me-parent > me-tpc')) {
      out.push(pickStyle(topic))
    }
    for (const topic of [...root.querySelectorAll('me-children me-tpc')].slice(0, 12)) {
      out.push(pickStyle(topic))
    }
    for (const label of root.querySelectorAll('.tags span, .svg-label')) out.push(pickStyle(label))
    for (const path of root.querySelectorAll(
      'svg.lines path, svg.subLines path, svg.summary path',
    )) {
      out.push(getComputedStyle(path).stroke)
    }
    for (const part of root.querySelectorAll('.mm-marker *')) {
      const style = getComputedStyle(part)
      out.push([style.fill, style.stroke])
    }
    return JSON.stringify(out)
  }, VISIBLE)

/**
 * How far the lines of the "line" skeleton are from where the topics really
 * are, in pixels of the map: the underline a main topic sits on against the
 * bottom of its box, and the start of the lines below it against the far end
 * of that underline.
 */
const lineJoins = (page: Page): Promise<{ underline: number; start: number; onePath: boolean }> =>
  page.evaluate((visible) => {
    const nodes = document.querySelector<HTMLElement>(`${visible} me-nodes`)!
    const scale = nodes.getBoundingClientRect().width / nodes.offsetWidth
    const origin = nodes.getBoundingClientRect()
    const numbers = (d: string): number[] => (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number)
    const lines = nodes.querySelector('svg.lines')!.children
    let underline = 0
    let start = 0
    let onePath = true
    nodes.querySelectorAll<HTMLElement>('me-main > me-wrapper').forEach((wrapper, at) => {
      const topic = wrapper.querySelector('me-tpc')!.getBoundingClientRect()
      const d = lines[at]!.getAttribute('d') ?? ''
      // M sx sy C x1 y1 x2 y2 nearX y H farX
      onePath &&= /^M [^M]* C [^M]* H [^M]*$/.test(d)
      const [, , , , , , nearX, y, farX] = numbers(d) as number[]
      const bottom = (topic.bottom - origin.top) / scale
      const left = (topic.left - origin.left) / scale
      const right = (topic.right - origin.left) / scale
      underline = Math.max(
        underline,
        Math.abs(y! + 1.125 - bottom),
        Math.abs(Math.min(nearX!, farX!) - left),
        Math.abs(Math.max(nearX!, farX!) - right),
      )
      // the lines below start where that underline ends, at its height
      const frame = wrapper.getBoundingClientRect()
      const farEnd = wrapper.closest('me-main')!.classList.contains('lhs')
        ? topic.left
        : topic.right
      const children = wrapper.querySelectorAll(':scope > me-children > me-wrapper').length
      const paths = [...wrapper.querySelectorAll(':scope > svg.subLines > path')].slice(0, 1)
      if (children > 0) {
        for (const path of paths) {
          const [sx, sy] = numbers(path.getAttribute('d') ?? '') as [number, number]
          start = Math.max(
            start,
            Math.abs(sx - (farEnd - frame.left) / scale),
            Math.abs(sy + 1.125 - (topic.bottom - frame.top) / scale),
          )
        }
      }
    })
    return { underline, start, onePath }
  }, VISIBLE)

async function waitForSaved(page: Page): Promise<void> {
  await page.waitForFunction(
    () => document.querySelector('.mm-save-status')?.textContent === '저장됨',
    undefined,
    { timeout: 20_000 },
  )
}

export async function lookRun(tools: LookRunTools): Promise<void> {
  const { check, results } = tools
  const dir = join(tools.out, 'look')
  mkdirSync(dir, { recursive: true })
  const shot = (page: Page, name: string): Promise<Buffer> =>
    page.screenshot({ path: join(dir, `${name}.png`) })

  console.log('\n[5] the look of the map: skeletons, bands, grounds, the panel, the toolbar')
  const path = join(tools.out, 'look-sample.xmind')
  writeFileSync(path, await (await createXmindDocumentFromSheets([sampleSheet()])).save())
  /** the theme picked last, the one the file must carry when it is opened again */
  const lastPicked: ThemeId = 'block/plum/tint'

  const first = await tools.launch(path, { size: WINDOW })
  try {
    const { page } = first
    await page.waitForSelector(`${VISIBLE} me-root me-tpc`)
    check(
      (await drawnTheme(page)) === DEFAULT_THEME_ID,
      'a map with the default theme is drawn with it',
    )
    check((await page.locator('.mm-notice').count()) === 0, 'and no notice says otherwise')
    check(
      (await page.locator('.mm-save-status').getAttribute('data-dirty')) === 'false',
      'looking at the map and opening the theme panel does not change the document',
    )

    // the text steps down from the centre, and again below the third level
    const defaultLook = themeLook(DEFAULT_THEME_ID)
    const sizes = await page.evaluate((visible) => {
      const sizeOf = (title: string): number | null => {
        const topic = [...document.querySelectorAll<HTMLElement>(`${visible} me-tpc`)].find(
          (each) => each.querySelector('.text')?.textContent === title,
        )
        return topic ? Number.parseFloat(getComputedStyle(topic).fontSize) : null
      }
      return {
        central: sizeOf('가을 제주 여행'),
        main: sizeOf('일정'),
        third: sizeOf('첫째 날 · 동쪽 해안'),
        fourth: sizeOf('성산 일출봉'),
      }
    }, VISIBLE)
    results.typeSizes = sizes
    check(
      sizes.central === defaultLook.shapes.central.fontSize &&
        sizes.main === defaultLook.shapes.main.fontSize &&
        sizes.third === defaultLook.shapes.sub.fontSize &&
        sizes.fourth === defaultLook.deepSizes[0],
      'the text steps down from the centre to the fourth level',
    )
    check(
      (await page.locator(`${VISIBLE} me-tpc[data-mm-level]`).count()) > 0 &&
        (await page
          .locator(`${VISIBLE} me-tpc[data-mm-level]`)
          .evaluateAll((topics) => topics.every((topic) => topic.dataset.mmLevel === '4'))),
      'and only the levels below the third carry the mark the stylesheet steps',
    )

    // 1: the four skeletons, in the default band
    for (const [at, skeleton] of THEME_SKELETON_IDS.entries()) {
      if (skeleton !== 'pill') await pick(page, 'skeleton', skeleton)
      await closePanel(page)
      await frame(page)
      const id = `${skeleton}/paper/light` as ThemeId
      check((await drawnTheme(page)) === id, `the ${skeleton} skeleton is drawn when picked`)
      check(
        (await page
          .locator(`${VISIBLE} .map-container`)
          .evaluate((element) => getComputedStyle(element).backgroundColor)) ===
          hexToRgb(themeLook(id).ground),
        `on the ground its theme says`,
      )
      if (skeleton === 'line') {
        const joins = await lineJoins(page)
        results.lineSkeletonJoins = joins
        check(
          joins.onePath,
          'line skeleton: a main branch and the underline of its topic are one path',
        )
        check(
          joins.underline <= 0.05,
          `the underline lies on the bottom of its topic (off by ${joins.underline.toFixed(3)}px at most)`,
        )
        check(
          joins.start <= 0.05,
          `the lines below start at the end of that underline (off by ${joins.start.toFixed(3)}px at most)`,
        )
      }
      await shot(page, `1-skeleton-${at + 1}-${skeleton}`)
    }

    // 2: the pill skeleton in every band
    await pick(page, 'skeleton', 'pill')
    for (const [at, band] of THEME_BAND_IDS.entries()) {
      if (band !== 'paper') await pick(page, 'band', band)
      await closePanel(page)
      await frame(page)
      check(
        (await drawnTheme(page)) === `pill/${band}/light`,
        `the ${band} band is drawn when picked`,
      )
      await shot(page, `2-band-${at + 1}-${band}`)
    }

    // 3: one band on its three grounds
    await pick(page, 'band', 'harbor')
    for (const [at, variant] of THEME_VARIANT_IDS.entries()) {
      await pick(page, 'variant', variant)
      await closePanel(page)
      await frame(page)
      check(
        (await drawnTheme(page)) === `pill/harbor/${variant}`,
        `the ${variant} ground is drawn when picked`,
      )
      await shot(page, `3-ground-${at + 1}-${variant}`)
    }

    // 4: the panel
    await pick(page, 'variant', 'light')
    await pick(page, 'band', 'paper')
    await openPanel(page)
    await frame(page)
    check(
      (await page.locator('.mm-theme-option.on').count()) === 3,
      'the panel marks one shape, one band and one ground as chosen',
    )
    check(
      (await page.locator('[data-theme-pick^="skeleton:"]').count()) === 4 &&
        (await page.locator('[data-theme-pick^="band:"]').count()) === 8 &&
        (await page.locator('[data-theme-pick^="variant:"]').count()) === 3,
      'and offers four shapes, eight bands and three grounds',
    )
    await shot(page, '4-theme-panel')

    // 5: the toolbar, close up
    await page.locator('.ribbon').screenshot({ path: join(dir, '5-toolbar-1-light.png') })
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
    await page.waitForTimeout(150)
    await page.locator('.ribbon').screenshot({ path: join(dir, '5-toolbar-2-dark.png') })

    // 6: the app and the map are light or dark on their own
    await closePanel(page)
    await frame(page)
    const lightMapInDarkApp = await mapColours(page)
    await shot(page, '6-app-1-dark-app-light-map')
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'))
    await page.waitForTimeout(150)
    const lightMapInLightApp = await mapColours(page)
    results.lightMapColourDifferences = colourDifferences(lightMapInDarkApp, lightMapInLightApp)
    check(
      lightMapInLightApp === lightMapInDarkApp,
      'a light map has the same colours in the dark app and in the light app',
    )
    await pick(page, 'variant', 'dark')
    await closePanel(page)
    await frame(page)
    const darkMapInLightApp = await mapColours(page)
    await shot(page, '6-app-2-light-app-dark-map')
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
    await page.waitForTimeout(150)
    const darkMapInDarkApp = await mapColours(page)
    results.darkMapColourDifferences = colourDifferences(darkMapInLightApp, darkMapInDarkApp)
    check(
      darkMapInDarkApp === darkMapInLightApp,
      'a dark map has the same colours in the light app and in the dark app',
    )
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'))

    // a theme that was picked is in the file, and is the same theme when the file is opened again
    await pick(page, 'skeleton', 'block')
    await pick(page, 'band', 'plum')
    await pick(page, 'variant', 'tint')
    check(
      (await page.locator('.mm-save-status').getAttribute('data-dirty')) === 'true',
      'picking a theme makes the document changed',
    )
    await page.keyboard.press('Control+S')
    await waitForSaved(page)
  } finally {
    await first.app.close()
  }
  const saved = await openXmind(new Uint8Array(readFileSync(path)))
  check(
    saved.status === 'ok' && recogniseSheetTheme(saved.document.sheets[0]!) === lastPicked,
    'the saved file carries the theme that was picked last',
  )

  const again = await tools.launch(path, { size: WINDOW })
  try {
    await again.page.waitForSelector(`${VISIBLE} me-root me-tpc`)
    check(
      (await drawnTheme(again.page)) === lastPicked,
      'opened again, the map is drawn with that theme',
    )
    check((await again.page.locator('.mm-notice').count()) === 0, 'without a notice about the look')

    // 9: the other layouts, not saved
    const layout = async (value: string): Promise<void> => {
      await again.page.locator('.mm-layout-pick .gs-dd-btn').click()
      await again.page.locator(`.gs-dd-item[data-value="${value}"]`).click()
      await again.page.waitForTimeout(200)
    }
    await pick(again.page, 'skeleton', 'line')
    await pick(again.page, 'band', 'moss')
    await pick(again.page, 'variant', 'light')
    await layout('right')
    await closePanel(again.page)
    await frame(again.page)
    await again.page.locator('[data-action="zoom-fit"]').click()
    await again.page.mouse.move(4, 4)
    await again.page.waitForTimeout(400)
    await shot(again.page, '9-layout-1-right-line')
    const rightJoins = await lineJoins(again.page)
    check(
      rightJoins.underline <= 0.05 && rightJoins.start <= 0.05,
      'the lines of the line skeleton meet in the layout to one side as well',
    )
    for (const [at, skeleton] of (['block', 'line', 'pill'] as const).entries()) {
      await pick(again.page, 'skeleton', skeleton)
      await layout('down')
      await closePanel(again.page)
      await frame(again.page)
      await again.page.locator('[data-action="zoom-fit"]').click()
      await again.page.mouse.move(4, 4)
      await again.page.waitForTimeout(400)
      await shot(again.page, `9-layout-${at + 2}-down-${skeleton}`)
    }
  } finally {
    await again.app.close()
  }

  // 5 again, three device pixels to the pixel: what the icons are made of
  const large = await tools.launch(path, { size: WINDOW, scale: 3 })
  try {
    await large.page.waitForSelector(`${VISIBLE} me-root me-tpc`)
    // a topic is selected, so every tool is in its enabled state
    await large.page.locator(`${VISIBLE} me-root me-tpc`).click()
    await large.page.mouse.move(700, 500)
    const clip = await large.page.evaluate(() => {
      const ribbon = document.querySelector('.ribbon')!.getBoundingClientRect()
      const tools = [...document.querySelectorAll('.mm-tools .mm-tool')]
      const last = tools[tools.length - 1]!.getBoundingClientRect()
      return { x: 0, y: ribbon.top, width: Math.ceil(last.right) + 16, height: ribbon.height }
    })
    await large.page.screenshot({ path: join(dir, '5-toolbar-3-light-close-up.png'), clip })
    await large.page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
    await large.page.waitForTimeout(150)
    await large.page.screenshot({ path: join(dir, '5-toolbar-4-dark-close-up.png'), clip })
  } finally {
    await large.app.close()
  }

  await decorationRun(tools, dir)
  await sampleFileRun(tools, dir)
}

// ---- 7: markers, pictures, a topic's own style ----

async function decorationRun(tools: LookRunTools, dir: string): Promise<void> {
  const { check, results } = tools
  console.log('\n[6] markers, pictures from inside and outside the file, style values')
  const outside = await startOutside()
  const path = join(tools.out, 'look-decoration.xmind')
  const original = await withResources([decorationSheet(outside.url), glyphSheet()], {
    'resources/landscape.png': landscape(),
    'resources/chart.svg': chartSvg(outside.url),
  })
  writeFileSync(path, original)

  const { app, page } = await tools.launch(path, { size: WINDOW })
  try {
    const requests = await watchRequests(app)
    await page.waitForSelector(`${VISIBLE} me-root me-tpc`)
    await page.waitForFunction(
      (visible) =>
        [...document.querySelectorAll<HTMLImageElement>(`${visible} .mm-picture img`)].every(
          (img) => img.complete && img.naturalWidth > 0,
        ),
      VISIBLE,
    )
    await page.waitForTimeout(400)
    await frame(page)

    const families = await page
      .locator(`${VISIBLE} .mm-marker`)
      .evaluateAll((glyphs) => glyphs.map((glyph) => (glyph as SVGElement).dataset.markerFamily))
    const count = (family: string): number => families.filter((each) => each === family).length
    results.markerFamilies = {
      priority: count('priority'),
      progress: count('progress'),
      flag: count('flag'),
      star: count('star'),
      other: count('other'),
    }
    check(
      count('priority') === 6 &&
        count('progress') === 6 &&
        count('flag') === 4 &&
        count('star') === 2,
      'markers of the four families are drawn with their own glyphs',
    )
    check(count('other') === 2, 'a marker id the app does not know is drawn as the common mark')

    const pictures = await page.locator(`${VISIBLE} .mm-picture img`).evaluateAll((images) =>
      (images as HTMLImageElement[]).map((img) => ({
        source: img.src.split(':')[0],
        width: img.naturalWidth,
      })),
    )
    results.archivePictures = pictures
    check(
      pictures.length === 2 && pictures.every((each) => each.source === 'blob' && each.width > 0),
      'the two pictures inside the file are shown, a PNG and an SVG, from object URLs',
    )
    check(
      (await page.locator(`${VISIBLE} .mm-picture-missing`).count()) === 2,
      'the two pictures that point outside the file are marks without a source',
    )
    check(
      (await page.locator('img:not([src^="blob:"])').count()) === 0 &&
        (await page
          .locator('script[src^="http"], link[href^="http"], iframe, object, embed')
          .count()) === 0,
      'no element on the page has an outside address as its source',
    )
    check(
      (await page.locator(`${VISIBLE} svg script, ${VISIBLE} svg image`).count()) === 0,
      'and the SVG picture was not put into the page',
    )

    const style = (
      title: string,
    ): Promise<{ fill: string; color: string; size: string; weight: string }> =>
      page
        .locator(`${VISIBLE} me-tpc`, { hasText: title })
        .first()
        .evaluate((element) => {
          const computed = getComputedStyle(element)
          return {
            fill: computed.backgroundColor,
            color: computed.color,
            size: computed.fontSize,
            weight: computed.fontWeight,
          }
        })
    const plain = await style('PC의 다른 경로도 자리만')
    const coloured = await style('채움과 글자색')
    check(
      coloured.fill === 'rgb(255, 224, 138)' && coloured.color === 'rgb(91, 58, 0)',
      "a topic's own fill and text colour are drawn",
    )
    const bold = await style('굵게, 크게')
    check(bold.weight === '700' && bold.size === '21.33px', 'and its own weight and size')
    const hostile = await style('색 꼴이 아닌 채움은 기본 모양')
    check(
      hostile.fill === plain.fill && hostile.color === plain.color && hostile.size === plain.size,
      'style values that are not a colour or a number are not used: the topic has the default look',
    )
    await page.screenshot({ path: join(dir, '7-decoration-1-markers-pictures-styles.png') })

    // every glyph, on a second sheet, enlarged so the drawing can be judged
    await page.locator('.mm-sheet-name', { hasText: '표식 그림' }).click()
    await page.waitForSelector(`${VISIBLE} me-root me-tpc`)
    const enlarged = async (name: string): Promise<void> => {
      await closePanel(page)
      await frame(page)
      for (let step = 0; step < 5; step++) await page.locator('[data-action="zoom-in"]').click()
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
      await page.mouse.move(4, 4)
      await page.waitForTimeout(400)
      await page.screenshot({ path: join(dir, `${name}.png`) })
    }
    await enlarged('7-decoration-2-every-marker-glyph')
    await page.locator('.mm-sheet-name', { hasText: '표식과 그림' }).click()

    await page.waitForTimeout(600)
    const seen = await requests()
    results.requestsWhilePicturesWereShown = seen.filter(leavesTheApp)
    check(seen.filter(leavesTheApp).length === 0, 'the app asked for no address outside itself')
    check(outside.hits.length === 0, 'and the web server the file points at was never visited')

    await page.keyboard.press('Control+S')
    await page.waitForTimeout(800)

    // Last, and not saved: the glyphs on topics filled with strong colours,
    // where a glyph could melt into its topic.
    await page.locator('.mm-sheet-name', { hasText: '표식 그림' }).click()
    await pick(page, 'skeleton', 'block')
    await pick(page, 'band', 'signal')
    await closePanel(page)
    await frame(page)
    for (let step = 0; step < 5; step++) await page.locator('[data-action="zoom-in"]').click()
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await page.mouse.move(4, 4)
    await page.waitForTimeout(400)
    await page.screenshot({ path: join(dir, '7-decoration-3-marker-glyphs-on-filled-topics.png') })
  } finally {
    await app.close()
    outside.server.close()
  }
  check(
    readFileSync(path).equals(Buffer.from(original)),
    'after all that, a save writes the file as it was: every value of the file is kept',
  )
}

// ---- 8: a file from another program, in the default look ----

async function sampleFileRun(tools: LookRunTools, dir: string): Promise<void> {
  const { check } = tools
  const sample = process.env.MINDMAP_REAL_RUN_SAMPLE
  if (!sample || !existsSync(sample)) {
    console.log('\n[7] no file named by MINDMAP_REAL_RUN_SAMPLE: the default-look step is skipped')
    return
  }
  console.log('\n[7] a file from another program is drawn in the default look and left alone')
  // a copy outside the repository; nothing of the file is kept but a screenshot
  const copy = join(mkdtempSync(join(tmpdir(), 'mindmap-real-run-sample-')), basename(sample))
  copyFileSync(sample, copy)
  const original = readFileSync(copy)
  const { app, page } = await tools.launch(copy, { size: WINDOW })
  try {
    const requests = await watchRequests(app)
    await page.waitForSelector(`${VISIBLE} me-root me-tpc`)
    await page.waitForTimeout(800)
    check((await drawnTheme(page)) === DEFAULT_THEME_ID, 'its sheet is drawn with the default look')
    check(
      (await page.locator('.mm-notice').allTextContents()).some((text) =>
        text.includes('기본 모양으로 보입니다'),
      ),
      'and the notice says so',
    )
    for (const close of await page.locator('.mm-notice-close').all()) await close.click()
    await openPanel(page)
    check(
      (await page.locator('[data-theme-note="not-written"]').count()) === 1,
      'the theme panel says the sheet is shown with the default look',
    )
    await closePanel(page)
    await frame(page)
    await page.locator('[data-action="zoom-fit"]').click()
    await page.mouse.move(4, 4)
    await page.waitForTimeout(400)
    await page.screenshot({ path: join(dir, '8-file-from-another-program-default-look.png') })
    check(
      (await requests()).filter(leavesTheApp).length === 0,
      'showing it asked for no address outside the app',
    )
    await page.keyboard.press('Control+S')
    await page.waitForTimeout(800)
  } finally {
    await app.close()
  }
  check(
    readFileSync(copy).equals(original),
    'a save without a change leaves the file byte for byte',
  )
}
