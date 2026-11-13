/**
 * Group `w/projects-store`: `project:resolveChat`, `project:appendChat`,
 * `project:loadChat` and `project:rebindChat`, the per-document chat of the
 * app-data project store (`registerProjectIpc` of `apps/docs/src/main/docs-main.ts`).
 * The store is faked on its prototype and answers from `hosts.w.projects.store`
 * (`resolve`, `lookup`, `load`, `rebind` by path or chat, `sessions` by
 * `<view>/<session>`, `headless`, `fail`), logging each call; the Rust handlers
 * run the same cases over `crates/shell-ipc/w/src/projects/legacy.rs`.
 */
import { createRequire } from 'node:module'
import type { Case, Group, LoadContext } from '../../types.ts'
import { loadDocsMain } from './app-main.ts'
import { hostsOf, request } from './projects-lib/load.ts'

const require = createRequire(import.meta.url)
const { ProjectStore } = require('@seuoffice/project-store') as {
  ProjectStore: { prototype: object }
}
const { setHeadlessMode } = require('@seuoffice/electron-utils') as {
  setHeadlessMode(on: boolean): void
}

type Json = Record<string, unknown>
const NOW = 1_700_000_000_000

async function load(cx: LoadContext): Promise<void> {
  const w = (cx.case.hosts?.w ?? {}) as Json
  const store = (((w.projects ?? {}) as Json).store ?? {}) as Json
  const table = (name: string): Json => (store[name] ?? {}) as Json
  const log = cx.electron.log
  const fail = (method: string): void => {
    const message = table('fail')[method]
    if (typeof message === 'string') throw new Error(message)
  }
  const call = (method: string, ...args: unknown[]): void => {
    log.push([`projectStore.${method}`, ...args.map((a) => (a === undefined ? null : a))])
    fail(method)
  }
  const key = (value: unknown): string =>
    typeof value === 'string' ? value : JSON.stringify(value)
  Date.now = () => NOW
  setHeadlessMode(store.headless === true)
  Object.assign(ProjectStore.prototype, {
    ensureDefaultProject: () => call('ensureDefaultProject'),
    resolveChatForFile(path: unknown) {
      call('resolveChatForFile', path)
      return table('resolve')[key(path)] ?? null
    },
    lookupChatForFile(path: unknown) {
      call('lookupChatForFile', path)
      return table('lookup')[key(path)] ?? null
    },
    appendChatMessage(projectId: unknown, chatId: unknown, message: unknown) {
      call('appendChatMessage', projectId, chatId, message)
    },
    loadChat(projectId: unknown, chatId: unknown, limit: unknown) {
      call('loadChat', projectId, chatId, limit)
      return table('load')[`${key(projectId)}/${key(chatId)}`] ?? null
    },
    rebindChatToFile(projectId: unknown, temp: unknown, path: unknown) {
      call('rebindChatToFile', projectId, temp, path)
      return table('rebind')[key(path)] ?? null
    },
    rebindChat(projectId: unknown, temp: unknown, next: unknown) {
      call('rebindChat', projectId, temp, next)
    },
  })
  const docs = await loadDocsMain(cx, { openTab() {}, listTabs: () => [], focusTab() {} })
  docs.setSessionPathResolver((sender, session) => {
    const path = table('sessions')[`${sender}/${session}`]
    return typeof path === 'string' ? path : null
  })
  docs.registerProjectIpc()
}

const ref = { projectId: 'default', chatId: 'c1' }
const store = {
  resolve: { '$DIR/a.docx': { projectId: 'default', chatId: 'chat-a' } },
  lookup: { '$DIR/a.docx': { projectId: 'default', chatId: 'look-a' } },
  load: { 'default/c1': [{ seq: 0, role: 'user', text: 'hi' }] },
  rebind: { '$DIR/b.docx': { projectId: 'default', chatId: 'chat-b' } },
  sessions: { '1/s1': '$DIR/a.docx' },
}
const hosts = (extra: Json = {}) => hostsOf({ store: { ...store, ...extra } })
const call = (channel: string, args: unknown[]) => ({ channel: `project:${channel}`, args })
void request

