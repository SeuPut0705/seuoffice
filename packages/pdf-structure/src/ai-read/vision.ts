/**
 * Can this provider and model read a page image (spec boundary rules: a model
 * without image input does not start AI reading)? The provider's declared
 * vision flag, then ai-provider's `modelLacksVision` for text-only models
 * under a vision-capable provider.
 */
import { getProviderAdapter, modelLacksVision } from '../../../ai-provider/src/registry'
import type { AiProviderSelection } from '../../../ai-provider/src/types'

export type AiReadVisionCheck =
  | { ok: true }
  | {
      ok: false
      /**
       * unknown-provider: not a registered provider id ('auto' must be
       * resolved first); provider-without-vision: the provider takes no
       * images; model-without-vision: this model of it takes no images
       */
      reason: 'unknown-provider' | 'provider-without-vision' | 'model-without-vision'
    }

/** pure: provider id + model id → whether a page image can be sent */
export function aiReadVisionCheck(provider: string, model: string): AiReadVisionCheck {
  if (provider === 'auto') return { ok: false, reason: 'unknown-provider' }
  let vision: boolean
  try {
    vision = getProviderAdapter(provider as AiProviderSelection).capabilities.vision
  } catch {
    return { ok: false, reason: 'unknown-provider' }
  }
  if (!vision) return { ok: false, reason: 'provider-without-vision' }
  if (modelLacksVision(model)) return { ok: false, reason: 'model-without-vision' }
  return { ok: true }
}
