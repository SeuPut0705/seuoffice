/**
 * The file of a co-edited PDF: the session's base bytes with the pending edits
 * written by the desktop save code (`applySaveRequest`), the way the App's
 * `editsPayload` hands them to it. Nothing here touches the App: no reload, no
 * page remapping, no clearing of edits.
 */
import type { EditSnapshot } from '../renderer/edit-state'
import { buildStamps } from '../renderer/stamps'
import type { PageSize } from '../renderer/view-config'
import { applySaveRequest } from '../main/save-pdf'
import type { SavePdfRequest } from '../shared/ipc'

export interface CoEditedFile {
  path: string
  fileName: string
  /** the epoch's base: what every client opened */
  bytes: Uint8Array
  /** the opened file's pages, unrotated, as the App measured them */
  pageSizes: readonly PageSize[]
  /** the open password of a protected file, kept on the output */
  password(): string | null
}

/**
 * `editsPayload` over a snapshot. Text, image and saved-annotation edits are
 * never pending while co-editing (the session refuses them), outline,
 * attachment and protection changes neither; static form fills come only from
 * image edits on the web, where the saved list is empty.
 */
export function saveRequestOf(s: EditSnapshot, file: CoEditedFile): SavePdfRequest {
  const sizes = [...file.pageSizes]
  for (const b of s.blankPages) sizes[b.input.pageIndex] = b.input
  const visible = (s.order ?? sizes.map((_, i) => i)).filter((i) => !s.deleted.has(i))
  const password = file.password()
  return {
    path: file.path,
    markups: s.markups.map(({ id: _id, ...rest }) => rest),
    annotDeletes: [],
    noteEdits: s.noteEdits.map((e) => ({
      pageIndex: e.annot.pageIndex,
      objNum: e.annot.objNum,
      rect: e.annot.rect,
      oldContents: e.annot.contents,
      contents: e.contents,
    })),
    drawings: s.drawings.map((d) => d.input),
    textEdits: [],
    textInserts: [],
    imageEdits: [],
    staticFormFills: [],
    stamps: s.stampCfg
      ? buildStamps(
          visible.map((origIdx, i) => ({
            origIdx,
            pw: sizes[origIdx]!.width,
            ph: sizes[origIdx]!.height,
            displayNo: i + 1,
          })),
          s.stampCfg.wm,
          s.stampCfg.hf,
        )
      : [],
    formValues: [...s.formEdits.values()],
    formFields: s.formFields.map((f) => f.input),
    blankPages: s.blankPages.map((b) => b.input),
    formWidgetEdits: [...s.formWidgetEdits.values()],
    rotations: [...s.rotations].map(([pageIndex, delta]) => ({ pageIndex, delta })),
    deletedPages: [...s.deleted],
    ...(s.order ? { pageOrder: visible } : {}),
    ...(s.metadata ? { metadata: s.metadata } : {}),
    protectionDirty: false,
    ...(password !== null ? { decryption: { userPassword: password } } : {}),
  }
}

export async function produceCoEditedFile(
  s: EditSnapshot,
  file: CoEditedFile,
): Promise<{ fileName: string; bytes: Uint8Array }> {
  const { bytes } = await applySaveRequest(file.bytes, saveRequestOf(s, file))
  return { fileName: file.fileName, bytes }
}
