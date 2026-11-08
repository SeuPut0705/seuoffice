import { headlessSubscriptionOn } from '@genoffice/ai-provider'
import {
  aiToolCapabilities,
  headlessSubscriptionUsage,
  type AiToolCapability,
} from '@genoffice/ai-search'
import { headlessCall } from '../cloud'
import { pdfAiFeature, resolvePdfAiRoute } from '../pdf-ai'
import type { CommandDef } from '../registry'
import { appLaunch } from '../resources'
import { wasmAvailability } from '../wasm'

/** `media_analysis` repeats one of the two analysis entries, so the summary leaves it out */
const SUMMARIZED = [
  'search',
  'image_search',
  'image_generation',
  'image_analysis',
  'video_analysis',
  'pdf_ai_read',
  'pdf_translation',
  'wasm',
  'app',
] as const

/**
 * What the cloud commands can do on this machine, decided from GenOffice's
 * own settings without a network call and without asking a model: the routes
 * the search / image / media commands would start on as the automatic-call
 * path they are (the free search, a key the user entered, or a subscription
 * login once the user allowed that for the command line). Agents check this
 * once before planning work that needs photos or web facts.
 */
export const capabilitiesCommand: CommandDef = {
  name: 'capabilities',
  summary:
    'Report which cloud features (search, image search, image generation, image and video analysis, PDF AI page reading and translation) are available in GenOffice and by which route, and whether the app is installed.',
  usage: 'capabilities',
  async run(_args, ctx) {
    const { settingsPath, settings, context } = await headlessCall(ctx.env, 'capabilities')
    const caps = aiToolCapabilities(settings, context)
    const subscription = headlessSubscriptionOn(settings)
    // counted only while the setting is on; off, no subscription request is made
    const usage = subscription ? headlessSubscriptionUsage(context.dataDir) : null
    const imageAnalysis = feature(caps.imageAnalysis)
    const videoAnalysis = feature(caps.videoAnalysis)
    const wasm = wasmAvailability()
    const detail = {
      search: feature(caps.webSearch),
      image_search: feature(caps.imageSearch),
      image_generation: feature(caps.imageGeneration),
      // the `media` command as a whole: images when they can be read, otherwise video and audio
      media_analysis:
        imageAnalysis.available || !videoAnalysis.available ? imageAnalysis : videoAnalysis,
      image_analysis: imageAnalysis,
      video_analysis: videoAnalysis,
      // the PDF document jobs: the AI provider the chat runs on (page reading needs one that reads images)
      pdf_ai_read: pdfAiFeature(resolvePdfAiRoute(settings, context, 'ai-read')),
      pdf_translation: pdfAiFeature(resolvePdfAiRoute(settings, context, 'translate')),
      automatic_calls: {
        subscription_enabled: subscription,
        // there is no hourly cap: the count of the last hour is information only
        ...(usage ? { used: usage.used, limit: null, remaining: null } : {}),
      },
      app: { available: appLaunch(ctx.env) !== null },
      // what the PDF, Hangul and network engines need; a virtual-memory cap that
      // cannot host a WebAssembly memory turns them off for the whole process
      wasm: {
        available: wasm.available,
        ...(wasm.reason ? { reason: wasm.reason } : {}),
        ...(wasm.limit_bytes ? { limit_bytes: wasm.limit_bytes } : {}),
      },
      settings_path: settingsPath,
    }
    const on = SUMMARIZED.filter((name) => detail[name].available)
    const off = SUMMARIZED.filter((name) => !detail[name].available)
    return {
      summary: [
        ...(on.length ? [`available: ${on.join(', ')}`] : []),
        ...(off.length ? [`unavailable: ${off.join(', ')}`] : []),
      ].join('; '),
      detail,
    }
  },
}

interface Feature {
  available: boolean
  /** who answers: a search backend, a key provider, `codex`, or the AI provider the chat runs on */
  via: string | null
  /** how it is paid for: `free`, `key` or `subscription` */
  route: AiToolCapability['route']
  /** a metered CLI login the user accepted: billed like a key, and reported as one */
  metered?: true
  /** unavailable only: the text the command itself answers with */
  message?: string
}

function feature(capability: AiToolCapability): Feature {
  return {
    available: capability.available,
    via: capability.provider,
    route: capability.route,
    ...(capability.metered ? { metered: true as const } : {}),
    ...(capability.message ? { message: capability.message } : {}),
  }
}
