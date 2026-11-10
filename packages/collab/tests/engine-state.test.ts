import { describe, expect, it } from 'vitest'
import { initialState, statusOf } from '../src/client/engine'

describe('a status before the first welcome', () => {
  it('names no self', () => {
    const status = statusOf(initialState({ name: 'toy', schema: 1 }, 'f'.repeat(64), 30_000))
    expect(status).toMatchObject({ phase: 'joining', self: null })
  })
})
