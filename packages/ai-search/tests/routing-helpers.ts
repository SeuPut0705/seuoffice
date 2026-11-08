import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  AiSubscriptionProviderId,
  AiSubscriptionState,
  AiSubscriptionStatus,
} from '@genoffice/ai-provider'

export function tempDir(prefix = 'genoffice-ai-routing-'): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

/**
 * A settings file as the app writes it. The chat provider block is always
 * there: without it every section of the file resets to its defaults.
 */
export function writeSettings(patch: Record<string, unknown> = {}): string {
  const path = join(tempDir(), 'ai-settings.json')
  writeFileSync(path, JSON.stringify({ provider: 'auto', providers: {}, ...patch }))
  return path
}

export function status(
  provider: AiSubscriptionProviderId,
  state: AiSubscriptionState,
  extra: Partial<AiSubscriptionStatus> = {},
): AiSubscriptionStatus {
  return { provider, state, meteredAccepted: false, ...extra }
}

/** A data URL whose decoded payload is `bytes` long. */
export function dataUrl(bytes: number, mime = 'image/png'): string {
  return `data:${mime};base64,${'A'.repeat(Math.ceil((bytes * 4) / 3))}`
}

/** media block with one key provider filled in for every capability it has */
export function keyMedia(
  selection: Record<string, string>,
  ...providers: string[]
): Record<string, unknown> {
  return {
    ...selection,
    providers: Object.fromEntries(
      providers.map((id) => [
        id,
        { apiKey: `${id}-key`, imageModel: `${id}-image`, analysisModel: `${id}-analysis` },
      ]),
    ),
  }
}
