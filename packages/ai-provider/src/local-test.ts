// The four-step connection test of the local AI card. A user has just typed an
// address, so silence, a refusal or a model that cannot call tools are ordinary
// answers, not incidents: this file never throws and never rejects.
//
// The test only asks "is something usable here". It sends fixed probe prompts —
// no document, attachment or user conversation — and it observes the single
// fake tool call without executing it or handing it to the app.
import type { AgentMessage, AgentToolCall, AgentToolDef } from '@genoffice/agent-core'
import { listLocalModels, type AiLocalModelSummary } from './local-models'
import {
  DEFAULT_LOCAL_TIMEOUT_MS,
  MAX_LOCAL_MODEL_ID_LENGTH,
  MAX_LOCAL_TIMEOUT_MS,
  MIN_LOCAL_TIMEOUT_MS,
} from './local-profile'
import { isAiNetworkError } from './network-error'
import { chatOpenAiCompatible, streamOpenAiCompatible } from './protocols/openai-compatible'
import { ResponseBodyTooLargeError, type StreamCallbacks } from './protocols/shared'
import type { AiProviderConfig } from './types'
import { AiTimeoutError, createStreamWatchdog } from './watchdog'

export type AiLocalCheckStatus = 'pass' | 'fail' | 'skip'

/**
 * Why a check did not pass:
 * `unreachable` nothing answered, `timeout` the budget ran out, `http` a route
 * refused the request, `shape` the answer was not an OpenAI-compatible body,
 * `model-missing` the server does not list the chosen model, `no-chat` the
 * model returned no text, `no-tool-call` the model did not call the probe tool.
 */
export type AiLocalCheckCode =
  'unreachable' | 'timeout' | 'http' | 'shape' | 'model-missing' | 'no-chat' | 'no-tool-call'

export interface AiLocalCheck {
  status: AiLocalCheckStatus
  code?: AiLocalCheckCode | undefined
}

export interface AiLocalTestResult {
  server: AiLocalCheck
  model: AiLocalCheck
  chat: AiLocalCheck
  tools: AiLocalCheck
  /** epoch milliseconds when the test started */
  checkedAt: number
  elapsedMs: number
  /** the server's list, when the server check read it */
  models?: AiLocalModelSummary[] | undefined
  /** which wire shape answered the list probe */
  serverKind?: 'ollama' | 'openai-compatible' | undefined
  /** invalid input: every check is skip and no request was sent */
  inputError?: 'shape' | undefined
  /**
   * the caller cancelled the test: the request in flight was aborted, nothing
   * more was sent, and every check that had not answered yet is skip
   */
  cancelled?: true | undefined
}

/** What a caller in the main process (never the IPC payload) may add to a test. */
export interface AiLocalTestOptions {
  /** aborting it ends the request in flight and sends no further check */
  signal?: AbortSignal | undefined
}

export interface AiLocalTestInput {
  /** the address the user typed; an OpenAI-compatible base normally ends in `/v1` */
  baseUrl: string
  /** sent as `Authorization: Bearer …` only when non-empty */
  apiKey?: string | undefined
  /** the model the card picked */
  model: string
  /**
   * true when the user typed the model id instead of picking one from the
   * server's list. A typed id that the list does not contain is unknown, not
   * missing: skip that check and let chat/tools decide.
   */
  typed?: boolean | undefined
  /** the total budget for all four checks (clamped to 60s–600s) */
  timeoutMs?: number | undefined
}

/** the IPC layer's string limits, repeated so a direct caller gets the same answer */
const MAX_BASE_URL_LENGTH = 2048
const MAX_API_KEY_LENGTH = 8192

/**
 * Fixed probe text. These are constants on purpose: the connection test must
 * never carry a document, an attachment or a conversation.
 */
const CHECK_SYSTEM_PROMPT =
  'You are answering a connection test of an AI server. The test only checks that this chat works. Reply briefly.'
const CHAT_USER_PROMPT = 'ping'
const TOOL_USER_PROMPT = 'Run the ieumoffice_probe tool now with ok set to true.'

/** enough for a short greeting; a local model may still be warming up */
const CHAT_MAX_TOKENS = 32
/** deep enough for a thinking model to finish the one small call */
const TOOL_MAX_TOKENS = 128

/**
 * The single fake tool the tool check offers. It is not registered anywhere and
 * the call is only observed, so the model cannot make the app do anything.
 */
const PROBE_TOOL: AgentToolDef = {
  name: 'ieumoffice_probe',
  description: 'Connection probe. Call this once with {"ok": true} to confirm tool calling works.',
  inputSchema: {
    type: 'object',
    properties: { ok: { type: 'boolean' } },
    required: ['ok'],
    additionalProperties: false,
  },
}

