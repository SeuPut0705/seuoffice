import { describe, expect, it } from 'vitest'

import { resolveAttachmentImageOps } from '../src/renderer/ai/tools'

const attached = (name: string): string | null =>
  name === 'chart.png' ? 'C:/Users/me/Pictures/chart.png' : null

describe('resolveAttachmentImageOps', () => {
  it('fills path from the attachment name the panel knows', () => {
    const result = resolveAttachmentImageOps(
      [{ op: 'add_image', sheetId: 's', attachment: 'chart.png', anchorCell: 'B2' }],
      attached,
    )
    expect(result.error).toBeUndefined()
    expect(result.operations[0]).toMatchObject({
      op: 'add_image',
      sheetId: 's',
      path: 'C:/Users/me/Pictures/chart.png',
      attachment: 'chart.png',
      anchorCell: 'B2',
    })
  })

  it('refuses a name the chat does not have (no arbitrary local paths)', () => {
    const result = resolveAttachmentImageOps(
      [{ op: 'add_image', sheetId: 's', attachment: 'secret.png', anchorCell: 'B2' }],
      attached,
    )
    expect(result.error).toContain('secret.png')
    expect(result.error).toContain('not attached')
    expect(result.operations).toEqual([])
  })

  it('leaves operations without an attachment untouched', () => {
    const op = { op: 'add_image', sheetId: 's', path: 'https://x/y.png', anchorCell: 'B2' }
    const result = resolveAttachmentImageOps([op], attached)
    expect(result.error).toBeUndefined()
    expect(result.operations[0]).toBe(op)
  })

  it('does not touch other operations', () => {
    const op = { op: 'set_cell', sheetId: 's', address: 'A1', value: 'x' }
    const result = resolveAttachmentImageOps([op], attached)
    expect(result.operations[0]).toBe(op)
  })
})
