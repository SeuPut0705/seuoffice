/**
 * `gateway-complete` (seuoffice decision 0008): an HTTP gateway that speaks the
 * OpenAI chat-completions request and SSE shape, authenticated with the
 * caller's token. The token is asked for on every request and goes only into
 * that request's Authorization header: it is never part of the settings, so
 * it cannot reach ai-settings.json, and it is not put in error messages.
 */
import type { AgentMessage, AgentToolDef } from '@genoffice/agent-core'
import { AiRunError } from '../run-error'
import type { AiChatResponse, AiProviderConfig } from '../types'
import type { StreamWatchdog } from '../watchdog'
import { chatOpenAiCompatible, streamOpenAiCompatible } from './openai-compatible'
import type { StreamCallbacks } from './shared'

/** Hands over the token for one request; an empty string means there is none */
export type GatewayTokenProvider = (signal: AbortSignal | undefined) => string | Promise<string>

/** The environment variable the default provider reads, on every request */
export const GATEWAY_TOKEN_ENV = 'SEUOFFICE_AI_GATEWAY_TOKEN'

const envTokenProvider: GatewayTokenProvider = () =>
  (typeof process === 'undefined' ? undefined : process.env[GATEWAY_TOKEN_ENV]) ?? ''

let tokenProvider: GatewayTokenProvider = envTokenProvider

/** Registers the process's token provider; null restores the environment variable */
export function setGatewayTokenProvider(next: GatewayTokenProvider | null): void {
  tokenProvider = next ?? envTokenProvider
}

/** The request's config with this request's token in place of any key */
async function withRequestToken(
  config: AiProviderConfig,
  baseUrl: string,
  signal: AbortSignal | undefined,
): Promise<AiProviderConfig> {
  if (!baseUrl)
    throw new AiRunError('not-connected', 'The AI gateway has no URL: set it in Settings')
  const token = (await tokenProvider(signal)).trim()
  if (!token) {
    throw new AiRunError('not-connected', 'The AI gateway has no token for this request')
  }
  return { ...config, apiKey: token }
}

export async function streamGatewayComplete(
  baseUrl: string,
  config: AiProviderConfig,
  system: string,
  messages: AgentMessage[],
  tools: AgentToolDef[],
  maxTokens: number,
  cb: StreamCallbacks,
  options: { timeoutMs?: number | undefined } = {},
): Promise<void> {
  const authorized = await withRequestToken(config, baseUrl, cb.signal)
  return streamOpenAiCompatible(
    baseUrl,
    authorized,
    system,
    messages,
    tools,
    maxTokens,
    cb,
    options,
  )
}

export async function chatGatewayComplete(
  wd: StreamWatchdog,
  baseUrl: string,
  config: AiProviderConfig,
  system: string,
  user: string,
): Promise<AiChatResponse> {
  let authorized: AiProviderConfig
  try {
    authorized = await withRequestToken(config, baseUrl, wd.signal)
  } catch (e) {
    // like the other config errors of a one-shot call: a failed reply, not a rejection
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
  return chatOpenAiCompatible(wd, baseUrl, authorized, system, user)
}
