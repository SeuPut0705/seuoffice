/**
 * Group `a/agent-window`: the agent window of the shell
 * (`apps/shell/src/main/agent/agent-window.ts`, 16 invokes and the event
 * `agent-window:event`), with its real manager (`agent-sessions.ts`), project
 * skills and preference files, configured as the shell entry configures it:
 * `APP_SETTINGS_PATH` and the `configureAgentWindow({...})` call are the
 * entry's own statements, run over the real modules and the fake Electron.
 *
 * What the Rust port reaches through its batch hosts is stood in here, from
 * the same `hosts.a.agent` (crates/shell-ipc/a/src/probe/agent.rs describes
 * its keys and the host log lines, which these stand-ins write the same):
 * `startClaudeAgentSession`, `startAgentMcpServer`, `currentMcpRuntimeDeps`,
 * `userSkills.list/enabledForAgent`, `templateTabs.openPreview`,
 * `buildAgentSkillBundle`, `routeDocumentPath`, the tab manager's open files,
 * `sharedSubscriptionStatuses`, `readStoredAiSettings`, `currentLang` and
 * `currentTheme`. `mcpHub` is null: sessions get no relays.
 *
 * `os.homedir()` and `os.tmpdir()` are the case's `home` and `temp` folders
 * (HOME and TMPDIR); a case makes them with a file each, a session folder is
 * made in `temp`. The ids `randomUUID()` makes in the manager are counted
 * (`00000000-0000-4000-8000-000000000001`, ...), as the Rust probe counts
 * them, so the session of a case has a known id.
 *
 * `agent-window:skill-proposal` and `agent-window:install-proposal` are shown by a
 * session's MCP tools, which no call of a renderer makes: the triggers
 * `a/agent-propose-skill` `[sessionId, projectRoot, input]` and
 * `a/agent-propose-install` `[sessionId, projectRoot, address]` call
 * `agentSkillToolsFor(session, projectRoot, deps)` of the real module over the
 * session the case started (window: its page, `listSkills`: `hosts.a.agent.skills`,
 * keys: the counted ids). No session skills are given (`bundle` stays null in those
 * cases: the manager's own list is not reachable from here), and a closed window
 * is not reachable on either side (no case destroys a view).
 *
 * Not covered here: opening the window (`home:open-agent-window`
 * is W's channel; the window is open from the start when `hosts.a.agent.window`
 * names its view), the cards the template buttons need (they come with the
 * proposals), a failed start that writes the crash log (its line is dated),
 * and Codex (it runs on the ai-provider runtime).
 */
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readAppSettings, writeAgentPrefs } from '../../../../apps/shell/src/main/app-settings.ts'
import {
  projectSkillsAllowed,
  projectSkillsView,
  setProjectSkills,
} from '../../../../apps/shell/src/main/agent/project-skills.ts'
import { normalizeAgentPrefs } from '../../../../apps/shell/src/shared/agent-api.ts'
import type { Call, Case, Group, LoadContext, TriggerContext, View } from '../../types.ts'
import { entryStatements } from './lib/entry-source.ts'

const MODULE = 'apps/shell/src/main/agent/agent-window.ts'
type AgentWindowModule = typeof import('../../../../apps/shell/src/main/agent/agent-window.ts')

/** The entry's statements, in its order */
const entryCode = entryStatements('apps/shell/src/main/index.ts', [
  'const APP_SETTINGS_PATH =',
  'configureAgentWindow({',
])

// ---- hosts.a.agent -------------------------------------------------------------

interface World {
  window?: number
  theme?: string
  statuses?: Record<string, unknown>
  settings?: Record<string, unknown>
  documents?: string[]
  openPath?: boolean
  skills?: Record<string, unknown>[]
  enabled?: Record<string, unknown>[]
  bundle?: { dir: string; skills: Record<string, unknown>[] } | null
  preview?: Record<string, unknown>
  mcpRuntime?: boolean
  runner?: { events?: unknown[]; sendThrows?: string }
}

