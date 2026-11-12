import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { editedCommentModelText, parseDocx, saveDocx, type SaveBlock } from '../src'
import { mutatedStoriesDocx, SECRET, TAG_MUTATION_NAMES } from './helpers/hidden-stories'

/**
 * A person's edit around the hidden words of a comment and a note (new words
 * before and after them), in a document whose tags are written another valid
 * way: neither the live view nor the saved file hands the hidden words over.
 */
describe.each(TAG_MUTATION_NAMES)('tags rewritten: %s', (mutation) => {
  it('an edit around hidden words keeps them hidden, live and saved', async () => {
    const file = await mutatedStoriesDocx(mkdtempSync(join(tmpdir(), 'edit-across-')), mutation)
    const doc = await parseDocx(new Uint8Array(readFileSync(file)))
    const comment = doc.comments.find((c) => c.id === '1')!
    const note = doc.footnotes.find((n) => n.id === '1')!
    const commentText = `Call: ${SECRET}C thanks`
    const noteText = `Read: ${SECRET}N more`
    if (comment.markedXml) {
      expect(editedCommentModelText(comment.markedXml, commentText) ?? commentText).not.toContain(
        SECRET,
      )
    }
    const { richParas: _rich, ...plainNote } = note
    const blocks = doc.blocks
      .filter((block) => !block.hidden)
      .map((block): SaveBlock => ({ kind: 'original', docxIndex: block.docxIndex! }))
    const saved = await saveDocx(doc, blocks, {
      comments: [{ ...comment, text: commentText }],
      footnotes: [{ ...plainNote, text: noteText }],
    })
    const reopened = await parseDocx(saved)
    const savedComment = reopened.comments.find((c) => c.id === '1')!
    const savedNote = reopened.footnotes.find((n) => n.id === '1')!
    expect(savedComment.text).toBe(commentText)
    expect(savedNote.text).toBe(noteText)
    expect(savedComment.modelText ?? savedComment.text).not.toContain(SECRET)
    expect(savedNote.modelText ?? savedNote.text).not.toContain(SECRET)
  })
})
