/**
 * Part `skills` of group `b5-agent`: the person's skills in the agent window
 * (agent-skills.ts), the agent window's decisions (agent-window.ts) and the
 * names of the redaction label (redact-range.ts, old-names.ts).
 *
 * agent-window.ts is the product's own file. `window` configures a copy of it
 * (`configureAgentWindow`) with scripted services, opens it with a fake
 * `BrowserWindow` and runs steps: a handler registered on the fake `ipcMain`
 * is called with the page that sends, the program of a session is a fake
 * runner, and what the window does (the calls the fakes saw, in order) is the
 * log. The Rust side runs the same steps against a scripted host.
 * The manager is the product's own as well (`createAgentManager`) and the Rust
 * side runs the real `AgentManager` over its start steps. A world with `hold`
 * keeps the fake program from answering until a `release` step, and an
 * `invoke` step with `detach` does not wait for its handler: the steps after
 * it (stop, send, a closed window) run while a start waits, and the `release`
 * step has the start's answer.
 * `crypto.randomUUID` answers `uuid-1`, `uuid-2` ... so session ids and card
 * keys are the same on both sides. A page is named by its id: the window's
 * pages count from 5, Home is 1, any other page is 77.
 *
 * The deck check reads a pptx with JSZip on the TypeScript side and with a
 * scripted archive on the Rust side: a case that reads a deck carries both,
 * made from the same entries (`makeDeck`).
 *
 * Symlinks cannot be a `FileSpec`: a case that needs them lists `links`
 * (`[link, target]` pairs, made before the call on each side).
 */
import crypto from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { dirname, resolve as resolvePath } from 'node:path'
import { setImmediate as tick } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import JSZip from 'jszip'
import { useElectron } from '../electron-fake.ts'
import type { Case, FnSpec, Group, TsContext } from '../types.ts'

// loaded after electron-fake.ts has registered its hooks
const skills = await import('../../../apps/shell/src/main/agent/agent-skills.ts')
const win = await import('../../../apps/shell/src/main/agent/agent-window.ts')
const api = await import('../../../apps/shell/src/shared/agent-api.ts')
const homeChannel = await import('../../../apps/shell/src/shared/agent-home-channel.ts')
const redact = await import('../../../packages/agent-core/src/redact-range.ts')
const oldNames = await import('../../../packages/agent-core/src/old-names.ts')

// any: the fakes take the typed parameters of the function they stand in for
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex')
const cases = (...lists: unknown[][]): Case[] => lists.map((args): Case => ({ args }))

/** `[link, target]` pairs of a case, made on the case's folder (a file link) */
function makeLinks(links: unknown): void {
  for (const [link, target] of (links ?? []) as [string, string][]) symlinkSync(target, link)
}

// ---- constants ------------------------------------------------------------

const constant = (name: string, value: () => unknown): [string, FnSpec] => [
  name,
  { ts: () => value(), cases: [{ args: [] }], single: 'a constant' },
]

const constants: Group = Object.fromEntries([
  constant('redact-range.OWN_REDACT_NS', () => redact.OWN_REDACT_NS),
  constant('old-names.OLD_REDACT_NS', () => oldNames.OLD_REDACT_NS),
  constant('redact-range.REDACT_PREFIX', () => redact.REDACT_PREFIX),
  constant('redact-range.REDACT_EL', () => redact.REDACT_EL),
  constant('redact-range.REDACT_NAMESPACES', () => [...redact.REDACT_NAMESPACES]),
  constant('redact-range.REDACT_NS_WRITTEN', () => redact.REDACT_NS_WRITTEN),
  constant('agent-skills.AGENT_WINDOW_MANAGE_CHANNELS', () => [
    ...skills.AGENT_WINDOW_MANAGE_CHANNELS,
  ]),
  constant('agent-skills.MAX_PROJECT_TEMPLATE_FILES', () => skills.MAX_PROJECT_TEMPLATE_FILES),
  constant('agent-skills.MAX_PROJECT_TEMPLATE_DEPTH', () => skills.MAX_PROJECT_TEMPLATE_DEPTH),
])

// ---- agent-skills ---------------------------------------------------------

const SKILL_MD = (template?: string): string =>
  `---\nname: s\ndescription: d\nmetadata:\n${template === undefined ? '  ieum-title: S\n' : `  ieum-template: ${template}\n`}---\nbody\n`

const entry = (n: number, extra: Record<string, unknown> = {}) => ({
  id: `user:s${n}`,
  name: `s${n}`,
  source: 'user',
  title: `S${n}`,
  description: `d${n}`,
  invoke: 'auto',
  skillMd: `$DIR/s${n}/SKILL.md`,
  ...extra,
})

/** `[windows]`, a sender and a channel: which predicates were asked, and the answer */
const manageGate: FnSpec = {
  ts: (a, cx) => {
    const w = a[0] as { main: number[]; agent: number[] }
    const gate = skills.userSkillsManageGate<number>({
      isMainWindow: (s) => (cx.log('isMainWindow', s), w.main.includes(s)),
      isAgentWindow: (s) => (cx.log('isAgentWindow', s), w.agent.includes(s)),
    })
    return gate(a[1] as number, a[2] as string)
  },
  cases: [
    { args: [{ main: [1], agent: [2] }, 1, 'skills:list'], note: 'the main window: any channel' },
    {
      args: [{ main: [1], agent: [2] }, 2, 'skills:install'],
      note: 'agent window, a preview call',
    },
    { args: [{ main: [1], agent: [2] }, 2, 'skills:import-github'] },
    { args: [{ main: [1], agent: [2] }, 2, 'skills:read-import'] },
    { args: [{ main: [1], agent: [2] }, 2, 'skills:read-import-file'] },
    { args: [{ main: [1], agent: [2] }, 2, 'skills:cancel-import'] },
    { args: [{ main: [1], agent: [2] }, 2, 'skills:list'], note: 'agent window, a settings call' },
    { args: [{ main: [1], agent: [2] }, 2, 'skills:save'], note: 'not a preview call' },
    { args: [{ main: [1], agent: [2] }, 3, 'skills:install'], note: 'some other page' },
    { args: [{ main: [1, 2], agent: [2] }, 2, 'skills:list'], note: 'both: main wins' },
  ],
}

const sessionSkills: FnSpec = {
  ts: async (a) => skills.agentSessionSkillsOf(a[0] as never),
  cases: [
    {
      args: [[entry(1), entry(2, { plugin: 'p' }), entry(3)]],
      files: {
        's1/SKILL.md': SKILL_MD('assets/t.docx'),
        's1/assets/t.docx': 'template',
        's2/SKILL.md': SKILL_MD('assets/gone.docx'),
        's3/SKILL.md': SKILL_MD(),
      },
      note: 'a template that is there, one that is gone, a skill with none',
    },
    {
      args: [[entry(1), entry(2), entry(3), entry(4), entry(5)]],
      files: {
        's1/SKILL.md': SKILL_MD('../outside.docx'),
        's2/SKILL.md': SKILL_MD('assets/sub'),
        's2/assets/sub': { dir: true },
        'outside.docx': 'x',
        's3/SKILL.md': 'no front matter at all',
        's4/SKILL.md': SKILL_MD('assets/a/../b.docx'),
      },
      note: 'a path the app does not accept, a folder, no front matter, a missing SKILL.md',
    },
    { args: [[]], note: 'no skills' },
    {
      args: [[entry(1)]],
      files: {
        's1/SKILL.md': SKILL_MD('assets/sub/t.xlsx'),
        's1/assets/sub/t.xlsx': 'x',
      },
      note: 'a template in a folder',
    },
  ],
}

const LIST = [
  { id: 'user:a', source: 'user', name: 'a', title: 'A', owned: true, editors: 'docs sheets' },
  { id: 'app:a', source: 'app', name: 'a', title: '', owned: false },
  { id: 'project:p', source: 'project', name: 'p', title: 'P', owned: false },
  { id: 'user:bad', source: 'user', name: 'bad', title: 'Bad', owned: true, unreadable: true },
  { id: 'user:seuoffice', source: 'user', name: 'SeuOffice', title: 'R', owned: true },
  { id: 'plugin:x:b', source: 'plugin', name: 'b', title: 'B', owned: false },
  { id: 'codex:b', source: 'codex', name: 'b', title: 'B2', owned: false, editors: ['docs', 'x'] },
  {
    id: 'user:all',
    source: 'user',
    name: 'all',
    title: 'All',
    owned: true,
    editors: SKILL_EDITORS_ALL(),
  },
  { id: 'user:ok', source: 'user', name: 'ok', title: 'Ok', owned: true, unreadable: false },
]

function SKILL_EDITORS_ALL(): string[] {
  return [
    'docs',
    'sheets',
    'slides',
    'hwp',
    'pdf',
    'markdown',
    'html',
    'mindmap',
    'epub',
    'diagram',
  ]
}

const INPUT = {
  title: 'T',
  name: 'n',
  description: 'desc',
  body: 'body',
  wantsTemplate: true,
  targetId: '',
  suggestedTemplatePath: '',
}
const proposalCase = (targetId: string, session: unknown[] = [], note?: string): Case => ({
  args: [{ ...INPUT, targetId }, LIST, 'key1', session],
  ...(note ? { note } : {}),
})

