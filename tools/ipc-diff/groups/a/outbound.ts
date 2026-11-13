/**
 * Group `a/outbound`: asking before the AI reaches the internet
 * (`apps/shell/src/main/outbound-confirm.ts`), configured as the shell entry
 * configures it: `readStoredAiSettings` and the `registerOutboundIpc({...})`
 * call are the entry's own statements, the switch is read from
 * userData/ai-settings.json, the question is worded in `hosts.a.lang` (`ko`
 * by default) and put over the caller's window.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { normalizeAiSettings } from '../../../../packages/ai-provider/src/index.ts'
import type { Call, Case, Group } from '../../types.ts'
import { entryStatements, runWith } from './lib/entry-source.ts'

const MODULE = 'apps/shell/src/main/outbound-confirm.ts'
type OutboundConfirm = typeof import('../../../../apps/shell/src/main/outbound-confirm.ts')

const entryCode = entryStatements('apps/shell/src/main/index.ts', [
  'function readStoredAiSettings(',
  'registerOutboundIpc({',
])

const docs = [{ view: 2, window: 7, surface: 'Docs' }]
const tools = (): Call => ({ channel: 'ai:internet-tools', args: [] })
const confirm = (request: unknown): Call => ({ channel: 'ai:confirm-addresses', args: [request] })
const ask = { tool: 'read_url', addresses: ['https://example.com/a?q=1'] }
/** `providers` is there: without it the stored settings drop `internetTools` */
const settings = (rest: Record<string, unknown>) => ({
  'userData/ai-settings.json': JSON.stringify({ providers: {}, ...rest }),
})
const answers = (...responses: number[]) => ({
  shared: { dialogs: { message: responses.map((response) => ({ response })) } },
})

const cases: Case[] = [
  { note: 'no settings file: the tools are on', views: docs, calls: [tools()] },
  {
    note: 'an explicit false turns them off and nothing is asked',
    views: docs,
    files: settings({ internetTools: false }),
    calls: [tools(), confirm(ask)],
  },
  {
    note: 'a value that is not false keeps them on',
    views: docs,
    files: settings({ internetTools: 'no' }),
    calls: [tools()],
  },
  {
    note: 'a corrupt file reads as the defaults',
    views: docs,
    files: { 'userData/ai-settings.json': '{oops' },
    calls: [tools()],
  },
  {
    note: 'Allow answers yes, Block and closing answer no',
    views: docs,
    hosts: answers(1, 0),
    calls: [confirm(ask), confirm(ask), confirm(ask)],
  },
  {
    note: 'several addresses, one cut at 300 characters, in English',
    views: docs,
    hosts: { ...answers(1), a: { lang: 'en' } },
    calls: [
      confirm({
        tool: 'fetch_image',
        addresses: [`https://example.com/${'x'.repeat(400)}`, 'https://example.org/'],
      }),
    ],
  },
  {
    note: 'a malformed request answers no without a question',
    views: docs,
    calls: [confirm(null), confirm({ tool: 'read_url', addresses: [] }), confirm('x')],
  },
  {
    note: 'the shell window asks too',
    hosts: answers(1),
    calls: [confirm(ask)],
  },
]

export const group: Group = {
  batch: 'A',
  async load(cx) {
    const hostsA = (cx.case.hosts?.a ?? {}) as { lang?: string }
    const mod = await cx.fresh<OutboundConfirm>(MODULE)
    runWith(entryCode, {
      readFileSync,
      join,
      normalizeAiSettings,
      app: cx.electron.app,
      registerOutboundIpc: mod.registerOutboundIpc,
      currentLang: () => hostsA.lang ?? 'ko',
      shellWindow: null,
    })
  },
  cases,
}
