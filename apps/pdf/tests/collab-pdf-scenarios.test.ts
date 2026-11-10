// @vitest-environment node
/**
 * Co-editing one PDF, case by case: two people act at the same version, the
 * server orders one before the other, and every page must end with the same
 * edits (and the edit each person meant, where that is possible). A late
 * joiner replays the log from the base file.
 */
import { describe, expect, it } from 'vitest'
import {
  GREEN,
  addBlankPage,
  addField,
  deletePage,
  deleteThread,
  draw,
  field,
  highlight,
  ink,
  note,
  reorder,
  rotate,
  stamp,
} from './collab/actions'
import { MAX_OP_BYTES, Room, blankFile, type RoomPage } from './collab/headless'

/** The box of the page's one picture stamp */
function stampRect(page: RoomPage): number[] {
  const input = page.app.state.drawings[0]!.input
  if (input.kind !== 'image') throw new Error('not a stamp')
  return input.rect
}

/** How large change `index` of the log went over the wire */
const wireSize = (room: Room, index: number): number => JSON.stringify(room.log[index]).length

function expectConverged(room: Room): string {
  const reference = room.late().print()
  for (const page of room.pages) expect(page.print()).toBe(reference)
  return reference
}

describe('co-editing a PDF', () => {
  it('two people highlight different pages at once: both highlights stay', () => {
    const room = new Room()
    const a = room.join()
    const b = room.join()
    expect(highlight(a.app, 0)).toBe(true)
    expect(highlight(b.app, 2, GREEN)).toBe(true)
    room.settle(a, b)
    for (const page of room.pages) {
      expect(page.app.state.markups.map((m) => m.pageIndex).sort()).toEqual([0, 2])
    }
    expectConverged(room)
  })

  for (const first of ['a', 'b'] as const) {
    it(`two people add a blank page at once: both pages stay, each with what its author drew (${first} first)`, () => {
      const room = new Room(blankFile(2))
      const a = room.join()
      const b = room.join()
      expect(addBlankPage(a.app, 0)).toBe(true)
      expect(addBlankPage(b.app, 1)).toBe(true)
      // each draws on the page they just added: both minted index 2
      expect(draw(a.app, ink(2))).toBe(true)
      expect(draw(b.app, note(2, 'on the new page'))).toBe(true)
      room.settle(...(first === 'a' ? [a, b] : [b, a]))
      const [earlier, later] = first === 'a' ? [a, b] : [b, a]
      for (const page of room.pages) {
        const s = page.app.state
        expect(s.blankPages.map((p) => p.input.pageIndex).sort()).toEqual([2, 3])
        expect(new Set(s.order)).toEqual(new Set([0, 1, 2, 3]))
        const indexOf = (page: RoomPage) =>
          s.blankPages.find((p) => p.id.startsWith(`${page.app.name}-`))!.input.pageIndex
        expect(indexOf(earlier)).toBe(2)
        expect(indexOf(later)).toBe(3)
        // the drawing follows its author's page
        const kindOn = (index: number) =>
          s.drawings.filter((d) => d.input.pageIndex === index).map((d) => d.input.kind)
        expect(kindOn(indexOf(a))).toEqual(['ink'])
        expect(kindOn(indexOf(b))).toEqual(['note'])
        // each new page sits after the page its author stood on
        expect(s.order).toEqual([0, indexOf(a), 1, indexOf(b)])
      }
      expectConverged(room)
    })
  }

  it('undo history follows a renumbered blank page', () => {
    const room = new Room(blankFile(2))
    const a = room.join()
    const b = room.join()
    addBlankPage(a.app, 1)
    addBlankPage(b.app, 1)
    draw(b.app, ink(2))
    room.settle(a, b)
    // b's page is 3 now; undoing the drawing and the page must address 3, not a's page 2
    expect(b.app.undo()).toBe(true)
    expect(b.app.undo()).toBe(true)
    room.settle(b)
    for (const page of room.pages) {
      const s = page.app.state
      expect(s.drawings).toEqual([])
      expect([...s.deleted]).toEqual([3])
      expect(s.deleted.has(2)).toBe(false)
    }
    expectConverged(room)
  })

  for (const deleter of ['first', 'second'] as const) {
    it(`one deletes a page while the other highlights it: page and highlight are gone everywhere (deleter ${deleter})`, () => {
      const room = new Room()
      const a = room.join()
      const b = room.join()
      expect(deletePage(a.app, 1)).toBe(true)
      expect(highlight(b.app, 1)).toBe(true)
      room.settle(...(deleter === 'first' ? [a, b] : [b, a]))
      for (const page of room.pages) {
        expect([...page.app.state.deleted]).toEqual([1])
        expect(page.app.state.markups).toEqual([])
      }
      expectConverged(room)
    })
  }

  it('one reorders pages while the other adds a blank page: the order holds, the page keeps its neighbour', () => {
    const room = new Room(blankFile(3))
    const a = room.join()
    const b = room.join()
    expect(reorder(a.app, [2, 0, 1])).toBe(true)
    expect(addBlankPage(b.app, 0)).toBe(true)
    room.settle(a, b)
    for (const page of room.pages) expect(page.app.state.order).toEqual([2, 0, 3, 1])
    expectConverged(room)
  })

  it('one adds a blank page while the other reorders: the later reorder wins and keeps the new page', () => {
    const room = new Room(blankFile(3))
    const a = room.join()
    const b = room.join()
    expect(addBlankPage(a.app, 0)).toBe(true)
    expect(reorder(b.app, [2, 1, 0])).toBe(true)
    room.settle(a, b)
    for (const page of room.pages) expect(page.app.state.order).toEqual([2, 1, 0, 3])
    expectConverged(room)
  })

  it('two people turn the same page a quarter each: it turns half', () => {
    const room = new Room()
    const a = room.join()
    const b = room.join()
    expect(rotate(a.app, [1], 90)).toBe(true)
    expect(rotate(b.app, [1], 90)).toBe(true)
    room.settle(b, a)
    for (const page of room.pages) expect([...page.app.state.rotations]).toEqual([[1, 180]])
    expectConverged(room)
  })

  for (const remover of ['first', 'second'] as const) {
    it(`one recolors a highlight the other removes: it stays removed (remover ${remover})`, () => {
      const room = new Room()
      const a = room.join()
      const b = room.join()
      highlight(a.app, 0)
      room.settle(a)
      const id = b.app.state.markups[0]!.id
      expect(a.app.apply([{ op: 'removeMarkup', id }]).failures).toEqual([])
      expect(b.app.apply([{ op: 'recolorMarkup', id, color: GREEN }]).failures).toEqual([])
      room.settle(...(remover === 'first' ? [a, b] : [b, a]))
      for (const page of room.pages) expect(page.app.state.markups).toEqual([])
      expectConverged(room)
    })
  }

  for (const deleter of ['first', 'second'] as const) {
    it(`one replies to a note the other deletes: the whole thread is gone (deleter ${deleter})`, () => {
      const room = new Room()
      const a = room.join()
      const b = room.join()
      draw(a.app, note(0, 'question'))
      room.settle(a)
      const root = b.app.state.drawings[0]!.id
      expect(deleteThread(a.app, root)).toBe(true)
      expect(draw(b.app, note(0, 'answer', root))).toBe(true)
      room.settle(...(deleter === 'first' ? [a, b] : [b, a]))
      for (const page of room.pages) expect(page.app.state.drawings).toEqual([])
      expectConverged(room)
    })
  }

  it('undo takes back only my own edit, not a peer’s that came after it', () => {
    const room = new Room()
    const a = room.join()
    const b = room.join()
    highlight(a.app, 0)
    room.settle(a)
    highlight(b.app, 1)
    rotate(b.app, [2], 90)
    room.settle(b)
    rotate(a.app, [2], 90)
    room.settle(a)
    expect(a.app.undo()).toBe(true) // a's quarter turn
    expect(a.app.undo()).toBe(true) // a's highlight
    room.settle(a)
    for (const page of room.pages) {
      expect(page.app.state.markups.map((m) => m.pageIndex)).toEqual([1])
      expect([...page.app.state.rotations]).toEqual([[2, 90]])
    }
    expect(a.app.redo()).toBe(true)
    room.settle(a)
    for (const page of room.pages) {
      expect(page.app.state.markups.map((m) => m.pageIndex).sort()).toEqual([0, 1])
    }
    expectConverged(room)
  })

  it('undo after a peer changed a highlight I had deleted takes back my last edit only', () => {
    const room = new Room()
    const a = room.join()
    const b = room.join()
    highlight(b.app, 0)
    room.settle(b)
    const theirs = a.app.state.markups[0]!.id
    // a deletes b's highlight and draws one of their own; neither is confirmed yet
    expect(a.app.apply([{ op: 'removeMarkup', id: theirs }]).failures).toEqual([])
    highlight(a.app, 1)
    // b recolours the highlight, and the server takes that first
    expect(b.app.apply([{ op: 'recolorMarkup', id: theirs, color: GREEN }]).failures).toEqual([])
    room.settle(b)
    expect(a.app.state.markups.map((m) => m.pageIndex)).toEqual([1])

    // one undo takes back a's own highlight and nothing else: b's stays deleted
    expect(a.app.undo()).toBe(true)
    expect(a.app.state.markups).toEqual([])
    room.settle(a)
    for (const page of room.pages) expect(page.app.state.markups).toEqual([])
    // the next takes back the deletion: the highlight is back as b left it
    expect(a.app.undo()).toBe(true)
    room.settle(a)
    for (const page of room.pages) {
      expect(page.app.state.markups.map((m) => [m.pageIndex, m.color])).toEqual([[0, GREEN]])
    }
    // and redo deletes it again, then draws a's highlight again
    expect(a.app.redo()).toBe(true)
    expect(a.app.redo()).toBe(true)
    room.settle(a)
    for (const page of room.pages) {
      expect(page.app.state.markups.map((m) => m.pageIndex)).toEqual([1])
    }
    expectConverged(room)
  })

  it('undo after a peer turned the page I had turned takes back my last edit only', () => {
    const room = new Room()
    const a = room.join()
    const b = room.join()
    // a turns the second page and highlights; b's turn of the same page is confirmed first
    rotate(a.app, [1], 90)
    highlight(a.app, 0)
    rotate(b.app, [1], 90)
    room.settle(b)
    expect([...a.app.state.rotations]).toEqual([[1, 180]])

    // undoing the highlight leaves both turns
    expect(a.app.undo()).toBe(true)
    expect(a.app.state.markups).toEqual([])
    expect([...a.app.state.rotations]).toEqual([[1, 180]])
    room.settle(a)
    for (const page of room.pages) {
      expect(page.app.state.markups).toEqual([])
      expect([...page.app.state.rotations]).toEqual([[1, 180]])
    }
    // undoing a's turn leaves b's
    expect(a.app.undo()).toBe(true)
    room.settle(a)
    for (const page of room.pages) expect([...page.app.state.rotations]).toEqual([[1, 90]])
    expectConverged(room)
  })

  it('undo of my creation after a peer changed it does nothing, and uses up the step', () => {
    const room = new Room()
    const a = room.join()
    const b = room.join()
    highlight(a.app, 0)
    room.settle(a)
    const mine = b.app.state.markups[0]!.id
    expect(b.app.apply([{ op: 'recolorMarkup', id: mine, color: GREEN }]).failures).toEqual([])
    room.settle(b)
    expect(a.app.undoStack).toHaveLength(1)
    expect(a.app.undo()).toBe(true)
    expect(a.app.undoStack).toHaveLength(0)
    // nothing was sent: the highlight is now also b's work
    expect(a.local).toEqual([])
    for (const page of room.pages) {
      expect(page.app.state.markups.map((m) => [m.id, m.color])).toEqual([[mine, GREEN]])
    }
    expectConverged(room)
  })

  it('two quarter turns of one page at once turn a picture stamp on it twice as well', () => {
    const room = new Room()
    const a = room.join()
    const b = room.join()
    draw(a.app, stamp(1, 1000))
    room.settle(a)
    const upright = stampRect(a)
    // one turn lays the stamp's box on its side about its centre, on every page
    rotate(a.app, [1], 90)
    room.settle(a)
    const sideways = [35, -15, 85, 85]
    for (const page of [...room.pages, room.late()]) expect(stampRect(page)).toEqual(sideways)
    // both turn it once more at one version: two more quarter turns, so the box is turned
    // twice more as well and lies on its side again
    rotate(a.app, [1], 90)
    rotate(b.app, [1], 90)
    room.settle(a, b)
    for (const page of [...room.pages, room.late()]) {
      expect([...page.app.state.rotations]).toEqual([[1, 270]])
      expect(stampRect(page)).toEqual(sideways)
    }
    // undoing one of the two turns stands it up
    expect(b.app.undo()).toBe(true)
    room.settle(b)
    for (const page of [...room.pages, room.late()]) {
      expect([...page.app.state.rotations]).toEqual([[1, 180]])
      expect(stampRect(page)).toEqual(upright)
    }
    expectConverged(room)
  })

  it('a picture stamp’s bytes travel once: moving it, by anyone, sends a reference', () => {
    const room = new Room()
    const a = room.join()
    const b = room.join()
    const bytes = 40_000
    draw(a.app, stamp(0, bytes))
    // moved before the stamp is in the log: the move cannot count on the bytes being there
    const id = a.app.state.drawings[0]!.id
    expect(a.app.apply([{ op: 'moveDrawing', id, dx: 5, dy: 5 }]).failures).toEqual([])
    room.settle(a)
    expect(wireSize(room, 0)).toBeGreaterThan(bytes)
    expect(wireSize(room, 1)).toBeGreaterThan(bytes)
    // from then on a move by its author and one by someone else are small
    expect(a.app.apply([{ op: 'moveDrawing', id, dx: 10, dy: 0 }]).failures).toEqual([])
    room.settle(a)
    expect(b.app.apply([{ op: 'moveDrawing', id, dx: 0, dy: 10 }]).failures).toEqual([])
    room.settle(b)
    expect(wireSize(room, 2)).toBeLessThan(1000)
    expect(wireSize(room, 3)).toBeLessThan(1000)
    for (const page of [...room.pages, room.late()]) {
      const input = page.app.state.drawings[0]!.input
      if (input.kind !== 'image') throw new Error('not a stamp')
      expect(input.image).toBe('A'.repeat(bytes))
      expect(input.rect).toEqual([25, 25, 125, 75])
    }
    expectConverged(room)
  })

  it('a page with two large stamps can be deleted and brought back by undo', () => {
    const room = new Room()
    const a = room.join()
    room.join()
    const half = Math.floor(MAX_OP_BYTES * 0.6)
    draw(a.app, stamp(1, half))
    room.settle(a)
    draw(a.app, { ...stamp(1, half), image: 'B'.repeat(half) })
    room.settle(a)
    deletePage(a.app, 1)
    room.settle(a)
    // the undo puts both stamps back in one change: together their bytes are over the limit
    expect(a.app.undo()).toBe(true)
    expect(a.app.refusals).toEqual([])
    room.settle(a)
    for (const page of [...room.pages, room.late()]) {
      expect(page.app.state.deleted.size).toBe(0)
      expect(page.app.state.drawings.map((d) => d.input.kind)).toEqual(['image', 'image'])
    }
    expectConverged(room)
  })

  it('an undone page deletion brings back the page and what was on it', () => {
    const room = new Room()
    const a = room.join()
    const b = room.join()
    highlight(a.app, 1)
    room.settle(a)
    deletePage(a.app, 1)
    room.settle(a)
    expect(b.app.state.markups).toEqual([])
    expect(a.app.undo()).toBe(true)
    room.settle(a)
    for (const page of room.pages) {
      expect(page.app.state.deleted.size).toBe(0)
      expect(page.app.state.markups.map((m) => m.pageIndex)).toEqual([1])
    }
    expectConverged(room)
  })

  it('two people delete the last two pages at once: one page remains', () => {
    const room = new Room(blankFile(2))
    const a = room.join()
    const b = room.join()
    expect(deletePage(a.app, 0)).toBe(true)
    expect(deletePage(b.app, 1)).toBe(true)
    room.settle(a, b)
    for (const page of room.pages) expect([...page.app.state.deleted]).toEqual([0])
    expectConverged(room)
  })

  it('two people add a form field with the same name: the later one is numbered', () => {
    const room = new Room()
    const a = room.join()
    const b = room.join()
    expect(addField(a.app, field('Name', 0))).toBe(true)
    expect(addField(b.app, field('Name', 1))).toBe(true)
    room.settle(a, b)
    for (const page of room.pages) {
      expect(page.app.state.formFields.map((f) => f.input.name)).toEqual(['Name', 'Name 2'])
    }
    expectConverged(room)
  })

  it('two people add radio buttons of one group at once: both join the group', () => {
    const room = new Room()
    const a = room.join()
    const b = room.join()
    addField(a.app, field('choice', 0, 'radio'))
    addField(b.app, field('choice', 1, 'radio'))
    room.settle(a, b)
    for (const page of room.pages) {
      expect(page.app.state.formFields.map((f) => f.input.name)).toEqual(['choice', 'choice'])
    }
    expectConverged(room)
  })

  it('two people fill the same form field: the later value wins everywhere', () => {
    const room = new Room()
    const a = room.join()
    const b = room.join()
    a.app.apply([{ op: 'setFormValue', value: { name: 'city', kind: 'text', value: 'Seoul' } }])
    b.app.apply([{ op: 'setFormValue', value: { name: 'city', kind: 'text', value: 'Busan' } }])
    room.settle(a, b)
    for (const page of room.pages) {
      expect(page.app.state.formEdits.get('city')).toEqual({
        name: 'city',
        kind: 'text',
        value: 'Busan',
      })
    }
    expectConverged(room)
  })

  it('text, image and saved-annotation edits are refused with a message and change nothing', () => {
    const room = new Room()
    const a = room.join()
    const refused = [
      a.app.apply([
        {
          op: 'putTextEdit',
          input: { pageIndex: 0, rect: [0, 0, 1, 1], oldText: 'a', newText: 'b' },
        },
      ]),
      a.app.apply([{ op: 'addTextInsert', input: { pageIndex: 0, text: 'hi', origin: [0, 0] } }]),
      a.app.apply([
        {
          op: 'addImageEdit',
          input: { kind: 'insertImage', pageIndex: 0, rect: [0, 0, 9, 9], image: 'x' },
        },
      ]),
      a.app.apply([
        {
          op: 'deleteSavedAnnot',
          annot: { pageIndex: 0, objNum: 7, type: 'highlight', quads: [], rect: [0, 0, 1, 1] },
        },
      ]),
    ]
    for (const plan of refused) expect(plan.failures[0]?.error).toMatch(/^refused: feature/)
    expect(a.app.refusals.map((r) => (r.kind === 'feature' ? r.feature : r.kind))).toEqual([
      'text',
      'text',
      'image',
      'savedAnnotation',
    ])
    expect(a.local).toEqual([])
    expect(a.print()).toBe(room.late().print())
  })

  it('outline, attachment, protection and redaction changes are refused', () => {
    const room = new Room()
    const a = room.join()
    for (const what of ['outline', 'attachments', 'protection', 'redaction'] as const) {
      expect(a.app.link.current!.blocks(what)).toBe(true)
    }
    expect(a.app.link.current!.blocks('history')).toBe(false)
    expect(a.app.refusals).toHaveLength(4)
  })

  it('nothing is sent at open, and nothing while the page may not edit', () => {
    const room = new Room()
    const a = room.join()
    expect(a.local).toEqual([])
    highlight(a.app, 0)
    room.settle(a)
    a.adapter.setEditable(false)
    expect(highlight(a.app, 1)).toBe(false)
    expect(a.app.undo()).toBe(false)
    expect(a.app.refusals.map((r) => r.kind)).toEqual(['frozen', 'frozen'])
    expect(a.local).toEqual([])
    expect(a.app.state.markups).toHaveLength(1)
    a.adapter.setEditable(true)
    expect(a.app.undo()).toBe(true)
    expect(a.local).toHaveLength(1)
  })

  it('an image stamp larger than one change is refused before it lands', () => {
    const room = new Room()
    const a = room.join()
    expect(draw(a.app, stamp(0, MAX_OP_BYTES + 1))).toBe(false)
    expect(a.app.refusals[0]?.kind).toBe('tooLarge')
    expect(a.app.state.drawings).toEqual([])
    expect(draw(a.app, stamp(0, 1000))).toBe(true)
    expect(a.local).toHaveLength(1)
  })

  it('a late joiner sees every edit, removed and renumbered ones included', () => {
    const room = new Room(blankFile(2))
    const a = room.join()
    const b = room.join()
    addBlankPage(a.app, 0)
    addBlankPage(b.app, 0)
    highlight(b.app, 2)
    rotate(a.app, [0], 90)
    deletePage(b.app, 1)
    room.settle(b, a)
    const reference = expectConverged(room)
    expect(reference).toContain('"blankPages"')
  })
})
