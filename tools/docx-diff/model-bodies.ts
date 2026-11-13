// Documents built to reach parser paths the tracked corpus does not, so that
// the key orders observed in parse results (model-gen.ts --observe-orders)
// include the orders those paths write. Each one names the producer in
// tools/docx-diff/reference it reaches. The capture (model-inputs.ts) and the
// gate (model-run.ts) parse every one with the same buildDocx call.
import { buildDocx, type BuildDocxOptions } from '../../packages/docx-engine/tests/helpers/build-docx'

export interface ModelBody extends BuildDocxOptions {
  name: string
}

/** The one buildDocx call both the capture and the gate parse a body with. */
export function buildModelBody(options: BuildDocxOptions): Promise<Uint8Array> {
  return buildDocx({ withNumbering: true, withImage: true, ...options })
}

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
const R = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
const VML = 'xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office"'
const DRAWING =
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"'
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const AT = 'w:author="Alice" w:date="2026-01-01T00:00:00Z"'

const p = (pPr: string, runs: string): string => `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${runs}</w:p>`
const r = (text: string, rPr = ''): string =>
  `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ''}<w:t xml:space="preserve">${text}</w:t></w:r>`

const FRAME_BOX =
  '<w:framePr w:w="2000" w:h="400" w:hRule="exact" w:wrap="around" w:vAnchor="text" w:hAnchor="margin" w:x="100" w:y="600"/>'
const DROP_CAP = '<w:framePr w:dropCap="drop" w:lines="2" w:wrap="around" w:vAnchor="text" w:hAnchor="text"/>'
const SHADED = '<w:shd w:val="pct25" w:color="FF0000" w:fill="FFFFFF"/>'
const CLEARED = '<w:shd w:val="clear" w:color="auto" w:fill="auto"/>'

/**
 * Every w:pPr child extractParaFormat (parse.ts) reads, in schema order, with
 * one frame, one shading and the direction given: the parser writes their
 * keys in its own order, which a document with fewer of them leaves open.
 */
const everyParaProperty = (style: string, frame: string, shading: string, bidi: string): string =>
  `${style}<w:keepNext/><w:keepLines/><w:pageBreakBefore/>${frame}<w:widowControl w:val="0"/><w:suppressLineNumbers/>` +
  '<w:pBdr><w:top w:val="single" w:sz="4" w:space="1" w:color="000000"/><w:bottom w:val="nil" w:space="4"/><w:left w:val="none"/></w:pBdr>' +
  `${shading}<w:tabs><w:tab w:val="left" w:pos="1440"/></w:tabs>` +
  '<w:wordWrap w:val="0"/><w:overflowPunct w:val="0"/><w:autoSpaceDE w:val="0"/><w:autoSpaceDN w:val="0"/>' +
  `${bidi}<w:snapToGrid w:val="0"/>` +
  '<w:spacing w:before="0" w:beforeAutospacing="1" w:after="0" w:afterAutospacing="1" w:line="276" w:lineRule="auto"/>' +
  '<w:ind w:left="240" w:right="120" w:hanging="120"/><w:contextualSpacing/><w:jc w:val="right"/><w:textDirection w:val="tbRl"/>' +
  '<w:rPr><w:lang w:eastAsia="ko-KR"/></w:rPr>'

