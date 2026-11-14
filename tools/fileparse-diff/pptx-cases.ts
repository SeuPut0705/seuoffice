import JSZip from 'jszip'
import {
  REDACT_EL,
  REDACT_NS_WRITTEN as REDACT_NS,
} from '../../packages/agent-core/src/redact-range'
import { pptxToText } from './reference/pptx'
import { PPTX_REDACT_EXT_URI } from './reference/pptx-redaction'
import { buildPptxFixture } from '../../packages/file-parse/tests/helpers/fixtures'
import { hostileZipInputs } from './hostile'
import type { Input, Spec } from './spec'
import { fixtureBytes, fixedFixtureBytes } from './zip-fixture'

const P = 'http://schemas.openxmlformats.org/presentationml/2006/main'
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const PKG = 'http://schemas.openxmlformats.org/package/2006/relationships'
const MC = 'http://schemas.openxmlformats.org/markup-compatibility/2006'
const P188 = 'http://schemas.microsoft.com/office/powerpoint/2018/8/main'
const MODERN_COMMENTS = 'http://schemas.microsoft.com/office/2018/10/relationships/comments'
const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'

const run = (text: string) => `<a:r><a:t xml:space="preserve">${text}</a:t></a:r>`
const para = (...inner: string[]) => `<a:p>${inner.join('')}</a:p>`
const sp = (body: string) => `<p:sp><p:txBody>${body}</p:txBody></p:sp>`
const slide = (tree: string) =>
  `${DECL}<p:sld xmlns:p="${P}" xmlns:a="${A}" xmlns:r="${R}" xmlns:mc="${MC}"><p:cSld><p:spTree>${tree}</p:spTree></p:cSld></p:sld>`
const pic = '<p:pic><p:nvPicPr><p:cNvPr id="4" name="Picture"/></p:nvPicPr><p:blipFill/></p:pic>'
const mark = (label: string) =>
  `<a:extLst><a:ext uri="${PPTX_REDACT_EXT_URI}"><${REDACT_EL} xmlns:go="${REDACT_NS}" label="${label}"/></a:ext></a:extLst>`
const markedRun = (label: string, text: string) =>
  `<a:r><a:rPr lang="en-US">${mark(label)}</a:rPr><a:t>${text}</a:t></a:r>`
const unlabelledRun = (text: string) =>
  `<a:r><a:rPr><a:extLst><a:ext uri="${PPTX_REDACT_EXT_URI}"><${REDACT_EL} xmlns:go="${REDACT_NS}"/></a:ext></a:extLst></a:rPr><a:t>${text}</a:t></a:r>`
const markOnShape = `<p:sp><p:spPr>${mark('Shape')}</p:spPr><p:txBody>${para(run('shape words'))}</p:txBody></p:sp>`

const placeholder = (type: string | null, body: string) =>
  `<p:sp><p:nvSpPr><p:cNvPr id="2" name="n"/><p:cNvSpPr/><p:nvPr>${type === null ? '<p:ph/>' : `<p:ph type="${type}" idx="1"/>`}</p:nvPr></p:nvSpPr><p:txBody>${body}</p:txBody></p:sp>`
const notes = (tree: string) =>
  `${DECL}<p:notes xmlns:p="${P}" xmlns:a="${A}" xmlns:mc="${MC}"><p:cSld><p:spTree>${tree}</p:spTree></p:cSld></p:notes>`

type Rel = [id: string, type: string, target: string, mode?: string]
const rels = (items: Rel[]) =>
  `${DECL}<Relationships xmlns="${PKG}">${items
    .map(
      ([id, type, target, mode]) =>
        `<Relationship Id="${id}" Type="${type}" Target="${target}"${mode ? ` TargetMode="${mode}"` : ''}/>`,
    )
    .join('')}</Relationships>`
const presentation = (ids: string) =>
  `${DECL}<p:presentation xmlns:p="${P}" xmlns:r="${R}"><p:sldIdLst>${ids}</p:sldIdLst></p:presentation>`
const sldId = (n: number, rid: string) => `<p:sldId id="${255 + n}" r:id="${rid}"/>`
const SLIDE_REL = `${R}/slide`
const NOTES_REL = `${R}/notesSlide`
const COMMENTS_REL = `${R}/comments`

