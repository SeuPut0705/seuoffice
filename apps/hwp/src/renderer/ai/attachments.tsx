import type { ReactElement } from 'react'
import { ATTACHMENT_IMAGE_EXTS } from '../../shared/ipc'
import type { AttachmentMeta } from '../../shared/ipc'
import fileDocumentIcon from '../assets/file-document.png'
import fileExcelIcon from '../assets/file-excel.png'
import fileGeneralIcon from '../assets/file-general.png'
import fileImageIcon from '../assets/file-image.png'
import filePdfIcon from '../assets/file-pdf.png'
import filePptIcon from '../assets/file-ppt.png'
import fileWordIcon from '../assets/file-word.png'

/**
 * The attachment chips of the AI panel: the same pieces as the other editors'
 * panels (copied from the HTML panel), kept out of AiPanel.tsx.
 */

/** clipboard bitmap MIME → attachment extension (matches ATTACHMENT_IMAGE_EXTS) */
export const PASTE_MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
}

/** image attachments sent along with one message */
export const MAX_IMAGES_PER_MESSAGE = 20

const ATTACHMENT_CARD_ICONS: Record<string, string> = Object.fromEntries(
  (
    [
      // a Hangul document has no icon of its own here: it takes the word-processor one
      [fileWordIcon, ['doc', 'docx', 'odt', 'hwp', 'hwpx']],
      [fileExcelIcon, ['xls', 'xlsx', 'xlsm', 'csv', 'tsv']],
      [filePptIcon, ['ppt', 'pptx']],
      [filePdfIcon, ['pdf']],
      [fileImageIcon, ['png', 'jpg', 'jpeg', 'gif', 'webp']],
    ] as [string, string[]][]
  ).flatMap(([icon, exts]) => exts.map((ext) => [ext, icon])),
)

function formatAttachmentSize(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(2)} MB`
    : `${(bytes / 1024).toFixed(2)} KB`
}

/** composer chips (removable) and the read-only echo on a sent message share one renderer */
export function AttachmentList({
  atts,
  previews,
  onRemove,
  removeLabel,
}: {
  atts: AttachmentMeta[]
  previews: Record<string, string>
  onRemove?: (path: string) => void
  removeLabel?: string
}): ReactElement {
  const remove = (path: string) =>
    onRemove && (
      <button
        type="button"
        className="ai-attachment-thumb-remove"
        onClick={() => onRemove(path)}
        data-tip={removeLabel}
        aria-label={removeLabel}
      >
        <svg width="16" height="16" viewBox="0 0 32 32" aria-hidden>
          <path
            d="M24 9.4L22.6 8L16 14.6L9.4 8L8 9.4l6.6 6.6L8 22.6L9.4 24l6.6-6.6l6.6 6.6l1.4-1.4l-6.6-6.6L24 9.4z"
            fill="currentColor"
          />
        </svg>
      </button>
    )
  return (
    <>
      {atts.map((a) =>
        ATTACHMENT_IMAGE_EXTS.has(a.ext) ? (
          <span key={a.path} className="ai-attachment-thumb" title={a.name}>
            {previews[a.path] ? (
              <img src={previews[a.path]} alt={a.name} />
            ) : (
              <span className="ai-attachment-thumb-pending" aria-hidden>
                <img src={fileImageIcon} alt="" />
              </span>
            )}
            {remove(a.path)}
          </span>
        ) : (
          <span key={a.path} className="ai-attachment-card" title={a.path}>
            <span className="ai-attachment-card-icon">
              <img
                src={ATTACHMENT_CARD_ICONS[a.ext] ?? fileDocumentIcon ?? fileGeneralIcon}
                alt=""
                aria-hidden
              />
            </span>
            <span className="ai-attachment-card-meta">
              <span className="ai-attachment-card-name">{a.name}</span>
              <span className="ai-attachment-card-size">{formatAttachmentSize(a.sizeBytes)}</span>
            </span>
            {remove(a.path)}
          </span>
        ),
      )}
    </>
  )
}
