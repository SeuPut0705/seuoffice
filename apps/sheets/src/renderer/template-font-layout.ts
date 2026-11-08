/// Re-lay the grid out once a bundled template face has loaded. Univer measures a
/// cell's text once and keeps both the measurement (FontCache) and the cell's laid-
/// out text (the skeleton's style cache), so a cell drawn while the face was still in
/// flight keeps the fallback's widths until both are dropped. This is Univer's own
/// "every cell changed" path (skeleton.resetCache, as its raw-formula toggle uses),
/// followed by the redraw a style change gets.

import { FontCache, IRenderManagerService } from '@univerjs/engine-render'
import { SheetSkeletonManagerService } from '@univerjs/preset-sheets-core'

import { TEMPLATE_FONT_FAMILY_KEYS } from '../shared/template-font-faces'
import type { UniverRuntime } from './univer-state'

/// Drops the cached measurements of font strings naming a bundled family. A key is a
/// canvas font string (`bold 14.6667px "Pretendard", …`, quoted or not); one that
/// names a bundled family anywhere may have been measured with the fallback.
export function dropTemplateFontMeasurements(
  cache: Map<string, unknown> = FontCache.globalFontMeasureCache,
): number {
  let dropped = 0
  for (const key of [...cache.keys()]) {
    const lower = key.toLowerCase()
    if ([...TEMPLATE_FONT_FAMILY_KEYS].some((family) => lower.includes(family))) {
      cache.delete(key)
      dropped += 1
    }
  }
  return dropped
}

export function refreshTemplateFontLayout(runtime: UniverRuntime): void {
  dropTemplateFontMeasurements()
  const workbook = runtime.univerAPI.getActiveWorkbook()
  if (!workbook) return
  try {
    const render = runtime.univer
      .__getInjector()
      .get(IRenderManagerService)
      .getRenderById(workbook.getId())
    if (!render) return
    const skeletons = render.with(SheetSkeletonManagerService)
    // every sheet already laid out, not only the visible one: a sheet tab switch
    // reuses its skeleton's style cache
    for (const sheet of workbook.getSheets()) {
      const skeleton = skeletons.getSkeleton(sheet.getSheetId())
      skeleton?.resetCache()
      skeleton?.makeDirty(true)
    }
    skeletons.reCalculate()
    render.mainComponent?.makeDirty(true)
    render.scene?.makeDirty(true)
  } catch {
    // Render modules may not exist yet during workbook replacement; the next
    // layout measures with the loaded face anyway.
  }
}
