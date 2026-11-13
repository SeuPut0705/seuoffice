// Slides that reach the slide section of parse.ts (parseSlide, parseBackground)
// through the shape tree and the context. What the slide part around the tree
// decides (an own <p:bg>, showMasterSp) is in calls-parse.ts, which owns the
// wrapper.

const A = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'
const R = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
const P = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'

const sp = (id: number, name: string, text = ''): string =>
  `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
  `<p:spPr><a:xfrm><a:off x="${id * 1000}" y="0"/><a:ext cx="1000" cy="500"/></a:xfrm>` +
  `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>` +
  (text
    ? `<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>${text}</a:t></a:r></a:p></p:txBody>`
    : '') +
  `</p:sp>`

const pic = (id: number, rId: string): string =>
  `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="Picture ${id}"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>` +
  `<p:blipFill><a:blip r:embed="${rId}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>` +
  `<p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="100"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`

const CONNECTOR =
  `<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="4" name="Connector 4"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr>` +
  `<p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="500" cy="0"/></a:xfrm><a:prstGeom prst="line"><a:avLst/></a:prstGeom></p:spPr></p:cxnSp>`

/** One of each top-level kind scanSlide finds, and an element it does not. */
const EVERY_KIND =
  sp(2, 'A', 'a') +
  pic(3, 'rId2') +
  CONNECTOR +
  `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="5" name="Group 5"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
  `<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="2000" cy="1000"/><a:chOff x="0" y="0"/><a:chExt cx="2000" cy="1000"/></a:xfrm></p:grpSpPr>` +
  `${sp(6, 'child', 'c')}${CONNECTOR}</p:grpSp>` +
  `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="8" name="Frame 8"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>` +
  `<p:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="100"/></p:xfrm>` +
  `<a:graphic><a:graphicData uri="urn:unknown"><x:thing xmlns:x="urn:x"/></a:graphicData></a:graphic></p:graphicFrame>` +
  '<p:extLst><p:ext uri="{x}"/></p:extLst>' +
  `<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006">` +
  `<mc:Choice Requires="p14">${sp(9, 'Choice')}</mc:Choice><mc:Fallback>${sp(9, 'Fallback')}</mc:Fallback></mc:AlternateContent>`

/** A layout or master part whose only content is its background. */
const partWithBg = (root: string, bg: string): string =>
  `<p:${root} ${A} ${R} ${P}><p:cSld>${bg}<p:spTree/></p:cSld></p:${root}>`
const solid = (hex: string): string =>
  `<p:bg><p:bgPr><a:solidFill><a:srgbClr val="${hex}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>`
const blip = (rId: string): string =>
  `<p:bg><p:bgPr><a:blipFill><a:blip r:embed="${rId}"/><a:stretch><a:fillRect/></a:stretch></a:blipFill><a:effectLst/></p:bgPr></p:bg>`
const bgRef = (idx: string, color = '<a:schemeClr val="accent1"/>'): string =>
  `<p:bg><p:bgRef idx="${idx}">${color}</p:bgRef></p:bg>`

const COLORS = {
  dk1: '#000000',
  lt1: '#FFFFFF',
  dk2: '#1F2A44',
  lt2: '#E7E6E6',
  accent1: '#4472C4',
  accent2: '#ED7D31',
  accent3: '#A5A5A5',
  accent4: '#FFC000',
  accent5: '#5B9BD5',
  accent6: '#70AD47',
  hlink: '#0563C1',
  folHlink: '#954F72',
}
const FILL_STYLES = [
  { 'a:solidFill': { 'a:schemeClr': { '@_val': 'phClr' } } },
  {
    'a:gradFill': {
      'a:gsLst': {
        'a:gs': [
          { '@_pos': '0', 'a:schemeClr': { '@_val': 'phClr', 'a:tint': { '@_val': '50000' } } },
          { '@_pos': '100000', 'a:schemeClr': { '@_val': 'phClr' } },
        ],
      },
      'a:lin': { '@_ang': '5400000', '@_scaled': '0' },
    },
  },
  { 'a:blipFill': { 'a:blip': { '@_r:embed': 'rIdT' }, 'a:stretch': { 'a:fillRect': '' } } },
]
const BG_FILL_STYLES = [
  { 'a:solidFill': { 'a:schemeClr': { '@_val': 'phClr' } } },
  { 'a:noFill': '' },
  { 'a:blipFill': { 'a:blip': { '@_r:embed': 'rIdT' }, 'a:tile': { '@_algn': 'tl' } } },
]
const theme = (clrMap: Record<string, string>, colors: Record<string, string> = COLORS) => ({
  colors,
  clrMap,
  majorFont: 'Georgia',
  minorFont: 'Verdana',
  fillStyles: FILL_STYLES,
  bgFillStyles: BG_FILL_STYLES,
})