const proposalOf: FnSpec = {
  ts: (a) =>
    skills.agentSkillProposalOf(a[0] as never, a[1] as never, a[2] as string, a[3] as never),
  cases: [
    proposalCase('', [], 'no target: a new skill'),
    proposalCase('user:a', [], 'by identifier'),
    proposalCase('a', [{ id: 'app:a', name: 'a' }], 'by name in the session: the one that won'),
    proposalCase('IEUM-skills:a', [{ id: 'user:a', name: 'A' }], 'plugin prefix, any case'),
    proposalCase('ieum-skills:user:a', [], 'prefix before an identifier'),
    proposalCase(
      'ieum-s\u212Aills:user:a',
      [],
      'a Kelvin sign lowers to k: the prefix is cut in code units',
    ),
    proposalCase('a', [], 'a plain name not in the session: priority, user before app'),
    proposalCase('b', [], 'priority, codex before plugin'),
    proposalCase('a--app', [{ id: 'app:a', name: 'a--app' }], 'renamed duplicate'),
    proposalCase('nothing', [], 'no such skill'),
    proposalCase('ieum-skills:nothing', [], 'prefix, no such skill'),
    proposalCase('p', [], 'a project skill'),
    proposalCase('bad', [], 'unreadable'),
    proposalCase('SeuOffice', [], 'a reserved name is never shown'),
    proposalCase('user:all', [], 'every editor: no limit'),
    proposalCase('b', [{ id: 'codex:b', name: 'b' }], 'in the session'),
    proposalCase('c', [{ id: 'user:gone', name: 'c' }], 'in the session but not in the list'),
    proposalCase('A', [{ id: 'user:a', name: 'a' }], 'a name in capitals is read as lower case'),
    proposalCase('ok', [], 'unreadable is false'),
    {
      args: [{ ...INPUT, targetId: 'app:a', wantsTemplate: false }, LIST, 'key2'],
      note: 'no sessionSkills argument; an empty title falls back to the name',
    },
  ],
}

const templateFiles: FnSpec = {
  ts: (a) => {
    makeLinks(a[2])
    return skills.projectTemplateFiles(a[0] as string, (a[1] ?? undefined) as never)
  },
  cases: [
    {
      args: ['$DIR/p', null],
      files: {
        'p/b.docx': '',
        'p/B.docx': '',
        'p/a.docx': '',
        'p/z.xlsx': '',
        'p/notes.txt': '',
        'p/data.bin': '',
        'p/~$lock.docx': '',
        'p/.hidden.docx': '',
        'p/.git/x.docx': '',
        'p/node_modules/m.docx': '',
        'p/sub/c.pptx': '',
        'p/sub/deep/d.hwp': '',
      },
      note: 'nearest first, sorted by name; hidden, lock files and node_modules left out',
    },
    {
      args: ['$DIR/p', { files: 2 }],
      files: { 'p/a.docx': '', 'p/b.docx': '', 'p/c.docx': '' },
      note: 'at most two files',
    },
    {
      args: ['$DIR/p', { depth: 0 }],
      files: { 'p/a.docx': '', 'p/s/b.docx': '' },
      note: 'depth 0: the folder itself',
    },
    {
      args: ['$DIR/p', { depth: 1, files: 10 }],
      files: { 'p/a.docx': '', 'p/s/b.docx': '', 'p/s/t/c.docx': '' },
      note: 'depth 1',
    },
    {
      args: ['$DIR/p', null],
      files: {
        'p/l1/l2/l3/l4/in.docx': '',
        'p/l1/l2/l3/l4/l5/out.docx': '',
      },
      note: 'the default depth is four levels',
    },
    { args: ['$DIR/missing', null], note: 'a folder that is not there' },
    {
      args: ['$DIR/p', null, [['$DIR/p/link.docx', '$DIR/p/a.docx']]],
      files: { 'p/a.docx': '' },
      note: 'a link is not offered',
    },
    {
      args: ['$DIR/p', { files: 0 }],
      files: { 'p/a.docx': '' },
      note: 'no file is allowed',
    },
  ],
}

const TABS = (...tabs: unknown[]) => tabs
const candidateOptions = (over: Record<string, unknown>): Record<string, unknown> => ({
  projectRoot: '$DIR/p',
  tabs: [],
  suggested: '',
  ...over,
})

const templateCandidates: FnSpec = {
  ts: async (a) => {
    makeLinks(a[1])
    const o = a[0] as Record<string, unknown>
    return skills.agentTemplateCandidates({
      projectRoot: o.projectRoot as string,
      tabs: o.tabs as never,
      suggested: o.suggested as string,
      ...(o.platform !== undefined ? { platform: o.platform as never } : {}),
      ...(o.projectFiles !== undefined ? { projectFiles: o.projectFiles as never } : {}),
    })
  },
  cases: [
    {
      args: [
        candidateOptions({
          tabs: TABS(
            { title: 'Tab A', filePath: '$DIR/p/a.docx', dirty: true },
            { title: 'No path', dirty: false },
            { title: 'Relative', filePath: 'rel/x.docx', dirty: false },
            { title: 'Lock', filePath: '$DIR/p/~$a.docx', dirty: false },
            { title: 'Binary', filePath: '$DIR/p/x.bin', dirty: false },
            { title: 'Outside', filePath: '$DIR/o/o.md', dirty: false },
          ),
        }),
      ],
      files: { 'p/a.docx': '', 'p/b.docx': '', 'o/o.md': '' },
      note: 'tabs first, the same file once, the project after',
    },
    {
      args: [candidateOptions({ suggested: 'b.docx' })],
      files: { 'p/a.docx': '', 'p/b.docx': '' },
      note: 'the model suggested a candidate',
    },
    {
      args: [candidateOptions({ suggested: '$DIR/p/a.docx', projectFiles: [] })],
      files: { 'p/a.docx': '' },
      note: 'projectFiles given (none) and a suggested file of the project not among them',
    },
    {
      args: [candidateOptions({ suggested: 'sub/new.md', projectFiles: ['$DIR/p/a.docx'] })],
      files: { 'p/a.docx': '', 'p/sub/new.md': '' },
      note: 'a relative suggestion inside the project, relative to its root',
    },
    {
      args: [candidateOptions({ suggested: '../o/o.md', projectFiles: [] })],
      files: { 'o/o.md': '', 'p/x': '' },
      note: 'a suggestion outside the project folder',
    },
    {
      args: [
        candidateOptions({ suggested: 'link.md', projectFiles: [] }),
        [['$DIR/p/link.md', '$DIR/o/o.md']],
      ],
      files: { 'o/o.md': '', 'p/x': '' },
      note: 'a link inside the folder that leads out',
    },
    {
      args: [candidateOptions({ suggested: 'sub.md', projectFiles: [] })],
      files: { 'p/sub.md/x.txt': '' },
      note: 'a folder is not a file',
    },
    {
      args: [candidateOptions({ suggested: 'notes.bin', projectFiles: [] })],
      files: { 'p/notes.bin': '' },
      note: 'not a document file',
    },
    {
      args: [candidateOptions({ suggested: 'gone.md', projectFiles: [] })],
      files: { 'p/x': '' },
      note: 'a file that is not there',
    },
    {
      args: [candidateOptions({ projectRoot: '$DIR/gone', suggested: 'a.md', projectFiles: [] })],
      note: 'a project folder that is not there',
    },
    {
      args: [
        candidateOptions({
          platform: 'win32',
          projectFiles: ['C:\\P\\A.docx', 'c:\\p\\a.DOCX'],
        }),
      ],
      note: 'on Windows paths differing in case are one file',
    },
    {
      args: [
        candidateOptions({
          platform: 'linux',
          projectFiles: ['C:\\P\\A.docx', 'c:\\p\\a.DOCX'],
        }),
      ],
      note: 'elsewhere they are two',
    },
  ],
}

const CANDIDATE = {
  id: 'c0',
  path: '$DIR/p/a.docx',
  title: 'a',
  fileName: 'a.docx',
  from: 'tab',
  unsaved: true,
}

const candidateView: FnSpec = {
  ts: (a) => skills.candidateView(a[0] as never),
  cases: cases([CANDIDATE], [{ ...CANDIDATE, id: 'c1', from: 'project', unsaved: false }]),
}

interface DeckEntry {
  name: string
  text: string
  dir?: boolean
}

/** a deck made from entries, as the bytes of its zip and the entries a scripted archive lists */
async function makeDeck(entries: DeckEntry[]): Promise<{ hex: string; entries: DeckEntry[] }> {
  const zip = new JSZip()
  for (const e of entries) {
    if (e.dir) zip.folder(e.name)
    else zip.file(e.name, e.text)
  }
  return { hex: hex(await zip.generateAsync({ type: 'uint8array' })), entries }
}

