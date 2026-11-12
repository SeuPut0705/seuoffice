/**
 * The app-side half of model file naming.
 *
 * ## What lives here and what does not
 *
 * The main process owns the model call and the timeout
 * (`apps/shell/src/main/ai-naming-service.ts`). What it deliberately does *not*
 * own is the text: only an editor knows which of its spans are withheld from
 * the model, so the caller has to pass the **projected** text. That is the whole
 * safety property, and it is why this helper takes content rather than a
 * document — there is no path by which raw text reaches the model from here.
 *
 * ## A name, or the reason there is none
 *
 * `suggestFileName` never throws and never returns a name it is not sure of.
 * Every way the attempt can end without a name — no shell, nothing to send, no
 * provider, the first-connection notice still unread, a timeout, a refusal, a
 * reply that sanitised away to nothing — is a failure carrying its reason. The
 * caller keeps the name it already had, which is the only acceptable outcome:
 * a rename that costs the reader their file name is worse than no rename at
 * all. It also tells the reader why (`fileNamingFailureText`): a command that
 * ends without a word looks broken.
 */
import type { AiProviderId, AiRunErrorKind } from '@genoffice/ai-provider/browser'
import type { Lang } from '@genoffice/i18n'
import { aiRunErrorText } from './ai-subscription'
import { aiNamingText } from './strings-ai-naming'
import { aiSubscriptionText } from './strings-ai-subscription'

export interface SuggestFileNameOptions {
  /**
   * The text the **model** is allowed to see. Pass the editor's projected view,
   * never the raw document — withheld spans must stay withheld from this call
   * too, and this is the only place the text is handed over.
   */
  content: string
}

/** Why a naming attempt gave no name */
export type FileNamingFailure =
  /** this window has no naming bridge: there is no shell behind it (the web build) */
  | { readonly reason: 'unavailable' }
  /** the projected text is empty: there is nothing to name the file from */
  | { readonly reason: 'no-text' }
  /** a subscription would answer, and its first-connection notice is still unread */
  | { readonly reason: 'notice' }
  /** no provider can run; `kind` and `provider` say which connection is missing */
  | {
      readonly reason: 'not-connected'
      readonly kind: AiRunErrorKind
      readonly provider?: AiProviderId | undefined
    }
  /** the provider did not answer within the main process's time limit */
  | { readonly reason: 'timeout' }
  /** the provider failed, or answered nothing usable as a name */
  | { readonly reason: 'failed' }

export type FileNameSuggestion =
  { readonly ok: true; readonly name: string } | ({ readonly ok: false } & FileNamingFailure)

/** What the main process answers on `ai:suggest-file-name` */
interface NamingReply {
  ok: boolean
  name?: string
  reason?: string
  errorKind?: string
  provider?: string
}

interface NamingApi {
  suggestFileName?: (input: { content: string }) => Promise<NamingReply>
}

/**
 * The naming bridge.
 *
 * One global, one name: every window that can name a file exposes the channel
 * as `aiNamingApi` — the shell for its own button, each editor for its own.
 *
 * The shell's `aiOffice` namespace is deliberately **not** used here. It is
 * the shell's home API, and a second, partial `aiOffice` in an editor window
 * would shadow the real one in that window: `window.aiOffice.setTheme` would
 * disappear, and anything that identifies the shell window by that global —
 * the e2e suite included — would find the editor instead.
 */
function api(): NamingApi {
  return (window as unknown as { aiNamingApi?: NamingApi }).aiNamingApi ?? {}
}

/** The failure a declined reply stands for; a reason this build does not know is a plain failure */
function failureOf(reply: NamingReply | null | undefined): FileNamingFailure {
  switch (reply?.reason) {
    case 'notice':
    case 'timeout':
      return { reason: reply.reason }
    case 'empty-content':
      return { reason: 'no-text' }
    case 'not-connected':
      return {
        reason: 'not-connected',
        // the kind only picks a sentence: one that has none reads as "not connected"
        kind: (reply.errorKind ?? 'not-connected') as AiRunErrorKind,
        ...(reply.provider ? { provider: reply.provider as AiProviderId } : {}),
      }
    default:
      return { reason: 'failed' }
  }
}

/**
 * Ask the model for a file name.
 *
 * Returns the name, or why the model gave none. The caller puts the name in
 * front of the reader before anything is written.
 */
export async function suggestFileName(
  options: SuggestFileNameOptions,
): Promise<FileNameSuggestion> {
  const call = api().suggestFileName
  if (!call) return { ok: false, reason: 'unavailable' }
  // nothing worth sending: an empty document has no name to derive
  if (!options.content.trim()) return { ok: false, reason: 'no-text' }
  try {
    const reply = await call({ content: options.content })
    if (!reply?.ok) return { ok: false, ...failureOf(reply) }
    // an empty name is a failed naming, not a request to name the file ""
    const name = reply.name?.trim()
    return name ? { ok: true, name } : { ok: false, reason: 'failed' }
  } catch {
    return { ok: false, reason: 'failed' }
  }
}

/** The status line while a naming request is out */
export function fileNamingRunningText(lang: Lang): string {
  return aiNamingText(lang, 'running')
}

/** The sentence that tells the reader why "Name with AI" gave no name */
export function fileNamingFailureText(lang: Lang, failure: FileNamingFailure): string {
  switch (failure.reason) {
    case 'unavailable':
      return aiNamingText(lang, 'unavailable')
    case 'no-text':
      return aiNamingText(lang, 'noText')
    case 'notice':
      return aiNamingText(lang, 'noticeFirst')
    case 'not-connected':
      // the wording of a blocked AI run, so the panel and this command agree
      return (
        aiRunErrorText(lang, { kind: failure.kind, provider: failure.provider }) ??
        aiSubscriptionText(lang, 'errNotConnected')
      )
    case 'timeout':
      return aiNamingText(lang, 'timeout')
    case 'failed':
      return aiNamingText(lang, 'failed')
  }
}

/** Where one editor shows a naming attempt: the place it already shows save and AI status */
export interface FileNamingStatus {
  /** the request is out: `text` stays up until this is called again with null */
  running(text: string | null): void
  /** the attempt ended without a name, and `text` says why */
  failed(text: string): void
}

/**
 * One "Name with AI" attempt as the reader sees it: that it is running, and,
 * when it gives no name, why. Returns the name to put into the Save As dialog,
 * or null after the reason was shown.
 *
 * Nothing stays on screen once a name is in, so a reader who then cancels the
 * dialog is left with what was there before.
 */
export async function runFileNaming(
  lang: Lang,
  status: FileNamingStatus,
  suggest: () => Promise<FileNameSuggestion>,
): Promise<string | null> {
  status.running(fileNamingRunningText(lang))
  let suggestion: FileNameSuggestion
  try {
    suggestion = await suggest()
  } finally {
    status.running(null)
  }
  if (suggestion.ok) return suggestion.name
  status.failed(fileNamingFailureText(lang, suggestion))
  return null
}