// ---- the ids ---------------------------------------------------------------------

let counted = 0
const countedUuid = (): string => `00000000-0000-4000-8000-${String(++counted).padStart(12, '0')}`

/**
 * `randomUUID()` of node:crypto: counted for the agent modules, the platform's
 * for everyone else (the settings file's temporary name draws from it too, and
 * the Rust side does not count that one)
 */
function numberAgentUuids(): void {
  const crypto = createRequire(import.meta.url)('node:crypto') as Record<string, unknown>
  const real = (crypto.randomUUID as () => string).bind(crypto)
  Object.defineProperty(crypto, 'randomUUID', {
    value: () => {
      const stack = new Error().stack ?? ''
      return stack.includes('agent-sessions') || stack.includes('agent-window')
        ? countedUuid()
        : real()
    },
    writable: true,
    configurable: true,
    enumerable: true,
  })
  syncBuiltinESMExports()
}
numberAgentUuids()

// ---- the window of the case ----------------------------------------------------------

type Fn = (...args: unknown[]) => unknown

/** `new BrowserWindow(...)`: the case's agent view as a window; every call but its id does nothing */
function browserWindowOf(cx: LoadContext, world: World): unknown {
  const view = (cx.case.views ?? []).find((v) => v.view === world.window)
  if (view === undefined) throw new Error('hosts.a.agent.window names no view of the case')
  const contents = Object.assign(cx.electron.contents(view.view), {
    setWindowOpenHandler: () => {},
    loadURL: async () => {},
    loadFile: async () => {},
  })
  class FakeWindow {
    id = view?.window ?? view?.view
    webContents = contents
    removeMenu(): void {}
    once(): this {
      return this
    }
    on(): this {
      return this
    }
    loadURL(): Promise<void> {
      return Promise.resolve()
    }
    loadFile(): Promise<void> {
      return Promise.resolve()
    }
    isDestroyed(): boolean {
      return false
    }
    isMinimized(): boolean {
      return false
    }
    restore(): void {}
    show(): void {}
    focus(): void {}
  }
  return Object.assign(FakeWindow, cx.electron.BrowserWindow)
}

// ---- load ------------------------------------------------------------------------------

/** what the triggers reach: the real module and the case's world */
let loaded: { mod: AgentWindowModule; world: World; log: (line: unknown[]) => number } | undefined

