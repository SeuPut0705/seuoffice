import { test, expect } from '@playwright/test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchShell, closeAndSaveVideo, screenshotPath } from './helpers'

/**
 * The free connections (Settings › AI › Use for free, and the first-run guide's
 * connect step) for people without a subscription. Nothing here reaches
 * OpenRouter or Google: the cards are read from a seeded settings file, and no
 * connect button is pressed.
 */

test('Settings › AI shows the free connections, and a seeded free connection as in use', async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'genoffice-e2e-free-ai-'))
  await writeFile(
    join(userDataDir, 'ai-settings.json'),
    JSON.stringify({
      provider: 'openrouter',
      providers: {
        openrouter: { apiKey: 'sk-or-v1-seeded', model: 'nvidia/nemotron-3-super-120b-a12b:free' },
      },
      subscriptionNoticeSeen: true,
    }),
  )
  const launched = await launchShell({
    userDataDir,
    onboardingSeen: true,
    videoDir: 'free-ai-settings',
  })
  const { page } = launched
  try {
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.locator('.set-nav-item').filter({ hasText: 'AI' }).first().click()
    await expect(page.locator('#set-free-ai')).toHaveText('Use for free')
    const openrouter = page.locator('.free-ai-card[data-provider="openrouter"]')
    const gemini = page.locator('.free-ai-card[data-provider="gemini"]')
    await expect(openrouter).toHaveAttribute('data-state', 'connected')
    await expect(openrouter.locator('.ai-sub-card-status')).toHaveText('Connected · in use')
    await expect(openrouter.locator('[data-action="disconnect"]')).toBeVisible()
    await expect(gemini).toHaveAttribute('data-state', 'idle')
    await expect(gemini.locator('input.free-ai-key')).toBeVisible()
    await expect(gemini.locator('[data-action="connect-key"]')).toBeDisabled()
    await expect(gemini.locator('[data-action="get-key"]')).toBeVisible()
    await expect(page.locator('.free-ai-privacy')).toBeVisible()
    await page.screenshot({ path: screenshotPath('free-ai-settings') })
  } finally {
    await closeAndSaveVideo(launched, 'free-ai-settings')
  }
})

test('the first-run connect step offers the free connections as the "neither yet" path', async () => {
  const launched = await launchShell({ videoDir: 'free-ai-onboarding' })
  const { page } = launched
  try {
    const dialog = page.locator('.onb-overlay')
    await expect(dialog).toBeVisible()
    await page.locator('.onb-next').click()
    const step = page.locator('.onb-slide[data-step="connect"]')
    // which AI the user has comes first; the free cards are the answer "neither yet"
    await expect(step.locator('.ai-sub-guide-question')).toHaveText('Which AI do you already use?')
    await expect(step.locator('.free-ai-card')).toHaveCount(0)
    await step.locator('[data-path="free"]').click()
    await expect(step.locator('.free-ai-card')).toHaveCount(2)
    await expect(
      step.locator('[data-provider="openrouter"] [data-action="connect-browser"]'),
    ).toBeVisible()
    await page.screenshot({ path: screenshotPath('free-ai-onboarding') })
  } finally {
    await closeAndSaveVideo(launched, 'free-ai-onboarding')
  }
})
