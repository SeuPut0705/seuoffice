import { describe, expect, it } from 'vitest'
import { ODT_MIMETYPE } from '../src/index'

describe('odt-engine package', () => {
  it('exposes the ODT media type', () => {
    expect(ODT_MIMETYPE).toBe('application/vnd.oasis.opendocument.text')
  })
})