const base: Case[] = [
  {
    note: 'resolve a chat: no file gives the default project, a file and a session resolve, bad args throw',
    hosts: hosts(),
    calls: [
      call('resolveChat', [{ filePath: null, tempChatId: 'tmp1' }]),
      call('resolveChat', [{ filePath: null }]),
      call('resolveChat', [{ filePath: '$DIR/a.docx' }]),
      call('resolveChat', [{ filePath: null, sessionId: 's1' }]),
      call('resolveChat', [{ filePath: '', sessionId: 'nope', tempChatId: 'tmp2' }]),
      call('resolveChat', [{ filePath: '$DIR/unknown.docx' }]),
      call('resolveChat', []),
      call('resolveChat', [null]),
    ],
  },
  {
    note: 'a headless export only looks a chat up',
    hosts: hosts({ headless: true }),
    calls: [
      call('resolveChat', [{ filePath: '$DIR/a.docx' }]),
      call('resolveChat', [{ filePath: null, tempChatId: 'tmp1' }]),
    ],
  },
  {
    note: 'the store throws',
    hosts: hosts({ fail: { ensureDefaultProject: 'disk full' } }),
    calls: [call('resolveChat', [{ filePath: '$DIR/a.docx' }])],
  },
  {
    note: 'append a message: the checks of role, text, tools and attachments, what reaches the store',
    hosts: hosts(),
    calls: [
      call('appendChat', [{ ...ref, role: 'user', text: 'hello' }]),
      call('appendChat', [
        {
          ...ref,
          role: 'assistant',
          text: 'ok',
          tools: [{ name: 't', summary: 's' }],
          attachments: [{ name: 'a' }],
          scope: { label: 'l' },
          skills: [{ id: 'x' }],
        },
      ]),
      call('appendChat', [{ ...ref, role: 'system', text: 'x' }]),
      call('appendChat', [{ ...ref, role: 'user', text: 5 }]),
      call('appendChat', [{ ...ref, role: 'user', text: 'x'.repeat(200_001) }]),
      call('appendChat', [{ ...ref, role: 'user', text: 'x', tools: 'no' }]),
      call('appendChat', [{ ...ref, role: 'user', text: 'x', attachments: {} }]),
      call('appendChat', [{ ...ref, role: 'user', text: 'x', skills: 'no' }]),
      call('appendChat', []),
    ],
  },
  {
    note: 'load a chat: the default limit, a given one, an unknown chat',
    hosts: hosts(),
    calls: [
      call('loadChat', [ref]),
      call('loadChat', [{ ...ref, limit: 5 }]),
      call('loadChat', [{ ...ref, chatId: 'other' }]),
      call('loadChat', []),
    ],
  },
  {
    note: 'rebind a chat to a file, to a session, to a new id, or to nothing',
    hosts: hosts({ sessions: { '1/s1': '$DIR/b.docx' } }),
    calls: [
      call('rebindChat', [{ projectId: 'default', tempChatId: 't', newFilePath: '$DIR/b.docx' }]),
      call('rebindChat', [{ projectId: 'default', tempChatId: 't', sessionId: 's1' }]),
      call('rebindChat', [{ projectId: 'default', tempChatId: 't', newChatId: 'n' }]),
      call('rebindChat', [{ projectId: 'default', tempChatId: 't' }]),
      call('rebindChat', [{ projectId: 'default' }]),
      call('rebindChat', []),
    ],
  },
]

/** the editors' panels call these: the shell view is no sender of them */
const cases = base.map((c) => ({
  ...c,
  views: [{ view: 1, window: 1, surface: 'Docs' }],
}))

export const group: Group = {
  batch: 'W',
  load,
  cases,
}