/** vmlWordArtBox (parse-vml.ts) writes `{ runs, align }`; a text box paragraph (collectTxbxParas) writes runs, its format, then styleId */
const WORDART_BESIDE_TEXT_BOX = p(
  '',
  '<w:r><w:pict>' +
    '<v:shape id="wordArt1" type="#_x0000_t136" style="position:absolute;margin-left:10pt;margin-top:20pt;width:200pt;height:50pt" fillcolor="#ff0000" stroked="f">' +
    '<v:textpath style="font-family:&quot;Arial&quot;;font-size:36pt;font-weight:bold;font-style:italic" string="WORDART"/>' +
    '</v:shape></w:pict></w:r>' +
    '<w:r><w:pict>' +
    '<v:shape id="textBox1" type="#_x0000_t202" style="position:absolute;margin-left:10pt;margin-top:90pt;width:200pt;height:80pt" fillcolor="#ffffff" strokecolor="#000000">' +
    '<v:textbox><w:txbxContent>' +
    p(
      '<w:pStyle w:val="Heading1"/><w:keepNext/><w:keepLines/><w:pageBreakBefore/><w:widowControl w:val="0"/>' +
        '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr><w:suppressLineNumbers/>' +
        '<w:pBdr><w:top w:val="single" w:sz="4" w:space="1" w:color="000000"/></w:pBdr><w:shd w:val="clear" w:color="auto" w:fill="EEEEEE"/>' +
        '<w:tabs><w:tab w:val="left" w:pos="1440"/></w:tabs><w:snapToGrid w:val="0"/>' +
        '<w:spacing w:before="120" w:after="60" w:line="300" w:lineRule="auto"/><w:ind w:left="240" w:right="120" w:hanging="120" w:leftChars="100"/>' +
        '<w:contextualSpacing/><w:wordWrap w:val="0"/><w:overflowPunct w:val="0"/><w:autoSpaceDE w:val="0"/><w:autoSpaceDN w:val="0"/>' +
        '<w:bidi/><w:jc w:val="center"/><w:textDirection w:val="tbRl"/>',
      r('Box text'),
    ) +
    p('<w:jc w:val="right"/><w:ind w:left="240"/><w:rPr><w:sz w:val="40"/></w:rPr>', r(' ')) +
    p(
      '<w:pStyle w:val="RtlPara"/><w:pBdr><w:top w:val="single" w:sz="4" w:space="1" w:color="000000"/><w:bottom w:val="nil" w:space="4"/><w:left w:val="none"/></w:pBdr>' +
        '<w:shd w:val="pct25" w:color="FF0000" w:fill="FFFFFF"/><w:jc w:val="left"/><w:rPr><w:lang w:eastAsia="ko-KR"/></w:rPr>',
      r('Inherited direction'),
    ) +
    p('<w:shd w:val="clear" w:color="auto" w:fill="auto"/>', r('Cleared shading')) +
    p('<w:framePr w:dropCap="drop" w:lines="2" w:wrap="around" w:vAnchor="text" w:hAnchor="text"/>', r('D')) +
    p(
      '<w:framePr w:w="2000" w:h="400" w:hRule="exact" w:hSpace="120" w:wrap="around" w:vAnchor="text" w:hAnchor="margin" w:x="100" w:y="100"/>',
      r('Framed in a box'),
    ) +
    // extractParaFormat writes every key it reads in one order, bidi (or bidiInherited) first
    p(everyParaProperty('', FRAME_BOX, SHADED, '<w:bidi/>'), r('Boxed')) +
    p(everyParaProperty('', DROP_CAP, CLEARED, '<w:bidi/>'), r('R')) +
    p(everyParaProperty('<w:pStyle w:val="RtlPara"/>', FRAME_BOX, SHADED, ''), r('Boxed, direction inherited')) +
    p(everyParaProperty('<w:pStyle w:val="RtlPara"/>', DROP_CAP, CLEARED, ''), r('I')) +
    '<w:tbl><w:tblPr><w:tblW w:w="3000" w:type="dxa"/></w:tblPr><w:tblGrid><w:gridCol w:w="1500"/><w:gridCol w:w="1500"/></w:tblGrid>' +
    `<w:tr><w:tc>${p('', r('Box cell A'))}</w:tc><w:tc><w:tcPr><w:shd w:val="clear" w:color="auto" w:fill="CCCCCC"/></w:tcPr>${p('', r('Box cell B'))}</w:tc></w:tr></w:tbl>` +
    '</w:txbxContent></v:textbox></v:shape></w:pict></w:r>' +
    '<w:r><w:drawing><wp:inline><wp:extent cx="914400" cy="457200"/><wp:docPr id="31" name="Canvas 31"/>' +
    '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/lockedCanvas">' +
    '<lc:lockedCanvas xmlns:lc="http://schemas.openxmlformats.org/drawingml/2006/lockedCanvas"><a:nvGrpSpPr><a:cNvPr id="0" name=""/><a:cNvGrpSpPr/></a:nvGrpSpPr><a:grpSpPr/>' +
    '<a:txSp><a:txBody><a:bodyPr/><a:p><a:pPr algn="ctr"/><a:r><a:rPr sz="2400" b="1"><a:latin typeface="Arial"/></a:rPr><a:t>Logo</a:t></a:r></a:p>' +
    '<a:p><a:r><a:rPr sz="1200"/><a:t>Tagline</a:t></a:r></a:p></a:txBody></a:txSp>' +
    '</lc:lockedCanvas></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>',
)

/** a paragraph style whose direction a text box paragraph inherits (foldEffectiveFormat, extractParaFormat) */
const RTL_STYLE =
  '<w:style w:type="paragraph" w:styleId="RtlPara"><w:name w:val="Rtl Para"/><w:basedOn w:val="Normal"/><w:pPr><w:bidi/></w:pPr></w:style>'

/** extractLockedCanvas (parse.ts): a drawing canvas with a rotated, filled, texted shape and a picture */
const CANVAS_SHAPES = p(
  '',
  '<w:r><w:drawing><wp:inline><wp:extent cx="1828800" cy="914400"/><wp:docPr id="32" name="Canvas 32"/>' +
    '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/lockedCanvas">' +
    '<lc:lockedCanvas xmlns:lc="http://schemas.openxmlformats.org/drawingml/2006/lockedCanvas"><a:nvGrpSpPr><a:cNvPr id="0" name=""/><a:cNvGrpSpPr/></a:nvGrpSpPr>' +
    '<a:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1828800" cy="914400"/><a:chOff x="0" y="0"/><a:chExt cx="1828800" cy="914400"/></a:xfrm></a:grpSpPr>' +
    '<a:sp><a:nvSpPr><a:cNvPr id="1" name="Oval 1"/><a:cNvSpPr/></a:nvSpPr><a:spPr><a:xfrm rot="1200000"><a:off x="0" y="0"/><a:ext cx="914400" cy="457200"/></a:xfrm>' +
    '<a:prstGeom prst="ellipse"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="00FF00"/></a:solidFill>' +
    '<a:ln w="12700"><a:solidFill><a:srgbClr val="0000FF"/></a:solidFill></a:ln></a:spPr>' +
    '<a:txSp><a:txBody><a:bodyPr/><a:p><a:r><a:rPr sz="1400"><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></a:rPr><a:t>Shape text</a:t></a:r></a:p></a:txBody></a:txSp></a:sp>' +
    '<a:pic><a:nvPicPr><a:cNvPr id="2" name="Picture 2"/><a:cNvPicPr/></a:nvPicPr><a:blipFill><a:blip r:embed="rId10"/><a:srcRect l="10000"/></a:blipFill>' +
    '<a:spPr><a:xfrm rot="600000"><a:off x="914400" y="0"/><a:ext cx="457200" cy="457200"/></a:xfrm><a:prstGeom prst="roundRect"><a:avLst/></a:prstGeom></a:spPr></a:pic>' +
    '</lc:lockedCanvas></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>',
)

