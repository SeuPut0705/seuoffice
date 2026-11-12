import { normalizeLang, type Lang } from '@seuoffice/i18n'
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

/** `?mode=edit`: the host holds the edit lock and will store what the page saves */
export function editMode(): boolean {
  return new URLSearchParams(location.search).get('mode') === 'edit'
}

/**
 * `?lang=` as the host wrote it; Korean when the host passes none. It names more
 * languages than the UI has: what a document is drawn for follows this value.
 */
export function webRequestedLanguage(): string {
  return new URLSearchParams(location.search).get('lang') || 'ko'
}

/** `?lang=` as a UI language; Korean when the host passes none */
export function webLanguage(): Lang {
  return normalizeLang(webRequestedLanguage())
}
