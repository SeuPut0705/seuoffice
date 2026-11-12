import { describe, expect, it } from 'vitest'
import { personIdFor } from '@seuoffice/xlsx-gateway/gateway/xlsx-threaded-comments'

import { ThreadStore } from '../src/renderer/threaded-comments'

/**
 * 0.12.37 named a person with no display name "GenOffice User". A person is
 * identified by a hash of that name, so a reply by the same no-name user in
 * this version must carry the same name, or it shows up as a second person.
 */

const OLD_NAME = 'GenOffice User'

function workbookWithOldFallbackThread() {
  return {
    sheets: [
      {
        id: 's1',
        comments: [
          {
            row: 0,
            column: 0,
            author: OLD_NAME,
            text: 'Root',
            thread: {
              id: '{R1}',
              personId: personIdFor(OLD_NAME),
              author: OLD_NAME,
              dT: '2024-01-01T00:00:00.00',
              done: false,
              text: 'Root',
              replies: [],
            },
          },
        ],
      },
    ],
  } as never
}

describe('a no-name user in a workbook whose thread has the old fallback person', () => {
  it('replies as that same person', () => {
    const store = new ThreadStore()
    store.setAuthor('')
    store.load(workbookWithOldFallbackThread())
    store.reply('s1', 0, 0, 'Me too')
    const reply = store.get('s1', 0, 0)!.replies[0]!
    expect(reply.personId).toBe(personIdFor(OLD_NAME))
    expect(reply.author).toBe(OLD_NAME)
  })

  it('is that person whichever of name and workbook arrives first', () => {
    const store = new ThreadStore()
    store.load(workbookWithOldFallbackThread())
    store.setAuthor('  ')
    expect(store.authorName()).toBe(OLD_NAME)
    expect(store.add('s1', 2, 2, 'New').personId).toBe(personIdFor(OLD_NAME))
  })

  it('stays the current fallback in a workbook without that person', () => {
    const store = new ThreadStore()
    store.load({ sheets: [{ id: 's1', comments: [] }] } as never)
    expect(store.authorName()).toBe('SeuOffice User')
  })

  it('does not rename a user who has a display name', () => {
    const store = new ThreadStore()
    store.load(workbookWithOldFallbackThread())
    store.setAuthor('Grace')
    expect(store.authorName()).toBe('Grace')
  })
})