/** paragraphStrayBox (parse.ts): text beside a text box shape, its format assigned after the runs */
const TEXT_BESIDE_TEXT_BOX = p(
  '<w:jc w:val="right"/><w:spacing w:after="200"/>',
  r('Stray text') +
    '<w:r><w:pict>' +
    '<v:shape id="textBox2" type="#_x0000_t202" style="position:absolute;margin-left:0;margin-top:0;width:100pt;height:40pt" strokecolor="#000000">' +
    `<v:textbox><w:txbxContent>${p('', r('Inner'))}</w:txbxContent></v:textbox></v:shape></w:pict></w:r>`,
)

/** extractTable / extractCell / richParas (parse.ts), propChangeInfo of a cell */
const TABLE_WITH_EVERY_CELL_PROPERTY =
  '<w:tbl><w:tblPr><w:tblStyle w:val="GridStyle"/>' +
  '<w:tblpPr w:leftFromText="180" w:rightFromText="180" w:vertAnchor="text" w:horzAnchor="margin" w:tblpXSpec="center" w:tblpY="200"/>' +
  '<w:tblW w:w="6000" w:type="dxa"/><w:tblInd w:w="120" w:type="dxa"/><w:bidiVisual/>' +
  '<w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="1" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/>' +
  '<w:tblCaption w:val="Caption"/><w:tblDescription w:val="Description"/></w:tblPr>' +
  '<w:tblGrid><w:gridCol w:w="1000"/><w:gridCol w:w="1000"/><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/></w:tblGrid>' +
  `<w:tr><w:trPr><w:gridBefore w:val="2"/><w:wBefore w:w="2000" w:type="dxa"/><w:trHeight w:val="500" w:hRule="exact"/><w:ins w:id="31" ${AT}/></w:trPr>` +
  '<w:tc><w:tcPr><w:tcW w:w="4000" w:type="dxa"/><w:gridSpan w:val="2"/><w:vMerge w:val="restart"/>' +
  '<w:shd w:val="clear" w:color="auto" w:fill="FFCC00"/><w:vAlign w:val="center"/>' +
  '<w:tcMar><w:top w:w="80" w:type="dxa"/><w:left w:w="100" w:type="dxa"/></w:tcMar>' +
  '<w:textDirection w:val="btLr"/><w:noWrap/><w:hideMark/>' +
  '<w:tcBorders><w:top w:val="single" w:sz="8" w:color="FF0000"/></w:tcBorders>' +
  `<w:cellIns w:id="32" ${AT}/>` +
  `<w:tcPrChange w:id="33" ${AT} w:vMerge="rest" w:vMergeOrig="cont"><w:tcPr><w:shd w:val="clear" w:color="auto" w:fill="00FF00"/></w:tcPr></w:tcPrChange>` +
  '</w:tcPr>' +
  p(
    '<w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr><w:jc w:val="center"/>',
    r('Listed cell paragraph'),
  ) +
  '</w:tc></w:tr>' +
  '<w:tr><w:trPr><w:trHeight w:val="300"/></w:trPr>' +
  '<w:tc><w:tcPr><w:tcW w:w="1000" w:type="dxa"/></w:tcPr><w:p/></w:tc>' +
  '<w:tc><w:tcPr><w:tcW w:w="1000" w:type="dxa"/></w:tcPr><w:p/></w:tc>' +
  `<w:tc><w:tcPr><w:tcW w:w="4000" w:type="dxa"/><w:gridSpan w:val="2"/><w:vMerge/><w:cellMerge w:id="34" ${AT} w:vMerge="cont"/></w:tcPr><w:p/></w:tc>` +
  '</w:tr></w:tbl>'

/** the old paragraph properties of a w:pPrChange (parse.ts), as a list item and as a heading */
const PARAGRAPH_PROPERTY_CHANGES =
  p(
    `<w:jc w:val="center"/><w:pPrChange w:id="41" ${AT}><w:pPr><w:pStyle w:val="ListParagraph"/>` +
      '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr><w:jc w:val="left"/><w:spacing w:after="120"/></w:pPr></w:pPrChange>',
    r('Was a numbered item'),
  ) +
  p(
    `<w:pPrChange w:id="42" ${AT}><w:pPr><w:pStyle w:val="Heading1"/><w:ind w:left="360"/></w:pPr></w:pPrChange>`,
    r('Was a heading'),
  ) +
  // extractParaFormat writes every key it reads in one order, bidi first
  p(`<w:pPrChange w:id="44" ${AT}><w:pPr>${everyParaProperty('', FRAME_BOX, SHADED, '<w:bidi/>')}</w:pPr></w:pPrChange>`, r('Was boxed')) +
  p(`<w:pPrChange w:id="45" ${AT}><w:pPr>${everyParaProperty('', DROP_CAP, CLEARED, '<w:bidi/>')}</w:pPr></w:pPrChange>`, r('Was a drop cap'))

/**
 * sdtMeta (parse-sdt.ts) writes alias, tag, controlType, lock, id: a block
 * control of one paragraph (parseDocx) and one of two (parseSdtBlock)
 */
const BLOCK_CONTROLS =
  '<w:sdt><w:sdtPr><w:alias w:val="Choice"/><w:tag w:val="choice"/><w:id w:val="701"/><w:lock w:val="sdtLocked"/>' +
  '<w:dropDownList><w:listItem w:displayText="A" w:value="A"/></w:dropDownList></w:sdtPr>' +
  `<w:sdtContent>${p('', r('A'))}</w:sdtContent></w:sdt>` +
  '<w:sdt><w:sdtPr><w:alias w:val="Notes"/><w:tag w:val="notes"/><w:id w:val="702"/><w:richText/></w:sdtPr>' +
  `<w:sdtContent>${p('', r('First note'))}${p('', r('Second note'))}</w:sdtContent></w:sdt>`

