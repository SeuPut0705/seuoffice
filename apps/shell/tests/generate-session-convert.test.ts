import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import type { ConvertKind, GenerateHandoff, GenerateWindowState } from '../src/shared/generate-api'
import type { MaterialStatus } from '../src/main/generate/materials'
import type { ConvertedDocument, ConvertResult } from '../src/main/generate/convert'
import { USAGE_NOTICE_CHARS } from '../src/main/generate/limits'
import {
  GenerateSession,
  type GenerateSessionDeps,
  type MaterialRef,
} from '../src/main/generate/session'

/**
 * 8.6 in the window's state machine: a conversion without AI is offered only
 * for exactly one material of a matching type, needs no request text, shows
 * the redaction notice only for a markdown source with withheld spans, obeys
 * 8.4, opens one new tab with the result, and never becomes an AI request.
 */

const p = (name: string) => join(tmpdir(), 'gen-convert-session', name)

interface FakeFile {
  size?: number
  length?: number
  unsaved?: boolean
  problem?: MaterialStatus['problem']
  marked?: boolean
}

function harness(
  files: Record<string, FakeFile>,
  options: { result?: ConvertResult; withConvert?: boolean } = {},
) {
  const handoffs: GenerateHandoff[] = []
  const converted: ConvertedDocument[] = []
  const calls: Array<{ kind: ConvertKind; path: string }> = []
  const pushed: GenerateWindowState[] = []
  let closed = 0
  const withConvert = options.withConvert ?? true
  const deps: GenerateSessionDeps = {
    lang: () => 'en',
    inspect: async (path) => {
      const name = path.split(/[\\/]/).pop()!
      const f = files[name]
      const ext = name.split('.').pop()!
      if (!f)
        return { key: path, name, path, ext, unsaved: false, textLength: 0, problem: 'missing' }
      return {
        key: path,
        name,
        path,
        ext,
        sizeBytes: f.size ?? 100,
        unsaved: !!f.unsaved,
        textLength: f.problem ? 0 : (f.length ?? 10),
        ...(f.problem ? { problem: f.problem } : {}),
      }
    },
    pathOfUntitled: async () => null,
    saveActionFor: async () => 'save',
    saveMaterial: async () => 'saved',
    showUntitled: async () => {},
    openTargetTab: (h) => {
      handoffs.push(h)
    },
    ...(withConvert
      ? {
          convert: async (kind: ConvertKind, path: string) => {
            calls.push({ kind, path })
            return (
              options.result ?? {
                ok: true as const,
                content: { kind: 'markdown-to-mindmap', target: 'mindmap', outline: '# x\n' },
              }
            )
          },
          openConvertedTab: (doc: ConvertedDocument) => {
            converted.push(doc)
          },
          redactionNotice: async (path: string) => !!files[path.split(/[\\/]/).pop()!]?.marked,
        }
      : {}),
    push: (s) => pushed.push(s),
    close: () => {
      closed++
    },
    newId: () => 'c-1',
    now: () => 5,
    recheckDelayMs: 0,
  }
  return { deps, handoffs, converted, calls, pushed, closedCount: () => closed }
}

async function start(h: ReturnType<typeof harness>, refs: MaterialRef[]) {
  const session = new GenerateSession(h.deps, { refs })
  await session.refresh()
  return session
}

describe('which conversions are offered (8.6)', () => {
  it('offers map → markdown and map → PPT for one map', async () => {
    const s = await start(harness({ 'plan.xmind': {} }), [{ path: p('plan.xmind') }])
    expect(s.state().conversions).toEqual(['mindmap-to-markdown', 'mindmap-to-slides'])
    expect(s.state().mode).toBe('ai')
  })

  it('offers markdown → map for one markdown file', async () => {
    const s = await start(harness({ 'notes.md': {} }), [{ path: p('notes.md') }])
    expect(s.state().conversions).toEqual(['markdown-to-mindmap'])
  })

  it('offers nothing for two materials, another type, or no conversion wiring', async () => {
    const two = await start(harness({ 'plan.xmind': {}, 'notes.md': {} }), [
      { path: p('plan.xmind') },
      { path: p('notes.md') },
    ])
    expect(two.state().conversions).toEqual([])
    const docx = await start(harness({ 'a.docx': {} }), [{ path: p('a.docx') }])
    expect(docx.state().conversions).toEqual([])
    const unwired = await start(harness({ 'plan.xmind': {} }, { withConvert: false }), [
      { path: p('plan.xmind') },
    ])
    expect(unwired.state().conversions).toEqual([])
  })

  it('does not count a left-out file', async () => {
    const s = await start(harness({ 'plan.xmind': {} }), [
      { path: p('plan.xmind') },
      { path: p('gone.docx') },
    ])
    expect(s.state().conversions).toEqual(['mindmap-to-markdown', 'mindmap-to-slides'])
  })

  it('ignores a conversion that is not on offer', async () => {
    const s = await start(harness({ 'plan.xmind': {} }), [{ path: p('plan.xmind') }])
    s.setConvert('markdown-to-mindmap')
    s.setConvert('no-such-thing')
    expect(s.state().mode).toBe('ai')
    expect(s.state().convertKind).toBeNull()
  })
})

