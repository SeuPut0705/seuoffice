import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { ProjectStore } from '../src/store.js'

/** every file under `dir` with its bytes, so "nothing was written" is one comparison */
function filesUnder(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  if (!existsSync(dir)) return out
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else out[relative(dir, full)] = readFileSync(full).toString('base64')
    }
  }
  walk(dir)
  return out
}

/**
 * lookupChatForFile is for a caller that only looks: a headless export's
 * hidden window asks which chat its document has, and the file must not
 * become one of the user's documents because of it.
 */
describe('lookupChatForFile', () => {
  let userData: string
  let docs: string
  let store: ProjectStore

  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'project-store-lookup-data-'))
    docs = mkdtempSync(join(tmpdir(), 'project-store-lookup-docs-'))
    store = new ProjectStore(userData)
  })

  afterEach(() => {
    rmSync(userData, { recursive: true, force: true })
    rmSync(docs, { recursive: true, force: true })
  })

  it('answers for a file nobody opened without creating the store', () => {
    const filePath = join(docs, 'note.md')
    writeFileSync(filePath, '# note', 'utf8')

    const looked = store.lookupChatForFile(filePath)

    expect(looked.projectId).toBe('default')
    expect(filesUnder(userData)).toEqual({})
    // the ids are the ones the file gets once a tab does open it
    expect(store.resolveChatForFile(filePath)).toEqual(looked)
  })

  it('leaves an existing store byte for byte as it was', () => {
    const opened = join(docs, 'opened.docx')
    const converted = join(docs, 'converted.docx')
    writeFileSync(opened, 'doc', 'utf8')
    writeFileSync(converted, 'doc', 'utf8')
    const registered = store.resolveChatForFile(opened)
    store.appendChatMessage(registered.projectId, registered.chatId, { role: 'user', text: 'q' })
    store.appendChatMessage(registered.projectId, registered.chatId, {
      role: 'assistant',
      text: 'a',
    })
    const before = filesUnder(userData)

    expect(store.lookupChatForFile(converted).projectId).toBe('default')
    expect(store.lookupChatForFile(opened)).toEqual(registered)

    expect(filesUnder(userData)).toEqual(before)
  })

  it('finds the project and the chat a renamed file carries', () => {
    const project = store.createProject('Report')
    const first = join(docs, 'draft.docx')
    const renamed = join(docs, 'final.docx')
    writeFileSync(first, 'doc', 'utf8')
    const registered = store.resolveChatForFile(first)
    store.moveFileToProject(first, project.id)
    writeFileSync(renamed, 'doc', 'utf8')
    rmSync(first)
    store.fileRenamed(first, renamed)
    const before = filesUnder(userData)

    expect(store.lookupChatForFile(renamed)).toEqual({
      projectId: project.id,
      chatId: registered.chatId,
    })
    expect(filesUnder(userData)).toEqual(before)
  })
})
