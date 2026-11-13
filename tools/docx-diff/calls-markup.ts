// Spellings of one XML document that a reader of literal tags gets wrong, for
// the specs of the readers that follow the markup: xml-tag.ts's segment
// scanner and ooxml-normalize.ts's canonicalXmlSyntax, and everything that
// reads a part through them. An XML parser reads each of these the same as
// the plain spelling: the markup inside a comment, a CDATA section or a
// processing instruction is no markup, a `>` inside a quoted attribute value
// does not end its tag, an end tag may hold white space before its `>`, and
// an attribute may be single-quoted with white space around its `=`.

/** `markup` where an XML parser reads none: in a comment, in CDATA, in a processing instruction. */
export const hiddenIn = (markup: string): string[] => [
  `<!-- ${markup} -->`,
  `<![CDATA[${markup}]]>`,
  `<?probe ${markup}?>`,
]

/** The tags the save and the readers cut by. */
export const SEGMENT_TAGS = [
  'w:drawing',
  'w:txbxContent',
  'mc:Fallback',
  'w:p',
  'w:pPr',
  'w:t',
  'w:tr',
]

export interface SegmentCase {
  text: string
  tag: string
}

/**
 * Texts where a literal search for `tag` finds an element other than the one
 * the markup holds: a tag hidden in a comment, CDATA or an instruction before
 * the element or inside it, an end tag with white space before its `>`, a `>`
 * in a quoted attribute value (both quotes, a `/` before it), single-quoted
 * and spaced attributes, a start tag never closed.
 */
export const SEGMENT_CASES: SegmentCase[] = SEGMENT_TAGS.flatMap((tag) => {
  const open = `<${tag}>`
  const close = `</${tag}>`
  return [
    ...hiddenIn(open).map((hidden) => `<w:p>${hidden}${open}a${close}b</w:p>`),
    ...hiddenIn(close).map((hidden) => `<w:p>${open}a${hidden}b${close}c</w:p>`),
    ...hiddenIn(`${open}x${close}`).map((hidden) => `<w:p>${hidden}tail</w:p>`),
    ...hiddenIn(`${open}x${close}`).map((hidden) => `<w:p>${hidden}${open}own${close}</w:p>`),
    `<w:p>${open}a</${tag} >b</w:p>`,
    `<w:p>${open}a</${tag}\n>b${open}c</${tag}\t >d</w:p>`,
    `<w:p>${open}a</${tag}\u3000>b</w:p>`,
    `<w:p><${tag} a=">">a${close}b<${tag} b='>' c="'>">c${close}</w:p>`,
    `<w:p><${tag} a="x/>y"/>t<${tag}/></w:p>`,
    `<w:p><${tag} a = "1"  b = '2'>a${close}</w:p>`,
    `<w:p><${tag} a="open>${close}</w:p>`,
    `<w:p>${open}a${open}b</${tag} >c${close}d</w:p>`,
    `<!-- ${open} --><${tag} a='1'>one</${tag} ><![CDATA[</${tag}>]]>${open}two${close}`,
  ].map((text) => ({ text, tag }))
})

/** Elements whose inner XML `elementInner` reads. */
export const INNER_TEXTS = [
  '',
  'plain text',
  '<w:tc>x</w:tc>',
  '<w:tc/>',
  '<w:tc />',
  '<w:tc a="/"/>',
  '<w:tc a=">">in</w:tc>',
  "<w:tc a='>'>in</w:tc >",
  '<w:tc>a<!-- </w:tc> -->b</w:tc>',
  '<w:tc>a<![CDATA[</w:tc>]]>b</w:tc>',
  '<w:tc>a<?probe </w:tc>?>b</w:tc>',
  '<!-- <w:x> --><w:tc>a</w:tc>',
  '<?probe <w:x>?><w:tc>a</w:tc>',
  '<w:tc>a</w:tc></w:tr>',
  '<w:tc>nested<w:tc>x</w:tc>y</w:tc>',
  '<w:tc>no close',
  '<w:tc>a</w:tc\n>',
  '<w:tbl><w:tr><w:tc>a</w:tc></w:tr></w:tbl>',
  '<w:p w:x=">"><w:pPr/><w:r/></w:p>',
  '\u{1F600}<w:tc>\u{1F600}</w:tc>',
]

/** Texts for `canonicalXmlSyntax`: every spelling it rewrites, and text it leaves. */
export const CANONICAL_TEXTS = [
  '',
  'plain text',
  'a < b > c',
  'text <not a tag',
  '<w:p w:rsidR="00A1"><w:r><w:t>x</w:t></w:r></w:p>',
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document/>',
  '<?xml\tversion="1.0"?><a/>',
  '<?xml?><a/>',
  '<?xml-stylesheet href="a"?><a/>',
  '<?probe x?><a/><?probe?>',
  '<?unterminated',
  '<a><!-- c --></a>',
  '<a><!-- unterminated',
  '<!-->x-->',
  '<!---->',
  '<a><![CDATA[x<y&z>w]]></a>',
  '<a><![CDATA[]]></a>',
  '<![CDATA[ unterminated',
  '<a><![CDATA[<b c="d"/>]]></a>',
  '</a >',
  '</a\n>',
  '</ns:a  \t >',
  '</a\u3000>',
  '</a>',
  '</ >',
  '</a b>',
  '</a',
  "<a b='c'/>",
  '<a b = "c" d  =  \'e\' />',
  '<a b="x>y"/>',
  "<a b='x>y'/>",
  "<a b='x\"y'>",
  '<a b="x\'y">',
  '<a b>',
  '<a b c="d">',
  '<a  b="1"   c="2"/>',
  '<a b="1"c="2"/>',
  '<a b="1" />',
  '<a b="1" / >',
  '<a/>',
  '<a />',
  '<a\n/>',
  '<a b="unterminated',
  "<a b='x",
  '<a"b c="d">',
  '<a"b" c="d">',
  '<a b="1"\'c d="2">',
  '<1a b="c"/>',
  '< a b="c">',
  '<_a b = "c"/>',
  '<a:b-c.d e:f = "g"/>',
  '<a b="x<y"/>',
  '<a b="&amp;&gt;"/>',
  '<a\u00A0b = "c"/>',
  '<a\u3000b="c"\u3000/>',
  '<a b = "">',
  "<a b=''>",
  '<a b="1" c=\'>\' d="\'">',
  '\u{1F600}<a b = \'\u{1F600}>\'/>',
  "<w:t xml:space = 'preserve'>x</w:t >",
  "<w:p><!-- <w:t a='1'>hidden</w:t > --><w:r><w:t>shown</w:t></w:r><![CDATA[<w:t>x</w:t>]]></w:p>",
  '<a b="1" c="2" d="3" e="4" f="5" g="6" h="7">',
  '<a b="1">x</a><b c = "2">y</b >',
  '<a b="x"/><a b = "x"/>',
]
