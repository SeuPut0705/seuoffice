// @vitest-environment jsdom
/**
 * Documents dropped on the editor's frame open in tabs of their own; pictures go on to
 * the editor, which inserts them.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { openDocumentsDroppedOn } from '../src/renderer/editor-drop'

/** A drop carrying these files, at the frame's document. */
function dropOn(frame: HTMLIFrameElement, names: string[]) {
  const files = names.map((name) => new File(['x'], name))
  const event = new Event('drop', { bubbles: true, cancelable: true }) as DragEvent
  Object.defineProperty(event, 'dataTransfer', { value: { files, types: ['Files'] } })
  frame.contentDocument!.body.dispatchEvent(event)
  return event
}

/** The editor's own drop handler, inside the frame. */
function editorHears(frame: HTMLIFrameElement) {
  const heard: string[][] = []
  frame.contentDocument!.body.addEventListener('drop', (event) =>
    heard.push(Array.from((event as DragEvent).dataTransfer!.files).map((file) => file.name)),
  )
  return heard
}

const frames: HTMLIFrameElement[] = []
function makeFrame() {
  const frame = document.createElement('iframe')
  document.body.appendChild(frame)
  frames.push(frame)
  return frame
}
afterEach(() => {
  for (const frame of frames.splice(0)) frame.remove()
})

/** Opens what looks like a document, as the preload does by path. */
const opener = (opened: string[][]) => (files: File[]) => {
  const docs = files.map((file) => file.name).filter((name) => /\.(hwpx?|docx|pdf)$/i.test(name))
  if (docs.length > 0) opened.push(docs)
  return docs.length > 0
}

describe('dropping on the editor', () => {
  it('opens dropped documents, and the editor does not see the drop', () => {
    const frame = makeFrame()
    const heard = editorHears(frame)
    const opened: string[][] = []
    openDocumentsDroppedOn(frame, opener(opened))
    const event = dropOn(frame, ['보고서.hwp', '표.docx'])
    expect(opened).toEqual([['보고서.hwp', '표.docx']])
    expect(event.defaultPrevented).toBe(true)
    expect(heard).toEqual([])
  })

  it('leaves a picture to the editor', () => {
    const frame = makeFrame()
    const heard = editorHears(frame)
    const opened: string[][] = []
    openDocumentsDroppedOn(frame, opener(opened))
    const event = dropOn(frame, ['사진.png'])
    expect(opened).toEqual([])
    expect(event.defaultPrevented).toBe(false)
    expect(heard).toEqual([['사진.png']])
  })

  it('stops listening when asked', () => {
    const frame = makeFrame()
    const heard = editorHears(frame)
    const opened: string[][] = []
    const stop = openDocumentsDroppedOn(frame, opener(opened))
    stop()
    dropOn(frame, ['보고서.hwp'])
    expect(opened).toEqual([])
    expect(heard).toEqual([['보고서.hwp']])
  })
})
