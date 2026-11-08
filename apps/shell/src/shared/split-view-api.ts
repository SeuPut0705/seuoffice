/** How the two panes are laid out: side by side, or stacked top and bottom. */
export type SplitOrientation = 'side' | 'stack'

/** What a pane is for; "no role" is expressed as null, not as a third member. */
export type SplitPaneRole = 'focus' | 'secondary'

/** The two-pane split of one shell window. */
export interface SplitViewState {
  /** tab id shown in the first pane (a) */
  aTabId: string
  /** tab id shown in the second pane (b) */
  bTabId: string
  orientation: SplitOrientation
  /** share of the first pane (a); 0 closes a, 1 closes b */
  ratio: number
  /** the pane that holds focus */
  focus: 'a' | 'b'
}

/** Gap between the two panes, in CSS px (tuning value). */
export const SPLIT_DIVIDER_PX = 6
/** Minimum width of a pane, in CSS px (tuning value). */
export const SPLIT_MIN_PANE_PX = 240
/** Width of the window-edge drop zone, in CSS px (tuning value). */
export const SPLIT_EDGE_ZONE_PX = 120

/** Shell-internal channels for the split view. */
export const SPLIT_TABS_CHANNELS = {
  /** invoke: returns SplitViewState | null */
  get: 'tabs:get-split',
  /** push: SplitViewState | null */
  changed: 'tabs:split-changed',
  /** push: SplitHint | null */
  hint: 'tabs:split-hint',
  /** send: number */
  setRatio: 'tabs:set-split-ratio',
} as const

/** Where the divider would land for the current drag, in window content CSS px. */
export interface SplitHint {
  left: number
  top: number
  width: number
  height: number
  orientation: SplitOrientation
}

/**
 * The result of dragging a tab onto a drop zone. Consumers apply these six
 * outcomes as-is; they must not re-interpret the drag. "No intent" (nothing
 * to do on this drag) is represented as null wherever the intent is carried.
 */
export type SplitDropIntent =
  /** no split yet and the tab came from outside a pane: open it in the pane on
   *  the dropped side (b); the opposite pane keeps the previous document, or a
   *  copy when there is none */
  | { kind: 'create'; orientation: SplitOrientation }
  /** split exists in the same orientation and the tab came from outside a
   *  pane: replace the document of that orientation's pane with this tab */
  | { kind: 'replace' }
  /** split exists in the other orientation and the tab came from outside a
   *  pane: switch orientation and put the tab in the pane on the dropped side */
  | { kind: 'reorient'; orientation: SplitOrientation }
  /** the tab came from outside a pane but its document already sits in a
   *  pane: only focus that pane */
  | { kind: 'focus' }
  /** a tab from inside a pane was dropped on the other orientation's edge:
   *  switch orientation only */
  | { kind: 'flip'; orientation: SplitOrientation }
  /** a tab from inside a pane was dropped on the same or the opposite
   *  orientation's edge: do nothing */
  | { kind: 'noop' }
