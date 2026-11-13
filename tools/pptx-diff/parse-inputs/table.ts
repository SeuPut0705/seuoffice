// Slides that reach the table section of parse.ts (xsdBool, parseTable, parseTableCell).

const NS = 'http://schemas.openxmlformats.org/drawingml/2006/table'

const frame = (tbl: string, name = 'Table 1', xfrm = '<p:xfrm><a:off x="10" y="20"/><a:ext cx="6000" cy="3000"/></p:xfrm>'): string =>
  `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="4" name="${name}"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>${xfrm}<a:graphic><a:graphicData uri="${NS}">${tbl}</a:graphicData></a:graphic></p:graphicFrame>`

const grid = (...w: string[]): string => `<a:tblGrid>${w.map((x) => `<a:gridCol w="${x}"/>`).join('')}</a:tblGrid>`
const txt = (t: string): string => `<a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>${t}</a:t></a:r></a:p></a:txBody>`
const tc = (t: string, attrs = '', pr = ''): string => `<a:tc${attrs}>${txt(t)}${pr}</a:tc>`
const tr = (h: string, ...cells: string[]): string => `<a:tr h="${h}">${cells.join('')}</a:tr>`
const tbl = (pr: string, g: string, ...rows: string[]): string => `<a:tbl>${pr}${g}${rows.join('')}</a:tbl>`

const ACCENT1_MEDIUM2 = '{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}'
const NO_STYLE_GRID = '{5940675A-B579-460E-94D1-54222C63F5DA}'
const LEGACY_NO_STYLE = '{2D5ABB26-0587-4C30-8999-92F81FD0307D}'

const grid3x3 = (pr: string): string =>
  tbl(
    pr,
    grid('1000', '2000', '3000'),
    tr('300', tc('a'), tc('b'), tc('c')),
    tr('300', tc('d'), tc('e'), tc('f')),
    tr('300', tc('g'), tc('h'), tc('i')),
  )

const THEME = {
  colors: {
    dk1: '#000000', lt1: '#FFFFFF', dk2: '#44546A', lt2: '#E7E6E6',
    accent1: '#4472C4', accent2: '#ED7D31', accent3: '#A5A5A5', accent4: '#FFC000',
    accent5: '#5B9BD5', accent6: '#70AD47', hlink: '#0563C1', folHlink: '#954F72',
  },
  clrMap: { bg1: 'lt1', tx1: 'dk1', bg2: 'lt2', tx2: 'dk2' },
  majorFont: 'Calibri Light',
  minorFont: 'Calibri',
  majorEaFont: 'MajorEa',
  minorEaFont: 'MinorEa',
  majorCsFont: 'MajorCs',
  minorCsFont: 'MinorCs',
  fillStyles: [
    { 'a:solidFill': { 'a:schemeClr': { '@_val': 'phClr' } } },
    { 'a:gradFill': { 'a:gsLst': { 'a:gs': [ { '@_pos': '0', 'a:schemeClr': { '@_val': 'phClr', 'a:tint': { '@_val': '50000' } } }, { '@_pos': '100000', 'a:schemeClr': { '@_val': 'phClr' } } ] }, 'a:lin': { '@_ang': '5400000', '@_scaled': '0' } } },
    { 'a:noFill': '' },
  ],
  bgFillStyles: [
    { 'a:solidFill': { 'a:schemeClr': { '@_val': 'phClr' } } },
    { 'a:blipFill': { 'a:blip': { '@_r:embed': 'rIdT' }, 'a:stretch': { 'a:fillRect': '' } } },
  ],
}

const styles = (body: string): string =>
  `<a:tblStyleLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" def="${ACCENT1_MEDIUM2}">${body}</a:tblStyleLst>`
