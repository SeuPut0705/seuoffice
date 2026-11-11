const body = (inner: string): string => `<w:document><w:body>${inner}</w:body></w:document>`

export const SCAN_CASES: Record<string, string> = {
  plain: body('<w:p/><w:tbl><w:tr/></w:tbl><w:sectPr/>'),
  'non-BMP before the body':
    '<?xml version="1.0"?><!-- \u{1F600}\u{1F600} --><w:document a="\u{1F600}\u{D55C}\u00E9"><w:body><w:p><w:r><w:t>x</w:t></w:r></w:p><w:sectPr/></w:body></w:document>',
  'non-BMP inside the body': body(
    '<w:p><w:r><w:t>\u{1F600}</w:t></w:r></w:p><!-- \u{1F9EA} --><w:p a="\u{10FFFF}"><w:r><w:t>\u{D55C}\u00E9\u{1F600}</w:t></w:r></w:p><w:sectPr/>',
  ),
  'lone surrogates': `\uD83D${body('<w:p>\uDC00</w:p><w:p a="\uD800"/>')}`,
  'CDATA inside text elements': body(
    '<w:p><w:r><w:t><![CDATA[a<b]]></w:t><w:delText><![CDATA[x]]></w:delText><w:instrText><![CDATA[y]]></w:instrText><w:delInstrText><![CDATA[z]]></w:delInstrText></w:r><a:t><![CDATA[1]]></a:t><m:t><![CDATA[2]]></m:t></w:p>',
  ),
  'CDATA outside text elements': body(
    '<![CDATA[top]]><w:p><![CDATA[in p]]><w:r><![CDATA[in r]]><w:t>x<w:x><![CDATA[below w:t]]></w:x></w:t></w:r></w:p>',
  ),
  'comments and processing instructions': body(
    '<!-- <w:p>fake</w:p> --><?pi <w:p/> ?><w:p><!-- in p --><?pi?></w:p><!---->',
  ),
  'opaque regions before the body are dropped':
    '<!-- before --><?before?><w:document><![CDATA[before]]><w:body><w:p/></w:body><!-- after --></w:document>',
  'DOCTYPE with an internal subset':
    '<!DOCTYPE w:document [<!ENTITY e "<w:body>]"> <!-- > --> ]><w:document><w:body><w:p/></w:body></w:document>',
  'declaration inside the body': body('<!ELEMENT x "a>b"><w:p/><!x [ [ ] > ] >'),
  'unterminated comment': '<w:document><w:body><w:p/><!-- never closed <w:p/>',
  'unterminated CDATA': '<w:document><w:body><w:p/><![CDATA[never closed',
  'unterminated processing instruction': '<w:document><w:body><w:p/><?never closed',
  'unterminated declaration': '<w:document><w:body><w:p/><!DOCTYPE [ "',
  'unterminated tag': '<w:document><w:body><w:p/><w:p a="x>',
  'unterminated tag that looks self-closing': '<w:document><w:body><w:p a="x/>',
  'gt inside attribute values': body(`<w:p a=">" b='/>'><w:r c="</w:p>"/></w:p>`),
  'self-closing body': '<w:document><w:body/></w:document>',
  'self-closing body then a real body': '<w:document><w:body/><w:body><w:p/></w:body></w:document>',
  'several bodies':
    '<w:document><w:body><w:p>1</w:p></w:body><w:body><w:p>2</w:p></w:body><w:body><w:p>3</w:p></w:body></w:document>',
  'unclosed body': '<w:document><w:body><w:p/><w:tbl>',
  'empty body': body(''),
  'body with only text': body(' text '),
  'body with only opaque regions': body('<!-- a --><?b?>'),
  'mismatched closing names': body('<w:p><w:r></w:p></w:r><w:p/>'),
  'closing body tag below an open element': body('<w:p></w:body><w:r/></w:p>'),
  'stray closing tag': body('</w:p>'),
  'stray closing tag with no name': body('</>'),
  'stray closing tag with a non-ASCII name': body('</\u00E9l>'),
  'no body': '<w:document><w:p/></w:document>',
  'empty string': '',
  'body tag variants':
    '<w:document><w:bodyPr/><W:BODY/><w:body.x/>< w:body><w:p/></w:body></w:document>',
  'whitespace after the opening bracket':
    '<w:document><\u00A0w:body><w:p/></\uFEFFw:body><w:p/></w:document>',
  'attributes on the body':
    '<w:document><w:body xmlns:w="urn:x" a=">"><w:p/></w:body></w:document>',
  'names the scanner cannot read': body('<1a/><\u00E9l>x</\u00E9l><w:p\u00E9/><>x</>'),
  'text only': 'no tags at all',
  'a lone opening bracket': body('<w:p/><'),
}

