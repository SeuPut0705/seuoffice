/**
 * The rhwp engine's readers of `@seuoffice/file-parse` that hwp-main.ts and
 * memos.ts import, for the hwp groups: answers from the case as the Rust
 * fake `HwpEngine::hwp_to_text` / `hwp_memos_of` do.
 */
import { world } from './common.ts'

export interface HwpMemo {
  author?: string | null
  date?: string | null
  text?: string | null
  place?: string | null
}

export async function hwpToText(_bytes: Uint8Array): Promise<string> {
  const w = world()
  w.log.push(['hwpToText'])
  const a = w.answers.next('hwp_to_text')
  if (typeof a === 'string') return a
  if (a && typeof a === 'object') throw new Error(String((a as { error?: unknown }).error ?? ''))
  return ''
}

export async function hwpMemosOf(_bytes: Uint8Array): Promise<HwpMemo[]> {
  const w = world()
  w.log.push(['hwpMemosOf'])
  const a = w.answers.next('hwp_memos_of')
  if (Array.isArray(a)) {
    return a.map((m: Record<string, unknown>) => {
      const f = (k: string) => (typeof m[k] === 'string' ? (m[k] as string) : null)
      return { author: f('author'), date: f('date'), text: f('text'), place: f('place') }
    })
  }
  if (a && typeof a === 'object' && 'error' in a) throw new Error(String(a.error))
  return []
}
