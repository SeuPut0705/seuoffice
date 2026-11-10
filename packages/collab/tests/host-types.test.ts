import { describe, expectTypeOf, it } from 'vitest'
import type { CollabLink, CollabStatus } from '../src/client/index'
import type { CollabStatus as EmbedStatus } from '../../embed/src/collab'
import type {
  CollabLink as PageLink,
  CollabStatus as PageStatus,
} from '../../web-platform/src/collab-types'

// embed ships alone to hosts and web-platform must not pull the engine into
// pages that never co-edit, so both declare these shapes themselves. This
// file fails `tsc` the moment one of the copies drifts from the owner.
describe('the shapes the host packages copy', () => {
  it('are the engine’s own', () => {
    expectTypeOf<EmbedStatus>().toEqualTypeOf<CollabStatus>()
    expectTypeOf<PageStatus>().toEqualTypeOf<CollabStatus>()
    expectTypeOf<PageLink>().toEqualTypeOf<CollabLink>()
  })
})
