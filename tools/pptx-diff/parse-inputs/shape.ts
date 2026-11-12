// Slides that reach the shape section of parse.ts: parseShapeFragment (and the
// mc:AlternateContent branch), parseSpShape, styleRefStroke, parseStroke,
// parseArrowEnd, parseConnector, parseGlow, parseReflection, parseShadow,
// parseScene3D, parseAvLst, the group budget, parseGroup, parseGroupChild,
// groupChildNvId, sliceGroupChildren, passthrough and the xfrm helpers.

const xfrm = (x = '100', y = '200', cx = '3000', cy = '2000', attrs = ''): string =>
  `<a:xfrm${attrs}><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>`

const solid = (hex: string): string => `<a:solidFill><a:srgbClr val="${hex}"/></a:solidFill>`

const nvSp = (id = '2', name = 'Shape 1', extra = '', nvPr = ''): string =>
  `<p:nvSpPr><p:cNvPr id="${id}" name="${name}"${extra}/><p:cNvSpPr/><p:nvPr>${nvPr}</p:nvPr></p:nvSpPr>`

const txBody = (t = 'Hello', rPr = '<a:rPr lang="en-US"/>'): string =>
  `<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r>${rPr}<a:t>${t}</a:t></a:r></a:p></p:txBody>`

const sp = (spPr: string, opts: { nv?: string; tx?: string; style?: string; attrs?: string } = {}): string =>
  `<p:sp${opts.attrs ?? ''}>${opts.nv ?? nvSp()}<p:spPr>${spPr}</p:spPr>${opts.style ?? ''}${opts.tx ?? ''}</p:sp>`

const rect = (inner = ''): string => `${xfrm()}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>${inner}`

const ln = (attrs: string, inner: string): string => `<a:ln${attrs}>${inner}</a:ln>`

const effect = (inner: string): string => `<a:effectLst>${inner}</a:effectLst>`

const cxn = (spPr: string, opts: { cxnPr?: string; style?: string; name?: string } = {}): string =>
  `<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="5" name="${opts.name ?? 'Connector 1'}"/><p:cNvCxnSpPr>${opts.cxnPr ?? ''}</p:cNvCxnSpPr><p:nvPr/></p:nvCxnSpPr><p:spPr>${spPr}</p:spPr>${opts.style ?? ''}</p:cxnSp>`

const grpXfrm = (off = '0', ext = '1000', chOff = '0', chExt = '1000'): string =>
  `<a:xfrm><a:off x="${off}" y="${off}"/><a:ext cx="${ext}" cy="${ext}"/><a:chOff x="${chOff}" y="${chOff}"/><a:chExt cx="${chExt}" cy="${chExt}"/></a:xfrm>`

const grp = (children: string, grpSpPr = `<p:grpSpPr>${grpXfrm()}</p:grpSpPr>`, id = '10', name = 'Group 1'): string =>
  `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>${grpSpPr}${children}</p:grpSp>`

const leaf = (id: string): string => sp(rect(), { nv: nvSp(id, `Leaf ${id}`) })

const nest = (levels: number): string => {
  let xml = leaf('100')
  for (let i = 0; i < levels; i++) xml = grp(xml, undefined, String(1000 + i), `G${i}`)
  return xml
}

const styleRefs = (ln: string, fill: string, effectIdx: string, font: string): string =>
  `<p:style><a:lnRef idx="${ln}"><a:schemeClr val="accent1"/></a:lnRef><a:fillRef idx="${fill}"><a:schemeClr val="accent2"/></a:fillRef><a:effectRef idx="${effectIdx}"><a:schemeClr val="accent3"/></a:effectRef><a:fontRef idx="minor">${font}</a:fontRef></p:style>`

const THEME = {
  colors: {
    dk1: '#101010', lt1: '#FFFFFF', dk2: '#44546A', lt2: '#E7E6E6',
    accent1: '#4472C4', accent2: '#ED7D31', accent3: '#A5A5A5', accent4: '#FFC000',
    accent5: '#5B9BD5', accent6: '#70AD47', hlink: '#0563C1', folHlink: '#954F72',
  },
  clrMap: { bg1: 'lt1', tx1: 'dk1', bg2: 'lt2', tx2: 'dk2' },
  majorFont: 'Calibri Light',
  minorFont: 'Calibri',
  fillStyles: [
    { 'a:solidFill': { 'a:schemeClr': { '@_val': 'phClr' } } },
    { 'a:noFill': '' },
    { 'a:gradFill': { 'a:gsLst': { 'a:gs': [ { '@_pos': '0', 'a:schemeClr': { '@_val': 'phClr' } }, { '@_pos': '100000', 'a:srgbClr': { '@_val': '000000' } } ] }, 'a:lin': { '@_ang': '5400000' } } },
  ],
  bgFillStyles: [
    { 'a:solidFill': { 'a:schemeClr': { '@_val': 'phClr', 'a:lumMod': { '@_val': '50000' } } } },
  ],
  lnStyles: [
    { 'a:ln': { '@_w': '6350', '@_cap': 'rnd', 'a:solidFill': { 'a:schemeClr': { '@_val': 'phClr' } }, 'a:prstDash': { '@_val': 'dash' } } },
    { 'a:ln': { 'a:noFill': '' } },
    { 'a:ln': { '@_w': '19050' } },
  ],
  effectStyles: [
    { 'a:effectStyle': { 'a:effectLst': '' } },
    { 'a:effectStyle': { 'a:effectLst': { 'a:outerShdw': { '@_blurRad': '40000', '@_dist': '23000', '@_dir': '5400000', 'a:schemeClr': { '@_val': 'phClr' } } } } },
    { 'a:effectStyle': { 'a:effectLst': { 'a:glow': { '@_rad': '63500', 'a:schemeClr': { '@_val': 'phClr' } } } } },
  ],
}

