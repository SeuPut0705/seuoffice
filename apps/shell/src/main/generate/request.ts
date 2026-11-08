/**
 * The generate request (8.1) and its checks. Every entry point builds the
 * same request; the main process checks it again before anything opens,
 * whatever the window last showed.
 */
import { isAbsolute } from 'node:path'
import {
  AI_TARGET_KINDS,
  CONVERT_KINDS,
  type AiTargetKind,
  type ConvertKind,
  type GenerateMode,
  type GenerateRequest,
} from '../../shared/generate-api'
import { MAX_MATERIALS, MAX_REQUEST_TEXT_CHARS } from './limits'
import {
  extOf,
  inspectMaterial,
  materialKey,
  summarizeMaterials,
  type MaterialStatus,
} from './materials'

export type RequestShapeError =
  | 'bad-mode'
  | 'bad-kind'
  | 'no-material'
  | 'too-many'
  | 'bad-path'
  | 'bad-text'
  | 'convert-needs-one'
  | 'convert-source-mismatch'

export function isAiTargetKind(value: unknown): value is AiTargetKind {
  return typeof value === 'string' && (AI_TARGET_KINDS as readonly string[]).includes(value)
}

export function isConvertKind(value: unknown): value is ConvertKind {
  return typeof value === 'string' && (CONVERT_KINDS as readonly string[]).includes(value)
}

/** 8.6: the one source type each conversion reads */
const CONVERT_SOURCE_EXTS: Record<ConvertKind, readonly string[]> = {
  'mindmap-to-markdown': ['xmind'],
  'mindmap-to-slides': ['xmind'],
  'markdown-to-mindmap': ['md', 'markdown'],
}

/**
 * 8.6: the conversions a material list allows — only when there is exactly
 * one material and its type is the conversion's source. The window offers
 * these alongside the AI kinds once conversions exist (a later task).
 */
export function availableConversions(materialPaths: readonly string[]): ConvertKind[] {
  if (materialPaths.length !== 1) return []
  const ext = extOf(materialPaths[0])
  return CONVERT_KINDS.filter((kind) => CONVERT_SOURCE_EXTS[kind].includes(ext))
}

/**
 * Shape check: mode and kind go together, at least one and at most
 * `MAX_MATERIALS` absolute paths (duplicates folded), text only for `ai`.
 * Whether each file can actually be read is `prepareGenerateRequest`'s job.
 */
export function validateGenerateRequest(
  raw: unknown,
): { ok: true; request: GenerateRequest } | { ok: false; error: RequestShapeError } {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const mode = input.mode as GenerateMode
  if (mode !== 'ai' && mode !== 'convert') return { ok: false, error: 'bad-mode' }
  const kind = input.kind
  if (mode === 'ai' ? !isAiTargetKind(kind) : !isConvertKind(kind)) {
    return { ok: false, error: 'bad-kind' }
  }
  if (!Array.isArray(input.materials) || input.materials.length === 0) {
    return { ok: false, error: 'no-material' }
  }
  const materials: string[] = []
  const seen = new Set<string>()
  for (const path of input.materials) {
    if (typeof path !== 'string' || !path || path.length > 4096 || !isAbsolute(path)) {
      return { ok: false, error: 'bad-path' }
    }
    const key = materialKey(path)
    if (seen.has(key)) continue
    seen.add(key)
    materials.push(path)
  }
  if (materials.length > MAX_MATERIALS) return { ok: false, error: 'too-many' }
  const text = input.text ?? ''
  if (typeof text !== 'string' || text.length > MAX_REQUEST_TEXT_CHARS) {
    return { ok: false, error: 'bad-text' }
  }
  if (mode === 'convert') {
    if (text.trim()) return { ok: false, error: 'bad-text' }
    if (materials.length !== 1) return { ok: false, error: 'convert-needs-one' }
    if (!availableConversions(materials).includes(kind as ConvertKind)) {
      return { ok: false, error: 'convert-source-mismatch' }
    }
  }
  return { ok: true, request: { mode, kind: kind as GenerateRequest['kind'], materials, text } }
}

export type PrepareError = RequestShapeError | 'no-readable-material' | 'unsaved-material'

/**
 * The request as it may go ahead: the shape is valid, every material was
 * read again just now, the unreadable ones are left out (with their reasons),
 * and nothing is open with unsaved changes. Applies to `ai` and `convert`.
 */
export async function prepareGenerateRequest(
  raw: unknown,
  inspect: (path: string) => Promise<MaterialStatus> = (path) => inspectMaterial(path),
): Promise<
  | { ok: true; request: GenerateRequest; ready: MaterialStatus[]; excluded: MaterialStatus[] }
  | { ok: false; error: PrepareError; unsaved?: MaterialStatus[]; excluded?: MaterialStatus[] }
> {
  const shape = validateGenerateRequest(raw)
  if (!shape.ok) return shape
  const statuses = await Promise.all(shape.request.materials.map((p) => inspect(p)))
  const kindForNotices: AiTargetKind = isAiTargetKind(shape.request.kind)
    ? shape.request.kind
    : 'mindmap'
  const summary = summarizeMaterials(statuses, kindForNotices)
  if (summary.unsaved.length > 0) {
    return {
      ok: false,
      error: 'unsaved-material',
      unsaved: summary.unsaved,
      excluded: summary.excluded,
    }
  }
  if (summary.ready.length === 0) {
    return { ok: false, error: 'no-readable-material', excluded: summary.excluded }
  }
  return {
    ok: true,
    request: { ...shape.request, materials: summary.ready.map((s) => s.path!) },
    ready: summary.ready,
    excluded: summary.excluded,
  }
}