/** No background on the layout or the master: the bg1 colour decides. */
const NO_INHERITED_BG = { layoutBg: null, masterBg: null }

const many = (n: number, gap = ''): string => Array.from({ length: n }, () => '<p:sp/>').join(gap)

export const SLIDES: Array<{
  name: string
  spTree: string
  ctx?: Record<string, unknown>
  seed?: false
}> = [
  { name: 'no shapes', spTree: '' },
  { name: 'one shape', spTree: sp(2, 'A', 'one') },
  { name: 'adjacent shapes: no gapAfter', spTree: sp(2, 'A') + sp(3, 'B') },
  {
    name: 'gaps of white space, a comment and stray text between shapes',
    spTree: `\n  ${sp(2, 'A')}<!-- between -->${sp(3, 'B')}  \n stray ${sp(4, 'C')}\n`,
  },
  {
    name: 'non-BMP and Hangul text in shapes and gaps: UTF-16 anchors',
    spTree:
      `<!-- \uD55C\uAE00 \u{1F600} -->${sp(2, '\uD55C\uAE00', '\u{1F600}\u{1F601} \uD55C')}` +
      `\u00e9${sp(3, 'B', '\u{10348}')}<!-- \u{1F600} -->${pic(4, 'rId2')}`,
  },
  { name: 'every top-level kind, an unknown element between', spTree: EVERY_KIND },
  // canonicalXml: a slide is read in one spelling
  {
    name: 'canonical spelling: an end tag of a run inside a comment and a CDATA section',
    spTree:
      `<p:sp><p:nvSpPr><p:cNvPr id="2" name="A"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/>` +
      `<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>one<!-- </a:t></a:r></a:p> --> two</a:t></a:r>` +
      `<a:r><a:rPr lang="en-US"/><a:t><![CDATA[</a:t></a:r> & <b>]]></a:t></a:r></a:p></p:txBody></p:sp>`,
  },
  {
    name: 'canonical spelling: end tags with white space before their >',
    spTree:
      `<p:sp ><p:nvSpPr><p:cNvPr id="2" name="A"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr ><p:spPr/>` +
      `<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>x</a:t ></a:r\n></a:p\t>` +
      `<a:p><a:r><a:rPr lang="en-US"/><a:t>y</a:t></a:r></a:p \r\n></p:txBody ></p:sp >${sp(3, 'B', 'b')}`,
  },
  {
    name: 'canonical spelling: a comment around a whole shape, CDATA in a name',
    spTree: `<!-- ${sp(2, 'gone', 'gone')} -->${sp(3, '<![CDATA[x]]>', 'b')}<![CDATA[ stray ]]>`,
  },
  { name: 'self-closing shapes', spTree: '<p:sp/><p:pic/><p:cxnSp/><p:grpSp/><p:graphicFrame/>' },
  { name: 'budget: exactly MAX_GROUP_DESCENDANTS shapes, no surplus', spTree: many(10000) },
  { name: 'budget: one shape past it, the surplus passthrough', spTree: many(10001) },
  {
    name: 'budget: three past it with gaps, one slice spans them',
    spTree: many(10003, '\n') + '\n',
  },
  // backgrounds the slide inherits through the context
  {
    name: 'layout background read with the layout rels',
    spTree: sp(2, 'A'),
    ctx: {
      layoutBg: partWithBg('sldLayout', blip('rIdL')),
      layoutMediaRels: [['rIdL', 'ppt/media/layout.png']],
      mediaRels: [['rIdL', 'ppt/media/slide.png']],
    },
  },
  {
    name: 'layout background read with the slide rels when the layout has none',
    spTree: sp(2, 'A'),
    ctx: {
      layoutBg: partWithBg('sldLayout', blip('rIdL')),
      layoutMediaRels: null,
      mediaRels: [['rIdL', 'ppt/media/slide.png']],
    },
  },
  {
    name: 'layout without a background: the master background',
    spTree: sp(2, 'A'),
    ctx: {
      layoutBg: partWithBg('sldLayout', ''),
      masterBg: partWithBg('sldMaster', solid('112233')),
    },
  },
  {
    name: 'empty layout part text is skipped',
    spTree: sp(2, 'A'),
    ctx: { layoutBg: '', masterBg: partWithBg('sldMaster', solid('445566')) },
  },
  {
    name: 'master background read with the master rels',
    spTree: '',
    ctx: {
      layoutBg: null,
      masterBg: partWithBg('sldMaster', blip('rIdM')),
      masterMediaRels: [['rIdM', 'ppt/media/master.png']],
      mediaRels: [['rIdM', 'ppt/media/slide.png']],
    },
  },
  {
    name: 'master background read with the slide rels when the master has none',
    spTree: '',
    ctx: {
      layoutBg: null,
      masterBg: partWithBg('sldMaster', blip('rIdM')),
      masterMediaRels: null,
      mediaRels: [['rIdM', 'ppt/media/slide.png']],
    },
  },
  {
    name: 'master background: a bgFillStyleLst template with the theme rels',
    spTree: '',
    ctx: {
      layoutBg: null,
      masterBg: partWithBg('sldMaster', bgRef('1003', '<a:schemeClr val="accent2"/>')),
      theme: theme({ bg1: 'lt1' }),
      themeMediaRels: [['rIdT', 'ppt/media/theme.png']],
    },
  },
  {
    name: 'master background: a fillStyleLst template, no colour, the slide rels',
    spTree: '',
    ctx: {
      layoutBg: null,
      masterBg: partWithBg('sldMaster', bgRef('3', '')),
      theme: theme({ bg1: 'lt1' }),
      themeMediaRels: null,
      mediaRels: [['rIdT', 'ppt/media/slide.png']],
    },
  },
  {
    name: 'master background: a template that gives no fill, the colour alone',
    spTree: '',
    ctx: {
      layoutBg: null,
      masterBg: partWithBg('sldMaster', bgRef('1002', '<a:srgbClr val="ABCDEF"/>')),
      theme: theme({ bg1: 'lt1' }),
    },
  },
  {
    name: 'no background anywhere, bg1 mapped to dark: the bg1 colour',
    spTree: sp(2, 'A'),
    ctx: { ...NO_INHERITED_BG, theme: theme({ bg1: 'dk1', tx1: 'lt1' }) },
  },
  {
    name: 'no background anywhere, bg1 white: none',
    spTree: sp(2, 'A'),
    ctx: { ...NO_INHERITED_BG, theme: theme({ bg1: 'lt1' }) },
  },
  {
    name: 'no background anywhere, bg1 white written in lower case: none',
    spTree: '',
    ctx: { ...NO_INHERITED_BG, theme: theme({}, { ...COLORS, lt1: '#ffffff' }) },
  },
  {
    name: 'no background anywhere, bg1 with alpha: a solid colour',
    spTree: '',
    ctx: { ...NO_INHERITED_BG, theme: theme({}, { ...COLORS, lt1: '#FFFFFF80' }) },
  },
  {
    name: 'no background anywhere, bg1 of ligatures that upper-case to #FFFFFF: none',
    spTree: '',
    ctx: { ...NO_INHERITED_BG, theme: theme({}, { ...COLORS, lt1: '#\uFB00\uFB00\uFB00' }) },
  },
  {
    name: 'no background anywhere, bg1 an empty colour: none',
    spTree: '',
    ctx: { ...NO_INHERITED_BG, theme: theme({}, { ...COLORS, lt1: '' }) },
  },
  {
    name: 'no background anywhere, bg1 mapped to a missing scheme name: none',
    spTree: '',
    ctx: { ...NO_INHERITED_BG, theme: theme({ bg1: 'accent9' }) },
  },
  {
    name: 'no background anywhere and no theme: none',
    spTree: '',
    ctx: { ...NO_INHERITED_BG, theme: null },
  },
  // ledger inherited-key-theme-clrmap: bg1 mapped to a name every object inherits gives the
  // TypeScript a function or Object.prototype as the colour, and toUpperCase throws
  ...['constructor', 'toString', '__proto__', 'hasOwnProperty'].map((name) => ({
    name: `no background anywhere, bg1 mapped to the inherited name ${name}`,
    spTree: sp(2, 'A'),
    ctx: { ...NO_INHERITED_BG, theme: theme({ bg1: name }) },
    seed: false as const,
  })),
]
