/**
 * Slide Show > Record, the page's side: the main process is told the recording stopped on every
 * way out, so it stops letting this page open the microphone.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useNarrationRecording, type NarrationTake } from '../src/renderer/narration/use-recording'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** What the page sent the main process, in order */
let sent: string[]
let osAllows: boolean
let deviceFails: boolean
let trackStops: number

class FakeRecorder extends EventTarget {
  state = 'inactive'
  mimeType = 'audio/webm'
  ondataavailable: ((e: { data: Blob }) => void) | null = null
  start(): void {
    this.state = 'recording'
  }
  pause(): void {
    this.state = 'paused'
  }
  resume(): void {
    this.state = 'recording'
  }
  stop(): void {
    this.state = 'inactive'
    this.dispatchEvent(new Event('stop'))
  }
}

beforeEach(() => {
  sent = []
  osAllows = true
  deviceFails = false
  trackStops = 0
  vi.stubGlobal('slidesApi', {
    microphoneAccess: async () => {
      sent.push('access')
      return osAllows
    },
    microphoneRelease: () => {
      sent.push('release')
    },
  })
  vi.stubGlobal('MediaRecorder', FakeRecorder)
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: async () => {
        if (deviceFails) throw new Error('no microphone')
        return { getTracks: () => [{ stop: () => (trackStops += 1) }] }
      },
    },
  })
})

let mounted: { root: Root; container: HTMLElement } | null = null
afterEach(() => {
  if (mounted) {
    const { root, container } = mounted
    act(() => root.unmount())
    container.remove()
    mounted = null
  }
  vi.unstubAllGlobals()
})

let recording: ReturnType<typeof useNarrationRecording>
function Show({ active }: { active: boolean }): null {
  recording = useNarrationRecording(active, 0, false)
  return null
}

async function show(active: boolean): Promise<Root> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  mounted = { root, container }
  await act(async () => {
    root.render(createElement(Show, { active }))
  })
  // the OS answer and the device each arrive a few promise turns later
  await act(async () => {
    for (let turn = 0; turn < 20; turn++) await Promise.resolve()
  })
  return root
}

describe('the page tells the main process the recording stopped', () => {
  it('when the show ends', async () => {
    const root = await show(true)
    expect(recording.phase).toBe('recording')
    expect(sent).toEqual(['access'])
    act(() => root.unmount())
    mounted = null
    expect(sent).toEqual(['access', 'release'])
    expect(trackStops).toBe(1)
  })

  it('when the recording is handed over', async () => {
    await show(true)
    let take: NarrationTake | null = null
    await act(async () => {
      take = await recording.finish()
    })
    expect(take).not.toBeNull()
    expect(sent).toEqual(['access', 'release'])
    expect(trackStops).toBe(1)
  })

  it('when the microphone cannot be opened', async () => {
    deviceFails = true
    await show(true)
    expect(recording.phase).toBe('failed')
    expect(sent).toEqual(['access', 'release'])
  })

  it('when the person refused the microphone', async () => {
    osAllows = false
    await show(true)
    expect(recording.phase).toBe('failed')
    expect(sent).toEqual(['access', 'release'])
  })

  it('and says nothing in a show that does not record', async () => {
    const root = await show(false)
    act(() => root.unmount())
    mounted = null
    expect(sent).toEqual([])
  })
})