async function load(cx: LoadContext): Promise<void> {
  // the folders `app.getPath` names: HOME and TMPDIR are what os.homedir() and os.tmpdir() read
  process.env.HOME = join(cx.dir, 'home')
  process.env.TMPDIR = join(cx.dir, 'temp')
  counted = 0
  const hostsA = (cx.case.hosts?.a ?? {}) as { agent?: World; lang?: string }
  const world = hostsA.agent ?? {}
  const log = (line: unknown[]): number => cx.electron.log.push(line)
  // `__dirname` of the CommonJS the app compiles to
  ;(globalThis as Record<string, unknown>).__dirname = '/probe'
  if (world.window !== undefined) cx.install({ BrowserWindow: browserWindowOf(cx, world) })
  const mod = await cx.fresh<AgentWindowModule>(MODULE)
  loaded = { mod, world, log }

  const names = {
    configureAgentWindow: mod.configureAgentWindow,
    shellWindow: null,
    currentLang: () => hostsA.lang ?? 'ko',
    currentTheme: () => world.theme ?? 'system',
    sharedSubscriptionStatuses: () => world.statuses ?? {},
    readStoredAiSettings: () => world.settings ?? {},
    normalizeAgentPrefs,
    readAppSettings,
    writeAgentPrefs,
    routeDocumentPath: (path: string) => {
      log(['routeDocumentPath', path])
      return world.openPath !== false
    },
    tabManager: { openFilePaths: () => world.documents ?? [] },
    detachedFilePaths: () => [],
    app: cx.electron.app,
    startClaudeAgentSession: async (
      options: {
        projectRoot: string
        mode: string
        model: string
        openDocuments: string[]
        appMcp?: unknown
      },
      onEvent: (event: unknown) => void,
    ) => {
      log([
        'claude.start',
        {
          projectRoot: options.projectRoot,
          mode: options.mode,
          model: options.model,
          openDocuments: options.openDocuments,
          appMcp: options.appMcp !== undefined,
        },
      ])
      for (const event of world.runner?.events ?? []) onEvent(event)
      return {
        provider: 'claude-code',
        send: async (text: string) => {
          log(['session.send', text])
          if (world.runner?.sendThrows !== undefined) throw new Error(world.runner.sendThrows)
        },
        answer: (id: string, answer: { allow: boolean; scope?: string }) =>
          log(['session.answer', id, answer.allow, answer.scope ?? null]),
        setOpenDocuments: (paths: string[]) => log(['session.setOpenDocuments', paths]),
        stop: () => log(['session.stop']),
      }
    },
    startCodexAgentSession: async () => {
      throw new Error('Codex is not scripted')
    },
    currentMcpRuntimeDeps: () => (world.mcpRuntime === false ? null : {}),
    startAgentMcpServer: async (_deps: unknown, projectRoot: string) => {
      log(['startAgentMcpServer', projectRoot])
      return {
        url: 'http://127.0.0.1:1/mcp',
        token: 'token',
        stop: async () => {
          log(['appMcp.stop'])
        },
      }
    },
    mcpHub: null,
    userSkills: {
      list: async () => {
        log(['userSkills.list'])
        return world.skills ?? []
      },
      enabledForAgent: async (folder: string) => {
        log(['userSkills.enabledForAgent', folder])
        return world.enabled ?? []
      },
    },
    templateTabs: {
      openPreview: async (owner: { id: number }, input: { fileName: string; tabTitle: string }) => {
        log([
          'templateTabs.openPreview',
          owner.id,
          { fileName: input.fileName, tabTitle: input.tabTitle },
        ])
        const preview = world.preview ?? {}
        if (typeof preview.throws === 'string') throw new Error(preview.throws)
        return preview
      },
    },
    projectSkillsAllowed,
    projectSkillsView,
    setProjectSkills,
    buildAgentSkillBundle: async (skills: { name: string }[]) => {
      log(['buildAgentSkillBundle', skills.map((skill) => skill.name)])
      return world.bundle ?? undefined
    },
    join,
    tmpdir,
  }
  new Function(...Object.keys(names), entryCode)(...Object.values(names))
  if (world.window !== undefined) mod.openAgentWindow()
}

// ---- triggers ----------------------------------------------------------------------------

/** the two skill tools of the session `sessionId` of the window `view`, over the case's skills */
function skillTools(cx: TriggerContext, view: number, sessionId: string, projectRoot: string) {
  const { mod, world, log } = loaded!
  return mod.agentSkillToolsFor({ ownerId: view, sessionId }, projectRoot, {
    window: () => ({ send: (channel, payload) => cx.contents(view).send(channel, payload) }),
    listSkills: async () => {
      log(['userSkills.list'])
      return (world.skills ?? []) as never
    },
    sessionSkills: () => [],
    keep: () => {},
    newKey: countedUuid,
  })
}

const triggers: NonNullable<Group['triggers']> = {
  'a/agent-propose-skill': async (cx, view, args) => {
    const [sessionId, projectRoot, input] = args as [string, string, Record<string, unknown>]
    // what the MCP tool's schema hands over: every field there, the strings empty when not given
    await skillTools(cx, view, sessionId, projectRoot).proposeSkill(
      {
        title: String(input.title ?? ''),
        name: String(input.name ?? ''),
        description: String(input.description ?? ''),
        body: String(input.body ?? ''),
        wantsTemplate: input.wantsTemplate === true,
        targetId: String(input.targetId ?? ''),
        suggestedTemplatePath: String(input.suggestedTemplatePath ?? ''),
      },
      { openTabs: async () => [] },
    )
  },
  'a/agent-propose-install': async (cx, view, args) => {
    const [sessionId, projectRoot, address] = args as [string, string, string]
    await skillTools(cx, view, sessionId, projectRoot).proposeInstall(address)
  },
}

