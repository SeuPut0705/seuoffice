import { describe, expect, it, vi } from 'vitest'
import { unsupported } from '@seuoffice/web-platform'
import {
  checkExternalLinksUpdate,
  updateExternalLinksFlow,
} from '../src/renderer/external-links-flow'
import type { DesktopApi } from '../src/shared/desktop-api'

type LinksBridge = Partial<Pick<DesktopApi, 'listExternalLinks' | 'updateExternalLinks'>>

function panel(api: LinksBridge) {
  const messages: unknown[] = []
  let sessionId = 'before-save'
  const save = vi.fn(async () => {
    sessionId = 'after-save'
    return { ok: true }
  })
  const apply = vi.fn()
  const onStatuses = vi.fn()
  return {
    save,
    apply,
    onStatuses,
    messages,
    click: () =>
      updateExternalLinksFlow({
        check: () => checkExternalLinksUpdate(api, sessionId),
        onError: (error) => messages.push(error),
        save,
        update: () => api.updateExternalLinks!({ sessionId }),
        apply,
        onStatuses,
      }),
  }
}

describe('the External Links panel Update handler', () => {
  it.each([
    ['missing', {}],
    ['missing update', { listExternalLinks: async () => ({ links: [] }) }],
    [
      'web refusal',
      {
        listExternalLinks: unsupported('sheets.externalLinks'),
        updateExternalLinks: unsupported('sheets.externalLinks'),
      },
    ],
  ] as const)('refuses a %s bridge before saving, and reports it', async (_name, api) => {
    const ui = panel(api)
    await expect(ui.click()).resolves.toBe(false)
    expect(ui.save).not.toHaveBeenCalled()
    expect(ui.apply).not.toHaveBeenCalled()
    expect(ui.messages).toHaveLength(1)
    expect(ui.messages[0]).toBeInstanceOf(Error)
  })

  it('reports a desktop sidecar rejection instead of leaving an unhandled promise', async () => {
    const error = new Error('the sidecar went away')
    const update = vi.fn().mockRejectedValue(error)
    const ui = panel({
      listExternalLinks: async () => ({ links: [] }),
      updateExternalLinks: update,
    })

    await expect(ui.click()).resolves.toBe(false)
    expect(ui.messages).toEqual([error])
    expect(ui.save).toHaveBeenCalledTimes(1)
    expect(ui.apply).not.toHaveBeenCalled()
    expect(ui.onStatuses).not.toHaveBeenCalled()
    // The first save replaces the session; Update must use the replacement.
    expect(update).toHaveBeenCalledWith({ sessionId: 'after-save' })
  })

  it('still saves, updates the replacement session, applies and saves again on desktop', async () => {
    const report = { links: [], cells: [] }
    const list = vi.fn().mockResolvedValue({ links: [] })
    const update = vi.fn().mockResolvedValue(report)
    const ui = panel({ listExternalLinks: list, updateExternalLinks: update })

    await expect(ui.click()).resolves.toBe(true)
    expect(list).toHaveBeenCalledWith({ sessionId: 'before-save' })
    expect(update).toHaveBeenCalledWith({ sessionId: 'after-save' })
    expect(ui.save).toHaveBeenCalledTimes(2)
    expect(ui.apply).toHaveBeenCalledWith(report)
    expect(ui.onStatuses).toHaveBeenCalledWith(report)
    expect(ui.messages).toEqual([])
  })
})