const OWN_NS = 'https://github.com/SeuPut0705/seuoffice/redaction/2026'
const OLD_NS = 'https://genspark.ai/genoffice/redaction/2026'
const EXT = '{9F1B2C3D-4E5F-4A6B-8C7D-9E0F1A2B3C4D}'
const DECKS = {
  own: await makeDeck([
    { name: 'ppt/slides/slide1.xml', text: '<a/>' },
    { name: 'ppt/slides/slide2.xml', text: `<p xmlns:go="${OWN_NS}"/>` },
  ]),
  old: await makeDeck([{ name: 'ppt/slides/slide1.xml', text: `<p xmlns:go="${OLD_NS}"/>` }]),
  ext: await makeDeck([{ name: 'ppt/presentation.xml', text: `<ext uri="${EXT}"/>` }]),
  clean: await makeDeck([
    { name: 'ppt/slides/slide1.xml', text: '<a/>' },
    { name: 'docProps/app.xml', text: '<b/>' },
  ]),
  notXml: await makeDeck([
    { name: 'ppt/media/note.txt', text: `go ${OWN_NS}` },
    { name: 'ppt/slides/slide1.xml', text: '<a/>' },
  ]),
  upper: await makeDeck([{ name: 'ppt/slides/SLIDE1.XML', text: `<p xmlns:go="${OLD_NS}"/>` }]),
  folder: await makeDeck([
    { name: 'ppt/x.xml/', text: '', dir: true },
    { name: 'ppt/slides/slide1.xml', text: '<a/>' },
  ]),
  empty: await makeDeck([]),
}

const redactionOf: FnSpec = {
  ts: async (a) => {
    const [name, body, inTab] = a as [string, { text?: string; hex?: string }, boolean]
    const bytes =
      body.hex !== undefined
        ? Buffer.from(body.hex, 'hex')
        : new TextEncoder().encode(body.text ?? '')
    return skills.templateRedactionOf(name, bytes, inTab)
  },
  cases: [
    ...(
      [
        ['a.md', '<span data-redaction="1">x</span>'],
        ['A.MARKDOWN', 'a DATA-REDACTION b'],
        ['a.txt', 'plain'],
        ['a.json', '{"data-redaction":1}'],
        ['a.html', '<p data-gx-redact>x</p>'],
        ['a.HTM', 'gx:redact: mark'],
        ['a.html', '<p data-redaction>not the html mark</p>'],
        ['a.md', '\uFEFFdata-redaction'],
        ['a.docx', 'data-redaction'],
        ['a.xlsx', ''],
        ['noextension', 'data-redaction'],
        ['.md', 'data-redaction'],
      ] as [string, string][]
    ).map(([n, t]): Case => ({ args: [n, { text: t }, false] })),
    { args: ['a.pdf', { text: '' }, true], note: 'a pdf open in a tab: not known' },
    { args: ['a.pdf', { text: '' }, false], note: 'a pdf not open: no marks' },
    { args: ['a.pptx', DECKS.own, false], note: 'the own namespace' },
    { args: ['a.pptx', DECKS.old, false], note: 'the old namespace' },
    { args: ['a.PPTX', DECKS.ext, true], note: 'the extension uri' },
    { args: ['a.pptx', DECKS.clean, false], note: 'a deck with no mark' },
    { args: ['a.pptx', DECKS.notXml, false], note: 'a mark only in a part that is not xml' },
    { args: ['a.pptx', DECKS.upper, false], note: 'the xml extension in capitals' },
    { args: ['a.pptx', DECKS.folder, false], note: 'a folder named like xml' },
    { args: ['a.pptx', DECKS.empty, false], note: 'an empty zip' },
    { args: ['a.pptx', { text: 'this is not a zip' }, false], note: 'not a zip: not known' },
  ],
}

const GUARD = {
  homeDir: '$DIR/home',
  protectedPaths: ['$DIR/home/.claude', '$DIR/data', '', '$DIR/linkdir'],
}
const readCandidate: FnSpec = {
  ts: async (a) => {
    makeLinks(a[2])
    const read = await skills.readTemplateCandidate(a[0] as string, a[1] as never)
    return read.ok ? { ok: true, hex: hex(read.bytes) } : read
  },
  cases: [
    { args: ['$DIR/p/a.md', GUARD], files: { 'p/a.md': 'hello' }, note: 'an ordinary file' },
    { args: ['$DIR/p/gone.md', GUARD], files: { 'p/a.md': '' }, note: 'not there' },
    { args: ['$DIR/p', GUARD], files: { 'p/a.md': '' }, note: 'a folder' },
    {
      args: ['$DIR/home/.claude/x.md', GUARD],
      files: { 'home/.claude/x.md': 's' },
      note: 'inside a protected folder',
    },
    {
      args: ['$DIR/data/x.md', GUARD],
      files: { 'data/x.md': 's' },
      note: 'inside the app data',
    },
    {
      args: ['$DIR/home/.codex/auth.json', GUARD],
      files: { 'home/.codex/auth.json': 's' },
      note: 'inside the Codex home',
    },
    {
      args: ['$DIR/p/link.md', GUARD, [['$DIR/p/link.md', '$DIR/data/x.md']]],
      files: { 'p/other.md': '', 'data/x.md': 's' },
      note: 'a link into a protected folder',
    },
    {
      args: ['$DIR/home/notcodex/x.md', GUARD],
      files: { 'home/notcodex/x.md': 'fine' },
      note: 'a folder that only looks like one',
    },
    {
      args: ['$DIR/data2/x.md', GUARD],
      files: { 'data2/x.md': 'fine' },
      note: 'a sibling that starts with the same letters',
    },
    {
      args: ['$DIR/p/a.md', { homeDir: '$DIR/home', protectedPaths: [] }],
      files: { 'p/a.md': 'no guard' },
      note: 'no protected folder',
    },
  ],
}

const skillsGroup: Group = {
  'agent-skills.userSkillsManageGate': manageGate,
  'agent-skills.agentSessionSkillsOf': sessionSkills,
  'agent-skills.agentSkillProposalOf': proposalOf,
  'agent-skills.projectTemplateFiles': templateFiles,
  'agent-skills.agentTemplateCandidates': templateCandidates,
  'agent-skills.candidateView': candidateView,
  'agent-skills.templateRedactionOf': redactionOf,
  'agent-skills.readTemplateCandidate': readCandidate,
}

// ---- agent-window: the window of a session ---------------------------------

const repo = new URL('../../../', import.meta.url)
const scratch = new URL('../out/b5-agent-skills/', import.meta.url)
let scratchCount = 0

/**
 * agent-window.ts as a copy of its source with `__dirname` set to `/app/main` and
 * every relative import made absolute: a copy per case, so each case starts
 * from the module state of a fresh process (the Rust side keeps no global).
 */
async function loadWindow(): Promise<typeof win> {
  const original = new URL('apps/shell/src/main/agent/agent-window.ts', repo)
  const dir = dirname(fileURLToPath(original))
  const src = readFileSync(original, 'utf8')
    .split('__dirname')
    .join("'/app/main'")
    .replace(
      /(from\s+|import\()\s*'(\.{1,2}\/[^']+)'/g,
      (_m: string, pre: string, spec: string) => {
        const target = resolvePath(dir, spec)
        const withExt = /\.(ts|mts|js|json)$/.test(target) ? target : `${target}.ts`
        return `${pre}'${pathToFileURL(withExt).href}'`
      },
    )
  mkdirSync(fileURLToPath(scratch), { recursive: true })
  if (scratchCount === 0) {
    process.on('exit', () => rmSync(fileURLToPath(scratch), { recursive: true, force: true }))
  }
  scratchCount += 1
  const path = fileURLToPath(new URL(`${scratchCount}-agent-window.mts`, scratch))
  writeFileSync(path, src)
  return import(pathToFileURL(path).href)
}

interface DepsSpec {
  lang: string
  /** the window title of `lang` (`agentText(lang, 'windowTitle')`): only the Rust side reads it */
  titles: Record<string, string>
  theme: string
  statuses: Record<string, { state: string; meteredAccepted?: boolean }>
  metered: Record<string, boolean> | null
  prefs: { provider: string; mode: string; recentFolders: string[]; warningAccepted: number }
  /** the main window: its page has id 1 */
  parent: { destroyed: boolean } | null
  userData: string
  homeDir?: string
  openDocuments: string[]
  openPath: boolean
  projectPrefs?: { read: unknown; write: unknown }
  projectSkills?: { view: unknown; set: unknown }
  preview?: unknown
  listSkills?: 'throws' | unknown[]
}

interface Step {
  open?: { rendererUrl?: string }
  minimize?: boolean
  destroy?: true
  fire?: string
  openUrl?: string
  /** a key of AGENT_CHANNELS, or `homeOpen` */
  invoke?: string
  /** whose page sends: `win`, `home` or `other` */
  sender?: string
  args?: unknown[]
  isWindowContents?: string
  /** an event of the program of the nth session */
  sessionEvent?: number
  event?: unknown
  tool?: 'proposeSkill' | 'proposeInstall'
  session?: number
  input?: unknown
  address?: string
  tabs?: 'throws' | unknown[]
  /** do not wait for the handler: it is held by a program that does not answer yet */
  detach?: true
  /** let the held program answer; the result is the held handler's */
  release?: true
}

