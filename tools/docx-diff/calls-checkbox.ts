// Group `checkbox` of comparison (f): checkbox-control.ts, the content-control
// checkboxes (w14:checkbox) and their glyphs.
import {
  isOn,
  sdtCheckboxControl,
  sdtCheckboxGlyphs,
  sdtCheckboxIsChecked,
  syncSdtCheckbox,
} from './reference/checkbox-control'
import { nameOf, xmlParser, type XNode } from './reference/xml-utils'
import type { CallSpec, Input } from './calls-spec'
import { elementFragments } from './fragments'

/** Every element called `name` in the .xml parts of a document. */
const fragmentsOf = (parts: ReadonlyMap<string, string>, name: string): string[] =>
  [...parts]
    .filter(([path]) => path.endsWith('.xml'))
    .flatMap(([, text]) => elementFragments(text, name))

const texts = (list: readonly string[]): Input[] => list.map((text) => ({ text }))

const state = (name: string, val: string, quote = '"'): string =>
  `<w14:${name} w14:val=${quote}${val}${quote} w14:font="MS Gothic"/>`

const checkbox = (inner: string): string => `<w14:checkbox>${inner}</w14:checkbox>`

const sdtPr = (inner: string): string => `<w:sdtPr>${inner}</w:sdtPr>`

/** Hex values of a glyph: Word's, astral, surrogate halves, bounds, garbage, prefixes. */
const HEXES = [
  '2612',
  '2610',
  '00FE',
  'a8',
  '0xA8',
  '0X2612',
  ' 2612',
  '+2612',
  '-2612',
  '2612zz',
  '1F600',
  '1f600',
  '10FFFF',
  '110000',
  'D800',
  'DFFF',
  'D7FF',
  'E000',
  '0',
  '-0',
  '',
  'zz',
  'ffffffffffffffffffff',
  '\u00a02612',
  '\ufeff2612',
  '2612.5',
]

const CHECKED_VALUES = [
  '1',
  '0',
  'true',
  'false',
  'on',
  'off',
  'TRUE',
  'On',
  'yes',
  '',
  ' 1',
  'tRuE',
]

const SDT_PRS: string[] = [
  '',
  sdtPr(''),
  '<w:sdtPr/>',
  sdtPr(checkbox('')),
  sdtPr('<w14:checkbox/>'),
  sdtPr(
    '<w:id w:val="1"/>' +
      checkbox(
        `<w14:checked w14:val="1"/>${state('checkedState', '2612')}${state('uncheckedState', '2610')}`,
      ),
  ),
  sdtPr(
    checkbox(
      `<w14:checked w14:val="0"/>${state('checkedState', '2611')}${state('uncheckedState', '25A1')}`,
    ),
  ),
  sdtPr(checkbox(`<w14:checked/>${state('checkedState', '00FE')}`)),
  sdtPr(checkbox(`${state('uncheckedState', '1F600', "'")}${state('checkedState', '1F44D', "'")}`)),
  ...HEXES.map((hex) =>
    sdtPr(checkbox(`${state('checkedState', hex)}${state('uncheckedState', hex)}`)),
  ),
  ...CHECKED_VALUES.map((val) => sdtPr(checkbox(`<w14:checked w14:val="${val}"/>`))),
  // the value attribute is not the first, or is spelled differently
  sdtPr(checkbox('<w14:checkedState w14:font="Wingdings" w14:val="00FE"/>')),
  sdtPr(checkbox('<w14:checkedState w14:font="Wingdings" val="00FE"/>')),
  sdtPr(checkbox('<w14:checkedState w14:val = "00FE"/>')),
  sdtPr(checkbox('<w14:checkedState xw14:val="00FE"/>')),
  sdtPr(checkbox('<w14:checkedStateX w14:val="00FE"/><w14:checkedState w14:val="2611"/>')),
  sdtPr(checkbox('<w14:checkedState\nw14:val="2714"/>')),
  sdtPr(checkbox('<w14:checkedState w14:val="2714"></w14:checkedState>')),
  // legacy form fields and other controls
  sdtPr('<w:checkbox><w:default w:val="1"/></w:checkbox>'),
  sdtPr('<w:text/><w:tag w:val="checkbox"/>'),
  sdtPr('<w14:checkbox w14:x="1"><w14:checked w14:val="1"/></w14:checkbox>'),
  sdtPr('<w14:checkbox w14:x="1"/>'),
  sdtPr('<w14:checkbox\t/>'),
  sdtPr('<w14:checkboxX/><w14:checkbox/>'),
  sdtPr(checkbox('<w14:checked w14:val="1"/><w14:checked w14:val="0"/>')),
  sdtPr(checkbox('<w14:checked w14:val="1" />')),
  sdtPr(checkbox('<w14:checked w14:val="1"></w14:checked>')),
  sdtPr(checkbox('<w14:checkedX w14:val="1"/>')),
  sdtPr(`${checkbox('<w14:checked w14:val="0"/>')}${checkbox('<w14:checked w14:val="1"/>')}`),
  // malformed
  '<w:sdtPr><w14:checkbox>',
  '<w:sdtPr><w14:checkbox/></w:sdt>',
  '<w14:checkbox w14:val="1">',
  '<w:sdtPr><w14:checkedState w14:val="2612/></w:sdtPr>',
  '<w:sdtPr><w14:checkedState w14:val=\'2612"/></w:sdtPr>',
  '<w:sdtPr>&bogus;<w14:checkbox/></w:sdtPr>',
]

