// @vitest-environment node
/**
 * What a HWPX save reports as missing memos. The engine lists the memos it models;
 * the section XML can hold raw memo anchors it does not. A save warns only about
 * memos that were there before and are gone after, never about a memo the user
 * removed on purpose. The engine itself is mocked here: `tab-widths.test.ts` checks
 * the raw count against files the real engine wrote.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HwpMemo } from '@genoffice/file-parse'
import type { MemoSnapshot } from '../src/shared/ipc'

const { memoList, rawCount } = vi.hoisted(() => ({
  memoList: vi.fn<(bytes: Uint8Array) => Promise<HwpMemo[]>>(),
  rawCount: vi.fn<(bytes: Uint8Array) => number | null>(),
}))

vi.mock('@genoffice/file-parse', () => ({ hwpMemosOf: memoList }))
vi.mock('../src/main/tab-widths', () => ({ hwpxMemoCountOf: rawCount }))

const { lostMemoCountOf } = await import('../src/main/memos')

const SAVED = Uint8Array.from([1])
const ORIGINAL = Uint8Array.from([2])

function snapshot(text: string, author = 'CDC', place = 'body'): MemoSnapshot {
  return {
    author,
    date: null,
    text,
    place,
    sectionIndex: 0,
    paraIndex: 0,
    startCharIdx: 0,
    endCharIdx: 0,
    path: null,
  }
}

function listed(text: string, author = 'CDC', place = 'body'): HwpMemo {
  return { author, date: null, text, place }
}

/** the written file first, the opened file second (when it is read at all) */
function models(saved: HwpMemo[], original?: HwpMemo[]): void {
  memoList.mockResolvedValueOnce(saved)
  if (original) memoList.mockResolvedValueOnce(original)
}

beforeEach(() => {
  memoList.mockReset()
  rawCount.mockReset()
})

describe('lostMemoCountOf', () => {
  it('reports a listed memo the written file does not have', async () => {
    models([])
    expect(await lostMemoCountOf({ saved: SAVED, original: null, memos: [snapshot('확인')] })).toBe(
      1,
    )
  })

  it('reports nothing when every listed memo came through', async () => {
    models([listed('확인')])
    expect(await lostMemoCountOf({ saved: SAVED, original: null, memos: [snapshot('확인')] })).toBe(
      0,
    )
  })

  it('matches memos as a multiset, not by position, and counts each once', async () => {
    models([listed('둘'), listed('하나')])
    expect(
      await lostMemoCountOf({
        saved: SAVED,
        original: null,
        memos: [snapshot('하나'), snapshot('둘'), snapshot('하나')],
      }),
    ).toBe(1)
  })

  it('does not read either file with the engine when neither the editor nor the file had memos', async () => {
    rawCount.mockReturnValueOnce(0)
    expect(await lostMemoCountOf({ saved: SAVED, original: ORIGINAL, memos: [] })).toBe(0)
    expect(memoList).not.toHaveBeenCalled()
    expect(rawCount).toHaveBeenCalledOnce()
  })

  it('does not report a memo the user removed on purpose', async () => {
    models([], [listed('지운 메모')])
    rawCount.mockReturnValueOnce(1).mockReturnValueOnce(0)
    expect(await lostMemoCountOf({ saved: SAVED, original: ORIGINAL, memos: [] })).toBe(0)
  })

  it('counts raw memo anchors the engine did not model when they fall', async () => {
    models([], [])
    rawCount.mockReturnValueOnce(2).mockReturnValueOnce(1)
    expect(await lostMemoCountOf({ saved: SAVED, original: ORIGINAL, memos: null })).toBe(1)
  })

  it('never reports raw anchors that grew, or a negative loss', async () => {
    models([], [])
    rawCount.mockReturnValueOnce(1).mockReturnValueOnce(2)
    expect(await lostMemoCountOf({ saved: SAVED, original: ORIGINAL, memos: null })).toBe(0)

    rawCount.mockReturnValueOnce(1).mockReturnValueOnce(0)
    models([], [listed('가'), listed('나'), listed('다')])
    expect(await lostMemoCountOf({ saved: SAVED, original: ORIGINAL, memos: null })).toBe(0)
  })

  it('adds a lost model memo and a lost unmodelled anchor together', async () => {
    models([], [listed('확인')])
    rawCount.mockReturnValueOnce(2).mockReturnValueOnce(0)
    expect(
      await lostMemoCountOf({ saved: SAVED, original: ORIGINAL, memos: [snapshot('확인')] }),
    ).toBe(2)
  })

  it('checks raw anchors only against an HWPX original, not a new file', async () => {
    models([listed('확인')])
    expect(await lostMemoCountOf({ saved: SAVED, original: null, memos: [snapshot('확인')] })).toBe(
      0,
    )
    expect(rawCount).not.toHaveBeenCalled()
    expect(memoList).toHaveBeenCalledTimes(1)
  })

  it('skips reading entirely when there is no list and no original', async () => {
    expect(await lostMemoCountOf({ saved: SAVED, original: null, memos: [] })).toBe(0)
    expect(memoList).not.toHaveBeenCalled()
    expect(rawCount).not.toHaveBeenCalled()
  })

  it('reports nothing when the written file cannot be read back', async () => {
    memoList.mockRejectedValueOnce(new Error('broken zip'))
    expect(await lostMemoCountOf({ saved: SAVED, original: null, memos: [snapshot('확인')] })).toBe(
      0,
    )
    expect(rawCount).not.toHaveBeenCalled()
  })

  it('reports nothing when the opened file cannot be read', async () => {
    memoList.mockResolvedValueOnce([]).mockRejectedValueOnce(new Error('broken zip'))
    expect(await lostMemoCountOf({ saved: SAVED, original: ORIGINAL, memos: null })).toBe(0)
    expect(rawCount).toHaveBeenCalledOnce()
  })

  it('keeps the model result when the saved raw count cannot be read', async () => {
    models([], [])
    rawCount.mockReturnValueOnce(2).mockReturnValueOnce(null)
    expect(await lostMemoCountOf({ saved: SAVED, original: ORIGINAL, memos: null })).toBe(0)

    rawCount.mockReset()
    models([], [listed('확인')])
    rawCount.mockReturnValueOnce(1).mockReturnValueOnce(null)
    expect(
      await lostMemoCountOf({ saved: SAVED, original: ORIGINAL, memos: [snapshot('확인')] }),
    ).toBe(1)
  })
})