interface World {
  deps: DepsSpec
  dialog: unknown
  /** the fake program does not answer a start until a `release` step */
  hold?: boolean
  /** the deck behind a pptx candidate (Rust only: the TypeScript reads the file) */
  deck?: { entries: DeckEntry[] }
  steps: Step[]
}

/** a promise and the call that settles it */
const gate = (): { promise: Promise<void>; open: () => void } => {
  let open: () => void = () => undefined
  const promise = new Promise<void>((resolve) => {
    open = resolve
  })
  return { promise, open }
}

/** `crypto.randomUUID` answers `uuid-1`, `uuid-2` ... while `run` runs */
async function withUuids<T>(run: () => Promise<T>): Promise<T> {
  const real = crypto.randomUUID
  let n = 0
  ;(crypto as Any).randomUUID = () => `uuid-${++n}`
  syncBuiltinESMExports()
  try {
    return await run()
  } finally {
    ;(crypto as Any).randomUUID = real
    syncBuiltinESMExports()
  }
}

async function withClock<T>(now: number, run: () => Promise<T>): Promise<T> {
  const Real = Date
  class Clock extends Real {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(now)
      else super(...(args as [number]))
    }
    static override now(): number {
      return now
    }
  }
  globalThis.Date = Clock as unknown as DateConstructor
  try {
    return await run()
  } finally {
    globalThis.Date = Real
  }
}

const failing = (what: unknown, name: string): unknown => {
  if (what === 'throws') throw new Error(name)
  return what
}

/** the services of the window (`deps`) a spec describes, each impure call logged */
function depsOf(d: DepsSpec, log: TsContext['log'], pageOfHome: () => Any): Any {
  return {
    runners: {},
    statuses: () => d.statuses,
    aiSettings: () => ({ providers: {}, meteredAccepted: d.metered ?? undefined }),
    openDocuments: () => d.openDocuments,
    userData: d.userData,
    homeDir: d.homeDir,
    language: () => d.lang,
    lang: () => d.lang,
    theme: () => d.theme,
    readPrefs: () => d.prefs,
    writePrefs: (p: unknown) => log('writePrefs', p),
    parentWindow: () =>
      d.parent && { isDestroyed: () => d.parent!.destroyed, webContents: pageOfHome() },
    openPath: (p: string) => (log('openPath', p), d.openPath),
    readProjectPrefs: d.projectPrefs
      ? (f: string) => (log('readProjectPrefs', f), failing(d.projectPrefs!.read, 'read'))
      : undefined,
    writeProjectPrefs: d.projectPrefs
      ? (f: string, p: unknown) => (
          log('writeProjectPrefs', f, p),
          failing(d.projectPrefs!.write, 'write')
        )
      : undefined,
    projectSkills: d.projectSkills && {
      view: async (f: string) => (
        log('projectSkills.view', f),
        failing(d.projectSkills!.view, 'view')
      ),
      set: async (f: string, on: boolean) => (
        log('projectSkills.set', f, on),
        failing(d.projectSkills!.set, 'set')
      ),
    },
    openTemplatePreview:
      d.preview !== undefined
        ? async (owner: { id: number }, input: { bytes: Uint8Array }) => {
            log('preview', owner.id, { ...input, bytes: hex(input.bytes) })
            return failing(d.preview, 'preview')
          }
        : undefined,
    listSkills:
      d.listSkills === undefined
        ? undefined
        : async () => {
            log('listSkills')
            return failing(d.listSkills, 'list')
          },
  }
}

async function runWindow(world: World, cx: TsContext): Promise<unknown[]> {
  let quiet = false
  const log = (...a: unknown[]): void => {
    if (!quiet) cx.log(...a)
  }
  const handlers: Record<string, (event: unknown, ...args: unknown[]) => unknown> = {}
  const pages = new Map<string, Any>()
  const page = (name: string, id: number): Any => {
    let p = pages.get(name)
    if (!p) {
      p = { id, isDestroyed: () => false, send: (c: string, pl: unknown) => log('send', id, c, pl) }
      pages.set(name, p)
    }
    return p
  }
  let current: Any = null
  const setCurrent = (window: Any): void => {
    current = window
  }
  let nextId = 5
  class FakeWindow {
    destroyed = false
    minimized = false
    listeners: Record<string, () => void> = {}
    openHandler: ((details: { url: string }) => unknown) | undefined
    webContents: Any
    constructor(options: unknown) {
      log('BrowserWindow', options)
      const id = nextId++
      this.webContents = {
        id,
        isDestroyed: () => this.destroyed,
        send: (c: string, pl: unknown) => log('send', id, c, pl),
        setWindowOpenHandler: (fn: (details: { url: string }) => unknown) => {
          log('setWindowOpenHandler')
          this.openHandler = fn
        },
      }
      setCurrent(this)
    }
    removeMenu(): void {
      log('removeMenu')
    }
    once(event: string, fn: () => void): void {
      log('once', event)
      this.listeners[event] = fn
    }
    on(event: string, fn: () => void): void {
      log('on', event)
      this.listeners[event] = fn
    }
    loadURL(url: string): void {
      log('loadURL', url)
    }
    loadFile(file: string): void {
      log('loadFile', file)
    }
    show(): void {
      log('show')
    }
    focus(): void {
      log('focus')
    }
    restore(): void {
      log('restore')
      this.minimized = false
    }
    isMinimized(): boolean {
      return this.minimized
    }
    isDestroyed(): boolean {
      return this.destroyed
    }
  }
  useElectron({
    ipcMain: {
      handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => {
        handlers[channel] = fn
      },
      on() {},
      removeHandler() {},
    },
    BrowserWindow: FakeWindow,
    dialog: {
      showOpenDialog: async (_w: unknown, options: unknown) => (
        log('showOpenDialog', options),
        world.dialog
      ),
    },
    shell: { openExternal: async (url: string) => log('openExternal', url) },
    app: { getVersion: () => '0.0.0' },
  })

  const reached = gate()
  const opened = gate()
  let pending: unknown
  const hooks: Any[] = []
  const onEvents: Array<(event: unknown) => void> = []
  const runner = (kind: string) => async (options: Any, onEvent: (event: unknown) => void) => {
    log(
      'runner',
      kind,
      kind === 'codex'
        ? {
            projectRoot: options.projectRoot,
            mode: options.mode,
            webSearch: options.webSearch,
            network: options.network,
          }
        : { projectRoot: options.projectRoot, mode: options.mode },
    )
    onEvents.push(onEvent)
    if (world.hold) {
      reached.open()
      await opened.promise
    }
    return {
      send: async (text: string) => log('session.send', text),
      answer: (id: string, a: unknown) => log('session.answer', id, a),
      stop: () => log('session.stop'),
      setOpenDocuments: (docs: unknown) => log('setOpenDocuments', docs),
    }
  }
  const deps = depsOf(world.deps, log, () => page('home', 1))
  deps.runners = { claude: runner('claude'), codex: runner('codex') }
  deps.startAppMcp = async (projectRoot: string, extra: { skillTools: unknown }) => {
    log('startAppMcp', projectRoot)
    hooks.push(extra.skillTools)
    return { url: 'http://localhost:1', token: 't', stop: async () => log('appMcp.stop') }
  }
  const mod = await loadWindow()
  mod.configureAgentWindow(deps)

  const sender = (name: string): Any => {
    if (name === 'home') return page('home', 1)
    if (name === 'other') return page('other', 77)
    return current ? current.webContents : page('pending', 5)
  }
  const plain = (value: unknown): unknown =>
    value === undefined
      ? null
      : JSON.parse(JSON.stringify(value, (_k, v) => (v instanceof Uint8Array ? hex(v) : v)))
  const results: unknown[] = []
  for (const step of world.steps) {
    let result: unknown = null
    if (step.open) {
      const had = process.env.ELECTRON_RENDERER_URL
      if (step.open.rendererUrl !== undefined) {
        process.env.ELECTRON_RENDERER_URL = step.open.rendererUrl
      } else delete process.env.ELECTRON_RENDERER_URL
      try {
        mod.openAgentWindow()
      } finally {
        if (had === undefined) delete process.env.ELECTRON_RENDERER_URL
        else process.env.ELECTRON_RENDERER_URL = had
      }
    } else if (step.minimize !== undefined) {
      current.minimized = step.minimize
    } else if (step.destroy) {
      current.destroyed = true
    } else if (step.fire) {
      current.listeners[step.fire]?.()
    } else if (step.openUrl !== undefined) {
      result = plain(current.openHandler?.({ url: step.openUrl }))
    } else if (step.invoke) {
      const channel =
        step.invoke === 'homeOpen'
          ? homeChannel.AGENT_HOME_OPEN_CHANNEL
          : api.AGENT_CHANNELS[step.invoke as keyof typeof api.AGENT_CHANNELS]
      const call = handlers[channel]!(
        { sender: sender(step.sender ?? 'win') },
        ...(step.args ?? []),
      )
      if (step.detach) {
        const settled = await Promise.race([
          reached.promise.then(() => false),
          Promise.resolve(call).then(
            () => true,
            () => true,
          ),
        ])
        if (settled) result = plain(await call)
        else pending = call
      } else result = plain(await call)
    } else if (step.release) {
      opened.open()
      result = plain(await pending)
      pending = undefined
    } else if (step.isWindowContents) {
      result = mod.isAgentWindowContents(sender(step.isWindowContents))
    } else if (step.sessionEvent !== undefined) {
      onEvents[step.sessionEvent]!(step.event)
    } else if (step.tool) {
      const h = hooks[step.session ?? 0]
      try {
        if (step.tool === 'proposeSkill') {
          await h.proposeSkill(step.input, {
            openTabs: async () => {
              log('openTabs')
              if (step.tabs === 'throws') throw new Error('tabs')
              return step.tabs ?? []
            },
          })
        } else await h.proposeInstall(step.address)
        result = 'shown'
      } catch (error) {
        result = { threw: (error as Error).message }
      }
    }
    results.push(result)
  }
  quiet = true
  mod.stopAgentSessions()
  await tick()
  await tick()
  return results
}