interface ResolvedTestInput {
  baseUrl: string
  apiKey: string
  model: string
  typed: boolean
  timeoutMs: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function normalizedBaseOf(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim().replace(/\/+$/, '')
  if (!trimmed || trimmed.length > MAX_BASE_URL_LENGTH) return undefined
  try {
    const url = new URL(trimmed)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    return trimmed
  } catch {
    return undefined
  }
}

/** a total budget in the window the settings contract allows */
function timeoutOf(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_LOCAL_TIMEOUT_MS
  return Math.min(MAX_LOCAL_TIMEOUT_MS, Math.max(MIN_LOCAL_TIMEOUT_MS, Math.round(raw)))
}

/**
 * The typed input with every malformed field rejected. Undefined means the IPC
 * caller sent something the four checks cannot run against: no request is made.
 */
function resolveInput(raw: unknown): ResolvedTestInput | undefined {
  if (!isRecord(raw)) return undefined
  const baseUrl = normalizedBaseOf(raw.baseUrl)
  const model = typeof raw.model === 'string' ? raw.model.trim() : ''
  if (!baseUrl || !model || model.length > MAX_LOCAL_MODEL_ID_LENGTH) return undefined
  const rawKey = raw.apiKey
  if (rawKey !== undefined && typeof rawKey !== 'string') return undefined
  const apiKey = typeof rawKey === 'string' ? rawKey.trim() : ''
  if (apiKey.length > MAX_API_KEY_LENGTH) return undefined
  return { baseUrl, apiKey, model, typed: raw.typed === true, timeoutMs: timeoutOf(raw.timeoutMs) }
}

function skippedResult(): AiLocalTestResult {
  return {
    server: { status: 'skip' },
    model: { status: 'skip' },
    chat: { status: 'skip' },
    tools: { status: 'skip' },
    checkedAt: Date.now(),
    elapsedMs: 0,
    inputError: 'shape',
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The code a thrown request error stands for, or undefined when the error says
 * nothing about the four steps (a plain empty stream says "no tool call").
 */
function requestFailureCode(error: unknown, deadline: number): AiLocalCheckCode | undefined {
  if (error instanceof AiTimeoutError || Date.now() >= deadline) return 'timeout'
  if (isAiNetworkError(error)) return 'unreachable'
  const message = messageOf(error)
  if (/^HTTP \d{3}\b/.test(message)) return 'http'
  if (error instanceof ResponseBodyTooLargeError) return 'shape'
  if (/unparseable JSON|non-JSON response/i.test(message)) return 'shape'
  return undefined
}

/** the one-shot chat reports HTTP, malformed and empty answers in its result */
function chatFailureCode(error: string): AiLocalCheckCode {
  if (/^HTTP \d{3}\b/.test(error)) return 'http'
  if (/non-JSON response/i.test(error)) return 'shape'
  return 'no-chat'
}

async function runChatCheck(
  input: ResolvedTestInput,
  deadline: number,
  controller: AbortController,
): Promise<AiLocalCheck> {
  const remaining = deadline - Date.now()
  if (remaining <= 0) return { status: 'fail', code: 'timeout' }
  const config: AiProviderConfig = { apiKey: input.apiKey, model: input.model }
  const wd = createStreamWatchdog(controller.signal, remaining, remaining)
  try {
    const response = await wd.guard(() =>
      chatOpenAiCompatible(wd, input.baseUrl, config, CHECK_SYSTEM_PROMPT, CHAT_USER_PROMPT, {
        timeoutMs: remaining,
        maxTokens: CHAT_MAX_TOKENS,
        temperature: 0,
      }),
    )
    if (response.ok) {
      return response.content?.trim() ? { status: 'pass' } : { status: 'fail', code: 'no-chat' }
    }
    return { status: 'fail', code: chatFailureCode(response.error ?? '') }
  } catch (error) {
    return { status: 'fail', code: requestFailureCode(error, deadline) ?? 'unreachable' }
  }
}

async function runToolsCheck(
  input: ResolvedTestInput,
  deadline: number,
  controller: AbortController,
): Promise<AiLocalCheck> {
  const remaining = deadline - Date.now()
  if (remaining <= 0) return { status: 'fail', code: 'timeout' }
  const config: AiProviderConfig = { apiKey: input.apiKey, model: input.model }
  const messages: AgentMessage[] = [{ role: 'user', text: TOOL_USER_PROMPT }]
  let probeCalled = false
  const callbacks: StreamCallbacks = {
    signal: controller.signal,
    onDelta: () => undefined,
    // Observed only. Nothing executes the fake tool or forwards the call to the
    // application's tools; the name is the whole answer this check needs.
    onToolCall: (call: AgentToolCall) => {
      if (call.name === PROBE_TOOL.name) probeCalled = true
    },
  }
  try {
    await streamOpenAiCompatible(
      input.baseUrl,
      config,
      CHECK_SYSTEM_PROMPT,
      messages,
      [PROBE_TOOL],
      TOOL_MAX_TOKENS,
      callbacks,
      { timeoutMs: remaining, maxTokens: TOOL_MAX_TOKENS, temperature: 0 },
    )
    return probeCalled ? { status: 'pass' } : { status: 'fail', code: 'no-tool-call' }
  } catch (error) {
    if (probeCalled) return { status: 'pass' }
    return { status: 'fail', code: requestFailureCode(error, deadline) ?? 'no-tool-call' }
  }
}

/**
 * Runs the four checks against one model on one local server.
 *
 * One deadline (`timeoutMs`, default 300s, clamped to 60s–600s) covers the whole
 * test: each request gets the time that is left, and once none is left the
 * remaining checks answer `timeout` without sending anything. The server list
 * probe is `listLocalModels`, whose own per-request limit is short; the chat and
 * tool probes are the app's OpenAI-compatible transports, capped and at
 * temperature 0.
 *
 * Aborting `options.signal` cancels the test: the request in flight is
 * aborted, no further check is sent, and the result says `cancelled`.
 *
 * Never throws and never rejects. Malformed input returns `inputError: 'shape'`
 * with every check skipped.
 */
export async function testLocalModel(
  input: AiLocalTestInput,
  options?: AiLocalTestOptions,
): Promise<AiLocalTestResult> {
  const resolved = resolveInput(input)
  if (!resolved) return skippedResult()

  const startedAt = Date.now()
  const result: AiLocalTestResult = {
    server: { status: 'skip' },
    model: { status: 'skip' },
    chat: { status: 'skip' },
    tools: { status: 'skip' },
    checkedAt: startedAt,
    elapsedMs: 0,
  }
  const outer = options?.signal
  if (outer?.aborted) return { ...result, cancelled: true }

  const deadline = startedAt + resolved.timeoutMs
  const controller = new AbortController()
  let deadlineHit = false
  let cancelled = false
  const timer = setTimeout(() => {
    deadlineHit = true
    controller.abort()
  }, resolved.timeoutMs)
  // the card was closed or moved to another server: end the request in flight
  const onCancel = () => {
    cancelled = true
    controller.abort()
  }
  outer?.addEventListener('abort', onCancel, { once: true })

  const timedOut = () => deadlineHit || deadline - Date.now() <= 0
  /** a cancelled test keeps the answers it already had; the rest stay skip */
  const cancelledResult = (): AiLocalTestResult => {
    result.cancelled = true
    return result
  }

  try {
    if (timedOut()) {
      result.server = { status: 'fail', code: 'timeout' }
    } else {
      const listed = await listLocalModels(
        {
          baseUrl: resolved.baseUrl,
          ...(resolved.apiKey ? { apiKey: resolved.apiKey } : {}),
        },
        { signal: controller.signal },
      )
      if (cancelled) return cancelledResult()
      if (listed.ok) {
        result.server = { status: 'pass' }
        result.models = listed.models
        result.serverKind = listed.server
        if (listed.models.length === 0) {
          // an empty list cannot judge the model at all
          result.model = { status: 'skip' }
        } else if (listed.models.some((entry) => entry.id === resolved.model)) {
          result.model = { status: 'pass' }
        } else if (resolved.typed) {
          // the user typed this id; the server's list not naming it is not proof
          // that it is missing (the list may be partial or stale)
          result.model = { status: 'skip' }
        } else {
          result.model = { status: 'fail', code: 'model-missing' }
        }
      } else {
        // no list means this model cannot be judged; chat and tools still try
        result.server = { status: 'fail', code: listed.errorCode }
      }
    }

    const chat = timedOut()
      ? ({ status: 'fail', code: 'timeout' } as const)
      : await runChatCheck(resolved, deadline, controller)
    if (cancelled) return cancelledResult()
    result.chat = chat

    const tools = timedOut()
      ? ({ status: 'fail', code: 'timeout' } as const)
      : await runToolsCheck(resolved, deadline, controller)
    if (cancelled) return cancelledResult()
    result.tools = tools

    return result
  } catch {
    // Every expected failure is handled above; this keeps the "never throws"
    // promise even if a future edit grows an unexpected path. Answers already
    // given stay as they are.
    return cancelled ? cancelledResult() : result
  } finally {
    clearTimeout(timer)
    outer?.removeEventListener('abort', onCancel)
    result.elapsedMs = Math.max(0, Date.now() - startedAt)
  }
}