const sdt = (
  pr: string,
  content = '<w:sdtContent><w:r><w:t>\u2610</w:t></w:r></w:sdtContent>',
): string => `<w:sdt>${pr}${content}</w:sdt>`

const SDTS: string[] = [
  ...SDT_PRS.map((pr) => sdt(pr)),
  sdt(sdtPr(checkbox('<w14:checked w14:val="1"/>')), ''),
  sdt(
    sdtPr(
      '<w:rPr><w:rFonts w:ascii="MS Gothic" w:hAnsi="&amp;&lt;x&gt;"/></w:rPr>' +
        checkbox(`<w14:checked w14:val="true"/>${state('checkedState', '2612')}`),
    ),
  ),
  sdt(sdtPr(`<w:alias w:val="a &quot;b&quot; 'c'"/>${checkbox('<w14:checked w14:val="1"/>')}`)),
  sdt(sdtPr(`<!-- note -->${checkbox('<w14:checked w14:val="1"/>')}`)),
  sdt(sdtPr(`<w:tag w:val="x"> text &amp; more </w:tag>${checkbox('')}`)),
  `<w:p/>${sdt(sdtPr(checkbox('<w14:checked w14:val="1"/>')))}`,
  `<w:body>${sdt(sdtPr(checkbox('<w14:checked w14:val="1"/>')))}</w:body>`,
  `${sdt(sdtPr(checkbox('')))}${sdt(sdtPr(checkbox('<w14:checked w14:val="1"/>')))}`,
  '<w:sdt/>',
  '<w:sdt><w:sdtPr/></w:sdt>',
  '<w:sdt><w14:checkbox/></w:sdt>',
  '<w:sdt><w:sdtPr><w:sdtPr><w14:checkbox/></w:sdtPr></w:sdtPr></w:sdt>',
  'plain text',
  '',
  '<w:sdt><w:sdtPr><w14:checkbox></w:sdtPr></w:sdt>',
  '<w:sdt><w:sdtPr><w14:checkbox/></w:sdtPr>',
  `<w:sdt>${'<w:x>'.repeat(120)}${'</w:x>'.repeat(120)}</w:sdt>`,
]

/** Glyphs set against a declaration: its own pair, the fallback list, and neither. */
const GLYPHS = [
  '\u2612',
  '\u2610',
  '\u2611',
  '\u2713',
  '\u2714',
  '\u2705',
  '\u00fe',
  '\u{1F600}',
  '\u{1F44D}',
  '\u25a1',
  'x',
  '',
  '\u2612\u2610',
  'a\u2611',
  '\u2612\ufe0f',
]

export const CHECKBOX: CallSpec[] = [
  {
    fn: 'checkbox.isOn',
    call: (text, args) => isOn(args.missing ? undefined : text),
    built: [
      ...texts([...CHECKED_VALUES, 'ON', 'True', 'o\u0307n', '\u0130', 'tr\u00fce', '\u2160']),
      { text: '', args: { missing: true } },
    ],
  },
  {
    fn: 'checkbox.sdtCheckboxGlyphs',
    call: (text) => sdtCheckboxGlyphs(text),
    fromDocument: (parts) => texts(fragmentsOf(parts, 'w:sdtPr')),
    built: texts(SDT_PRS),
  },
  {
    fn: 'checkbox.sdtCheckboxControl',
    // the first top-level w:sdt, or `{}` where there is none
    call: (text) =>
      sdtCheckboxControl(
        (xmlParser.parse(text) as XNode[]).find((node) => nameOf(node) === 'w:sdt') ?? {},
      ),
    fromDocument: (parts) => texts(fragmentsOf(parts, 'w:sdt')),
    built: texts(SDTS),
  },
  {
    fn: 'checkbox.sdtCheckboxIsChecked',
    call: (text, args) => sdtCheckboxIsChecked(text, String(args.glyph)),
    fromDocument: (parts) =>
      fragmentsOf(parts, 'w:sdtPr').flatMap((text) =>
        ['\u2612', '\u2610', 'x'].map((glyph) => ({ text, args: { glyph } })),
      ),
    built: SDT_PRS.flatMap((text) => GLYPHS.map((glyph) => ({ text, args: { glyph } }))),
  },
  {
    fn: 'checkbox.syncSdtCheckbox',
    call: (text, args) => syncSdtCheckbox(text, args.checked === true),
    fromDocument: (parts) =>
      fragmentsOf(parts, 'w:sdtPr').flatMap((text) =>
        [true, false].map((checked) => ({ text, args: { checked } })),
      ),
    built: [
      ...SDT_PRS,
      sdtPr('<w14:checkbox><w14:checked w14:val="1"/><w14:checked/></w14:checkbox>'),
      sdtPr('<w14:checkbox w14:a="1"><w14:checked\tw14:val="0" /></w14:checkbox>'),
      sdtPr('<w14:checkbox w14:a="/>"/>'),
      sdtPr('<w14:checkbox$1/>'),
      sdtPr('<w14:checkbox a="$&"/>'),
      sdtPr('<w14:checked w14:val="1"/><w14:checkbox/>'),
      sdtPr('<w14:checkedState w14:val="2612"/>'),
      '<w14:checkbox/><w14:checkbox/>',
      '<w14:checkbox><w14:checkbox/>',
      '<w14:checkbox>',
      '<w14:checkboxed/>',
    ].flatMap((text) => [true, false].map((checked) => ({ text, args: { checked } }))),
  },
]
