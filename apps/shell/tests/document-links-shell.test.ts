import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MenuItemConstructorOptions, WebContents } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'

// the make window needs a running Electron; these tests never open it
vi.mock('../src/main/generate/generate-window', () => ({
  openGenerateWindowForDocument: vi.fn(),
}))

import { DOCUMENT_LINKS_FILE } from '../src/main/document-links'
import { configureDocumentLinks, documentLinkFileMenuItems } from '../src/main/document-links-shell'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** a made document whose one source is on disk, with the File menu built for it */
function setUp() {
  const dir = mkdtempSync(join(tmpdir(), 'doc-links-shell-'))
  dirs.push(dir)
  const derived = join(dir, 'made.pptx')
  const source = join(dir, 'notes.md')
  writeFileSync(derived, 'made')
  writeFileSync(source, 'notes')
  writeFileSync(
    join(dir, DOCUMENT_LINKS_FILE),
    JSON.stringify({
      version: 1,
      links: [{ derived, sources: [source], createdAt: '2026-10-14T00:00:00.000Z', via: 'ai' }],
    }),
  )
  const opened: string[] = []
  const applyMenu = vi.fn()
  const webContents = { id: 7, isDestroyed: () => false } as unknown as WebContents
  configureDocumentLinks({
    userDataPath: () => dir,
    activeDocument: () => ({ webContents, filePath: derived, title: 'made.pptx' }),
    documentFor: () => undefined,
    parentFor: () => null,
    openPath: (path) => opened.push(path),
    labels: () => ({ make: 'Make', sources: 'View Sources', derived: 'Made from This' }),
    tabIdFor: () => undefined,
    menuKind: () => 'slides',
    applyMenu,
  })
  const items = documentLinkFileMenuItems('slides')
  const sources = items.find((i) => i.id === 'document-links-sources')
  const entry = (sources?.submenu as MenuItemConstructorOptions[])[0]!
  applyMenu.mockClear()
  return { source, opened, applyMenu, entry }
}

const click = (entry: MenuItemConstructorOptions) => (entry.click as unknown as () => void)()

describe('a source picked from the File menu', () => {
  it('opens when the file is still there', () => {
    const { source, opened, applyMenu, entry } = setUp()
    expect(entry.enabled).toBe(true)
    click(entry)
    expect(opened).toEqual([source])
    expect(applyMenu).not.toHaveBeenCalled()
  })

  it('does nothing but rebuild the menu when the file was deleted after the menu was built', () => {
    const { source, opened, applyMenu, entry } = setUp()
    expect(entry.enabled).toBe(true)
    rmSync(source)
    click(entry)
    expect(opened).toEqual([])
    expect(applyMenu).toHaveBeenCalledWith('slides')
  })
})