/** a run formatting revision (w:rPrChange) and a framed paragraph (w:framePr) */
const RUN_CHANGE_AND_FRAME =
  p(
    '',
    `<w:r><w:rPr><w:b/><w:rPrChange w:id="43" ${AT}><w:rPr><w:i/><w:sz w:val="28"/></w:rPr></w:rPrChange></w:rPr><w:t>Changed run</w:t></w:r>`,
  ) +
  p(
    '<w:framePr w:w="3000" w:h="600" w:hRule="exact" w:hSpace="180" w:vSpace="90" w:wrap="around" w:vAnchor="text" w:hAnchor="margin" w:x="200" w:y="300" w:xAlign="right"/>',
    r('Framed'),
  )

/** fieldDisplayOf (parse-fields.ts): a TOC line with an outline number, a deleted one and an empty one */
const TOC_LINES =
  p(
    '<w:pStyle w:val="TOC1"/><w:tabs><w:tab w:val="left" w:pos="440"/><w:tab w:val="right" w:leader="dot" w:pos="9350"/></w:tabs><w:ind w:left="440" w:hanging="440"/>',
    '<w:hyperlink w:anchor="_Toc1">' +
      r('1.1', '<w:rStyle w:val="Hyperlink"/><w:rFonts w:ascii="Arial" w:eastAsia="SimSun"/><w:b/><w:sz w:val="24"/>') +
      '<w:r><w:tab/></w:r>' +
      r('Introduction 中文', '<w:rFonts w:ascii="Arial" w:eastAsia="SimSun"/><w:sz w:val="24"/>') +
      '<w:r><w:tab/></w:r>' +
      r('7') +
      '</w:hyperlink>',
  ) +
  p(
    `<w:pStyle w:val="TOC2"/><w:tabs><w:tab w:val="left" w:pos="440"/><w:tab w:val="right" w:leader="dot" w:pos="9350"/></w:tabs><w:ind w:left="440" w:hanging="440"/><w:rPr><w:del w:id="44" ${AT}/></w:rPr>`,
    `<w:del w:id="45" ${AT}><w:r><w:delText>2.1</w:delText></w:r><w:r><w:tab/></w:r><w:r><w:delText>Removed entry</w:delText></w:r><w:r><w:tab/></w:r><w:r><w:delText>9</w:delText></w:r></w:del>`,
  ) +
  p('<w:pStyle w:val="TOC1"/><w:rPr><w:sz w:val="28"/></w:rPr>', '')

const NUMBERING_XML =
  XML_DECL +
  `<w:numbering ${W} xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml">` +
  '<w:numPicBullet w:numPicBulletId="0"><w:pict><v:shape id="bullet0" type="#_x0000_t75" style="width:9pt;height:9pt" ' +
  `${VML}><v:imagedata r:id="rId1" o:title="" ${R}/></v:shape></w:pict></w:numPicBullet>` +
  '<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val="&#61623;"/></w:lvl></w:abstractNum>' +
  '<w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:start w:val="3"/>' +
  '<mc:AlternateContent><mc:Choice Requires="w14"><w:numFmt w:val="custom" w:format="01, 02, 03, ..."/></mc:Choice>' +
  '<mc:Fallback><w:numFmt w:val="decimalZero"/></mc:Fallback></mc:AlternateContent>' +
  '<w:lvlRestart w:val="0"/><w:pStyle w:val="ListParagraph"/><w:isLgl/><w:suff w:val="space"/><w:lvlText w:val="%1."/><w:lvlJc w:val="right"/><w:lvlPicBulletId w:val="0"/>' +
  '<w:pPr><w:bidi/><w:tabs><w:tab w:val="num" w:pos="720"/></w:tabs><w:ind w:left="720" w:right="120" w:hanging="360"/></w:pPr>' +
  '<w:rPr><w:rFonts w:ascii="Symbol" w:hAnsi="Symbol"/><w:b/><w:i/><w:color w:val="ff0000"/><w:sz w:val="28"/></w:rPr>' +
  '</w:lvl></w:abstractNum>' +
  '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>' +
  '<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>' +
  '</w:numbering>'

/** tableStyleDisplayOf (parse-styles.ts): a table style with every part the display reads */
const TABLE_STYLE =
  '<w:style w:type="table" w:styleId="GridStyle"><w:name w:val="Grid Style"/>' +
  '<w:pPr><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/><w:jc w:val="center"/></w:pPr>' +
  '<w:rPr><w:color w:val="333333"/><w:b/><w:i/><w:sz w:val="20"/><w:kern w:val="2"/></w:rPr>' +
  '<w:tblPr><w:tblStyleRowBandSize w:val="1"/>' +
  '<w:tblBorders><w:top w:val="single" w:sz="4" w:color="000000"/><w:insideH w:val="single" w:sz="4" w:color="000000"/></w:tblBorders>' +
  '<w:tblCellMar><w:left w:w="108" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr>' +
  '<w:tcPr><w:shd w:val="clear" w:color="auto" w:fill="F0F0F0"/></w:tcPr>' +
  '<w:tblStylePr w:type="firstRow"><w:pPr><w:spacing w:after="40"/><w:jc w:val="left"/></w:pPr><w:rPr><w:b/><w:caps/><w:color w:val="FFFFFF"/><w:sz w:val="22"/><w:rFonts w:ascii="Arial"/><w:spacing w:val="10"/></w:rPr>' +
  '<w:tcPr><w:tcBorders><w:bottom w:val="single" w:sz="8" w:color="000000"/></w:tcBorders><w:shd w:val="clear" w:color="auto" w:fill="000080"/><w:tcMar><w:top w:w="40" w:type="dxa"/></w:tcMar></w:tcPr></w:tblStylePr>' +
  '<w:tblStylePr w:type="band1Horz"><w:tcPr><w:shd w:val="clear" w:color="auto" w:fill="EEEEEE"/></w:tcPr></w:tblStylePr>' +
  '<w:tblStylePr w:type="band2Horz"><w:tcPr><w:shd w:val="clear" w:color="auto" w:fill="DDDDDD"/></w:tcPr></w:tblStylePr>' +
  '</w:style>'

