import { test, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { launchShell, closeAndSaveVideo, waitForPageWithUrl } from './helpers'

/**
 * The fixture deck (one slide whose only run uses Rubik, a font the app does
 * not bundle) is kept as plain-text OOXML parts under
 * assets/font-manager-rubik/ so no binary lives in the repo; zip them into a
 * real .pptx at test time.
 */
async function buildRubikFixture(): Promise<string> {
  const out = join(
    await mkdtemp(join(tmpdir(), 'genoffice-font-manager-')),
    'font-manager-rubik.pptx',
  )
  execFileSync('zip', ['-X', '-q', '-r', out, '.'], {
    cwd: resolve(__dirname, 'assets/font-manager-rubik'),
  })
  return out
}

/**
 * Font manager smoke: a deck that references a font the machine lacks opens
 * with no download prompt, and installing a font file the user already has
 * lands it in the app's font store.
 */
test('fonts install from a file and nothing offers a download', async () => {
  test.setTimeout(180_000)
  const launched = await launchShell({
    onboardingSeen: true,
    videoDir: 'slides-font-manager',
    openFile: await buildRubikFixture(),
  })
  try {
    const editorPage = await waitForPageWithUrl(launched.app, '://slides/')
    await editorPage.waitForSelector('.stage-wrap canvas', { timeout: 30_000 })

    const surface = await editorPage.evaluate(() => {
      const api = (window as unknown as { slidesApi: Record<string, unknown> }).slidesApi
      return {
        catalog: typeof api.fontCatalog,
        download: typeof api.fontDownload,
        missing: typeof api.fontMissing,
        installLocal: typeof api.fontInstallLocal,
      }
    })
    expect(surface).toEqual({
      catalog: 'undefined',
      download: 'undefined',
      missing: 'undefined',
      installLocal: 'function',
    })
    await expect(editorPage.locator('.font-missing-banner')).toHaveCount(0)
    await expect(editorPage.locator('.rb-font-download')).toHaveCount(0)

    // The entry opens the native file picker; answer it with a font the repo bundles.
    const fontFile = resolve(__dirname, '../apps/docs/src/renderer/fonts/Caladea-Regular.ttf')
    await launched.app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
    }, fontFile)
    const installed = await editorPage.evaluate(() =>
      (
        window as unknown as {
          slidesApi: { fontInstallLocal(): Promise<{ families: string[] }> }
        }
      ).slidesApi.fontInstallLocal(),
    )
    expect(installed.families).toEqual(['Caladea'])
    expect(existsSync(join(launched.userDataDir, 'fonts', 'Caladea.ttf'))).toBe(true)
    // the relayout the install triggers must leave the deck on screen
    await expect(editorPage.locator('.stage-wrap canvas').first()).toBeVisible()
  } finally {
    await closeAndSaveVideo(launched, 'slides-font-manager')
  }
})
