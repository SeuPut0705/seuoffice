import { describe, expect, it } from 'vitest'
import { summarize } from '../src/commands/selection'

describe('selection summary', () => {
  it('previews the selected text of a block, cut to 80 characters', () => {
    const text = 'a'.repeat(100)
    expect(summarize({ blocks: [3, 3], text })).toBe(`block 3: ${'a'.repeat(79)}…`)
    expect(summarize({ blocks: [3, 5], text: 'short' })).toBe('blocks 3-5: short')
  })

  it('does not cut an emoji in half when the preview is clipped', () => {
    // the emoji straddles the cut after 79 UTF-16 units
    const text = `${'a'.repeat(78)}😀${'b'.repeat(20)}`
    const line = summarize({ page: 2, text })
    // a lone surrogate would not survive the trip through UTF-8
    expect(Buffer.from(line).toString('utf-8')).toBe(line)
    expect(line).toBe(`page 2: ${'a'.repeat(78)}…`)
  })
})
