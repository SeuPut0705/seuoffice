/**
 * Group `a/ai-naming`: the "Name with AI..." channel of the shell
 * (`apps/shell/src/main/ai-naming-service.ts`, `ai:suggest-file-name`),
 * registered as the shell entry registers it (`registerAiNamingIpc(() => lang)`).
 *
 * What the Rust port reaches through its batch hosts is stood in here, from
 * the same `hosts.a.aiNaming` (crates/shell-ipc/a/src/probe/ai_naming.rs
 * describes its keys and the host log line, written the same here):
 * `chatForProvider` of `@seuoffice/ai-provider` is the case's script (the
 * provider transports have their own group), and `sharedSubscriptionStatuses`
 * of `@seuoffice/ai-provider/subscription` answers `statuses`. Every other
 * export of both is the real module's. The settings file is the case's
 * `userData/ai-settings.json`, read by both sides.
 *
 * Not covered here (the unit tests of the Rust port do): the 30 second timer
 * that makes a call `timeout`: the gate cannot wait for it.
 */
import { registerHooks } from 'node:module'
import type { Call, Case, Group, LoadContext } from '../../types.ts'

const MODULE = 'apps/shell/src/main/ai-naming-service.ts'
type AiNamingService = typeof import('../../../../apps/shell/src/main/ai-naming-service.ts')

const HOST = Symbol.for('ipc-diff.a.ai-naming')
const PROVIDER = 'ipc-diff:ai-provider'
const SUBSCRIPTION = 'ipc-diff:ai-provider-subscription'
/** the real modules the stand-ins re-export, found when the specifiers are first resolved */
const real: Record<string, string> = {}

const forward = (name: string): string =>
  `export const ${name} = (...args) => globalThis[Symbol.for('ipc-diff.a.ai-naming')].${name}(...args)`

// synchronous hooks, as tools/main-diff/electron-fake.ts: they answer `import` and `require`
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@seuoffice/ai-provider') {
      real[PROVIDER] = next(specifier, context).url
      return { url: PROVIDER, shortCircuit: true }
    }
    if (specifier === '@seuoffice/ai-provider/subscription') {
      real[SUBSCRIPTION] = next(specifier, context).url
      return { url: SUBSCRIPTION, shortCircuit: true }
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (url === PROVIDER || url === SUBSCRIPTION) {
      const names = url === PROVIDER ? ['chatForProvider'] : ['sharedSubscriptionStatuses']
      const source = `export * from ${JSON.stringify(real[url])}\n${names.map(forward).join('\n')}`
      return { format: 'module', source, shortCircuit: true }
    }
    return next(url, context)
  },
})

// ---- hosts.a.aiNaming ----------------------------------------------------------------

interface ChatSpec {
  content?: string
  noContent?: boolean
  ok?: boolean
  error?: string
  throws?: string
}
interface World {
  statuses?: Record<string, unknown>
  chats?: ChatSpec[]
}

async function load(cx: LoadContext): Promise<void> {
  const hostsA = (cx.case.hosts?.a ?? {}) as { aiNaming?: World; lang?: string }
  const world = hostsA.aiNaming ?? {}
  const chats = [...(world.chats ?? [])]
  ;(globalThis as Record<symbol, unknown>)[HOST] = {
    chatForProvider: async (
      provider: string,
      config: { model?: string } | undefined,
      _system: string,
      user: string,
    ) => {
      cx.electron.log.push(['chatForProvider', provider, config?.model ?? null, user])
      const answer = chats.shift() ?? { ok: false, error: 'no scripted chat' }
      if (answer.throws !== undefined) throw new Error(answer.throws)
      if (answer.ok === false) return { ok: false, error: answer.error }
      if (answer.noContent === true) return { ok: true }
      return { ok: true, content: answer.content }
    },
    sharedSubscriptionStatuses: () => world.statuses ?? {},
  }
  const mod = await cx.fresh<AiNamingService>(MODULE)
  mod.registerAiNamingIpc(() => hostsA.lang ?? 'ko')
}

// ---- cases -----------------------------------------------------------------------------------

/** settings that select the API-key provider `openai` */
const keySettings = {
  'userData/ai-settings.json': JSON.stringify({
    provider: 'openai',
    providers: { openai: { apiKey: 'sk-test', model: 'gpt-x' } },
  }),
}
const name = (content: unknown): Call => ({ channel: 'ai:suggest-file-name', args: [{ content }] })
const aiNaming = (world: World, rest: Record<string, unknown> = {}) => ({
  a: { aiNaming: world, ...rest },
})

const cases: Case[] = [
  {
    note: 'no text to name the file from: nothing is asked',
    files: keySettings,
    hosts: aiNaming({ chats: [{ content: 'Never asked' }] }),
    calls: [
      name('  \n '),
      name(42),
      { channel: 'ai:suggest-file-name', args: [null] },
      { channel: 'ai:suggest-file-name', args: [] },
    ],
  },
  {
    note: 'no connected provider, and no settings file at all',
    hosts: aiNaming({ chats: [{ content: 'Never asked' }] }),
    calls: [name('A quarterly report')],
  },
  {
    note: 'a subscription that is ready but whose notice was never read',
    files: { 'userData/ai-settings.json': JSON.stringify({ provider: 'claude-code' }) },
    hosts: aiNaming({
      statuses: { 'claude-code': { provider: 'claude-code', state: 'ready' } },
      chats: [{ content: 'Never asked' }],
    }),
    calls: [name('A quarterly report')],
  },
  {
    note: 'the first non-blank line of the reply is the name, cleaned of quotes, extension and path',
    files: keySettings,
    hosts: aiNaming({
      chats: [
        { content: '\n"Q3 Revenue Report.md"\nA second line' },
        { content: '/home/me/Notes/Weekly plan' },
        { content: 'x'.repeat(80) },
        { content: 'con' },
      ],
    }),
    calls: [
      name('Quarterly revenue by region'),
      name('Plans for the week'),
      name('A very long name'),
      name('A reserved name'),
    ],
  },
  {
    note: 'the instruction is cut at the excerpt limit and asks in the UI language',
    files: keySettings,
    hosts: aiNaming({ chats: [{ content: 'Long text' }] }, { lang: 'en' }),
    calls: [name(`${'word '.repeat(2000)}\n\n\n\nend`)],
  },
  {
    note: 'a reply with nothing usable, a failed chat, a provider that rejects, no content at all',
    files: keySettings,
    hosts: aiNaming({
      chats: [
        { content: '...' },
        { ok: false, error: 'boom' },
        { throws: 'network down' },
        { noContent: true },
      ],
    }),
    calls: [name('text'), name('text'), name('text'), name('text')],
  },
]

export const group: Group = {
  batch: 'A',
  load,
  cases,
}
