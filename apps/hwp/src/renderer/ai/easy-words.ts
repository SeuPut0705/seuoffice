import type { Params } from '@genoffice/i18n'
import type { AgentEasyWordsDetail } from '../../../studio-plugin/agent-plugin.mjs'

/** A request for the AI panel: `autoRun` sends it as soon as it arrives. */
export interface AiPrefill {
  text: string
  nonce: number
  autoRun?: boolean
}

/**
 * The handed request once the panel has taken `taken` (sent an `autoRun` one, put any other
 * in its input box): it is cleared, so a panel that mounts again (the print preview closing,
 * a reload) neither sends it a second time nor puts it back in the box. A newer request that
 * arrived meanwhile stays to be taken.
 */
export function afterPrefillTaken(current: AiPrefill | null, taken: AiPrefill): AiPrefill | null {
  return current?.nonce === taken.nonce ? null : current
}

type Translate = (key: 'easyWordsPrompt', params?: Params) => string

/**
 * The request a click on the editor's 쉬운 말로 풀기 sends: explain the selected text in
 * plain words, in the language of the screen, without changing the document. Nothing when
 * the event carries no text (the plugin fires it only with some).
 */
export function easyWordsRequest(detail: unknown, t: Translate, nonce: number): AiPrefill | null {
  const text = (detail as Partial<AgentEasyWordsDetail> | null)?.text
  if (typeof text !== 'string' || !text.trim()) return null
  return { text: t('easyWordsPrompt', { text: text.trim() }), nonce, autoRun: true }
}
