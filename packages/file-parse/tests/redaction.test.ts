import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { REDACT_EL, REDACT_NS_WRITTEN } from '@seuoffice/agent-core/redact-range'
// the writer's own helpers, by path: the marks under test are the ones the deck
// engine really saves, not a copy of their shape kept in this file
import { REDACT_EXT_URI, setRedactExt } from '../../pptx-engine/src/redaction-xml'
import {
  parseFileToText,
  pptxToText,
  redactHtmlSource,
  redactMarkdownSource,
  xlsxToText,
} from '../src/index'
import { PPTX_REDACT_EXT_URI } from '../src/pptx-redaction'
import { pivotOutputOf } from '../src/xlsx-formula-redaction'
import { xlsxWithheldCells } from '../src/redaction'
import { writeFixture } from './helpers/fixtures'
// the workbook gateway's own writers: the part and its defined-name copy under
// test are the ones a save really produces
import {
  applyRedactionNameMirror,
  rekeyRedactionStates,
  serializeRedactionPart,
  type RedactionMark,
  type SheetRedactionState,
} from '@seuoffice/xlsx-gateway/gateway/xlsx-redaction'
import {
  applyCellEditsToXlsx,
  type SheetStructuralOps,
} from '@seuoffice/xlsx-gateway/gateway/xlsx-gateway'
import type { SheetEditPlan } from '@seuoffice/xlsx-gateway/gateway/xlsx-sheets'

/**
 * A file read as another file's material (attachment, knowledge base, search
 * index) must not hand over what its own editor withholds from a model. Two
 * things are checked for every mark kind: the withheld words are not in the
 * result, and a mark that cannot be processed fails the read instead of
 * returning the original text.
 */

const LABEL = 'client phone'
const SECRET = '13800138000'
const MARKER = `{{${LABEL}}}`

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'
const SLIDE_NS =
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ' +
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'

const RPR = '<a:rPr lang="en-US" sz="1800"><a:latin typeface="Calibri"/></a:rPr>'
const RPR_SELF = '<a:rPr lang="en-US"/>'

const run = (text: string, rPr = '') => `<a:r>${rPr}<a:t>${text}</a:t></a:r>`
/** a run as the engine saves it once the reader has withheld it */
const withheldRun = (text: string, label = LABEL, rPr = RPR) => run(text, setRedactExt(rPr, label))

function slideXml(paragraphs: string[], extra = ''): string {
  return (
    `${XML_DECL}<p:sld ${SLIDE_NS}><p:cSld><p:spTree><p:sp><p:txBody>` +
    paragraphs.map((p) => `<a:p>${p}</a:p>`).join('') +
    `</p:txBody></p:sp>${extra}</p:spTree></p:cSld></p:sld>`
  )
}

function notesXml(paragraphs: string[]): string {
  return (
    `${XML_DECL}<p:notes ${SLIDE_NS}><p:cSld><p:spTree>` +
    '<p:sp><p:nvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:txBody>' +
    paragraphs.map((p) => `<a:p>${p}</a:p>`).join('') +
    '</p:txBody></p:sp></p:spTree></p:cSld></p:notes>'
  )
}

