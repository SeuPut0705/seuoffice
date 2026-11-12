// Slides that reach the diagram section of parse.ts: layoutDiagramFallback,
// dgmBulletLines, diagramLabelFills, dgmSp, dgmTint, collectDgmTexts,
// collectDgmRunSize. Each slide holds a SmartArt graphicFrame without a
// drawing part, so graphicFramePassthrough lays the data tree out with the
// fallback; the layout part's uniqueId picks the family.

const NS_DGM = 'http://schemas.openxmlformats.org/drawingml/2006/diagram'
const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const LAYOUT_URN = 'urn:microsoft.com/office/officeart/2005/8/layout/'

const THEME = {
  colors: {
    dk1: '#000000', lt1: '#FFFFFF', dk2: '#44546A', lt2: '#E7E6E6',
    accent1: '#4472C4', accent2: '#ED7D31', accent3: '#A5A5A5', accent4: '#FFC000',
    accent5: '#5B9BD5', accent6: '#70AD47', hlink: '#0563C1', folHlink: '#954F72',
  },
  clrMap: { bg1: 'lt1', tx1: 'dk1', bg2: 'lt2', tx2: 'dk2' },
  majorFont: 'Calibri Light',
  minorFont: 'Calibri',
}

let nextFrameId = 2
/** The SmartArt graphicFrame; its relIds name the parts the ctx holds. */
const frame = (o: { cx?: string; cy?: string; xfrm?: string; relIds?: string } = {}): string => {
  const xfrm = o.xfrm ?? `<p:xfrm><a:off x="1524000" y="1397000"/><a:ext cx="${o.cx ?? '8128000'}" cy="${o.cy ?? '5418667'}"/></p:xfrm>`
  const relIds = o.relIds ?? `<dgm:relIds xmlns:dgm="${NS_DGM}" xmlns:r="${NS_R}" r:dm="rId2" r:lo="rId3" r:qs="rId4" r:cs="rId5"/>`
  return `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${nextFrameId++}" name="Diagram"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>${xfrm}<a:graphic><a:graphicData uri="${NS_DGM}">${relIds}</a:graphicData></a:graphic></p:graphicFrame>`
}

const dataModel = (pts: string, cxns: string): string =>
  `<dgm:dataModel xmlns:dgm="${NS_DGM}" xmlns:a="${NS_A}" xmlns:r="${NS_R}"><dgm:ptLst>${pts}</dgm:ptLst><dgm:cxnLst>${cxns}</dgm:cxnLst><dgm:bg/><dgm:whole/></dgm:dataModel>`
const docPt = (id = '0'): string =>
  `<dgm:pt modelId="${id}" type="doc"><dgm:prSet/><dgm:spPr/><dgm:t><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="en-US"/></a:p></dgm:t></dgm:pt>`
/** A node point; `t` is the inner XML of dgm:t's paragraphs. */
const nodePt = (id: string, paras: string, o: { type?: string; spPr?: string } = {}): string =>
  `<dgm:pt modelId="${id}"${o.type != null ? ` type="${o.type}"` : ''}><dgm:prSet phldrT="[Text]"/><dgm:spPr>${o.spPr ?? ''}</dgm:spPr><dgm:t><a:bodyPr/><a:lstStyle/>${paras}</dgm:t></dgm:pt>`
const para = (text: string, rPr = '<a:rPr lang="en-US"/>'): string => `<a:p><a:r>${rPr}<a:t>${text}</a:t></a:r></a:p>`
const presPt = (id: string, assoc: string, o: { lbl?: string; idx?: string; hier?: string } = {}): string =>
  `<dgm:pt modelId="${id}" type="pres"><dgm:prSet presAssocID="${assoc}" presName="node"${o.lbl != null ? ` presStyleLbl="${o.lbl}"` : ''}${o.idx != null ? ` presStyleIdx="${o.idx}"` : ''} presStyleCnt="3">${o.hier != null ? `<dgm:presLayoutVars><dgm:hierBranch val="${o.hier}"/></dgm:presLayoutVars>` : ''}</dgm:prSet><dgm:spPr/></dgm:pt>`
const cxn = (id: string, src: string, dest: string, ord: string | null, type?: string): string =>
  `<dgm:cxn modelId="${id}"${type != null ? ` type="${type}"` : ''} srcId="${src}" destId="${dest}"${ord != null ? ` srcOrd="${ord}"` : ''} destOrd="0"/>`

/** A tree node: its text, or its text and children; `paras` replaces the text paragraphs. */
type T = string | { t: string; kids?: T[]; type?: string; spPr?: string; paras?: string; style?: [string, string]; hier?: string }
const SOLID = (hex: string): string => `<a:solidFill><a:srgbClr val="${hex}"/></a:solidFill>`

