import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentToolCall } from '@genoffice/agent-core'
import type { AttachmentMeta, AttachmentReadResult } from '../src/shared/ipc'
import { createFilesSkill } from '../src/renderer/ai/files-skill'

const FORM: AttachmentMeta = {
  path: 'C:/docs/명단.xlsx',
  name: '명단.xlsx',
  ext: 'xlsx',
  sizeBytes: 20480,
}
const NOTICE: AttachmentMeta = {
  path: 'C:/docs/공문.hwp',
  name: '공문.hwp',
  ext: 'hwp',
  sizeBytes: 3 * 1024 * 1024,
}
const PHOTO: AttachmentMeta = {
  path: 'C:/docs/서식.png',
  name: '서식.png',
  ext: 'png',
  sizeBytes: 900,
}

let readAttachment: ReturnType<typeof vi.fn<(...args: unknown[]) => Promise<AttachmentReadResult>>>

beforeEach(() => {
  readAttachment = vi.fn(async () => ({
    ok: true,
    name: '명단.xlsx',
    totalChars: 30000,
    offset: 0,
    text: '성명 | 소속\n홍길동 | 교무기획부',
  }))
  vi.stubGlobal('window', { hwpApi: { readAttachment } })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const call = (skill: ReturnType<typeof createFilesSkill>, input: Record<string, unknown>) =>
  skill.executeTool({ id: '1', name: 'read_attachment', input } satisfies AgentToolCall)

describe('the files skill of the HWP panel', () => {
  it('adds nothing to a turn without attachments', () => {
    expect(createFilesSkill(() => []).buildContext!()).toBe('')
  })

  it('lists the attachments with the index read_attachment takes', () => {
    const context = createFilesSkill(() => [FORM, NOTICE, PHOTO]).buildContext!()
    expect(context.split('\n')).toEqual([
      'Attachment list (index | file name | type | size):',
      '0 | 명단.xlsx | .xlsx | 20KB',
      '1 | 공문.hwp | .hwp | 3.0MB',
      '2 | 서식.png | .png | 900B',
    ])
  })

  it('reads a slice of an attachment and says where the next one starts', async () => {
    const result = await call(
      createFilesSkill(() => [FORM]),
      { index: 0 },
    )
    expect(readAttachment).toHaveBeenCalledWith(FORM.path, 0, 24_000)
    expect(result.isError).toBeFalsy()
    expect(result.output).toContain('명단.xlsx — 30000 chars total, this slice 0–19')
    expect(result.output).toContain('(more follows: continue with offset=19)')
    expect(result.output).toContain('홍길동 | 교무기획부')
  })

  it('goes on from an offset', async () => {
    await call(
      createFilesSkill(() => [FORM]),
      { index: 0, offset: 24000 },
    )
    expect(readAttachment).toHaveBeenCalledWith(FORM.path, 24000, 24_000)
  })

  it('does not read an image as text: it went with the message', async () => {
    const result = await call(
      createFilesSkill(() => [PHOTO]),
      { index: 0 },
    )
    expect(readAttachment).not.toHaveBeenCalled()
    expect(result.isError).toBeFalsy()
    expect(result.output).toContain('already sent as an image')
  })

  it('answers a wrong index and a failed read as tool errors', async () => {
    const skill = createFilesSkill(() => [FORM])
    expect((await call(skill, { index: 3 })).isError).toBe(true)
    readAttachment.mockResolvedValueOnce({ ok: false, error: 'password-protected' })
    const failed = await call(skill, { index: 0 })
    expect(failed.isError).toBe(true)
    expect(failed.output).toBe('password-protected')
  })

  it('tells the model that an attached image cannot be put into the document', () => {
    const prompt = createFilesSkill(() => []).systemPrompt
    expect(prompt).toContain('cannot be placed into the document')
    expect(prompt).not.toContain('attachment://')
  })
})
