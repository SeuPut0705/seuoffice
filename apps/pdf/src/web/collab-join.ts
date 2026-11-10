/**
 * The PDF page joining the host's co-editing session: the format it declares,
 * the adapter it builds once the renderer shows the document, and what the
 * person reads when the session refuses a change.
 */
import {
  joinPageCollab,
  webLanguage,
  type CollabStatus,
  type PageCollab,
  type WebDocument,
} from '@seuoffice/web-platform'
import { flushSync } from 'react-dom'
import type { PageSize } from '../renderer/view-config'
import type { PdfHost, Refusal } from './collab-adapter'
import type { PdfOp } from './collab-model'

/** What the renderer hands over (`window.seuCollab.attach`) once the opened document is on screen */
export interface PdfCollabHandles extends PdfHost {
  /** the opened file's pages, unrotated */
  pageSizes: readonly PageSize[]
  /** the open password of a protected file */
  password(): string | null
  /** the App's notice line */
  notice(text: string): void
  /** the toolbar's unsaved mark and Save button follow this instead of the App's own pending edits */
  unsaved(value: boolean): void
  /** commit what the person has open (a text edit, a comment being rewritten), as the App's save does */
  commitDrafts(): void
}

/** Bump `schema` when the op format changes: pages of two schemas must not share a session */
// 2: a rotation put turns the page's picture stamps itself, and a stamp's bytes travel once
const FORMAT = { name: 'pdf', schema: 2 }

const FEATURES = {
  text: ['글자를 고치거나 넣을 수 없습니다', 'text cannot be edited or added'],
  image: ['문서 안의 그림을 고칠 수 없습니다', 'images in the document cannot be edited'],
  savedAnnotation: ['파일에 저장된 주석을 지울 수 없습니다', 'saved annotations cannot be removed'],
  outline: ['책갈피를 고칠 수 없습니다', 'bookmarks cannot be edited'],
  attachments: ['첨부 파일을 더하거나 뺄 수 없습니다', 'attachments cannot be added or removed'],
  protection: ['암호 보호를 바꿀 수 없습니다', 'password protection cannot be changed'],
  redaction: ['영구 가림을 할 수 없습니다', 'nothing can be redacted'],
  fileOps: [
    '내보내기, 합치기, 나누기처럼 저장된 파일로 하는 작업을 할 수 없습니다',
    'exporting, merging, splitting and other work on the stored file is not available',
  ],
} as const

function refusalText(reason: Refusal): string {
  const ko = webLanguage() === 'ko'
  switch (reason.kind) {
    case 'feature': {
      const [korean, english] = FEATURES[reason.feature]
      return ko
        ? `여러 사람이 함께 편집하는 동안에는 ${korean}.`
        : `While several people edit this PDF, ${english}.`
    }
    case 'frozen':
      return ko
        ? '지금은 문서를 고칠 수 없습니다. 저장하는 중이거나 보기 전용입니다.'
        : 'The document cannot be changed now: it is being saved, or you may only view it.'
    case 'tooLarge': {
      const mb = (reason.bytes / (1024 * 1024)).toFixed(1)
      return ko
        ? `이 편집(${mb}MB)은 너무 커서 함께 편집하는 문서에 넣을 수 없습니다. 더 작은 그림을 쓰세요.`
        : `This edit (${mb} MB) is too large to share: use a smaller image.`
    }
    case 'lastPage':
      return ko
        ? '문서에는 쪽이 하나 이상 남아야 합니다.'
        : 'The document must keep at least one page.'
  }
}

const newId = (): string => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`

/**
 * Whether a person who may save has something to save: an edit of their own on the way to the
 * log, or edits in the log that no stored file holds. The App's own pending edits cannot say:
 * they are the whole session's since the base file, and no save ever clears them.
 */
export const sessionUnsaved = (status: CollabStatus): boolean =>
  status.canEdit && (status.unconfirmed > 0 || status.version > status.saved)

/**
 * Join before the renderer opens `doc`; a page that joins a running session
 * opens the session's base file, which the bridge puts into `doc.bytes`.
 */
export function joinPdfCollab(doc: WebDocument): Promise<PageCollab<PdfCollabHandles> | null> {
  let app: PdfCollabHandles | null = null
  return joinPageCollab<PdfCollabHandles, PdfOp>({
    status: (status) => app?.unsaved(sessionUnsaved(status)),
    // the host's save takes what the person is still typing, as the App's own save does
    hostSave: async (save) => {
      app?.commitDrafts()
      await save()
    },
    // a protected file asks for its password before anything can attach
    inputBeforeAttach: (target) => target instanceof Element && !!target.closest('.pdf-pwd-dialog'),
    format: FORMAT,
    fileName: doc.fileName,
    bytes: doc.bytes,
    adapter: async (handles) => {
      app = handles
      // a page that never co-edits never loads these
      const [{ MAX_CHANGE_BYTES }, { createPdfAdapter }, { produceCoEditedFile }] =
        await Promise.all([
          import('@seuoffice/collab/client'),
          import('./collab-adapter'),
          import('./collab-file'),
        ])
      const file = {
        path: doc.virtualPath,
        fileName: doc.fileName,
        bytes: doc.bytes,
        pageSizes: handles.pageSizes,
        password: handles.password,
      }
      const adapter = createPdfAdapter({
        host: handles,
        basePages: handles.pageSizes.length,
        produce: (state) => produceCoEditedFile(state, file),
        refused: (reason) => {
          const text = refusalText(reason)
          handles.notice(text)
          return text
        },
        // room for the submit frame and the op's own wrapper
        maxOpBytes: MAX_CHANGE_BYTES - 4096,
        newId,
      })
      return {
        ...adapter,
        // The App's undo closes over its history as last rendered: a peer's change and the
        // history it rewrote must be on screen before the next key press reaches it
        integrate: (remote, local) => flushSync(() => adapter.integrate(remote, local)),
      }
    },
  })
}