/** The data part of a tree: point ids 1.. depth first, the doc point 0. */
const tree = (roots: T[], extraPts = '', extraCxns = ''): string => {
  let n = 1
  const pts = [docPt()]
  const cxns: string[] = []
  const pres: string[] = []
  const walk = (parent: string, kids: T[]): void =>
    kids.forEach((k, i) => {
      const id = String(n++)
      const node: Exclude<T, string> = typeof k === 'string' ? { t: k } : k
      pts.push(nodePt(id, node.paras ?? para(node.t), { type: node.type, spPr: node.spPr }))
      cxns.push(cxn(`c${id}`, parent, id, String(i)))
      if (node.style || node.hier != null)
        pres.push(presPt(`p${id}`, id, { lbl: node.style?.[0], idx: node.style?.[1], hier: node.hier }))
      walk(id, node.kids ?? [])
    })
  walk('0', roots)
  return dataModel(pts.join('') + pres.join('') + extraPts, cxns.join('') + extraCxns)
}

const layoutDef = (uniqueId: string, body = ''): string =>
  `<dgm:layoutDef xmlns:dgm="${NS_DGM}" xmlns:a="${NS_A}" uniqueId="${LAYOUT_URN}${uniqueId}"><dgm:title val=""/><dgm:desc val=""/>${body}</dgm:layoutDef>`
const styleLbl = (name: string | null, fills: string): string =>
  `<dgm:styleLbl${name != null ? ` name="${name}"` : ''}><dgm:fillClrLst meth="repeat">${fills}</dgm:fillClrLst><dgm:linClrLst meth="repeat"><a:schemeClr val="lt1"/></dgm:linClrLst></dgm:styleLbl>`
const colorsDef = (lbls: string): string =>
  `<dgm:colorsDef xmlns:dgm="${NS_DGM}" xmlns:a="${NS_A}" uniqueId="urn:microsoft.com/office/officeart/2005/8/colors/accent1_2"><dgm:title val=""/>${lbls}</dgm:colorsDef>`
const SRGB = (v: string, kids = ''): string => (kids ? `<a:srgbClr val="${v}">${kids}</a:srgbClr>` : `<a:srgbClr val="${v}"/>`)
/** Three node1 slots and a node0, all srgb so they need no theme. */
const COLORS3 = colorsDef(
  styleLbl('node0', SRGB('112233')) +
    styleLbl('node1', SRGB('C00000') + SRGB('00B050') + SRGB('7030A0')) +
    styleLbl('fgAccFollowNode1', SRGB('FFE699')),
)

type Entry = { name: string; spTree: string; ctx?: Record<string, unknown>; seed?: false }
type Opts = {
  colors?: string | null
  layoutXml?: string | null
  layoutBody?: string
  theme?: boolean
  cx?: string
  cy?: string
  xfrm?: string
  relIds?: string
  seed?: false
}
/** One slide: a SmartArt frame whose data part is `data` and whose layout part names `layoutId`. */
const dgm = (name: string, layoutId: string | null, data: string, o: Opts = {}): Entry => {
  const ctx: Record<string, unknown> = { diagramDatas: [['rId2', data]] }
  const layoutXml = o.layoutXml !== undefined ? o.layoutXml : layoutId != null ? layoutDef(layoutId, o.layoutBody) : null
  if (layoutXml != null) ctx.diagramLayouts = [['rId3', layoutXml]]
  const colors = o.colors !== undefined ? o.colors : COLORS3
  if (colors != null) ctx.diagramColors = [['rId5', colors]]
  if (o.theme) ctx.theme = THEME
  return {
    name,
    spTree: frame({ cx: o.cx, cy: o.cy, xfrm: o.xfrm, relIds: o.relIds }),
    ctx,
    ...(o.seed === false ? { seed: false as const } : {}),
  }
}

