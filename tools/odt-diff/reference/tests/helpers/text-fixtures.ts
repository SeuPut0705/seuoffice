/**
 * Hancom-like paragraphs for the text layer tests. Every piece is the exact
 * string written into the body.
 */
import type { BuildOdtOptions } from './build-odt'
import {
  escapeAttr,
  hFieldBookmark,
  hPara,
  hParagraphAutoStyle,
  hParaWith,
} from './hancom-fragments'

export const FIELD = 'NormalField1¡안건명¡안건명¡F¡T'
export const FIELD2 = 'NormalField2¡<성명> & "직위"¡¡F¡T'

export interface TextSample {
  options: BuildOdtOptions
  blocks: string[]
}

/** Paragraph styles with Hancom attributes, tab stops and page breaks. */
export function textAutoStyles(): string {
  return (
    hParagraphAutoStyle('P9_0', {
      parent: '바탕글',
      tabStops: [
        { position: '3.000cm' },
        { position: '14.993cm', type: 'right', leader: 'dotted' },
      ],
    }) +
    hParagraphAutoStyle('P_BREAK', { parent: '바탕글' }).replace(
      'fo:line-height="160%"',
      'fo:line-height="160%" fo:break-before="page"',
    ) +
    '<style:style style:name="T_MARK" style:family="text"><style:text-properties fo:color="#ff0000" fo:background-color="#ffff00" style:text-underline-style="solid" style:text-underline-width="auto" style:text-underline-color="font-color" fo:font-size="14.00pt" style:font-size-asian="14.00pt" style:font-size-complex="14.00pt" style:font-name="함초롬바탕" fo:font-family="함초롬바탕" style:letter-kerning="false"/></style:style>' +
    '<style:style style:name="T_LINK" style:family="text"><style:text-properties fo:color="#0000ff" style:text-underline-style="solid" style:text-underline-width="auto" style:text-underline-color="font-color"/></style:style>' +
    '<style:style style:name="H1_0" style:family="paragraph" style:parent-style-name="바탕글" style:default-outline-level="1"><style:paragraph-properties fo:text-align="start" style:text-autospace="none"/></style:style>' +
    '<text:list-style style:name="NL1"><text:list-level-style-number text:level="1" style:num-format="가, 나, 다, ..." style:num-suffix="."><style:list-level-properties text:list-level-position-and-space-mode="label-alignment"><style:list-level-label-alignment fo:margin-left="0.635cm" fo:text-indent="-0.635cm" text:label-followed-by="listtab" text:list-tab-stop-position="0.635cm"/></style:list-level-properties></text:list-level-style-number><text:list-level-style-bullet text:level="2" text:bullet-char="-"><style:list-level-properties text:list-level-position-and-space-mode="label-alignment"><style:list-level-label-alignment fo:margin-left="1.270cm" fo:text-indent="-0.635cm" text:label-followed-by="listtab"/></style:list-level-properties></text:list-level-style-bullet></text:list-style>'
  )
}

export function textSample(): TextSample {
  const field = hFieldBookmark(FIELD, '안건  내용')
  const field2 = hFieldBookmark(FIELD2, 'value')
  const blocks = [
    '<text:sequence-decls><text:sequence-decl text:display-outline-level="0" text:name="Table"/></text:sequence-decls>',
    // 1: plain Hancom paragraph with tab stops
    hPara('첫째 문단입니다', { style: 'P9_0', span: 'T1' }),
    // 2: two form fields, an unpaired start and a point bookmark
    hParaWith(
      `앞 ${field.xml} 중간 ${field2.xml}<text:bookmark-start text:name="NormalField3¡unfinished¡¡F¡T"/> 뒤<text:bookmark text:name="CellField1¡기관명¡F"/>`,
      { style: 'P9_0' },
    ),
    // 3: heading
    `<text:h text:style-name="H1_0" text:outline-level="1"><text:span text:style-name="T2">제목 하나</text:span></text:h>`,
    // 4: hyperlink inside a span
    hParaWith(
      `링크 <text:a xlink:type="simple" xlink:href="https://example.com/a?b=1&amp;c=2" office:target-frame-name="_self" text:style-name="T_LINK">여기</text:a> 끝`,
    ),
    // 5: a list with a nested level
    '<text:list text:style-name="NL1" xml:id="list1"><text:list-item>' +
      hPara('항목 하나') +
      '</text:list-item><text:list-item>' +
      hPara('항목 둘') +
      '<text:list><text:list-item>' +
      hPara('하위 항목') +
      '</text:list-item></text:list></text:list-item></text:list>',
    // 6: page break before
    hPara('새 쪽', { style: 'P_BREAK' }),
    // 7: spaces, tabs, line breaks
    hParaWith('  앞 공백<text:tab/>탭 <text:s text:c="3"/>공백<text:line-break/>둘째 줄 '),
    // 8: a text field and a note (kept inline constructs)
    hParaWith(
      '쪽 <text:page-number text:select-page="current">3</text:page-number> 번호<text:note text:note-class="footnote"><text:note-citation>1)</text:note-citation><text:note-body><text:p>각주</text:p></text:note-body></text:note> 끝',
    ),
    // 9: last paragraph
    hPara('마지막', { style: 'P9_0' }),
    // 10: strongly formatted text (colour, highlight, underline, size) for clearing
    hPara('강조된 글자', { style: 'P9_0', span: 'T_MARK' }),
  ]
  return {
    options: { body: blocks.join(''), extraContentAutomaticStyles: textAutoStyles() },
    blocks,
  }
}

export { escapeAttr }
