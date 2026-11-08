/**
 * The AI and MCP side of the ODT rules (odt-gate.ts): tools for switched-off
 * features are not offered to the model in an ODT document, and a call that
 * reaches the executor anyway (an older tool list, an MCP client) is refused
 * with the reason. Edits the editor guard refuses (protected cells, locked
 * placeholders) come back as errors instead of silent no-ops.
 */
import type { AgentToolCall } from '../../shared/ipc'
import { isOdtSession, takeOdtRefusal, type OdtRefusal } from '../odt-gate'

/** tool name -> the switched-off feature it belongs to */
const ODT_OFF_TOOLS: Record<string, string> = {
  add_comment: 'new comments',
  reply_comment: 'comment replies',
  resolve_comment: 'resolving comments',
  accept_changes: 'tracked changes',
  reject_changes: 'tracked changes',
  insert_chart: 'charts',
  edit_chart: 'charts',
  set_watermark: 'watermarks',
  insert_text_box: 'text boxes',
}

/** insertField types for captions, cross-references, citations and tables of contents */
const OFF_FIELD_TYPES = new Set([
  'SEQ',
  'REF',
  'PAGEREF',
  'NOTEREF',
  'CITATION',
  'BIBLIOGRAPHY',
  'TOC',
])

export const ODT_SYSTEM_NOTE =
  '\n\nNote: the open document is an ODT (OpenDocument) file. In it, new comments, comment replies and resolving, tracked changes, charts, text boxes, shapes, equations (<formula>), watermarks, text columns, tables of contents, captions, cross-references and citations are not available: do not call tools for them or promise them (saving the document as .docx makes them available). ' +
  'Protected table cells (locked in Hancom Office) and locked object placeholders (pictures standing in for objects only Hancom Office shows) cannot be changed; edits that touch them are refused.'

/** the tools offered to the model: switched-off ones are left out in an ODT document */
export function odtToolFilter<T extends { name: string }>(tools: readonly T[]): readonly T[] {
  if (!isOdtSession()) return tools
  return tools.filter((tool) => !(tool.name in ODT_OFF_TOOLS))
}

const offMessage = (what: string): string =>
  `${what} are not available in this ODT document (saving it as .docx makes them available). Do not retry.`

/** the reason a tool call is refused in an ODT document, or null when it may run */
export function odtToolRefusal(call: AgentToolCall): string | null {
  if (!isOdtSession()) return null
  const off = ODT_OFF_TOOLS[call.name]
  if (off) return offMessage(off.charAt(0).toUpperCase() + off.slice(1))
  const input = (call.input ?? {}) as Record<string, unknown>
  if (call.name === 'set_page_setup' && input.columns !== undefined && input.columns !== null)
    return offMessage('Text columns')
  if (call.name === 'apply_ops' && Array.isArray(input.ops)) {
    for (const op of input.ops as Array<Record<string, unknown>>) {
      if (op?.op === 'insertToc') return offMessage('Tables of contents')
      if (
        op?.op === 'insertField' &&
        typeof op.type === 'string' &&
        OFF_FIELD_TYPES.has(op.type.toUpperCase())
      )
        return offMessage(`${op.type.toUpperCase()} fields (captions, cross-references, citations)`)
    }
  }
  return null
}

const REFUSAL_TEXT: Record<OdtRefusal, string> = {
  protectedCell:
    'The edit was refused: it would change a protected table cell (locked in Hancom Office). Leave protected cells unchanged.',
  lockedObject:
    'The edit was refused: locked object placeholders can only be deleted whole, never resized, replaced or otherwise changed.',
}

/** forget a refusal left over from before this tool call */
export function startOdtToolCall(): void {
  takeOdtRefusal()
}

/** the editor guard refused part of this tool call: its error text, else null */
export function odtGuardRefusalText(): string | null {
  const kind = takeOdtRefusal()
  return kind ? REFUSAL_TEXT[kind] : null
}
