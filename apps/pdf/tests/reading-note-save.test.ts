/**
 * "Keep as note" on a passage card (reading-assist spec 4.2, 5.7): the note is
 * a standard /Text annotation whose /Contents starts with the UI-language
 * heading, authored like a note a person adds. Checked by saving through the
 * real save path and reading the bytes back.
 */
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFString } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { applySaveRequest } from '../src/main/save-pdf'
import type { SavePdfRequest } from '../src/shared/ipc'
import type { PassageCard } from '../../../packages/pdf-structure/src/store/reading'
import { passageNoteDrawing } from '../src/renderer/reading/passage-cards'

const CARD: PassageCard = {
  id: 'c1',
  kind: 'translate',
  lang: 'en',
  page: 1,
  pageFingerprint: 'fp1',
  quads: [[100, 700, 300, 700, 100, 688, 300, 688]],
  excerpt: '구절',
  passageHash: 'h',
  text: 'The passage.\nSecond line.',
  provider: 'codex',
  model: '',
  createdAt: 1,
  savedAt: 1,
}

async function onePage(): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  doc.addPage([595, 842])
  return doc.save({ useObjectStreams: false })
}

const decode = (v: unknown): string =>
  v instanceof PDFHexString || v instanceof PDFString ? v.decodeText() : ''

async function textAnnots(bytes: Uint8Array): Promise<{ contents: string; author: string }[]> {
  const doc = await PDFDocument.load(bytes)
  const annots = doc.getPage(0).node.lookupMaybe(PDFName.of('Annots'), PDFArray)
  if (!annots) return []
  return annots
    .asArray()
    .map((ref) => doc.context.lookup(ref))
    .filter((d): d is PDFDict => d instanceof PDFDict)
    .filter((d) => d.get(PDFName.of('Subtype'))?.toString() === '/Text')
    .map((d) => ({
      contents: decode(d.get(PDFName.of('Contents'))),
      author: decode(d.get(PDFName.of('T'))),
    }))
}

const request = (over: Partial<SavePdfRequest>): SavePdfRequest => ({
  path: 'test.pdf',
  markups: [],
  drawings: [],
  formValues: [],
  stamps: [],
  ...over,
})

describe('keep a passage card as a note', () => {
  it('saves a /Text note headed by the UI-language label, authored by the account name', async () => {
    const note = passageNoteDrawing({
      card: CARD,
      origIdx: 0,
      heading: 'AI 번역(영어)',
      author: 'kim',
      color: [1, 0.85, 0.2],
      now: Date.UTC(2026, 9, 19),
    })
    const out = await applySaveRequest(await onePage(), request({ drawings: [note] }))
    const notes = await textAnnots(out.bytes)
    expect(notes).toHaveLength(1)
    expect(notes[0]!.contents.split('\n')[0]).toBe('AI 번역(영어)')
    expect(notes[0]!.contents).toBe('AI 번역(영어)\nThe passage.\nSecond line.')
    expect(notes[0]!.author).toBe('kim')
  })

  it('falls back to the same default author as a note a person adds when no account name is known', async () => {
    const human = await applySaveRequest(
      await onePage(),
      request({
        drawings: [
          {
            kind: 'note',
            pageIndex: 0,
            color: [1, 1, 0],
            at: [10, 10],
            contents: 'x',
            createdMs: 1,
          },
        ],
      }),
    )
    const fromCard = await applySaveRequest(
      await onePage(),
      request({
        drawings: [
          passageNoteDrawing({
            card: CARD,
            origIdx: 0,
            heading: 'h',
            author: '',
            color: [1, 1, 0],
            now: 1,
          }),
        ],
      }),
    )
    expect((await textAnnots(fromCard.bytes))[0]!.author).toBe(
      (await textAnnots(human.bytes))[0]!.author,
    )
  })
})