const rPr = (inner: string): string => `<w:rPr>${inner}</w:rPr>`

export const XML_CASES: Record<string, string[]> = {
  'run properties': [
    rPr('<w:b/><w:i w:val="0"/><w:sz w:val="24"/>'),
    '<w:rPr/>',
    '<w:rPr />',
    '<w:rPr></w:rPr>',
  ],
  entities: [
    rPr('<w:rFonts w:ascii="a&amp;b&lt;c&gt;d&quot;e&apos;f"/>'),
    rPr('<w:x a="&#65;&#x41;&#X41;&#0065;"/>text &#65; &#x1F600;'),
    rPr('<w:x a="[&#0;][&#x0;][&#-0;][&#1;][&#8;][&#9;][&#10;][&#11;][&#13;][&#x1F;][&#32;]"/>'),
    rPr('<w:x a="[&#xD800;][&#xDFFF;][&#55296;][&#xE000;][&#x110000;][&#99999999999;][&#-1;]"/>'),
    rPr('<w:x a="[&#x0x9;][&#x0x1;][&# 1;][&#+1;][&#1z;][&#x1g;][&#;][&#x;][&#xg;]"/>'),
    rPr('<w:x a="&nbsp;&unknown;&;&amp&lt &AMP; &amp;amp; &amp;#0;"/>'),
    rPr(
      `<w:x a="&${'a'.repeat(32)};&${'a'.repeat(33)};&#0${' '.repeat(29)};&#0${' '.repeat(30)};"/>`,
    ),
    rPr(
      `<w:x a="&#0${'\u{1F600}'.repeat(15)};&#0${'\u{1F600}'.repeat(14)}xx;&#0${'\u{1F600}'.repeat(14)}x;"/>`,
    ),
    rPr('a &amp; b &lt;c&gt; &quot;d&quot; &#1; &#x41;'),
    '<w:t>&#1;</w:t>',
    '<w:t>a &amp; &lt;b&gt; &quot;</w:t>',
    '<?xml version="1.1"?>' + rPr('<w:x a="[&#1;][&#0;][&#xD800;]"/>'),
    '<?xml version="1.1"?><?other a="b"?>' + rPr('<w:x a="[&#1;]"/>'),
    '<?xml version=" 1.10 "?><?other?>' + rPr('<w:x a="[&#1;]"/>'),
  ],
  'whitespace and tag forms': [
    rPr('<w:b\t/><w:i\n/><w:u\tw:val="a\tb"\t/><w:x\u00A0a="1"/>'),
    rPr(' <w:b/> \n\t<w:i/> '),
    '  <w:rPr><w:b/></w:rPr>  ',
    'text before<w:rPr/>text after',
    'text before</w:x>text after',
    rPr('<w:x a="1\r\n2\r3\n4">a\r\nb\rc</w:x>'),
    '< w:rPr><w:b/></ w:rPr>',
    '<>x</><w:b/>',
    '<w:rPr/ ><w:b/>',
    '<w:x/ a="1"/>',
    '<w:x a="1" / >',
    '<w:x a="/"/>',
    '<w:x a="1"//>',
  ],
  attributes: [
    rPr(`<w:x a='single' b = "spaced" c= 'd' e ="f"/>`),
    rPr('<w:x a="1" a="2" b="3" a="4"/>'),
    rPr('<w:x novalue a="1" bare=unquoted b="2" c=/>'),
    rPr(`<w:x a="it's" b='say "hi"' c="<>&amp;"/>`),
    rPr(
      '<w:x 10="ten" b="b" 2="two" 0="zero" 01="not an index" 4294967294="max" 4294967295="past max" a="a"/>',
    ),
    rPr('<w:x toString="1" valueOf="2" hasOwnProperty="3" __defineGetter__="4"/>'),
    rPr('<w:x constructor="1"/>'),
    rPr('<w:x __proto__="1"/>'),
    rPr('<w:x prototype/>'),
    rPr('<w:x a="unterminated/>'),
    rPr('<w:x a=">"/><w:y b=\'>\'/>'),
    rPr('<w:x a="\u{1F600}\u{D55C}" \u{1F600}="b" \u00E9="c"/>'),
    rPr('<w:x a="\u0001\u0008\u000B\u001F tab\there"/>'),
  ],
  'names the parser renames or rejects': [
    '<toString/><valueOf a="1"></valueOf><hasOwnProperty/>',
    '<constructor/>',
    '<constructor a="1"></constructor>',
    '<prototype>',
    '<__proto__/>',
    '<a></constructor>',
    '<a></ prototype >',
    '<#text/>',
    '<#text>',
    '<:@ a="1">x</:@><w:b/>',
  ],
  'text, comments, CDATA, processing instructions': [
    rPr('a<!-- comment -->b<w:b/>c<!-- <w:i/> -->d'),
    rPr('<![CDATA[a<b&amp;]]><w:b/><![CDATA[]]>'),
    rPr('x<![CDATA[y]]>z'),
    '<![CDATA[top level]]><w:b/>',
    'text<![CDATA[x]]>',
    '<![]]>',
    '<![x]]>',
    '<![CDATA]]>',
    '<![\u{1F600}\u{1F600}\u{1F600}x]]>',
    '<![\u00E9\u00E9\u00E9\u00E9\u00E9\u00E9x]]>',
    rPr('<?pi a="1" b?>x<?empty?><??>'),
    'text<?pi?><w:b/>',
    '<?pi constructor="1"?>',
    '<!---->x<!-->y--><w:b/>',
    '<w:a>x<!--y-->z</w:a>',
    '<!ELEMENT x><w:b/>',
    '<!x a="1"/>',
  ],
  structure: [
    '<w:a><w:b></w:a></w:b><w:c/>',
    '<w:a><w:b>text',
    '<w:a>text</w:a>trailing',
    '</w:a>',
    '</w:a>text</w:b><!-- c -->',
    '</w:a><w:b/>',
    '</w:a><w:b>',
    '</w:a><?pi?>',
    '</w:a><![CDATA[x]]>',
    'x</w:a><w:b/>',
    '<w:a/></w:a></w:a>text',
  ],
  'unterminated input': [
    '<w:a',
    '<w:a b="c',
    '<w:a/><',
    '</w:a',
    '<!-- never',
    '<![CDATA[never',
    '<?never',
    '<w:a><!--',
  ],
  'nesting limit': [
    ...[99, 100, 101, 102, 103].map((depth) => '<a>'.repeat(depth) + 'x' + '</a>'.repeat(depth)),
    ...[100, 101, 102].map((depth) => '<a>'.repeat(depth) + '<b/>'),
  ],
  'no markup': ['', 'plain text only', '\uFEFF<w:rPr/>'],
}

