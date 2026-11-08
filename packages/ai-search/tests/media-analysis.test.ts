import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@genoffice/ai-provider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@genoffice/ai-provider')>()),
  analyzeMediaWithProvider: vi.fn(),
  streamForProvider: vi.fn(),
}))

import { AiRunError, analyzeMediaWithProvider, streamForProvider } from '@genoffice/ai-provider'
import { analyzeMediaTool } from '../src/media-tools'
import type { AiToolCallContext } from '../src/tool-routing'
import { dataUrl, keyMedia, status, writeSettings } from './routing-helpers'

const keyAnalyze = vi.mocked(analyzeMediaWithProvider)
const stream = vi.mocked(streamForProvider)

const claudeReady: AiToolCallContext = {
  path: 'screen',
  statuses: { 'claude-code': status('claude-code', 'ready') },
}

/** the provider answers in two deltas, like a real stream */
function answer(...parts: string[]) {
  stream.mockImplementation(async (_provider, _config, _system, _messages, _tools, _max, cb) => {
    for (const part of parts) cb.onDelta(part)
  })
}

beforeEach(() => {
  keyAnalyze.mockReset()
  stream.mockReset()
  keyAnalyze.mockResolvedValue('from the key provider')
  answer('A red ', 'square.')
})

describe('analyze_media, image analysis through the AI provider (`chat`)', () => {
  it('asks the provider `auto` resolves to, with the images attached and no tools', async () => {
    const r = await analyzeMediaTool(
      writeSettings(),
      {
        mediaUrls: [dataUrl(8, 'image/png'), dataUrl(8, 'image/jpeg')],
        requirements: 'What is this?',
      },
      { context: claudeReady },
    )
    expect(r).toEqual({ text: 'A red square.' })
    expect(stream).toHaveBeenCalledTimes(1)
    const [provider, config, system, messages, tools] = stream.mock.calls[0]!
    expect(provider).toBe('claude-code')
    expect(config).toMatchObject({ model: '' })
    expect(system).toEqual(expect.any(String))
    expect(tools).toEqual([])
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ role: 'user', text: 'What is this?' })
    const images = (messages[0] as { images?: { base64: string; mime: string }[] }).images!
    expect(images.map((image) => image.mime)).toEqual(['image/png', 'image/jpeg'])
    expect(images.every((image) => /^[A-Za-z0-9+/]+=*$/.test(image.base64))).toBe(true)
    expect(keyAnalyze).not.toHaveBeenCalled()
  })

  it('prefers Claude Code over Codex when both are ready, like the chat does', async () => {
    await analyzeMediaTool(
      writeSettings(),
      { mediaUrls: [dataUrl(8)], requirements: 'describe' },
      {
        context: {
          path: 'screen',
          statuses: {
            codex: status('codex', 'ready'),
            'claude-code': status('claude-code', 'ready'),
          },
        },
      },
    )
    expect(stream.mock.calls[0]![0]).toBe('claude-code')
  })

  it('uses a key chat provider only because the user selected it', async () => {
    const settings = writeSettings({
      provider: 'anthropic',
      providers: { anthropic: { apiKey: 'sk-ant', model: 'claude-sonnet-4-5' } },
    })
    const r = await analyzeMediaTool(settings, {
      mediaUrls: [dataUrl(8)],
      requirements: 'describe',
    })
    expect(r).toEqual({ text: 'A red square.' })
    expect(stream.mock.calls[0]![0]).toBe('anthropic')
    expect(stream.mock.calls[0]![1]).toMatchObject({ apiKey: 'sk-ant' })
  })

  it('never picks a filled-in key chat provider on behalf of `auto`', async () => {
    const settings = writeSettings({
      provider: 'auto',
      providers: { anthropic: { apiKey: 'sk-ant', model: 'claude-sonnet-4-5' } },
    })
    const r = await analyzeMediaTool(settings, {
      mediaUrls: [dataUrl(8)],
      requirements: 'describe',
    })
    expect(r.text).toBeUndefined()
    expect(r.errorCode).toBe('unavailable')
    expect(r.error).toMatch(/Settings/)
    expect(stream).not.toHaveBeenCalled()
  })

  it('answers "unavailable" for a selected model that cannot read images', async () => {
    const settings = writeSettings({
      provider: 'deepseek',
      providers: { deepseek: { apiKey: 'sk', model: 'deepseek-v4-pro' } },
    })
    const r = await analyzeMediaTool(settings, {
      mediaUrls: [dataUrl(8)],
      requirements: 'describe',
    })
    expect(r.errorCode).toBe('unavailable')
    expect(stream).not.toHaveBeenCalled()
  })

  it('returns the provider failure as the error, with its cause, and tries nothing else', async () => {
    const resetsAt = Date.now() + 1000
    stream.mockRejectedValueOnce(
      new AiRunError('rate-limit', 'Claude usage limit reached', {
        provider: 'claude-code',
        resetsAt,
      }),
    )
    const settings = writeSettings({ media: keyMedia({ analysisProvider: 'chat' }, 'gemini') })
    const r = await analyzeMediaTool(
      settings,
      { mediaUrls: [dataUrl(8)], requirements: 'describe' },
      { context: claudeReady },
    )
    expect(r).toEqual({
      error: 'Claude usage limit reached',
      errorCode: 'rate-limit',
      resetsAt,
    })
    expect(stream).toHaveBeenCalledTimes(1)
    expect(keyAnalyze).not.toHaveBeenCalled()
  })

  it('reports an empty answer as an error instead of an empty analysis', async () => {
    answer()
    const r = await analyzeMediaTool(
      writeSettings(),
      { mediaUrls: [dataUrl(8)], requirements: 'describe' },
      { context: claudeReady },
    )
    expect(r.text).toBeUndefined()
    expect(r.error).toEqual(expect.any(String))
  })

  it('ends the provider run when the caller cancels, and answers with an error instead of throwing', async () => {
    let providerSignal: AbortSignal | undefined
    stream.mockImplementation(
      (_provider, _config, _system, _messages, _tools, _max, cb) =>
        new Promise<void>((_resolve, reject) => {
          providerSignal = cb.signal
          // what a subscription bridge does on abort: it ends its program, then rejects
          cb.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
        }),
    )
    const controller = new AbortController()
    const pending = analyzeMediaTool(
      writeSettings(),
      { mediaUrls: [dataUrl(8)], requirements: 'describe' },
      { context: claudeReady, signal: controller.signal },
    )
    await vi.waitFor(() => expect(stream).toHaveBeenCalledTimes(1))
    expect(providerSignal!.aborted).toBe(false)
    controller.abort()
    const r = await pending
    expect(providerSignal!.aborted).toBe(true)
    expect(r.text).toBeUndefined()
    expect(r.error).toEqual(expect.any(String))
  })
})