// ---- cases ---------------------------------------------------------------------------------

const views: View[] = [
  { view: 1, window: 1, surface: 'Shell' },
  { view: 2, window: 2, surface: 'ShellAgent' },
  { view: 3, window: 3, surface: 'ShellAgent' },
]
const SESSION = '00000000-0000-4000-8000-000000000001'
const ready = { 'claude-code': { provider: 'claude-code', state: 'ready' } }
const accepted = JSON.stringify({
  agent: {
    provider: 'claude-code',
    mode: 'ask-commands',
    recentFolders: [],
    warningAccepted: 1,
  },
})
/** the folders a session needs: `temp` for its own folder, the project to work in */
const folders = { 'temp/.keep': '', 'home/.keep': '', 'project/notes.md': 'notes' }
const withAccepted = { ...folders, 'userData/app-settings.json': accepted }

const agent = (world: World = {}, rest: Record<string, unknown> = {}) => ({
  a: { agent: { window: 2, ...world }, ...rest },
})
const call = (channel: string, args: unknown[] = [], view = 2): Call => ({ channel, args, view })
const start = (provider = 'claude-code', mode = 'ask-commands', folder = '$DIR/project'): Call =>
  call('agent-window:start', [{ provider, mode, folder }])

const skillFiles = {
  'project/.claude/skills/review/SKILL.md': '---\nname: review\ndescription: Reviews\n---\nBody\n',
}
const projectSkill = {
  id: 'project:review',
  name: 'review',
  title: 'Review',
  description: 'Reviews',
  dir: '$DIR/project/.claude/skills/review',
  source: 'project',
}

const propose = (input: Record<string, unknown>): Call => ({
  channel: 'a/agent-propose-skill',
  kind: 'trigger',
  name: 'a/agent-propose-skill',
  view: 2,
  args: [SESSION, '$DIR/project', input],
})
const proposeInstall = (address: string): Call => ({
  channel: 'a/agent-propose-install',
  kind: 'trigger',
  name: 'a/agent-propose-install',
  view: 2,
  args: [SESSION, '$DIR/project', address],
})
const listed = [
  { id: 'user:summarize', source: 'user', name: 'summarize', title: 'Summarize', owned: true },
  { id: 'project:review', source: 'project', name: 'review', title: 'Review', owned: false },
]

