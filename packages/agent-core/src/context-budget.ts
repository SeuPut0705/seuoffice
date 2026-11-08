import type { AgentMessage, AgentToolDef } from './types'

/**
 * Share of the model's context window at which a request is confirmed with the
 * person first. Tunable: a higher value asks less often and risks a hard
 * provider rejection, a lower one asks earlier.
 */
export const CONTEXT_WARNING_RATIO = 0.8

/**
 * Context assumed for a model whose window was never reported. Conservative on
 * purpose: a request that fits here fits anywhere. Mirrors ai-provider's
 * DEFAULT_LOCAL_CONTEXT_TOKENS (this package cannot depend on it).
 */
export const CONTEXT_ASSUMED_TOKENS = 4096

/** A prompt close to its context window, as the confirmation dialog reads it */
export interface ContextWarning {
  estimatedTokens: number
  contextTokens: number
  /** estimatedTokens / contextTokens, unclamped: above 1 means it cannot fit */
  ratio: number
  /** false when contextTokens is an assumption, not a reported size */
  known: boolean
}

/** ASCII reads at four characters per token */
const ASCII_CHARS_PER_TOKEN = 4
/** Everything else (CJK, Hangeul, Cyrillic …) at 1.5 characters per token */
const OTHER_CHARS_PER_TOKEN = 1.5

interface CharCounts {
  ascii: number
  other: number
}

function addText(counts: CharCounts, text: string | undefined): void {
  if (!text) return
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) < 0x80) counts.ascii++
    else counts.other++
  }
}

function addJson(counts: CharCounts, value: unknown): void {
  try {
    addText(counts, JSON.stringify(value))
  } catch {
    // a circular value could never be serialized for a provider either
  }
}

function addMessage(counts: CharCounts, message: AgentMessage): void {
  if (message.role === 'tool') {
    for (const result of message.results) addText(counts, result.output)
    return
  }
  addText(counts, message.text)
  if (message.role === 'assistant' && message.toolCalls) {
    for (const call of message.toolCalls) addJson(counts, call.input)
  }
  // Images are billed as image tokens, not as base64 characters: counting the
  // characters would be wrong by orders of magnitude in both directions. The
  // estimate is therefore a floor for a prompt that carries images.
}

/**
 * Rough token count of one model request, without tokenizer dependencies:
 * ASCII at 4 characters per token and every other character at 1.5, rounded up
 * once for the whole prompt. Tool definitions, tool-call arguments and tool
 * results count because they are sent on every turn of a tool loop.
 */
export function estimatePromptTokens(
  system: string,
  messages: readonly AgentMessage[],
  tools: readonly AgentToolDef[],
): number {
  const counts: CharCounts = { ascii: 0, other: 0 }
  addText(counts, system)
  for (const message of messages) addMessage(counts, message)
  for (const tool of tools) {
    addText(counts, tool.name)
    addText(counts, tool.description)
    addJson(counts, tool.inputSchema)
  }
  return Math.ceil(counts.ascii / ASCII_CHARS_PER_TOKEN + counts.other / OTHER_CHARS_PER_TOKEN)
}

/**
 * The confirmation a request needs before it is sent, or undefined when it may
 * go. A limit that is not a positive number falls back to the assumed 4096 and
 * is reported as unknown, so the dialog never claims a size nobody gave.
 */
export function contextWarningFor(
  system: string,
  messages: readonly AgentMessage[],
  tools: readonly AgentToolDef[],
  limit: number,
  known: boolean,
): ContextWarning | undefined {
  const reported = Number.isFinite(limit) && limit > 0
  const contextTokens = reported ? limit : CONTEXT_ASSUMED_TOKENS
  const estimatedTokens = estimatePromptTokens(system, messages, tools)
  const ratio = estimatedTokens / contextTokens
  if (ratio < CONTEXT_WARNING_RATIO) return undefined
  return {
    estimatedTokens,
    contextTokens,
    ratio,
    known: known && reported,
  }
}
