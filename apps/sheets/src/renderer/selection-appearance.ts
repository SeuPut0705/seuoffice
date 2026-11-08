import { ThemeService } from '@univerjs/core'
import { IRenderManagerService } from '@univerjs/engine-render'
import type { ISelectionWithStyle } from '@univerjs/sheets'
import {
  genNormalSelectionStyle,
  ISheetSelectionRenderService,
  SheetSelectionRenderService,
} from '@univerjs/sheets-ui'

import type { UniverRuntime } from './univer-state'

// Canvas selection chrome only; these colors never enter cell styles.
const LIGHT_SELECTION = {
  stroke: '#006b3c',
  fill: 'rgba(0, 107, 60, 0.12)',
  headerFill: 'rgba(0, 107, 60, 0.18)',
}

/** Keep normal selections visible against white cells and authored borders. */
export function installSelectionAppearance(runtime: UniverRuntime): {
  refresh(): void
  dispose(): void
} {
  const injector = runtime.univer.__getInjector()
  const theme = injector.get(ThemeService)
  const appearance = (style: ISelectionWithStyle['style']): ISelectionWithStyle['style'] => {
    const normal = genNormalSelectionStyle(theme)
    // Preserve hidden selections and explicitly styled reference/mark ranges.
    if (
      style &&
      (style.id ||
        style.strokeDash !== undefined ||
        Object.values(style.widgets ?? {}).some(Boolean) ||
        (style.stroke && style.stroke !== normal.stroke && style.stroke !== LIGHT_SELECTION.stroke))
    ) {
      return style
    }
    return theme.darkMode
      ? normal
      : {
          ...normal,
          stroke: LIGHT_SELECTION.stroke,
          strokeWidth: 2,
          fill: LIGHT_SELECTION.fill,
          autofillSize: 8,
          rowHeaderFill: LIGHT_SELECTION.headerFill,
          rowHeaderStroke: LIGHT_SELECTION.stroke,
          rowHeaderStrokeWidth: 2,
          columnHeaderFill: LIGHT_SELECTION.headerFill,
          columnHeaderStroke: LIGHT_SELECTION.stroke,
          columnHeaderStrokeWidth: 2,
        }
  }

  // Render modules are created per workbook, after this installer runs. Patch
  // only normal selections; formula references and copy outlines use others.
  const proto = SheetSelectionRenderService.prototype
  const originalNew = proto.newSelectionControl
  const originalReset = proto.resetSelectionsByModelData
  proto.newSelectionControl = function (scene, skeleton, selection) {
    return originalNew.call(this, scene, skeleton, {
      ...selection,
      style: appearance(selection.style),
    })
  }
  proto.resetSelectionsByModelData = function (selections) {
    originalReset.call(
      this,
      selections.map((selection) => ({ ...selection, style: appearance(selection.style) })),
    )
  }

  return {
    refresh() {
      const workbook = runtime.univerAPI.getActiveWorkbook()
      if (!workbook) return
      const render = injector.get(IRenderManagerService).getRenderById(workbook.getId())
      const controls = render?.with(ISheetSelectionRenderService).getSelectionControls() ?? []
      for (const control of controls) {
        const style = appearance(control.currentStyle)
        if (style) control.updateStyle(style)
      }
    },
    dispose() {
      proto.newSelectionControl = originalNew
      proto.resetSelectionsByModelData = originalReset
    },
  }
}
