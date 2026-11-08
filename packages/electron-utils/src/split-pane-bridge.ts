/// Every editor preload exposes the same split-pane bridge. The shell declares
/// the same role structure on its side of the package boundary; this copy keeps
/// the editors independent of the shell's source tree.
import type { IpcRenderer } from 'electron'

/** What a pane is for; "no role" is expressed as null. */
export type SplitPaneRole = 'focus' | 'secondary'

/** App-wide channels for split panes. */
export const SPLIT_PANE_CHANNELS = {
  /** invoke: SplitPaneRole | null */
  getRole: 'app:get-split-role',
  /** push: SplitPaneRole | null */
  roleChanged: 'app:split-role-changed',
  /** invoke/send: ask the shell to focus this pane */
  requestFocus: 'tabs:focus-pane',
  /** send: fallback focus ping from a view that gained focus */
  reportFocus: 'app:view-focused',
} as const

/** Key of the bridge exposed on the editor's window object. */
export const SPLIT_PANE_BRIDGE_KEY = 'aiOfficeSplit'

export interface SplitPaneBridge {
  /** the role the shell gave this view, or null when it is not in a split */
  getRole(): Promise<SplitPaneRole | null>
  /** called with the new role whenever the split changes; returns unsubscribe */
  onRoleChanged(handler: (role: SplitPaneRole | null) => void): () => void
  /** ask the shell to move focus to this pane */
  requestFocus(): void
  /** fallback ping: this view gained focus */
  reportFocus(): void
}

export function splitPaneBridge(ipcRenderer: IpcRenderer): SplitPaneBridge {
  return {
    getRole: async () =>
      (await ipcRenderer.invoke(SPLIT_PANE_CHANNELS.getRole).catch(() => null)) ?? null,
    onRoleChanged(handler) {
      const listener = (_event: unknown, role: SplitPaneRole | null) => handler(role)
      ipcRenderer.on(SPLIT_PANE_CHANNELS.roleChanged, listener)
      return () => {
        ipcRenderer.removeListener(SPLIT_PANE_CHANNELS.roleChanged, listener)
      }
    },
    requestFocus() {
      ipcRenderer.send(SPLIT_PANE_CHANNELS.requestFocus)
    },
    reportFocus() {
      ipcRenderer.send(SPLIT_PANE_CHANNELS.reportFocus)
    },
  }
}
