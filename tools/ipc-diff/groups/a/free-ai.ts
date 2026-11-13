/**
 * Group `a/free-ai`: `apps/docs/src/main/free-ai-ipc.ts`: the free AI
 * connections' IPC (the Gemini key check, removing a connection, today's free
 * requests, the page where a key is made, cancelling a sign-in).
 *
 * The module is loaded afresh for each case (its `pending` sign-in starts
 * over) and registered as the docs entry registers it, over stand-ins for the
 * entry's deps: `readSettings` (the stored settings, normalized),
 * `writeSettings` (logged as `["writeSettings", settings]`) and `windowFor`
 * (the window of `hosts.a.freeAi.window`, its calls logged as `["win.restore"]`,
 * `["win.show"]`, `["win.focus"]`). The network is the process's `fetch`,
 * scripted by `hosts.a.freeAi.fetches` and logged as `["fetch", url, method,
 * headers, body]` (header names in lower case, without the User-Agent
 * `aiFetch` adds, which the Rust side's host adds). `shell.openExternal` is
 * the fake Electron's, which logs as the Rust shared host does.
 *
 * Not run: a browser sign-in (OpenRouter's). Its loopback server and PKCE
 * random bytes are real on this side and the probe has no fake of them, so no
 * case starts one; `ai:free-connect` is covered by the Gemini key check.
 * Scripted statuses stay clear of 429, 503 and 529, which `aiFetch` retries
 * after a delay.
 */
import { normalizeAiSettings } from '../../../../packages/ai-provider/src/legacy-settings.ts'
import type { Call, Case, Group } from '../../types.ts'

interface FreeAiHosts {
  freeAi?: {
    settings?: unknown
    refuseWrite?: boolean
    window?: { destroyed?: boolean; minimized?: boolean } | null
    fetches?: { status?: number; json?: unknown; location?: string; throw?: string }[]
  }
}

const shell = (channel: string, ...args: unknown[]): Call => ({ channel, view: 1, args })

const KEY_1 = 'AIzaSyExampleExampleExample1'
const KEY_2 = 'AIzaSyExampleExampleExample2'
const stored = {
  provider: 'auto',
  providers: { openrouter: { apiKey: 'sk-or-old' }, gemini: { apiKey: KEY_1 } },
}

