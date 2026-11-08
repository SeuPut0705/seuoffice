// @vitest-environment node
/**
 * Saved styles on disk (userData/style-templates/<name>.json) and the optional
 * `basedOn`: the id of the built-in design template a style was saved from.
 * Files written before the field existed must load as they always did.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

type Handler = (event: { sender: { id: number } }, ...args: unknown[]) => unknown
const handlers = new Map<string, Handler>()

const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'slides-style-template-ipc-')))
const userData = join(root, 'userData')
mkdirSync(userData)
const stylesDir = join(userData, 'style-templates')

vi.mock('electron', () => ({
  app: {
    getPath: () => userData,
    getName: () => 'slides-test',
    getVersion: () => '0',
    once: () => {},
  },
  ipcMain: {
    handle: (channel: string, fn: Handler) => handlers.set(channel, fn),
    on: () => {},
    removeHandler: () => {},
  },
  nativeImage: {},
  net: {},
  webContents: { getAllWebContents: () => [], fromId: () => null },
}))

// The shaping chain loads a harfbuzz wasm that cannot resolve in the unit-test env;
// nothing here renders text.
vi.mock('../src/main/shaped-metrics', () => ({
  shapedMetricsReady: async () => {},
  refineComplexWidths: async () => {},
  complexScriptOf: () => null,
  initShapedMetrics: () => {},
  gtMeasure: (t: string) => ({ width: t.length * 8 }),
  shapedFamily: () => null,
  shapedMeasure: () => ({ width: 0 }),
}))

// no status check: registering the subscription channels would look for the CLIs
vi.mock('@genoffice/ai-provider/subscription', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@genoffice/ai-provider/subscription')>()),
  ensureSubscriptionIpc: () => ({}),
  sharedSubscriptionStatuses: () => ({}),
}))

import { registerSlidesOnlyAiIpc } from '../src/main/ai-ipc'

const event = { sender: { id: 1 } }
const save = (name: string, data: unknown) =>
  handlers.get('ai:save-style-template')!(event, name, data) as Promise<{
    ok: boolean
    error?: string
  }>
const load = (name: string) =>
  handlers.get('ai:load-style-template')!(event, name) as {
    ok: boolean
    styleSkill?: string
    topic?: string
    layout?: unknown
    basedOn?: string
    error?: string
  }
const list = () =>
  handlers.get('ai:list-style-templates')!(event) as Array<{
    name: string
    topic: string
    createdAt: string
  }>
const fileOf = (name: string) =>
  JSON.parse(readFileSync(join(stylesDir, `${name}.json`), 'utf8')) as Record<string, unknown>

const base = { topic: 'Tech', styleSkill: 'STYLE TEXT', createdAt: '2026-01-02T03:04:05.000Z' }

beforeAll(() => {
  // the shell never calls registerAiIpc: only this function runs there
  registerSlidesOnlyAiIpc()
})

beforeEach(() => {
  rmSync(stylesDir, { recursive: true, force: true })
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('saved styles and basedOn', () => {
  it('writes basedOn into the file and reads it back', async () => {
    expect(await save('My Coral', { ...base, basedOn: 'coral' })).toEqual({ ok: true })
    expect(fileOf('My Coral')).toEqual({ ...base, basedOn: 'coral', name: 'My Coral' })
    expect(load('My Coral')).toEqual({
      ok: true,
      styleSkill: 'STYLE TEXT',
      topic: 'Tech',
      basedOn: 'coral',
    })
  })

  it('a style saved without it has no such field, in the file or in the answer', async () => {
    await save('Plain', base)
    expect(fileOf('Plain')).not.toHaveProperty('basedOn')
    const loaded = load('Plain')
    expect(loaded).toEqual({ ok: true, styleSkill: 'STYLE TEXT', topic: 'Tech' })
    expect(loaded).not.toHaveProperty('basedOn')
  })

  it('a file written before the field existed loads as before', () => {
    mkdirSync(stylesDir, { recursive: true })
    writeFileSync(
      join(stylesDir, 'Old.json'),
      JSON.stringify({
        topic: 'Old',
        styleSkill: 'OLD STYLE',
        createdAt: '2024-01-01',
        name: 'Old',
      }),
    )
    expect(load('Old')).toEqual({ ok: true, styleSkill: 'OLD STYLE', topic: 'Old' })
    expect(list()).toEqual([{ name: 'Old', topic: 'Old', createdAt: '2024-01-01' }])
  })

  it('the layout skeleton and basedOn travel together', async () => {
    const layout = { canvas: { w: 1280, h: 720 } }
    await save('Both', { ...base, layout, basedOn: 'coral' })
    expect(load('Both')).toMatchObject({ ok: true, layout, basedOn: 'coral' })
  })

  it('a basedOn that is not a non-empty string is neither written nor answered', async () => {
    await save('Odd', { ...base, basedOn: 42 })
    expect(fileOf('Odd')).not.toHaveProperty('basedOn')
    await save('Empty', { ...base, basedOn: '   ' })
    expect(fileOf('Empty')).not.toHaveProperty('basedOn')
    mkdirSync(stylesDir, { recursive: true })
    writeFileSync(join(stylesDir, 'Hand.json'), JSON.stringify({ ...base, basedOn: ['coral'] }))
    expect(load('Hand')).not.toHaveProperty('basedOn')
  })

  it('the list answers the same three fields for both kinds of file', async () => {
    await save('My Coral', { ...base, basedOn: 'coral' })
    expect(list()).toEqual([{ name: 'My Coral', topic: 'Tech', createdAt: base.createdAt }])
  })
})