const custom = (id: string, inner: string): string => `<a:tblStyle styleId="${id}" styleName="Custom">${inner}</a:tblStyle>`
const CUSTOM_ID = '{00000000-1111-2222-3333-444444444444}'
const CUSTOM_STYLES = styles(
  custom(
    CUSTOM_ID,
    `<a:tblBg><a:solidFill><a:srgbClr val="EEEEEE"/></a:solidFill></a:tblBg>` +
      `<a:wholeTbl><a:tcTxStyle><a:font><a:latin typeface="Arial"/><a:ea typeface="MS Gothic"/><a:cs typeface="Tahoma"/></a:font><a:srgbClr val="111111"/></a:tcTxStyle><a:tcStyle><a:tcBdr><a:left><a:ln w="12700"><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></a:ln></a:left><a:right><a:ln w="12700"><a:solidFill><a:srgbClr val="00FF00"/></a:solidFill></a:ln></a:right><a:top><a:ln w="12700"><a:solidFill><a:srgbClr val="0000FF"/></a:solidFill></a:ln></a:top><a:bottom><a:ln w="12700"><a:solidFill><a:srgbClr val="123456"/></a:solidFill></a:ln></a:bottom><a:insideH><a:ln w="6350"><a:solidFill><a:srgbClr val="ABCDEF"/></a:solidFill></a:ln></a:insideH><a:insideV><a:ln w="6350"><a:solidFill><a:srgbClr val="FEDCBA"/></a:solidFill></a:ln></a:insideV></a:tcBdr><a:fill><a:solidFill><a:srgbClr val="FAFAFA"/></a:solidFill></a:fill></a:tcStyle></a:wholeTbl>` +
      `<a:band1H><a:tcStyle><a:fill><a:solidFill><a:srgbClr val="DDDDDD"/></a:solidFill></a:fill></a:tcStyle></a:band1H>` +
      `<a:band1V><a:tcStyle><a:fill><a:solidFill><a:srgbClr val="CCCCCC"/></a:solidFill></a:fill></a:tcStyle></a:band1V>` +
      `<a:firstRow><a:tcTxStyle b="on"><a:fontRef idx="major"/><a:schemeClr val="lt1"/></a:tcTxStyle><a:tcStyle><a:fill><a:solidFill><a:schemeClr val="accent1"/></a:solidFill></a:fill></a:tcStyle></a:firstRow>` +
      `<a:lastRow><a:tcTxStyle b="off"><a:fontRef idx="minor"/></a:tcTxStyle><a:tcStyle><a:fill><a:noFill/></a:fill></a:tcStyle></a:lastRow>` +
      `<a:firstCol><a:tcTxStyle b="on"/></a:firstCol>` +
      `<a:lastCol><a:tcTxStyle i="on"><a:font><a:latin typeface="Courier"/></a:font></a:tcTxStyle></a:lastCol>`,
  ) +
    custom('{BGREF-1}', `<a:tblBg><a:fillRef idx="2"><a:schemeClr val="accent2"/></a:fillRef></a:tblBg><a:wholeTbl><a:tcStyle><a:fill><a:solidFill><a:srgbClr val="010101"/></a:solidFill></a:fill></a:tcStyle></a:wholeTbl>`) +
    custom('{BGREF-1001}', `<a:tblBg><a:fillRef idx="1001"><a:schemeClr val="accent3"/></a:fillRef></a:tblBg>`) +
    custom('{BGREF-1002}', `<a:tblBg><a:fillRef idx="1002"><a:schemeClr val="accent4"/></a:fillRef></a:tblBg>`) +
    custom('{BGREF-3}', `<a:tblBg><a:fillRef idx="3"><a:schemeClr val="accent5"/></a:fillRef></a:tblBg>`) +
    custom('{BGREF-99}', `<a:tblBg><a:fillRef idx="99"><a:schemeClr val="accent6"/></a:fillRef></a:tblBg>`) +
    custom('{BGREF-0}', `<a:tblBg><a:fillRef idx="0"/></a:tblBg>`) +
    custom('{BGNONE}', `<a:tblBg><a:noFill/></a:tblBg>`),
)

const CTX = { theme: THEME, tableStyles: CUSTOM_STYLES, mediaRels: [['rId1', 'ppt/media/image1.png']], themeMediaRels: [['rIdT', 'ppt/media/theme1.jpeg']] }

