import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OLD_PROJECT_DATA_DIR_NAMES } from '@seuoffice/i18n'
import {
  PROJECT_FOLDER_NAMES,
  type ProjectChatInfo,
  type ProjectChatMessage,
  type ProjectTrustAnswer,
  type ProjectTrustPrompt,
} from '@seuoffice/project-store'
import { ProjectChatStore } from '../src/main/projects/chat-store'
import { newDocumentFolder } from '../src/main/projects/new-documents'
import { listVisibleFiles } from '../src/main/projects/project-files'
import { ProjectGuide } from '../src/main/projects/project-guide'
import { ProjectWriteGuard, ProjectWriteRefused } from '../src/main/projects/write-guard'

/**
 * A project folder made before the rename keeps its data folder under the old
 * name: where it is the only one it is found and used as it is (identity,
 * instructions, memory, chats), nothing is copied or moved, and a new project
 * gets the new name. Once the new folder exists it is the one used, whatever
 * appears under the old name later. Both names stay closed to the AI whichever
 * one a project uses.
 */

const OLD = OLD_PROJECT_DATA_DIR_NAMES[0]!
const NEW = PROJECT_FOLDER_NAMES.dataDir

let base: string
let guide: ProjectGuide

function folder(...parts: string[]): string {
  const path = join(base, ...parts)
  mkdirSync(path, { recursive: true })
  return path
}

function put(root: string, rel: string, text: string): void {
  const path = join(root, rel)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
}

function asking(value: ProjectTrustAnswer) {
  return vi.fn(async (_prompt: ProjectTrustPrompt): Promise<ProjectTrustAnswer> => value)
}

/** A project folder as an older version left it: everything under `dir` */
function plantProject(root: string, dir: string, id: string): void {
  put(
    root,
    `${dir}/project.json`,
    JSON.stringify({
      version: 1,
      id,
      name: `Project ${id}`,
      createdAt: '2026-01-01T00:00:00.000Z',
    }),
  )
  put(root, `${dir}/instructions.md`, `rules of ${id}`)
  put(root, `${dir}/memory.md`, `<!-- notes -->\n- fact of ${id} (2026-01-01)\n`)
  const info: ProjectChatInfo = {
    version: 1,
    id: 'chat1',
    projectId: id,
    title: 'earlier chat',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    origin: guide.installId(),
    lastEditor: 'docs',
    documents: [],
  }
  const message: Partial<ProjectChatMessage> = {
    seq: 0,
    ts: '2026-01-01T00:00:00.000Z',
    role: 'user',
    text: 'earlier question',
    editor: 'docs',
    origin: guide.installId(),
  }
  put(root, `${dir}/chats/chat1.json`, JSON.stringify(info))
  put(root, `${dir}/chats/chat1.jsonl`, `${JSON.stringify(message)}\n`)
}

async function addOk(root: string, ask = asking('use')) {
  const result = await guide.addFolder(root, ask)
  if (result.status !== 'added') throw new Error(`not added: ${JSON.stringify(result)}`)
  return result.project
}

beforeEach(() => {
  base = realpathSync.native(mkdtempSync(join(tmpdir(), 'project-data-folder-')))
  const userData = folder('appdata', 'App')
  guide = new ProjectGuide({
    settingsPath: join(userData, 'app-settings.json'),
    homeDir: folder('home'),
    userData,
    defaultParentDir: () => folder('documents'),
    env: {},
    language: () => 'en',
    now: () => new Date(Date.UTC(2026, 10, 12)),
  })
})

afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

