import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { repoRoot } from '../docx-diff/harness'
import { redactHtmlSource } from './reference/html-redaction'
import { SOURCE_ELEMENTS_TEXT } from './host-steps-fileparse'
import type { Input, Spec } from './spec'

const PAGES: Record<string, string> = {
  plain: '<html><body><p>nothing marked</p></body></html>',
  own: '<p data-gx-redact="Salary">12,000</p><p>left</p>',
  ownSingle: "<div data-gx-redact='Name'><b>Kim</b> Jisoo</div>",
  ownBare: '<span data-gx-redact=Secret>x</span>',
  ownEmptyLabel: '<span data-gx-redact="">hidden</span>',
  ownValueless: '<span data-gx-redact>hidden</span>',
  ownUpper: '<span DATA-GX-REDACT="Name">hidden</span>',
  ownEmptyContent: '<span data-gx-redact="Name"></span>after',
  attribute: '<img data-gx-redact-src="Photo" src="https://example.com/me.png" alt="me">',
  attributeUnmarkedLabel: '<a data-gx-redact-href href="https://example.com/x">link</a>',
  attributeEmpty: '<img data-gx-redact-src="Photo" src="">',
  attributeMissing: '<img data-gx-redact-src="Photo" alt="x">',
  attributeUpper: '<img DATA-GX-REDACT-SRC="Photo" SRC="https://example.com/me.png">',
  attributeTargetUpper: '<img data-gx-redact-src="Photo" SRC="https://example.com/me.png">',
  attributeBareValue: '<input data-gx-redact-value="Code" value=1234>',
  script: '<script>const key = /*gx:redact:API key*/ "sk-123";</script>',
  scriptTemplate: '<script>const t = /*gx:redact:Body*/ `multi\nline`;</script>',
  scriptEscaped: '<script>const s = /*gx:redact:Quote*/ "a \\" b";</script>',
  scriptNoLiteral: '<script>/*gx:redact:Nothing*/ const n = 1;\n</script>',
  scriptLiteralPast: '<script>/*gx:redact:Far*/</script><p>"not in script"</p>',
  scriptMarkOutside: '<p>/*gx:redact:Text*/ "kept"</p>',
  scriptNewline: '<script>/*gx:redact:Broken*/ "line\nbreak";</script>',
  nested: '<div data-gx-redact="Outer"><span data-gx-redact="Inner">a</span> b</div>',
  overlap:
    '<p data-gx-redact="Row"><img data-gx-redact-src="Pic" src="https://example.com/a.png"></p>',
  template: '<template><p data-gx-redact="Tpl">inside a template</p></template>',
  adoption: '<b data-gx-redact="Bold"><p>misnested</b> text</p>',
  implicitEnd: '<ul><li data-gx-redact="Item">one<li>two</ul>',
  table: '<table><tr><td data-gx-redact="Cell">x</td></tr></table>',
  comment: '<!-- data-gx-redact="Comment" --><p>no element mark</p>',
  textOnly: 'gx:redact: as words only',
  labelCleaning: '<p data-gx-redact="a*b/c {d} <e> \'f\' \n g">x</p>',
  labelLong: `<p data-gx-redact="${'가'.repeat(60)}">x</p>`,
  astralBefore: '<p>😀😀</p><p data-gx-redact="Emoji">after astral</p>',
  koreanBefore: '<p>한국어 문장</p><img data-gx-redact-alt="Alt" alt="설명">',
  entityBefore: '<p>&amp;&nbsp;&notin;</p><p data-gx-redact="E">x</p>',
  duplicateAttr: '<p data-gx-redact="A" data-gx-redact="B">x</p>',
  selfClosing: '<br data-gx-redact="Br"/><p>after</p>',
  rawText: '<textarea data-gx-redact="T">a <b>not</b> tag</textarea>',
  styleMark: '<style>/*gx:redact:Css*/ "x"</style>',
  unclosed: '<div data-gx-redact="Open">never closed',
  doctype:
    '<!DOCTYPE html><html lang="ko"><head><title data-gx-redact="Title">t</title></head></html>',
}

function built(): Input[] {
  const source = readFileSync(
    resolve(repoRoot, 'tools/fileparse-diff/reference/html-redaction.ts'),
    'utf8',
  )
  // the host step is a copy of sourceElements: the copy must still be the code
  if (!source.includes(SOURCE_ELEMENTS_TEXT)) {
    throw new Error(
      'html-redaction.ts no longer holds the sourceElements that host-steps-fileparse.ts copies',
    )
  }
  return Object.entries(PAGES).map(([label, text]) => ({ label, text }))
}

export const SPECS: Spec[] = [
  {
    fn: 'redactHtmlSource',
    extensions: ['html', 'htm'],
    mutateText: true,
    call: ({ text = '' }) => redactHtmlSource(text),
    built,
  },
]
