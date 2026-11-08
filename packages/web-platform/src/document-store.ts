import { receiveOpen } from './embed-channel'

/** A document handed to this page through the embed channel */
export interface WebDocument {
  id: string
  fileName: string
  bytes: Uint8Array
  /** the path the desktop bridges pass around for this document */
  virtualPath: string
}

const byPath = new Map<string, WebDocument>()
let first: Promise<WebDocument | null> | undefined

/** The document the host sends first; null when the page is not framed */
export function waitForDocument(): Promise<WebDocument | null> {
  first ??= receiveOpen().then((open) => {
    if (!open) return null
    const id = crypto.randomUUID()
    const doc: WebDocument = {
      id,
      fileName: open.fileName,
      bytes: new Uint8Array(open.bytes),
      virtualPath: `/web/${id}/${open.fileName}`,
    }
    byPath.set(doc.virtualPath, doc)
    return doc
  })
  return first
}

export function documentByPath(path: string): WebDocument | undefined {
  return byPath.get(path)
}

/** `?mode=view`: the host asked for read mode */
export function viewMode(): boolean {
  return new URLSearchParams(location.search).get('mode') === 'view'
}

/** `?lang=`, Korean by default */
export function webLanguage(): string {
  return new URLSearchParams(location.search).get('lang') || 'ko'
}