// ---- agent-window: the cases ---------------------------------------------------

const PREFS = {
  provider: 'codex',
  mode: 'ask-writes',
  recentFolders: ['/a', '/b'],
  warningAccepted: 1,
}

const DEPS: DepsSpec = {
  lang: 'ko',
  titles: { ko: '\uC5D0\uC774\uC804\uD2B8', en: 'Agent' },
  theme: 'dark',
  statuses: { 'claude-code': { state: 'ready' }, codex: { state: 'ready' } },
  metered: null,
  prefs: PREFS,
  parent: { destroyed: false },
  userData: '$DIR/ud',
  openDocuments: [],
  openPath: true,
}

const world = (steps: Step[], over: Partial<World> = {}, deps: Partial<DepsSpec> = {}): World => ({
  deps: { ...DEPS, ...deps },
  dialog: { canceled: false, filePaths: ['/picked'] },
  deck: { entries: DECKS.own.entries },
  steps,
  ...over,
})

const OPEN: Step = { open: {} }
const invoke = (key: string, sender: string, ...args: unknown[]): Step => ({
  invoke: key,
  sender,
  args,
})
const FOLDER = '$DIR/proj'
const REQUEST = { provider: 'codex', mode: 'ask-commands', folder: FOLDER }
const PROJECT = {
  'proj/a.md': 'plain text',
  'proj/b.pptx': { hex: DECKS.own.hex },
  'proj/c.pdf': '%PDF',
  'proj/d.html': '<p data-gx-redact>x</p>',
  'ud/secret.md': 'secret',
}
const SETTINGS = JSON.stringify({
  agentProjectPrefs: { '/some/where': { codexWebSearch: 'live', codexNetwork: true } },
})
const SKILLS_VIEW = {
  skills: [{ name: 'a', title: 'A', description: 'd' }],
  allowed: true,
  changed: false,
}
const PREVIEW_OK = { ok: true, tabId: 't1', previewId: 'p1' }
const SKILL_INPUT = { ...INPUT, suggestedTemplatePath: 'a.md' }
const START = invoke('start', 'win', REQUEST)
/** a session is running: the window is open and the program started */
const SESSION: Step[] = [OPEN, START]
const KEY = 'uuid-2'

const caseOf = (
  steps: Step[],
  note: string,
  over: Partial<World> = {},
  deps: Partial<DepsSpec> = {},
  files: Case['files'] = PROJECT,
): Case => ({
  args: [world(steps, over, deps)],
  files,
  note,
})

const SENDERS = ['win', 'other', 'home'] as const

