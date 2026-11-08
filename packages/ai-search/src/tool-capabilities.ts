/**
 * What the search and media tools can do right now, and through which kind
 * of route: for the CLI's capabilities command and for the editors deciding
 * which tools to offer the model. It asks the same routing functions the
 * tools start a request with, so the report follows the settings, the
 * connection statuses the caller passes and, on the automatic-call path, the
 * subscription setting. It does not look at the ledger of automatic calls,
 * which only counts them (headlessSubscriptionUsage reports the count).
 */

import { normalizeAiSettings, type AiSettings } from '@genoffice/ai-provider'
import { selectedSearchKey } from './search-tools'
import {
  SCREEN_TOOL_CONTEXT,
  imageGenerationUnavailableMessage,
  resolveImageAnalysisRoute,
  resolveImageRoute,
  resolveVideoAnalysisRoute,
  type AiToolCallContext,
} from './tool-routing'

/** `free` needs no account; `key` is billed to the user per request; `subscription` runs on a CLI login's plan */
export type AiToolRouteKind = 'free' | 'key' | 'subscription'

export interface AiToolCapability {
  available: boolean
  /** null when unavailable */
  route: AiToolRouteKind | null
  /** who answers: a search backend, a media key provider, `codex`, or the chat provider's id; null when unavailable */
  provider: string | null
  /** the route is a metered CLI login the user accepted: reported as `key`, because it is billed like one */
  metered?: true
  /** unavailable only: what the tool itself answers, including where to connect or configure */
  message?: string
}

export interface AiToolCapabilities {
  webSearch: AiToolCapability
  imageSearch: AiToolCapability
  imageGeneration: AiToolCapability
  /** analyze_media on images */
  imageAnalysis: AiToolCapability
  /** analyze_media on video and audio */
  videoAnalysis: AiToolCapability
}

const unavailable = (message: string): AiToolCapability => ({
  available: false,
  route: null,
  provider: null,
  message,
})

const via = (route: AiToolRouteKind, provider: string): AiToolCapability => ({
  available: true,
  route,
  provider,
})

/**
 * `settings` may be anything a settings file held (readAiSettingsFile's
 * result included): removed and unknown selections read as their defaults.
 * A caller that passes no context is the screen path with no subscription
 * connected.
 */
export function aiToolCapabilities(
  settings: AiSettings | null | undefined,
  context: AiToolCallContext = SCREEN_TOOL_CONTEXT,
): AiToolCapabilities {
  const resolved = normalizeAiSettings(settings ?? undefined)

  // the same answer the search tools route on: the selected key provider, or the keyless chain
  const search = selectedSearchKey(resolved)?.provider
  // only Serper and Serply have an image endpoint; every other selection searches images for free
  const imageSearchKeyed = search === 'serper' || search === 'serply'

  const image = resolveImageRoute(resolved, context)
  const analysis = resolveImageAnalysisRoute(resolved, context)
  const video = resolveVideoAnalysisRoute(resolved)

  return {
    webSearch: search ? via('key', search) : via('free', 'parallel'),
    imageSearch: imageSearchKeyed ? via('key', search) : via('free', 'duckduckgo'),
    imageGeneration:
      image.kind === 'none'
        ? unavailable(imageGenerationUnavailableMessage(resolved, context))
        : image.kind === 'codex'
          ? via('subscription', 'codex')
          : via('key', image.provider),
    imageAnalysis:
      analysis.kind === 'none'
        ? unavailable(analysis.message)
        : analysis.kind === 'key'
          ? via('key', analysis.provider)
          : analysis.billing === 'subscription'
            ? via('subscription', analysis.provider)
            : {
                ...via('key', analysis.provider),
                ...(analysis.billing === 'metered' ? { metered: true as const } : {}),
              },
    videoAnalysis: video.kind === 'none' ? unavailable(video.message) : via('key', video.provider),
  }
}
