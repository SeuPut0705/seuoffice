import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, extname, isAbsolute } from 'node:path'
import { hwpToText } from '@genoffice/file-parse'
import { z } from 'zod'
import type { McpToolDefinition } from '../mcp-server'

/**
 * HWP reading: the registry's `hwp` family exposes read-only MCP access
 * (`mcp.read`, no session, no generation). An agent reads the text of a Hangul
 * document directly from disk, through the same engine the HWP editor runs.
 * Like read_pdf this is headless and always registered. Editing an HWP
 * document is done in the editor, by its own AI panel.
 */

const HWP_EXTS = new Set(['.hwp', '.hwpx'])
/** hard cap on returned text so one huge document cannot flood the agent's context */
export const HWP_MAX_CHARS = 80_000

/**
 * One window of a document's text. `truncated` says there is more after it, and
 * `nextOffset` is where to go on.
 */
export function hwpTextWindow(
  text: string,
  offset: number,
): { text: string; totalChars: number; offset: number; truncated: boolean; nextOffset?: number } {
  const start = Math.min(Math.max(0, Math.trunc(offset) || 0), text.length)
  const end = Math.min(text.length, start + HWP_MAX_CHARS)
  return {
    text: text.slice(start, end),
    totalChars: text.length,
    offset: start,
    truncated: end < text.length,
    ...(end < text.length ? { nextOffset: end } : {}),
  }
}

/** The text of an HWP / HWPX file; failures come back as one plain tool error. */
export async function readHwpFile(filePath: string): Promise<string> {
  const bytes = new Uint8Array(await readFile(filePath))
  return hwpToText(bytes)
}

export function createHwpTools(): McpToolDefinition[] {
  return [
    {
      name: 'read_hwp',
      description:
        'Read the text of a Hangul word processor document (.hwp or .hwpx): paragraphs as ' +
        'lines, data tables as rows with cells joined by " | ". The text is what is saved on ' +
        `disk. Long documents are returned ${HWP_MAX_CHARS} characters at a time; pass the ` +
        '`nextOffset` of one answer as `offset` to read on. A password-protected document ' +
        'cannot be read.',
      inputSchema: {
        path: z.string().describe('absolute path to a .hwp or .hwpx file'),
        offset: z.number().int().min(0).optional().describe('character to start from; default 0'),
      },
      handler: async (args) => {
        const filePath = String(args.path ?? '')
        if (!isAbsolute(filePath)) throw new Error('path must be absolute')
        if (!HWP_EXTS.has(extname(filePath).toLowerCase()))
          throw new Error('path must point to a .hwp or .hwpx file')
        if (!existsSync(filePath)) throw new Error(`file not found: ${filePath}`)
        const text = await readHwpFile(filePath)
        return {
          path: filePath,
          name: basename(filePath),
          ...hwpTextWindow(text, typeof args.offset === 'number' ? args.offset : 0),
        }
      },
    },
  ]
}