async function deck(slide: string, notes?: string): Promise<Uint8Array> {
  const zip = new JSZip()
  zip.file('ppt/slides/slide1.xml', slide)
  if (notes) {
    zip.file(
      'ppt/slides/_rels/slide1.xml.rels',
      `${XML_DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide1.xml"/>' +
        '</Relationships>',
    )
    zip.file('ppt/notesSlides/notesSlide1.xml', notes)
  }
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
}

const P188 = 'http://schemas.microsoft.com/office/powerpoint/2018/8/main'
const MODERN_COMMENTS_REL = 'http://schemas.microsoft.com/office/2018/10/relationships/comments'

/** a one-comment, one-paragraph Office 365 comment thread on slide 1 */
async function deckWithComment(paragraph: string): Promise<Uint8Array> {
  const zip = new JSZip()
  zip.file('ppt/slides/slide1.xml', slideXml([run('Title')]))
  zip.file(
    'ppt/slides/_rels/slide1.xml.rels',
    `${XML_DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId9" Type="${MODERN_COMMENTS_REL}" Target="../comments/comment1.xml"/>` +
      '</Relationships>',
  )
  zip.file(
    'ppt/comments/comment1.xml',
    `${XML_DECL}<p188:cmLst xmlns:p188="${P188}" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">` +
      '<p188:cm authorId="a1" created="2026-01-01T00:00:00Z">' +
      `<p188:txBody><a:p>${paragraph}</a:p></p188:txBody>` +
      '</p188:cm></p188:cmLst>',
  )
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
}

let fixtureSeq = 0
async function readDeck(slide: string, notes?: string) {
  return parseFileToText(writeFixture(`withheld-${++fixtureSeq}.pptx`, await deck(slide, notes)))
}

async function readDeckWithComment(paragraph: string) {
  return parseFileToText(
    writeFixture(`withheld-comment-${++fixtureSeq}.pptx`, await deckWithComment(paragraph)),
  )
}

function readText(name: string, content: string) {
  return parseFileToText(writeFixture(`${++fixtureSeq}-${name}`, content))
}

/** the read failed, and nothing of the result carries the words */
function expectClosedFailure(result: Awaited<ReturnType<typeof parseFileToText>>, secret = SECRET) {
  expect(result.ok).toBe(false)
  expect(result.text).toBeUndefined()
  expect(result.error).toMatch(/redaction/i)
  expect(JSON.stringify(result)).not.toContain(secret)
}

describe('pptx: a withheld run reads as its marker', () => {
  it('uses the extension id the deck engine writes', () => {
    expect(PPTX_REDACT_EXT_URI).toBe(REDACT_EXT_URI)
  })

  it('swaps the run on a slide and keeps the words around it', async () => {
    const result = await readDeck(
      slideXml([run('please call ') + withheldRun(SECRET) + run(' to confirm'), run('Agenda')]),
    )
    expect(result).toEqual({
      ok: true,
      kind: 'text',
      text: `## Slide 1\nplease call ${MARKER} to confirm\nAgenda`,
    })
  })

  it('swaps the run in the speaker notes too', async () => {
    const result = await readDeck(
      slideXml([run('Visible title')]),
      notesXml([run('remember ') + withheldRun(SECRET) + run(' before the call')]),
    )
    expect(result.ok).toBe(true)
    expect(result.text).toBe(
      `## Slide 1\nVisible title\n### Notes\nremember ${MARKER} before the call`,
    )
    expect(result.text).not.toContain(SECRET)
  })

  it('reads a mark written through a self-closing rPr', async () => {
    const result = await readDeck(slideXml([withheldRun(SECRET, LABEL, RPR_SELF)]))
    expect(result.text).toBe(`## Slide 1\n${MARKER}`)
  })

  it('withholds a field the same way as a run', async () => {
    const field =
      `<a:fld id="{F}" type="datetime1">${setRedactExt(RPR, 'signing date')}` +
      '<a:t>2026-03-04</a:t></a:fld>'
    const result = await readDeck(slideXml([run('Signed on ') + field]))
    expect(result.text).toBe('## Slide 1\nSigned on {{signing date}}')
  })

  it('cleans the label the way the editor does, and keeps an ampersand readable', async () => {
    const result = await readDeck(slideXml([withheldRun(SECRET, 'R&D <budget> "2026"')]))
    expect(result.text).toBe('## Slide 1\n{{R&D budget 2026}}')
  })

  it('leaves nothing of a withheld run behind, whatever else the run carries', async () => {
    // a second text element inside the run would be read by the paragraph walker
    const marked = setRedactExt(RPR, LABEL)
    const result = await readDeck(
      slideXml([`<a:r>${marked}<a:t>${SECRET}</a:t><a:t>${SECRET}</a:t></a:r>`]),
    )
    expect(result.text).toBe(`## Slide 1\n${MARKER}`)
  })

  it('keeps every span when a slide withholds several', async () => {
    const result = await readDeck(
      slideXml([
        withheldRun('Jane Roe', 'client name') + run(' / ') + withheldRun(SECRET),
        withheldRun('ACME-7781', 'contract no'),
      ]),
    )
    expect(result.text).toBe(`## Slide 1\n{{client name}} / ${MARKER}\n{{contract no}}`)
  })

  it('reads a deck with a withheld picture, and still reports the picture', async () => {
    const pic =
      '<p:pic><p:nvPicPr><p:cNvPr id="4" name="Picture 3" descr="passport scan"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>' +
      '<p:blipFill><a:blip r:embed="rId2"/></p:blipFill>' +
      setRedactExt('<p:spPr><a:xfrm/></p:spPr>', 'passport') +
      '</p:pic>'
    const xml = `${XML_DECL}<p:sld ${SLIDE_NS}><p:cSld><p:spTree>${pic}</p:spTree></p:cSld></p:sld>`
    const result = await readDeck(xml)
    expect(result.ok).toBe(true)
    expect(result.text).toContain('picture-only slide: 1 image')
    expect(result.text).not.toContain('passport scan')
  })

  it('reads a deck whose empty paragraph carries the mark on its paragraph properties', async () => {
    // the engine reads <a:endParaRPr> as an empty run; there are no words to withhold
    const endPara = setRedactExt('<a:endParaRPr lang="en-US"/>', LABEL)
    const result = await readDeck(slideXml([run('Agenda'), endPara]))
    expect(result).toEqual({ ok: true, kind: 'text', text: '## Slide 1\nAgenda' })
  })

  it('leaves a deck with no marks exactly as it read before', async () => {
    const result = await readDeck(slideXml([run('Product') + run('Intro')]))
    expect(result.text).toBe('## Slide 1\nProductIntro')
  })

  it('swaps the run inside a comment thread and keeps the words around it', async () => {
    const result = await readDeckWithComment(
      run('please call ') + withheldRun(SECRET) + run(' to confirm'),
    )
    expect(result).toEqual({
      ok: true,
      kind: 'text',
      text:
        '## Slide 1\nTitle\n### Comments\n' +
        `- Unknown author (2026-01-01T00:00:00Z): please call ${MARKER} to confirm`,
    })
  })
})

describe('pptx: a mark that cannot be processed fails the read', () => {
  const ext = (inner: string, uri = REDACT_EXT_URI) =>
    `<a:extLst><a:ext uri="${uri}" xmlns:go="${REDACT_NS_WRITTEN}">${inner}</a:ext></a:extLst>`
  const broken: Array<[string, string]> = [
    ['an extension with no label element', run(SECRET, `<a:rPr>${ext('')}</a:rPr>`)],
    ['an empty label', run(SECRET, `<a:rPr>${ext(`<${REDACT_EL} label=""/>`)}</a:rPr>`)],
    ['a label element with no label', run(SECRET, `<a:rPr>${ext(`<${REDACT_EL}/>`)}</a:rPr>`)],
    [
      'the label under an extension that is not ours',
      run(SECRET, `<a:rPr>${ext(`<${REDACT_EL} label="x"/>`, '{SOMEONE-ELSE}')}</a:rPr>`),
    ],
    [
      'the mark outside the run properties',
      `<a:pPr>${ext(`<${REDACT_EL} label="x"/>`)}</a:pPr>${run(SECRET)}`,
    ],
    [
      'the namespace bound to another prefix',
      run(
        SECRET,
        `<a:rPr><a:extLst><a:ext uri="{OTHER}" xmlns:x="${REDACT_NS_WRITTEN}"><x:redact label="x"/></a:ext></a:extLst></a:rPr>`,
      ),
    ],
    [
      'markup that does not close',
      `<a:r>${setRedactExt(RPR, LABEL).replace('</a:extLst>', '')}<a:t>${SECRET}</a:t></a:r>`,
    ],
  ]

  for (const [name, paragraph] of broken) {
    it(`${name} on a slide`, async () => {
      expectClosedFailure(await readDeck(slideXml([run('before ') + paragraph])))
    })
    it(`${name} in the notes`, async () => {
      expectClosedFailure(await readDeck(slideXml([run('Title')]), notesXml([paragraph])))
    })
  }

  it('a mark on a shape that is not a picture', async () => {
    const shape =
      '<p:sp>' +
      setRedactExt('<p:spPr><a:xfrm/></p:spPr>', LABEL) +
      `<p:txBody><a:p>${run(SECRET)}</a:p></p:txBody></p:sp>`
    expectClosedFailure(await readDeck(slideXml([run('Title')], shape)))
  })

  it('a marked run inside another marked run', async () => {
    // not valid DrawingML; rewriting both would leave the inner words in the part
    const marked = setRedactExt(RPR, LABEL)
    const nested =
      `<a:r>${marked}<a:t>outer</a:t>` + `<a:r>${marked}<a:t>${SECRET}</a:t></a:r>` + `</a:r>`
    expectClosedFailure(await readDeck(slideXml([run('before ') + nested])))
    expectClosedFailure(await readDeck(slideXml([run('Title')]), notesXml([nested])))
  })

  it('throws from pptxToText itself, which has no result object to fail with', async () => {
    const bytes = await deck(slideXml([run(SECRET, `<a:rPr>${ext('')}</a:rPr>`)]))
    await expect(pptxToText(bytes)).rejects.toThrow(/redaction/i)
  })

  it('a mark inside a comment thread, which reads the part the same way as a slide', async () => {
    expectClosedFailure(await readDeckWithComment(run(SECRET, `<a:rPr>${ext('')}</a:rPr>`)))
  })
})

describe('markdown: a withheld span reads as its marker', () => {
  const span = (text: string, label = LABEL) =>
    `<span class="redact-span" data-redaction="" data-label="${label}">${text}</span>`

  it('replaces the whole span, tags included', async () => {
    const result = await readText('note.md', `please call ${span(SECRET)} confirm the order`)
    expect(result).toEqual({
      ok: true,
      kind: 'text',
      text: `please call ${MARKER} confirm the order`,
    })
  })

  it('does the same for the .markdown extension', async () => {
    const result = await readText('note.markdown', `# Title\n\n${span(SECRET)}\n`)
    expect(result.text).toBe(`# Title\n\n${MARKER}\n`)
  })

  it('replaces every span and leaves the rest of the file byte for byte', async () => {
    const md = `# Plan\r\n\r\n- ${span('Jane Roe', 'client name')} at ${span(SECRET)}\r\n- **bold** stays\r\n`
    const result = await readText('plan.md', md)
    expect(result.text).toBe(`# Plan\r\n\r\n- {{client name}} at ${MARKER}\r\n- **bold** stays\r\n`)
  })

  it('falls back to the default label, and reads a single-quoted one', () => {
    expect(redactMarkdownSource(`a <span data-redaction>${SECRET}</span> b`)).toBe(
      'a {{private}} b',
    )
    expect(
      redactMarkdownSource(`a <SPAN data-label='pin' DATA-REDACTION="">${SECRET}</SPAN> b`),
    ).toBe('a {{pin}} b')
  })

  it('withholds the escaped markup a span carries', () => {
    const out = redactMarkdownSource(span('&lt;b&gt;4111 1111&lt;/b&gt;', 'card'))
    expect(out).toBe('{{card}}')
  })

  it('leaves a markdown file with no marks verbatim', async () => {
    const md = '# Title\n\nBody with a <span class="x">plain span</span>\n'
    expect((await readText('plain.md', md)).text).toBe(md)
  })

  it('reads a markdown document saved under .txt or .json the same way', async () => {
    // the markdown editor opens all four extensions and its Save As writes the
    // same text, withheld spans included, whichever one is picked
    const doc = `call ${span(SECRET, 'phone')} now`
    for (const name of ['a.md', 'a.markdown', 'a.txt', 'a.json']) {
      const result = await readText(name, doc)
      expect(result, name).toEqual({ ok: true, kind: 'text', text: 'call {{phone}} now' })
    }
  })

  it('keeps what the editor writes inside a span: escapes, emphasis, a link, a price', () => {
    const inside = [
      'plain **bold part** and *it* tail',
      'a [link text](http://x.y/z_q) b',
      'price $5,000 and 2\\*3 a\\_b [TODO]',
      'x\\~y back\\\\slash end',
      'don\'t (really) "quote" &lt;b&gt;',
    ]
    for (const text of inside) {
      expect(redactMarkdownSource(`before ${span(text)} after`), text).toBe(
        `before ${MARKER} after`,
      )
    }
  })

  it('fails the read when a span never closes', async () => {
    const md = `call <span class="redact-span" data-redaction="" data-label="${LABEL}">${SECRET} soon`
    expectClosedFailure(await readText('open.md', md))
    expect(() => redactMarkdownSource(md)).toThrow(/redaction/i)
  })

  it('fails the read when a mark is left that it did not understand', async () => {
    // a ">" inside an attribute ends the tag early for the editor's own pattern
    const md = `call <span title="a>b" data-redaction="" data-label="${LABEL}">${SECRET}</span>`
    expectClosedFailure(await readText('odd.md', md))
  })
})

describe('markdown: where a span closes is never guessed', () => {
  const O = '<span class="redact-span" data-redaction="" data-label="k">'

  /**
   * The editor closes a span at the next inline `</span` *token*, or by DOM
   * nesting inside an HTML block. A raw `</span>` that is not that token (it sits
   * in code, in a comment, in a link, in another tag, behind a backslash) must
   * not end the span here either: every one of these either hides at least what
   * the editor hides or fails the read.
   */
  const EARLY_CLOSE: Array<[string, string]> = [
    ['in a code span', `before ${O} see \`</span>\` then ${SECRET}</span> after`],
    ['behind a backslash', `before ${O} see \\</span> then ${SECRET}</span> after`],
    ['in a comment', `before ${O} see <!-- </span> --> then ${SECRET}</span> after`],
    ['in a link destination', `before ${O} see [x](</span>) then ${SECRET}</span> after`],
    ['after a nested span in an HTML block', `<div>${O} a <span>x</span> ${SECRET}</span></div>`],
    [
      'in an attribute inside an HTML block',
      `<div>${O} a <img alt="</span>"> ${SECRET}</span></div>`,
    ],
    ['inside emphasis that ends later', `before ${O} a *b </span> c* ${SECRET}</span> after`],
    ['inside strikethrough that ends later', `before ${O} a ~~b </span> c~~ ${SECRET}</span> x`],
    ['inside a link label', `before ${O} [see </span> x](http://u) ${SECRET}</span> after`],
    ['inside a link title', `before ${O} [a](u "t </span> x") ${SECRET}</span> after`],
    ['inside a formula', `before ${O} $a </span> b$ ${SECRET}</span> after`],
    ['as a tag that is not a plain closing tag', `before ${O} a</span foo> ${SECRET}</span> end`],
    [
      'inside an attribute of the opening tag itself',
      `before <span data-redaction="" data-label="k" title="a>b </span> ${SECRET}">x</span> end`,
    ],
    [
      'when the opening tag sits in an attribute of another tag',
      `before <a title='${O}' href="x </span> ${SECRET}">y</a> tail</span> end`,
    ],
    [
      'when the opening tag sits in a comment',
      `before <!-- ${O} x </span> --> ${SECRET}</span> end`,
    ],
  ]

  for (const [name, md] of EARLY_CLOSE) {
    it(name, async () => {
      for (const file of ['early.md', 'early.txt', 'early.json']) {
        const result = await readText(file, md)
        if (result.ok) expect(result.text, file).not.toContain(SECRET)
        else expectClosedFailure(result)
      }
    })
  }

  it('fails every one of the six inputs from the review rather than guess', () => {
    for (const [, md] of EARLY_CLOSE.slice(0, 6)) {
      expect(() => redactMarkdownSource(md), md).toThrow(/redaction/i)
    }
  })

  it('still closes at the tag when nothing after the span could end a construct', () => {
    // an unmatched delimiter inside the span cannot swallow the closing tag
    // unless something later in the paragraph closes it
    expect(redactMarkdownSource(`a ${O}2*3 [x $5 a_ b~</span> plain tail\n\nnext *p*`)).toBe(
      'a {{k}} plain tail\n\nnext *p*',
    )
    expect(() => redactMarkdownSource(`a ${O}2*3</span> then *this* closes it`)).toThrow(
      /redaction/i,
    )
  })

  it('hides to the closing tag when a paragraph break comes first (more than the editor)', () => {
    expect(redactMarkdownSource(`a ${O}${SECRET}\n\nnext para</span> after`)).toBe('a {{k}} after')
  })

  it('reads a span inside an HTML block, where nothing nests', () => {
    expect(redactMarkdownSource(`<div>${O} ${SECRET}</span> tail</div>`)).toBe(
      '<div>{{k}} tail</div>',
    )
  })
})

describe('markdown: only something that could be a mark fails the read', () => {
  const PROSE = [
    'The attribute data-redaction marks a withheld span.',
    'Search the page for `data-redaction` and DATA-REDACTION to find them.',
    '<span class="note">A plain span.</span> Later the text mentions data-redaction in passing.',
    '{"keys": ["data-redaction", "data-label"], "html": "<span class=\\"x\\">y</span>"}',
    '{"html": "<span class=\\"x\\">y</span>", "note": "see data-redaction"}',
    'a < b and c > d, so data-redaction > nothing',
  ]

  for (const text of PROSE) {
    it(`reads ${JSON.stringify(text.slice(0, 40))}… as written`, async () => {
      for (const name of ['prose.md', 'prose.txt', 'prose.json']) {
        expect(await readText(name, text), name).toEqual({ ok: true, kind: 'text', text })
      }
    })
  }

  const UNREAD: Array<[string, string]> = [
    [
      'the attribute after a quoted ">" (an HTML block reads it as a mark)',
      `<div><span title="a>b" data-redaction="" data-label="k">${SECRET}</span></div>`,
    ],
    [
      'the attribute after a quoted value that runs over several lines',
      `<pre><span title="a>\n\n b" data-redaction>${SECRET}</span></pre>`,
    ],
    [
      'the attribute after a quoted value that holds a whole withheld span',
      `<div><span title='<span data-redaction="">x</span> y' data-redaction>${SECRET}</span></div>`,
    ],
    ['an opening tag that never ends', `text <span data-redaction ${SECRET}`],
  ]

  for (const [name, text] of UNREAD) {
    it(`fails for ${name}`, async () => {
      for (const file of ['unread.md', 'unread.txt', 'unread.json']) {
        expectClosedFailure(await readText(file, text))
      }
    })
  }
})

describe('html: each kind of mark reads as its marker', () => {
  const API = 'API key'
  const KEY = 'sk-ABC123'
  const API_MARKER = `{{${API}}}`

  it('withholds the content of a marked element and keeps the wrapper', async () => {
    const html = `<p>Call <span data-gx-redact="${LABEL}">${SECRET}</span> now</p>`
    const result = await readText('page.html', html)
    expect(result).toEqual({
      ok: true,
      kind: 'text',
      text: `<p>Call <span data-gx-redact="${LABEL}">${MARKER}</span> now</p>`,
    })
  })

  it('withholds only the marked attribute value', async () => {
    const html = `<img src="https://cdn.example.com/logo.png" alt="company logo" data-gx-redact-src="${API}">`
    const result = await readText('attr.htm', html)
    expect(result.text).toBe(
      `<img src="${API_MARKER}" alt="company logo" data-gx-redact-src="${API}">`,
    )
  })

  it('reads single-quoted and unquoted attribute values', () => {
    expect(redactHtmlSource(`<img src='secret.png' alt='logo' data-gx-redact-src='brand'>`)).toBe(
      `<img src='{{brand}}' alt='logo' data-gx-redact-src='brand'>`,
    )
    expect(redactHtmlSource('<img src=secret.png alt=logo data-gx-redact-src=brand>')).toBe(
      '<img src={{brand}} alt=logo data-gx-redact-src=brand>',
    )
  })

  it('does not withhold an unmarked attribute whose value names a marked one', () => {
    const out = redactHtmlSource(
      '<img src="secret.png" alt="src= not this" data-gx-redact-src="logo">',
    )
    expect(out).toContain('src= not this')
    expect(out).not.toContain('secret.png')
  })

  it('withholds the string literal a script comment stands in front of', async () => {
    const html = `<script>const KEY = /*gx:redact:${API}*/ "${KEY}"; render(KEY);</script>`
    const result = await readText('script.html', html)
    expect(result.text).toBe(
      `<script>const KEY = /*gx:redact:${API}*/ "${API_MARKER}"; render(KEY);</script>`,
    )
  })

  it('withholds a single-quoted script literal', () => {
    const out = redactHtmlSource(`<script>const K = /*gx:redact:${API}*/ '${KEY}';</script>`)
    expect(out).not.toContain(KEY)
    expect(out).toContain(API_MARKER)
  })

  it('handles the three kinds in one page, and an element inside a withheld one once', async () => {
    const html = [
      '<!doctype html><html><head>',
      `<meta name="token" content="tok-999" data-gx-redact-content="token">`,
      `<script>const K = /*gx:redact:${API}*/ "${KEY}";</script>`,
      '</head><body>',
      `<div data-gx-redact="address"><p>1 Main St</p><span data-gx-redact="zip">02139</span></div>`,
      '<p>public</p></body></html>',
    ].join('\n')
    const result = await readText('all.html', html)
    expect(result.ok).toBe(true)
    for (const hidden of ['tok-999', KEY, '1 Main St', '02139']) {
      expect(result.text).not.toContain(hidden)
    }
    expect(result.text).toContain('content="{{token}}"')
    expect(result.text).toContain(`"${API_MARKER}"`)
    expect(result.text).toContain('<div data-gx-redact="address">{{address}}</div>')
    expect(result.text).toContain('<p>public</p>')
  })

  it('strips what a comment carrier cannot hold from the label, as the editor does', () => {
    expect(redactHtmlSource('<b data-gx-redact="a*/b">x</b>')).toBe(
      '<b data-gx-redact="a*/b">{{ab}}</b>',
    )
  })

  it('leaves a page with nothing withheld verbatim', () => {
    const html = '<p>Hello</p><img src="logo.png">'
    expect(redactHtmlSource(html)).toBe(html)
  })

  it('honours a script mark only inside a real script', () => {
    const html = `<p>literal /*gx:redact:${API}*/ "${KEY}" in a paragraph</p>`
    expect(redactHtmlSource(html)).toBe(html)
  })

  it('ignores a mark for an attribute the element does not have', () => {
    const html = `<img src="a.png" data-gx-redact-href="${API}">`
    expect(redactHtmlSource(html)).toBe(html)
  })
})

describe('html: a mark that cannot be processed fails the read', () => {
  it('an element mark written without a value', async () => {
    expectClosedFailure(
      await readText('valueless.html', `<p>Call <span data-gx-redact>${SECRET}</span></p>`),
    )
  })

  it('an element mark the editor would not match by case', async () => {
    expectClosedFailure(
      await readText('case.html', `<p>Call <span DATA-GX-REDACT="${LABEL}">${SECRET}</span></p>`),
    )
  })

  it('an attribute mark whose attribute is there but was not reached', async () => {
    expectClosedFailure(
      await readText('attr-case.html', `<img SRC="${SECRET}.png" data-gx-redact-src="logo">`),
    )
    expectClosedFailure(
      await readText('attr-mark-case.html', `<img src="${SECRET}.png" data-gx-redact-SRC="logo">`),
    )
  })

  it('a script mark with no string literal after it', async () => {
    expectClosedFailure(
      await readText(
        'script-number.html',
        `<script>const PIN = /*gx:redact:pin*/ ${SECRET};</script>`,
      ),
    )
  })

  it('a script mark whose next literal is outside the script', async () => {
    expectClosedFailure(
      await readText(
        'script-outside.html',
        `<script>const PIN = /*gx:redact:pin*/ ${SECRET};</script><p class="x">y</p>`,
      ),
    )
  })

  it('throws from redactHtmlSource itself, for a caller that reads the file on its own', () => {
    expect(() => redactHtmlSource(`<span data-gx-redact>${SECRET}</span>`)).toThrow(/redaction/i)
  })
})

const SHEET_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const REDACTION_PART = 'xl/gxRedactions.json'

interface BookSheet {
  name: string
  /** the `<row>` elements of the sheet */
  rows: string
}

interface BookMarks {
  /** the part's text, written verbatim (a damaged part is a string too) */
  part?: string
  /** the marks copied into the workbook's defined names */
  mirror?: readonly SheetRedactionState[]
  /** raw `<definedName>` elements, for a copy no save would write */
  definedNames?: string
  sharedStrings?: string
}

const inline = (ref: string, text: string) =>
  `<c r="${ref}" t="inlineStr"><is><t>${text}</t></is></c>`

/** `B2` and friends as a mark's zero-based rectangle */
function mark(from: string, to = from, label = LABEL): RedactionMark {
  const at = (ref: string) => ({
    column: ref.charCodeAt(0) - 65,
    row: Number(ref.slice(1)) - 1,
  })
  return {
    startRow: at(from).row,
    startColumn: at(from).column,
    endRow: at(to).row,
    endColumn: at(to).column,
    label,
  }
}

async function book(sheets: readonly BookSheet[], marks: BookMarks = {}): Promise<Uint8Array> {
  const zip = new JSZip()
  let workbookXml =
    `${XML_DECL}<workbook xmlns="${SHEET_NS}" xmlns:r="${REL_NS}"><sheets>` +
    sheets
      .map((s, i) => `<sheet name="${s.name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
      .join('') +
    '</sheets>' +
    (marks.definedNames ? `<definedNames>${marks.definedNames}</definedNames>` : '') +
    '</workbook>'
  if (marks.mirror) {
    workbookXml = applyRedactionNameMirror(
      workbookXml,
      marks.mirror,
      sheets.map((s) => s.name),
    )
  }
  zip.file('xl/workbook.xml', workbookXml)
  zip.file(
    'xl/_rels/workbook.xml.rels',
    `${XML_DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      sheets
        .map(
          (_, i) =>
            `<Relationship Id="rId${i + 1}" Type="${REL_NS}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
        )
        .join('') +
      `<Relationship Id="rId90" Type="${REL_NS}/sharedStrings" Target="sharedStrings.xml"/>` +
      '</Relationships>',
  )
  zip.file(
    '[Content_Types].xml',
    `${XML_DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '</Types>',
  )
  zip.file(
    'xl/sharedStrings.xml',
    `${XML_DECL}<sst xmlns="${SHEET_NS}">${marks.sharedStrings ?? ''}</sst>`,
  )
  sheets.forEach((s, i) =>
    zip.file(
      `xl/worksheets/sheet${i + 1}.xml`,
      `${XML_DECL}<worksheet xmlns="${SHEET_NS}"><sheetData>${s.rows}</sheetData></worksheet>`,
    ),
  )
  if (marks.part !== undefined) zip.file(REDACTION_PART, marks.part)
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
}

/** a workbook as a save leaves it: the part, and the same marks in the defined names */
function savedBook(sheets: readonly BookSheet[], states: readonly SheetRedactionState[]) {
  return book(sheets, { part: serializeRedactionPart(states), mirror: states })
}

async function readBook(bytes: Uint8Array | Promise<Uint8Array>) {
  return parseFileToText(writeFixture(`withheld-${++fixtureSeq}.xlsx`, await bytes))
}

const CLIENTS: BookSheet = {
  name: 'Clients',
  rows:
    `<row r="1">${inline('A1', 'Name')}${inline('B1', 'Phone')}</row>` +
    `<row r="2">${inline('A2', 'Kim')}<c r="B2"><v>${SECRET}</v></c></row>`,
}

describe('xlsx: a withheld cell reads as its marker', () => {
  it('replaces the one cell and leaves its neighbours', async () => {
    const result = await readBook(
      savedBook([CLIENTS], [{ sheetName: 'Clients', marks: [mark('B2')] }]),
    )
    expect(result).toEqual({
      ok: true,
      kind: 'text',
      text: `# Clients\nName | Phone\nKim | ${MARKER}`,
    })
  })

  it('covers every cell of a range, whatever holds the value', async () => {
    const sheet: BookSheet = {
      name: 'Clients',
      rows:
        `<row r="1">${inline('A1', 'Name')}${inline('B1', 'Phone')}</row>` +
        // a number, a shared string, an inline string, a formula with its
        // cached result, a formula nothing has calculated yet, an empty cell
        `<row r="2">${inline('A2', 'Kim')}<c r="B2"><v>${SECRET}</v></c></row>` +
        `<row r="3">${inline('A3', 'Lee')}<c r="B3" t="s"><v>0</v></c></row>` +
        `<row r="4">${inline('A4', 'Park')}${inline('B4', SECRET)}</row>` +
        `<row r="5">${inline('A5', 'Choi')}<c r="B5" t="str"><f>"138"&amp;"00138000"</f><v>${SECRET}</v></c></row>` +
        `<row r="6">${inline('A6', 'Jung')}<c r="B6"><f>${SECRET}+0</f></c></row>` +
        `<row r="7">${inline('A7', 'Han')}<c r="B7"/></row>` +
        `<row r="8">${inline('A8', 'Total')}<c r="B8"><v>6</v></c></row>`,
    }
    const bytes = await book([sheet], {
      part: serializeRedactionPart([{ sheetName: 'Clients', marks: [mark('B2', 'B7')] }]),
      sharedStrings: `<si><t>${SECRET}</t></si>`,
    })
    const text = await xlsxToText(bytes)
    expect(text).toBe(
      '# Clients\nName | Phone\n' +
        ['Kim', 'Lee', 'Park', 'Choi', 'Jung', 'Han'].map((n) => `${n} | ${MARKER}`).join('\n') +
        '\nTotal | 6',
    )
    expect(text).not.toContain('138')
  })

  it('keeps two marks on one sheet under their own names', async () => {
    const result = await readBook(
      savedBook(
        [CLIENTS],
        [{ sheetName: 'Clients', marks: [mark('B2'), mark('A2', 'A2', 'client name')] }],
      ),
    )
    expect(result.text).toBe(`# Clients\nName | Phone\n{{client name}} | ${MARKER}`)
  })

  it('follows a sheet the editor renamed, and only that sheet', async () => {
    const states = rekeyRedactionStates(
      [{ sheetName: 'Clients', marks: [mark('B2')] }],
      [{ sheetName: 'Clients', newName: 'Customers' }],
      [],
    )
    const other: BookSheet = { name: 'Stock', rows: CLIENTS.rows.replace(SECRET, '42') }
    const result = await readBook(savedBook([other, { ...CLIENTS, name: 'Customers' }], states))
    expect(result.text).toBe(
      `# Stock\nName | Phone\nKim | 42\n\n# Customers\nName | Phone\nKim | ${MARKER}`,
    )
  })

  it('reads the marks from the defined names when another program dropped the part', async () => {
    const result = await readBook(
      book([CLIENTS], { mirror: [{ sheetName: 'Clients', marks: [mark('B2')] }] }),
    )
    expect(result.text).toBe(`# Clients\nName | Phone\nKim | ${MARKER}`)
  })

  it('falls back to the defined names when the part is damaged, as the editor does', async () => {
    const result = await readBook(
      book([CLIENTS], {
        part: '{"version":1,"sheets":[',
        mirror: [{ sheetName: 'Clients', marks: [mark('B2')] }],
      }),
    )
    expect(result.text).toBe(`# Clients\nName | Phone\nKim | ${MARKER}`)
  })

  it('writes the label the way the sheet editor shows it to its own model', async () => {
    const result = await readBook(
      savedBook(
        [CLIENTS],
        [{ sheetName: 'Clients', marks: [mark('B2', 'B2', 'client*/{phone}')] }],
      ),
    )
    expect(result.text).toBe('# Clients\nName | Phone\nKim | {{clientphone}}')
  })

  it('withholds a cell it cannot place on a sheet that has marks', async () => {
    const loose: BookSheet = {
      name: 'Clients',
      rows: `<row r="1">${inline('A1', 'Name')}</row><row r="2">${inline('A2', 'Kim')}<c><v>${SECRET}</v></c></row>`,
    }
    const plain: BookSheet = { name: 'Plain', rows: '<row r="1"><c><v>7</v></c></row>' }
    const result = await readBook(
      savedBook([loose, plain], [{ sheetName: 'Clients', marks: [mark('D9')] }]),
    )
    expect(result.text).toBe('# Clients\nName\nKim | {{private}}\n\n# Plain\n7')
  })

  it('reads a text-parts copy of a large workbook the same way', async () => {
    const bytes = await savedBook([CLIENTS], [{ sheetName: 'Clients', marks: [mark('B2')] }])
    const result = await parseFileToText(writeFixture(`withheld-${++fixtureSeq}.xlsx`, bytes), {
      wholeZipMaxBytes: 1,
    })
    expect(result.text).toBe(`# Clients\nName | Phone\nKim | ${MARKER}`)
  })

  it('finds the marks of a sheet whose name starts and ends with a space', async () => {
    // the spaces are part of the name: the editor keys the marks by it as written
    const spaced: BookSheet = { ...CLIENTS, name: ' Data ' }
    const text = await xlsxToText(
      await savedBook([spaced, STOCK], [{ sheetName: ' Data ', marks: [mark('B2')] }]),
    )
    expect(text).toBe(`#  Data \nName | Phone\nKim | ${MARKER}\n\n# Stock\nItem`)
  })

  it('reads a workbook with no marks as before', async () => {
    const names = '<definedName name="Phones">Clients!$B$2:$B$9</definedName>'
    for (const bytes of [book([CLIENTS]), book([CLIENTS], { definedNames: names })]) {
      expect((await readBook(bytes)).text).toBe(`# Clients\nName | Phone\nKim | ${SECRET}`)
    }
  })
})

describe('xlsx: the withheld cells a reader outside this package asks about', () => {
  it('answers each cell, and nothing for a workbook that withholds nothing', async () => {
    const withheld = await xlsxWithheldCells(
      await savedBook([CLIENTS], [{ sheetName: 'Clients', marks: [mark('B2')] }]),
    )
    expect(withheld?.('Clients', 'B2', false)).toBe(MARKER)
    expect(withheld?.('Clients', 'A2', false)).toBeNull()
    expect(await xlsxWithheldCells(await book([CLIENTS]))).toBeNull()
  })

  it('still answers after many other workbooks were opened since', async () => {
    const first = await xlsxWithheldCells(
      await savedBook([CLIENTS], [{ sheetName: 'Clients', marks: [mark('B2')] }]),
    )
    for (let i = 0; i < 8; i++) {
      const other = await xlsxWithheldCells(
        await savedBook([CLIENTS], [{ sheetName: 'Clients', marks: [mark('A2')] }]),
      )
      expect(other?.('Clients', 'A2', false)).toBe(MARKER)
    }
    expect(first?.('Clients', 'B2', false)).toBe(MARKER)
    expect(first?.('Clients', 'A2', false)).toBeNull()
  })
})

describe('xlsx: marks that cannot be processed fail the read', () => {
  const damaged: Array<[string, string]> = [
    ['is not JSON', '{"version":1,"sheets":['],
    ['has a version this reader does not know', '{"version":2,"sheets":[]}'],
    [
      'holds a mark with no label',
      '{"version":1,"sheets":[{"name":"Clients","marks":[{"startRow":1,"endRow":1,"startColumn":1,"endColumn":1}]}]}',
    ],
    [
      'holds a mark with no rectangle',
      `{"version":1,"sheets":[{"name":"Clients","marks":[{"label":"${LABEL}"}]}]}`,
    ],
  ]
  it.each(damaged)('a part that %s', async (_name, part) => {
    expectClosedFailure(await readBook(book([CLIENTS], { part })))
  })

  it('a part naming a sheet the workbook does not have', async () => {
    // renamed in another program: the part still says "Clients"
    const part = serializeRedactionPart([{ sheetName: 'Clients', marks: [mark('B2')] }])
    expectClosedFailure(await readBook(book([{ ...CLIENTS, name: 'Customers' }], { part })))
  })

  it('a defined-name copy that cannot be read, with no part beside it', async () => {
    const definedNames = '<definedName name="_gxRedaction_1" hidden="1">"not a mark"</definedName>'
    expectClosedFailure(await readBook(book([CLIENTS], { definedNames })))
  })

  it('a defined-name copy pointing past the last sheet', async () => {
    const mirrored = applyRedactionNameMirror(
      '<workbook><sheets/></workbook>',
      [{ sheetName: 'Second', marks: [mark('B2')] }],
      ['First', 'Second'],
    )
    const definedNames = /<definedNames>([\s\S]*)<\/definedNames>/.exec(mirrored)?.[1] ?? ''
    expect(definedNames).toContain('_gxRedaction_1')
    expectClosedFailure(await readBook(book([CLIENTS], { definedNames })))
  })

  it('throws from xlsxToText itself, for a caller that reads the file on its own', async () => {
    await expect(xlsxToText(await book([CLIENTS], { part: 'x' }))).rejects.toThrow(/redaction/i)
  })
})

interface GatewaySave {
  plan?: SheetEditPlan
  ops?: readonly SheetStructuralOps[]
  /** the marks the caller knows, or null when it never read them */
  states: readonly SheetRedactionState[] | null
}

/** the file a save through the workbook gateway writes over `source` */
async function gatewaySave(source: Promise<Uint8Array>, save: GatewaySave): Promise<Uint8Array> {
  const saved = await applyCellEditsToXlsx(
    Buffer.from(await source),
    [],
    save.ops ?? [],
    [],
    save.plan,
    [],
    [],
    [],
    [],
    [],
    null,
    [],
    [],
    [],
    save.states,
  )
  return saved.buffer
}

const STOCK: BookSheet = { name: 'Stock', rows: `<row r="1">${inline('A1', 'Item')}</row>` }
const CLIENT_MARKS: readonly SheetRedactionState[] = [{ sheetName: 'Clients', marks: [mark('B2')] }]
const WITHHELD_CLIENTS = `Name | Phone\nKim | ${MARKER}`

describe('xlsx: a sheet duplicated by a save keeps its cells withheld', () => {
  const copyOfClients = (name: string) => ({ name, sourceSheetName: 'Clients' })

  it('reads the copy of a withheld cell as its marker', async () => {
    const saved = await gatewaySave(savedBook([CLIENTS, STOCK], CLIENT_MARKS), {
      plan: {
        renames: [],
        removals: [],
        additions: [copyOfClients('Clients (2)')],
        order: ['Clients', 'Stock', 'Clients (2)'],
      },
      states: CLIENT_MARKS,
    })
    expect(await xlsxToText(saved)).toBe(
      `# Clients\n${WITHHELD_CLIENTS}\n\n# Stock\nItem\n\n# Clients (2)\n${WITHHELD_CLIENTS}`,
    )
  })

  it('follows the rows and columns each of two copies went through', async () => {
    // a copy of a copy is saved as two copies of the file's sheet, each with
    // the row and column edits made on it
    const saved = await gatewaySave(savedBook([CLIENTS, STOCK], CLIENT_MARKS), {
      plan: {
        renames: [],
        removals: [],
        additions: [copyOfClients('Clients (2)'), copyOfClients('Clients (3)')],
        order: ['Clients', 'Stock', 'Clients (2)', 'Clients (3)'],
      },
      ops: [
        { sheetName: 'Clients (2)', ops: [{ kind: 'insert-rows', index: 0, count: 1 }] },
        {
          sheetName: 'Clients (3)',
          ops: [
            { kind: 'insert-rows', index: 0, count: 1 },
            { kind: 'insert-cols', index: 0, count: 1 },
          ],
        },
      ],
      states: CLIENT_MARKS,
    })
    expect(await xlsxToText(saved)).toBe(
      `# Clients\n${WITHHELD_CLIENTS}\n\n# Stock\nItem\n\n` +
        `# Clients (2)\n${WITHHELD_CLIENTS}\n\n` +
        `# Clients (3)\n | Name | Phone\n | Kim | ${MARKER}`,
    )
  })

  it('reads the copy as its marker when the source is renamed in the same save', async () => {
    const saved = await gatewaySave(savedBook([CLIENTS, STOCK], CLIENT_MARKS), {
      plan: {
        renames: [{ sheetName: 'Clients', newName: 'Customers' }],
        removals: [],
        additions: [copyOfClients('Clients (2)')],
        order: ['Customers', 'Stock', 'Clients (2)'],
      },
      states: CLIENT_MARKS,
    })
    expect(await xlsxToText(saved)).toBe(
      `# Customers\n${WITHHELD_CLIENTS}\n\n# Stock\nItem\n\n# Clients (2)\n${WITHHELD_CLIENTS}`,
    )
  })

  it('reads the copy as its marker when the source is removed in the same save', async () => {
    const saved = await gatewaySave(savedBook([CLIENTS, STOCK], CLIENT_MARKS), {
      plan: {
        renames: [],
        removals: ['Clients'],
        additions: [copyOfClients('Kept copy')],
        order: ['Stock', 'Kept copy'],
      },
      states: CLIENT_MARKS,
    })
    expect(await xlsxToText(saved)).toBe(`# Stock\nItem\n\n# Kept copy\n${WITHHELD_CLIENTS}`)
  })
})

describe('xlsx: a save that was not given the marks keeps the cell withheld', () => {
  // the editor right after opening a workbook, or a caller that never reads the part
  const UNKNOWN = null

  it('after a row is inserted above the cell', async () => {
    const saved = await gatewaySave(savedBook([CLIENTS, STOCK], CLIENT_MARKS), {
      ops: [{ sheetName: 'Clients', ops: [{ kind: 'insert-rows', index: 1, count: 1 }] }],
      states: UNKNOWN,
    })
    const text = await xlsxToText(saved)
    expect(text).toBe(`# Clients\n${WITHHELD_CLIENTS}\n\n# Stock\nItem`)
    expect(text).not.toContain(SECRET)
  })

  it('after a column is inserted before the cell', async () => {
    const saved = await gatewaySave(savedBook([CLIENTS, STOCK], CLIENT_MARKS), {
      ops: [{ sheetName: 'Clients', ops: [{ kind: 'insert-cols', index: 1, count: 1 }] }],
      states: UNKNOWN,
    })
    expect(await xlsxToText(saved)).toBe(
      `# Clients\nName |  | Phone\nKim |  | ${MARKER}\n\n# Stock\nItem`,
    )
  })

  it('after the sheet is renamed', async () => {
    const saved = await gatewaySave(savedBook([CLIENTS, STOCK], CLIENT_MARKS), {
      plan: {
        renames: [{ sheetName: 'Clients', newName: 'Customers' }],
        removals: [],
        additions: [],
        order: ['Customers', 'Stock'],
      },
      states: UNKNOWN,
    })
    expect(await xlsxToText(saved)).toBe(`# Customers\n${WITHHELD_CLIENTS}\n\n# Stock\nItem`)
  })

  it('and reads the rest of the workbook after the sheet is removed', async () => {
    const saved = await gatewaySave(savedBook([CLIENTS, STOCK], CLIENT_MARKS), {
      plan: { renames: [], removals: ['Clients'], additions: [], order: ['Stock'] },
      states: UNKNOWN,
    })
    expect(await xlsxToText(saved)).toBe('# Stock\nItem')
  })

  it('on a duplicated sheet too', async () => {
    const saved = await gatewaySave(savedBook([CLIENTS, STOCK], CLIENT_MARKS), {
      plan: {
        renames: [],
        removals: [],
        additions: [{ name: 'Clients (2)', sourceSheetName: 'Clients' }],
        order: ['Clients', 'Stock', 'Clients (2)'],
      },
      states: UNKNOWN,
    })
    expect(await xlsxToText(saved)).toBe(
      `# Clients\n${WITHHELD_CLIENTS}\n\n# Stock\nItem\n\n# Clients (2)\n${WITHHELD_CLIENTS}`,
    )
  })

  it('after the tabs are reordered and another program drops the part', async () => {
    // the tabs are reordered by a save that does not know the marks, then a
    // program that rebuilds the package drops the part: what is left is the
    // copy in the defined names, which records the sheet by position
    const saved = await gatewaySave(savedBook([CLIENTS, STOCK], CLIENT_MARKS), {
      plan: {
        renames: [],
        removals: [],
        additions: [],
        order: ['Stock', 'Clients'],
        orderChanged: true,
      },
      states: UNKNOWN,
    })
    const rebuilt = await JSZip.loadAsync(saved)
    rebuilt.remove(REDACTION_PART)
    const text = await xlsxToText(await rebuilt.generateAsync({ type: 'uint8array' }))
    expect(text).toBe(`# Stock\nItem\n\n# Clients\n${WITHHELD_CLIENTS}`)
  })
})

/** a formula cell with the value the last calculation left in the file */
const formula = (ref: string, text: string, cached: string | number) =>
  `<c r="${ref}"><f>${text}</f><v>${cached}</v></c>`
const PRIVATE = '{{private}}'
/** the Clients sheet with B2 withheld, and whatever else a test puts beside it */
const clientsWith = (extra: string): BookSheet => ({
  name: 'Clients',
  rows:
    `<row r="1">${inline('A1', 'Name')}${inline('B1', 'Phone')}</row>` +
    `<row r="2">${inline('A2', 'Kim')}<c r="B2"><v>${SECRET}</v></c>${extra}</row>`,
})

describe('xlsx: a formula that depends on a withheld cell is withheld too', () => {
  it('withholds the value of a formula that reads the cell', async () => {
    const text = await xlsxToText(
      await savedBook([clientsWith(formula('C2', 'B2', SECRET))], CLIENT_MARKS),
    )
    expect(text).toBe(`# Clients\nName | Phone\nKim | ${MARKER} | ${PRIVATE}`)
  })

  it('follows a chain of three formulas', async () => {
    const chain =
      formula('C2', 'B2', SECRET) +
      formula('D2', 'C2&amp;"x"', `${SECRET}x`) +
      formula('E2', 'LEFT(D2,11)', SECRET)
    const text = await xlsxToText(await savedBook([clientsWith(chain)], CLIENT_MARKS))
    expect(text).toBe(
      `# Clients\nName | Phone\nKim | ${MARKER} | ${PRIVATE} | ${PRIVATE} | ${PRIVATE}`,
    )
    expect(text).not.toContain(SECRET)
  })

  it('withholds a formula on a sheet without marks that points at a marked sheet', async () => {
    const report: BookSheet = {
      name: 'Report',
      rows: `<row r="1">${formula('A1', 'Clients!B2', SECRET)}${formula('B1', "'Clients'!A2", 'Kim')}</row>`,
    }
    const text = await xlsxToText(await savedBook([CLIENTS, report], CLIENT_MARKS))
    expect(text).toBe(`# Clients\n${WITHHELD_CLIENTS}\n\n# Report\n${PRIVATE} | Kim`)
  })

  it('withholds a total over the whole column', async () => {
    const totals = formula('D2', 'SUM(B:B)', SECRET) + formula('E2', 'COUNTA(A:A)', 2)
    const text = await xlsxToText(await savedBook([clientsWith(totals)], CLIENT_MARKS))
    expect(text).toBe(`# Clients\nName | Phone\nKim | ${MARKER} |  | ${PRIVATE} | 2`)
  })

  it('resolves a named range', async () => {
    const bytes = await book(
      [clientsWith(formula('C2', 'KimPhone', SECRET) + formula('D2', 'KimName', 'Kim'))],
      {
        part: serializeRedactionPart(CLIENT_MARKS),
        definedNames:
          '<definedName name="KimPhone">Clients!$B$2</definedName>' +
          '<definedName name="KimName">Clients!$A$2</definedName>',
      },
    )
    expect(await xlsxToText(bytes)).toBe(
      `# Clients\nName | Phone\nKim | ${MARKER} | ${PRIVATE} | Kim`,
    )
  })

  it('withholds what it cannot trace: INDIRECT, and what reads it', async () => {
    const indirect =
      formula('C2', 'INDIRECT("B"&amp;2)', SECRET) +
      formula('D2', 'C2', SECRET) +
      formula('E2', 'A2', 'Kim')
    const text = await xlsxToText(await savedBook([clientsWith(indirect)], CLIENT_MARKS))
    expect(text).toBe(`# Clients\nName | Phone\nKim | ${MARKER} | ${PRIVATE} | ${PRIVATE} | Kim`)
  })

  it('reads a workbook whose formulas refer to each other in a circle', async () => {
    const circle =
      formula('C2', 'D2+B2', SECRET) +
      formula('D2', 'C2', SECRET) +
      formula('E2', 'F2', 0) +
      formula('F2', 'E2', 0)
    const text = await xlsxToText(await savedBook([clientsWith(circle)], CLIENT_MARKS))
    expect(text).toBe(`# Clients\nName | Phone\nKim | ${MARKER} | ${PRIVATE} | ${PRIVATE} | 0 | 0`)
  })

  it('withholds the followers of a shared formula that reach the cell, and only those', async () => {
    const sheet: BookSheet = {
      name: 'Clients',
      rows:
        `<row r="1">${inline('A1', 'Name')}${inline('B1', 'Phone')}` +
        '<c r="C1" t="str"><f t="shared" ref="C1:C3" si="0">B1</f><v>Phone</v></c></row>' +
        `<row r="2">${inline('A2', 'Kim')}<c r="B2"><v>${SECRET}</v></c>` +
        `<c r="C2"><f t="shared" si="0"/><v>${SECRET}</v></c></row>` +
        `<row r="3">${inline('A3', 'Lee')}<c r="B3"><v>555</v></c>` +
        '<c r="C3"><f t="shared" si="0"/><v>555</v></c></row>',
    }
    const text = await xlsxToText(await savedBook([sheet], CLIENT_MARKS))
    expect(text).toBe(
      `# Clients\nName | Phone | Phone\nKim | ${MARKER} | ${PRIVATE}\nLee | 555 | 555`,
    )
  })

  it('withholds every cell an array formula fills', async () => {
    const sheet: BookSheet = {
      name: 'Clients',
      rows:
        `<row r="1">${inline('A1', 'Name')}${inline('B1', 'Phone')}` +
        '<c r="D1" t="str"><f t="array" ref="D1:D2">B1:B2</f><v>Phone</v></c></row>' +
        `<row r="2">${inline('A2', 'Kim')}<c r="B2"><v>${SECRET}</v></c><c r="D2"><v>${SECRET}</v></c></row>`,
    }
    const text = await xlsxToText(await savedBook([sheet], CLIENT_MARKS))
    expect(text).toBe(`# Clients\nName | Phone |  | ${PRIVATE}\nKim | ${MARKER} |  | ${PRIVATE}`)
  })

  it('withholds the text of a dependent formula that was never calculated', async () => {
    const text = await xlsxToText(
      await savedBook(
        [clientsWith('<c r="C2"><f>B2*1</f></c><c r="D2"><f>A2</f></c>')],
        CLIENT_MARKS,
      ),
    )
    expect(text).toBe(`# Clients\nName | Phone\nKim | ${MARKER} | ${PRIVATE} | =A2`)
  })

  it('traces through a sheet the character budget never reaches', async () => {
    // Report!A1 reads Ledger!A1, which reads the withheld cell; the budget
    // ends before Ledger is read for its text.
    const report: BookSheet = {
      name: 'Report',
      rows: `<row r="1">${formula('A1', 'Ledger!A1', SECRET)}</row>`,
    }
    const ledger: BookSheet = {
      name: 'Ledger',
      rows: `<row r="1">${formula('A1', 'Clients!B2', SECRET)}</row>`,
    }
    const text = await xlsxToText(await savedBook([report, ledger, CLIENTS], CLIENT_MARKS), {
      maxChars: 12,
    })
    expect(text).toBe(`# Report\n${PRIVATE}`)
  })

  it('withholds a whole sheet that is too large to check for formulas', async () => {
    const report: BookSheet = {
      name: 'Report',
      rows: `<row r="1">${inline('A1', 'Q'.repeat(2000))}${formula('B1', 'A1', 'Quarter')}</row>`,
    }
    // Stock reads a cell of the sheet nobody could check
    const stock: BookSheet = {
      name: 'Stock',
      rows: `<row r="1">${inline('A1', 'Item')}${formula('B1', 'Report!A1', 'Q')}</row>`,
    }
    const bytes = await savedBook([CLIENTS, report, stock], CLIENT_MARKS)
    // Report is past the limit, Clients and Stock are within it
    const text = await xlsxToText(bytes, { formulaScanMaxBytes: 1500 })
    expect(text).toBe(
      `# Clients\n${WITHHELD_CLIENTS}\n\n# Report\n${PRIVATE} | ${PRIVATE}\n\n# Stock\nItem | ${PRIVATE}`,
    )
  })

  it('withholds a whole sheet when a formula on it has no address to trace from', async () => {
    const loose: BookSheet = {
      name: 'Report',
      rows: `<row r="1">${inline('A1', 'Quarter')}<c><f>Clients!B2</f><v>${SECRET}</v></c></row>`,
    }
    const text = await xlsxToText(await savedBook([CLIENTS, loose], CLIENT_MARKS))
    expect(text).toBe(`# Clients\n${WITHHELD_CLIENTS}\n\n# Report\n${PRIVATE} | ${PRIVATE}`)
  })

  it('withholds every cell of a what-if data table', async () => {
    const table: BookSheet = {
      name: 'Report',
      rows:
        `<row r="1">${inline('A1', 'Rate')}<c r="B1"><f t="dataTable" ref="B1:B2" dt2D="0" dtr="0" r1="A9"/><v>1</v></c></row>` +
        `<row r="2">${inline('A2', 'Kept')}<c r="B2"><v>2</v></c></row>`,
    }
    const text = await xlsxToText(await savedBook([CLIENTS, table], CLIENT_MARKS))
    expect(text).toBe(
      `# Clients\n${WITHHELD_CLIENTS}\n\n# Report\nRate | ${PRIVATE}\nKept | ${PRIVATE}`,
    )
  })

  it('reads formulas written with a namespace prefix', async () => {
    const prefixed = await JSZip.loadAsync(await savedBook([CLIENTS], CLIENT_MARKS))
    prefixed.file(
      'xl/worksheets/sheet1.xml',
      `${XML_DECL}<x:worksheet xmlns:x="${SHEET_NS}"><x:sheetData>` +
        `<x:row r="2"><x:c r="B2"><x:v>${SECRET}</x:v></x:c>` +
        `<x:c r="C2"><x:f>B2</x:f><x:v>${SECRET}</x:v></x:c><x:c r="D2"><x:f>1+1</x:f><x:v>2</x:v></x:c></x:row>` +
        '</x:sheetData></x:worksheet>',
    )
    const text = await xlsxToText(await prefixed.generateAsync({ type: 'uint8array' }))
    expect(text).toBe(`# Clients\n | ${MARKER} | ${PRIVATE} | 2`)
  })

  it('still shows a formula that reads no withheld cell', async () => {
    const plain = formula('C2', 'LEN(A2)', 3) + formula('D2', 'SUM(A:A)', 0)
    const text = await xlsxToText(await savedBook([clientsWith(plain)], CLIENT_MARKS))
    expect(text).toBe(`# Clients\nName | Phone\nKim | ${MARKER} | 3 | 0`)
  })

  it('changes nothing in a workbook that withholds nothing', async () => {
    const text = await xlsxToText(
      await book([
        clientsWith(formula('C2', 'INDIRECT("B2")', SECRET) + formula('D2', 'B2', SECRET)),
      ]),
    )
    expect(text).toBe(`# Clients\nName | Phone\nKim | ${SECRET} | ${SECRET} | ${SECRET}`)
  })

  it('reads a 5,000-formula sheet in well under two seconds', async () => {
    let rows = `<row r="1">${inline('A1', 'n')}<c r="B1"><v>${SECRET}</v></c></row>`
    for (let row = 2; row <= 2501; row += 1) {
      rows +=
        `<row r="${row}"><c r="A${row}"><v>${row}</v></c>` +
        formula(`B${row}`, `B${row - 1}+A${row}`, SECRET) +
        formula(`C${row}`, `SUM(A$2:A${row})`, row) +
        '</row>'
    }
    const bytes = await savedBook(
      [{ name: 'Clients', rows }],
      [{ sheetName: 'Clients', marks: [mark('B1')] }],
    )
    const started = performance.now()
    const text = await xlsxToText(bytes)
    const elapsed = performance.now() - started
    expect(text).not.toContain(SECRET)
    expect(text.split(PRIVATE)).toHaveLength(2501)
    expect(text).toContain('\n2501 | {{private}} | 2501')
    expect(elapsed).toBeLessThan(2000)
  })
})

const PKG_RELS = 'http://schemas.openxmlformats.org/package/2006/relationships'
/** The second sheet of these books: a pivot's output at A3:B4, a label beside it, a formula over it. */
const pivotReport = (extra = ''): BookSheet => ({
  name: 'Report',
  rows:
    extra +
    `<row r="3">${inline('A3', 'Phone')}${inline('B3', 'Total')}${inline('D3', 'beside')}</row>` +
    `<row r="4"><c r="A4"><v>${SECRET}</v></c><c r="B4"><v>10</v></c></row>`,
})
const REPORT_SHOWN = `# Report\nPhone | Total |  | beside\n${SECRET} | 10`
const REPORT_WITHHELD = `# Report\n${PRIVATE} | ${PRIVATE} |  | beside\n${PRIVATE} | ${PRIVATE}`

/**
 * Add a PivotTable to sheet 2 the way Excel writes one: the sheet points at
 * the pivot part, the pivot part says where its output is and points at its
 * cache, and the cache says where the data came from.
 */
async function withPivot(
  bytes: Promise<Uint8Array>,
  pivot: {
    /** the content of `<cacheSource>`; undefined = the cache part is missing */
    source: string | undefined
    /** the pivot part's body; the output's location by default */
    body?: string
  },
): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(await bytes)
  const rels = (type: string, target: string) =>
    `${XML_DECL}<Relationships xmlns="${PKG_RELS}"><Relationship Id="rId1" Type="${REL_NS}/${type}" Target="${target}"/></Relationships>`
  zip.file(
    'xl/worksheets/_rels/sheet2.xml.rels',
    rels('pivotTable', '../pivotTables/pivotTable1.xml'),
  )
  zip.file(
    'xl/pivotTables/pivotTable1.xml',
    `${XML_DECL}<pivotTableDefinition xmlns="${SHEET_NS}" name="PivotTable1" cacheId="1">` +
      (pivot.body ??
        '<location ref="A3:B4" firstHeaderRow="1" firstDataRow="1" firstDataCol="1"/>') +
      '</pivotTableDefinition>',
  )
  zip.file(
    'xl/pivotTables/_rels/pivotTable1.xml.rels',
    rels('pivotCacheDefinition', '../pivotCache/pivotCacheDefinition1.xml'),
  )
  if (pivot.source !== undefined) {
    zip.file(
      'xl/pivotCache/pivotCacheDefinition1.xml',
      `${XML_DECL}<pivotCacheDefinition xmlns="${SHEET_NS}" xmlns:r="${REL_NS}">${pivot.source}</pivotCacheDefinition>`,
    )
  }
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
}

const worksheetSource = (attributes: string) =>
  `<cacheSource type="worksheet"><worksheetSource ${attributes}/></cacheSource>`

describe('xlsx: the output of a PivotTable built from a withheld cell is withheld too', () => {
  const read = async (
    pivot: Parameters<typeof withPivot>[1],
    report = pivotReport(),
    marks: BookMarks = { part: serializeRedactionPart(CLIENT_MARKS) },
  ) => xlsxToText(await withPivot(book([CLIENTS, report], marks), pivot))

  it('withholds the labels and totals when the source range holds the cell', async () => {
    const text = await read({ source: worksheetSource('ref="A1:B2" sheet="Clients"') })
    expect(text).toBe(`# Clients\n${WITHHELD_CLIENTS}\n\n${REPORT_WITHHELD}`)
  })

  it('shows the output of a pivot whose source range holds none', async () => {
    const text = await read({ source: worksheetSource('ref="A1:A2" sheet="Clients"') })
    expect(text).toBe(`# Clients\n${WITHHELD_CLIENTS}\n\n${REPORT_SHOWN}`)
  })

  it('withholds a formula that reads the output', async () => {
    const text = await read(
      { source: worksheetSource('ref="A1:B2" sheet="Clients"') },
      pivotReport(`<row r="1">${formula('F1', 'A4', SECRET)}</row>`),
    )
    expect(text).not.toContain(SECRET)
    expect(text).toContain(`# Report\n |  |  |  |  | ${PRIVATE}`)
  })

  it('withholds the report-filter cells above the output', async () => {
    const text = await read(
      {
        source: worksheetSource('ref="A1:B2" sheet="Clients"'),
        body:
          '<location ref="A3:B4" firstHeaderRow="1" firstDataRow="1" firstDataCol="1" rowPageCount="1" colPageCount="1"/>' +
          '<pageFields count="1"><pageField fld="1" item="0" hier="-1"/></pageFields>',
      },
      pivotReport(`<row r="1">${inline('A1', 'Phone')}<c r="B1"><v>${SECRET}</v></c></row>`),
    )
    expect(text).not.toContain(SECRET)
  })

  it.each([
    // two filters in one row: label and item, a blank column, label and item (A1:B1, D1:E1)
    ['side by side, wider than the output', ' rowPageCount="1" colPageCount="2"'],
    // what cannot be told is not guessed: the filters are somewhere above the output
    ['without saying how they are laid out', ''],
    ['with a layout too small to hold them', ' rowPageCount="1" colPageCount="1"'],
    ['with a layout that is no number', ' rowPageCount="1" colPageCount="x"'],
  ])('withholds report filters given %s', async (_how, layout) => {
    const text = await read(
      {
        source: worksheetSource('ref="A1:B2" sheet="Clients"'),
        body:
          `<location ref="A3:B4" firstHeaderRow="1" firstDataRow="1" firstDataCol="1"${layout}/>` +
          '<pageFields count="2"><pageField fld="0" hier="-1"/><pageField fld="1" item="0" hier="-1"/></pageFields>',
      },
      pivotReport(
        `<row r="1">${inline('A1', 'Name')}${inline('B1', 'Kim')}${inline('D1', 'Phone')}<c r="E1"><v>${SECRET}</v></c></row>`,
      ),
    )
    expect(text).not.toContain(SECRET)
  })

  it('follows a source given as a defined name', async () => {
    const named = (range: string): BookMarks => ({
      part: serializeRedactionPart(CLIENT_MARKS),
      definedNames: `<definedName name="ClientData">Clients!${range}</definedName>`,
    })
    const source = { source: worksheetSource('name="ClientData"') }
    expect(await read(source, pivotReport(), named('$A$1:$B$2'))).toContain(REPORT_WITHHELD)
    expect(await read(source, pivotReport(), named('$A$1:$A$2'))).toContain(REPORT_SHOWN)
  })

  it.each([
    ['is a table or a name the workbook does not define', worksheetSource('name="Table1"')],
    ['is in another workbook', worksheetSource('ref="A1:A2" sheet="Clients" r:id="rId1"')],
    [
      'is in another workbook, the relationship written with spaces',
      worksheetSource('ref="A1:A2" sheet="Clients" r:id = "rId1"'),
    ],
    [
      'is in another workbook, the relationship in single quotes',
      worksheetSource(`ref="A1:A2" sheet="Clients" r:id='rId1'`),
    ],
    [
      'is in another workbook, the relationship under another declared prefix',
      worksheetSource(`xmlns:rel="${REL_NS}" ref="A1:A2" sheet="Clients" rel:id="rId1"`),
    ],
    ['is a database connection', '<cacheSource type="external" connectionId="1"/>'],
    [
      'is several ranges consolidated',
      '<cacheSource type="consolidation"><consolidation/></cacheSource>',
    ],
    ['names a sheet the workbook does not have', worksheetSource('ref="A1:A2" sheet="Gone"')],
    ['has no range', worksheetSource('sheet="Clients"')],
    ['cannot be read: the cache part is missing', undefined],
  ])('withholds the output when the source %s', async (_why, source) => {
    const text = await read({ source })
    expect(text).toBe(`# Clients\n${WITHHELD_CLIENTS}\n\n${REPORT_WITHHELD}`)
  })

  it.each([
    [
      'a revision id',
      'xmlns:xr="http://schemas.microsoft.com/office/spreadsheetml/2014/revision" xr:id="{7C5A}"',
    ],
    ['an id of no namespace', 'id="7"'],
    ['text inside another attribute that only looks like one', `comment='a r:id="rId1"'`],
  ])('does not take %s on the source for another workbook', async (_what, extra) => {
    const text = await read({ source: worksheetSource(`ref="A1:A2" sheet="Clients" ${extra}`) })
    expect(text).toBe(`# Clients\n${WITHHELD_CLIENTS}\n\n${REPORT_SHOWN}`)
  })

  it('withholds the whole sheet when a pivot on it does not say where its output is', async () => {
    const text = await read({ source: worksheetSource('ref="A1:A2" sheet="Clients"'), body: '' })
    expect(text).not.toContain(SECRET)
    expect(text).not.toContain('beside')
  })

  /** more member items than the megabyte a pivot part's head used to be read to */
  const MANY_ITEMS = '<item x="0"/>'.repeat(90_000)
  const BIG_FIELDS = `<pivotFields count="1"><pivotField axis="axisRow"><items count="90000">${MANY_ITEMS}</items></pivotField></pivotFields>`

  it.each([
    ['and no layout', ''],
    ['and a layout too small to hold them', ' rowPageCount="1" colPageCount="1"'],
  ])(
    'withholds report filters listed after a megabyte of field items, %s',
    async (_how, layout) => {
      // the order Excel writes: location, the fields with their items, then the filters
      const text = await read(
        {
          source: worksheetSource('ref="A1:B2" sheet="Clients"'),
          body:
            `<location ref="A3:B4" firstHeaderRow="1" firstDataRow="1" firstDataCol="1"${layout}/>` +
            BIG_FIELDS +
            '<pageFields count="2"><pageField fld="0" hier="-1"/><pageField fld="1" item="0" hier="-1"/></pageFields>',
        },
        pivotReport(
          `<row r="1">${inline('A1', 'Name')}${inline('B1', 'Kim')}${inline('D1', 'Phone')}<c r="E1"><v>${SECRET}</v></c></row>`,
        ),
      )
      expect(text).not.toContain(SECRET)
    },
  )

  it('finds an output location written after a megabyte of field items', async () => {
    const text = await read({
      source: worksheetSource('ref="A1:B2" sheet="Clients"'),
      body:
        BIG_FIELDS + '<location ref="A3:B4" firstHeaderRow="1" firstDataRow="1" firstDataCol="1"/>',
    })
    expect(text).toBe(`# Clients\n${WITHHELD_CLIENTS}\n\n${REPORT_WITHHELD}`)
  })

  it('withholds the output when the cache names its source after a megabyte of other content', async () => {
    // a cache opens with its source; one that does not is not searched for it
    const text = await read({
      source:
        `<extLst><ext uri="{0}">${MANY_ITEMS}</ext></extLst>` +
        worksheetSource('ref="A1:A2" sheet="Clients"'),
    })
    expect(text).toBe(`# Clients\n${WITHHELD_CLIENTS}\n\n${REPORT_WITHHELD}`)
  })

  describe('a pivot part too large to be read to its end', () => {
    const cache = `<pivotCacheDefinition>${worksheetSource('ref="A1:A2" sheet="Clients"')}</pivotCacheDefinition>`
    const WHOLE = { startRow: 0, endRow: 1_048_575, startColumn: 0, endColumn: 16_383 }

    it('takes every row from the top of the sheet to the end of the output', () => {
      // the filters, if any, are in the part that was not read
      const head = '<location ref="C5:D9" rowPageCount="1" colPageCount="1"/>'
      expect(pivotOutputOf({ text: head, truncated: true }, cache).area).toEqual({
        ...WHOLE,
        endRow: 8,
      })
      expect(pivotOutputOf({ text: head, truncated: false }, cache).area).toEqual({
        startRow: 2,
        endRow: 8,
        startColumn: 2,
        endColumn: 3,
      })
    })

    it('takes the whole sheet when the location was not in what was read', () => {
      expect(pivotOutputOf({ text: BIG_FIELDS, truncated: true }, cache)).toEqual({
        area: WHOLE,
        formula: null,
      })
    })
  })

  it('changes nothing in a workbook that withholds nothing', async () => {
    const text = await read({ source: undefined }, pivotReport(), {})
    expect(text).toBe(`# Clients\nName | Phone\nKim | ${SECRET}\n\n${REPORT_SHOWN}`)
  })
})