const classicAuthors = `${DECL}<p:cmAuthorLst xmlns:p="${P}"><p:cmAuthor id="0" name="Ann" initials="A" lastIdx="2" clrIdx="0"/><p:cmAuthor id="1" name="  " initials="B"/></p:cmAuthorLst>`
const classicComments = (body: string) => `${DECL}<p:cmLst xmlns:p="${P}">${body}</p:cmLst>`
const modernAuthors = `<p188:authorLst xmlns:p188="${P188}"><p188:author id="{A1}" name="Alice"/><p188:author id="{B2}" name="Bob"/></p188:authorLst>`
const modernComments = (body: string) =>
  `<p188:cmLst xmlns:p188="${P188}" xmlns:a="${A}">${body}</p188:cmLst>`
const modernComment = (attrs: string, text: string, replies = '') =>
  `<p188:cm ${attrs}><p188:txBody><a:bodyPr/>${text}</p188:txBody>${replies ? `<p188:replyLst>${replies}</p188:replyLst>` : ''}</p188:cm>`

async function zip(parts: Record<string, string>): Promise<Uint8Array> {
  const z = new JSZip()
  for (const [name, data] of Object.entries(parts)) z.file(name, data)
  return fixtureBytes(z)
}

/** A deck with a presentation manifest: one entry per slide, in order. */
function deck(slides: string[], extra: Record<string, string> = {}): Record<string, string> {
  const parts: Record<string, string> = {
    'ppt/presentation.xml': presentation(
      slides.map((_, i) => sldId(i + 1, `rId${i + 1}`)).join(''),
    ),
    'ppt/_rels/presentation.xml.rels': rels(
      slides.map((_, i) => [`rId${i + 1}`, SLIDE_REL, `slides/slide${i + 1}.xml`]),
    ),
  }
  slides.forEach((xml, i) => (parts[`ppt/slides/slide${i + 1}.xml`] = xml))
  return { ...parts, ...extra }
}

/** The first compressed byte of `name` set to 0xFF: a reserved deflate block, so reading that part throws. */
function breakEntry(bytes: Uint8Array, name: string): Uint8Array {
  const out = bytes.slice()
  const view = new DataView(out.buffer)
  const wanted = new TextEncoder().encode(name)
  for (let at = 0; at + 30 < out.length; at++) {
    if (view.getUint32(at, true) !== 0x04034b50) continue
    const nameLen = view.getUint16(at + 26, true)
    const extraLen = view.getUint16(at + 28, true)
    const found = out.subarray(at + 30, at + 30 + nameLen)
    if (nameLen === wanted.length && found.every((b, i) => b === wanted[i])) {
      out[at + 30 + nameLen + extraLen] = 0xff
      return out
    }
  }
  throw new Error(`entry ${name} not found`)
}

const TEXT_SLIDE = slide(sp(para(run('Hello'), run(' world'))))

