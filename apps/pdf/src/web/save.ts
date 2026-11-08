import { saveToHost, webLanguage, type WebDocument } from '@seuoffice/web-platform'
import { applySaveRequest } from '../main/save-pdf'
import type { SavePdfRequest, SavePdfResult } from '../shared/ipc'

/**
 * Parts of a save whose writers need desktop engines: pdfium with system fonts
 * (text, images, saved-annotation removal, redaction) or Node crypto (password
 * protection). Everything else in a request is written by pdf-lib, which runs here.
 */
const DESKTOP_ONLY: { ko: string; en: string; in: (request: SavePdfRequest) => boolean }[] = [
  { ko: '텍스트 편집', en: 'text edits', in: (r) => (r.textEdits?.length ?? 0) > 0 },
  { ko: '텍스트 추가', en: 'added text', in: (r) => (r.textInserts?.length ?? 0) > 0 },
  { ko: '이미지 편집', en: 'image edits', in: (r) => (r.imageEdits?.length ?? 0) > 0 },
  {
    ko: '저장된 주석 삭제',
    en: 'removing saved annotations',
    in: (r) => (r.annotDeletes?.length ?? 0) > 0,
  },
  { ko: '영구 제거', en: 'redaction', in: (r) => (r.redactions?.length ?? 0) > 0 },
  {
    ko: '암호 보호',
    en: 'password protection',
    in: (r) =>
      r.encryption !== undefined || r.decryption !== undefined || r.protectionDirty === true,
  },
]

function refusal(parts: typeof DESKTOP_ONLY): string {
  if (webLanguage() === 'ko') {
    const names = parts.map((part) => part.ko).join(', ')
    return `웹에서 저장할 수 없는 편집이 있습니다(${names}). 되돌리거나 데스크톱 앱에서 저장하세요.`
  }
  const names = parts.map((part) => part.en).join(', ')
  return `${names} cannot be saved on the web: undo them or save in the desktop app`
}

/** A page the host opened for viewing keeps its edits on screen and never stores them */
export async function refuseViewOnly(): Promise<SavePdfResult> {
  const error =
    webLanguage() === 'ko'
      ? '보기 전용으로 연 문서라 저장할 수 없습니다.'
      : 'the document is open for viewing only'
  return { ok: false, error }
}

/**
 * The desktop save over the document held in the page: the edited bytes go to
 * the host, and once it stored them they are what the next open reads.
 */
export async function saveOnWeb(doc: WebDocument, request: SavePdfRequest): Promise<SavePdfResult> {
  const refused = DESKTOP_ONLY.filter((part) => part.in(request))
  if (refused.length > 0) return { ok: false, error: refusal(refused) }
  try {
    const { bytes } = await applySaveRequest(doc.bytes, request)
    await saveToHost(doc.fileName, bytes)
    doc.bytes = bytes
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
