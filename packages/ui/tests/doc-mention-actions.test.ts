import { afterEach, describe, expect, it, vi } from 'vitest'
import { docMentionActions, type DocMentionAddResult } from '../src/doc-mention-actions'

const BRIDGE_KEY = 'aiOfficeDocs'

const setBridge = (value: unknown) => {
  ;(globalThis as Record<string, unknown>)[BRIDGE_KEY] = value
}

interface Meta {
  path: string
  name: string
}

function setup(answer: (paths: string[]) => DocMentionAddResult<Meta> | null) {
  const merged: DocMentionAddResult<Meta>[] = []
  const add = vi.fn(async (paths: string[]) => answer(paths))
  const actions = docMentionActions<Meta>({
    lang: 'ko',
    add,
    merge: (r) => merged.push(r),
  })
  return { actions, add, merged }
}

const meta = (path: string): Meta => ({ path, name: path.split('/').pop() ?? path })

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[BRIDGE_KEY]
})

describe('docMentionActions.attach', () => {
  it('resolves to the accepted paths and merges them', async () => {
    const { actions, merged } = setup((paths) => ({ accepted: paths.map(meta), rejected: [] }))
    await expect(actions.attach(['C:/d/a.docx'])).resolves.toEqual(['C:/d/a.docx'])
    expect(merged).toEqual([{ accepted: [meta('C:/d/a.docx')], rejected: [] }])
  })

  it('never reports a refused path as attached; the reason goes to the row', async () => {
    const { actions, merged } = setup(() => ({ accepted: [], rejected: ['a.docx: too large'] }))
    await expect(actions.attach(['C:/d/a.docx'])).resolves.toEqual([])
    expect(merged).toEqual([{ accepted: [], rejected: ['a.docx: too large'] }])
  })

  it('treats a missing answer as nothing attached', async () => {
    const { actions, merged } = setup(() => null)
    await expect(actions.attach(['C:/d/a.docx'])).resolves.toEqual([])
    expect(merged).toEqual([])
  })
})

describe('docMentionActions.pickMore', () => {
  it('attaches what the picker returned, like the attach-from-documents button', async () => {
    setBridge({ pick: async () => ({ ok: true, paths: ['C:/d/a.docx', 'C:/d/b.docx'] }) })
    const { actions, add } = setup((paths) => ({
      accepted: paths.filter((p) => p.endsWith('a.docx')).map(meta),
      rejected: ['b.docx: unreadable'],
    }))
    await expect(actions.pickMore()).resolves.toEqual(['C:/d/a.docx'])
    expect(add).toHaveBeenCalledWith(['C:/d/a.docx', 'C:/d/b.docx'])
  })

  it('cancel leaves everything as it was', async () => {
    setBridge({ pick: async () => ({ ok: false, reason: 'cancelled' }) })
    const { actions, add, merged } = setup(() => null)
    await expect(actions.pickMore()).resolves.toBeNull()
    expect(add).not.toHaveBeenCalled()
    expect(merged).toEqual([])
  })

  it('busy shows the note and attaches nothing', async () => {
    setBridge({ pick: async () => ({ ok: false, reason: 'busy' }) })
    const { actions, add, merged } = setup(() => null)
    await expect(actions.pickMore()).resolves.toEqual([])
    expect(add).not.toHaveBeenCalled()
    expect(merged).toEqual([{ accepted: [], rejected: ['목록 창이 이미 열려 있습니다'] }])
  })

  it('without the shell there is nothing to pick', async () => {
    const { actions } = setup(() => null)
    await expect(actions.pickMore()).resolves.toBeNull()
  })

  it('a failed pick request counts as cancelled', async () => {
    setBridge({ pick: () => Promise.reject(new Error('gone')) })
    const { actions, merged } = setup(() => null)
    await expect(actions.pickMore()).resolves.toBeNull()
    expect(merged).toEqual([])
  })
})
