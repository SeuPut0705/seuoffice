import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { REDACT_EL, REDACT_NS } from '@genoffice/agent-core/redact-range'
// the writer's own helpers, by path: the marks under test are the ones the deck
// engine really saves, not a copy of their shape kept in this file
import { REDACT_EXT_URI, setRedactExt } from '../../pptx-engine/src/redaction-xml'
import { parseFileToText, pptxToText, redactHtmlSource, redactMarkdownSource } from '../src/index'
import { PPTX_REDACT_EXT_URI } from '../src/pptx-redaction'
import { writeFixture } from './helpers/fixtures'

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

let fixtureSeq = 0
async function readDeck(slide: string, notes?: string) {
  return parseFileToText(writeFixture(`withheld-${++fixtureSeq}.pptx`, await deck(slide, notes)))
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
})

describe('pptx: a mark that cannot be processed fails the read', () => {
  const ext = (inner: string, uri = REDACT_EXT_URI) =>
    `<a:extLst><a:ext uri="${uri}" xmlns:go="${REDACT_NS}">${inner}</a:ext></a:extLst>`
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
        `<a:rPr><a:extLst><a:ext uri="{OTHER}" xmlns:x="${REDACT_NS}"><x:redact label="x"/></a:ext></a:extLst></a:rPr>`,
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
