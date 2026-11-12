import { afterEach, describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import { editorExtensions } from '../src/renderer/editor/extensions'
import { selectRevisions } from '../src/renderer/ai/revision-ops'

/**
 * `before` picks the body changes recorded before an instant. A date written
 * without a zone designator is UTC, as the engine reads it for header, footer
 * and note parts, so the same file and filter pick the same changes on every
 * machine. Each case runs under a zone east and a zone west of UTC.
 */

const live: Editor[] = []
const hostZone = process.env.TZ
afterEach(() => {
  for (const editor of live.splice(0)) editor.destroy()
  if (hostZone === undefined) delete process.env.TZ
  else process.env.TZ = hostZone
})

/** one paragraph holding one insertion per date, its text the date itself */
function insertionsDated(dates: string[]) {
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: editorExtensions,
    content: {
      type: 'doc',
      content: [
        {
          type: 'docParagraph',
          attrs: { docxIndex: null },
          content: dates.flatMap((date) => [
            { type: 'text', text: date, marks: [{ type: 'ins', attrs: { author: 'A', date } }] },
            { type: 'text', text: ' ' },
          ]),
        },
      ],
    },
  })
  live.push(editor)
  return editor.state.doc
}

describe.each(['Asia/Seoul', 'America/Los_Angeles'])(
  'the before selector with the machine in %s',
  (zone) => {
    /** the dates of the changes the selector picks */
    const picked = (dates: string[], before: string) => {
      process.env.TZ = zone
      const out = selectRevisions(insertionsDated(dates), { before })
      return 'entries' in out ? out.entries.map((e) => e.date) : out.error
    }

    it('a change date without a zone is UTC', () => {
      expect(
        picked(['2026-01-14T23:30:00', '2026-01-15T00:30:00'], '2026-01-15T00:00:00Z'),
      ).toEqual(['2026-01-14T23:30:00'])
    })

    it('a before without a zone is UTC', () => {
      expect(
        picked(['2026-01-14T23:30:00Z', '2026-01-15T00:30:00Z'], '2026-01-15T00:00:00'),
      ).toEqual(['2026-01-14T23:30:00Z'])
    })

    it('a zone designator keeps its meaning', () => {
      expect(
        picked(['2026-01-15T08:30:00+09:00', '2026-01-14T16:30:00-08:00'], '2026-01-15T00:00:00Z'),
      ).toEqual(['2026-01-15T08:30:00+09:00'])
    })
  },
)
