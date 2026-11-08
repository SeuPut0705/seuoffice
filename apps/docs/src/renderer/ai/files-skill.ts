import type { AgentSkill } from '@genoffice/agent-core'
import { attachmentFolderLabel } from '@genoffice/ui'
import type { AttachmentMeta } from '../../shared/ipc'
import { ATTACHMENT_IMAGE_EXTS } from '../../shared/ipc'
import { t } from '../i18n/locale'

/**
 * Chat-attachment capability as an AgentSkill: the per-turn context lists the
 * attached local files, and read_attachment pages through their extracted
 * text (parsing happens in the main process; files never leave the machine).
 */

const READ_CHUNK_CHARS = 24_000

const FILES_SYSTEM_PROMPT = `## Attachments
The user may attach local files to the conversation (see the "attachment list" in each turn's context).
- When the user's request involves attachment content, read it with read_attachment first, then answer or write; do not guess content from file names.
- Long files are read in pages: the result reports the total character count and the current range; to continue, set offset to the end position of the previous slice.
- Image attachments (png/jpg/gif/webp) are already sent as images with the user message — just look at them; read_attachment is only for text-like attachments.
- Do not call read_attachment when there are no attachments or they are unrelated to the request.`

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}

/**
 * One line per attachment for the model's attachment list. When two or more
 * attachments share a file name (case-insensitive), each of those lines names
 * the folder directly containing the file, with the same label the composer
 * inserts, so the model can tell them apart. Only that one folder name is
 * added, never the rest of the path; every other line is unchanged.
 */
function attachmentListLines(list: readonly AttachmentMeta[]): string[] {
  const nameCounts = new Map<string, number>()
  for (const a of list) {
    const key = a.name.normalize('NFC').toLocaleLowerCase()
    nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1)
  }
  return list.map((a, i) => {
    const shared = (nameCounts.get(a.name.normalize('NFC').toLocaleLowerCase()) ?? 0) > 1
    const folder = shared ? attachmentFolderLabel(a.path) : ''
    const name = folder ? `${a.name} (folder: ${folder})` : a.name
    return `${i} | ${name} | .${a.ext} | ${formatSize(a.sizeBytes)}`
  })
}

export function createFilesSkill(getAttachments: () => AttachmentMeta[]): AgentSkill {
  return {
    id: 'files',
    systemPrompt: FILES_SYSTEM_PROMPT,
    tools: [
      {
        name: 'read_attachment',
        description:
          'Read the text content of an attachment (parsed locally). Long files are paged: read offset=0 first, then decide whether to continue based on the returned total character count.',
        inputSchema: {
          type: 'object',
          properties: {
            index: {
              type: 'integer',
              description: 'attachment index (0-based, see the attachment list)',
            },
            offset: { type: 'integer', description: 'start character position, default 0' },
          },
          required: ['index'],
        },
      },
    ],
    buildContext: () => {
      const list = getAttachments()
      if (list.length === 0) return ''
      const lines = attachmentListLines(list)
      return `Attachment list (index | file name | type | size):\n${lines.join('\n')}`
    },
    executeTool: async (call) => {
      if (call.name !== 'read_attachment') {
        return { output: `unknown tool: ${call.name}`, isError: true, summary: call.name }
      }
      const list = getAttachments()
      const index = Number(call.input.index)
      const att = Number.isInteger(index) ? list[index] : undefined
      if (!att) {
        return {
          output: 'invalid attachment index (see the attachment list)',
          isError: true,
          summary: t('aiSumReadAttachment'),
        }
      }
      // no text extraction for images: already provided as a multimodal image with the user message on send
      if (ATTACHMENT_IMAGE_EXTS.has(att.ext)) {
        return {
          output: `${att.name} is an image attachment already sent as an image with the user message; just look at the image in the message, no text to read.`,
          mutated: false,
          summary: t('aiSumImageAttachment', { name: att.name }),
        }
      }
      const offset = Math.max(0, Number(call.input.offset) || 0)
      const result = await window.desktop.readAttachment(att.path, offset, READ_CHUNK_CHARS)
      if (!result.ok) {
        return {
          output: result.error ?? 'read failed',
          isError: true,
          summary: t('aiSumRead', { name: att.name }),
        }
      }
      const end = (result.offset ?? 0) + (result.text?.length ?? 0)
      const header = `File ${att.name}, total characters ${result.totalChars}, this slice ${result.offset}-${end}${
        end < (result.totalChars ?? 0)
          ? ' (not finished, continue with offset=' + end + ')'
          : ' (end of file)'
      }`
      return {
        output: `${header}\n---\n${result.text ?? ''}`,
        mutated: false,
        summary: t('aiSumReadAttachmentName', { name: att.name }),
      }
    },
  }
}
