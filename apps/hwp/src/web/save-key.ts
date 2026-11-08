/**
 * Ctrl+S (Cmd+S on a Mac) runs `onSave`. The desktop main process takes the key in
 * `before-input-event` (hwp-main.ts) because the editor's iframe swallows it; a page has no such
 * hook, so its window and each same-origin frame in it listen in the capture phase, ahead of the
 * editor and of the browser's own "save page".
 */
export function watchSaveKey(onSave: () => void): void {
  const onKey = (event: KeyboardEvent): void => {
    if (event.code !== 'KeyS' || event.shiftKey || event.altKey) return
    if (!event.ctrlKey && !event.metaKey) return
    event.preventDefault()
    event.stopImmediatePropagation()
    onSave()
  }
  const listenIn = (win: Window | null): void => {
    try {
      // a frame's window is a new one after each navigation; the same listener is added once
      win?.addEventListener('keydown', onKey, true)
    } catch {
      // a cross-origin frame: not the editor
    }
  }
  const watchFrame = (frame: HTMLIFrameElement): void => {
    frame.addEventListener('load', () => listenIn(frame.contentWindow))
    listenIn(frame.contentWindow)
  }
  listenIn(window)
  document.querySelectorAll('iframe').forEach(watchFrame)
  new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node instanceof HTMLIFrameElement) watchFrame(node)
        else if (node instanceof Element) node.querySelectorAll('iframe').forEach(watchFrame)
      }
    }
  }).observe(document.documentElement, { childList: true, subtree: true })
}