/** readThemeFonts (theme.ts): every slot of both font groups */
const THEME_XML =
  XML_DECL +
  '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office Theme"><a:themeElements>' +
  '<a:clrScheme name="Office"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>' +
  '<a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2><a:accent1><a:srgbClr val="4472C4"/></a:accent1>' +
  '<a:accent2><a:srgbClr val="ED7D31"/></a:accent2><a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4>' +
  '<a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6>' +
  '<a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme>' +
  '<a:fontScheme name="Office">' +
  '<a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface="SimHei"/><a:cs typeface="Times New Roman"/><a:font script="Hang" typeface="Malgun Gothic"/></a:majorFont>' +
  '<a:minorFont><a:latin typeface="Calibri"/><a:ea typeface="SimSun"/><a:cs typeface="Arial"/><a:font script="Jpan" typeface="Yu Mincho"/></a:minorFont>' +
  '</a:fontScheme></a:themeElements></a:theme>'

const CHART_XML =
  XML_DECL +
  '<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" ' +
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  `${R}><c:chart>` +
  '<c:title><c:tx><c:rich><a:bodyPr/><a:p><a:pPr><a:defRPr sz="1600"/></a:pPr><a:r><a:rPr sz="1600"/><a:t>Sales</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title>' +
  '<c:plotArea><c:layout/><c:barChart><c:barDir val="bar"/><c:grouping val="stacked"/>' +
  '<c:ser><c:idx val="0"/><c:order val="0"/><c:tx><c:strRef><c:f>Sheet1!$B$1</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>East</c:v></c:pt></c:strCache></c:strRef></c:tx>' +
  '<c:spPr><a:solidFill><a:srgbClr val="4472C4"/></a:solidFill></c:spPr>' +
  '<c:cat><c:strRef><c:f>Sheet1!$A$2:$A$3</c:f><c:strCache><c:ptCount val="2"/><c:pt idx="0"><c:v>Q1</c:v></c:pt><c:pt idx="1"><c:v>Q2</c:v></c:pt></c:strCache></c:strRef></c:cat>' +
  '<c:val><c:numRef><c:f>Sheet1!$B$2:$B$3</c:f><c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="2"/><c:pt idx="0"><c:v>10</c:v></c:pt><c:pt idx="1"><c:v>20</c:v></c:pt></c:numCache></c:numRef></c:val>' +
  '</c:ser><c:dLbls><c:showLegendKey val="0"/><c:showVal val="1"/><c:showCatName val="0"/><c:showSerName val="0"/><c:showPercent val="0"/><c:showBubbleSize val="0"/></c:dLbls>' +
  '<c:axId val="111"/><c:axId val="222"/></c:barChart>' +
  '<c:catAx><c:axId val="111"/><c:delete val="0"/><c:axPos val="l"/><c:title><c:tx><c:rich><a:bodyPr/><a:p><a:r><a:t>Quarter</a:t></a:r></a:p></c:rich></c:tx></c:title>' +
  '<c:txPr><a:bodyPr/><a:p><a:pPr><a:defRPr sz="900"/></a:pPr></a:p></c:txPr><c:crossAx val="222"/></c:catAx>' +
  '<c:valAx><c:axId val="222"/><c:delete val="0"/><c:axPos val="b"/><c:majorGridlines><c:spPr><a:ln><a:solidFill><a:srgbClr val="D9D9D9"/></a:solidFill></a:ln></c:spPr></c:majorGridlines><c:crossAx val="111"/></c:valAx>' +
  '<c:dTable><c:showHorzBorder val="1"/><c:showVertBorder val="1"/><c:showOutline val="1"/><c:showKeys val="1"/></c:dTable>' +
  '</c:plotArea>' +
  '<c:legend><c:legendPos val="t"/><c:overlay val="0"/><c:txPr><a:bodyPr/><a:p><a:pPr><a:defRPr sz="1000"/></a:pPr></a:p></c:txPr></c:legend>' +
  '</c:chart><c:spPr><a:ln><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></a:ln></c:spPr></c:chartSpace>'

/**
 * parseChartPartXml spreads axesOf, whose keys follow the axes of the part:
 * catAx (axPos b, so xAxis) before valAx (axPos l, so yAxis), the order of
 * most charts and the reverse of CHART_XML. No c:legend gives noLegend.
 */
