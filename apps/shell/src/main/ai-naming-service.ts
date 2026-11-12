import { app, ipcMain } from 'electron'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { chatForProvider } from '@seuoffice/ai-provider'
import { sharedSubscriptionStatuses } from '@seuoffice/ai-provider/subscription'
import { buildNamingInstruction, excerptForNaming, sanitizeFileStem } from './ai-naming'
import { resolveNamingProvider, type NamingRefusal, type NamingTarget } from './ai-naming-provider'

/** The channel the renderer's "Name with AI…" button calls. */
export const AI_NAMING_SUGGEST_CHANNEL = 'ai:suggest-file-name'

/**
 * The AI settings file as it is on disk: a plain `ai-settings.json` in
 * userData. The naming service is registered from the same process as
 * `registerAiIpc`, so it can read the file itself rather than round-tripping
 * the value through an IPC hop that already exists for renderers.
 */
function readAiSettingsFile(): unknown {
  try {
    return JSON.parse(
      readFileSync(join(app.getPath('userData'), 'ai-settings.json'), 'utf8'),
    ) as unknown
  } catch {
    // no file yet, or unreadable: the default settings, as for every other reader
    return {}
  }
}

/** A naming call that has not answered by then is not going to */
const NAMING_TIMEOUT_MS = 30_000

/**
 * What the channel answers: a name, or why there is none. The editor shows the
 * reason (`suggestFileName` in @seuoffice/ui); a naming that ends without a
 * word looks like a broken command.
 */
export type NamingReply =
  | { ok: true; name: string }
  | ({ ok: false } & NamingRefusal)
  | {
      ok: false
      reason:
        | 'empty-content' // there was no text to name the file from
        | 'timeout' // the provider did not answer within NAMING_TIMEOUT_MS
        | 'failed' // the provider answered with an error, or could not be reached
        | 'empty-name' // the answer held nothing usable as a file name
    }

/**
 * Ask the model for a name: a bare file stem, or why it gave none.
 *
 * One one-shot chat on the provider every other AI request would run on, and
 * the first line of its answer. If the provider is unreachable the caller
 * keeps whatever name the document already has — a failed rename must never
 * cost the reader their file.
 */
async function askModel(
  target: Extract<NamingTarget, { ok: true }>,
  content: string,
  lang: string,
): Promise<NamingReply> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), NAMING_TIMEOUT_MS)
  // a provider cut off by the timer rejects or reports a failed reply, depending
  // on the provider: either way the reason is the timer, not the provider
  const failure = (): NamingReply => ({
    ok: false,
    reason: controller.signal.aborted ? 'timeout' : 'failed',
  })
  let out: string
  try {
    const result = await chatForProvider(
      target.provider,
      target.config,
      '',
      buildNamingInstruction(excerptForNaming(content), lang),
      controller.signal,
    )
    if (!result.ok) {
      console.warn('[shell] file naming failed:', result.error)
      return failure()
    }
    out = result.content ?? ''
  } catch (err) {
    console.warn('[shell] file naming failed:', err)
    return failure()
  } finally {
    clearTimeout(timer)
  }
  // a model that wrapped the name in a sentence still gets one usable line
  const name = sanitizeFileStem(out.split('\n').find((line) => line.trim()) ?? '')
  // A stem that sanitised away to empty is a *failed* naming, not a successful
  // one handing back "". The caller's contract is that it keeps whatever name
  // the document already had, and returning ok:true with an empty name would
  // instead rename the file to nothing.
  return name ? { ok: true, name } : { ok: false, reason: 'empty-name' }
}

/**
 * The naming bridge's only channel.
 *
 * There is no preference and no automatic path: a name is proposed because the
 * reader asked for one, and the caller puts it in front of them.
 */
export function registerAiNamingIpc(lang: () => string): void {
  ipcMain.handle(
    AI_NAMING_SUGGEST_CHANNEL,
    async (_event, input: { content?: unknown }): Promise<NamingReply> => {
      const content = typeof input?.content === 'string' ? input.content : ''
      if (!content.trim()) return { ok: false, reason: 'empty-content' }
      // decided before anything is built for the model: a refusal sends nothing
      const target = resolveNamingProvider(readAiSettingsFile(), sharedSubscriptionStatuses())
      return target.ok ? askModel(target, content, lang()) : target
    },
  )
}
