/**
 * Documents dropped on the editor open in tabs of their own, as they do anywhere else in
 * the app. The editor runs in a frame the page's drop bridge does not hear, and in the
 * embedded mode it ignores dropped documents. So the drop is taken at the frame's window,
 * before the editor sees it, when it carries a document; a drop of pictures goes on to
 * the editor, which inserts them.
 *
 * `open` opens the documents among the files and says whether there were any. Returns
 * the function that stops listening.
 */
export function openDocumentsDroppedOn(
  frame: HTMLIFrameElement,
  open: (files: File[]) => boolean,
): () => void {
  let listening: Window | null = null
  const onDrop = (event: DragEvent) => {
    const files = Array.from(event.dataTransfer?.files ?? [])
    if (files.length === 0 || !open(files)) return
    event.preventDefault()
    event.stopPropagation()
  }
  const listen = () => {
    const win = frame.contentWindow
    if (!win || win === listening) return
    listening?.removeEventListener('drop', onDrop, true)
    // the capture phase at the window comes before any handler inside the editor
    win.addEventListener('drop', onDrop, true)
    listening = win
  }
  listen()
  // a reload of the editor (a new language) is a new window
  frame.addEventListener('load', listen)
  return () => {
    frame.removeEventListener('load', listen)
    listening?.removeEventListener('drop', onDrop, true)
    listening = null
  }
}
