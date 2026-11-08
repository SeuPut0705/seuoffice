import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ChannelModule from '../src/embed-channel'

type Channel = typeof ChannelModule

const HOST = location.origin

let host: Window
let sent: Record<string, unknown>[]
let channel: Channel

function fromHost(data: Record<string, unknown>, origin = HOST): void {
  window.dispatchEvent(
    new MessageEvent('message', {
      source: host,
      origin,
      data: { source: 'seuoffice', version: 1, ...data },
    }),
  )
}

beforeEach(async () => {
  // a frame's window stands in for the embedding page
  const frame = document.createElement('iframe')
  document.body.appendChild(frame)
  host = frame.contentWindow!
  sent = []
  vi.spyOn(host, 'postMessage').mockImplementation((message: unknown) => {
    sent.push(message as Record<string, unknown>)
  })
  Object.defineProperty(window, 'parent', { value: host, configurable: true })
  // the channel keeps one host per page load, so each test loads a fresh copy
  vi.resetModules()
  channel = await import('../src/embed-channel')
  const opening = channel.receiveOpen()
  fromHost({ type: 'open', fileName: 'memo.hwpx', bytes: new ArrayBuffer(1) })
  await opening
  sent = []
})

afterEach(() => {
  Object.defineProperty(window, 'parent', { value: window, configurable: true })
  document.body.replaceChildren()
})

describe('saving to the host', () => {
  it('sends a copy of the bytes and resolves when the host stored them', async () => {
    const bytes = new Uint8Array([9, 8, 7])
    const saving = channel.saveToHost('memo.hwpx', bytes)
    const [save] = sent as { type: string; saveId: number; fileName: string; bytes: ArrayBuffer }[]
    expect(save!.type).toBe('save')
    expect(save!.fileName).toBe('memo.hwpx')
    expect(Array.from(new Uint8Array(save!.bytes))).toEqual([9, 8, 7])
    expect(Array.from(bytes)).toEqual([9, 8, 7])
    fromHost({ type: 'saved', saveId: save!.saveId })
    await expect(saving).resolves.toBeUndefined()
  })

  it('rejects with the host reason and ignores answers from another origin', async () => {
    const saving = channel.saveToHost('memo.hwpx', new Uint8Array(1))
    const { saveId } = sent[0] as { saveId: number }
    fromHost({ type: 'saved', saveId }, 'https://evil.example')
    fromHost({ type: 'save_failed', saveId, message: 'lock lost' })
    await expect(saving).rejects.toThrow('lock lost')
  })

  it('runs the app save when the host asks and reports how it went', async () => {
    channel.onHostSaveRequest(async () => {})
    fromHost({ type: 'request_save', requestId: 3 })
    await vi.waitFor(() =>
      expect(sent).toContainEqual(
        expect.objectContaining({ type: 'request_save_done', requestId: 3, ok: true }),
      ),
    )
    channel.onHostSaveRequest(async () => {
      throw new Error('nothing to save')
    })
    fromHost({ type: 'request_save', requestId: 4 })
    await vi.waitFor(() =>
      expect(sent).toContainEqual(
        expect.objectContaining({
          type: 'request_save_done',
          requestId: 4,
          ok: false,
          message: 'nothing to save',
        }),
      ),
    )
  })

  it('reports dirty only when it changes', () => {
    channel.reportDirty(true)
    channel.reportDirty(true)
    channel.reportDirty(false)
    expect(sent.map((message) => message.dirty)).toEqual([true, false])
  })
})