const cases: Case[] = [
  {
    note: 'a Gemini key is checked by listing models and saved; a key Google refuses saves nothing',
    hosts: {
      a: {
        freeAi: {
          fetches: [
            { status: 200, json: { models: [] } },
            { status: 401, json: {} },
          ],
        },
      },
    },
    calls: [
      shell('ai:free-connect', { provider: 'gemini', apiKey: ` ${KEY_1} ` }),
      shell('ai:free-connect', { provider: 'gemini', apiKey: KEY_2 }),
    ],
  },
  {
    note: 'a key that does not look like one never reaches the network; an unknown provider is invalid',
    calls: [
      shell('ai:free-connect', { provider: 'gemini', apiKey: 'has spaces in it, so no' }),
      shell('ai:free-connect', { provider: 'gemini' }),
      shell('ai:free-connect', { provider: 'openai' }),
      shell('ai:free-connect', null),
      shell('ai:free-connect'),
    ],
  },
  {
    note: 'a check that fails on the network, and settings that refuse the connection',
    hosts: {
      a: {
        freeAi: {
          fetches: [{ status: 404, json: {} }, { throw: 'offline' }, { status: 200, json: {} }],
        },
      },
    },
    calls: [
      shell('ai:free-connect', { provider: 'gemini', apiKey: KEY_1 }),
      shell('ai:free-connect', { provider: 'gemini', apiKey: KEY_2 }),
    ],
  },
  {
    note: 'settings that are refused make a good key a network failure',
    hosts: {
      a: { freeAi: { refuseWrite: true, fetches: [{ status: 200, json: { models: [] } }] } },
    },
    calls: [shell('ai:free-connect', { provider: 'gemini', apiKey: KEY_1 })],
  },
  {
    note: 'a redirect from the key check is refused, as every keyed request is',
    hosts: {
      a: {
        freeAi: {
          fetches: [{ status: 302, json: {}, location: 'https://elsewhere.test/models' }],
        },
      },
    },
    calls: [shell('ai:free-connect', { provider: 'gemini', apiKey: KEY_1 })],
  },
  {
    note: 'disconnect removes the connection of a known provider; an unknown one and no argument change nothing',
    hosts: { a: { freeAi: { settings: stored } } },
    calls: [
      shell('ai:free-disconnect', { provider: 'openrouter' }),
      shell('ai:free-disconnect', { provider: 'gemini' }),
      shell('ai:free-disconnect', { provider: 'openai' }),
      shell('ai:free-disconnect'),
    ],
  },
  {
    note: "quota: today's free requests of the stored OpenRouter key; Gemini and a key OpenRouter does not answer for are null",
    hosts: {
      a: {
        freeAi: {
          settings: stored,
          fetches: [
            {
              status: 200,
              json: { data: { free_model_daily_requests: { used: 3, limit: 50, remaining: 47 } } },
            },
            { status: 404, json: {} },
          ],
        },
      },
    },
    calls: [
      shell('ai:free-quota', { provider: 'openrouter' }),
      shell('ai:free-quota', { provider: 'gemini' }),
      shell('ai:free-quota', { provider: 'openrouter' }),
      shell('ai:free-quota'),
    ],
  },
  {
    note: 'quota with no OpenRouter key asks nobody',
    calls: [shell('ai:free-quota', { provider: 'openrouter' })],
  },
  {
    note: 'the key page of each provider opens in the browser; an unknown provider opens nothing',
    calls: [
      shell('ai:free-open-key-page', { provider: 'gemini' }),
      shell('ai:free-open-key-page', { provider: 'openrouter' }),
      shell('ai:free-open-key-page', { provider: 'openai' }),
      shell('ai:free-open-key-page'),
    ],
  },
  {
    note: 'cancel with no sign-in waiting does nothing',
    calls: [shell('ai:free-connect-cancel')],
  },
]

export const group: Group = {
  batch: 'A',
  async load(cx) {
    const hostsA = (cx.case.hosts?.a ?? {}) as FreeAiHosts
    const scripted = hostsA.freeAi ?? {}
    const log = cx.electron.log
    let settings: unknown = scripted.settings ?? {}
    const fetches = [...(scripted.fetches ?? [])]

    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const headers = Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>)
          .map(([name, value]) => [name.toLowerCase(), value] as const)
          .filter(([name]) => name !== 'user-agent'),
      )
      log.push(['fetch', String(url), init?.method ?? 'GET', headers, init?.body ?? null])
      const answer = fetches.shift()
      if (!answer) throw new Error('no fetch scripted')
      if (answer.throw !== undefined) throw new Error(answer.throw)
      return new Response(JSON.stringify(answer.json ?? null), {
        status: answer.status ?? 200,
        headers: answer.location ? { location: answer.location } : {},
      })
    }) as typeof fetch

    const win = scripted.window
    const mod = await cx.fresh<{ registerFreeAiIpc(deps: unknown): void }>(
      'apps/docs/src/main/free-ai-ipc.ts',
    )
    mod.registerFreeAiIpc({
      readSettings: () => normalizeAiSettings(settings),
      writeSettings: (next: unknown) => {
        if (scripted.refuseWrite) return false
        log.push(['writeSettings', next])
        settings = next
        return true
      },
      windowFor: () =>
        win
          ? {
              isDestroyed: () => win.destroyed === true,
              isMinimized: () => win.minimized === true,
              restore: () => log.push(['win.restore']),
              show: () => log.push(['win.show']),
              focus: () => log.push(['win.focus']),
            }
          : undefined,
    })
  },
  cases,
  single: {
    'ai:free-disconnect':
      'always answers undefined; what differs is the settings written (the host log)',
    'ai:free-open-key-page':
      'always answers undefined; what differs is the address opened (the host log)',
  },
}