async function built(): Promise<Input[]> {
  const cases: Array<[string, Record<string, string>]> = [
    // reading order and the manifest
    [
      'manifest order, external, wrong type, missing rel, prefixed and bare ids',
      {
        'ppt/presentation.xml': presentation(
          sldId(1, 'rId3') +
            sldId(2, 'rId1') +
            sldId(3, 'rId9') +
            sldId(4, 'rIdX') +
            sldId(5, 'rIdT') +
            '<p:sldId id="300" id2="x" ns:id="rId2"/><p:sldId id="rId1"/><p:sldId>rId1</p:sldId><p:sldId/>',
        ),
        'ppt/_rels/presentation.xml.rels': rels([
          ['rId1', SLIDE_REL, 'slides/slide1.xml'],
          ['rId2', SLIDE_REL, ' /ppt/slides/slide2.xml '],
          ['rId3', SLIDE_REL, 'slides/slide3.xml'],
          ['rIdX', SLIDE_REL, 'slides/slide1.xml', 'External'],
          ['rIdT', `${R}/slideLayout`, 'slides/slide1.xml'],
          ['', SLIDE_REL, 'slides/slide1.xml'],
        ]),
        'ppt/slides/slide1.xml': slide(sp(para(run('First file')))),
        'ppt/slides/slide2.xml': slide(sp(para(run('Second file')))),
        'ppt/slides/slide3.xml': slide(sp(para(run('Third file')))),
      },
    ],
    [
      'manifest without slide list',
      {
        'ppt/presentation.xml': `<p:presentation xmlns:p="${P}"/>`,
        'ppt/slides/slide1.xml': TEXT_SLIDE,
      },
    ],
    [
      'manifest with empty rels part',
      {
        'ppt/presentation.xml': presentation(sldId(1, 'rId1')),
        'ppt/_rels/presentation.xml.rels': '',
        'ppt/slides/slide1.xml': TEXT_SLIDE,
      },
    ],
    [
      'manifest names: double prefix self-closing, percent target, empty slide part',
      {
        'ppt/presentation.xml': `<p:presentation xmlns:p="${P}" xmlns:r="${R}"><x:p:sldIdLst><x:y:sldId r:id="rId1"/><q:sldId r:id="rId2"/></x:p:sldIdLst></p:presentation>`,
        'ppt/_rels/presentation.xml.rels': rels([
          ['rId1', SLIDE_REL, 'slides/slide%31.xml'],
          ['rId2', SLIDE_REL, 'slides/slide2.xml'],
        ]),
        'ppt/slides/slide1.xml': slide(sp(para(run('Percent target')))),
        'ppt/slides/slide2.xml': '',
      },
    ],
    // legacy numeric order
    [
      'no manifest: numeric order, non-slide names skipped',
      {
        'ppt/slides/slide10.xml': slide(sp(para(run('Ten')))),
        'ppt/slides/slide2.xml': slide(sp(para(run('Two')))),
        'ppt/slides/slide002.xml': slide(sp(para(run('Two again')))),
        'ppt/slides/slideA.xml': slide(sp(para(run('Not a slide')))),
        'ppt/slides/sub/slide1.xml': slide(sp(para(run('Nested')))),
      },
    ],
    // the text walk
    [
      'runs, breaks, tabs, fields, whitespace-only paragraph',
      deck([
        slide(
          sp(
            para(run('Before'), '<a:br/>', run('After'), '<a:tab/>', run('Tabbed')) +
              para('<a:fld id="{1}" type="slidenum"><a:rPr/><a:t>7</a:t></a:fld>', run(' of 9')) +
              para(run('   ')) +
              para('<a:r><a:t>02139</a:t><a:t>&amp;&lt;&#x41;&#66;</a:t></a:r>') +
              '\n  <a:p>\n    <a:r><a:t>Spaced</a:t></a:r>\n  </a:p>',
          ),
        ),
      ]),
    ],
    [
      'markup compatibility: fallback wins, first choice otherwise',
      deck([
        slide(
          `<mc:AlternateContent><mc:Choice Requires="x">${sp(para(run('Choice A')))}</mc:Choice><mc:Fallback>${sp(para(run('Fallback A')))}</mc:Fallback></mc:AlternateContent>` +
            `<mc:AlternateContent><mc:Choice Requires="x">${sp(para(run('Choice B1')))}</mc:Choice><mc:Choice Requires="y">${sp(para(run('Choice B2')))}</mc:Choice></mc:AlternateContent>` +
            sp(
              para(
                run('Inline '),
                `<mc:AlternateContent><mc:Choice>${run('C')}</mc:Choice><mc:Fallback>${run('F')}</mc:Fallback></mc:AlternateContent>`,
              ),
            ),
        ),
      ]),
    ],
    // picture-only
    ['one picture-only slide', deck([slide(pic)])],
    [
      'picture-only deck, several images',
      deck([
        slide(pic + pic),
        slide(
          `<mc:AlternateContent><mc:Choice>${pic}${pic}</mc:Choice><mc:Fallback>${pic}</mc:Fallback></mc:AlternateContent>`,
        ),
      ]),
    ],
    ['picture slide beside a text slide', deck([slide(pic), TEXT_SLIDE, slide('')])],
    ['empty slide, no pictures', deck([slide('<p:sp/>')])],
    // notes
    [
      'notes: body placeholder only, group and compatibility branches',
      deck([TEXT_SLIDE, slide(pic)], {
        'ppt/slides/_rels/slide1.xml.rels': rels([
          ['rId1', NOTES_REL, '../notesSlides/notesSlide1.xml'],
        ]),
        'ppt/slides/_rels/slide2.xml.rels': rels([
          ['rId1', NOTES_REL, '../notesSlides/notesSlide2.xml'],
        ]),
        'ppt/notesSlides/notesSlide1.xml': notes(
          placeholder('sldNum', para(run('1'))) +
            placeholder('body', para(run('Speaker note')) + para(run('Second line'))) +
            placeholder(null, para(run('No type'))) +
            `<p:grpSp>${placeholder('body', para(run('Grouped note')))}</p:grpSp>` +
            `<mc:AlternateContent><mc:Choice>${placeholder('body', para(run('Choice note')))}</mc:Choice><mc:Fallback>${placeholder('body', para(run('Fallback note')))}</mc:Fallback></mc:AlternateContent>`,
        ),
        'ppt/notesSlides/notesSlide2.xml': notes(
          placeholder('body', para(run('Notes on a picture slide'))),
        ),
      }),
    ],
    [
      'notes rels: external, empty target, missing part, other types',
      deck([TEXT_SLIDE, TEXT_SLIDE, TEXT_SLIDE], {
        'ppt/slides/_rels/slide1.xml.rels': rels([
          ['rId1', NOTES_REL, 'http://x/n.xml', 'EXTERNAL'],
          ['rId2', NOTES_REL, '../notesSlides/notesSlide1.xml'],
        ]),
        'ppt/slides/_rels/slide2.xml.rels': rels([
          ['rId1', `${R}/image`, '../media/a.png'],
          ['rId2', NOTES_REL, ''],
        ]),
        'ppt/slides/_rels/slide3.xml.rels': rels([
          ['rId1', NOTES_REL, '../notesSlides/missing.xml'],
        ]),
        'ppt/notesSlides/notesSlide1.xml': notes(placeholder('body', para(run('Reached')))),
      }),
    ],
    // classic comments
    [
      'classic comments: authors, unknown author, no date',
      deck([TEXT_SLIDE, slide(pic)], {
        'ppt/commentAuthors.xml': classicAuthors,
        'ppt/slides/_rels/slide1.xml.rels': rels([
          ['rId1', COMMENTS_REL, '../comments/comment1.xml'],
        ]),
        'ppt/slides/_rels/slide2.xml.rels': rels([
          ['rId1', COMMENTS_REL, '../comments/comment2.xml'],
        ]),
        'ppt/comments/comment1.xml': classicComments(
          '<p:cm authorId="0" dt="2020-01-02T03:04:05.000" idx="1"><p:pos x="1" y="2"/><p:text>Fix &amp; ship</p:text></p:cm>' +
            '<p:cm authorId="1" dt=""><p:text>Blank-named author</p:text></p:cm>' +
            '<p:cm authorId="7"><p:text>Unknown <b>mixed</b> text</p:text></p:cm>' +
            '<p:cm><p:text/></p:cm>',
        ),
        'ppt/comments/comment2.xml': classicComments(
          '<p:cm authorId="0" dt="2021-05-05"><p:text>On a picture</p:text></p:cm>',
        ),
      }),
    ],
    // modern comments
    [
      'modern comments with replies',
      deck([TEXT_SLIDE], {
        'ppt/authors.xml': modernAuthors,
        'ppt/slides/_rels/slide1.xml.rels': rels([
          ['rId3', MODERN_COMMENTS, '../comments/modernComment1.xml'],
        ]),
        'ppt/comments/modernComment1.xml': modernComments(
          modernComment(
            'id="{1}" authorId="{A1}" created="2024-12-30T20:26:06.503"',
            para(run('Needs')) + para(run('more'), '<a:br/>', run('cowbell')),
            '<p188:reply id="{2}" authorId="{B2}" created="2024-12-30T21:00:00.000"><p188:txBody>' +
              para(run('Reply')) +
              '</p188:txBody></p188:reply>' +
              '<p188:reply authorId="{ZZ}"><p188:txBody/></p188:reply>',
          ) + modernComment('authorId=""', para(run('No author id'))),
        ),
      }),
    ],
    [
      'both author tables, the second overrides',
      deck([TEXT_SLIDE], {
        'ppt/commentAuthors.xml': classicAuthors,
        'ppt/authors.xml': `<p188:authorLst xmlns:p188="${P188}"><p188:author id="0" name="Override"/></p188:authorLst>`,
        'ppt/slides/_rels/slide1.xml.rels': rels([
          ['rId1', COMMENTS_REL, '../comments/comment1.xml'],
        ]),
        'ppt/comments/comment1.xml': classicComments(
          '<p:cm authorId="0"><p:text>Which name</p:text></p:cm>',
        ),
      }),
    ],
    // U+017F is not `s` under /i: the relationship is not a comments one
    [
      'comments relationship type ending in a long s',
      deck([TEXT_SLIDE], {
        'ppt/slides/_rels/slide1.xml.rels': rels([
          ['rId1', 'x/comment\u017f', '../comments/comment1.xml'],
        ]),
        'ppt/comments/comment1.xml': classicComments('<p:cm><p:text>not read</p:text></p:cm>'),
      }),
    ],
    // malformed optional parts are skipped
    [
      'malformed comments and authors parts are ignored',
      deck([TEXT_SLIDE, TEXT_SLIDE, TEXT_SLIDE], {
        'ppt/commentAuthors.xml': '<p:cmAuthorLst><p:cmAuthor id="0" name="Ann">',
        'ppt/slides/_rels/slide1.xml.rels': rels([
          ['rId1', COMMENTS_REL, '../comments/comment1.xml'],
        ]),
        'ppt/slides/_rels/slide2.xml.rels':
          '<Relationships><Relationship Id="a" Type="x/comments" Target="../comments/comment2.xml">',
        'ppt/slides/_rels/slide3.xml.rels': rels([
          ['rId1', COMMENTS_REL, '../comments/comment3.xml'],
        ]),
        'ppt/comments/comment1.xml': classicComments(
          '<p:cm authorId="0"><p:text>a & b</p:text></p:cm>',
        ),
        'ppt/comments/comment2.xml': classicComments('<p:cm><p:text>never read</p:text></p:cm>'),
        'ppt/comments/comment3.xml': `${classicComments('<p:cm><p:text>two roots</p:text></p:cm>')}<p:cmLst/>`,
      }),
    ],
    // hidden marks
    [
      'hidden marks in slide, notes and comments become their markers',
      deck(
        [
          slide(
            sp(para(run('Public '), markedRun('Secret', 'hidden words'), run(' end'))) +
              `<p:pic><p:spPr>${mark('Figure')}</p:spPr></p:pic>`,
          ),
        ],
        {
          'ppt/slides/_rels/slide1.xml.rels': rels([
            ['rId1', NOTES_REL, '../notesSlides/notesSlide1.xml'],
            ['rId2', MODERN_COMMENTS, '../comments/modernComment1.xml'],
          ]),
          'ppt/notesSlides/notesSlide1.xml': notes(
            placeholder('body', para(markedRun('Notes label', 'hidden note'))),
          ),
          'ppt/comments/modernComment1.xml': modernComments(
            modernComment('authorId="x"', para(markedRun('Comment label', 'hidden comment'))),
          ),
        },
      ),
    ],
    ['unreadable mark in a slide refuses the deck', deck([slide(sp(para(unlabelledRun('leak'))))])],
    ['mark on a shape refuses the deck', deck([slide(markOnShape)])],
    [
      'unreadable mark in notes refuses the deck',
      deck([TEXT_SLIDE], {
        'ppt/slides/_rels/slide1.xml.rels': rels([
          ['rId1', NOTES_REL, '../notesSlides/notesSlide1.xml'],
        ]),
        'ppt/notesSlides/notesSlide1.xml': notes(placeholder('body', para(unlabelledRun('leak')))),
      }),
    ],
    [
      'unreadable mark in comments is not swallowed',
      deck([TEXT_SLIDE], {
        'ppt/slides/_rels/slide1.xml.rels': rels([
          ['rId1', COMMENTS_REL, '../comments/comment1.xml'],
        ]),
        'ppt/comments/comment1.xml': classicComments(
          `<p:cm><p:text>${PPTX_REDACT_EXT_URI}</p:text></p:cm>`,
        ),
      }),
    ],
    [
      'mark in a malformed comment part refuses the deck',
      deck([TEXT_SLIDE], {
        'ppt/slides/_rels/slide1.xml.rels': rels([
          ['rId1', COMMENTS_REL, '../comments/comment1.xml'],
        ]),
        'ppt/comments/comment1.xml': `<p188:cmLst xmlns:a="${A}"><p188:cm>${markedRun('x', 'y')}`,
      }),
    ],
    // parser refusals
    [
      'slide with an unclosed closing tag',
      deck([slide(sp(para(run('x')))).replace('</p:sld>', '</p:sld')]),
    ],
    ['slide with an unclosed opening tag', deck([`<p:sld xmlns:p="${P}"><p:cSld><a:t x="1 <b>`])],
    ['slide with an unclosed comment', deck([`<p:sld xmlns:p="${P}"><!-- open`])],
    ['slide with an unclosed processing instruction', deck([`<?xml version="1.0"`])],
    ['slide with an unclosed CDATA section', deck([`<p:sld><a:t><![CDATA[x`])],
    ['slide with markup after the document closed', deck([`<a></a></b><c/>`])],
    ['slide with text then a PI after the document closed', deck([`<a></a></b>xx<?pi?>`])],
    ['slide with CDATA after the document closed', deck([`<a></a></b><![CDATA[y]]>`])],
    ['slide with a reserved local name', deck([slide('<a:constructor/>')])],
    ['slide with a reserved closing local name', deck([slide('<a:x></a:prototype>')])],
    ['slide with a #text element that has content', deck([slide('<a:#text>x</a:#text>')])],
    [
      'slide with a self-closing #text element',
      deck([slide(sp(para('<a:r><a:t>kept<a:#text/></a:t></a:r>')))]),
    ],
    ['slide nested past the tag limit', deck([`<p:sld>${'<a:x>'.repeat(120)}`])],
    [
      'presentation that does not parse',
      {
        'ppt/presentation.xml': '<p:presentation><p:sldIdLst',
        'ppt/slides/slide1.xml': TEXT_SLIDE,
      },
    ],
    [
      'presentation with markup after the document closed',
      { 'ppt/presentation.xml': '<a></a></b><c/>', 'ppt/slides/slide1.xml': TEXT_SLIDE },
    ],
    [
      'notes rels that do not parse',
      deck([TEXT_SLIDE], {
        'ppt/slides/_rels/slide1.xml.rels':
          '<Relationships><Relationship Id="a" Type="b" Target="c',
      }),
    ],
    // option mismatches between the docx parser and these parsers
    [
      'slide attribute literally named constructor',
      deck([slide(sp(para(run('Attr')))).replace('<p:sld ', '<p:sld constructor="x" ')]),
    ],
    [
      'comment attribute literally named __proto__',
      deck([TEXT_SLIDE], {
        'ppt/slides/_rels/slide1.xml.rels': rels([
          ['rId1', COMMENTS_REL, '../comments/comment1.xml'],
        ]),
        'ppt/comments/comment1.xml': classicComments(
          '<p:cm __proto__="x" dt="d"><p:text>proto attr</p:text></p:cm>',
        ),
      }),
    ],
    [
      'notes placeholder type repeated across prefixes',
      deck([TEXT_SLIDE], {
        'ppt/slides/_rels/slide1.xml.rels': rels([
          ['rId1', NOTES_REL, '../notesSlides/notesSlide1.xml'],
        ]),
        'ppt/notesSlides/notesSlide1.xml': notes(
          '<p:sp><p:nvSpPr><p:nvPr><p:ph type="body" p:type="title" type="sldNum"/></p:nvPr></p:nvSpPr><p:txBody>' +
            para(run('Which type')) +
            '</p:txBody></p:sp>',
        ),
      }),
    ],
    [
      'slide with a document type declaration',
      deck([`<!DOCTYPE x [<!ENTITY e "Entity text">]>` + slide(sp(para(run('&e;'))))]),
    ],
    [
      'slide whose CDATA opener splits an astral character',
      deck([slide(sp(para('<a:r><a:t><![\u{1F600}x]]></a:t></a:r>')))]),
    ],
    // slide() opens with a version="1.0" declaration, which would reset the version again
    [
      'slide declaring XML 1.1 through a prefixed version',
      deck([`<?xml x:version="1.1"?>` + slide(sp(para(run('a&#1;b')))).replace(DECL, '')]),
    ],
    [
      'slide declaring XML 1.1 then 1.0 through a prefixed version',
      deck([
        `<?xml version="1.1" x:version="1.0"?>` + slide(sp(para(run('a&#1;b')))).replace(DECL, ''),
      ]),
    ],
    [
      'notes and comments declaring XML 1.1 through a prefixed version',
      deck([TEXT_SLIDE], {
        'ppt/slides/_rels/slide1.xml.rels': rels([
          ['rId1', NOTES_REL, '../notesSlides/notesSlide1.xml'],
          ['rId2', COMMENTS_REL, '../comments/comment1.xml'],
        ]),
        'ppt/notesSlides/notesSlide1.xml':
          `<?xml p:version="1.1"?>` +
          notes(placeholder('body', para(run('note a&#1;b')))).replace(DECL, ''),
        'ppt/comments/comment1.xml': `<?xml p:version="1.1"?><p:cmLst xmlns:p="${P}"><p:cm><p:text>comment a&#1;b</p:text></p:cm></p:cmLst>`,
      }),
    ],
    [
      'notes placeholder type: repeated raw name after a prefixed alias',
      deck([TEXT_SLIDE], {
        'ppt/slides/_rels/slide1.xml.rels': rels([
          ['rId1', NOTES_REL, '../notesSlides/notesSlide1.xml'],
        ]),
        'ppt/notesSlides/notesSlide1.xml': notes(
          '<p:sp><p:nvSpPr><p:nvPr><p:ph type="title" p:type="sldNum" type="body"/></p:nvPr></p:nvSpPr><p:txBody>' +
            para(run('Body wins in source order')) +
            '</p:txBody></p:sp>',
        ),
      }),
    ],
    [
      'slide with a dangerous local name',
      deck([slide(sp(para('<a:r><a:toString>x</a:toString><a:t>after</a:t></a:r>')))]),
    ],
  ]
  const inputs: Input[] = []
  inputs.push({
    label: 'test fixture deck (legacy order)',
    bytes: await fixedFixtureBytes(await buildPptxFixture()),
  })
  for (const [label, parts] of cases) inputs.push({ label, bytes: await zip(parts) })

  const brokenSlide = await zip(deck([TEXT_SLIDE, slide(sp(para(run('x'.repeat(200)))))]))
  inputs.push({
    label: 'slide part that does not inflate',
    bytes: breakEntry(brokenSlide, 'ppt/slides/slide2.xml'),
  })
  const brokenComments = await zip(
    deck([TEXT_SLIDE], {
      'ppt/commentAuthors.xml': classicAuthors,
      'ppt/slides/_rels/slide1.xml.rels': rels([
        ['rId1', COMMENTS_REL, '../comments/comment1.xml'],
      ]),
      'ppt/comments/comment1.xml': classicComments(
        '<p:cm authorId="0"><p:text>unreadable</p:text></p:cm>',
      ),
    }),
  )
  inputs.push({
    label: 'comments part that does not inflate',
    bytes: breakEntry(brokenComments, 'ppt/comments/comment1.xml'),
  })
  inputs.push({
    label: 'authors part that does not inflate',
    bytes: breakEntry(brokenComments, 'ppt/commentAuthors.xml'),
  })
  inputs.push({
    label: 'slide rels part that does not inflate',
    bytes: breakEntry(brokenComments, 'ppt/slides/_rels/slide1.xml.rels'),
  })
  inputs.push({ label: 'not a zip', bytes: new TextEncoder().encode('not a zip at all') })
  inputs.push({ label: 'empty archive', bytes: await zip({}) })
  inputs.push(...hostileZipInputs())
  return inputs
}

export const SPECS: Spec[] = [
  {
    fn: 'pptxToText',
    extensions: ['pptx'],
    built,
    call: (input) => pptxToText(input.bytes!),
  },
]
