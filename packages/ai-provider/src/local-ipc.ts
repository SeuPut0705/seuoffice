// The three `ai:local-*` calls of the local AI card, behind one entry point.
//
// The main process registers them as one-liners; this file owns the validation
// of payloads that arrive from the renderer, so the rules are covered by unit
// tests instead of a handler buried in `docs-main.ts`. A malformed payload is
// an ordinary answer, not an incident: discovery and inspection report `shape`,
// the connection test reports every check skipped with `inputError: 'shape'`,
// and no request is sent either way.
//
// A connection test may carry a `testId`; `ai:local-test-cancel` with the same
// id (from the same window) aborts it in this process, so closing the card or
// moving to another server ends the requests, not only the wait for them.
import type {
  AiLocalDiscoveryRequest,
  AiLocalDiscoveryResult,
  AiLocalInspectionRequest,
  AiLocalInspectionResult,
  AiLocalServerKind,
} from './local-models'
import { inspectLocalModel, listLocalModels } from './local-models'
import type { AiLocalTestInput, AiLocalTestResult } from './local-test'
import { testLocalModel } from './local-test'
import {
  DEFAULT_LOCAL_TIMEOUT_MS,
  MAX_LOCAL_MODEL_ID_LENGTH,
  localTimeoutMsOf,
} from './local-profile'

/** the IPC layer's string limits, repeated here so a direct caller gets the same answer */
const MAX_BASE_URL_LENGTH = 2048
const MAX_API_KEY_LENGTH = 8192

/** A validated discovery payload: the same shape `listLocalModels` takes. */
export type AiLocalDiscoveryIpcInput = AiLocalDiscoveryRequest
/** A validated inspection payload: the same shape `inspectLocalModel` takes. */
export type AiLocalInspectionIpcInput = AiLocalInspectionRequest
/** A validated connection-test payload, with the budget already resolved. */
export interface AiLocalTestIpcInput extends AiLocalTestInput {
  timeoutMs: number
  /** the renderer's handle for cancelling this test; absent means it cannot be cancelled by id */
  testId?: string
}

/** A test id: short and plain, so it is only ever a lookup key. */
const TEST_ID_RE = /^[A-Za-z0-9_-]{1,128}$/

