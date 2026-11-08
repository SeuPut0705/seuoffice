/**
 * Which backend a generate_image request starts on: the Codex subscription or
 * a key provider. Pure and browser-safe.
 *
 * The choice is made once, when the request starts. A request that fails
 * midway (a used-up limit, say) ends in its error; it is not retried on
 * another backend.
 */
import { DEFAULT_AI_IMAGE_PROVIDER } from './legacy-settings'
import { AI_MEDIA_PROVIDERS, mediaConfigUsable, providerHasCapability } from './media'
import type {
  AiImageProviderSelection,
  AiMediaKeyProviderId,
  AiMediaProviderConfig,
  AiSettings,
  AiSubscriptionStatus,
} from './types'

let codexImageAvailable = false

/**
 * Called by the Codex image backend when it loads (`./codex-image`), so the
 * answer is "yes" exactly in the processes that can actually run it. A
 * process that never loads that module keeps the default `false`.
 */
export function setCodexImageGenerationAvailable(available: boolean): void {
  codexImageAvailable = available
}

/** Whether this build can generate images through the Codex subscription. Off until a backend registers. */
export function codexImageGenerationAvailable(): boolean {
  return codexImageAvailable
}

export type AiImageBackend =
  | { kind: 'codex' }
  | { kind: 'key'; provider: AiMediaKeyProviderId; config: AiMediaProviderConfig }
  /** nothing can generate an image: the tool answers "unavailable" */
  | { kind: 'none' }

export interface AiImageBackendContext {
  /** Codex connection status; leave it out to treat the subscription as absent (a headless caller that may not use it) */
  codex?: AiSubscriptionStatus | undefined
  /** defaults to codexImageGenerationAvailable() */
  codexImageAvailable?: boolean | undefined
}

type MediaSettings = Pick<AiSettings, 'media'> | null | undefined

function usableKeyConfig(
  settings: MediaSettings,
  id: unknown,
): { provider: AiMediaKeyProviderId; config: AiMediaProviderConfig } | null {
  const meta = AI_MEDIA_PROVIDERS.find((m) => m.id === id)
  if (!meta || !providerHasCapability(meta, 'image')) return null
  const provider = meta.id as AiMediaKeyProviderId
  const config = settings?.media?.providers?.[provider]
  if (!mediaConfigUsable(meta, config)) return null
  // custom endpoints ship no default image model: without one there is nothing to request
  if (!(config!.imageModel?.trim() || meta.defaultImageModel)) return null
  return { provider, config: config! }
}

/** Key providers able to generate an image right now, in catalog order */
export function configuredImageKeyProviders(settings: MediaSettings): AiMediaKeyProviderId[] {
  return AI_MEDIA_PROVIDERS.flatMap((meta) => {
    const usable = usableKeyConfig(settings, meta.id)
    return usable ? [usable.provider] : []
  })
}

/**
 * The image selection as the UI shows it. A removed, unknown or image-less
 * stored id reads as the default, and the default (the Codex subscription)
 * reads as `none` in a build without Codex image generation.
 */
export function imageProviderSelection(
  settings: MediaSettings,
  available: boolean = codexImageGenerationAvailable(),
): AiImageProviderSelection {
  const stored: unknown = settings?.media?.imageProvider
  if (stored === 'none') return 'none'
  const key = AI_MEDIA_PROVIDERS.find((m) => m.id === stored)
  if (key && providerHasCapability(key, 'image')) return key.id
  const selection = stored === 'codex' ? 'codex' : DEFAULT_AI_IMAGE_PROVIDER
  return selection === 'codex' && !available ? 'none' : selection
}

/**
 * The backend for a request that is about to start:
 *
 * 1. the selected backend, when it can run;
 * 2. otherwise the other kind: a configured key provider for a selected Codex,
 *    Codex for a selected key provider;
 * 3. otherwise any configured key provider; several are tried in catalog order.
 *
 * Codex generates only on a `ready` subscription, never on a `metered` login
 * (accepted or not): paying per image is what the key providers are for.
 * `none` selected means no preference, which starts at step 2 with Codex first.
 */
export function resolveImageBackend(
  settings: MediaSettings,
  context: AiImageBackendContext = {},
): AiImageBackend {
  const available = context.codexImageAvailable ?? codexImageGenerationAvailable()
  const codexUsable = available && context.codex?.state === 'ready'
  const selection = imageProviderSelection(settings, true)
  if (selection === 'codex' && codexUsable) return { kind: 'codex' }
  if (selection !== 'codex' && selection !== 'none') {
    const selected = usableKeyConfig(settings, selection)
    if (selected) return { kind: 'key', ...selected }
  }
  if (selection !== 'codex' && codexUsable) return { kind: 'codex' }
  const first = configuredImageKeyProviders(settings)[0]
  const fallback = first ? usableKeyConfig(settings, first) : null
  return fallback ? { kind: 'key', ...fallback } : { kind: 'none' }
}