const THEME_CTX = { theme: THEME }

const T = (x: string, y: string, cx: string, cy: string) => ({
  offset: { x: Number(x), y: Number(y), cx: Number(cx), cy: Number(cy) },
  rot: 0,
  flipH: false,
  flipV: false,
})

const PH_CTX = {
  theme: THEME,
  layoutPlaceholders: {
    entries: [
      {
        type: 'title', idx: '', transform: T('11', '22', '5000', '700'), anchor: 'bottom', anchorCtr: true,
        insets: { l: 1, t: 2 },
        fillSpPr: { 'a:solidFill': { 'a:srgbClr': { '@_val': 'ABCDEF' } } },
        textStyle: { levels: [{ fontSize: 4400, color: '#123456' }] },
      },
      { type: 'body', idx: '1', transform: T('33', '44', '6000', '4000'), anchor: 'top' },
    ],
  },
  masterPlaceholders: {
    entries: [
      {
        type: 'body', idx: '', transform: T('1', '2', '7000', '5000'), anchor: 'middle', anchorCtr: false,
        insets: { r: 3, b: 4 },
        fillSpPr: { 'a:blipFill': { 'a:blip': { '@_r:embed': 'rIdM' } } },
      },
    ],
  },
  masterTextStyles: {
    title: { levels: [{ fontSize: 4000 }] },
    body: { levels: [{ fontSize: 2800 }, { fontSize: 2400 }] },
    other: { levels: [{ fontSize: 1800 }] },
  },
  layoutMediaRels: [['rIdL', 'ppt/media/layout.png']],
  masterMediaRels: [['rIdM', 'ppt/media/master.png']],
  mediaRels: [['rIdM', 'ppt/media/slide.png']],
}

const DTS_CTX = {
  theme: THEME,
  defaultTextStyle: { levels: [{ fontSize: 1400, color: '#222222' }] },
}

const MODEL_CTX = { theme: THEME, model3dRels: [['rId3d', 'ppt/media/model.glb'], ['undefined', 'ppt/media/undef.glb']] }

const sideBySide = (n: number): string => Array.from({ length: n }, (_, i) => leaf(String(2000 + i))).join('')

