import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'

const TOOLS = join(__dirname, '../../../tools')

interface Comparison {
  gone: Array<{ id: string; reason: 'unlisted' | 'no-tools' }>
  candidates: Array<{ id: string; context: number }>
  staleRejections: string[]
}
interface FreeModelsTool {
  listedFreeModels(source: string): string[]
  compareFreeModels(input: {
    listed: string[]
    rejected: Record<string, unknown>
    catalog: unknown[]
  }): Comparison
  needsAction(result: Comparison): boolean
  reportMarkdown(result: Comparison): string
}

let tool: FreeModelsTool
beforeAll(async () => {
  tool = (await import(pathToFileURL(join(TOOLS, 'free-models.mjs')).href)) as FreeModelsTool
})

const withTools = (id: string, context = 0) => ({
  id,
  context_length: context,
  supported_parameters: ['tools', 'temperature'],
})

describe('free model list check', () => {
  it('reads the offered models from free-ai.ts, in order', () => {
    const source = readFileSync(join(__dirname, '../../ai-provider/src/free-ai.ts'), 'utf8')
    const listed = tool.listedFreeModels(source)
    expect(listed.length).toBeGreaterThan(0)
    expect(listed.every((id) => id.endsWith(':free'))).toBe(true)
    expect(listed[0]).toBe('nvidia/nemotron-3-super-120b-a12b:free')
  })

  it('every rejection in the file is a free model id with a date and a reason', () => {
    const rejected = JSON.parse(
      readFileSync(join(TOOLS, 'free-models-rejected.json'), 'utf8'),
    ) as Record<string, { date: string; reason: string }>
    for (const [id, entry] of Object.entries(rejected)) {
      expect(id.endsWith(':free')).toBe(true)
      expect(entry.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(entry.reason.trim()).not.toBe('')
    }
  })

  it('flags an offered model OpenRouter dropped or serves without tools', () => {
    const result = tool.compareFreeModels({
      listed: ['a/kept:free', 'a/dropped:free', 'a/toolless:free'],
      rejected: {},
      catalog: [withTools('a/kept:free'), { id: 'a/toolless:free', supported_parameters: [] }],
    })
    expect(result.gone).toEqual([
      { id: 'a/dropped:free', reason: 'unlisted' },
      { id: 'a/toolless:free', reason: 'no-tools' },
    ])
    expect(tool.needsAction(result)).toBe(true)
  })

  it('offers only new free models with tools that were not turned down, longest context first', () => {
    const result = tool.compareFreeModels({
      listed: ['a/offered:free'],
      rejected: { 'a/turned-down:free': { date: '2026-10-15', reason: 'x' } },
      catalog: [
        withTools('a/offered:free'),
        withTools('a/turned-down:free'),
        withTools('a/short:free', 1000),
        withTools('a/long:free', 9000),
        withTools('a/paid', 9000),
        { id: 'a/no-tools:free', supported_parameters: ['temperature'] },
      ],
    })
    expect(result.candidates).toEqual([
      { id: 'a/long:free', context: 9000 },
      { id: 'a/short:free', context: 1000 },
    ])
    expect(result.gone).toEqual([])
  })

  it('names rejections OpenRouter no longer lists, without asking for action on them alone', () => {
    const result = tool.compareFreeModels({
      listed: ['a/offered:free'],
      rejected: { 'a/vanished:free': { date: '2026-10-15', reason: 'x' } },
      catalog: [withTools('a/offered:free')],
    })
    expect(result.staleRejections).toEqual(['a/vanished:free'])
    expect(tool.needsAction(result)).toBe(false)
    expect(tool.reportMarkdown(result)).toContain('`a/vanished:free`')
  })

  it('reports the same text for the same lists, and says when nothing changed', () => {
    const input = {
      listed: ['a/offered:free'],
      rejected: {},
      catalog: [withTools('a/offered:free'), withTools('a/new:free', 5000)],
    }
    const first = tool.reportMarkdown(tool.compareFreeModels(input))
    expect(tool.reportMarkdown(tool.compareFreeModels(input))).toBe(first)
    expect(first).toContain('`a/new:free`')
    expect(tool.reportMarkdown({ gone: [], candidates: [], staleRejections: [] })).toBe(
      '바뀐 것이 없습니다.\n',
    )
  })
})
