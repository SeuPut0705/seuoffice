/**
 * Speaker notes on a deck whose parts bind the PresentationML namespace as the default one
 * (`<presentation xmlns="...">`) or to a prefix other than `p`. It is the same document: notes
 * written to it must be listed where PowerPoint looks for them. A notes master that
 * presentation.xml does not list in `notesMasterIdLst` (right after `sldMasterIdLst`, before
 * `handoutMasterIdLst` and `sldIdLst`) makes PowerPoint offer to repair the file.
 */
import { describe, it, expect } from 'vitest'
import { XMLParser, XMLValidator } from 'fast-xml-parser'
import {
  createBlankPptx,
  getSlideNotes,
  openPptx,
  savePptx,
  setSlideNotes,
  type OpenedPptx,
} from '../src/index'
import { notesPathForSlide } from '../src/notes'
import { resolveTarget } from '../src/zip'

const PRES = 'ppt/presentation.xml'
const NOTES_MASTER_REL =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesMaster'

/** Every element of the part written under prefix `p:` written under `to` instead. */
function rebound(xml: string, to: string): string {
  const named = to === '' ? 'xmlns=' : `xmlns:${to.slice(0, -1)}=`
  return xml.replace(/<(\/?)p:/g, `<$1${to}`).replace('xmlns:p=', named)
}

async function deckWith(edit: (presXml: string) => string): Promise<OpenedPptx> {
  const opened = await openPptx(await createBlankPptx())
  const pres = opened.archive.readText(PRES)!
  expect(pres).toContain('<p:sldMasterIdLst>')
  opened.archive.entries.set(PRES, Buffer.from(edit(pres), 'utf8'))
  const reopened = await openPptx(await savePptx(opened))
  expect(reopened.deck.slides).toHaveLength(1)
  return reopened
}

/** The children of the root of `xml`, by local name, in document order. */
function rootChildren(xml: string): { name: string; node: Record<string, unknown>[] }[] {
  const doc = new XMLParser({ ignoreAttributes: false, preserveOrder: true }).parse(xml) as Record<
    string,
    unknown
  >[]
  const root = doc.find((n) => !Object.keys(n).includes('?xml'))!
  const rootName = Object.keys(root).find((k) => k !== ':@')!
  const children = root[rootName] as Record<string, unknown>[]
  return children.map((child) => {
    const name = Object.keys(child).find((k) => k !== ':@')!
    return { name: name.replace(/^[^:]*:/, ''), node: [child] }
  })
}

const FORMS: Array<[string, (pres: string) => string]> = [
  ['in the default namespace', (pres) => rebound(pres, '')],
  [
    'in the default namespace, with an empty notes master list',
    (pres) =>
      rebound(pres, '').replace('</sldMasterIdLst>', () => '</sldMasterIdLst><notesMasterIdLst/>'),
  ],
]

describe('notes on a deck whose presentation.xml has no p prefix', () => {
  it.each(FORMS)('%s: the notes master is listed where the schema puts it', async (_n, edit) => {
    const opened = await deckWith(edit)
    expect(setSlideNotes(opened, 0, 'note')).toBe(true)

    const reopened = await openPptx(await savePptx(opened))
    const pres = reopened.archive.readText(PRES)!
    expect(XMLValidator.validate(pres)).toBe(true)
    const children = rootChildren(pres)
    expect(children.map((c) => c.name)).toEqual([
      'sldMasterIdLst',
      'notesMasterIdLst',
      'sldIdLst',
      'sldSz',
      'notesSz',
    ])
    // the one entry names the relationship to the notes master part
    const list = children[1]!.node[0]!
    const listName = Object.keys(list).find((k) => k !== ':@')!
    const entries = (list[listName] as Record<string, unknown>[]).filter((e) => !('#text' in e))
    expect(entries).toHaveLength(1)
    const rid = (entries[0]![':@'] as Record<string, string>)['@_r:id']
    const rel = reopened.archive.readRels(PRES).get(rid!)
    expect(rel?.type).toBe(NOTES_MASTER_REL)
    const master = resolveTarget(PRES, rel!.target)
    expect(reopened.archive.readText(master)).toContain('notesMaster')
    // the notes slide hangs off that master, and holds the note
    const slidePath = reopened.deck.slides[0]!.path
    const notesPath = notesPathForSlide(reopened.archive, slidePath)!
    const notesMaster = [...reopened.archive.readRels(notesPath).values()].find(
      (r) => r.type === NOTES_MASTER_REL,
    )!
    expect(resolveTarget(notesPath, notesMaster.target)).toBe(master)
    expect(getSlideNotes(reopened.archive, slidePath)).toBe('note')
  })
})

describe('a notes slide part with no p prefix', () => {
  /** A deck with notes on slide 1, its notes slide part rewritten under the prefix `to`. */
  async function deckWithNotesPart(to: string): Promise<{ opened: OpenedPptx; path: string }> {
    const built = await openPptx(await createBlankPptx())
    expect(setSlideNotes(built, 0, 'first')).toBe(true)
    const notesPath = notesPathForSlide(built.archive, built.deck.slides[0]!.path)!
    built.archive.entries.set(
      notesPath,
      Buffer.from(rebound(built.archive.readText(notesPath)!, to), 'utf8'),
    )
    const opened = await openPptx(await savePptx(built))
    return { opened, path: notesPath }
  }

  it.each(['', 'pml:'])('under the prefix "%s" is read and written', async (to) => {
    const { opened, path } = await deckWithNotesPart(to)
    const slidePath = opened.deck.slides[0]!.path
    expect(getSlideNotes(opened.archive, slidePath)).toBe('first')

    expect(setSlideNotes(opened, 0, 'second\nthird & more')).toBe(true)
    const reopened = await openPptx(await savePptx(opened))
    const xml = reopened.archive.readText(path)!
    expect(XMLValidator.validate(xml)).toBe(true)
    expect(xml).not.toContain('<p:')
    expect(getSlideNotes(reopened.archive, slidePath)).toBe('second\nthird & more')
  })
})
