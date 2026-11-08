/**
 * Live trial of one OpenRouter `:free` model on the Word editor's tool loop.
 * Not part of the suite: it needs a real key and spends that key's free daily
 * requests. `npm run free-models:trial` runs it once per model and reads the
 * `TRIAL {json}` line it prints; by hand:
 *   TRIAL_MODEL=<id> npx playwright test -c e2e/playwright.config.ts free-models.trial
 * The key is copied from the installed app's settings into a scratch folder
 * and never printed.
 */
import { test, expect, type Page } from '@playwright/test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchShell, closeAndSaveVideo, waitForPageWithUrl, screenshotPath } from './helpers'

const MODEL = process.env.TRIAL_MODEL ?? ''
const RUN_TIMEOUT = 240_000

async function storedKey(): Promise<string> {
  const path = join(process.env.APPDATA ?? '', 'IeumOffice', 'ai-settings.json')
  const settings = JSON.parse(await readFile(path, 'utf8'))
  return settings.providers.openrouter.apiKey
}

test(`free model trial: ${MODEL}`, async () => {
  test.skip(!MODEL, 'TRIAL_MODEL is not set')
  test.setTimeout(RUN_TIMEOUT * 2 + 120_000)
  const key = await storedKey()
  const userDataDir = await mkdtemp(join(tmpdir(), 'ieum-free-trial-'))
  await writeFile(
    join(userDataDir, 'ai-settings.json'),
    JSON.stringify({
      provider: 'openrouter',
      providers: { openrouter: { apiKey: key, model: MODEL } },
      subscriptionNoticeSeen: true,
    }),
  )
  const slug = MODEL.replace(/[^a-z0-9]+/gi, '-')
  const launched = await launchShell({
    userDataDir,
    onboardingSeen: true,
    lang: 'ko',
    videoDir: `free-trial-${slug}`,
  })
  const { app, page } = launched
  const report: Record<string, unknown> = { model: MODEL, pass: false }
  let editor: Page | undefined
  try {
    await page.locator('.quick-card').first().click()
    editor = await waitForPageWithUrl(app, '://docs/')
    const docPage = editor.locator('.doc-page[contenteditable="true"]')
    await docPage.waitFor()
    await docPage.click()
    await editor.keyboard.type('주간 회의', { delay: 5 })
    await editor.keyboard.press('Control+Alt+1')
    await editor.keyboard.press('Enter')
    await editor.keyboard.type(
      '이번 주에는 새 학기 준비물 목록을 정리했다. 복사기 토너가 떨어져 다음 주 화요일까지 주문하기로 했다.',
      { delay: 2 },
    )
    await editor.keyboard.press('Enter')
    await editor.keyboard.type(
      '도서관 대출 기간을 2주에서 3주로 늘리자는 의견이 나왔고, 다음 회의에서 다시 정하기로 했다.',
      { delay: 2 },
    )
    await expect(docPage.locator('h1')).toContainText('주간 회의')

    const view = editor
    const composer = view.locator('.ai-composer textarea')
    const stop = view.locator('.ai-stop-btn')
    const errorLines = view.locator('.ai-msg-error')
    /** one request; the errors are the ones this request added to the panel */
    const ask = async (label: string, prompt: string) => {
      const errorsBefore = await errorLines.count()
      const t0 = Date.now()
      await composer.fill(prompt)
      await composer.press('Enter')
      await expect(stop).toBeVisible({ timeout: 15_000 })
      try {
        await expect(stop).toBeHidden({ timeout: RUN_TIMEOUT })
      } catch {
        report.failure = `request ${label} did not finish in ${RUN_TIMEOUT / 1000} s`
        throw new Error(report.failure as string)
      }
      const errors = (await errorLines.allInnerTexts()).slice(errorsBefore)
      await view.screenshot({ path: screenshotPath(`free-trial-${slug}-${label}`) })
      return { seconds: Math.round((Date.now() - t0) / 1000), errors }
    }

    const a = await ask(
      'A',
      '문서 끝에 "다음 회의는 10월 22일 오후 3시에 엽니다."라는 문단을 넣어 줘.',
    )
    const textA = await docPage.innerText()
    const insertedOnce = textA.split('다음 회의는 10월 22일 오후 3시에 엽니다').length - 1 === 1
    report.A = { ...a, ok: insertedOnce && a.errors.length === 0, insertedOnce }

    const b = await ask(
      'B',
      '제목을 "10월 셋째 주 회의록"으로 바꾸고, 문서 맨 끝에 본문 내용을 세 줄로 요약한 글머리 기호 목록을 넣어 줘.',
    )
    const heading = (await docPage.locator('h1').first().innerText()).trim()
    const listItems = await docPage.locator('.doc-li').count()
    report.B = {
      ...b,
      ok: heading === '10월 셋째 주 회의록' && listItems >= 3 && b.errors.length === 0,
      heading,
      listItems,
    }
    report.pass = (report.A as { ok: boolean }).ok && (report.B as { ok: boolean }).ok
  } catch (error) {
    report.failure ??= String(error instanceof Error ? error.message : error).split('\n')[0]
    await editor?.screenshot({ path: screenshotPath(`free-trial-${slug}-failed`) }).catch(() => {})
  } finally {
    console.log('TRIAL ' + JSON.stringify(report))
    await closeAndSaveVideo(launched, `free-trial-${slug}`)
    await rm(userDataDir, { recursive: true, force: true })
  }
})
