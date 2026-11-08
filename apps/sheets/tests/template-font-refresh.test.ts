// A bundled template face loads on first use, after cells may already have been laid
// out with the fallback: once it finishes, the grid must measure and draw again.
import { describe, expect, it, vi } from 'vitest'

import { IRenderManagerService } from '@univerjs/engine-render'
import { SheetSkeletonManagerService } from '@univerjs/preset-sheets-core'

import {
  dropTemplateFontMeasurements,
  refreshTemplateFontLayout,
} from '../src/renderer/template-font-layout'
import { installTemplateFontRefresh } from '../src/renderer/template-fonts'
import type { UniverRuntime } from '../src/renderer/univer-state'

function loadingDone(families: string[]): Event {
  const event = new Event('loadingdone')
  Object.assign(event, { fontfaces: families.map((family) => ({ family })) })
  return event
}

describe('installTemplateFontRefresh', () => {
  it('re-lays the grid out when a bundled face finishes loading', () => {
    const fonts = new EventTarget()
    const refresh = vi.fn()
    installTemplateFontRefresh(refresh, fonts as FontFaceSet, (run) => run())
    fonts.dispatchEvent(loadingDone(['Calibri']))
    expect(refresh).not.toHaveBeenCalled()
    fonts.dispatchEvent(loadingDone(['"Noto Serif KR"']))
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('refreshes once per frame and stops when disposed', () => {
    const fonts = new EventTarget()
    const refresh = vi.fn()
    const frames: (() => void)[] = []
    const dispose = installTemplateFontRefresh(refresh, fonts as FontFaceSet, (run) =>
      frames.push(run),
    )
    fonts.dispatchEvent(loadingDone(['Pretendard']))
    fonts.dispatchEvent(loadingDone(['Gowun Batang']))
    expect(frames).toHaveLength(1)
    frames.shift()!()
    expect(refresh).toHaveBeenCalledTimes(1)
    fonts.dispatchEvent(loadingDone(['Bebas Neue']))
    dispose()
    frames.shift()?.()
    fonts.dispatchEvent(loadingDone(['Bebas Neue']))
    expect(refresh).toHaveBeenCalledTimes(1)
  })
})

describe('refreshTemplateFontLayout', () => {
  it('drops the measurements made in a bundled family, and only those', () => {
    const cache = new Map<string, unknown>([
      ['bold 14.6667px "Pretendard", sans-serif', 1],
      ['14.6667px Gowun Batang', 2],
      ['11pt Calibri', 3],
    ])
    expect(dropTemplateFontMeasurements(cache)).toBe(2)
    expect([...cache.keys()]).toEqual(['11pt Calibri'])
  })

  it('resets every laid-out sheet and redraws', () => {
    const skeleton = () => ({ resetCache: vi.fn(), makeDirty: vi.fn() })
    const laidOut = { s1: skeleton(), s2: skeleton() }
    const manager = {
      getSkeleton: (id: string) => laidOut[id as keyof typeof laidOut],
      reCalculate: vi.fn(),
    }
    const render = {
      with: (token: unknown) => (token === SheetSkeletonManagerService ? manager : null),
      mainComponent: { makeDirty: vi.fn() },
      scene: { makeDirty: vi.fn() },
    }
    const runtime = {
      univerAPI: {
        getActiveWorkbook: () => ({
          getId: () => 'wb',
          // s3 was never shown: no skeleton to reset
          getSheets: () => ['s1', 's2', 's3'].map((id) => ({ getSheetId: () => id })),
        }),
      },
      univer: {
        __getInjector: () => ({
          get: (token: unknown) =>
            token === IRenderManagerService
              ? { getRenderById: (id: string) => (id === 'wb' ? render : null) }
              : null,
        }),
      },
    } as unknown as UniverRuntime
    refreshTemplateFontLayout(runtime)
    for (const sheet of Object.values(laidOut)) {
      expect(sheet.resetCache).toHaveBeenCalledTimes(1)
      expect(sheet.makeDirty).toHaveBeenCalledWith(true)
    }
    expect(manager.reCalculate).toHaveBeenCalledTimes(1)
    expect(render.mainComponent.makeDirty).toHaveBeenCalledWith(true)
    expect(render.scene.makeDirty).toHaveBeenCalledWith(true)
  })
})