const LINE_CHART_XML =
  XML_DECL +
  '<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" ' +
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  `${R}><c:chart>` +
  '<c:plotArea><c:layout/><c:lineChart><c:grouping val="standard"/>' +
  '<c:ser><c:idx val="0"/><c:order val="0"/><c:marker><c:symbol val="circle"/></c:marker>' +
  '<c:cat><c:strRef><c:f>Sheet1!$A$2:$A$3</c:f><c:strCache><c:ptCount val="2"/><c:pt idx="0"><c:v>Q1</c:v></c:pt><c:pt idx="1"><c:v>Q2</c:v></c:pt></c:strCache></c:strRef></c:cat>' +
  '<c:val><c:numRef><c:f>Sheet1!$B$2:$B$3</c:f><c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="2"/><c:pt idx="0"><c:v>3</c:v></c:pt><c:pt idx="1"><c:v>5</c:v></c:pt></c:numCache></c:numRef></c:val>' +
  '</c:ser><c:marker val="1"/><c:axId val="333"/><c:axId val="444"/></c:lineChart>' +
  '<c:catAx><c:axId val="333"/><c:delete val="0"/><c:axPos val="b"/><c:crossAx val="444"/></c:catAx>' +
  '<c:valAx><c:axId val="444"/><c:delete val="0"/><c:axPos val="l"/><c:majorGridlines/><c:crossAx val="333"/></c:valAx>' +
  '</c:plotArea>' +
  '</c:chart></c:chartSpace>'

const chartParagraph = (rId: string, id: number): string =>
  `<w:p><w:r><w:drawing><wp:inline><wp:extent cx="5486400" cy="3200400"/><wp:docPr id="${id}" name="Chart ${id}"/>` +
  '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">' +
  `<c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="${rId}"/>` +
  '</a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>'

const picture = (rId: string, extra = ''): string =>
  '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic>' +
  `<pic:blipFill><a:blip r:embed="${rId}"/>${extra}</pic:blipFill><pic:spPr/></pic:pic></a:graphicData></a:graphic>`

/**
 * hfParagraphs, hfTableRowParagraphs, hfCellContent, textboxParagraphs and the
 * header pictures (parse.ts), readWatermarkShape (watermark.ts)
 */
