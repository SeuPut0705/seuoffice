import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test, type Page } from '@playwright/test'

const repo = fileURLToPath(new URL('../../..', import.meta.url))
const at = (path: string): string => resolve(repo, path)

function firstXlsx(): string {
  const dir = at('apps/sheets/fixtures/generated')
  const name = readdirSync(dir)
    .filter((file) => file.endsWith('.xlsx'))
    .sort()[0]
  if (!name) throw new Error(`no .xlsx in ${dir}`)
  return resolve(dir, name)
}

interface Problems {
  errors: string[]
  missing: string[]
}

/** Uncaught errors and missing-bridge warnings from the launcher and every frame */
function watch(page: Page): Problems {
  const problems: Problems = { errors: [], missing: [] }
  page.on('pageerror', (error) => problems.errors.push(error.message))
  page.on('console', (message) => {
    if (message.text().includes('[web-bridge] missing')) problems.missing.push(message.text())
  })
  return problems
}

async function open(page: Page, file: string | { name: string; buffer: Buffer }): Promise<void> {
  await page.goto('/')
  await page.setInputFiles(
    '#file',
    typeof file === 'string' ? file : { ...file, mimeType: 'application/octet-stream' },
  )
}

/** Share of pixels that differ from the most common colour of a PNG */
async function inkedShare(page: Page, png: Buffer): Promise<number> {
  return page.evaluate(async (base64) => {
    const blob = await (await fetch(`data:image/png;base64,${base64}`)).blob()
    const bitmap = await createImageBitmap(blob)
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    const context = canvas.getContext('2d')!
    context.drawImage(bitmap, 0, 0)
    const data = context.getImageData(0, 0, bitmap.width, bitmap.height).data
    const counts = new Map<number, number>()
    for (let i = 0; i < data.length; i += 4) {
      const key = (data[i]! << 16) | (data[i + 1]! << 8) | data[i + 2]!
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    const total = data.length / 4
    return 1 - Math.max(...counts.values()) / total
  }, png.toString('base64'))
}

/** `worker`: a Vite-bundled worker the app starts, which needs the Node globals too */
const OPENS: Array<{ file: string; text?: string; worker?: string }> = [
  {
    file: 'apps/pdf/tests/fixtures/plain-sample.pdf',
    text: 'This line must survive the round trip.',
  },
  // "first paragraph." in the fixture's Chinese text
  {
    file: 'fixtures/generated/simple.docx',
    text: '\u7b2c\u4e00\u6bb5\u3002',
    worker: 'parse-worker',
  },
  { file: 'XLSX', worker: 'xlsx-worker' },
  { file: 'packages/pptx-engine/tests/fixtures/01_standard_business.pptx' },
  { file: 'apps/hwp/tests/fixtures/memo.hwp' },
  { file: 'apps/hwp/tests/fixtures/memo.hwpx' },
]

for (const { file, text, worker } of OPENS) {
  test(`opens ${file}`, async ({ page }) => {
    const path = file === 'XLSX' ? firstXlsx() : at(file)
    const problems = watch(page)
    await open(page, path)
    await expect(page.locator('#status')).not.toContainText('여는 중', { timeout: 30_000 })
    await expect(page.locator('#status')).not.toContainText('오류')
    const frame = page.locator('#viewer iframe')
    await expect
      .poll(async () => inkedShare(page, await frame.screenshot()), { timeout: 20_000 })
      .toBeGreaterThanOrEqual(0.005)
    if (text)
      await expect(page.frameLocator('#viewer iframe').getByText(text).first()).toBeVisible()
    if (worker) {
      const running = page.workers().find((candidate) => candidate.url().includes(worker))
      expect(running, `${worker} is running`).toBeDefined()
      const globals = await running!.evaluate(() => [
        typeof Buffer,
        typeof globalThis.process?.nextTick,
      ])
      expect(globals).toEqual(['function', 'function'])
    }
    expect(problems.errors).toEqual([])
    expect(problems.missing).toEqual([])
  })
}

test('refuses a format no app opens', async ({ page }) => {
  await open(page, { name: 'notes.txt', buffer: Buffer.from('plain text') })
  await expect(page.locator('#status')).toContainText('unsupported_format')
})

test('an encrypted PDF shows the password prompt or a page, without crashing', async ({ page }) => {
  const problems = watch(page)
  await open(page, at('apps/pdf/tests/fixtures/enc128.pdf'))
  await expect(page.locator('#status')).not.toContainText('여는 중', { timeout: 30_000 })
  const frame = page.frameLocator('#viewer iframe')
  await expect(frame.locator('.pdf-pwd-mask, .pdf-page-content canvas').first()).toBeVisible({
    timeout: 20_000,
  })
  expect(problems.errors).toEqual([])
})
