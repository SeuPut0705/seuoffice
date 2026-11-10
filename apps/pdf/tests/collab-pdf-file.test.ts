/**
 * The file a co-editing session stores: the desktop save code over the base
 * bytes and the edits of the log. Two people edit at once, a third page that
 * only replays the log writes the file, and the file is read back.
 */
import { PDFArray, PDFDict, PDFDocument, PDFName } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { createPdfAdapter } from '../src/web/collab-adapter'
import { produceCoEditedFile, type CoEditedFile } from '../src/web/collab-file'
import { canonical, emptySnapshot, type PdfOp } from '../src/web/collab-model'
import {
  addBlankPage,
  addField,
  draw,
  field,
  highlight,
  ink,
  note,
  reorder,
  rotate,
} from './collab/actions'
import { HeadlessPdf, Room, blankFile } from './collab/headless'

const A4: [number, number] = [595, 842]

async function basePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  for (let i = 0; i < 3; i++) doc.addPage(A4)
  return doc.save({ useObjectStreams: false })
}

const subtypes = (doc: PDFDocument, pageIndex: number): string[] => {
  const annots = doc.getPage(pageIndex).node.lookupMaybe(PDFName.of('Annots'), PDFArray)
  if (!annots) return []
  return Array.from({ length: annots.size() }, (_, i) =>
    annots.lookup(i, PDFDict).lookup(PDFName.of('Subtype'), PDFName).decodeText(),
  )
}

describe('the co-edited PDF file', () => {
  it('a save by a page that only replayed the log holds both people’s edits', async () => {
    const room = new Room(blankFile(3))
    const alice = room.join()
    const bob = room.join()
    expect(highlight(alice.app, 0)).toBe(true)
    expect(rotate(alice.app, [1], 90)).toBe(true)
    expect(addBlankPage(alice.app, 2)).toBe(true)
    expect(draw(alice.app, ink(3))).toBe(true)
    expect(draw(bob.app, note(2, 'from bob'))).toBe(true)
    expect(
      bob.app.apply([{ op: 'setMetadata', metadata: { title: 'Shared plan' } }]).failures,
    ).toEqual([])
    expect(addField(bob.app, field('Name', 0))).toBe(true)
    expect(reorder(bob.app, [2, 0, 1])).toBe(true)
    room.settle(alice, bob)
    expect(alice.print()).toBe(bob.print())

    const bytes = await basePdf()
    const file: CoEditedFile = {
      path: '/web/shared.pdf',
      fileName: 'shared.pdf',
      bytes,
      pageSizes: [0, 1, 2].map(() => ({ width: A4[0], height: A4[1] })),
      password: () => null,
    }
    const carol = new HeadlessPdf(3, emptySnapshot())
    const adapter = createPdfAdapter({
      host: carol,
      basePages: 3,
      produce: (s) => produceCoEditedFile(s, file),
      refused: (reason) => reason.kind,
      maxOpBytes: 1 << 20,
      newId: carol.newId,
    })
    const sent: PdfOp[] = []
    adapter.listen((ops) => sent.push(...ops))
    adapter.integrate(
      room.log.map((wire) => adapter.decode(wire)),
      [],
    )
    expect(canonical(carol.state)).toBe(alice.print())

    const shown = carol.state
    const saved = await adapter.produceFile()
    // writing the file changed nothing on the page and sent nothing
    expect(carol.state).toBe(shown)
    expect(sent).toEqual([])
    expect(saved.fileName).toBe('shared.pdf')

    const out = await PDFDocument.load(saved.bytes)
    // bob's order with alice's blank page after the page she stood on: 2, blank, 0, 1
    expect(out.getPageCount()).toBe(4)
    expect(subtypes(out, 0)).toEqual(['Text'])
    expect(subtypes(out, 1)).toEqual(['Ink'])
    expect(subtypes(out, 2)).toContain('Highlight')
    expect(subtypes(out, 2)).toContain('Widget')
    expect(out.getPage(3).getRotation().angle).toBe(90)
    expect(out.getTitle()).toBe('Shared plan')
    expect(
      out
        .getForm()
        .getFields()
        .map((f) => f.getName()),
    ).toEqual(['Name'])

    // the base file is what every page opened: the save never wrote into it
    expect(file.bytes).toBe(bytes)
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(3)
  })
})
