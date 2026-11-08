// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * mindmap:ai-generate-image and mindmap:fetch-image — the two channels that
 * bring a picture into the map file. The generation tool is the shared one, and
 * the fetch gate is the shared one: this module only has to wire them to the
 * view's media roots and the screen path.
 */

type Handler = (event: { sender: unknown }, ...args: unknown[]) => unknown
const handlers = new Map<string, Handler>()

vi.mock('electron', () => ({
  app: { getPath: (name: string) => `/fake/${name}` },
  ipcMain: { handle: (channel: string, fn: Handler) => handlers.set(channel, fn) },
}))

const generateImageTool = vi.fn()
vi.mock('@genoffice/ai-search', () => ({
  generateImageTool: (...args: unknown[]) => generateImageTool(...args),
  documentMediaRoots: (path: string | null, pasted: string) =>
    [path ? `/roots${path}` : null, `/roots${pasted}`].filter(Boolean),
  withMediaCallSignal: (_sender: unknown, run: (signal: AbortSignal) => unknown) =>
    run(new AbortController().signal),
}))

vi.mock('@genoffice/ai-provider/subscription', () => ({
  sharedSubscriptionStatuses: () => ({ codex: 'ready' }),
}))

const fetchImageBytes = vi.fn()
vi.mock('@genoffice/electron-utils/fetch-image-bytes', () => ({
  fetchImageBytes: (...args: unknown[]) => fetchImageBytes(...args),
}))

import { registerMindmapImageIpc } from '../src/main/ai-image'
import { MINDMAP_CHANNELS } from '../src/shared/ipc'

const sender = { id: 7 }

beforeEach(() => {
  vi.resetModules()
  handlers.clear()
  generateImageTool.mockReset()
  fetchImageBytes.mockReset()
})

const register = (filePath: string | null = 'C:/maps/a.xmind') =>
  registerMindmapImageIpc({ filePathOf: () => filePath, pastedImageDir: '/tmp/pasted' })

describe('mindmap image channels', () => {
  it('registers exactly its own two channels', () => {
    register()
    expect([...handlers.keys()].sort()).toEqual(
      [MINDMAP_CHANNELS.aiGenerateImage, MINDMAP_CHANNELS.fetchImage].sort(),
    )
  })

  it('generates with the screen path, the shared statuses and the open map folder', async () => {
    register()
    generateImageTool.mockResolvedValue({ url: 'file:///store/a.png' })
    const result = await handlers.get(MINDMAP_CHANNELS.aiGenerateImage)!(
      { sender },
      { prompt: ' a red kite ', aspectRatio: '16:9' },
    )
    expect(result).toEqual({ url: 'file:///store/a.png' })
    const [settingsPath, op, options] = generateImageTool.mock.calls[0] as [
      string,
      Record<string, unknown>,
      Record<string, unknown>,
    ]
    expect(settingsPath).toContain('ai-settings.json')
    // the shared tool trims the prompt; the channel passes what the panel sent
    expect(op).toEqual({ prompt: ' a red kite ', aspectRatio: '16:9' })
    expect(options.context).toEqual({ path: 'screen', statuses: { codex: 'ready' } })
    expect(options.mediaRoots).toEqual(['/rootsC:/maps/a.xmind', '/roots/tmp/pasted'])
    expect(options.signal).toBeInstanceOf(AbortSignal)
  })

  it('keeps an empty prompt away from the tool', async () => {
    register()
    await handlers.get(MINDMAP_CHANNELS.aiGenerateImage)!({ sender }, {})
    expect(generateImageTool.mock.calls[0]?.[1]).toEqual({
      prompt: '',
      aspectRatio: undefined,
    })
  })

  it('fetches through the shared gate, which decides which URLs may be read', async () => {
    register()
    fetchImageBytes.mockResolvedValue({ base64: 'AA==', mime: 'image/png' })
    const result = await handlers.get(MINDMAP_CHANNELS.fetchImage)!(
      { sender },
      'https://example.com/a.png',
    )
    expect(result).toEqual({ base64: 'AA==', mime: 'image/png' })
    expect(fetchImageBytes).toHaveBeenCalledWith('https://example.com/a.png')
  })

  it('gives the fetch gate the map folder as a media root (an untitled map has none)', async () => {
    register(null)
    generateImageTool.mockResolvedValue({})
    await handlers.get(MINDMAP_CHANNELS.aiGenerateImage)!({ sender }, { prompt: 'x' })
    expect((generateImageTool.mock.calls[0]![2] as { mediaRoots: string[] }).mediaRoots).toEqual([
      '/roots/tmp/pasted',
    ])
  })
})
