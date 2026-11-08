import { describe, expect, it } from 'vitest'

import { attachedImageNote } from '../src/attached-images'

describe('attachedImageNote', () => {
  it('says nothing when the chat has no images', () => {
    expect(attachedImageNote([], 'call insert_image')).toBe('')
    expect(attachedImageNote(['  ', ''], 'call insert_image')).toBe('')
  })

  it('names each file once, in order, and says how to place one', () => {
    const note = attachedImageNote(
      [' chart.png', 'photo.jpg ', 'chart.png'],
      'call insert_image with attachment set to the name',
    )
    expect(note).toContain('Images attached to this chat: chart.png, photo.jpg.')
    expect(note).toContain('call insert_image with attachment set to the name')
    expect(note).toContain('use the exact name')
    expect(note.match(/chart\.png/g)).toHaveLength(1)
  })

  it('caps the list and says how many were left out', () => {
    const names = Array.from({ length: 23 }, (_, i) => `image-${i + 1}.png`)
    const note = attachedImageNote(names, 'call add_image')
    expect(note).toContain('image-1.png')
    expect(note).toContain('image-20.png')
    expect(note).not.toContain('image-21.png')
    expect(note).toContain('(and 3 more)')
  })
})
