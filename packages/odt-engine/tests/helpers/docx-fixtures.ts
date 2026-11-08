/**
 * A Word document with every feature `docxToOdt` must carry: headings, a
 * numbered list, footnotes, two page sections (the second landscape with its
 * own header), a header and footer, a table with merged cells and Table Grid
 * borders, a picture, a chart, shapes with and without a fallback picture, an
 * inline and a display equation, a table of contents, a tracked change and a
 * comment.
 */
import { PNG_1X1 } from './hancom-sample'
import { type DocxSpec, chartRun, p, pictureRun, sectPr, shapeRun } from './build-docx'

export const NUMBERING =
  '<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:lvlJc w:val="left"/>' +
  '<w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>'

const listItem = (text: string) =>
  `<w:p><w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`

const cell = (text: string, tcPr = '') =>
  `<w:tc><w:tcPr><w:tcW w:w="3000" w:type="dxa"/>${tcPr}</w:tcPr>${p(text)}</w:tc>`

export const TABLE =
  '<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="9000" w:type="dxa"/><w:tblLook w:val="04A0"/></w:tblPr>' +
  '<w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/></w:tblGrid>' +
  `<w:tr>${cell('가나', '<w:gridSpan w:val="2"/>').replace('3000', '6000')}${cell('다')}</w:tr>` +
  `<w:tr>${cell('라', '<w:vMerge w:val="restart"/>')}${cell('마')}${cell('바')}</w:tr>` +
  `<w:tr><w:tc><w:tcPr><w:tcW w:w="3000" w:type="dxa"/><w:vMerge/></w:tcPr><w:p/></w:tc>${cell('사')}${cell('아')}</w:tr>` +
  '</w:tbl>'

const tocLine = (text: string, page: string) =>
  `<w:p><w:pPr><w:pStyle w:val="TOC1"/><w:tabs><w:tab w:val="right" w:leader="dot" w:pos="9016"/></w:tabs></w:pPr>` +
  `<w:hyperlink w:anchor="_Toc1" w:history="1"><w:r><w:t>${text}</w:t></w:r><w:r><w:tab/></w:r><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGEREF _Toc1 \\h </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>${page}</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:hyperlink></w:p>`

export const TOC =
  '<w:p><w:pPr><w:pStyle w:val="TOC1"/></w:pPr><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> TOC \\o "1-3" \\h \\z \\u </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r></w:p>' +
  tocLine('제목 하나', '1') +
  '<w:p><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>'

export const INLINE_MATH =
  '<w:p><w:r><w:t xml:space="preserve">식 </w:t></w:r><m:oMath><m:r><m:t>x=1</m:t></m:r></m:oMath><w:r><w:t xml:space="preserve"> 끝</w:t></w:r></w:p>'

export const DISPLAY_MATH =
  '<w:p><m:oMathPara><m:oMath><m:r><m:t>y=2</m:t></m:r></m:oMath></m:oMathPara></w:p>'

export function kitchenSink(): DocxSpec {
  const heading = (text: string) => p(text, '<w:pStyle w:val="Heading1"/>')
  const landscape = sectPr(
    '<w:headerReference w:type="default" r:id="rIdH1"/><w:footerReference w:type="default" r:id="rIdF1"/>',
  )
  const second = sectPr(
    '<w:headerReference w:type="default" r:id="rIdH2"/>',
    '<w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/>',
  )
  const body =
    heading('첫 제목') +
    p('본문 첫 문단입니다.') +
    `<w:p><w:r><w:t xml:space="preserve">각주가 있는 문단</w:t></w:r><w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:footnoteReference w:id="1"/></w:r><w:r><w:t xml:space="preserve"> 그리고 </w:t></w:r><w:r><w:rPr><w:rStyle w:val="Strong"/></w:rPr><w:t>굵게</w:t></w:r></w:p>` +
    listItem('하나') +
    listItem('둘') +
    TABLE +
    `<w:p>${pictureRun('rIdImg', 914400, 457200)}</w:p>` +
    `<w:p>${chartRun(2743200, 1371600)}</w:p>` +
    `<w:p>${shapeRun(1270000, 635000, 'rIdFallback')}</w:p>` +
    `<w:p>${shapeRun(1270000, 635000, null, 21)}</w:p>` +
    INLINE_MATH +
    DISPLAY_MATH +
    `<w:p><w:r><w:t xml:space="preserve">바뀐 </w:t></w:r><w:del w:id="5" w:author="a"><w:r><w:delText>지운</w:delText></w:r></w:del><w:ins w:id="6" w:author="a"><w:r><w:t>넣은</w:t></w:r></w:ins></w:p>` +
    `<w:p><w:pPr>${landscape}</w:pPr><w:r><w:t>첫 구역 끝</w:t></w:r></w:p>` +
    heading('둘째 구역') +
    p('가로 쪽 본문') +
    second
  return {
    body,
    numbering: NUMBERING,
    footnotes: { '1': '각주 본문' },
    parts: {
      rIdH1: { kind: 'header', inner: p('머리글 하나') },
      rIdF1: { kind: 'footer', inner: p('꼬리글 하나') },
      rIdH2: { kind: 'header', inner: p('머리글 둘') },
    },
    media: {
      rIdImg: { name: 'image1.png', data: PNG_1X1 },
      rIdFallback: { name: 'fallback.png', data: PNG_1X1 },
    },
  }
}