describe('a project made before the rename', () => {
  it('opens with the identity, instructions, memory and chats of its old data folder', async () => {
    const root = folder('old-project')
    plantProject(root, OLD, 'p-old')
    const ask = asking('use')
    const project = await addOk(root, ask)

    expect(project.id).toBe('p-old')
    expect(project.name).toBe('Project p-old')
    expect(ask.mock.calls[0]![0].instructions).toBe('rules of p-old')

    const read = await guide.readContext(project.id)
    if (read.status !== 'ok') throw new Error(read.status)
    expect(read.context.instructions?.text).toBe(`[${OLD}/instructions.md]\nrules of p-old`)
    expect(read.context.memory?.text).toContain('- fact of p-old (2026-01-01)')

    const store = new ProjectChatStore({ guide, trash: vi.fn() })
    expect((await store.listChats(project.id)).map((chat) => chat.title)).toEqual(['earlier chat'])
    const opened = await store.openChat({ projectId: project.id, chatId: 'chat1' })
    expect(opened.status === 'ok' && opened.messages.map((m) => m.text)).toEqual([
      'earlier question',
    ])
    expect(existsSync(join(root, NEW))).toBe(false)
  })

  it('writes a chat message and a memory entry into the old data folder, making no new one', async () => {
    const root = folder('old-project')
    plantProject(root, OLD, 'p-old')
    const project = await addOk(root)
    const store = new ProjectChatStore({ guide, trash: vi.fn() })

    const saved = await store.append(
      { projectId: project.id, chatId: 'chat1', role: 'assistant', text: 'new answer' },
      { editor: 'home', docPath: null },
    )
    expect(saved.status).toBe('saved')
    const edited = await guide.editMemory(project.id, { op: 'add', text: 'a new fact' }, 'person')
    expect(edited.status).toBe('ok')
    expect((await guide.saveInstructions(project.id, 'new rules')).status).toBe('ok')

    expect(readFileSync(join(root, OLD, 'chats', 'chat1.jsonl'), 'utf8')).toContain('new answer')
    expect(readFileSync(join(root, OLD, 'memory.md'), 'utf8')).toContain('a new fact')
    expect(readFileSync(join(root, OLD, 'instructions.md'), 'utf8')).toBe('new rules')
    expect(existsSync(join(root, NEW))).toBe(false)

    const reopened = await store.openChat({ projectId: project.id, chatId: 'chat1' })
    expect(reopened.status === 'ok' && reopened.messages.map((m) => m.text)).toEqual([
      'earlier question',
      'new answer',
    ])
  })

  it('uses the new data folder when the folder holds both, and leaves the old one as it was', async () => {
    const root = folder('both')
    plantProject(root, OLD, 'p-old')
    plantProject(root, NEW, 'p-new')
    const project = await addOk(root)

    expect(project.id).toBe('p-new')
    expect((await guide.saveInstructions(project.id, 'saved now')).status).toBe('ok')
    expect(readFileSync(join(root, NEW, 'instructions.md'), 'utf8')).toBe('saved now')
    expect(readFileSync(join(root, OLD, 'instructions.md'), 'utf8')).toBe('rules of p-old')
    expect(readdirSync(join(root, OLD, 'chats')).sort()).toEqual(['chat1.json', 'chat1.jsonl'])
  })

  it('keeps the old data folder when an empty one appears under the new name', async () => {
    const root = folder('old-project')
    plantProject(root, OLD, 'p-old')
    // a person made the folder the help names, and has put nothing in it yet
    mkdirSync(join(root, NEW, 'chats'), { recursive: true })
    writeFileSync(join(root, NEW, '.DS_Store'), '')
    const project = await addOk(root)

    expect(project.id).toBe('p-old')
    expect((await guide.saveInstructions(project.id, 'saved now')).status).toBe('ok')
    expect(readFileSync(join(root, OLD, 'instructions.md'), 'utf8')).toBe('saved now')
    expect(existsSync(join(root, NEW, 'instructions.md'))).toBe(false)
  })

  it('does not take a linked old data folder for the real one', async (ctx) => {
    const root = folder('linked')
    const elsewhere = folder('elsewhere')
    plantProject(elsewhere, OLD, 'p-elsewhere')
    try {
      symlinkSync(join(elsewhere, OLD), join(root, OLD), 'junction')
    } catch {
      ctx.skip()
    }
    const project = await addOk(root, asking('use'))
    expect(project.id).not.toBe('p-elsewhere')
    expect((await guide.saveInstructions(project.id, 'here')).status).toBe('ok')
    expect(readFileSync(join(root, NEW, 'instructions.md'), 'utf8')).toBe('here')
    expect(readFileSync(join(elsewhere, OLD, 'instructions.md'), 'utf8')).toBe(
      'rules of p-elsewhere',
    )
  })
})

describe('a new project', () => {
  it('gets the data folder under the new name', async () => {
    const result = await guide.createProject({ name: 'Fresh' }, asking('use'))
    if (result.status !== 'created') throw new Error(result.status)
    const root = result.project.path
    expect(JSON.parse(readFileSync(join(root, NEW, 'project.json'), 'utf8')).id).toBe(
      result.project.id,
    )
    for (const old of OLD_PROJECT_DATA_DIR_NAMES) expect(existsSync(join(root, old))).toBe(false)
  })
})