const windowCases: Case[] = [
  caseOf(
    [
      invoke('getInit', 'win'),
      invoke('getTheme', 'win'),
      invoke('pickFolder', 'win'),
      invoke('setPrefs', 'win', { provider: 'claude-code' }),
      invoke('getProjectPrefs', 'win', FOLDER),
      invoke('setProjectPrefs', 'win', FOLDER, { codexNetwork: true }),
      invoke('getProjectSkills', 'win', FOLDER),
      invoke('setProjectSkills', 'win', FOLDER, true),
      invoke('start', 'win', REQUEST),
      invoke('send', 'win', 's', 'hi'),
      invoke('answer', 'win', 's', 'r', true, 'once'),
      invoke('stop', 'win', 's'),
      invoke('openFile', 'win', 's', 'a.md'),
      invoke('templateCheck', 'win', 'k', 'c0'),
      invoke('templateAsIs', 'win', 'k', 'c0'),
      invoke('templateBlank', 'win', 'k', 'c0', {}),
      { isWindowContents: 'win' },
    ],
    'before the window is open nothing but the theme answers',
  ),
  caseOf(
    [
      OPEN,
      ...SENDERS.map((s) => invoke('getInit', s)),
      invoke('getTheme', 'other'),
      { isWindowContents: 'win' },
      { isWindowContents: 'other' },
      { isWindowContents: 'home' },
    ],
    'the window asks for its start: only its own page is answered',
  ),
  caseOf(
    [OPEN, invoke('getInit', 'win')],
    'init with the connections of the statuses',
    {},
    {
      lang: 'en',
      statuses: {
        'claude-code': { state: 'metered', meteredAccepted: true },
        codex: { state: 'checking' },
      },
      metered: { 'claude-code': true },
    },
  ),
  caseOf(
    [OPEN, invoke('getInit', 'win')],
    'a metered program the settings did not accept',
    {},
    {
      statuses: {
        'claude-code': { state: 'metered', meteredAccepted: true },
        codex: { state: 'off' },
      },
    },
  ),
  caseOf(
    [
      OPEN,
      { fire: 'ready-to-show' },
      OPEN,
      { minimize: true },
      OPEN,
      { destroy: true },
      { isWindowContents: 'win' },
      invoke('getInit', 'win'),
      OPEN,
      { fire: 'ready-to-show' },
      { openUrl: 'https://example.com/page' },
      { openUrl: 'javascript:alert(1)' },
      { openUrl: 'file:///etc/passwd' },
      { fire: 'closed' },
      invoke('getInit', 'win'),
      OPEN,
    ],
    'the window opens, is brought forward, restored, replaced when destroyed and closed',
    {},
    { lang: 'en' },
  ),
  caseOf([{ open: { rendererUrl: 'http://localhost:5173' } }], 'the dev server loads the page'),
  caseOf([{ open: { rendererUrl: '' } }], 'an empty dev server address loads the built page'),
  caseOf(
    [
      invoke('homeOpen', 'home'),
      invoke('homeOpen', 'win'),
      invoke('homeOpen', 'other'),
      { fire: 'ready-to-show' },
    ],
    'only Home opens the window',
  ),
  caseOf([invoke('homeOpen', 'home')], 'Home is closed', {}, { parent: { destroyed: true } }),
  caseOf([invoke('homeOpen', 'home')], 'there is no main window', {}, { parent: null }),
  ...[
    [{ canceled: false, filePaths: ['/picked'] }, 'a folder was picked'],
    [{ canceled: true, filePaths: ['/picked'] }, 'cancelled'],
    [{ canceled: false, filePaths: [] }, 'nothing picked'],
    [{ canceled: false, filePaths: [''] }, 'an empty path'],
  ].map(([dialog, note]) =>
    caseOf([OPEN, invoke('pickFolder', 'win'), invoke('pickFolder', 'other')], note as string, {
      dialog,
    }),
  ),
  caseOf(
    [
      OPEN,
      invoke('setPrefs', 'win', { provider: 'claude-code', mode: 'trust-project' }),
      invoke('setPrefs', 'win', { recentFolders: ['/b', '/zzz', '/a'], warningAccepted: 5 }),
      invoke('setPrefs', 'win', { recentFolders: [], warningAccepted: 0 }),
      invoke('setPrefs', 'win', { provider: 'nope', mode: 3, warningAccepted: 1.5 }),
      invoke('setPrefs', 'win', null),
      invoke('setPrefs', 'win', 'text'),
      invoke('setPrefs', 'other', { provider: 'claude-code' }),
    ],
    'the window changes its preferences, but cannot add folders or claim a newer warning',
  ),
  caseOf(
    [
      OPEN,
      invoke('getProjectPrefs', 'win', '/some/where'),
      invoke('getProjectPrefs', 'win', FOLDER),
      invoke('getProjectPrefs', 'win', 'relative/dir'),
      invoke('getProjectPrefs', 'win', 42),
      invoke('getProjectPrefs', 'other', FOLDER),
      invoke('setProjectPrefs', 'win', '/some/where', { codexWebSearch: 'disabled' }),
      invoke('setProjectPrefs', 'win', FOLDER, {
        codexWebSearch: 'live',
        codexNetwork: true,
        other: 1,
      }),
      invoke('setProjectPrefs', 'win', 'relative/dir', { codexNetwork: true }),
      invoke('setProjectPrefs', 'win', 42, {}),
      invoke('setProjectPrefs', 'other', FOLDER, { codexNetwork: true }),
      invoke('getProjectPrefs', 'win', FOLDER),
    ],
    'the folder\u2019s remembered choices in the app settings file',
    {},
    {},
    { ...PROJECT, 'ud/app-settings.json': SETTINGS },
  ),
  caseOf(
    [
      OPEN,
      invoke('getProjectPrefs', 'win', FOLDER),
      invoke('setProjectPrefs', 'win', FOLDER, { codexWebSearch: 'live' }),
    ],
    'the app gave its own reader and writer',
    {},
    {
      projectPrefs: {
        read: { codexWebSearch: 'live', codexNetwork: true },
        write: { codexWebSearch: 'disabled', codexNetwork: false },
      },
    },
  ),
  caseOf(
    [
      OPEN,
      invoke('getProjectPrefs', 'win', FOLDER),
      invoke('setProjectPrefs', 'win', FOLDER, { codexWebSearch: 'live' }),
    ],
    'the reader and writer throw',
    {},
    { projectPrefs: { read: 'throws', write: 'throws' } },
  ),
  caseOf(
    [
      OPEN,
      invoke('getProjectSkills', 'win', FOLDER),
      invoke('getProjectSkills', 'win', 'rel'),
      invoke('getProjectSkills', 'other', FOLDER),
      invoke('setProjectSkills', 'win', FOLDER, true),
      invoke('setProjectSkills', 'win', FOLDER, 'yes'),
      invoke('setProjectSkills', 'win', 'rel', true),
      invoke('setProjectSkills', 'other', FOLDER, true),
    ],
    'a project folder\u2019s own skills',
    {},
    { projectSkills: { view: SKILLS_VIEW, set: SKILLS_VIEW } },
  ),
  caseOf(
    [
      OPEN,
      invoke('getProjectSkills', 'win', FOLDER),
      invoke('setProjectSkills', 'win', FOLDER, true),
    ],
    'the project skills throw',
    {},
    { projectSkills: { view: 'throws', set: 'throws' } },
  ),
  caseOf(
    [
      OPEN,
      invoke('getProjectSkills', 'win', FOLDER),
      invoke('setProjectSkills', 'win', FOLDER, true),
    ],
    'the app has no project skills',
  ),
  caseOf(
    [
      OPEN,
      invoke('start', 'win', REQUEST),
      invoke('start', 'win', {
        ...REQUEST,
        provider: 'claude-code',
        mode: 'trust-project',
        folder: '/nowhere/at/all',
      }),
      invoke('start', 'win', { ...REQUEST, provider: 'gemini' }),
      invoke('start', 'win', { ...REQUEST, mode: 'yolo' }),
      invoke('start', 'win', null),
      invoke('start', 'other', REQUEST),
    ],
    'starting a program: a codex start, a folder that is not there, a request that is not valid',
    {},
    { prefs: { ...PREFS, recentFolders: ['/a', '/b'] } },
  ),
  caseOf(
    [
      OPEN,
      invoke('start', 'win', { ...REQUEST, provider: 'claude-code' }),
      invoke('start', 'win', REQUEST),
    ],
    'a program that is not connected is not started',
    {},
    { statuses: { 'claude-code': { state: 'ready' }, codex: { state: 'checking' } } },
  ),
  caseOf(
    [OPEN, invoke('start', 'win', REQUEST)],
    'the first-use warning was not accepted',
    {},
    { prefs: { ...PREFS, warningAccepted: 0 } },
  ),
  caseOf(
    [
      ...SESSION,
      invoke('send', 'win', 'uuid-1', 'hello'),
      invoke('send', 'win', 'uuid-1', '   '),
      invoke('send', 'win', 'uuid-1', 7),
      invoke('send', 'win', 7, 'hello'),
      invoke('send', 'win', 'uuid-9', 'hello'),
      invoke('send', 'other', 'uuid-1', 'hello'),
      invoke('answer', 'win', 'uuid-1', 'r1', true, 'session'),
      invoke('answer', 'win', 'uuid-1', 'r2', false, 'session'),
      invoke('answer', 'win', 'uuid-1', 'r3', 'yes', 'once'),
      invoke('answer', 'win', 'uuid-1', 7, true, 'once'),
      invoke('answer', 'other', 'uuid-1', 'r4', true, 'once'),
      invoke('openFile', 'win', 'uuid-1', 'a.md'),
      invoke('openFile', 'win', 'uuid-1', '$DIR/proj/c.pdf'),
      invoke('openFile', 'win', 'uuid-1', '../outside.md'),
      invoke('openFile', 'win', 'uuid-1', 'missing.md'),
      invoke('openFile', 'win', 'uuid-1', ''),
      invoke('openFile', 'win', 'uuid-9', 'a.md'),
      invoke('openFile', 'win', 'uuid-1', 7),
      invoke('openFile', 'other', 'uuid-1', 'a.md'),
      invoke('stop', 'other', 'uuid-1'),
      invoke('stop', 'win', 7),
      invoke('stop', 'win', 'uuid-1'),
      invoke('send', 'win', 'uuid-1', 'again'),
      invoke('openFile', 'win', 'uuid-1', 'a.md'),
    ],
    'a running session: messages, answers, opening files, stopping',
    {},
    {},
    { ...PROJECT, 'outside.md': 'x' },
  ),
  caseOf(
    [...SESSION, invoke('openFile', 'win', 'uuid-1', 'a.md')],
    'nothing could open the file',
    {},
    { openPath: false },
  ),
  caseOf(
    [
      ...SESSION,
      {
        sessionEvent: 0,
        event: { type: 'started', provider: 'codex', model: 'm', skills: ['a', 'b'] },
      },
      {
        sessionEvent: 0,
        event: {
          type: 'permission',
          request: {
            id: 'r1',
            provider: 'codex',
            kind: 'command',
            tool: 'sh',
            command: 'ls',
            paths: [],
          },
        },
      },
      { sessionEvent: 0, event: { type: 'error', kind: 'rate-limit', message: '/home/x leaked' } },
      { sessionEvent: 0, event: { type: 'documents-unprotected', paths: ['/a', '/b', '/c'] } },
      { sessionEvent: 0, event: { type: 'text', text: 'hello' } },
      { destroy: true },
      { sessionEvent: 0, event: { type: 'text', text: 'nobody is listening' } },
    ],
    'the program\u2019s events reach the window while it is open',
  ),
  caseOf(
    [
      ...SESSION,
      { sessionEvent: 0, event: { type: 'ended' } },
      invoke('send', 'win', 'uuid-1', 'late'),
      { fire: 'closed' },
    ],
    'the program ended',
  ),
  caseOf(
    [
      ...SESSION,
      { fire: 'closed' },
      { sessionEvent: 0, event: { type: 'text', text: 'late' } },
      invoke('send', 'win', 'uuid-1', 'late'),
    ],
    'closing the window ends its sessions',
  ),
  caseOf(
    [
      ...SESSION,
      { tool: 'proposeSkill', session: 0, input: { ...SKILL_INPUT }, tabs: [] },
      { destroy: true },
      OPEN,
      { sessionEvent: 0, event: { type: 'text', text: 'the old window is gone' } },
      { tool: 'proposeSkill', session: 0, input: { ...SKILL_INPUT }, tabs: [] },
      invoke('templateCheck', 'win', KEY, 'c0'),
      invoke('send', 'win', 'uuid-1', 'hello'),
      invoke('getInit', 'win'),
    ],
    'a new window is not the owner of the old window\u2019s session or cards',
  ),
  caseOf(
    [
      ...SESSION,
      {
        tool: 'proposeSkill',
        session: 0,
        input: { ...SKILL_INPUT },
        tabs: [{ title: 'Tab', filePath: '$DIR/proj/c.pdf', dirty: true }],
      },
      invoke('templateCheck', 'win', KEY, 'c0'),
      invoke('templateCheck', 'win', KEY, 'c1'),
      invoke('templateCheck', 'win', KEY, 'c2'),
      invoke('templateCheck', 'win', KEY, 'c3'),
      invoke('templateCheck', 'win', KEY, 'c4'),
      invoke('templateCheck', 'win', KEY, 'c9'),
      invoke('templateCheck', 'other', KEY, 'c0'),
      invoke('templateCheck', 'win', 'nokey', 'c0'),
      invoke('templateCheck', 'win', 7, 'c0'),
      invoke('templateAsIs', 'win', KEY, 'c0'),
      invoke('templateAsIs', 'win', KEY, 'c1'),
      invoke('templateAsIs', 'win', KEY, 'c2'),
      invoke('templateAsIs', 'win', KEY, 'c4'),
      invoke('templateAsIs', 'win', KEY, 'c9'),
      invoke('templateBlank', 'win', KEY, 'c1', {
        tabTitle: 'Tab',
        text: 'clear it',
        draft: { a: 1 },
      }),
    ],
    'a skill card: its candidates read, a pdf open in a tab is not known, a deck with a mark',
    {},
    { openDocuments: [], preview: PREVIEW_OK },
  ),
  caseOf(
    [
      ...SESSION,
      {
        tool: 'proposeSkill',
        session: 0,
        input: { ...SKILL_INPUT },
        tabs: [{ title: 'S', filePath: '$DIR/ud/secret.md', dirty: false }],
      },
      invoke('templateCheck', 'win', KEY, 'c0'),
      invoke('templateAsIs', 'win', KEY, 'c0'),
      invoke('templateCheck', 'win', KEY, 'c1'),
    ],
    'a candidate in the app\u2019s data is never read',
  ),
  caseOf(
    [
      ...SESSION,
      { tool: 'proposeSkill', session: 0, input: { ...SKILL_INPUT }, tabs: [] },
      invoke('templateCheck', 'win', KEY, 'c2'),
      invoke('templateAsIs', 'win', KEY, 'c2'),
    ],
    'a pdf open in a tab by another case of letters',
    {},
    { openDocuments: ['$DIR/PROJ/C.PDF'] },
  ),
  ...[
    [PREVIEW_OK, 'opened'],
    [{ ok: false, reason: 'busy' }, 'the opener refuses'],
    ['throws', 'the opener throws'],
  ].map(([preview, note]) =>
    caseOf(
      [
        ...SESSION,
        { tool: 'proposeSkill', session: 0, input: { ...SKILL_INPUT }, tabs: [] },
        invoke('templateBlank', 'win', KEY, 'c0', { tabTitle: 'Tab', text: 'clear it' }),
        invoke('templateBlank', 'win', KEY, 'c3', {
          tabTitle: 'Tab',
          text: 'clear it',
          draft: { a: 1 },
        }),
        invoke('templateBlank', 'win', KEY, 'c0', { tabTitle: '', text: 'x' }),
        invoke('templateBlank', 'win', KEY, 'c0', { tabTitle: 'x', text: 7 }),
        invoke('templateBlank', 'win', KEY, 'c0', null),
        invoke('templateBlank', 'win', KEY, 'c0', {
          tabTitle: 'T'.repeat(400),
          text: 'y'.repeat(12000),
        }),
        invoke('templateBlank', 'win', KEY, 'c4', { tabTitle: 'x', text: 'y' }),
        invoke('templateBlank', 'other', KEY, 'c0', { tabTitle: 'x', text: 'y' }),
      ],
      note as string,
      {},
      { preview },
    ),
  ),
  caseOf(
    [
      ...SESSION,
      { tool: 'proposeSkill', session: 0, input: { ...SKILL_INPUT }, tabs: [] },
      invoke('templateBlank', 'win', KEY, 'c0', { tabTitle: 'Tab', text: 'x' }),
    ],
    'the app has no template preview',
  ),
  caseOf(
    [
      ...SESSION,
      { tool: 'proposeSkill', session: 0, input: { ...INPUT, title: 'New' }, tabs: 'throws' },
      { tool: 'proposeSkill', session: 0, input: { ...INPUT, targetId: 'a' } },
      { tool: 'proposeInstall', session: 0, address: 'https://github.com/o/r' },
      { destroy: true },
      { tool: 'proposeSkill', session: 0, input: { ...INPUT } },
      { tool: 'proposeInstall', session: 0, address: 'https://github.com/o/r' },
    ],
    'the skill tools of a session, and once the window is gone',
    {},
    { listSkills: LIST },
  ),
  caseOf(
    [
      ...SESSION,
      { tool: 'proposeSkill', session: 0, input: { ...INPUT, targetId: 'p' }, tabs: [] },
      { tool: 'proposeSkill', session: 0, input: { ...INPUT, targetId: 'a' }, tabs: [] },
    ],
    'the list of skills cannot be read',
    {},
    { listSkills: 'throws' },
  ),
  caseOf(
    [
      OPEN,
      { ...START, detach: true },
      invoke('send', 'win', 'uuid-1', 'early'),
      invoke('openFile', 'win', 'uuid-1', 'a.md'),
      invoke('stop', 'win', 'uuid-1'),
      invoke('openFile', 'win', 'uuid-1', 'a.md'),
      { release: true },
      invoke('send', 'win', 'uuid-1', 'late'),
    ],
    'stop while start awaits: the stop runs at once, the start then answers stopped and writes no preferences',
    { hold: true },
  ),
  caseOf(
    [
      OPEN,
      { ...START, detach: true },
      { fire: 'closed' },
      { sessionEvent: 0, event: { type: 'text', text: 'nobody is listening' } },
      { release: true },
    ],
    'the window closes while a start awaits',
    { hold: true },
  ),
  caseOf(
    [
      OPEN,
      { ...START, detach: true },
      invoke('answer', 'win', 'uuid-1', 'r1', true, 'once'),
      { release: true },
      invoke('send', 'win', 'uuid-1', 'hello'),
      invoke('stop', 'win', 'uuid-1'),
    ],
    'an answer while a start awaits finds no program; the start goes on after it',
    { hold: true },
  ),
]