describe('choosing a conversion', () => {
  it('drops the AI notices and keeps "make" available without any request text', async () => {
    const s = await start(harness({ 'plan.xmind': { length: USAGE_NOTICE_CHARS + 1 } }), [
      { path: p('plan.xmind') },
    ])
    expect(s.state().notices.usage).toBe(true)
    s.setConvert('mindmap-to-slides')
    const state = s.state()
    expect(state.mode).toBe('convert')
    expect(state.convertKind).toBe('mindmap-to-slides')
    expect(state.notices).toEqual({ usage: false, longMaterial: false })
    expect(state.canMake).toBe(true)
    s.setConvert(null)
    expect(s.state().mode).toBe('ai')
  })

  it('shows the redaction notice only for a markdown source with withheld spans', async () => {
    const marked = await start(harness({ 'private.md': { marked: true } }), [
      { path: p('private.md') },
    ])
    expect(marked.state().redactionNotice).toBe(false)
    marked.setConvert('markdown-to-mindmap')
    expect(marked.state().redactionNotice).toBe(true)

    const plain = await start(harness({ 'plain.md': {} }), [{ path: p('plain.md') }])
    plain.setConvert('markdown-to-mindmap')
    expect(plain.state().redactionNotice).toBe(false)
  })
})

describe('"make" for a conversion', () => {
  it('converts the one material and opens it as a new tab, then closes; no AI hand-off', async () => {
    const h = harness({ 'notes.md': {} })
    const s = await start(h, [{ path: p('notes.md') }])
    s.setConvert('markdown-to-mindmap')
    expect(await s.make('ignored')).toBe(true)
    expect(h.calls).toEqual([{ kind: 'markdown-to-mindmap', path: p('notes.md') }])
    expect(h.converted).toEqual([
      {
        id: 'c-1',
        content: { kind: 'markdown-to-mindmap', target: 'mindmap', outline: '# x\n' },
        sources: [p('notes.md')],
        createdAt: 5,
      },
    ])
    expect(h.handoffs).toEqual([])
    expect(h.closedCount()).toBe(1)
  })

  it('is blocked while the source has unsaved changes (8.4)', async () => {
    const h = harness({ 'plan.xmind': { unsaved: true } })
    const s = await start(h, [{ path: p('plan.xmind') }])
    s.setConvert('mindmap-to-markdown')
    expect(s.state().mode).toBe('convert')
    expect(s.state().canMake).toBe(false)
    expect(await s.make('')).toBe(false)
    expect(h.calls).toEqual([])
    expect(h.converted).toEqual([])
  })

  it('opens nothing and says why when the source cannot be read', async () => {
    const h = harness(
      { 'private.md': { marked: true } },
      {
        result: { ok: false, problem: 'redaction' },
      },
    )
    const s = await start(h, [{ path: p('private.md') }])
    s.setConvert('markdown-to-mindmap')
    expect(await s.make('')).toBe(false)
    expect(h.converted).toEqual([])
    expect(h.closedCount()).toBe(0)
    expect(s.state().failure).toBe('convert')
    expect(s.state().convertProblem).toBe('redaction')
    expect(s.state().making).toBe(false)
  })

  it('never turns a conversion that is no longer offered into an AI request', async () => {
    const h = harness({ 'plan.xmind': {}, 'notes.md': {} })
    const s = await start(h, [{ path: p('plan.xmind') }])
    s.setConvert('mindmap-to-markdown')
    await s.addPaths([p('notes.md')])
    const state = s.state()
    expect(state.conversions).toEqual([])
    expect(state.mode).toBe('ai')
    expect(state.canMake).toBe(false)
    expect(await s.make('')).toBe(false)
    expect(h.handoffs).toEqual([])
    expect(h.converted).toEqual([])
    // picking an AI kind again is a deliberate choice
    s.setKind('slides')
    expect(s.state().canMake).toBe(true)
  })
})