const HEADER_XML =
  XML_DECL +
  `<w:hdr ${W} ${R} ${VML} ${DRAWING}>` +
  p(
    '<w:framePr w:wrap="around" w:vAnchor="text" w:hAnchor="margin" w:xAlign="center" w:y="1"/><w:tabs><w:tab w:val="center" w:pos="4513"/></w:tabs><w:jc w:val="left"/>',
    `${r('Left')}<w:r><w:ptab w:relativeTo="margin" w:alignment="right" w:leader="none"/></w:r>${r('Right')}`,
  ) +
  p(
    '',
    '<w:r><w:pict><v:shape id="hfBox" type="#_x0000_t202" style="position:absolute;margin-left:0;margin-top:0;width:100pt;height:30pt;z-index:1;' +
      'mso-position-horizontal:center;mso-position-horizontal-relative:margin;mso-position-vertical:top;mso-position-vertical-relative:page" strokecolor="#000000">' +
      `<v:textbox inset="2pt,2pt,2pt,2pt"><w:txbxContent>${p('<w:jc w:val="center"/>', r('In header box'))}</w:txbxContent></v:textbox></v:shape></w:pict></w:r>`,
  ) +
  p(
    '',
    '<w:r><w:drawing><wp:anchor behindDoc="1" distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="2" locked="0" layoutInCell="1" allowOverlap="1">' +
      '<wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="margin"><wp:align>right</wp:align></wp:positionH>' +
      '<wp:positionV relativeFrom="paragraph"><wp:posOffset>12700</wp:posOffset></wp:positionV>' +
      '<wp:extent cx="1270000" cy="381000"/><wp:wrapSquare wrapText="bothSides"/><wp:docPr id="23" name="Text Box 23"/>' +
      '<a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">' +
      '<wps:wsp xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:spPr><a:xfrm rot="600000"><a:off x="0" y="0"/><a:ext cx="1270000" cy="381000"/></a:xfrm>' +
      '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:ln w="12700"><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></a:ln></wps:spPr>' +
      `<wps:txbx><w:txbxContent>${p('', r('Anchored box'))}</w:txbxContent></wps:txbx>` +
      '<wps:bodyPr lIns="45720" tIns="45720" rIns="45720" bIns="45720" anchor="ctr"/></wps:wsp></a:graphicData></a:graphic></wp:anchor></w:drawing></w:r>',
  ) +
  '<w:tbl><w:tblPr><w:tblpPr w:vertAnchor="text" w:horzAnchor="margin" w:tblpXSpec="center" w:tblpY="1"/>' +
  '<w:tblW w:w="5000" w:type="dxa"/><w:jc w:val="center"/><w:tblInd w:w="100" w:type="dxa"/>' +
  '<w:tblCellMar><w:left w:w="100" w:type="dxa"/></w:tblCellMar></w:tblPr>' +
  '<w:tblGrid><w:gridCol w:w="2500"/><w:gridCol w:w="2500"/></w:tblGrid>' +
  '<w:tr><w:trPr><w:trHeight w:val="400" w:hRule="exact"/></w:trPr>' +
  '<w:tc><w:tcPr><w:tcW w:w="2500" w:type="dxa"/><w:shd w:val="clear" w:color="auto" w:fill="DDDDDD"/><w:vAlign w:val="center"/>' +
  '<w:tcMar><w:top w:w="50" w:type="dxa"/></w:tcMar><w:tcBorders><w:top w:val="single" w:sz="8" w:color="000000"/></w:tcBorders></w:tcPr>' +
  p(
    '<w:pStyle w:val="Heading1"/><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs><w:spacing w:before="120" w:after="60" w:line="300" w:lineRule="exact"/>' +
      '<w:ind w:left="120" w:firstLine="120"/><w:wordWrap w:val="0"/><w:jc w:val="center"/>',
    r('Cell'),
  ) +
  '<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="1000"/></w:tblGrid>' +
  `<w:tr><w:tc>${p('', r('Nested'))}</w:tc></w:tr></w:tbl><w:p/>` +
  '</w:tc>' +
  `<w:tc><w:tcPr><w:tcW w:w="2500" w:type="dxa"/></w:tcPr>${p('', r('B'))}</w:tc>` +
  '</w:tr></w:tbl>' +
  p(
    '',
    '<w:r><w:drawing><wp:anchor behindDoc="1" distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="1" locked="0" layoutInCell="1" allowOverlap="1">' +
      '<wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="margin"><wp:posOffset>914400</wp:posOffset></wp:positionH>' +
      '<wp:positionV relativeFrom="page"><wp:posOffset>457200</wp:posOffset></wp:positionV>' +
      '<wp:extent cx="914400" cy="457200"/><wp:wrapSquare wrapText="bothSides"/><wp:docPr id="21" name="Picture 21"/>' +
      `${picture('rId1', '<a:srcRect l="10000" t="5000"/>')}</wp:anchor></w:drawing></w:r>`,
  ) +
  p(
    '<w:jc w:val="center"/>',
    `<w:r><w:drawing><wp:inline><wp:extent cx="457200" cy="457200"/><wp:docPr id="22" name="Picture 22"/>${picture('rId1')}</wp:inline></w:drawing></w:r>`,
  ) +
  p(
    '',
    '<w:r><w:pict><v:shape id="hfPicture" type="#_x0000_t75" style="position:absolute;margin-left:10pt;margin-top:10pt;width:50pt;height:50pt;rotation:30;z-index:-1">' +
      '<v:imagedata r:id="rId1" o:title=""/></v:shape></w:pict></w:r>',
  ) +
  p(
    '',
    '<w:r><w:pict><v:shape id="PowerPlusWaterMarkObject1" type="#_x0000_t136" ' +
      'style="position:absolute;margin-left:0;margin-top:0;width:400pt;height:100pt;rotation:315;z-index:-251654144;' +
      'mso-position-horizontal:center;mso-position-horizontal-relative:margin;mso-position-vertical:center;mso-position-vertical-relative:margin" ' +
      'fillcolor="silver" stroked="f"><v:fill opacity=".5"/>' +
      '<v:textpath style="font-family:&quot;Calibri&quot;;font-size:1pt;font-weight:bold;font-style:italic" string="DRAFT"/></v:shape></w:pict></w:r>',
  ) +
  p(
    '',
    '<w:r><w:drawing><wp:anchor behindDoc="0" distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="3" locked="0" layoutInCell="1" allowOverlap="1">' +
      '<wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="page"><wp:posOffset>100000</wp:posOffset></wp:positionH>' +
      '<wp:positionV relativeFrom="page"><wp:posOffset>200000</wp:posOffset></wp:positionV>' +
      '<wp:extent cx="914400" cy="457200"/><wp:wrapNone/><wp:docPr id="24" name="Group 24"/>' +
      '<a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingGroup">' +
      '<wpg:wgp xmlns:wpg="http://schemas.microsoft.com/office/word/2010/wordprocessingGroup"><wpg:cNvGrpSpPr/>' +
      '<wpg:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="457200"/><a:chOff x="0" y="0"/><a:chExt cx="914400" cy="457200"/></a:xfrm></wpg:grpSpPr>' +
      '<pic:pic><pic:nvPicPr><pic:cNvPr id="25" name="Picture 25"/><pic:cNvPicPr/></pic:nvPicPr>' +
      '<pic:blipFill><a:blip r:embed="rId1"/><a:srcRect l="10000" t="10000"/></pic:blipFill>' +
      '<pic:spPr><a:xfrm><a:off x="457200" y="0"/><a:ext cx="457200" cy="457200"/></a:xfrm></pic:spPr></pic:pic>' +
      '</wpg:wgp></a:graphicData></a:graphic></wp:anchor></w:drawing></w:r>',
  ) +
  '</w:hdr>'

const IMAGE_RELS =
  XML_DECL +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  `<Relationship Id="rId1" Type="${REL}/image" Target="media/image1.png"/>` +
  '</Relationships>'

const RELS_CONTENT_TYPE = 'application/vnd.openxmlformats-package.relationships+xml'

/** parseComments (parse-package.ts): a comment with an image and a paraId, a resolved one and its reply */
const COMMENTS_XML =
  XML_DECL +
  `<w:comments ${W} ${R} ${DRAWING} xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml">` +
  `<w:comment w:id="0" ${AT} w:initials="A"><w:p w14:paraId="1A2B3C4D">${r('Look at this')}` +
  '<w:r><w:drawing><wp:inline><wp:extent cx="190500" cy="95250"/><wp:docPr id="1" name="Picture 1"/>' +
  `${picture('rId1')}</wp:inline></w:drawing></w:r></w:p></w:comment>` +
  `<w:comment w:id="1" w:author="Bob" w:date="2026-01-02T00:00:00Z"><w:p w14:paraId="2B3C4D5E">${r('Reply')}</w:p></w:comment>` +
  '</w:comments>'

const COMMENTS_EXTENDED_XML =
  XML_DECL +
  '<w15:commentsEx xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml">' +
  '<w15:commentEx w15:paraId="1A2B3C4D" w15:done="1"/><w15:commentEx w15:paraId="2B3C4D5E" w15:paraIdParent="1A2B3C4D" w15:done="0"/>' +
  '</w15:commentsEx>'