describe('both names are closed to the AI, whichever one is in use', () => {
  async function projectUsing(dir: string) {
    if (dir === OLD) {
      const root = folder('uses-old')
      plantProject(root, OLD, 'p-old')
      return { root, project: await addOk(root) }
    }
    const created = await guide.createProject({ name: 'uses-new' }, asking('use'))
    if (created.status !== 'created') throw new Error(created.status)
    return { root: created.project.path, project: created.project }
  }

  for (const inUse of [OLD, NEW]) {
    it(`hides and refuses files in either folder of a project using ${inUse}`, async () => {
      const { root, project } = await projectUsing(inUse)
      put(root, 'visible.md', 'a document')
      for (const dir of [OLD, NEW]) put(root, `${dir}/planted.md`, 'not for the AI')

      const visibility = await guide.aiVisibility(project.id)
      if (!visibility) throw new Error('not listed')
      expect((await listVisibleFiles(visibility)).map((file) => file.relPath)).toEqual([
        'visible.md',
      ])
      for (const dir of [OLD, NEW]) {
        expect(visibility.isVisible(`${dir}/planted.md`)).toBe(false)
        const refusal = await guide
          .writeNewDocument(project.id, join(root, dir, 'made-by-ai.md'), Buffer.from('x'))
          .catch((error: unknown) => error)
        expect(refusal).toBeInstanceOf(ProjectWriteRefused)
        expect((refusal as ProjectWriteRefused).reason).toBe('outside')
        expect(existsSync(join(root, dir, 'made-by-ai.md'))).toBe(false)
        expect(newDocumentFolder(root, join(root, dir, 'chats', 'doc.md'))).toBe(root)
      }
    })
  }
})

describe('the old data folder appears after the new one was made (an earlier version, or the upstream app, opened the folder)', () => {
  const home = { editor: 'home' as const, docPath: null }

  function messagesIn(root: string, dir: string, chatId: string): [number, string][] {
    return readFileSync(join(root, dir, 'chats', `${chatId}.jsonl`), 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as ProjectChatMessage)
      .map((message) => [message.seq, message.text])
  }

  it('goes on with an open chat in the new folder, and the project stays the same one', async () => {
    const created = await guide.createProject({ name: 'Synced' }, asking('use'))
    if (created.status !== 'created') throw new Error(created.status)
    const { id, path: root } = created.project
    const store = new ProjectChatStore({ guide, trash: vi.fn() })
    const ref = { projectId: id, ...(await store.newChat(id)) }
    await store.append({ ...ref, role: 'user', text: 'q1' }, home)
    expect((await store.append({ ...ref, role: 'assistant', text: 'a1' }, home)).status).toBe(
      'saved',
    )

    plantProject(root, OLD, 'p-other')
    await store.append({ ...ref, role: 'user', text: 'q2' }, home)
    expect((await store.append({ ...ref, role: 'assistant', text: 'a2' }, home)).status).toBe(
      'saved',
    )

    expect(messagesIn(root, NEW, ref.chatId)).toEqual([
      [0, 'q1'],
      [1, 'a1'],
      [2, 'q2'],
      [3, 'a2'],
    ])
    expect(readdirSync(join(root, OLD, 'chats')).sort()).toEqual(['chat1.json', 'chat1.jsonl'])
    const opened = await store.openChat(ref)
    expect(opened.status === 'ok' && opened.messages.map((m) => m.text)).toEqual([
      'q1',
      'a1',
      'q2',
      'a2',
    ])

    // what the other program wrote under the old name does not become this project's
    const read = await guide.readContext(id)
    if (read.status !== 'ok') throw new Error(read.status)
    expect(read.context.instructions?.text ?? '').not.toContain('rules of p-other')
    expect(read.context.memory?.text ?? '').not.toContain('fact of p-other')
    expect((await store.listChats(id)).map((chat) => chat.id)).toEqual([ref.chatId])
  })

  it('writes the identity and the file of one save into the same folder', async () => {
    const root = folder('plain')
    const project = await addOk(root)
    expect(existsSync(join(root, NEW))).toBe(false)
    const original = ProjectWriteGuard.prototype.updateData
    const spy = vi
      .spyOn(ProjectWriteGuard.prototype, 'updateData')
      .mockImplementation(async function (
        this: ProjectWriteGuard,
        ...args: Parameters<ProjectWriteGuard['updateData']>
      ) {
        const result = await original.apply(this, args)
        // the earlier version makes its folder right after the identity was written
        if (args[1] === PROJECT_FOLDER_NAMES.projectFile)
          mkdirSync(join(root, OLD), { recursive: true })
        return result
      })
    try {
      expect((await guide.saveInstructions(project.id, 'rules')).status).toBe('ok')
    } finally {
      spy.mockRestore()
    }
    expect(readdirSync(join(root, NEW)).sort()).toEqual(['instructions.md', 'project.json'])
    expect(readdirSync(join(root, OLD))).toEqual([])
  })
})