function testIdOf(raw: unknown): string | undefined {
  return typeof raw === 'string' && TEST_ID_RE.test(raw) ? raw : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * The address the user typed, with trailing slashes intact (the probe
 * normalizes them): a bounded `http(s)` URL, or undefined for anything else.
 * `localhost:11434` is not a URL and is rejected rather than guessed at.
 */
function baseUrlOf(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  if (!trimmed || trimmed.length > MAX_BASE_URL_LENGTH) return undefined
  try {
    const url = new URL(trimmed)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    return trimmed
  } catch {
    return undefined
  }
}

/** The optional key: absent and blank are both "no key", anything not a string is invalid. */
function apiKeyOf(raw: Record<string, unknown>): { ok: true; apiKey?: string } | { ok: false } {
  const value = raw.apiKey
  if (value !== undefined && typeof value !== 'string') return { ok: false }
  const key = typeof value === 'string' ? value.trim() : ''
  if (key.length > MAX_API_KEY_LENGTH) return { ok: false }
  return key ? { ok: true, apiKey: key } : { ok: true }
}

/** A model id: the exact string the server listed, trimmed and bounded. */
function modelIdOf(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const model = raw.trim()
  if (!model || model.length > MAX_LOCAL_MODEL_ID_LENGTH) return undefined
  return model
}

/** The two wire shapes a local server can have; anything else is invalid input. */
function serverKindOf(raw: unknown): AiLocalServerKind | undefined {
  return raw === 'ollama' || raw === 'openai-compatible' ? raw : undefined
}

/** The address and key every local call shares, or undefined when either is bad. */
function baseFieldsOf(
  raw: Record<string, unknown>,
): { baseUrl: string; apiKey?: string } | undefined {
  const baseUrl = baseUrlOf(raw.baseUrl)
  if (!baseUrl) return undefined
  const key = apiKeyOf(raw)
  if (!key.ok) return undefined
  return key.apiKey ? { baseUrl, apiKey: key.apiKey } : { baseUrl }
}

/** A validated `{ baseUrl, apiKey? }`, or undefined when the payload is not one. */
export function parseLocalDiscoveryInput(raw: unknown): AiLocalDiscoveryIpcInput | undefined {
  if (!isRecord(raw)) return undefined
  return baseFieldsOf(raw)
}

/** A validated `{ baseUrl, apiKey?, model, server? }`, or undefined. */
export function parseLocalInspectionInput(raw: unknown): AiLocalInspectionIpcInput | undefined {
  if (!isRecord(raw)) return undefined
  const fields = baseFieldsOf(raw)
  if (!fields) return undefined
  const model = modelIdOf(raw.model)
  if (!model) return undefined
  // an explicit but unknown kind is invalid; an absent one means "probe once"
  if (raw.server !== undefined && serverKindOf(raw.server) === undefined) return undefined
  const server = serverKindOf(raw.server)
  return { ...fields, model, ...(server ? { server } : {}) }
}

/**
 * A validated `{ baseUrl, apiKey?, model, timeoutMs }`, or undefined. The
 * timeout is a whole number of milliseconds inside 60s–600s; absent takes the
 * default 300s. It is not clamped: a value the settings contract does not allow
 * means the caller built the payload wrong.
 */
export function parseLocalTestInput(raw: unknown): AiLocalTestIpcInput | undefined {
  if (!isRecord(raw)) return undefined
  const fields = baseFieldsOf(raw)
  if (!fields) return undefined
  const model = modelIdOf(raw.model)
  if (!model) return undefined
  if (raw.typed !== undefined && typeof raw.typed !== 'boolean') return undefined
  const timeoutMs =
    raw.timeoutMs === undefined ? DEFAULT_LOCAL_TIMEOUT_MS : localTimeoutMsOf(raw.timeoutMs)
  if (timeoutMs === undefined) return undefined
  if (raw.testId !== undefined && testIdOf(raw.testId) === undefined) return undefined
  const testId = testIdOf(raw.testId)
  return {
    ...fields,
    model,
    ...(raw.typed === true ? { typed: true } : {}),
    timeoutMs,
    ...(testId ? { testId } : {}),
  }
}

/** The connection test's answer for a payload it cannot run: nothing was sent. */
function skippedTestResult(): AiLocalTestResult {
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

/** `ai:local-models` behind an `unknown` IPC payload. */
export async function listLocalModelsForIpc(input: unknown): Promise<AiLocalDiscoveryResult> {
  const parsed = parseLocalDiscoveryInput(input)
  if (!parsed) return { ok: false, errorCode: 'shape' }
  return listLocalModels(parsed)
}

/** `ai:local-inspect` behind an `unknown` IPC payload. */
export async function inspectLocalModelForIpc(input: unknown): Promise<AiLocalInspectionResult> {
  const parsed = parseLocalInspectionInput(input)
  if (!parsed) return { ok: false, errorCode: 'shape' }
  return inspectLocalModel(parsed)
}

/** Who started a test (the sender's id): one window cannot cancel another's test. */
export type AiLocalTestOwner = string | number

export interface AiLocalTestIpcOptions {
  /** the sender; tests are cancelled by owner and id together */
  owner?: AiLocalTestOwner | undefined
  /** aborted by the main process itself (the window that asked was closed) */
  signal?: AbortSignal | undefined
}

/** tests in flight in this process, by owner and test id */
const runningTests = new Map<string, AbortController>()

function testKeyOf(owner: AiLocalTestOwner | undefined, testId: string): string {
  return JSON.stringify([owner ?? null, testId])
}

/** `ai:local-test` behind an `unknown` IPC payload. */
export async function testLocalModelForIpc(
  input: unknown,
  options?: AiLocalTestIpcOptions,
): Promise<AiLocalTestResult> {
  const parsed = parseLocalTestInput(input)
  if (!parsed) return skippedTestResult()
  const { testId, ...test } = parsed
  const controller = new AbortController()
  const outer = options?.signal
  const onOuterAbort = () => controller.abort()
  if (outer?.aborted) controller.abort()
  else outer?.addEventListener('abort', onOuterAbort, { once: true })
  const key = testId ? testKeyOf(options?.owner, testId) : undefined
  if (key) {
    // the same id again replaces the earlier test, which then has no handle left
    runningTests.get(key)?.abort()
    runningTests.set(key, controller)
  }
  try {
    return await testLocalModel(test, { signal: controller.signal })
  } finally {
    outer?.removeEventListener('abort', onOuterAbort)
    if (key && runningTests.get(key) === controller) runningTests.delete(key)
  }
}

/**
 * `ai:local-test-cancel`: abort the test this owner started with this id.
 * True when a running test was found; an unknown, finished or malformed id is
 * false and does nothing.
 */
export function cancelLocalTestForIpc(input: unknown, owner?: AiLocalTestOwner): boolean {
  const testId = testIdOf(isRecord(input) ? input.testId : input)
  if (!testId) return false
  const key = testKeyOf(owner, testId)
  const controller = runningTests.get(key)
  if (!controller) return false
  runningTests.delete(key)
  controller.abort()
  return true
}