export const MODEL_BODIES: ModelBody[] = [
  {
    name: 'vml shapes and text boxes',
    docRootExtraAttrs: VML,
    extraStylesXml: RTL_STYLE,
    bodyXml: WORDART_BESIDE_TEXT_BOX + TEXT_BESIDE_TEXT_BOX + CANVAS_SHAPES,
  },
  {
    name: 'tables, revisions, fields and numbering',
    docRootExtraAttrs: VML,
    numberingXml: NUMBERING_XML,
    extraStylesXml: TABLE_STYLE,
    bodyXml:
      TABLE_WITH_EVERY_CELL_PROPERTY +
      PARAGRAPH_PROPERTY_CHANGES +
      BLOCK_CONTROLS +
      RUN_CHANGE_AND_FRAME +
      TOC_LINES +
      chartParagraph('rId31', 11) +
      chartParagraph('rId32', 12),
    extraRels:
      `<Relationship Id="rId31" Type="${REL}/chart" Target="charts/chart1.xml"/>` +
      `<Relationship Id="rId32" Type="${REL}/chart" Target="charts/chart2.xml"/>`,
    extraParts: [
      {
        path: 'word/charts/chart1.xml',
        xml: CHART_XML,
        contentType: 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml',
      },
      {
        path: 'word/charts/chart2.xml',
        xml: LINE_CHART_XML,
        contentType: 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml',
      },
      {
        path: 'word/theme/theme1.xml',
        xml: THEME_XML,
        contentType: 'application/vnd.openxmlformats-officedocument.theme+xml',
      },
      { path: 'word/_rels/numbering.xml.rels', xml: IMAGE_RELS, contentType: RELS_CONTENT_TYPE },
    ],
    sectPrExtra:
      '<w:footnotePr><w:pos w:val="beneathText"/><w:numFmt w:val="lowerRoman"/><w:numStart w:val="3"/><w:numRestart w:val="eachSect"/></w:footnotePr>' +
      '<w:endnotePr><w:pos w:val="sectEnd"/><w:numFmt w:val="upperLetter"/></w:endnotePr>',
  },
  {
    name: 'a header with text, a table, pictures and a watermark',
    docRootExtraAttrs: VML,
    bodyXml: p('', r('Body')),
    extraRels: `<Relationship Id="rId41" Type="${REL}/header" Target="header1.xml"/>`,
    extraParts: [
      {
        path: 'word/header1.xml',
        xml: HEADER_XML,
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml',
      },
      { path: 'word/_rels/header1.xml.rels', xml: IMAGE_RELS, contentType: RELS_CONTENT_TYPE },
      {
        path: 'word/settings.xml',
        xml: `${XML_DECL}<w:settings ${W}><w:compat><w:doNotUseHTMLParagraphAutoSpacing/></w:compat></w:settings>`,
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml',
      },
    ],
    sectPrExtra: '<w:headerReference w:type="default" r:id="rId41"/>',
  },
  {
    name: 'comments with an image, resolved and replied to',
    bodyXml: p(
      '',
      '<w:commentRangeStart w:id="0"/><w:commentRangeStart w:id="1"/>' +
        r('Commented') +
        '<w:commentRangeEnd w:id="0"/><w:r><w:commentReference w:id="0"/></w:r>' +
        '<w:commentRangeEnd w:id="1"/><w:r><w:commentReference w:id="1"/></w:r>',
    ),
    extraRels:
      `<Relationship Id="rId51" Type="${REL}/comments" Target="comments.xml"/>` +
      '<Relationship Id="rId52" Type="http://schemas.microsoft.com/office/2011/relationships/commentsExtended" Target="commentsExtended.xml"/>',
    extraParts: [
      {
        path: 'word/comments.xml',
        xml: COMMENTS_XML,
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml',
      },
      { path: 'word/_rels/comments.xml.rels', xml: IMAGE_RELS, contentType: RELS_CONTENT_TYPE },
      {
        path: 'word/commentsExtended.xml',
        xml: COMMENTS_EXTENDED_XML,
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.commentsExtended+xml',
      },
    ],
  },
  {
    // firstPageBreakAt (parse.ts parseDocx): the first sectPr ends the first page, so cover art after it
    // is not pinned to the page; the closing sectPr of the body is a later boundary and must not be taken
    name: 'page-pinned cover art after a section break',
    docRootExtraAttrs: DRAWING,
    bodyXml:
      p('<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>', r('First section')) +
      p(
        '',
        '<w:r><w:drawing><wp:anchor behindDoc="1" distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="3" locked="0" layoutInCell="1" allowOverlap="1">' +
          '<wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="page"><wp:posOffset>914400</wp:posOffset></wp:positionH>' +
          '<wp:positionV relativeFrom="page"><wp:posOffset>1371600</wp:posOffset></wp:positionV>' +
          '<wp:extent cx="2540000" cy="762000"/><wp:wrapNone/><wp:docPr id="24" name="Cover banner"/>' +
          '<a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">' +
          '<wps:wsp xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="2540000" cy="762000"/></a:xfrm>' +
          '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="DDEEFF"/></a:solidFill></wps:spPr>' +
          `<wps:txbx><w:txbxContent>${p('', r('Cover banner'))}</w:txbxContent></wps:txbx>` +
          '<wps:bodyPr/></wps:wsp></a:graphicData></a:graphic></wp:anchor></w:drawing></w:r>',
      ) +
      p('', r('Second section')),
  },
]
