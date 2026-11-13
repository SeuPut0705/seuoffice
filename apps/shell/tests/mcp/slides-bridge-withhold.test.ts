/**
 * The slides bridge's readout for agent sessions (decision 0032): withheld runs
 * and withheld elements read as their `{{label}}`, the outside MCP readout is
 * unchanged, and a deck that withholds anything says so.
 */
import { describe, expect, it, vi } from 'vitest'
import { PackageArchive } from '@seuoffice/pptx-engine'

const sessions = new Map<number, unknown>()

vi.mock('electron', () => ({ webContents: { fromId: () => null } }))
vi.mock('../../../slides/src/main/slides-main', () => ({
  applySessionTxn: vi.fn(),
  saveSessionDeckTo: vi.fn(),
}))
vi.mock('../../../slides/src/main/session-state', () => ({
  sessions,
  attachedIds: () => [],
}))

const { createSlidesControl, elementWithholds } = await import('../../src/main/mcp/slides-bridge')

// whole model objects: the engine reads what it is handed as the model types it
const box = { offset: { x: 0, y: 0, cx: 100, cy: 100 }, rot: 0, flipH: false, flipV: false }
const anchor = { spIndex: 0, originalXml: '', range: [0, 0] }
const para = (...runs: Array<{ text: string; redact?: string }>) => ({ runs })

const COMMENTS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments'

const AUTHORS_XML =
  '<p:cmAuthorLst xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">' +
  '<p:cmAuthor id="0" name="Alice" initials="A" lastIdx="1"/>' +
  '<p:cmAuthor id="1" name="" initials="" lastIdx="2"/>' +
  '</p:cmAuthorLst>'
const COMMENTS_XML =
  '<p:cmLst xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">' +
  '<p:cm authorId="0" dt="2026-02-03T04:05:06Z" idx="1"><p:pos x="0" y="0"/>' +
  '<p:text>Please tighten this slide.</p:text></p:cm>' +
  '<p:cm authorId="1" dt="2026-02-04T05:06:07Z" idx="2"><p:pos x="1" y="1"/>' +
  '<p:text>Anonymous note</p:text></p:cm>' +
  '</p:cmLst>'

interface DeckOptions {
  hidden?: boolean
  comments?: { authorsXml: string; commentsXml: string }
}

/** A package holding the slide's rels and the comment parts getSlideComments reads. */
function archiveOf(comments: DeckOptions['comments']): PackageArchive {
  const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text)
  const entries: Array<[string, Uint8Array]> = []
  if (comments) {
    entries.push(
      [
        'ppt/slides/_rels/slide1.xml.rels',
        utf8(
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
            `<Relationship Id="rId2" Type="${COMMENTS_REL}" Target="../comments/comment1.xml"/>` +
            '</Relationships>',
        ),
      ],
      ['ppt/comments/comment1.xml', utf8(comments.commentsXml)],
      ['ppt/commentAuthors.xml', utf8(comments.authorsXml)],
    )
  }
  return PackageArchive.fromWire({ entries, originalHash: '' })
}

function deck(elements: unknown[], options: DeckOptions = {}) {
  return {
    opened: {
      archive: archiveOf(options.comments),
      deck: {
        size: { cx: 12192000, cy: 6858000 },
        slides: [
          {
            path: 'ppt/slides/slide1.xml',
            originalXml: '',
            bodyPrefix: options.hidden ? '<p:sld show="0">' : '<p:sld>',
            bodySuffix: '',
            elements,
          },
        ],
      },
    },
  }
}

interface SlideReadout {
  hidden?: boolean
  comments?: Array<{
    authorId: number
    idx: number
    author: string
    dt: string
    text: string
  }>
  elements: Array<{ text?: unknown }>
}

function slide0(readout: unknown): SlideReadout {
  return (readout as { slides: SlideReadout[] }).slides[0]!
}