/** `startAgentForWindow` with a service and a manager that answer as the case says */
interface DirectStart {
  deps: DepsSpec
  start: unknown
}

const directStart = (start: unknown, deps: Partial<DepsSpec> = {}): DirectStart => ({
  deps: { ...DEPS, ...deps },
  start,
})
const STARTED = {
  ok: true,
  sessionId: 's1',
  skills: [
    {
      id: 'user:a',
      name: 'a',
      source: 'user',
      title: 'A',
      description: 'd',
      invoke: 'auto',
      skillMd: '/x/SKILL.md',
    },
  ],
}
const fail = (failure: unknown, cause?: string) => ({
  ok: false,
  failure,
  ...(cause ? { cause } : {}),
})
const exited = (exitCode?: number) => ({
  reason: 'program-problem',
  problem: { type: 'exited', ...(exitCode === undefined ? {} : { exitCode }) },
})

const startCases: Case[] = [
  {
    args: [directStart(STARTED), REQUEST],
    files: { 'ud/app-settings.json': SETTINGS },
    note: 'a codex start, the folder has no remembered choices',
  },
  {
    args: [directStart(STARTED), { ...REQUEST, provider: 'claude-code', folder: '/some/where' }],
    files: { 'ud/app-settings.json': SETTINGS },
    note: 'claude code takes no codex choices',
  },
  {
    args: [directStart(STARTED), { ...REQUEST, folder: '/some/where' }],
    files: { 'ud/app-settings.json': SETTINGS },
    note: 'remembered choices of the folder reach codex',
  },
  {
    args: [directStart(STARTED), { provider: 'gemini', mode: 'ask-commands', folder: '/x' }],
    note: 'unknown program',
  },
  {
    args: [directStart(STARTED), { provider: 'codex', mode: 'yolo', folder: '/x' }],
    note: 'unknown mode',
  },
  { args: [directStart(STARTED), null], note: 'no request' },
  { args: [directStart(STARTED), 'codex'], note: 'a request that is a string' },
  {
    args: [directStart(STARTED), { provider: 'codex', mode: 'ask-commands' }],
    files: { 'ud/app-settings.json': '{}' },
    note: 'no folder: the empty one',
  },
  {
    args: [directStart(STARTED, { prefs: { ...PREFS, warningAccepted: 0 } }), REQUEST],
    note: 'the first-use warning was not accepted',
  },
  {
    args: [directStart(STARTED, { prefs: { ...PREFS, warningAccepted: 2 } }), REQUEST],
    files: { 'ud/app-settings.json': '{}' },
    note: 'a newer warning than the app has counts',
  },
  {
    args: [directStart(STARTED, { projectPrefs: { read: 'throws', write: 'throws' } }), REQUEST],
    note: 'the folder cannot be read',
  },
  {
    args: [directStart(fail(exited(3), 'Error:ENOENT')), REQUEST],
    files: { 'ud/placeholder': '' },
    note: 'the program exited: recorded with its code',
  },
  {
    args: [directStart(fail(exited(), 'Error')), REQUEST],
    files: { 'ud/placeholder': '' },
    note: 'the program exited without a code',
  },
  {
    args: [directStart(fail({ reason: 'run-error', kind: 'signed-out' }, 'Error')), REQUEST],
    files: { 'ud/placeholder': '' },
    note: 'a run error: recorded, no code',
  },
  {
    args: [
      directStart(
        fail(
          { reason: 'program-problem', problem: { type: 'refused', step: 'a/b', code: 2 } },
          'TypeError',
        ),
      ),
      REQUEST,
    ],
    files: { 'ud/placeholder': '' },
    note: 'refused: only the exited problem has a code',
  },
  {
    args: [directStart(fail({ reason: 'stopped' })), REQUEST],
    files: { 'ud/placeholder': '' },
    note: 'a failure with no cause is not recorded',
  },
  {
    args: [
      directStart({ ...STARTED, mcpKeepInside: [], instructionsTruncated: ['CLAUDE.md'] }),
      REQUEST,
    ],
    files: { 'ud/app-settings.json': '{}' },
    note: 'an empty list is still told, and the truncated notes',
  },
  {
    args: [
      directStart({ ...STARTED, mcpKeepInside: ['srv'] }),
      { ...REQUEST, provider: 'claude-code', mode: 'trust-project' },
    ],
    note: 'the person\u2019s server that keeps content inside; the program and mode are remembered',
  },
]

