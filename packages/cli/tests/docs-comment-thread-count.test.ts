import { buildBlankDocx, type CommentInfo } from '@genoffice/docx-engine'
import { expect, it } from 'vitest'
import { openDocument, closeDocument } from '../src/formats/docx'
import { checkDocument } from '../src/formats/docx-check'

async function count(comments: CommentInfo[]) {
  const d = await openDocument(await buildBlankDocx())
  try {
    d.side.comments = comments
    return checkDocument(d).find((i) => i.code === 'unresolved_comments')
  } finally {
    closeDocument(d)
  }
}
const comment = (id: string, parentId?: string, done = false): CommentInfo => ({
  id,
  author: 'Test',
  text: 'Review',
  ...(parentId ? { parentId } : {}),
  done,
})
it('counts one root with two replies as one thread', async () => {
  expect((await count([comment('0'), comment('1', '0'), comment('2', '0')]))?.message).toMatch(
    /^1 comment thread/,
  )
})
it('does not reopen a resolved root because a reply lacks its done flag', async () => {
  expect(await count([comment('0', undefined, true), comment('1', '0')])).toBeUndefined()
})
it('counts multiple unresolved roots separately', async () => {
  expect(
    (await count([comment('0'), comment('1', '0'), comment('2'), comment('3', '2')]))?.message,
  ).toMatch(/^2 comment thread/)
})
it('does not hide an orphaned reply', async () => {
  expect((await count([comment('1', 'missing')]))?.message).toMatch(/^1 comment thread/)
})
it('keeps a document with no comments clear', async () => {
  expect(await count([])).toBeUndefined()
})