const FLAT3 = tree(['Alpha', 'Beta', 'Gamma'])
const NESTED = tree([
  { t: 'Plan', kids: ['Scope', { t: 'Budget', kids: ['Capex', 'Opex'] }] },
  { t: 'Build', kids: ['Code', 'Test'] },
  { t: 'Run', kids: ['Operate'] },
])
const NESTED_SPPR = tree([
  { t: 'Own fill', spPr: SOLID('2E75B6'), kids: ['Child one', 'Child two'] },
  { t: 'Cycle', kids: ['Kid'] },
])
const ORG = tree([
  {
    t: 'CEO',
    kids: [
      { t: 'Assistant', type: 'asst' },
      { t: 'CTO', hier: 'hang', kids: ['Dev', 'Ops', 'QA'] },
      { t: 'CFO', hier: 'l', kids: ['Ledger', 'Payroll'] },
      { t: 'COO', hier: 'r', kids: ['Plant'] },
      { t: 'CMO', hier: 'std', kids: ['Brand', 'Ads'] },
      { t: 'CLO', hier: 'init', kids: ['Contracts'] },
    ],
  },
])
const ORG_LAYOUT_BODY =
  '<dgm:layoutNode name="hierChild1"><dgm:constrLst>' +
  '<dgm:constr type="h" for="des" forName="rootComposite1" refType="w" refFor="des" refForName="rootComposite1" fact="0.4"/>' +
  '<dgm:constr type="sibSp" refType="w" refFor="ch" refForName="rootComposite1" fact="0.3"/>' +
  '<dgm:constr type="sp" for="des" forName="hierRoot1" refType="w" fact="0.25"/>' +
  '<dgm:constr type="w" for="ch" forName="rootConnector1" refType="w" fact="0.3"/>' +
  '<dgm:constr type="primFontSz" for="des" forName="rootText" op="equ" val="40"/>' +
  '</dgm:constrLst></dgm:layoutNode>'

const many = (count: number, prefix = 'Item'): T[] => Array.from({ length: count }, (_, i) => `${prefix} ${i + 1}`)
/** A chain of `depth` nodes, each the only child of the one before. */
const chain = (depth: number): T[] => {
  let node: T = `Level ${depth}`
  for (let i = depth - 1; i >= 1; i--) node = { t: `Level ${i}`, kids: [node] }
  return [node]
}

