/**
 * The AI dock under the shell's split panes (decision 0036): while this view is
 * the secondary pane its panel is forced to the collapsed rail, and a click on
 * that rail asks the shell to focus this pane first, so the panel it opens is
 * the visible one. Without the bridge (a standalone editor) nothing changes.
 */
import { effectiveAiPanelOpen, onAiRailClick, useSplitPaneRole } from '@genoffice/ui'

export interface AiDockState {
  /** what the dock renders: a secondary pane's panel is forced to the rail */
  open: boolean
  /** a click on the collapsed rail: focus this pane first where the shell split it */
  onExpand: () => void
}

export function useAiDock(
  localOpen: boolean,
  setLocalOpen: (open: boolean) => void,
): AiDockState {
  const { role, requestFocus } = useSplitPaneRole()
  return {
    open: effectiveAiPanelOpen(localOpen, role),
    onExpand: () => onAiRailClick(role, localOpen, setLocalOpen, requestFocus),
  }
}