const windowGroup: Group = {
  'agent-window.agentCodexStartChoices': {
    ts: (a) => win.agentCodexStartChoices(a[0] as never, a[1] as never),
    cases: cases(
      ['codex', { codexWebSearch: 'live', codexNetwork: true }],
      ['codex', { codexWebSearch: 'cached', codexNetwork: false }],
      ['codex', { codexWebSearch: 'disabled' }],
      ['claude-code', { codexWebSearch: 'live', codexNetwork: true }],
    ),
  },
  'agent-window.agentPermissionAnswer': {
    ts: (a) => win.agentPermissionAnswer(a[0], a[1]),
    cases: cases(
      [true, 'session'],
      [true, 'once'],
      [true, 'forever'],
      [true, null],
      [false, 'session'],
      ['yes', 'session'],
      [1, 'session'],
      [null, null],
    ),
  },
  'agent-window.agentEventView': {
    ts: (a) => win.agentEventView(a[0] as never),
    cases: cases(
      [{ type: 'started', provider: 'codex', model: 'm', skills: ['a', 'b'] }],
      [{ type: 'started', provider: 'claude-code', skills: [] }],
      [
        {
          type: 'permission',
          request: {
            id: 'r1',
            provider: 'codex',
            kind: 'command',
            tool: 'sh',
            command: 'ls',
            paths: [],
          },
        },
      ],
      [
        {
          type: 'permission',
          request: { provider: 'codex', kind: 'read', tool: 'r', paths: ['/a'], reason: 'why' },
        },
      ],
      [{ type: 'error', kind: 'rate-limit', message: '/home/x leaked' }],
      [{ type: 'error', message: 'only a message' }],
      [{ type: 'documents-unprotected', paths: ['/a', '/b', '/c'] }],
      [{ type: 'text', text: 'hello' }],
      [{ type: 'tool', action: { kind: 'read', tool: 'r', paths: [] }, status: 'done' }],
      [{ type: 'turn-done', ok: true }],
      [{ type: 'ended' }],
    ),
  },
  'agent-window.agentConnections': {
    ts: (a) =>
      win.agentConnections(
        a[0] as never,
        (a[1] ?? undefined) as never,
        ...(a[2] === undefined ? [] : [a[2] as never]),
      ),
    cases: [
      { args: [{}, null], note: 'nothing known yet' },
      { args: [{ 'claude-code': { state: 'ready' }, codex: { state: 'checking' } }, null] },
      { args: [{ 'claude-code': { state: 'off' }, codex: { state: 'unavailable' } }, null] },
      {
        args: [
          {
            'claude-code': { state: 'metered', meteredAccepted: true },
            codex: { state: 'metered', meteredAccepted: true },
          },
          { 'claude-code': true, codex: false },
        ],
      },
      {
        args: [
          {
            'claude-code': { state: 'metered', meteredAccepted: false },
            codex: { state: 'metered' },
          },
          { 'claude-code': true, codex: true },
        ],
      },
      {
        args: [{ 'claude-code': { state: 'metered', meteredAccepted: true } }, null],
        note: 'accepted by the status, not by the settings',
      },
      {
        args: [{ 'claude-code': { state: 'ready' }, codex: { state: 'ready' } }, null, ['codex']],
        note: 'a blocked program',
      },
      {
        args: [
          { 'claude-code': { state: 'ready' }, codex: { state: 'ready' } },
          null,
          ['claude-code', 'codex'],
        ],
      },
      { args: [{ 'claude-code': { state: 'strange' } }, null] },
    ],
  },
  'agent-window.startAgentForWindow': {
    ts: async (a, cx) => {
      const sc = a[0] as DirectStart
      const d: Any = {
        readPrefs: () => sc.deps.prefs,
        writePrefs: (p: unknown) => cx.log('writePrefs', p),
        readProjectPrefs: sc.deps.projectPrefs
          ? (f: string) => (
              cx.log('readProjectPrefs', f),
              failing(sc.deps.projectPrefs!.read, 'read')
            )
          : undefined,
        userData: sc.deps.userData,
      }
      const m: Any = {
        start: async (owner: number, request: unknown) => (
          cx.log('start', owner, request),
          sc.start
        ),
      }
      return withClock(cx.now, () => win.startAgentForWindow(d, m, 5, a[1]))
    },
    cases: startCases,
  },
  'agent-window.window': {
    ts: (a, cx) => withClock(cx.now, () => withUuids(() => runWindow(a[0] as World, cx))),
    cases: windowCases,
  },
}

// ---- agent-window: the skill tools -------------------------------------------

interface ToolScenario {
  projectRoot: string
  /** what each call of `window()` answers: true is an open window; the last one repeats */
  window: boolean[]
  list?: 'throws' | unknown[]
  sessionSkills?: unknown[]
  keys: string[]
  tabs: 'throws' | unknown[]
}

function toolsFor(sc: ToolScenario, cx: TsContext) {
  let calls = 0
  let keys = 0
  const d: Any = {
    window: () => {
      const open = sc.window[Math.min(calls++, sc.window.length - 1)]
      cx.log('window', open)
      return open ? { send: (c: string, p: unknown) => cx.log('send', c, p) } : null
    },
    listSkills:
      sc.list === undefined
        ? undefined
        : async () => {
            cx.log('listSkills')
            if (sc.list === 'throws') throw new Error('list')
            return sc.list
          },
    sessionSkills:
      sc.sessionSkills === undefined
        ? undefined
        : () => (cx.log('sessionSkills'), sc.sessionSkills),
    keep: (shown: unknown) => cx.log('keep', shown),
    newKey: () => (cx.log('newKey'), sc.keys[keys++]),
  }
  const hooks = win.agentSkillToolsFor({ ownerId: 5, sessionId: 's1' }, sc.projectRoot, d)
  return { hooks, sc }
}

const toolScenario = (over: Partial<ToolScenario> = {}): ToolScenario => ({
  projectRoot: '$DIR/p',
  window: [true],
  keys: ['key-1', 'key-2'],
  tabs: [],
  ...over,
})

const toolsGroup: Group = {
  'agent-window.agentSkillToolsFor.proposeSkill': {
    ts: async (a, cx) => {
      const sc = a[0] as ToolScenario
      const { hooks } = toolsFor(sc, cx)
      try {
        await hooks.proposeSkill(a[1] as never, {
          openTabs: async () => {
            cx.log('openTabs')
            if (sc.tabs === 'throws') throw new Error('tabs')
            return sc.tabs as never
          },
        })
        return 'shown'
      } catch (error) {
        return { threw: (error as Error).message }
      }
    },
    cases: [
      {
        args: [toolScenario(), { ...INPUT }],
        files: { 'p/a.docx': '', 'p/b.md': '' },
        note: 'a new skill, the project offered',
      },
      {
        args: [
          toolScenario({ tabs: [{ title: 'T', filePath: '$DIR/p/a.docx', dirty: true }] }),
          { ...INPUT, suggestedTemplatePath: 'a.docx' },
        ],
        files: { 'p/a.docx': '' },
        note: 'a tab is a candidate and the model picked it',
      },
      { args: [toolScenario({ window: [false] }), { ...INPUT }], note: 'the window is closed' },
      {
        args: [toolScenario({ window: [true, false] }), { ...INPUT }],
        files: { 'p/a.docx': '' },
        note: 'the window closes while the tabs are read',
      },
      {
        args: [
          toolScenario({ list: LIST, sessionSkills: [{ id: 'user:a', name: 'a' }] }),
          { ...INPUT, targetId: 'a' },
        ],
        files: { 'p/a.docx': '' },
        note: 'a change to a skill of the session',
      },
      {
        args: [toolScenario({ list: LIST }), { ...INPUT, targetId: 'p' }],
        note: 'a project skill is refused',
      },
      {
        args: [toolScenario({ list: 'throws' }), { ...INPUT, targetId: 'a' }],
        note: 'the list cannot be read',
      },
      {
        args: [toolScenario({ list: 'throws' }), { ...INPUT }],
        files: { 'p/a.docx': '' },
        note: 'a new skill when the list cannot be read',
      },
      {
        args: [toolScenario({ tabs: 'throws' }), { ...INPUT }],
        files: { 'p/a.docx': '' },
        note: 'the tabs cannot be read',
      },
      { args: [toolScenario({ list: [] }), { ...INPUT, targetId: 'zzz' }], note: 'no such skill' },
    ],
  },
  'agent-window.agentSkillToolsFor.proposeInstall': {
    ts: async (a, cx) => {
      const { hooks } = toolsFor(a[0] as ToolScenario, cx)
      try {
        await hooks.proposeInstall(a[1] as string)
        return 'shown'
      } catch (error) {
        return { threw: (error as Error).message }
      }
    },
    cases: [
      { args: [toolScenario(), 'https://github.com/o/r'] },
      {
        args: [toolScenario({ window: [false] }), 'https://github.com/o/r'],
        note: 'the window is closed',
      },
    ],
  },
}

export const group: Group = { ...constants, ...skillsGroup, ...windowGroup, ...toolsGroup }
