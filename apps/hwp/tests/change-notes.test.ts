/**
 * A call into the editor counts as a change only when the saved file could differ after it.
 * The app keeps a count of such calls: the document check reads the document again when it
 * rises, and the recovery copier takes it for work on the document. A call that only reads,
 * or only changes what the editor shows (the memo anchors, the input lock of a memo dialog),
 * must not raise it. Each call is made here on a real document, and the saved bytes compared.
 */
import { describe, expect, it } from 'vitest'
import type { AgentBridge } from '../src/renderer/ai/agent-bridge'
import { withChangeNotes } from '../src/renderer/recovery-flow'
import { openEditor, same, useEngine } from './ai-run-harness'

useEngine()

type Call = (...args: unknown[]) => Promise<unknown>

/** One call of the bridge behind the app's change count: what the count is after it, and the file. */
async function made(
  name: keyof AgentBridge,
  args: unknown[],
  setup?: (bridge: AgentBridge) => Promise<unknown>,
) {
  const editor = openEditor()
  await setup?.(editor.bridge)
  const before = editor.bytes()
  let notes = 0
  const call = editor.bridge[name] as Call
  const noted = withChangeNotes({ [name]: (...rest: unknown[]) => call(...rest) }, () => {
    notes += 1
  })
  const answer = await noted[name]!(...args).then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  )
  return { notes, fileSame: same(editor.bytes(), before), answer }
}

const LABELS = { tag: 'not on this PC', hint: 'This font is not on this PC' }

describe('a call that leaves the saved file as it was is not counted as a change', () => {
  const READS: Array<[keyof AgentBridge, unknown[]]> = [
    ['readText', []],
    ['documentProfile', []],
    ['findText', ['문단']],
    ['listTables', []],
    ['listPictures', []],
    ['readPicture', [1]],
    ['checkLayout', []],
    ['listFields', []],
    ['listNotes', []],
    ['noteSettings', []],
    ['pageSetup', []],
    ['listStyles', []],
    ['readStyle', ['바탕글']],
    ['formatting', []],
    ['paragraphLooks', []],
    ['pageTarget', [0]],
    ['selection', []],
    ['listMemos', []],
    ['memoSelection', []],
    ['showMemoAnchors', [true]],
    ['selectMemo', [null]],
    ['setMemoLock', [false]],
    ['installEasyWords', ['Put in plain words']],
    ['watchMissingFonts', [LABELS]],
    ['clearMarks', []],
    ['runSteps', []],
  ]

  it.each(READS)('%s', async (name, args) => {
    const call = await made(name, args)
    // the harness answers each of these: a call that only threw would prove nothing
    expect(call.answer).not.toHaveProperty('error')
    expect(call.fileSame).toBe(true)
    expect(call.notes).toBe(0)
  })
})

describe('a call after which the saved file differs is counted', () => {
  const anchor = { place: 'body', sectionIndex: 0, paraIndex: 1, startCharIdx: 0, endCharIdx: 2 }
  const WRITES: Array<[keyof AgentBridge, unknown[]]> = [
    ['replaceText', ['첫째', '처음']],
    ['insertParagraphs', ['제목', null, 'after', ['새 문단']]],
    ['insertMemo', [anchor, 'person', 'a note']],
    ['setPageSetup', [{ margins: { left: 31 } }]],
  ]

  it.each(WRITES)('%s', async (name, args) => {
    const call = await made(name, args)
    expect(call.fileSame).toBe(false)
    // when it starts and when it lands
    expect(call.notes).toBe(2)
  })

  it('undo, after a change', async () => {
    const call = await made('undo', [1, 0], (bridge) => bridge.replaceText('첫째', '처음'))
    expect(call.fileSame).toBe(false)
    expect(call.notes).toBe(2)
  })
})