describe('analyze_media, key analysis provider', () => {
  it('uses the key provider when it is selected and filled in', async () => {
    const settings = writeSettings({ media: keyMedia({ analysisProvider: 'openai' }, 'openai') })
    const r = await analyzeMediaTool(
      settings,
      { mediaUrls: [dataUrl(8)], requirements: 'describe' },
      { context: claudeReady },
    )
    expect(r).toEqual({ text: 'from the key provider' })
    expect(keyAnalyze.mock.calls[0]![0]).toBe('openai')
    expect(stream).not.toHaveBeenCalled()
  })

  it('goes back to the AI provider when the selected key provider is not filled in', async () => {
    const settings = writeSettings({ media: { analysisProvider: 'openai', providers: {} } })
    const r = await analyzeMediaTool(
      settings,
      { mediaUrls: [dataUrl(8)], requirements: 'describe' },
      { context: claudeReady },
    )
    expect(r).toEqual({ text: 'A red square.' })
    expect(keyAnalyze).not.toHaveBeenCalled()
  })

  it('does not use a filled-in key provider that is not the selection', async () => {
    const settings = writeSettings({ media: keyMedia({ analysisProvider: 'chat' }, 'openai') })
    await analyzeMediaTool(
      settings,
      { mediaUrls: [dataUrl(8)], requirements: 'describe' },
      { context: claudeReady },
    )
    expect(stream).toHaveBeenCalledTimes(1)
    expect(keyAnalyze).not.toHaveBeenCalled()
  })
})

describe('analyze_media, video and audio', () => {
  it('answers "unavailable" and names the setting when no video-capable key provider is selected', async () => {
    const r = await analyzeMediaTool(
      writeSettings(),
      { mediaUrls: [dataUrl(8, 'video/mp4')], requirements: 'summarize the clip' },
      { context: claudeReady },
    )
    expect(r.text).toBeUndefined()
    expect(r.errorCode).toBe('unavailable')
    expect(r.error).toMatch(/video/i)
    expect(r.error).toMatch(/Settings/)
    expect(stream).not.toHaveBeenCalled()
    expect(keyAnalyze).not.toHaveBeenCalled()
  })

  it('does not show audio to the AI provider either', async () => {
    const r = await analyzeMediaTool(
      writeSettings(),
      { mediaUrls: [dataUrl(8, 'audio/mpeg')], requirements: 'transcribe' },
      { context: claudeReady },
    )
    expect(r.errorCode).toBe('unavailable')
    expect(stream).not.toHaveBeenCalled()
  })

  it('does not use an image-only key provider for video', async () => {
    // openai reads images but not video
    const settings = writeSettings({
      media: keyMedia({ analysisProvider: 'openai', videoAnalysisProvider: 'openai' }, 'openai'),
    })
    const r = await analyzeMediaTool(settings, {
      mediaUrls: [dataUrl(8, 'video/mp4')],
      requirements: 'summarize',
    })
    expect(r.errorCode).toBe('unavailable')
    expect(keyAnalyze).not.toHaveBeenCalled()
  })

  it('uses the selected video-capable key provider', async () => {
    const settings = writeSettings({
      media: keyMedia({ videoAnalysisProvider: 'gemini' }, 'gemini'),
    })
    const r = await analyzeMediaTool(settings, {
      mediaUrls: [dataUrl(8, 'video/mp4'), dataUrl(8, 'image/png')],
      requirements: 'summarize',
    })
    expect(r).toEqual({ text: 'from the key provider' })
    expect(keyAnalyze.mock.calls[0]![0]).toBe('gemini')
    // a request with any video in it goes to the video provider as a whole
    expect(keyAnalyze.mock.calls[0]![2].media).toHaveLength(2)
    expect(stream).not.toHaveBeenCalled()
  })
})

describe('analyze_media input checks', () => {
  it('validates its input first', async () => {
    expect(await analyzeMediaTool(writeSettings(), { mediaUrls: [], requirements: 'x' })).toEqual({
      error: 'mediaUrls must not be empty',
    })
    expect(
      await analyzeMediaTool(writeSettings(), { mediaUrls: [dataUrl(8)], requirements: ' ' }),
    ).toEqual({ error: 'requirements must not be empty' })
  })

  it('bounds the item count on every route', async () => {
    const r = await analyzeMediaTool(
      writeSettings(),
      { mediaUrls: Array.from({ length: 13 }, () => dataUrl(8)), requirements: 'describe' },
      { context: claudeReady },
    )
    expect(r.error).toBe(
      'Too many media items in one request (13, limit 12); analyze them in smaller batches',
    )
    expect(stream).not.toHaveBeenCalled()
  })
})