export const SLIDES: Entry[] = [
  // ── layoutDiagramFallback: early returns and the data model ──
  dgm('dgm data part not XML', 'hList1', '<dgm:dataModel><dgm:ptLst></dgm:cxnLst></dgm:dataModel>'),
  dgm('dgm no doc point', 'hList1', dataModel(nodePt('1', para('Orphan')), '')),
  dgm('dgm doc point without modelId', 'hList1', dataModel('<dgm:pt type="doc"/>' + nodePt('1', para('A')), cxn('c1', 'undefined', '1', '0'))),
  dgm('dgm doc point with no children', 'hList1', dataModel(docPt() + nodePt('1', para('Loose')), '')),
  dgm('dgm empty ptLst and cxnLst', 'hList1', dataModel('', '')),
  dgm('dgm no dataModel root', 'hList1', `<dgm:other xmlns:dgm="${NS_DGM}"/>`),
  dgm(
    'dgm single pt and single cxn (no arrays)',
    null,
    `<dgm:dataModel xmlns:dgm="${NS_DGM}" xmlns:a="${NS_A}"><dgm:ptLst>${docPt()}</dgm:ptLst><dgm:cxnLst>${cxn('c1', '0', '0', '0')}</dgm:cxnLst></dgm:dataModel>`,
  ),
  dgm(
    'dgm point types: explicit node, asst, parTrans and sibTrans skipped, pres not a child',
    'default',
    dataModel(
      docPt() +
        nodePt('1', para('Typed node'), { type: 'node' }) +
        nodePt('2', para('Assistant'), { type: 'asst' }) +
        nodePt('3', para('Transition'), { type: 'parTrans' }) +
        nodePt('4', para('Sibling'), { type: 'sibTrans' }) +
        presPt('5', '1'),
      cxn('c1', '0', '1', '0') + cxn('c2', '0', '2', '1') + cxn('c3', '0', '3', '2') + cxn('c4', '0', '4', '3') + cxn('c5', '0', '5', '4'),
    ),
  ),
  dgm(
    'dgm cxn types: parOf kept, presOf and presParOf skipped',
    'default',
    dataModel(
      docPt() + nodePt('1', para('One')) + nodePt('2', para('Two')) + nodePt('3', para('Three')),
      cxn('c1', '0', '1', '0', 'parOf') + cxn('c2', '0', '2', '1', 'presOf') + cxn('c3', '0', '3', '2', 'presParOf'),
    ),
  ),
  dgm(
    'dgm srcOrd: reversed, missing, not a number, negative, fractional',
    'default',
    dataModel(
      docPt() + ['A', 'B', 'C', 'D', 'E', 'F'].map((t, i) => nodePt(String(i + 1), para(t))).join(''),
      cxn('c1', '0', '1', '5') + cxn('c2', '0', '2', null) + cxn('c3', '0', '3', 'abc') + cxn('c4', '0', '4', '-2') + cxn('c5', '0', '5', '2.9') + cxn('c6', '0', '6', '1'),
    ),
  ),
  dgm(
    'dgm a node reached twice and a cycle: seen keeps the first',
    'hList1',
    dataModel(
      docPt() + nodePt('1', para('Root A')) + nodePt('2', para('Root B')) + nodePt('3', para('Shared')),
      cxn('c1', '0', '1', '0') + cxn('c2', '0', '2', '1') + cxn('c3', '1', '3', '0') + cxn('c4', '2', '3', '0') + cxn('c5', '3', '1', '0') + cxn('c6', '0', '0', '2'),
    ),
  ),
  dgm(
    'dgm a point without modelId reached by a cxn without destId',
    'default',
    dataModel(docPt() + '<dgm:pt><dgm:t><a:p><a:r><a:t>No id</a:t></a:r></a:p></dgm:t></dgm:pt>' + nodePt('1', para('Has id')), '<dgm:cxn srcId="0" srcOrd="0"/>' + cxn('c1', '0', '1', '1')),
  ),
  dgm(
    'dgm inherited names as model ids',
    'hList1',
    dataModel(
      docPt('__proto__') + nodePt('constructor', para('Ctor')) + nodePt('toString', para('ToStr')) + nodePt('hasOwnProperty', para('Own')),
      cxn('c1', '__proto__', 'constructor', '0') + cxn('c2', '__proto__', 'toString', '1') + cxn('c3', 'constructor', 'hasOwnProperty', '0'),
    ),
  ),
  dgm(
    'dgm single-quoted attributes',
    'default',
    `<dgm:dataModel xmlns:dgm='${NS_DGM}' xmlns:a='${NS_A}'><dgm:ptLst><dgm:pt modelId='0' type='doc'/><dgm:pt modelId='1'><dgm:t><a:p><a:r><a:rPr sz='1800'/><a:t>Quoted</a:t></a:r></a:p></dgm:t></dgm:pt></dgm:ptLst><dgm:cxnLst><dgm:cxn modelId='c1' srcId='0' destId='1' srcOrd='0'/></dgm:cxnLst></dgm:dataModel>`,
  ),
  dgm('dgm tree deeper than MAX_DGM_TREE_DEPTH', 'hList1', tree(chain(260))),
  dgm('dgm tree exactly at MAX_DGM_TREE_DEPTH', 'vList2', tree(chain(257))),

  // ── collectDgmTexts and collectDgmRunSize ──
  dgm(
    'dgm texts: runs joined, paragraphs, xml:space object, empty and missing a:t',
    'default',
    tree([
      { t: '', paras: '<a:p><a:r><a:t>Ab</a:t></a:r><a:r><a:t xml:space="preserve"> cd </a:t></a:r></a:p><a:p><a:r><a:t/></a:r></a:p><a:p/><a:p><a:fld id="{1}" type="slidenum"><a:t>9</a:t></a:fld></a:p><a:p><a:r/></a:p><a:p><a:r><a:t>Second</a:t><a:t>dup</a:t></a:r></a:p>' },
      { t: '', paras: '' },
      { t: '', paras: '<a:p><a:r>bare run text</a:r></a:p>' },
    ]),
  ),
  dgm(
    'dgm texts: dgm:t empty, dgm:t repeated, no dgm:t',
    'default',
    dataModel(
      docPt() +
        '<dgm:pt modelId="1"><dgm:t/></dgm:pt>' +
        `<dgm:pt modelId="2"><dgm:t>${para('First')}</dgm:t><dgm:t>${para('Second')}</dgm:t></dgm:pt>` +
        '<dgm:pt modelId="3"/>' +
        nodePt('4', para('Kept')),
      cxn('c1', '0', '1', '0') + cxn('c2', '0', '2', '1') + cxn('c3', '0', '3', '2') + cxn('c4', '0', '4', '3'),
    ),
  ),
  dgm(
    'dgm texts: non-BMP, escaped CJK, entities, white space kinds',
    'default',
    tree(['\u{1F600} smile \u{1F600}', '\u4e2d\u6587\u6807\u9898', 'a &amp; b &lt; c', 'nbsp\u00a0split\u3000ideo\ufeffbom', 'nel\u0085no-split']),
  ),
  dgm(
    'dgm run sizes: 2400, 0, negative, not a number, 1e3, on a later run only',
    'process4',
    tree([
      { t: 'Big', paras: para('Big', '<a:rPr lang="en-US" sz="2400"/>'), kids: [{ t: 'Zero', paras: para('Zero', '<a:rPr sz="0"/>') }, { t: 'Neg', paras: para('Neg', '<a:rPr sz="-100"/>') }] },
      { t: 'NaN', paras: para('NaN', '<a:rPr sz="abc"/>'), kids: [{ t: 'Exp', paras: para('Exp', '<a:rPr sz="1e3"/>') }] },
      { t: 'Later', paras: '<a:p><a:r><a:rPr/><a:t>first</a:t></a:r><a:r><a:rPr sz="4000"/><a:t>second</a:t></a:r></a:p>' },
    ]),
  ),

  // ── presentation points: style slots and hierBranch ──
  dgm(
    'dgm style slots: node0, node1 idx 0..4, node without digit, empty idx, not a number, huge',
    'default',
    tree([
      { t: 'n0', style: ['node0', '0'] },
      { t: 'n1-0', style: ['node1', '0'] },
      { t: 'n1-1', style: ['node1', '1'] },
      { t: 'n1-4', style: ['node1', '4'] },
      { t: 'plain node', style: ['node', '1'] },
      { t: 'empty idx', style: ['node1', ''] },
      { t: 'nan idx', style: ['node1', 'x7'] },
      { t: 'huge idx', style: ['node1', '99999999999999999999'] },
      { t: 'unknown slot', style: ['node9', '0'] },
      { t: 'other label', style: ['alignNode1', '1'] },
    ]),
  ),
  dgm(
    'dgm style slots: first presentation point per node wins, duplicate pres ids',
    'default',
    tree(['First', 'Second'], presPt('p1', '1', { lbl: 'node1', idx: '2' }) + presPt('p1', '2', { lbl: 'node1', idx: '1' }) + presPt('q1', '1', { lbl: 'node1', idx: '0' })),
  ),
  // ledger dgm-style-idx-negative: presStyleIdx="-1" makes slot[-1] undefined, dgmSp reads `.spPr` of it and parseSlide throws; the Rust takes the cycle color
  dgm('dgm style slot index negative', 'default', tree([{ t: 'Negative', style: ['node1', '-1'] }, 'Next']), { seed: false }),
  // ledger dgm-style-idx-infinite: a 400-digit presStyleIdx parses to Infinity, Infinity % n is NaN, and parseSlide throws as above; the Rust takes the cycle color
  dgm('dgm style slot index infinite', 'default', tree([{ t: 'Infinite', style: ['node1', '9'.repeat(400)] }]), { seed: false }),
  dgm(
    'dgm style slot index beyond 32 bits is still a slot',
    'default',
    tree([
      { t: 'Big a', style: ['node1', '4294967297'] },
      { t: 'Big b', style: ['node1', '9007199254740991'] },
      { t: 'Big c', style: ['node1', '4294967296'] },
      { t: 'Past safe', style: ['node1', '9007199254740993'] },
    ]),
  ),
  dgm(
    'dgm hierBranch values and presAssocID edge cases',
    'orgChart1',
    tree(
      [{ t: 'Top', kids: [{ t: 'Empty hb', hier: '' }, { t: 'Init', hier: 'init', kids: ['x'] }, { t: 'Hang', hier: 'hang', kids: ['y', 'z'] }] }],
      '<dgm:pt modelId="pz" type="pres"><dgm:prSet presStyleLbl="node1"><dgm:presLayoutVars><dgm:hierBranch val="l"/></dgm:presLayoutVars></dgm:prSet></dgm:pt>' +
        '<dgm:pt modelId="py" type="pres"><dgm:prSet presAssocID="" presStyleLbl="node1"/></dgm:pt>' +
        '<dgm:pt modelId="px" type="pres"><dgm:prSet presAssocID="1"/><dgm:prSet presAssocID="2"/></dgm:pt>' +
        '<dgm:pt modelId="pw" type="pres"/>',
    ),
    { layoutBody: ORG_LAYOUT_BODY },
  ),
  dgm(
    'dgm node spPr: solidFill kept, empty solidFill ignored, gradFill ignored, repeated solidFill',
    'hList1',
    tree([
      { t: 'Solid', spPr: SOLID('FF0000'), kids: ['a'] },
      { t: 'Empty', spPr: '<a:solidFill/>', kids: ['b'] },
      { t: 'Grad', spPr: '<a:gradFill><a:gsLst/></a:gradFill>', kids: ['c'] },
      { t: 'Twice', spPr: SOLID('00FF00') + SOLID('0000FF'), kids: ['d'] },
      { t: 'Scheme', spPr: '<a:solidFill><a:schemeClr val="accent2"><a:lumMod val="75000"/></a:schemeClr></a:solidFill>', kids: ['e'] },
    ]),
    { theme: true },
  ),

  // ── diagramLabelFills ──
  dgm('dgm colors part absent, no theme: accent1 falls back to 4472C4', null, FLAT3, { colors: null }),
  dgm('dgm colors part absent, theme accent1', 'default', NESTED, { colors: null, theme: true }),
  dgm('dgm colors part empty string', null, FLAT3, { colors: '' }),
  dgm('dgm colors part not XML', null, FLAT3, { colors: '<dgm:colorsDef><dgm:styleLbl></dgm:colorsDef>' }),
  dgm('dgm colors part: single styleLbl node0 only', null, FLAT3, { colors: colorsDef(styleLbl('node0', SRGB('ABCDEF'))) }),
  dgm(
    'dgm colors part: every color tag, repeated tags, tag order over document order, alpha cut to 7',
    'default',
    NESTED,
    {
      theme: true,
      colors: colorsDef(
        styleLbl(
          'node1',
          '<a:prstClr val="red"/><a:schemeClr val="accent2"/><a:srgbClr val="00ff00"><a:alpha val="40000"/></a:srgbClr><a:sysClr val="window" lastClr="FFFFFF"/><a:hslClr hue="0" sat="0" lum="0"/><a:scrgbClr r="0" g="0" b="0"/><a:srgbClr val="0000FF"/><a:srgbClr/><a:schemeClr val="accent6"><a:lumMod val="60000"/><a:lumOff val="40000"/></a:schemeClr>',
        ),
      ),
    },
  ),
  dgm(
    'dgm colors part: fillClrLst missing, empty, repeated; styleLbl without name; inherited names',
    'default',
    NESTED,
    {
      theme: true,
      colors: colorsDef(
        '<dgm:styleLbl name="node0"><dgm:linClrLst/></dgm:styleLbl>' +
          '<dgm:styleLbl name="node1"><dgm:fillClrLst/></dgm:styleLbl>' +
          `<dgm:styleLbl name="node2"><dgm:fillClrLst>${SRGB('111111')}</dgm:fillClrLst><dgm:fillClrLst>${SRGB('222222')}</dgm:fillClrLst></dgm:styleLbl>` +
          styleLbl(null, SRGB('333333')) +
          styleLbl('constructor', SRGB('444444')) +
          styleLbl('__proto__', SRGB('555555')) +
          styleLbl('node0', '<a:schemeClr val="constructor"/><a:schemeClr val="toString"/><a:schemeClr val="accent3"/>') +
          styleLbl('node0', SRGB('666666')),
      ),
    },
  ),
  dgm('dgm colors part: scheme colors without a theme resolve to nothing', 'default', NESTED, { colors: colorsDef(styleLbl('node1', '<a:schemeClr val="accent1"/>')) }),

  // ── flatGrid (blocks without hierarchy) ──
  dgm('dgm flatGrid: no layout part', null, FLAT3),
  dgm('dgm flatGrid: layout part without uniqueId', null, FLAT3, { layoutXml: `<dgm:layoutDef xmlns:dgm="${NS_DGM}"/>` }),
  dgm('dgm flatGrid: uniqueId single-quoted', null, FLAT3, { layoutXml: `<dgm:layoutDef xmlns:dgm='${NS_DGM}' uniqueId='${LAYOUT_URN}hList1'/>` }),
  dgm('dgm flatGrid: uniqueId ends in a slash', '', FLAT3),
  dgm('dgm flatGrid: one node', 'default', tree(['Only'])),
  dgm('dgm flatGrid: five nodes, last row shorter', 'default', tree(many(5))),
  dgm('dgm flatGrid: seven nodes, long words', 'default', tree(['Supercalifragilisticexpialidocious', ...many(5), 'a b c d e f g h i j k l m n o p q r s t u v w x y z'])),
  dgm('dgm flatGrid: twelve nodes in a tall frame', 'default', tree(many(12)), { cx: '2000000', cy: '9000000' }),
  dgm('dgm flatGrid: zero frame', 'default', FLAT3, { cx: '0', cy: '0' }),
  dgm('dgm flatGrid: negative frame', 'default', FLAT3, { cx: '-5000000', cy: '-100' }),
  dgm('dgm flatGrid: huge frame', 'default', FLAT3, { cx: '27273042316900', cy: '27273042316900' }),
  dgm('dgm flatGrid: frame extents not numbers', 'default', FLAT3, { cx: 'abc', cy: '' }),
  dgm('dgm flatGrid: frame without xfrm', 'default', FLAT3, { xfrm: '' }),
  dgm('dgm flatGrid: node without text', 'default', tree(['', 'Text'])),

  // ── blocks (hierarchy, unknown layout) ──
  dgm('dgm blocks: nested bullets', 'default', NESTED),
  dgm('dgm blocks: unknown ids fall through', 'hList10', NESTED),
  dgm('dgm blocks: cycle3 is not a cycle', 'cycle3', NESTED),
  dgm('dgm blocks: cycle40 is not cycle4', 'cycle40', NESTED),
  dgm('dgm blocks: own spPr fill', 'matrix1', NESTED_SPPR),
  dgm('dgm blocks: five roots with children', 'default', tree(many(5).map((t) => ({ t: t as string, kids: ['x', 'y'] })))),

  // ── equation ──
  dgm('dgm equation: three operands', 'equation1', FLAT3),
  dgm('dgm equation: two operands', 'equation2', tree(['A', 'B'])),
  dgm('dgm equation: one operand', 'equation1', tree(['Alone'])),
  dgm('dgm equation: own spPr', 'equation1', NESTED_SPPR),

  // ── colProcess ──
  dgm('dgm colProcess: children', 'lProcess1', NESTED),
  dgm('dgm colProcess: childless panels', 'lProcess2', FLAT3),
  dgm('dgm colProcess: own spPr', 'lProcess3', NESTED_SPPR),
  dgm('dgm colProcess: childless with own spPr', 'lProcess2', tree([{ t: 'Fill', spPr: SOLID('ABCDEF') }, 'Plain'])),

  // ── columns ──
  dgm('dgm columns: hList1', 'hList1', NESTED),
  dgm('dgm columns: hList2 without bullets', 'hList2', FLAT3),
  dgm('dgm columns: own spPr', 'hList1', NESTED_SPPR),

  // ── tableList ──
  dgm('dgm tableList: parent with children', 'hList3', tree([{ t: 'Parent', kids: ['One', 'Two', 'Three'] }])),
  dgm('dgm tableList: parent without children uses the other roots', 'hList3', FLAT3),
  dgm('dgm tableList: a single root', 'hList3', tree(['Solo'])),

  // ── stacked ──
  dgm('dgm stacked: vList2', 'vList2', NESTED),
  dgm('dgm stacked: vProcess1', 'vProcess1', FLAT3),
  dgm('dgm stacked: vList50 is not vList5', 'vList50', NESTED),

  // ── hierarchy ──
  dgm('dgm hierarchy: children and a childless root', 'hierarchy1', tree([{ t: 'P', kids: ['a', 'b', 'c'] }, 'Q', { t: 'R', kids: ['d'] }])),

  // ── sideList ──
  dgm('dgm sideList: vList5', 'vList5', tree([{ t: 'Has', kids: ['b1', { t: 'b2', kids: ['b3'] }] }, 'Bare'])),
  dgm('dgm sideList: Bracket', 'BracketList', NESTED_SPPR),

  // ── stepped ──
  dgm('dgm stepped: three steps', 'vProcess5', NESTED),
  dgm('dgm stepped: one step', 'vProcess5', tree(['Only'])),
  dgm('dgm stepped: own spPr arrow is grey', 'vProcess5', NESTED_SPPR),

  // ── chevronList and chevronRow ──
  dgm('dgm chevronList', 'chevron2', NESTED),
  dgm('dgm chevronList: own spPr stroke falls back', 'chevron2', NESTED_SPPR),
  dgm('dgm chevronRow: roots and children flattened', 'chevron1', NESTED),
  dgm('dgm chevronRow: chevron20 is a row', 'chevron20', FLAT3),

  // ── arrowRing ──
  dgm('dgm arrowRing: one arrow', 'arrow5', tree(['Up'])),
  dgm('dgm arrowRing: three arrows', 'arrow5', FLAT3),
  dgm('dgm arrowRing: sixteen arrows', 'arrow5x', tree(many(16))),

  // ── cycleMatrix ──
  dgm('dgm cycleMatrix: four quadrants with cards', 'cycle4', tree(many(4).map((t, i) => ({ t: t as string, kids: [`c${i}a`, { t: `c${i}b`, kids: [`c${i}c`] }] })))),
  dgm('dgm cycleMatrix: five roots keep four', 'cycle4', tree(many(5))),
  dgm('dgm cycleMatrix: two roots', 'cycle4', tree(['L', 'R'])),
  dgm('dgm cycleMatrix: own spPr resolved and unresolved', 'cycle4', tree([{ t: 'Own', spPr: SOLID('123456'), kids: ['k'] }, { t: 'Scheme', spPr: '<a:solidFill><a:schemeClr val="accent9"/></a:solidFill>' }, 'Plain'])),

  // ── cycle ──
  dgm('dgm cycle: cycle1', 'cycle1', FLAT3),
  dgm('dgm cycle: cycle2', 'cycle2', tree(many(6))),
  dgm('dgm cycle: cycle7 with children ignored', 'cycle7', NESTED),
  dgm('dgm cycle: radial with children', 'radial1', tree([{ t: 'Hub', kids: ['N', 'E', 'S', 'W'] }])),
  dgm('dgm cycle: radial without children uses the other roots', 'radial3', FLAT3),
  dgm('dgm cycle: radial single root', 'radial6', tree(['Hub'])),

  // ── orgChart ──
  dgm('dgm orgChart: constraints from the layout part', 'orgChart1', ORG, { layoutBody: ORG_LAYOUT_BODY }),
  dgm('dgm orgChart: default constraints', 'orgChart1', ORG),
  dgm('dgm orgChart: case-insensitive id', 'hORGCHART1', tree([{ t: 'Boss', kids: ['A', 'B'] }])),
  dgm('dgm orgChart: non-ASCII letters around the id', '\u212A\u017Forgchart\u0131', tree([{ t: 'Boss', kids: ['A', 'B'] }])),
  dgm('dgm orgChart: dotted capital I is not o', '\u0130rgchart', tree([{ t: 'Boss', kids: ['A', 'B'] }])),
  dgm('dgm orgChart: boxes without text use fontMax', 'orgChart1', tree([{ t: '', kids: [''] }])),
  dgm('dgm orgChart: zero frame', 'orgChart1', ORG, { cx: '0', cy: '0' }),
  dgm('dgm orgChart: own spPr', 'orgChart1', tree([{ t: 'Boss', spPr: SOLID('FF00FF'), kids: [{ t: 'Kid', style: ['node1', '2'] }] }])),

  // ── cards ──
  dgm('dgm cards: bList2', 'bList2', NESTED),
  dgm('dgm cards: own spPr', 'bList1', NESTED_SPPR),
  dgm('dgm cards: seven cards', 'bList3', tree(many(7).map((t) => ({ t: t as string, kids: ['k'] })))),

  // ── arrowBands ──
  dgm('dgm arrowBands: callouts and closing rect with cells', 'process4', NESTED),
  dgm('dgm arrowBands: last band without children', 'process4', tree([{ t: 'Head', kids: ['a', 'b'] }, 'Tail'])),
  dgm('dgm arrowBands: no fgAccFollowNode1, node1 from colors', 'process4#1', NESTED, { colors: colorsDef(styleLbl('node1', SRGB('C00000'))) }),
  dgm('dgm arrowBands: no colors part', 'process4', tree(['Only band'])),
  dgm('dgm arrowBands: own spPr', 'process4', NESTED_SPPR),

  // ── procCards ──
  dgm('dgm procCards: process1', 'process1', NESTED),
  dgm('dgm procCards: hProcess4', 'hProcess4', FLAT3),
  dgm('dgm procCards: process40 is not process4', 'process40', NESTED),
  dgm('dgm procCards: hProcess30 is not hProcess3', 'hProcess30', FLAT3),
  dgm('dgm procCards: bProcess own spPr', 'bProcess2', NESTED_SPPR),

  // ── pyramid ──
  dgm('dgm pyramid: one node', 'pyramid1', tree(['Apex'])),
  dgm('dgm pyramid: four rows', 'pyramid2', tree(many(4))),

  // ── strips ──
  dgm('dgm strips', 'PictureStrips', NESTED),
  dgm('dgm strips: own spPr', 'PictureFrame', NESTED_SPPR),

  // ── pictureList ──
  dgm('dgm pictureList', 'pList1', NESTED),
  dgm('dgm pictureList: theme accent', 'pList2', FLAT3, { colors: null, theme: true }),

  // ── ruleArrow ──
  dgm('dgm ruleArrow: hProcess3', 'hProcess3', FLAT3),
  dgm('dgm ruleArrow: hProcess3#2 with children', 'hProcess3#2', NESTED),
  dgm('dgm ruleArrow: narrow frame', 'hProcess3', FLAT3, { cx: '1000000', cy: '4000000' }),

  // ── boxList ──
  dgm('dgm boxList', 'list1', NESTED),
  dgm('dgm boxList: own spPr', 'lists2', NESTED_SPPR),

  // ── graphicFrame wiring ──
  dgm('dgm relIds without r:lo and r:cs', 'hList1', NESTED, {
    relIds: `<dgm:relIds xmlns:dgm="${NS_DGM}" xmlns:r="${NS_R}" r:dm="rId2"/>`,
  }),
  dgm('dgm relIds naming no data part', 'hList1', NESTED, {
    relIds: `<dgm:relIds xmlns:dgm="${NS_DGM}" xmlns:r="${NS_R}" r:dm="rIdMissing" r:lo="rId3" r:cs="rId5"/>`,
  }),
]