const flags = (v: string): string =>
  `<a:tblPr firstRow="${v}" lastRow="${v}" firstCol="${v}" lastCol="${v}" bandRow="${v}" bandCol="${v}"><a:tableStyleId>${ACCENT1_MEDIUM2}</a:tableStyleId></a:tblPr>`

const BORDER = (tag: string, attrs: string, inner: string): string => `<${tag}${attrs}>${inner}</${tag}>`
const SOLID = (hex: string): string => `<a:solidFill><a:srgbClr val="${hex}"/></a:solidFill>`

export const SLIDES: Array<{ name: string; spTree: string; ctx?: Record<string, unknown>; seed?: false }> = [
  // ── early returns of parseTable ──
  { name: 'tbl no grid', spTree: frame(tbl('', '', tr('100', tc('x')))) },
  { name: 'tbl empty grid', spTree: frame(tbl('', '<a:tblGrid/>', tr('100', tc('x')))) },
  { name: 'tbl bare gridCol', spTree: frame(tbl('', '<a:tblGrid><a:gridCol/></a:tblGrid>', tr('100', tc('x')))) },
  { name: 'tbl no rows', spTree: frame(tbl('', grid('100'))) },
  { name: 'tbl bare tr and tc', spTree: frame(tbl('', grid('100', '200'), '<a:tr/>', '<a:tr h="5"><a:tc/></a:tr>')) },
  { name: 'tbl self-closing tbl', spTree: frame('<a:tbl/>') },
  // ── grid widths and row heights ──
  {
    name: 'tbl widths non-numeric negative huge fractional',
    spTree: frame(tbl('', grid('abc', '-500', '99999999999999999999', '12.7', ''), tr('-3', tc('a')), tr('1e3', tc('b')), tr('x', tc('c')))),
  },
  { name: 'tbl single col single row', spTree: frame(tbl('<a:tblPr/>', grid('914400'), tr('370840', tc('one')))) },
  { name: "tbl single quotes", spTree: frame(`<a:tbl><a:tblPr firstRow='1' bandRow='1'><a:tableStyleId>${ACCENT1_MEDIUM2}</a:tableStyleId></a:tblPr><a:tblGrid><a:gridCol w='500'/></a:tblGrid><a:tr h='200'>${tc('q', " gridSpan='1'")}</a:tr></a:tbl>`) },
  // ── names and transforms ──
  { name: 'tbl no name no xfrm', spTree: `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="4"/></p:nvGraphicFramePr><a:graphic><a:graphicData uri="${NS}">${grid3x3('')}</a:graphicData></a:graphic></p:graphicFrame>` },
  { name: 'tbl non-BMP name', spTree: frame(grid3x3(''), '\u{1F600} t\u00e4ble &amp; "x"') },
  // ── xsdBool and flags ──
  { name: 'flags all 1', spTree: frame(grid3x3(flags('1'))) },
  { name: 'flags all true', spTree: frame(grid3x3(flags('true'))) },
  { name: 'flags all True', spTree: frame(grid3x3(flags('True'))) },
  { name: 'flags all TRUE', spTree: frame(grid3x3(flags('TRUE'))) },
  { name: 'flags all 0', spTree: frame(grid3x3(flags('0'))) },
  { name: 'flags all false', spTree: frame(grid3x3(flags('false'))) },
  { name: 'flags all on', spTree: frame(grid3x3(flags('on'))) },
  { name: 'flags all empty', spTree: frame(grid3x3(flags(''))) },
  { name: 'flags padded 1', spTree: frame(grid3x3(flags(' 1'))) },
  { name: 'flags 01', spTree: frame(grid3x3(flags('01'))) },
  { name: 'flags first row only', spTree: frame(grid3x3(`<a:tblPr firstRow="1"><a:tableStyleId>${ACCENT1_MEDIUM2}</a:tableStyleId></a:tblPr>`)) },
  { name: 'flags last col band col', spTree: frame(grid3x3(`<a:tblPr lastCol="1" bandCol="1" lastRow="1"><a:tableStyleId>${ACCENT1_MEDIUM2}</a:tableStyleId></a:tblPr>`)) },
  { name: 'rtl 1', spTree: frame(grid3x3('<a:tblPr rtl="1"/>')) },
  { name: 'rtl true', spTree: frame(grid3x3('<a:tblPr rtl="true"/>')) },
  { name: 'rtl 0', spTree: frame(grid3x3('<a:tblPr rtl="0"/>')) },
  // ── style ids ──
  { name: 'style none no lines (table grid default)', spTree: frame(grid3x3('<a:tblPr firstRow="1" bandRow="1"/>')) },
  {
    name: 'style none cell defines line',
    spTree: frame(tbl('<a:tblPr/>', grid('100', '100'), tr('100', tc('a', '', '<a:tcPr><a:lnL w="0"><a:noFill/></a:lnL></a:tcPr>'), tc('b')))),
  },
  { name: 'style explicit no-style grid', spTree: frame(grid3x3(`<a:tblPr><a:tableStyleId>${NO_STYLE_GRID}</a:tableStyleId></a:tblPr>`)) },
  { name: 'style legacy no style', spTree: frame(grid3x3(`<a:tblPr><a:tableStyleId>${LEGACY_NO_STYLE}</a:tableStyleId></a:tblPr>`)) },
  { name: 'style unknown id', spTree: frame(grid3x3('<a:tblPr><a:tableStyleId>{DEADBEEF-0000-0000-0000-000000000000}</a:tableStyleId></a:tblPr>')) },
  { name: 'style empty id', spTree: frame(grid3x3('<a:tblPr><a:tableStyleId></a:tableStyleId></a:tblPr>')) },
  { name: 'style self-closing id', spTree: frame(grid3x3('<a:tblPr><a:tableStyleId/></a:tblPr>')) },
  { name: 'style id with attribute (#text)', spTree: frame(grid3x3(`<a:tblPr><a:tableStyleId x="1">${ACCENT1_MEDIUM2}</a:tableStyleId></a:tblPr>`)) },
  { name: 'style id repeated', spTree: frame(grid3x3(`<a:tblPr><a:tableStyleId>${ACCENT1_MEDIUM2}</a:tableStyleId><a:tableStyleId>${NO_STYLE_GRID}</a:tableStyleId></a:tblPr>`)) },
  { name: 'style constructor id', spTree: frame(grid3x3('<a:tblPr><a:tableStyleId>constructor</a:tableStyleId></a:tblPr>')) },
  ...[
    '{2D5ABB26-0587-4C30-8999-92F81FD0307D}',
    '{3C2FFA5D-87B4-456A-9821-1D502468CF0F}',
    '{284E427A-3D55-4303-BF80-6455036E1DE7}',
    '{69C7853C-536D-4A76-A0AE-DD22124D55A5}',
    '{775DCB02-9BB8-47FD-8907-85C794F793BA}',
    '{35758FB7-9AC5-4552-8A53-C91805E547FA}',
    '{08FB837D-C827-4EFA-A057-4D05807E0F7C}',
    '{5202B0CA-FC54-4496-8BCA-5EF66A818D29}',
    '{0E3FDE45-AF77-4B5C-9715-49D594BDF05E}',
    '{D7AC3CCA-C797-4891-BE02-D94E43425B78}',
    '{BC89EF96-8CEA-46FF-86C4-4CE0E7609802}',
    '{E8034E78-7F5D-4C2E-B375-FC64B27BC917}',
    '{793D81CF-94F2-401A-BA57-92F5A7B2D0C5}',
    '{073A0DAA-6AF3-43AB-8588-CEC1D06C72B9}',
    '{9D7B26C5-4107-4FEC-AEDC-1716B250EE53}',
    '{F5AB1C69-6EDB-4FF4-983F-18BD219EF322}',
  ].map((id) => ({ name: `style builtin ${id} all flags`, spTree: frame(grid3x3(flags('1').replace(ACCENT1_MEDIUM2, id))), ctx: { theme: THEME } })),
  // ── custom styles of ctx.tableStyles ──
  { name: 'custom style all flags', spTree: frame(grid3x3(flags('1').replace(ACCENT1_MEDIUM2, CUSTOM_ID))), ctx: CTX },
  { name: 'custom style no flags', spTree: frame(grid3x3(`<a:tblPr><a:tableStyleId>${CUSTOM_ID}</a:tableStyleId></a:tblPr>`)), ctx: CTX },
  { name: 'custom style with defaultTextStyle', spTree: frame(grid3x3(flags('1').replace(ACCENT1_MEDIUM2, CUSTOM_ID))), ctx: { ...CTX, defaultTextStyle: { levels: [{ fontSize: 14, latinFont: 'Def' }] } } },
  { name: 'custom style no theme', spTree: frame(grid3x3(flags('1').replace(ACCENT1_MEDIUM2, CUSTOM_ID))), ctx: { tableStyles: CUSTOM_STYLES } },
  { name: 'bg fillRef idx 2', spTree: frame(grid3x3('<a:tblPr><a:tableStyleId>{BGREF-1}</a:tableStyleId></a:tblPr>')), ctx: CTX },
  { name: 'bg fillRef idx 1001', spTree: frame(grid3x3('<a:tblPr><a:tableStyleId>{BGREF-1001}</a:tableStyleId></a:tblPr>')), ctx: CTX },
  { name: 'bg fillRef idx 1002 (theme media)', spTree: frame(grid3x3('<a:tblPr><a:tableStyleId>{BGREF-1002}</a:tableStyleId></a:tblPr>')), ctx: CTX },
  { name: 'bg fillRef idx 1002 media rels only', spTree: frame(grid3x3('<a:tblPr><a:tableStyleId>{BGREF-1002}</a:tableStyleId></a:tblPr>')), ctx: { ...CTX, themeMediaRels: undefined, mediaRels: [['rIdT', 'ppt/media/m.png']] } },
  { name: 'bg fillRef idx 3 noFill', spTree: frame(grid3x3('<a:tblPr><a:tableStyleId>{BGREF-3}</a:tableStyleId></a:tblPr>')), ctx: CTX },
  { name: 'bg fillRef idx 99 out of range', spTree: frame(grid3x3('<a:tblPr><a:tableStyleId>{BGREF-99}</a:tableStyleId></a:tblPr>')), ctx: CTX },
  { name: 'bg fillRef idx 0 no color', spTree: frame(grid3x3('<a:tblPr><a:tableStyleId>{BGREF-0}</a:tableStyleId></a:tblPr>')), ctx: CTX },
  { name: 'bg fillRef no theme', spTree: frame(grid3x3('<a:tblPr><a:tableStyleId>{BGREF-1}</a:tableStyleId></a:tblPr>')), ctx: { tableStyles: CUSTOM_STYLES } },
  { name: 'bg noFill', spTree: frame(grid3x3('<a:tblPr><a:tableStyleId>{BGNONE}</a:tableStyleId></a:tblPr>')), ctx: CTX },
  // ── merges ──
  {
    name: 'merge gridSpan hMerge',
    spTree: frame(tbl(flags('1'), grid('100', '100', '100'), tr('100', tc('a', ' gridSpan="2"'), tc('', ' hMerge="1"'), tc('c')), tr('100', tc('d'), tc('e'), tc('f')))),
  },
  {
    name: 'merge rowSpan vMerge',
    spTree: frame(tbl(flags('1'), grid('100', '100'), tr('100', tc('a', ' rowSpan="2"'), tc('b')), tr('100', tc('', ' vMerge="true"'), tc('d')))),
  },
  {
    name: 'merge both spans',
    spTree: frame(tbl(flags('1'), grid('100', '100', '100'), tr('100', tc('a', ' gridSpan="2" rowSpan="2"'), tc('', ' hMerge="True"'), tc('c')), tr('100', tc('', ' vMerge="1"'), tc('', ' hMerge="1" vMerge="1"'), tc('f')))),
  },
  {
    name: 'merge spans omitted continuation',
    spTree: frame(tbl(flags('1'), grid('100', '100', '100'), tr('100', tc('a', ' gridSpan="2"'), tc('c')))),
  },
  {
    name: 'merge span odd values',
    spTree: frame(
      tbl(
        flags('1'),
        grid('100', '100', '100', '100'),
        tr('100', tc('a', ' gridSpan="0"'), tc('b', ' gridSpan="-2"'), tc('c', ' gridSpan="abc"'), tc('d', ' gridSpan="1.9"')),
        tr('100', tc('e', ' gridSpan="99"'), tc('f', ' rowSpan="0"'), tc('g', ' rowSpan="x"'), tc('h', ' rowSpan="3.5" gridSpan=""')),
      ),
    ),
  },
  { name: 'merge flags odd values', spTree: frame(tbl('', grid('100', '100'), tr('100', tc('a', ' hMerge="0" vMerge="false"'), tc('b', ' hMerge="yes" vMerge=""')))) },
  // ── cell text: anchors and insets ──
  {
    name: 'cell anchors and insets',
    spTree: frame(
      tbl(
        '',
        grid('100', '100', '100', '100'),
        tr(
          '100',
          tc('t', '', '<a:tcPr anchor="t" marL="0" marR="1" marT="-5" marB="abc"/>'),
          tc('ctr', '', '<a:tcPr anchor="ctr" marL="12.5"/>'),
          tc('b', '', '<a:tcPr anchor="b"/>'),
          tc('just', '', '<a:tcPr anchor="just"/>'),
        ),
        tr('100', tc('empty', '', '<a:tcPr anchor=""/>'), tc('none', '', '<a:tcPr/>'), '<a:tc><a:tcPr anchor="t"/></a:tc>', tc('no tcPr')),
      ),
    ),
  },
  // ledger inherited-key-parse-3319: anchorMap[tcPr anchor] answers for inherited names
  {
    name: 'cell anchor inherited names',
    seed: false,
    spTree: frame(tbl('', grid('100', '100', '100', '100'), tr('100', tc('a', '', '<a:tcPr anchor="__proto__"/>'), tc('b', '', '<a:tcPr anchor="constructor"/>'), tc('c', '', '<a:tcPr anchor="toString"/>'), tc('d', '', '<a:tcPr anchor="hasOwnProperty"/>')))),
  },
  { name: 'cell text only default text style', spTree: frame(tbl('', grid('100'), tr('100', tc('a')))), ctx: { defaultTextStyle: { levels: [{ fontSize: 18 }], src: 'x' } } },
  // ── cell fills ──
  {
    name: 'cell fills',
    spTree: frame(
      tbl(
        flags('1'),
        grid('100', '100', '100', '100', '100'),
        tr(
          '100',
          tc('solid', '', `<a:tcPr>${SOLID('FF0000')}</a:tcPr>`),
          tc('nofill', '', '<a:tcPr><a:noFill/></a:tcPr>'),
          tc('grad', '', '<a:tcPr><a:gradFill><a:gsLst><a:gs pos="0"><a:srgbClr val="000000"/></a:gs><a:gs pos="100000"><a:srgbClr val="FFFFFF"/></a:gs></a:gsLst><a:lin ang="0"/></a:gradFill></a:tcPr>'),
          tc('patt', '', '<a:tcPr><a:pattFill prst="dkHorz"><a:fgClr><a:srgbClr val="111111"/></a:fgClr><a:bgClr><a:srgbClr val="EEEEEE"/></a:bgClr></a:pattFill></a:tcPr>'),
          tc('blip', '', '<a:tcPr><a:blipFill><a:blip r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></a:blipFill></a:tcPr>'),
        ),
        tr('100', tc('grp', '', '<a:tcPr><a:grpFill/></a:tcPr>'), tc('bad solid', '', '<a:tcPr><a:solidFill/></a:tcPr>'), tc('style'), tc('a'), tc('b')),
      ),
    ),
    ctx: CTX,
  },
  // ── cell3D ──
  {
    name: 'cell3D',
    spTree: frame(
      tbl(
        '',
        grid('100', '100', '100', '100'),
        tr(
          '100',
          tc('a', '', '<a:tcPr><a:cell3D><a:bevel w="50800" prst="angle"/><a:lightRig rig="threePt" dir="tl"/></a:cell3D></a:tcPr>'),
          tc('b', '', '<a:tcPr><a:cell3D><a:bevel/></a:cell3D></a:tcPr>'),
          tc('c', '', '<a:tcPr><a:cell3D/></a:tcPr>'),
          tc('d', '', '<a:tcPr><a:cell3D prstMaterial="metal"><a:bevel w="x" prst=""/><a:lightRig dir=""/></a:cell3D></a:tcPr>'),
        ),
        tr('100', tc('e', '', '<a:tcPr><a:cell3D><a:bevel w="1"/></a:cell3D><a:cell3D/></a:tcPr>'), tc('f'), tc('g'), tc('h')),
      ),
    ),
  },
  // ── borders ──
  {
    name: 'cell borders all edges',
    spTree: frame(
      tbl(
        '',
        grid('100', '100'),
        tr(
          '100',
          tc('a', '', `<a:tcPr>${BORDER('a:lnL', ' w="12700"', SOLID('FF0000'))}${BORDER('a:lnR', ' w="25400" cap="rnd"', SOLID('00FF00') + '<a:prstDash val="dash"/>')}${BORDER('a:lnT', ' w="0"', SOLID('0000FF'))}${BORDER('a:lnB', ' w="0"', '<a:noFill/>')}</a:tcPr>`),
          tc('b', '', `<a:tcPr><a:lnL/><a:lnR w="9525"><a:noFill/></a:lnR><a:lnT w="abc">${SOLID('123456')}</a:lnT><a:lnB w="-1">${SOLID('654321')}</a:lnB></a:tcPr>`),
        ),
        tr('100', tc('c', '', `<a:tcPr>${BORDER('a:lnB', ' w="12700"', SOLID('ABCDEF'))}${BORDER('a:lnT', ' w="12700"', SOLID('FEDCBA'))}</a:tcPr>`), tc('d', '', `<a:tcPr>${BORDER('a:lnL', '', SOLID('111111'))}${BORDER('a:lnL', '', SOLID('222222'))}</a:tcPr>`)),
      ),
    ),
  },
  {
    name: 'cell borders with style inside lines',
    spTree: frame(
      tbl(
        flags('1').replace(ACCENT1_MEDIUM2, CUSTOM_ID),
        grid('100', '100', '100'),
        tr('100', tc('a', '', `<a:tcPr>${BORDER('a:lnT', ' w="12700"', SOLID('FF00FF'))}</a:tcPr>`), tc('b'), tc('c', '', `<a:tcPr>${BORDER('a:lnR', ' w="0"', SOLID('00FFFF'))}</a:tcPr>`)),
        tr('100', tc('d'), tc('e', '', `<a:tcPr>${BORDER('a:lnB', ' w="12700"', SOLID('0F0F0F'))}${BORDER('a:lnL', ' w="12700"', SOLID('F0F0F0'))}</a:tcPr>`), tc('f')),
        tr('100', tc('g'), tc('h'), tc('i')),
      ),
    ),
    ctx: CTX,
  },
  {
    name: 'cell borders builtin style',
    spTree: frame(
      tbl(
        flags('1').replace(ACCENT1_MEDIUM2, '{073A0DAA-6AF3-43AB-8588-CEC1D06C72B9}'),
        grid('100', '100'),
        tr('100', tc('a', '', `<a:tcPr>${BORDER('a:lnB', ' w="38100"', SOLID('000000'))}</a:tcPr>`), tc('b')),
        tr('100', tc('c'), tc('d')),
      ),
    ),
    ctx: { theme: THEME },
  },
  // ── many rows (repeated elements) ──
  {
    name: 'tbl many rows and cols',
    spTree: frame(tbl(flags('1'), grid(...Array.from({ length: 6 }, (_, i) => String(100 * (i + 1)))), ...Array.from({ length: 7 }, (_, r) => tr(String(50 * r), ...Array.from({ length: 6 }, (_, c) => tc(`${r}.${c}`)))))),
    ctx: { theme: THEME },
  },
  { name: 'tbl rows fewer cells than grid', spTree: frame(tbl(flags('1'), grid('100', '100', '100'), tr('100', tc('a')), tr('100', tc('b'), tc('c'), tc('d'), tc('e')))) },
]
