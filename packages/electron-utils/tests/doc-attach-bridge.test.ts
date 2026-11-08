import { beforeEach, describe, expect, it, vi } from 'vitest'

import { DOC_ATTACH_BRIDGE_KEY, DOC_ATTACH_CHANNELS } from '../src/doc-attach-channels'
import {
  docAttachBridge,
  type DocAttachResult,
  type DocMentionListResult,
} from '../src/doc-attach-bridge'

// ---- electron mock (module under test imports ipcRenderer eagerly) ----

const electronMocks = vi.hoisted(() => ({ invoke: vi.fn() }))

vi.mock('electron', () => ({
  ipcRenderer: { invoke: electronMocks.invoke },
}))

beforeEach(() => {
  electronMocks.invoke.mockReset()
})

describe('DOC_ATTACH_CHANNELS', () => {
  it('names the three editor-to-shell channels and the bridge key', () => {
    expect(DOC_ATTACH_CHANNELS).toEqual({
      available: 'doc:attach-available',
      pick: 'doc:pick-attachments',
      list: 'doc:attach-list',
    })
    expect(DOC_ATTACH_BRIDGE_KEY).toBe('aiOfficeDocs')
  })
})

describe('docAttachBridge', () => {
  it('asks the available channel and reports a live shell', async () => {
    electronMocks.invoke.mockResolvedValue(true)
    await expect(docAttachBridge().available()).resolves.toBe(true)
    expect(electronMocks.invoke).toHaveBeenCalledWith(DOC_ATTACH_CHANNELS.available)
  })

  it('reports an absent shell when the available invoke fails', async () => {
    electronMocks.invoke.mockRejectedValue(new Error('no handler'))
    await expect(docAttachBridge().available()).resolves.toBe(false)
  })

  it('passes the pick result through unchanged', async () => {
    const result: DocAttachResult = { ok: true, paths: ['C:\\docs\\a.docx'] }
    electronMocks.invoke.mockResolvedValue(result)
    await expect(docAttachBridge().pick()).resolves.toEqual(result)
    expect(electronMocks.invoke).toHaveBeenCalledWith(DOC_ATTACH_CHANNELS.pick)
  })

  it('answers unavailable when the pick invoke fails (editor run without the shell)', async () => {
    electronMocks.invoke.mockRejectedValue(new Error('no handler'))
    await expect(docAttachBridge().pick()).resolves.toEqual({ ok: false, reason: 'unavailable' })
  })

  it('passes a well-formed list result through unchanged', async () => {
    const result: DocMentionListResult = {
      ok: true,
      items: [
        { path: 'C:\\docs\\a.docx', name: 'a.docx', dir: 'C:\\docs', group: 'open', state: 'ok' },
        { path: null, name: '제목 없는 문서', dir: '', group: 'pane', state: 'unsaved' },
      ],
    }
    electronMocks.invoke.mockResolvedValue(result)
    await expect(docAttachBridge().list()).resolves.toEqual(result)
    expect(electronMocks.invoke).toHaveBeenCalledWith(DOC_ATTACH_CHANNELS.list)
  })

  it('answers unavailable when the list invoke fails (editor run without the shell)', async () => {
    electronMocks.invoke.mockRejectedValue(new Error('no handler'))
    await expect(docAttachBridge().list()).resolves.toEqual({ ok: false, reason: 'unavailable' })
  })

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a string', 'items'],
    ['ok false', { ok: false, reason: 'busy' }],
    ['ok true without items', { ok: true }],
    ['items not an array', { ok: true, items: { length: 1 } }],
    ['ok not exactly true', { ok: 'yes', items: [] }],
  ])('answers unavailable for a malformed list reply (%s)', async (_label, reply) => {
    electronMocks.invoke.mockResolvedValue(reply)
    await expect(docAttachBridge().list()).resolves.toEqual({ ok: false, reason: 'unavailable' })
  })
})
