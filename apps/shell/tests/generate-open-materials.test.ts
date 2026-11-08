import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import type { OpenDocumentTab } from '../src/shared/tabs-api'
import { createOpenMaterials, type MaterialContents } from '../src/main/generate/open-materials'

/** saving a material in its tab: each family through its own dialog-free save, or shown */

const p = (name: string) => join(tmpdir(), 'gen-open', name)

function setup(tabs: OpenDocumentTab[], fail = false) {
  const calls: string[] = []
  const revealed: string[] = []
  const contents = new Map<string, MaterialContents>(
    tabs.map((t, i) => [t.id, { id: 100 + i, isDestroyed: () => false }]),
  )
  const record =
    (name: string) =>
    async (...args: unknown[]) => {
      calls.push(
        `${name}:${args.map((a) => (typeof a === 'object' ? (a as MaterialContents).id : a)).join(',')}`,
      )
      if (fail) throw new Error('disk full')
      return true
    }
  const open = createOpenMaterials({
    list: async () => tabs,
    webContentsFor: (id) => contents.get(id),
    reveal: (id) => revealed.push(id),
    save: {
      docs: record('docs'),
      sheets: record('sheets'),
      slides: record('slides'),
      markdown: record('markdown'),
      html: record('html'),
      mindmap: record('mindmap'),
    },
  })
  return { open, calls, revealed }
}

const tab = (
  id: string,
  kind: OpenDocumentTab['kind'],
  name: string,
  dirty = true,
): OpenDocumentTab => ({
  id,
  kind,
  title: name,
  filePath: p(name),
  active: false,
  dirty,
})

describe('open materials', () => {
  it('saves each family in place through its own save', async () => {
    const tabs = [
      tab('t1', 'docs', 'a.docx'),
      tab('t2', 'sheets', 'b.xlsx'),
      tab('t3', 'slides', 'c.pptx'),
      tab('t4', 'markdown', 'd.md'),
      tab('t5', 'html', 'e.html'),
      tab('t6', 'mindmap', 'f.xmind'),
    ]
    const { open, calls, revealed } = setup(tabs)
    for (const t of tabs) {
      expect(await open.saveActionFor(t.filePath!), t.kind).toBe('save')
      expect(await open.saveMaterial(t.filePath!), t.kind).toBe('saved')
    }
    expect(calls).toEqual([
      `docs:100,${p('a.docx')}`,
      `sheets:101,${p('b.xlsx')}`,
      `slides:102,${p('c.pptx')}`,
      'markdown:103',
      'html:104',
      'mindmap:105',
    ])
    expect(revealed).toEqual([])
  })

  it('shows the tab instead when its format cannot be written in place', async () => {
    const tabs = [
      tab('t1', 'pdf', 'a.pdf'),
      tab('t2', 'docs', 'old.doc'),
      tab('t3', 'sheets', 'table.csv'),
      tab('t4', 'slides', 'old.ppt'),
    ]
    const { open, calls, revealed } = setup(tabs)
    for (const t of tabs) {
      expect(await open.saveActionFor(t.filePath!), t.filePath).toBe('show')
      expect(await open.saveMaterial(t.filePath!), t.filePath).toBe('shown')
    }
    expect(calls).toEqual([])
    expect(revealed).toEqual(['t1', 't2', 't3', 't4'])
  })

  it('has nothing to do for a clean or closed document', async () => {
    const { open, calls } = setup([tab('t1', 'docs', 'a.docx', false)])
    expect(await open.saveMaterial(p('a.docx'))).toBe('saved')
    expect(await open.saveMaterial(p('elsewhere.docx'))).toBe('saved')
    expect(calls).toEqual([])
  })

  it('reports a failed save', async () => {
    const { open } = setup([tab('t1', 'markdown', 'd.md')], true)
    expect(await open.saveMaterial(p('d.md'))).toBe('failed')
  })

  it('follows a never-saved document by its webContents', async () => {
    const untitled: OpenDocumentTab = {
      id: 't1',
      kind: 'html',
      title: 'Untitled',
      active: true,
      dirty: true,
    }
    const tabs = [untitled]
    const { open, revealed } = setup(tabs)
    expect(await open.pathOfUntitled(100)).toBeNull()
    await open.showUntitled(100)
    expect(revealed).toEqual(['t1'])
    untitled.filePath = p('page.html')
    expect(await open.pathOfUntitled(100)).toBe(p('page.html'))
    expect(await open.pathOfUntitled(999)).toBeNull()
  })
})
