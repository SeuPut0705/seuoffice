import { describe, expect, it } from 'vitest'
import {
  ATTACHABLE_EXTS,
  ATTACHABLE_IMAGE_EXTS,
  ATTACHABLE_IMAGE_MAX_BYTES,
  ATTACHABLE_MAX_BYTES,
} from '../src/attachable'
import { callEngine } from '../src/engine'
import { WHOLE_ZIP_READ_MAX_BYTES } from '../src/parse'
import { PPTX_REDACT_EXT_URI } from '../src/pptx-redaction'
import { UNKNOWN_CELL_MARKER } from '../src/xlsx'

/**
 * The constants this package exports stay TypeScript literals; the readers in
 * Rust hold their own. A list that drifts makes the attach dialog offer a file
 * the reader refuses, or the size cap the host checks differ from the one the
 * reader assumes.
 */
describe('the exported constants and the Rust readers', () => {
  it('hold the same values', () => {
    const rust = callEngine<Record<string, unknown>>('constants', [])
    expect({
      ATTACHABLE_EXTS: [...ATTACHABLE_EXTS].sort(),
      ATTACHABLE_IMAGE_EXTS: [...ATTACHABLE_IMAGE_EXTS].sort(),
      ATTACHABLE_MAX_BYTES,
      ATTACHABLE_IMAGE_MAX_BYTES,
      WHOLE_ZIP_READ_MAX_BYTES,
      PPTX_REDACT_EXT_URI,
      UNKNOWN_CELL_MARKER,
    }).toEqual({
      ...rust,
      ATTACHABLE_EXTS: [...(rust.ATTACHABLE_EXTS as string[])].sort(),
      ATTACHABLE_IMAGE_EXTS: [...(rust.ATTACHABLE_IMAGE_EXTS as string[])].sort(),
    })
  })
})