const cases: Case[] = [
  {
    note: 'the skill tools of a session: a new skill card, a change to a listed skill, an install proposal',
    views,
    files: withAccepted,
    hosts: agent({ statuses: ready, skills: listed }),
    calls: [
      start(),
      propose({
        title: 'Weekly report',
        name: 'weekly-report',
        description: 'Writes the weekly report',
        body: 'Collect the week and write it up.',
        wantsTemplate: true,
      }),
      propose({
        title: 'Summaries',
        name: 'summarize',
        description: 'Summarizes better',
        body: 'Keep it short.',
        targetId: 'summarize',
      }),
      proposeInstall('https://github.com/example/skills/tree/main/review'),
    ],
  },
  {
    note: 'a card for a skill that is not listed, and one of the project folder are refused with words for the model',
    views,
    files: withAccepted,
    hosts: agent({ statuses: ready, skills: listed }),
    calls: [
      start(),
      propose({
        title: 'Nope',
        name: 'nope',
        description: 'd',
        body: 'b',
        targetId: 'no-such-skill',
      }),
      propose({
        title: 'Review',
        name: 'review',
        description: 'd',
        body: 'b',
        targetId: 'project:review',
      }),
    ],
  },
  {
    note: 'the window page is told its init, another agent page is not',
    views,
    files: folders,
    hosts: agent({
      statuses: ready,
      settings: { meteredAccepted: { codex: true } },
      theme: 'dark',
    }),
    calls: [
      call('agent-window:get-init'),
      call('agent-window:get-init', [], 3),
      call('agent-window:get-theme'),
    ],
  },
  {
    note: 'no window is open: nothing is answered, and the theme is the default',
    views,
    files: folders,
    hosts: { a: { agent: {} } },
    calls: [
      call('agent-window:get-init'),
      call('agent-window:pick-folder'),
      call('agent-window:get-theme'),
    ],
  },
  {
    note: 'set-prefs cannot add folders or claim a newer warning; the file keeps what was stored',
    views,
    files: {
      ...folders,
      'userData/app-settings.json': JSON.stringify({
        agent: {
          provider: 'codex',
          mode: 'ask-writes',
          recentFolders: ['/a', '/b'],
          warningAccepted: 1,
        },
      }),
    },
    hosts: agent(),
    calls: [
      call('agent-window:set-prefs', [
        { provider: 'claude-code', recentFolders: ['/b', '/evil'], warningAccepted: 9 },
      ]),
      call('agent-window:set-prefs', [{ mode: 'bogus' }]),
      call('agent-window:set-prefs', [null]),
      call('agent-window:set-prefs', [{ provider: 'codex' }], 3),
    ],
  },
  {
    note: 'pick-folder: the chosen folder, then a cancelled dialog, then a page that is not the window',
    views,
    files: folders,
    hosts: { ...agent(), shared: { dialogs: { open: [['/picked/folder']] } } },
    calls: [
      call('agent-window:pick-folder'),
      call('agent-window:pick-folder'),
      call('agent-window:pick-folder', [], 3),
    ],
  },
  {
    note: 'project prefs: relative folders are refused, the choices are remembered and normalized',
    views,
    files: folders,
    hosts: agent(),
    calls: [
      call('agent-window:get-project-prefs', ['relative/folder']),
      call('agent-window:get-project-prefs', ['$DIR/project']),
      call('agent-window:set-project-prefs', [
        '$DIR/project',
        { codexNetwork: true, codexWebSearch: 'live' },
      ]),
      call('agent-window:set-project-prefs', [
        '$DIR/project',
        { codexWebSearch: 'nonsense', codexNetwork: 'yes' },
      ]),
      call('agent-window:get-project-prefs', ['$DIR/project']),
      call('agent-window:get-project-prefs', ['$DIR/project'], 3),
      call('agent-window:set-project-prefs', ['$DIR/project', { codexNetwork: false }], 3),
    ],
  },
  {
    note: 'project skills are turned on as they are now, and only by `true`',
    views,
    files: { ...folders, ...skillFiles },
    hosts: agent({ enabled: [projectSkill] }),
    calls: [
      call('agent-window:get-project-skills', ['$DIR/project']),
      call('agent-window:set-project-skills', ['$DIR/project', true]),
      call('agent-window:get-project-skills', ['$DIR/project']),
      call('agent-window:set-project-skills', ['$DIR/project', 'yes']),
      call('agent-window:get-project-skills', ['relative']),
      call('agent-window:set-project-skills', ['$DIR/project', true], 3),
    ],
  },
  {
    note: 'a start refuses a window that did not accept the warning, a bad request, a missing folder and a program that is not connected',
    views,
    files: folders,
    hosts: agent({ statuses: ready }),
    calls: [
      start(),
      start('nobody'),
      start('claude-code', 'ask-commands', '$DIR/missing'),
      {
        channel: 'agent-window:start',
        args: [{ provider: 'claude-code', mode: 'ask-commands', folder: '$DIR/project' }],
        view: 3,
      },
    ],
  },
  {
    note: 'a start with the warning accepted but no connected program',
    views,
    files: withAccepted,
    hosts: agent({ statuses: {} }),
    calls: [start()],
  },
  {
    note: 'a session: events, messages, answers, files and stop',
    views,
    files: { ...withAccepted, 'project/report.docx': 'x' },
    hosts: agent({
      statuses: ready,
      settings: { providers: { 'claude-code': { model: 'sonnet' } } },
      documents: ['$DIR/project/report.docx'],
      runner: {
        events: [
          { type: 'text', text: 'ready' },
          { type: 'turn-done', ok: true },
        ],
      },
    }),
    calls: [
      start(),
      call('agent-window:send', [SESSION, 'make it shorter']),
      call('agent-window:send', [SESSION, '  \n ']),
      call('agent-window:send', ['no-such-session', 'x']),
      call('agent-window:answer', [SESSION, 'req-1', true, 'session']),
      call('agent-window:answer', [SESSION, 'req-2', false, 'session']),
      call('agent-window:open-file', [SESSION, 'report.docx']),
      call('agent-window:open-file', [SESSION, '../outside.docx']),
      call('agent-window:open-file', [SESSION, 'missing.docx']),
      call('agent-window:send', [SESSION, 'from another page'], 3),
      call('agent-window:stop', [SESSION]),
      call('agent-window:send', [SESSION, 'after the stop']),
    ],
  },
  {
    note: 'a program that refuses a message, and tabs that cannot open a file',
    views,
    files: { ...withAccepted, 'project/report.docx': 'x' },
    hosts: agent({
      statuses: ready,
      openPath: false,
      runner: { sendThrows: 'the program is busy' },
    }),
    calls: [
      start(),
      call('agent-window:send', [SESSION, 'hello']),
      call('agent-window:open-file', [SESSION, 'report.docx']),
      call('agent-window:stop', [SESSION]),
    ],
  },
  {
    note: 'the skills a session gets: the project skills stay out until turned on',
    views,
    files: { ...withAccepted, ...skillFiles },
    hosts: agent({
      statuses: ready,
      enabled: [
        projectSkill,
        {
          id: 'user:summarize',
          name: 'summarize',
          title: 'Summarize',
          description: 'Summarizes',
          dir: '$DIR/skills/summarize',
          source: 'user',
        },
      ],
      bundle: {
        dir: '$DIR/temp/skill-copy',
        skills: [
          {
            id: 'user:summarize',
            name: 'summarize',
            source: 'user',
            title: 'Summarize',
            description: 'Summarizes',
            invoke: '/summarize',
            skillMd: '---\nname: summarize\n---\nBody\n',
          },
        ],
      },
    }),
    calls: [
      start(),
      call('agent-window:set-project-skills', ['$DIR/project', true]),
      call('agent-window:stop', [SESSION]),
      start('claude-code', 'trust-project'),
    ],
  },
  {
    note: 'the template buttons of a card that was never shown',
    views,
    files: folders,
    hosts: agent(),
    calls: [
      call('agent-window:template-check', ['no-card', 'no-candidate']),
      call('agent-window:template-as-is', ['no-card', 'no-candidate']),
      call('agent-window:template-blank', [
        'no-card',
        'no-candidate',
        { tabTitle: 't', text: 'x' },
      ]),
      call('agent-window:template-check', [1, 2], 3),
    ],
  },
]

export const group: Group = {
  batch: 'A',
  load,
  triggers,
  cases,
  single: {
    'agent-window:answer':
      'answers undefined whatever the session; the host log tells the cases apart',
    'agent-window:stop':
      'answers undefined whatever the session; the host log and the events tell the cases apart',
    'agent-window:template-check':
      'a card exists only after a skill tool call of a session, which no renderer call makes: always not-found',
    'agent-window:template-as-is':
      'a card exists only after a skill tool call of a session, which no renderer call makes: always not-found',
    'agent-window:template-blank':
      'a card exists only after a skill tool call of a session, which no renderer call makes: always not-found',
  },
}
