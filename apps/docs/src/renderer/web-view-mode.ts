/** True when the page was opened by the web embed with `?mode=view` (never set in the desktop app). */
export const webViewMode = (): boolean =>
  new URLSearchParams(globalThis.location?.search ?? '').get('mode') === 'view'