function bytes(...parts: Array<string | number[]>): Uint8Array {
  return Buffer.concat(
    parts.map((part) => (typeof part === 'string' ? Buffer.from(part) : Buffer.from(part))),
  )
}

export function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function bytesBiasedToUtf8LeadsAndContinuations(length: number, seed: number): Uint8Array {
  const random = mulberry32(seed)
  const pick = (low: number, high: number): number => low + Math.floor(random() * (high - low + 1))
  const out = new Uint8Array(length)
  for (let i = 0; i < length; i++) {
    const kind = random()
    out[i] =
      kind < 0.3
        ? pick(0x20, 0x7e)
        : kind < 0.6
          ? pick(0x80, 0xbf)
          : kind < 0.75
            ? pick(0xc0, 0xdf)
            : kind < 0.88
              ? pick(0xe0, 0xef)
              : kind < 0.96
                ? pick(0xf0, 0xf7)
                : pick(0xf8, 0xff)
  }
  return out
}

// JSZip decodes every entry in 16 KiB blocks (DataWorker for stored data, pako's
// default chunk for inflated data): the first and the fourth block edge.
const BLOCK_EDGES = [16 * 1024, 64 * 1024]

export function zipTextCases(): Record<string, Uint8Array> {
  const cases: Record<string, Uint8Array> = {
    'empty.xml': bytes(),
    'bom.xml': bytes([0xef, 0xbb, 0xbf], '<a>\u{D55C}\u{1F600}</a>'),
    'bom-only.xml': bytes([0xef, 0xbb, 0xbf]),
    'bom-twice.xml': bytes([0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf], '<a/>'),
    'utf16le.xml': bytes([0xff, 0xfe], [...Buffer.from('<a>\u{D55C}</a>', 'utf16le')]),
    'utf16be-bom.xml': bytes([0xfe, 0xff, 0x00, 0x3c, 0x00, 0x61, 0x00, 0x2f, 0x00, 0x3e]),
    'truncated-at-end.xml': bytes('<a/>', [0xf0, 0x9f, 0x98]),
    'truncated-then-ascii.xml': bytes('a', [0xe2, 0x82], 'b', [0xf0, 0x9f], 'c', [0xc3], 'd'),
    'stray-continuations.xml': bytes([0x80, 0xbf, 0x80], 'a', [0xe2, 0x82, 0xac, 0x80]),
    'overlong.xml': bytes([0xc0, 0xaf, 0xc1, 0xbf, 0xe0, 0x80, 0xaf, 0xf0, 0x80, 0x80, 0xaf]),
    'surrogates.xml': bytes([0xed, 0xa0, 0x80, 0xed, 0xb0, 0x80, 0xed, 0x9f, 0xbf]),
    'beyond-unicode.xml': bytes([
      0xf4, 0x90, 0x80, 0x80, 0xf5, 0x80, 0x80, 0x80, 0xf7, 0xbf, 0xbf, 0xbf,
    ]),
    'five-and-six-byte-leads.xml': bytes([
      0xf8, 0x88, 0x80, 0x80, 0x80, 0xfc, 0x84, 0x80, 0x80, 0x80, 0x80,
    ]),
    'fe-ff.xml': bytes([0xfe, 0xff, 0xfe, 0xfe, 0xff, 0xff], 'a'),
    'nul-and-controls.xml': bytes([0x00, 0x01, 0x7f], 'a', [0x00]),
    'soup-small.bin': bytesBiasedToUtf8LeadsAndContinuations(4096, 1),
    'soup-large.bin': bytesBiasedToUtf8LeadsAndContinuations(300_000, 2),
  }
  for (const edge of BLOCK_EDGES) {
    for (const back of [1, 2, 3]) {
      const lead = 'a'.repeat(edge - back)
      cases[`edge-${edge}-${back}-valid.xml`] = bytes(lead, '\u{1F600}', 'tail')
      cases[`edge-${edge}-${back}-truncated.xml`] = bytes(lead, [0xf0, 0x9f], 'tail')
      cases[`edge-${edge}-${back}-lead-then-ascii.xml`] = bytes(lead, [0xe2], 'bc', [0x82, 0xac])
      cases[`edge-${edge}-${back}-stray.xml`] = bytes(lead, [0x80, 0x80, 0x80, 0x80], 'tail')
      cases[`edge-${edge}-${back}-long-lead.xml`] = bytes(lead, [0xfc, 0x80], 'tail', [0xff])
    }
  }
  return cases
}
