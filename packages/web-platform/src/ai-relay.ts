/**
 * AI on the web (seuoffice decision 0017): the page holds no gateway token and
 * reaches no gateway. It runs the desktop's own `gateway` provider, whose
 * requests go through the embed channel to the host instead of the network;
 * the host adds its token, calls its gateway and streams the SSE bytes back.
 * The parser, tool-call assembly and error handling are the desktop's code.
 */
// the provider files by path: the package's main entry pulls in desktop-only modules
import { setAiFetch } from '../../ai-provider/src/fetch'
import { setGatewayTokenProvider } from '../../ai-provider/src/protocols/gateway-complete'
import { defaultAiSettings, maxOutputTokensOf } from '../../ai-provider/src/providers'
import { AiRunError, aiStreamErrorFields } from '../../ai-provider/src/run-error'
import { streamForProvider } from '../../ai-provider/src/stream'
import type { AiSettings, AiStreamChunk, AiStreamRequest } from '../../ai-provider/src/types'
import { receiveOpen, requestAiFromHost } from './embed-channel'

/**
 * The gateway address the page's settings name. `.invalid` never resolves, so
 * nothing addressed here can leave the page except through the host.
 */
export const HOST_AI_BASE_URL = 'https://embed-host.invalid/'
const HOST_AI_ENDPOINT = `${HOST_AI_BASE_URL}chat/completions`

/**
 * The protocol refuses to send without a token. The real one stays with the
 * host; this stand-in only reaches the request's Authorization header, which
 * the channel drops.
 */
const PAGE_TOKEN = 'held-by-the-embed-host'

/** The fetch the AI provider uses on the page: its gateway request goes to the host */
export async function hostAiFetch(url: string, init?: RequestInit): Promise<Response> {
  if (url !== HOST_AI_ENDPOINT || init?.method !== 'POST' || typeof init.body !== 'string') {
    throw new TypeError(`seuoffice web: AI requests go only to the embed host, not ${url}`)
  }
  return requestAiFromHost(JSON.parse(init.body), init.signal)
}

/** Whether the host that opened this page offers AI */
export async function hostOffersAi(): Promise<boolean> {
  return (await receiveOpen())?.ai === true
}

/**
 * The AI settings the web bridges report: the gateway selected and configured
 * when the host offers AI, otherwise the defaults (nothing connected).
 */
export async function webAiSettings(): Promise<AiSettings> {
  const settings = defaultAiSettings()
  if (!(await hostOffersAi())) return settings
  return {
    ...settings,
    provider: 'gateway',
    providers: {
      ...settings.providers,
      gateway: { ...settings.providers.gateway, baseUrl: HOST_AI_BASE_URL },
    },
  }
}

export interface AiStreamBridge {
  aiStream(request: AiStreamRequest): Promise<void>
  aiStreamCancel(requestId: string): Promise<void>
  onAiStream(handler: (chunk: AiStreamChunk) => void): () => void
}

/**
 * The bridge trio the desktop preload exposes for `ai:stream`, run in the page:
 * each request streams through the `gateway` provider and its chunks reach the
 * `onAiStream` handlers, like the main process's handler sends them.
 */
export function createAiStreamBridge(): AiStreamBridge {
  setAiFetch(hostAiFetch)
  setGatewayTokenProvider(() => PAGE_TOKEN)
  const handlers = new Set<(chunk: AiStreamChunk) => void>()
  const running = new Map<string, AbortController>()
  const send = (chunk: AiStreamChunk): void => {
    for (const handler of handlers) handler(chunk)
  }

  return {
    async aiStream(request) {
      const { requestId } = request
      if (!(await hostOffersAi())) {
        const refusal = new AiRunError('not-connected', 'AI is not connected: the host offers none')
        send({ requestId, type: 'error', error: refusal.message, ...aiStreamErrorFields(refusal) })
        return
      }
      const controller = new AbortController()
      running.set(requestId, controller)
      // the gateway entry supplies only the model hint; the address is the host's
      const hint = request.settings.providers?.gateway?.model ?? ''
      try {
        let stopReason: string | undefined
        await streamForProvider(
          'gateway',
          { apiKey: '', model: hint, baseUrl: HOST_AI_BASE_URL },
          request.system,
          request.messages,
          request.tools ?? [],
          request.maxTokens ?? maxOutputTokensOf(request.settings),
          {
            signal: controller.signal,
            onDelta: (text) => send({ requestId, type: 'delta', text }),
            onReasoningDelta: (text) => send({ requestId, type: 'reasoning', text }),
            onToolCall: (toolCall) => send({ requestId, type: 'tool-call', toolCall }),
            onStopReason: (reason) => {
              stopReason = reason
            },
            onUsage: (usage) => send({ requestId, type: 'usage', usage }),
          },
        )
        send({ requestId, type: 'done', ...(stopReason !== undefined ? { stopReason } : {}) })
      } catch (err) {
        if (controller.signal.aborted) send({ requestId, type: 'done' })
        else {
          send({
            requestId,
            type: 'error',
            error: err instanceof Error ? err.message : String(err),
            ...aiStreamErrorFields(err),
          })
        }
      } finally {
        running.delete(requestId)
      }
    },
    async aiStreamCancel(requestId) {
      running.get(requestId)?.abort()
    },
    onAiStream(handler) {
      handlers.add(handler)
      return () => handlers.delete(handler)
    },
  }
}
