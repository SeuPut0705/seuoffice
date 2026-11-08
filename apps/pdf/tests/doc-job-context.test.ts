/**
 * One confirmation per document job: every call of one `createModelCall` shares
 * a run id and its confirmation memory, while two factories (a single-call run
 * and a summary job, say) ask separately. A declined prompt sends nothing and
 * fails with `context-limit`; a later call of the same job does not ask again.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IpcStreamChunk } from '@genoffice/agent-core'
import { normalizeAiSettings, type AiSettings } from '@genoffice/ai-provider/browser'
import { createModelCall, ModelCallError } from '../src/renderer/doc-jobs/model-call'

/** ASCII text that estimates to exactly `tokens` tokens (4 ASCII characters per token) */
const ascii = (tokens: number): string => 'a'.repeat(tokens * 4)
const LARGE_PROMPT = ascii(90)

function localSettings(): AiSettings {
  const settings = normalizeAiSettings({})
  settings.provider = 'custom'
  settings.customEndpoint = 'loc'
  settings.customEndpoints = [
    {
      id: 'loc',
      name: 'Ollama',
      baseUrl: 'http://127.0.0.1:11434/v1',
      apiKey: '',
      model: 'qwen3:8b',
      kind: 'local',
      modelProfiles: { 'qwen3:8b': { contextLength: 100, tools: true } },
    },
  ]
  return settings
}

type Listener = (chunk: IpcStreamChunk) => void

function fakePdfApi(answer = 'ok') {
  const listeners = new Set<Listener>()
  const started: string[] = []
  let pending: string | null = null
  ;(window as unknown as { pdfApi: unknown }).pdfApi = {
    onAiStream: (listener: Listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    aiStream: async (request: { requestId: string }) => {
      started.push(request.requestId)
      pending = request.requestId
      setTimeout(() => {
        for (const listener of [...listeners]) {
          listener({ requestId: request.requestId, type: 'delta', text: answer })
          listener({ requestId: request.requestId, type: 'done' })
        }
        pending = null
      }, 0)
    },
    aiStreamCancel: async (requestId: string) => {
      if (pending === requestId) pending = null
    },
  }
  return { started }
}

const askOnce = (call: ReturnType<typeof createModelCall>) =>
  call({ system: LARGE_PROMPT, messages: [], tools: [] }, new AbortController().signal)

afterEach(() => {
  vi.restoreAllMocks()
})

describe('a document job model call', () => {
  it('asks once for every call of one job', async () => {
    const { started } = fakePdfApi('first')
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const call = createModelCall({
      settings: localSettings,
      lang: () => 'en',
      runId: 'job-1',
    })
    await expect(askOnce(call)).resolves.toBe('first')
    await expect(askOnce(call)).resolves.toBe('first')
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(started).toHaveLength(2)
  })

  it('does not share a confirmation between two runs (a single ask and a job)', async () => {
    const { started } = fakePdfApi('single')
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const single = createModelCall({
      settings: localSettings,
      lang: () => 'en',
      runId: 'single',
    })
    const job = createModelCall({
      settings: localSettings,
      lang: () => 'en',
      runId: 'job',
    })
    await askOnce(single)
    await askOnce(job)
    expect(confirm).toHaveBeenCalledTimes(2)
    expect(started).toHaveLength(2)
  })

  it('a declined prompt sends nothing and stops the job with context-limit', async () => {
    const { started } = fakePdfApi()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const call = createModelCall({
      settings: localSettings,
      lang: () => 'en',
      runId: 'job-1',
    })
    const failure = await askOnce(call).catch((err: unknown) => err)
    expect(failure).toBeInstanceOf(ModelCallError)
    expect((failure as ModelCallError).kind).toBe('context-limit')
    expect(started).toHaveLength(0)

    // the job's next call does not put the same question again
    const later = await askOnce(call).catch((err: unknown) => err)
    expect((later as ModelCallError).kind).toBe('context-limit')
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(started).toHaveLength(0)
  })
})