export const SLIDES: Array<{ name: string; spTree: string; ctx?: Record<string, unknown>; seed?: false }> = [
  // ── parseShapeFragment ─────────────────────────────────────────────
  { name: 'fragment: p:sp plain rect', spTree: sp(rect(), { tx: txBody() }) },
  { name: 'fragment: self-closing p:sp is null', spTree: '<p:sp/>' + leaf('3') },
  { name: 'fragment: empty p:sp is null', spTree: '<p:sp></p:sp>' + leaf('3') },
  { name: 'fragment: a:br and a:fld rewritten', spTree: sp(rect(), { tx: '<p:txBody><a:bodyPr/><a:p><a:r><a:t>A</a:t></a:r><a:br/><a:r><a:t>B</a:t></a:r><a:br><a:rPr/></a:br><a:fld id="{1}" type="slidenum"><a:t>3</a:t></a:fld></a:p></p:txBody>' }) },
  { name: 'fragment: math block in paragraph', spTree: sp(rect(), { tx: '<p:txBody><a:bodyPr/><a:p><mc:AlternateContent xmlns:mc="m"><mc:Choice Requires="a14"><a14:m><m:oMath><m:r><m:t>x</m:t></m:r><m:r><m:t>+1</m:t></m:r></m:oMath></a14:m></mc:Choice><mc:Fallback><a:r><a:t>x+1 fb</a:t></a:r></mc:Fallback></mc:AlternateContent></a:p></p:txBody>' }) },
  { name: 'fragment: math block without fallback text', spTree: sp(rect(), { tx: '<p:txBody><a:bodyPr/><a:p><mc:AlternateContent><mc:Choice Requires="a14"> <a14:m><m:oMath><m:r><m:t>\u{1D465}\u00e9</m:t></m:r></m:oMath></a14:m></mc:Choice><mc:Fallback/></mc:AlternateContent></a:p></p:txBody>' }) },
  { name: 'fragment: math block $ in text', spTree: sp(rect(), { tx: '<p:txBody><a:bodyPr/><a:p><mc:AlternateContent><mc:Choice Requires="a14"><a14:m><m:t>$&amp; $1 $$ $\'</m:t></a14:m></mc:Choice><mc:Fallback><a:r><a:t>$&amp;$1</a:t></a:r></mc:Fallback></mc:AlternateContent></a:p></p:txBody>' }) },
  { name: 'fragment: hidden sp is silent passthrough', spTree: sp(rect(), { nv: nvSp('2', 'Hidden', ' hidden="1"') }) },
  { name: 'fragment: hidden="true" pic', spTree: '<p:pic><p:nvPicPr><p:cNvPr id="3" name="P" hidden="true"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId1"/></p:blipFill><p:spPr>' + xfrm() + '</p:spPr></p:pic>' },
  { name: "fragment: hidden='0' stays", spTree: "<p:sp><p:nvSpPr><p:cNvPr id='2' name='N' hidden='0'/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/></p:sp>" },
  { name: 'fragment: hidden group', spTree: grp(leaf('5')).replace('name="Group 1"', 'name="Group 1" hidden="1"') },
  { name: 'fragment: hidden connector', spTree: cxn(xfrm()).replace('name="Connector 1"', 'name="Connector 1" hidden="1"') },
  { name: 'fragment: hidden graphicFrame', spTree: '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="7" name="F" hidden="1"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="1" y="2"/><a:ext cx="3" cy="4"/></p:xfrm><a:graphic><a:graphicData uri="x"/></a:graphic></p:graphicFrame>' },
  { name: 'fragment: p:pic', spTree: '<p:pic><p:nvPicPr><p:cNvPr id="3" name="Pic"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId1"/></p:blipFill><p:spPr>' + xfrm() + '<a:prstGeom prst="rect"/></p:spPr></p:pic>', ctx: { mediaRels: [['rId1', 'ppt/media/a.png']] } },
  { name: 'fragment: graphicFrame unknown uri', spTree: '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="7" name="F"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="1" y="2"/><a:ext cx="3" cy="4"/></p:xfrm><a:graphic><a:graphicData uri="urn:other"/></a:graphic></p:graphicFrame>' },
  { name: 'fragment: AC choice graphicFrame passthrough then fallback pic', spTree: '<mc:AlternateContent><mc:Choice Requires="cx1"><p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="8" name="CX"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="1" y="2"/><a:ext cx="3" cy="4"/></p:xfrm><a:graphic><a:graphicData uri="urn:unknown"/></a:graphic></p:graphicFrame></mc:Choice><mc:Fallback><p:pic><p:nvPicPr><p:cNvPr id="9" name="FB"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId1"/></p:blipFill><p:spPr>' + xfrm('5', '6', '70', '80') + '</p:spPr></p:pic></mc:Fallback></mc:AlternateContent>' },
  { name: 'fragment: AC model3d with rot and rel', ctx: MODEL_CTX, spTree: '<mc:AlternateContent><mc:Choice Requires="am3d"><p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="8" name="M"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="1" y="2"/><a:ext cx="3" cy="4"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/drawing/2017/model3d"><am3d:model3d r:embed="rId3d"><am3d:trans><am3d:rot ax="60000" ay="-1.5e3" az="abc"/></am3d:trans></am3d:model3d></a:graphicData></a:graphic></p:graphicFrame></mc:Choice><mc:Fallback><p:pic><p:nvPicPr><p:cNvPr id="9" name="FB"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId1"/></p:blipFill><p:spPr>' + xfrm() + '</p:spPr></p:pic></mc:Fallback></mc:AlternateContent>' },
  { name: 'fragment: AC model3d without embed reads "undefined" rel', ctx: MODEL_CTX, spTree: '<mc:AlternateContent><mc:Choice Requires="am3d"><p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="8" name="M"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm/><a:graphic><a:graphicData uri="u"><am3d:model3d><am3d:trans/></am3d:model3d></a:graphicData></a:graphic></p:graphicFrame></mc:Choice><mc:Fallback><p:pic><p:nvPicPr><p:cNvPr id="9" name="FB"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill/><p:spPr/></p:pic></mc:Fallback></mc:AlternateContent>' },
  { name: 'fragment: AC model3d unknown rel', ctx: { model3dRels: [['other', 'x']] }, spTree: '<mc:AlternateContent><mc:Choice Requires="am3d"><p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="8" name="M"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><a:graphic><a:graphicData uri="u"><am3d:model3d r:embed="rIdX"/></a:graphicData></a:graphic></p:graphicFrame></mc:Choice><mc:Fallback><p:pic><p:nvPicPr><p:cNvPr id="9" name="FB"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:spPr/></p:pic></mc:Fallback></mc:AlternateContent>' },
  { name: 'fragment: AC ink contentPart xfrm', spTree: '<mc:AlternateContent><mc:Choice Requires="p14"><p:contentPart r:id="rId9"><p14:xfrm flipH="1" rot="5400000"><a:off x="7" y="8"/><a:ext cx="90" cy="91"/></p14:xfrm></p:contentPart></mc:Choice><mc:Fallback><p:pic><p:nvPicPr><p:cNvPr id="9" name="Ink"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill/><p:spPr>' + xfrm('1', '2', '3', '99999') + '</p:spPr></p:pic></mc:Fallback></mc:AlternateContent>' },
  { name: 'fragment: AC two choices, second ink', spTree: '<mc:AlternateContent><mc:Choice Requires="a"><p:contentPart/></mc:Choice><mc:Choice Requires="b"><p:contentPart><p14:xfrm><a:off x="1" y="1"/></p14:xfrm></p:contentPart></mc:Choice><mc:Fallback><p:pic><p:nvPicPr><p:cNvPr id="9" name="Ink"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:spPr/></p:pic></mc:Fallback></mc:AlternateContent>' },
  { name: 'fragment: AC fallback sp', spTree: '<mc:AlternateContent><mc:Choice Requires="x"/><mc:Fallback>' + sp(rect(), { tx: txBody('fb') }) + '</mc:Fallback></mc:AlternateContent>' },
  { name: 'fragment: AC nothing renderable is silent', spTree: '<mc:AlternateContent><mc:Choice Requires="x"><p:other/></mc:Choice><mc:Fallback><p:sp/></mc:Fallback></mc:AlternateContent>' },
  { name: 'fragment: AC empty', spTree: '<mc:AlternateContent></mc:AlternateContent>' + '<mc:AlternateContent>t</mc:AlternateContent>' },
  { name: 'fragment: AC math-shaped top-level block', spTree: '<mc:AlternateContent><mc:Choice Requires="a14"><a14:m/></mc:Choice><mc:Fallback>' + sp(rect()) + '</mc:Fallback></mc:AlternateContent>' },
  { name: 'fragment: grpSp parse error is passthrough', spTree: grp(leaf('5') + '<p:sp><a:x></p:sp>') },
  { name: 'fragment: sp parse error throws', spTree: '<p:sp><p:spPr></p:sp>' },

  // ── parseSpShape ───────────────────────────────────────────────────
  { name: 'sp: no spPr, no geometry', spTree: '<p:sp>' + nvSp() + '</p:sp>' },
  { name: 'sp: empty spPr element', spTree: '<p:sp>' + nvSp() + '<p:spPr/>' + txBody() + '</p:sp>' },
  { name: 'sp: text box txBox rect', spTree: sp(rect(), { nv: '<p:nvSpPr><p:cNvPr id="2" name="TextBox 1"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>', tx: txBody() }) },
  { name: 'sp: txBox with ellipse is shape', spTree: sp(xfrm() + '<a:prstGeom prst="ellipse"/>', { nv: '<p:nvSpPr><p:cNvPr id="2" name="T"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>', tx: txBody() }) },
  { name: 'sp: txBox="true" is not a text box', spTree: sp(rect(), { nv: '<p:nvSpPr><p:cNvPr id="2" name="T"/><p:cNvSpPr txBox="true"/><p:nvPr/></p:nvSpPr>', tx: txBody() }) },
  { name: 'sp: geometry-less txBody is text', spTree: sp(xfrm(), { tx: txBody() }) },
  { name: 'sp: empty prst is no geometry', spTree: sp(xfrm() + '<a:prstGeom prst=""/>', { tx: txBody() }) },
  { name: 'sp: prstGeom repeated', spTree: sp(xfrm() + '<a:prstGeom prst="rect"/><a:prstGeom prst="ellipse"/>') },
  { name: 'sp: custGeom', spTree: sp(xfrm() + '<a:custGeom><a:avLst/><a:gdLst/><a:pathLst><a:path w="100" h="100"><a:moveTo><a:pt x="0" y="0"/></a:moveTo><a:lnTo><a:pt x="100" y="100"/></a:lnTo><a:close/></a:path></a:pathLst></a:custGeom>', { tx: txBody() }) },
  { name: 'sp: custGeom txBox', spTree: sp(xfrm() + '<a:custGeom><a:pathLst><a:path w="10" h="10"><a:moveTo><a:pt x="0" y="0"/></a:moveTo></a:path></a:pathLst></a:custGeom>', { nv: '<p:nvSpPr><p:cNvPr id="2" name="T"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>', tx: txBody() }) },
  { name: 'sp: empty custGeom element', spTree: sp(xfrm() + '<a:custGeom/>') },
  { name: 'sp: useBgFill 1 / true / 0', spTree: sp(rect(), { attrs: ' useBgFill="1"' }) + sp(rect(), { attrs: ' useBgFill="true"' }) + sp(rect(), { attrs: ' useBgFill="0"' }) },
  { name: 'sp: fill, overlay, softEdge', spTree: sp(rect(solid('FF0000') + effect('<a:softEdge rad="12700"/><a:fillOverlay blend="mult">' + solid('00FF00') + '</a:fillOverlay>'))) },
  { name: 'sp: overlay noFill dropped, softEdge non-numeric', spTree: sp(rect(effect('<a:softEdge rad="abc"/><a:fillOverlay><a:noFill/></a:fillOverlay>'))) },
  { name: 'sp: softEdge without rad', spTree: sp(rect(effect('<a:softEdge/>'))) },
  { name: 'sp: softEdge negative and huge', spTree: sp(rect(effect('<a:softEdge rad="-5"/>'))) + sp(rect(effect('<a:softEdge rad="99999999999999999999999"/>'))) },
  { name: 'sp: name absent', spTree: '<p:sp><p:nvSpPr><p:cNvPr id="2"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/></p:sp>' },
  { name: 'sp: no nvSpPr', spTree: '<p:sp><p:spPr>' + rect() + '</p:spPr></p:sp>' },

  // placeholders
  { name: 'ph: title without xfrm inherits layout', ctx: PH_CTX, spTree: sp('', { nv: nvSp('2', 'Title 1', '', '<p:ph type="title"/>'), tx: txBody('T') }) },
  { name: 'ph: title off without ext keeps offset', ctx: PH_CTX, spTree: sp('<a:xfrm><a:off x="9" y="8"/></a:xfrm>', { nv: nvSp('2', 'Title 1', '', '<p:ph type="title"/>'), tx: txBody('T') }) },
  { name: 'ph: empty xfrm element', ctx: PH_CTX, spTree: sp('<a:xfrm/>', { nv: nvSp('2', 'Title 1', '', '<p:ph type="title"/>'), tx: txBody('T') }) },
  { name: 'ph: idx only body', ctx: PH_CTX, spTree: sp('', { nv: nvSp('3', 'Content', '', '<p:ph idx="1"/>'), tx: txBody('B') }) },
  { name: 'ph: master body blip fill, anchor middle', ctx: PH_CTX, spTree: sp('', { nv: nvSp('3', 'Body', '', '<p:ph type="body" idx="7"/>'), tx: txBody('B') }) },
  { name: 'ph: own anchor kept', ctx: PH_CTX, spTree: sp('', { nv: nvSp('2', 'Title', '', '<p:ph type="title"/>'), tx: '<p:txBody><a:bodyPr anchor="t" anchorCtr="0"/><a:p><a:r><a:t>x</a:t></a:r></a:p></p:txBody>' }) },
  { name: 'ph: self-closing ph with no attributes is no placeholder', ctx: PH_CTX, spTree: sp('', { nv: nvSp('2', 'P', '', '<p:ph/>'), tx: txBody() }) },
  { name: 'ph: unmatched type without layers', spTree: sp('', { nv: nvSp('2', 'P', '', '<p:ph type="dt" idx="10"/>'), tx: txBody() }) },
  { name: 'ph: type constructor', ctx: PH_CTX, spTree: sp('', { nv: nvSp('2', 'P', '', '<p:ph type="constructor" idx="__proto__"/>'), tx: txBody() }) },
  { name: 'ph: own fill wins', ctx: PH_CTX, spTree: sp(solid('00FF00'), { nv: nvSp('2', 'Title', '', '<p:ph type="title"/>') }) },
  { name: 'nonph: defaultTextStyle chain', ctx: DTS_CTX, spTree: sp(rect(), { tx: txBody() }) },

  // p:style
  { name: 'style: fill/ln/effect/font refs from theme', ctx: THEME_CTX, spTree: sp(rect(), { style: styleRefs('1', '1', '2', '<a:schemeClr val="lt1"/>'), tx: '<p:txBody><a:bodyPr/><a:p><a:r><a:rPr/><a:t>a</a:t></a:r><a:r><a:rPr><a:solidFill><a:srgbClr val="00FF00"/></a:solidFill></a:rPr><a:t>b</a:t></a:r></a:p><a:p><a:r><a:t>c</a:t></a:r></a:p></p:txBody>' }) },
  { name: 'style: bg fill ref 1001, glow effect 3', ctx: THEME_CTX, spTree: sp(rect(), { style: styleRefs('2', '1001', '3', '') }) },
  { name: 'style: fill ref 2 noFill template, gradient 3', ctx: THEME_CTX, spTree: sp(rect(), { style: styleRefs('3', '2', '1', '') }) + sp(rect(), { style: styleRefs('0', '3', '0', '') }) },
  { name: 'style: idx beyond theme lists falls back to color', ctx: THEME_CTX, spTree: sp(rect(), { style: styleRefs('9', '7', '9', '') }) + sp(rect(), { style: styleRefs('99999999999999999999', '1009', '-1', '') }) },
  { name: 'style: no theme', spTree: sp(rect(), { style: styleRefs('1', '1', '1', '<a:srgbClr val="ABCDEF"/>'), tx: txBody() }) },
  { name: 'style: refs without color', ctx: THEME_CTX, spTree: sp(rect(), { style: '<p:style><a:lnRef idx="1"/><a:fillRef idx="1"/><a:effectRef idx="2"/><a:fontRef idx="minor"/></p:style>' }) },
  { name: 'style: non-numeric idx', ctx: THEME_CTX, spTree: sp(rect(), { style: '<p:style><a:lnRef idx="x"><a:srgbClr val="111111"/></a:lnRef><a:fillRef idx=""><a:srgbClr val="222222"/></a:fillRef><a:effectRef idx="1.9"><a:srgbClr val="333333"/></a:effectRef><a:fontRef/></p:style>' }) },
  { name: 'style: explicit noFill line beats lnRef, explicit shadow beats effectRef', ctx: THEME_CTX, spTree: sp(rect(ln('', '<a:noFill/>') + effect('<a:outerShdw><a:srgbClr val="000000"/></a:outerShdw>')), { style: styleRefs('1', '1', '3', '') }) },
  { name: 'style: empty p:style', ctx: THEME_CTX, spTree: sp(rect(), { style: '<p:style/>' }) + sp(rect(), { style: '<p:style>text</p:style>' }) },
  { name: 'style: fontRef color reaches text chain', ctx: DTS_CTX, spTree: sp(rect(), { style: '<p:style><a:fontRef idx="minor"><a:srgbClr val="FEDCBA"/></a:fontRef></p:style>', tx: txBody() }) },
  { name: 'style: theme media rels for blip template', ctx: { theme: { ...THEME, bgFillStyles: [{ 'a:blipFill': { 'a:blip': { '@_r:embed': 'rIdT' } } }] }, themeMediaRels: [['rIdT', 'ppt/media/theme.png']] }, spTree: sp(rect(), { style: styleRefs('0', '1001', '0', '') }) },

  // ── parseStroke / parseArrowEnd ─────────────────────────────────────
  { name: 'stroke: full', spTree: sp(rect(ln(' w="25400" cap="rnd" cmpd="dbl"', solid('112233') + '<a:prstDash val="sysDot"/><a:round/><a:headEnd type="triangle" w="sm" len="lg"/><a:tailEnd type="arrow"/>'))) },
  { name: 'stroke: caps and compounds', spTree: [['flat', 'sng'], ['sq', 'thickThin'], ['rnd', 'thinThick'], ['xx', 'tri'], ['', 'zz']].map(([c, m]) => sp(rect(ln(` cap="${c}" cmpd="${m}"`, solid('000000') + '<a:bevel/>')))).join('') },
  { name: 'stroke: miter join, bad width', spTree: sp(rect(ln(' w="abc"', solid('000000') + '<a:miter lim="800000"/>'))) + sp(rect(ln(' w="-1"', solid('000000')))) },
  { name: 'stroke: ln without fill is undefined', spTree: sp(rect(ln(' w="12700"', ''))) },
  { name: 'stroke: empty ln element', spTree: sp(rect('<a:ln/>')) },
  { name: 'stroke: ln text content', spTree: sp(rect('<a:ln>x</a:ln>')) },
  { name: 'stroke: repeated ln', spTree: sp(rect(ln('', solid('FF0000')) + ln('', solid('00FF00')))) },
  { name: 'stroke: ln noFill', spTree: sp(rect(ln('', '<a:noFill/>'))) },
  { name: 'stroke: dash empty', spTree: sp(rect(ln('', solid('000000') + '<a:prstDash val=""/>'))) + sp(rect(ln('', solid('000000') + '<a:prstDash/>'))) },
  { name: 'arrow: none, empty, sizes', spTree: sp(rect(ln('', solid('000000') + '<a:headEnd type="none" w="lg"/><a:tailEnd/>'))) + sp(rect(ln('', solid('000000') + '<a:headEnd w="lg"/><a:tailEnd type="" len="med"/>'))) + sp(rect(ln('', solid('000000') + '<a:headEnd type="oval" w="huge" len=""/><a:tailEnd type="stealth" w="med" len="sm"/>'))) },
  { name: 'arrow: repeated headEnd', spTree: sp(rect(ln('', solid('000000') + '<a:headEnd type="oval"/><a:headEnd type="arrow"/>'))) },
  // ledger inherited-key-parse-678: capMap['constructor'] answers Object (no cap key after JSON) and capMap['__proto__'] answers {} ("cap":{}); Rust: no cap
  { name: 'stroke: cap inherited names', seed: false, spTree: ['constructor', 'toString', '__proto__', 'hasOwnProperty'].map((c) => sp(rect(ln(` cap="${c}"`, solid('000000'))))).join('') },
  // ledger inherited-key-parse-686: cmpdMap['__proto__'] answers {} ("compound":{}); a function answer is dropped by JSON; Rust: no compound
  { name: 'stroke: cmpd inherited names', seed: false, spTree: ['constructor', 'toString', '__proto__', 'valueOf'].map((c) => sp(rect(ln(` cmpd="${c}"`, solid('000000'))))).join('') },
  // ledger inherited-key-parse-713: sizeMap['constructor'] answers Object ("w" dropped by JSON) and '__proto__' answers {}; Rust: 'med'
  { name: 'arrow: w/len inherited names', seed: false, spTree: ['constructor', 'toString', '__proto__'].map((c) => sp(rect(ln('', solid('000000') + `<a:headEnd type="arrow" w="${c}" len="${c}"/>`)))).join('') },

  // ── parseConnector ──────────────────────────────────────────────────
  { name: 'cxn: default stroke dk1 from theme', ctx: THEME_CTX, spTree: cxn(xfrm('0', '0', '100', '0', ' flipV="1"') + '<a:prstGeom prst="straightConnector1"><a:avLst/></a:prstGeom>') },
  { name: 'cxn: no theme default black, no prstGeom', spTree: cxn(xfrm()) },
  { name: 'cxn: ln without fill completes from lnRef', ctx: THEME_CTX, spTree: cxn(xfrm() + ln(' w="38100"', '<a:tailEnd type="triangle"/>'), { style: styleRefs('1', '0', '0', '') }) },
  { name: 'cxn: ln without fill and lnRef template without fill', ctx: THEME_CTX, spTree: cxn(xfrm() + ln('', ''), { style: styleRefs('3', '0', '0', '') }) },
  { name: 'cxn: lnRef noFill template falls back to ref color', ctx: THEME_CTX, spTree: cxn(xfrm(), { style: styleRefs('2', '0', '0', '') }) },
  { name: 'cxn: explicit noFill has no stroke', ctx: THEME_CTX, spTree: cxn(xfrm() + ln('', '<a:noFill/>'), { style: styleRefs('1', '0', '0', '') }) },
  { name: 'cxn: bent with adjusts and connections', spTree: cxn(xfrm() + '<a:prstGeom prst="bentConnector3"><a:avLst><a:gd name="adj1" fmla="val 50000"/></a:avLst></a:prstGeom>', { cxnPr: '<a:stCxn id="4" idx="2"/><a:endCxn id="x" idx="bad"/>' }) },
  { name: 'cxn: start only, end only, empty refs', spTree: cxn(xfrm(), { cxnPr: '<a:stCxn id="4"/>' }) + cxn(xfrm(), { cxnPr: '<a:endCxn id="-7" idx="3"/>' }) + cxn(xfrm(), { cxnPr: '<a:stCxn/><a:endCxn/>' }) + cxn(xfrm(), { cxnPr: '<a:stCxn idx="1">t</a:stCxn>' }) },
  { name: 'cxn: empty prst', spTree: cxn(xfrm() + '<a:prstGeom prst=""/>') },
  { name: 'cxn: no spPr', spTree: '<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="5"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr></p:cxnSp>' },

  // ── effects ─────────────────────────────────────────────────────────
  { name: 'glow: full, no rad, bad rad, no color', spTree: sp(rect(effect('<a:glow rad="63500">' + '<a:srgbClr val="FF0000"/></a:glow>'))) + sp(rect(effect('<a:glow><a:srgbClr val="FF0000"/></a:glow>'))) + sp(rect(effect('<a:glow rad="x1"><a:srgbClr val="FF0000"/></a:glow>'))) + sp(rect(effect('<a:glow rad="5"/>'))) + sp(rect(effect('<a:glow rad="1e999"><a:srgbClr val="FF0000"/></a:glow>'))) },
  { name: 'reflection: full and default', spTree: sp(rect(effect('<a:reflection blurRad="6350" stA="52000" endPos="35000" dist="1000" dir="5400000"/>'))) + sp(rect(effect('<a:reflection/>'))) + sp(rect(effect('<a:reflection stA="x" endPos=""></a:reflection>'))) + sp(rect(effect('<a:reflection stA="0">t</a:reflection>'))) },
  { name: 'reflection: attributes without stA or endPos', spTree: sp(rect(effect('<a:reflection blurRad="6350" dist="1000"/>'))) },
  { name: 'shadow: outer full', spTree: sp(rect(effect('<a:outerShdw blurRad="50800" dist="38100" dir="2700000" sx="90000" sy="-50000" kx="1200000" ky="0" algn="tl" rotWithShape="0"><a:prstClr val="black"><a:alpha val="40000"/></a:prstClr></a:outerShdw>'))) },
  { name: 'shadow: inner', spTree: sp(rect(effect('<a:innerShdw blurRad="63500" dist="50800" dir="13500000" kx="x"><a:srgbClr val="000000"/></a:innerShdw>'))) },
  { name: 'shadow: empty outer hides inner', spTree: sp(rect(effect('<a:outerShdw/><a:innerShdw><a:srgbClr val="000000"/></a:innerShdw>'))) },
  { name: 'shadow: no color, bad numbers', spTree: sp(rect(effect('<a:outerShdw blurRad="x"/>'))) + sp(rect(effect('<a:outerShdw blurRad="x" dist="" dir="-60000" sx="" sy="y"><a:srgbClr val="000000"/></a:outerShdw>'))) },
  { name: 'shadow: repeated outer', spTree: sp(rect(effect('<a:outerShdw><a:srgbClr val="000000"/></a:outerShdw><a:outerShdw><a:srgbClr val="FFFFFF"/></a:outerShdw>'))) },
  { name: 'effectLst empty', spTree: sp(rect('<a:effectLst/>')) },

  // ── parseScene3D ────────────────────────────────────────────────────
  { name: 'scene3d: full', spTree: sp(rect('<a:scene3d><a:camera prst="isometricOffAxis1Right"><a:rot lat="1" lon="2" rev="3"/></a:camera><a:lightRig rig="threePt" dir="t"><a:rot lat="x" lon="" rev="-4"/></a:lightRig></a:scene3d><a:sp3d extrusionH="76200" z="-12700" prstMaterial="metal"><a:bevelT w="1" h="2" prst="angle"/><a:extrusionClr><a:srgbClr val="ABCDEF"/></a:extrusionClr></a:sp3d>')) },
  { name: 'scene3d: no camera prst', spTree: sp(rect('<a:scene3d><a:camera/><a:lightRig rig="flat" dir="t"/></a:scene3d><a:sp3d extrusionH="1"/>')) },
  { name: 'scene3d: camera only, empty bevel and sp3d', spTree: sp(rect('<a:scene3d><a:camera prst="orthographicFront"><a:rot/></a:camera></a:scene3d><a:sp3d><a:bevelT/><a:extrusionClr/></a:sp3d>')) + sp(rect('<a:scene3d><a:camera prst="p"/></a:scene3d><a:sp3d/>')) },
  { name: 'scene3d: bad numbers, empty rig', spTree: sp(rect('<a:scene3d><a:camera prst="p"/><a:lightRig rig="" dir=""/></a:scene3d><a:sp3d extrusionH="x" z="" prstMaterial=""><a:bevelT w="x" prst=""/></a:sp3d>')) },
  { name: 'scene3d: no scene, sp3d only', spTree: sp(rect('<a:sp3d extrusionH="5"/>')) },

  // ── parseAvLst ──────────────────────────────────────────────────────
  { name: 'avLst: several guides', spTree: sp(xfrm() + '<a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val 16667"/><a:gd name="adj2" fmla="val   -500 extra"/><a:gd name="2" fmla="val 1"/><a:gd name="0" fmla="val 2"/></a:avLst></a:prstGeom>') },
  { name: 'avLst: non-val, missing name/fmla, empty', spTree: sp(xfrm() + '<a:prstGeom prst="a"><a:avLst><a:gd name="a" fmla="*/ 1 2 3"/><a:gd fmla="val 1"/><a:gd name="b"/><a:gd name="" fmla="val 3"/><a:gd name="c" fmla="val1"/></a:avLst></a:prstGeom>') + sp(xfrm() + '<a:prstGeom prst="b"><a:avLst/></a:prstGeom>') + sp(xfrm() + '<a:prstGeom prst="c"><a:avLst><a:gd/></a:avLst></a:prstGeom>') },
  { name: 'avLst: repeated name, huge value, inherited names', spTree: sp(xfrm() + '<a:prstGeom prst="d"><a:avLst><a:gd name="adj" fmla="val 1"/><a:gd name="adj" fmla="val 99999999999999999999999"/><a:gd name="constructor" fmla="val 5"/><a:gd name="toString" fmla="val 6"/></a:avLst></a:prstGeom>') },
  // ledger avlst-proto: out['__proto__'] = n sets no key in the TypeScript (adjust absent when it is the only guide); Rust keeps the guide
  { name: 'avLst: __proto__ guide', seed: false, spTree: sp(xfrm() + '<a:prstGeom prst="d"><a:avLst><a:gd name="__proto__" fmla="val 5"/></a:avLst></a:prstGeom>') + sp(xfrm() + '<a:prstGeom prst="d"><a:avLst><a:gd name="__proto__" fmla="val 5"/><a:gd name="adj" fmla="val 6"/></a:avLst></a:prstGeom>') },

  // ── xfrm ────────────────────────────────────────────────────────────
  { name: 'xfrm: rot, flips', spTree: sp(xfrm('1', '2', '3', '4', ' rot="5400000" flipH="1" flipV="true"')) + sp(xfrm('1', '2', '3', '4', ' rot="x" flipH="0" flipV="TRUE"')) + sp(xfrm('1', '2', '3', '4', ' rot=""')) },
  { name: 'xfrm: bad, negative, -0, huge, fractional coordinates', spTree: sp(xfrm('-0', '-5', '1.9', '1e3')) + sp(xfrm('abc', '', ' 7', '99999999999999999999999')) },
  { name: 'xfrm: off/ext missing or empty', spTree: sp('<a:xfrm><a:ext cx="5" cy="6"/></a:xfrm>') + sp('<a:xfrm><a:off/><a:ext/></a:xfrm>') + sp("<a:xfrm><a:off x='3' y='4'/></a:xfrm>") },

  // ── groups ──────────────────────────────────────────────────────────
  { name: 'group: depth 1 mixed children in document order', spTree: grp(leaf('11') + cxn(xfrm()) + leaf('12') + '<p:pic><p:nvPicPr><p:cNvPr id="13" name="P"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill/><p:spPr>' + xfrm() + '</p:spPr></p:pic>' + '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="14" name="F"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm/><a:graphic><a:graphicData uri="u"/></a:graphic></p:graphicFrame>' + leaf('15')) },
  { name: 'group: depth 5', spTree: nest(5) },
  { name: 'group: depth 64 (the bound) parses', spTree: nest(64) },
  { name: 'group: depth 65 is passthrough', spTree: nest(65) },
  { name: 'group: 65 self-closing groups do not nest', spTree: grp(leaf('15') + '<p:grpSp/>'.repeat(65) + leaf('16')) },
  { name: 'group: 10000 descendants parse', spTree: grp(sideBySide(10000)) },
  { name: 'group: 10001 descendants is passthrough', spTree: grp(sideBySide(10001)) },
  { name: 'group: nested groups count toward descendants', spTree: grp(grp(sideBySide(9998)) + leaf('9')) },
  { name: 'group: hidden child skipped, nvId on children', spTree: grp(sp(rect(), { nv: nvSp('21', 'H', ' hidden="1"') }) + leaf('22') + '<p:sp><p:nvSpPr><p:cNvPr name="noid"/></p:nvSpPr><p:spPr/></p:sp>') },
  { name: 'group: self-closing child sp keeps slots aligned', spTree: grp('<p:sp/>' + leaf('31') + '<p:cxnSp/>' + cxn(xfrm())) },
  { name: 'group: comment and CDATA among children', spTree: grp('<!-- <p:sp> -->' + leaf('41') + '<![CDATA[<p:sp>]]>' + leaf('42')) },
  { name: 'group: attribute with > and quotes', spTree: grp(sp(rect(), { nv: nvSp('51', 'a>b \'q\'') }) + "<p:sp><p:nvSpPr><p:cNvPr id='52' name='x\">y'/></p:nvSpPr><p:spPr/></p:sp>") },
  { name: 'group: grpFill child inherits group fill', spTree: grp(sp(rect('<a:grpFill/>')) + grp(sp(rect('<a:grpFill/>')), `<p:grpSpPr><a:grpFill/>${grpXfrm()}</p:grpSpPr>`), `<p:grpSpPr>${grpXfrm()}${solid('FF00FF')}</p:grpSpPr>`) },
  { name: 'group: grpFill with outer groupFill and no own fill', ctx: { groupFill: { type: 'solid', color: '#010203' } }, spTree: grp(sp(rect('<a:grpFill/>')), `<p:grpSpPr><a:grpFill/></p:grpSpPr>`) + grp(sp(rect('<a:grpFill/>'))) },
  { name: 'group: no chOff/chExt', spTree: grp(leaf('61'), `<p:grpSpPr>${xfrm()}</p:grpSpPr>`) },
  { name: 'group: chOff only, chExt only, empty', spTree: grp(leaf('62'), '<p:grpSpPr><a:xfrm><a:chOff x="5" y="-6"/></a:xfrm></p:grpSpPr>') + grp(leaf('63'), '<p:grpSpPr><a:xfrm><a:chExt cx="x" cy="7"/></a:xfrm></p:grpSpPr>') + grp(leaf('64'), '<p:grpSpPr><a:xfrm><a:chOff/><a:chExt/></a:xfrm></p:grpSpPr>') },
  { name: 'group: scale within and beyond COORD_MAX', spTree: grp(leaf('71'), `<p:grpSpPr>${grpXfrm('0', '2147483648', '0', '1')}</p:grpSpPr>`) + grp(leaf('72'), `<p:grpSpPr>${grpXfrm('0', '5000000', '0', '1')}</p:grpSpPr>`) + grp(leaf('73'), `<p:grpSpPr>${grpXfrm('0', '5222359', '0', '1')}</p:grpSpPr>`) },
  { name: 'group: zero and negative chExt, infinite ext', spTree: grp(leaf('81'), `<p:grpSpPr>${grpXfrm('0', '1000', '0', '0')}</p:grpSpPr>`) + grp(leaf('82'), `<p:grpSpPr>${grpXfrm('0', '1000', '0', '-5')}</p:grpSpPr>`) + grp(leaf('83'), `<p:grpSpPr>${grpXfrm('0', '9'.repeat(400), '0', '1')}</p:grpSpPr>`) + grp(leaf('84'), `<p:grpSpPr>${grpXfrm('9'.repeat(400), '10', '0', '0')}</p:grpSpPr>`) },
  { name: 'group: no grpSpPr, no nvGrpSpPr', spTree: '<p:grpSp>' + leaf('91') + '</p:grpSp>' },
  { name: 'group: empty group', spTree: grp('') + '<p:grpSp/>' },
  { name: 'group: unclosed child tag mismatch', spTree: grp(leaf('92') + '</p:sp>' + leaf('93')) },
  // ledger grpsppr-string-in: `'a:grpFill' in grpSpPr` throws a TypeError on `<p:grpSpPr/>` (an empty string node), so parseSlide throws for a schema-valid group; Rust reads it as a group without fill
  { name: 'group: self-closing grpSpPr', seed: false, spTree: grp(leaf('94'), '<p:grpSpPr/>') },
  { name: 'group: text grpSpPr', seed: false, spTree: grp(leaf('95'), '<p:grpSpPr>t</p:grpSpPr>') },
  { name: 'group: child sp parse feeds custGeom slice', spTree: grp(sp(xfrm() + '<a:custGeom><a:pathLst><a:path w="10" h="10"><a:moveTo><a:pt x="0" y="0"/></a:moveTo><a:lnTo><a:pt x="10" y="10"/></a:lnTo></a:path></a:pathLst></a:custGeom>', { nv: nvSp('96', 'G') }) + sp(xfrm() + '<a:custGeom><a:pathLst><a:path w="20" h="20"><a:moveTo><a:pt x="20" y="0"/></a:moveTo></a:path></a:pathLst></a:custGeom>', { nv: nvSp('97', 'H') })) },
  { name: 'group: child placeholder and styled connector', ctx: { ...PH_CTX }, spTree: grp(sp('', { nv: nvSp('98', 'Title', '', '<p:ph type="title"/>'), tx: txBody() }) + cxn(xfrm(), { style: styleRefs('1', '0', '0', '') })) },
]