const withheldRun = {
  id: 'e1',
  type: 'text',
  anchor,
  transform: box,
  text: { paragraphs: [para({ text: 'Salary: ' }, { text: '5,000', redact: 'pay' })] },
}
const withheldShape = {
  id: 'e2',
  type: 'shape',
  redact: 'secret box',
  anchor,
  transform: box,
  text: { paragraphs: [para({ text: 'hidden words' })] },
}
const table = {
  id: 'e3',
  type: 'table',
  anchor,
  transform: box,
  colWidths: [50, 50],
  rowHeights: [100],
  rows: [
    [
      { text: { paragraphs: [para({ text: 'Name' })] } },
      { text: { paragraphs: [para({ text: 'Kim', redact: 'person' })] } },
    ],
  ],
}
const plain = {
  id: 'e4',
  type: 'text',
  anchor,
  transform: box,
  text: { paragraphs: [para({ text: 'Hello' })] },
}

const control = createSlidesControl({ openBlankTab: () => 1 })

function texts(readout: unknown): unknown[] {
  return slide0(readout).elements.map((el) => el.text)
}

describe('the withholding readout', () => {
  it('reads withheld runs, elements and table cells as their labels', async () => {
    sessions.set(7, deck([withheldRun, withheldShape, table, plain]))
    const readout = await control.readDeck(7, { withhold: true })
    expect(texts(readout)).toEqual([
      'Salary: {{pay}}',
      '{{secret box}}',
      'Name | {{person}}',
      'Hello',
    ])
    expect(JSON.stringify(readout)).not.toContain('5,000')
    expect(JSON.stringify(readout)).not.toContain('hidden words')
    expect(JSON.stringify(readout)).not.toContain('Kim')
  })

  it('leaves the outside readout as it was', async () => {
    sessions.set(8, deck([withheldRun, plain]))
    expect(texts(await control.readDeck(8))).toEqual(['Salary: 5,000', 'Hello'])
  })

  it('tells whether a deck withholds anything', async () => {
    sessions.set(9, deck([plain]))
    sessions.set(10, deck([plain, table]))
    expect(await control.deckWithholds!(9)).toBe(false)
    expect(await control.deckWithholds!(10)).toBe(true)
    expect(
      elementWithholds({
        id: 'g',
        type: 'group',
        anchor,
        transform: box,
        children: [withheldShape],
      } as never),
    ).toBe(true)
  })
})

describe('slide comments and hidden slides in the readout', () => {
  const comments = { authorsXml: AUTHORS_XML, commentsXml: COMMENTS_XML }

  it('includes every comment and maps an empty author name to Unknown author', async () => {
    sessions.set(11, deck([plain], { comments }))
    const slide = slide0(await control.readDeck(11))
    expect(slide.comments).toEqual([
      {
        authorId: 0,
        idx: 1,
        author: 'Alice',
        dt: '2026-02-03T04:05:06Z',
        text: 'Please tighten this slide.',
      },
      {
        authorId: 1,
        idx: 2,
        author: 'Unknown author',
        dt: '2026-02-04T05:06:07Z',
        text: 'Anonymous note',
      },
    ])
  })

  it('marks a hidden slide, and only a hidden slide', async () => {
    sessions.set(12, deck([plain], { hidden: true }))
    sessions.set(13, deck([plain]))
    expect(slide0(await control.readDeck(12)).hidden).toBe(true)
    expect(slide0(await control.readDeck(13))).not.toHaveProperty('hidden')
  })

  it('leaves comments and the hidden marker untouched when withholding', async () => {
    sessions.set(14, deck([withheldRun], { hidden: true, comments }))
    const outside = slide0(await control.readDeck(14))
    const withheld = slide0(await control.readDeck(14, { withhold: true }))
    expect(withheld.hidden).toBe(true)
    expect(withheld.comments).toEqual(outside.comments)
    // comments are metadata, not slide content: no {{label}} substitution
    expect(withheld.comments?.map((c) => c.text)).toEqual([
      'Please tighten this slide.',
      'Anonymous note',
    ])
    expect(withheld.elements[0]!.text).toBe('Salary: {{pay}}')
  })

  it('omits comments when the slide has none', async () => {
    sessions.set(15, deck([plain]))
    expect(slide0(await control.readDeck(15))).not.toHaveProperty('comments')
  })
})
