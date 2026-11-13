// Inputs for the property readers that the tracked documents do not hold: no
// tracked .docx has a field, a ruby, a VML shape or a comment range, and their
// XML is machine-written in one style. Each text below is run through every
// reader, as a part and as the elements it holds, and seeds the mutations.
import type { Run } from './reference/types'

const p = (inner: string, attrs = ''): string => `<w:p${attrs}>${inner}</w:p>`
const r = (inner: string, rPr = ''): string =>
  `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ''}${inner}</w:r>`
const t = (text: string): string => `<w:t>${text}</w:t>`
const field = (instr: string, result = 'result'): string =>
  r('<w:fldChar w:fldCharType="begin"/>') +
  r(`<w:instrText xml:space="preserve">${instr}</w:instrText>`) +
  r('<w:fldChar w:fldCharType="separate"/>') +
  r(t(result)) +
  r('<w:fldChar w:fldCharType="end"/>')
const shape = (spPr: string, extra = ''): string =>
  `<mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><wp:anchor><wp:extent cx="5000000" cy="0"/><a:graphic><a:graphicData><wps:wsp><wps:spPr>${spPr}</wps:spPr>${extra}</wps:wsp></a:graphicData></a:graphic></wp:anchor></w:drawing></mc:Choice></mc:AlternateContent>`
const pict = (shapes: string): string => p(r(`<w:pict>${shapes}</w:pict>`))

export const PROPS_TEXTS: Record<string, string[]> = {
  'hidden text': [
    p(`<w:pPr><w:rPr><w:vanish/></w:rPr></w:pPr>${r(t('x'), '<w:vanish/>')}`),
    p(r(t('x'), '<w:vanish/>') + r(t('y'), '<w:vanish w:val="0"/>')),
    p(r(t('x'), `<w:vanish w:val='off'/>`)),
    p(r(t('x'), '<w:vanish w:val="FALSE"/>')),
    p(r(t('x'), '<w:vanish\tw:val="none"/>')),
    p(r(t('x'), '<w:vanish/><w:specVanish/>')),
    p(r(t('x'), '<w:vanish/><w:specVanish w:val="false"/>')),
    p(`<w:hyperlink r:id="rId1">${r(t('x'), '<w:vanish w:val="true"/>')}</w:hyperlink>`),
    p(`<w:ins w:id="1">${r(t('x'), '<w:vanish/>')}</w:ins>${r(t('y'))}`),
    p(r(t('x'), '<w:vanish/>') + '<w:r/>'),
    p(r(t('x'), '<w:vanish/>') + '<w:sectPr/>'),
    p(r(t('x'), '<w:vanish/>') + '<w:bookmarkStart\nw:id="1" w:name="a"/>'),
    p(r('<w:object/>', '<w:vanish/>')),
    p(''),
  ],
  'bookmarks and comment ranges': [
    p(
      '<w:bookmarkStart w:id="1" w:name="_Toc1"/><w:bookmarkStart w:id="2" w:name="user &amp; name"/>' +
        `<w:bookmarkStart w:id="3" w:name='single'/><w:bookmarkStart w:id="4" w:name="_Toc1"/>` +
        '<w:bookmarkStart w:id="5" w:name="user &amp; name"/><w:bookmarkStart w:id="6" w:name=""/>' +
        '<w:bookmarkStart\tw:id="7" w:name="tab"/><w:bookmarkStart w:name="&#95;hidden"/>' +
        '<w:bookmarkEnd w:id="1"/>',
    ),
    p(
      '<w:commentRangeStart w:id="3"/><w:commentRangeStart w:id="4"/>' +
        r(t('x')) +
        `<w:commentRangeEnd w:id="4"/><w:commentRangeEnd w:id = '5'/><w:commentRangeEnd w:id="5"/>`,
    ),
    p('<w:commentRangeStart w:initials="a" w:id="9"/><w:commentRangeStarted w:id="8"/>'),
    p('<w:commentRangeEnd w:id="1"/><w:commentRangeEnd xw:id="2"/>'),
  ],
  'paragraph properties as a slice': [
    p(
      '<w:pPr><w:pPrChange w:id="1"><w:pPr><w:jc w:val="left"/></w:pPr></w:pPrChange></w:pPr>' +
        r(t('x')),
    ),
    `<w:p>\n  <w:pPr>\n    <w:jc w:val="center"/>\n  </w:pPr>\n  ${r(t('x'))}\n</w:p>`,
    p('<w:pPr/>' + r(t('x'))),
    p('<w:pPr />' + r(t('x'))),
    p('<w:pPr\t><w:keepNext/></w:pPr\t>'),
    p('<w:pPr\n><w:keepNext/></w:pPr>'),
    p('<w:pPr a=">"><w:keepNext/></w:pPr>'),
    p('<w:pPrChange/><w:pPr/>'),
    p(r('<w:pPr/>')),
    '<w:p><w:pPr><w:jc/>',
    p('<w:pPr><w:pPr/></w:pPr>'),
    p('<w:pPr><w:pPr><w:pPr/></w:pPr><w:pPr></w:pPr></w:pPr><w:pPr/>'),
    p('</w:pPr><w:pPr/>'),
    p('\u00A0<w:pPr/>'),
    'no tag at all',
    '<w:p',
  ],
  'rules and drawings': [
    p(r('<w:drawing><wp:extent cx="5000000" cy="0"/></w:drawing>')),
    p(r('<w:drawing><wp:extent cx="0" cy="0"/></w:drawing>')),
    p(r('<w:drawing><wp:extent cx="1" cy="130000"/></w:drawing>')),
    p(r('<w:drawing><wp:extent cx="1" cy="130001"/></w:drawing>')),
    p(r('<w:drawing><wp:extent cx="99999999999999999999" cy="1"/></w:drawing>')),
    p(r(`<w:drawing><wp:extent cx='5' cy='5'/></w:drawing>`)),
    p(r('<w:drawing><wp:extent cy="5" cx="5"/></w:drawing>')),
    p(
      r(
        '<w:drawing><wp:extent cx="4762" cy="10"/><a:ln w="19050" cap="flat"><a:solidFill><a:srgbClr val="ff00aa"/></a:solidFill></a:ln></w:drawing>',
      ),
    ),
    p(
      r(
        '<w:drawing><wp:extent cx="14287" cy="10"/><a:ln w="100"><a:solidFill>\n<a:srgbClr val="ABCDEF"/></a:solidFill></a:ln></w:drawing>',
      ),
    ),
    p(
      r(
        '<w:drawing><a:ln><a:solidFill><a:srgbClr val="12345"/></a:solidFill></a:ln><a:ln w="9525"></a:ln></w:drawing>',
      ),
    ),
    p(r('<w:drawing><a:ln xw="1" w="28575"><a:noFill/></a:ln></w:drawing>')),
    p(r('<w:drawing><a:lnRef idx="1"/><a:ln w="0"></a:ln></w:drawing>')),
    p(
      r(
        '<w:drawing><a:ln w="12700"/><a:ln w="25400"><a:solidFill><a:srgbClr val="000000"/></a:solidFill></a:ln></w:drawing>',
      ),
    ),
  ],
  // the same document in other valid spellings: markup hidden in a comment, CDATA or
  // an instruction, spaced end tags, a `>` in an attribute value, single quotes
  'markup spellings': [
    p(
      `<w:bookmarkStart w:id="1" w:name = 'single quoted'/><w:bookmarkStart w:id="2" w:descr="a>b" w:name="after gt"/>` +
        `<w:bookmarkStart w:id = "3" w:name = "_Toc9" />`,
    ),
    p(`<!-- <w:bookmarkStart w:id="3" w:name="in comment"/> --><w:bookmarkStart w:id="4" w:name="own"/>`),
    p(`<![CDATA[<w:bookmarkStart w:id="3" w:name="in cdata"/>]]><w:bookmarkStart w:id="4" w:name='_hid den'/>`),
    `<w:p w:rsidR=">"><w:pPr><w:keepNext/></w:pPr>${r(t('x'))}</w:p>`,
    `<w:p w:rsidR='>'>\n<w:pPr><w:jc w:val="center"/></w:pPr ></w:p>`,
    `<w:p><!-- <w:pPr><w:jc w:val="left"/></w:pPr> --><w:pPr><w:jc w:val="right"/></w:pPr></w:p>`,
    `<w:p><w:pPr><w:keepNext/><!-- </w:pPr> --><w:keepLines/></w:pPr>${r(t('x'))}</w:p>`,
    `<w:p><w:pPr><w:keepNext/><![CDATA[</w:pPr>]]></w:pPr></w:p>`,
    `<w:p><w:pPr><w:keepNext/><?probe </w:pPr>?></w:pPr></w:p>`,
    `<w:p><w:pPr a=">"/>x</w:p>`,
    `<w:p><w:pPr a='/>'><w:keepNext/></w:pPr></w:p>`,
    `<w:p><![CDATA[<w:pPr/>]]></w:p>`,
    `<w:p><?probe <w:pPr/>?></w:p>`,
    `<w:p><w:pPr><w:pPrChange w:id="1"><w:pPr/></w:pPrChange ></w:pPr ><w:r/></w:p>`,
    p(r(`<w:drawing><wp:extent cx = '5000000' cy = "0"/></w:drawing>`)),
    p(r(`<w:drawing><!-- <wp:extent cx="1" cy="1"/> --><wp:extent cx="5000000" cy="0"/></w:drawing>`)),
    p(
      r(
        `<w:drawing><wp:extent cx="14287" cy="10"/><a:ln w = '19050'><a:solidFill><a:srgbClr val = 'AABBCC'/></a:solidFill></a:ln ></w:drawing>`,
      ),
    ),
    p(
      r(
        `<w:drawing><wp:extent cx="4762" cy="10" descr="a>b"/><a:ln w="100"><a:solidFill><a:srgbClr val="ABCDEF"/></a:solidFill></a:ln></w:drawing>`,
      ),
    ),
    p(
      r(
        `<w:drawing><![CDATA[<a:ln w="999"><a:solidFill><a:srgbClr val="000000"/></a:solidFill></a:ln>]]><wp:extent cx="4762" cy="10"/></w:drawing>`,
      ),
    ),
    pict(`<v:shape style = 'visibility:hidden'/>`),
    pict(`<v:rect fillcolor = 'white' stroked = 'f'/>`),
    pict(`<!-- <v:imagedata r:id="rId1"/> --><v:shape style="visibility:hidden"/>`),
    pict(`<v:shape style="visibility:hidden"/><![CDATA[<w:txbxContent/>]]>`),
    pict(`<v:shape style="visibility:hidden" descr="a>b"/>`),
    p(r(`<w:t>before</w:t><w:txbxContent a="1"><w:p>${t('in')}</w:p></w:txbxContent ><w:t>after</w:t>`)),
    p(`<w:txbxContent><w:p><!-- </w:txbxContent> -->${r(t('in'))}</w:p></w:txbxContent>${r(t('after'))}`),
    p(`<w:txbxContent a=">"><w:p/></w:txbxContent>${r('<w:br w:type="page"/>')}`),
    p(`<w:txbxContent><w:p/></w:txbxContent >${r('<w:br w:type="page"/>')}`),
    p(`<w:r><w:t xml:space = 'preserve'>a</w:t ></w:r><w:r><w:t>b</w:t ></w:r>`),
    p(`<w:r><w:t><![CDATA[a<b&c]]></w:t></w:r>`),
    p(`<w:r><w:t>a<!--x-->b</w:t></w:r><!-- <w:t>hidden</w:t> -->`),
    p(`<w:r><w:t>a</w:t></w:r><![CDATA[<w:t>fake</w:t>]]><?probe </w:t>?>`),
    `<w:tbl><w:tr><w:tc>${p(r(t('c1')))}</w:tc ><w:tc>${p(r(t('c2')))}</w:tc ></w:tr ></w:tbl>`,
  ],
  'shapes that draw nothing': [
    p(r(shape('<a:noFill/><a:ln><a:noFill/></a:ln>'))),
    p(r(shape('<a:noFill/><a:ln><a:noFill/></a:ln><a:effectLst/>'))),
    p(r(shape('<a:noFill/><a:ln><a:noFill/></a:ln><a:effectLst><a:glow/></a:effectLst>'))),
    p(r(shape('<a:noFill/><a:ln/>'))),
    p(r(shape('<a:solidFill/><a:ln><a:noFill/></a:ln>'))),
    p(r(shape('<a:noFill/>'))),
    p(r(shape('<a:noFill/><a:ln><a:noFill/></a:ln>') + shape('<a:noFill/>'))),
    p(
      r(
        shape(
          '<a:noFill/><a:ln><a:noFill/></a:ln>',
          `<wps:txbx><w:txbxContent>${p(r(t('text')))}</w:txbxContent></wps:txbx>`,
        ),
      ),
    ),
    p(
      r(
        shape(
          '<a:noFill/><a:ln><a:noFill/></a:ln>',
          `<wps:txbx><w:txbxContent>${p(r(t(' ')))}</w:txbxContent></wps:txbx>`,
        ),
      ),
    ),
    p(r(shape('<a:noFill/><a:ln><a:noFill/></a:ln>', '<a:blip r:embed="rId1"/>'))),
    p(r(shape('<a:noFill/><a:ln><a:noFill/></a:ln>')) + '</w:x>'),
    p(r('<wps:wsp/>')),
    p(r('<wps:wspace/>')),
  ],
  'VML picts': [
    pict('<v:shapetype id="t" coordsize="21600,21600"/>'),
    pict('<v:shapetype id="t"/><v:shape style="position:absolute;visibility:hidden"/>'),
    pict('<v:shape style="visibility:  hidden" fillcolor="red"/>'),
    pict(`<v:shape style='visibility:hidden'/>`),
    pict('<v:rect fillcolor=" White " stroked="f"/>'),
    pict('<v:rect fillcolor="#FFF" stroked="false"/><v:oval fillcolor="#ffffff" stroked="0"/>'),
    pict('<v:rect fillcolor="white" stroked="t"/>'),
    pict('<v:rect fillcolor="white" unstroked="f"/>'),
    pict('<v:rect fillcolor="white" xstroked="f"/>'),
    pict('<v:rect fillcolor="black" stroked="f"/>'),
    pict('<v:rect stroked="f"/>'),
    pict(
      '<v:line style="x" stroked="f" fillcolor="white"/><v:polyline stroked="f" fillcolor="WHITE"/>',
    ),
    pict('<v:roundrect stroked="f" fillcolor="white"><v:imagedata r:id="rId1"/></v:roundrect>'),
    pict(
      `<v:rect stroked="f" fillcolor="white"><v:textbox><w:txbxContent>${p('')}</w:txbxContent></v:textbox></v:rect>`,
    ),
    pict('<v:shapes/><v:group/>'),
    pict('<o:lock/>'),
  ],
  'textboxes and page breaks': [
    p(r('<w:br w:type="page"/>')),
    p(r('<w:br w:clear="all" w:type="page"/>')),
    p(r(`<w:br w:type='page'/>`)),
    p(r('<w:br\nw:type="page"/>')),
    p(r('<w:br w:type="column"/>') + r('<w:br/>')),
    p(
      r(
        `<w:pict><v:shape><v:textbox><w:txbxContent>${p(r('<w:br w:type="page"/>'))}</w:txbxContent></v:textbox></v:shape></w:pict>`,
      ),
    ),
    p(
      r(
        `<w:pict><w:txbxContent>${p(r(t('a')))}</w:txbxContent><w:txbxContent>${p(r(t('b')))}</w:txbxContent></w:pict>`,
      ) + r('<w:br w:type="page"/>'),
    ),
    p(
      r(
        `<w:pict><w:txbxContent><w:tbl><w:tr><w:tc>${p(r(t('cell')))}</w:tc></w:tr></w:tbl></w:txbxContent></w:pict>`,
      ),
    ),
    p(
      r(
        `<w:pict><w:txbxContent><w:sdt><w:sdtContent>${p('')}</w:sdtContent></w:sdt></w:txbxContent></w:pict>`,
      ),
    ),
    p(
      r(
        `<w:pict><w:txbxContent a="1">${p(r(t('kept: the tag has an attribute')))}</w:txbxContent></w:pict>`,
      ),
    ),
  ],
  fields: [
    p(field(' PAGE ')),
    p(field('HYPERLINK "https://example.com/a?b=1&amp;c=2" \\o "tool &quot;tip&quot;" ')),
    p(field(' HYPERLINK &#34;https://example.com&#34;')),
    p(field('HYPERLINK \\l "bookmark"')),
    p(field(' EMBED Excel.Sheet.12 ') + field('LINK Word.Document')),
    p(field(' XE "term:sub" ') + r(t('text')) + field('XE"tight"')),
    p(field(' REF _Ref123 \\h ') + field('REFX')),
    p(field(' MERGEFIELD "First Name" \\* Upper ') + field('MERGEFIELD Name')),
    p(
      field(' ADDIN ZOTERO_ITEM CSL_CITATION {"citationID":"x"} ') +
        field('addin csl_bibliography'),
    ),
    p(field(' TOC \\o "1-3" ')),
    p(field('')),
    p(field('   ') + field(' DATE \\@ "yyyy" ')),
    // one instruction split over several runs
    p(
      r('<w:fldChar w:fldCharType="begin"/>') +
        r('<w:instrText> HYPER</w:instrText>') +
        r('<w:instrText>LINK "https://example.com" </w:instrText>') +
        r('<w:fldChar w:fldCharType="separate"/>') +
        r('<w:instrText>not an instruction: inside the result</w:instrText>') +
        r('<w:fldChar w:fldCharType="end"/>'),
    ),
    // a field inside a field
    p(
      r('<w:fldChar w:fldCharType="begin"/>') +
        r('<w:instrText> IF </w:instrText>') +
        field(' PAGE ') +
        r('<w:instrText> = 1 "a" "b" </w:instrText>') +
        r('<w:fldChar w:fldCharType="end"/>'),
    ),
    p(
      r('<w:fldChar w:fldCharType="begin"/>') +
        r('<w:instrText></w:instrText>') +
        field('PAGE') +
        r('<w:fldChar w:fldCharType="end"/>'),
    ),
    p(r('<w:fldChar w:fldCharType="end"/>') + r(t('the end of a field begun earlier'))),
    p(r('<w:fldChar w:fldCharType="begin"/>') + r('<w:instrText> TOC </w:instrText>')),
    p(
      r(`<w:fldChar w:fldCharType='begin'/>`) +
        r('<w:instrText>PAGE</w:instrText>') +
        r(`<w:fldChar w:fldCharType='end'/>`),
    ),
    p(
      r('<w:fldChar w:fldCharType = "begin"/>') +
        r('<w:instrText>PAGE</w:instrText>') +
        r('<w:fldChar w:fldCharType = "end"/>'),
    ),
    p(
      r('<w:fldChar w:dirty="1" w:fldCharType="begin"/>') +
        r('<w:instrText>PAGE</w:instrText>') +
        r('<w:fldChar w:fldCharType="end" w:dirty="1"/>'),
    ),
    p(
      r('<w:fldChar w:fldCharType="other"/>') +
        r('<w:instrText>loose</w:instrText>') +
        r('<w:instrText>second</w:instrText>'),
    ),
    p(`<w:fldSimple w:instr=" PAGE ">${r(t('1'))}</w:fldSimple>`),
    p(`<w:fldSimple w:instr=" XE &quot;quoted&quot; ">${r(t('1'))}</w:fldSimple>`),
    p(`<w:fldSimple w:instr=" SEQ Figure ">${r(t('1'))}</w:fldSimple>`),
    p(`<w:fldSimple>${r(t('no instruction'))}</w:fldSimple>`),
    p(`<w:fldSimple w:instr='PAGE'>${r(t('single quotes are not read'))}</w:fldSimple>`),
    p(`<w:fldSimple w:instr=" MERGEFIELD City ">${r(t('x'))}</w:fldSimple>` + field(' REF a ')),
    // form checkboxes
    p(
      r(
        '<w:fldChar w:fldCharType="begin"><w:ffData><w:checkBox><w:default w:val="1"/></w:checkBox></w:ffData></w:fldChar>',
      ) +
        r('<w:instrText> FORMCHECKBOX </w:instrText>') +
        r('<w:fldChar w:fldCharType="end"/>'),
    ),
    p(
      r(
        '<w:fldChar w:fldCharType="begin"><w:ffData><w:checkBox><w:default w:val="1"/><w:checked w:val="0"/></w:checkBox></w:ffData></w:fldChar>',
      ) +
        r('<w:instrText>FORMCHECKBOX</w:instrText>') +
        r('<w:fldChar w:fldCharType="end"/>'),
    ),
    p(
      r(
        '<w:fldChar w:fldCharType="begin"><w:ffData><w:checkBox><w:checked/></w:checkBox></w:ffData></w:fldChar>',
      ),
    ),
    p(
      r(
        '<w:fldChar w:fldCharType="begin"><w:ffData><w:checkBox><w:checked w:val="ON"/></w:checkBox></w:ffData></w:fldChar>',
      ),
    ),
    p(r('<w:fldChar w:fldCharType="begin"><w:ffData><w:checkBox/></w:ffData></w:fldChar>')),
    p(r('<w:fldChar w:fldCharType="begin"><w:ffData><w:textInput/></w:ffData></w:fldChar>')),
    p(field(' FORMCHECKBOX ')),
    p(
      field(' FORMCHECKBOX ') +
        field(' FORMCHECKBOX ') +
        r('<w:fldChar><w:ffData><w:checkBox/></w:ffData></w:fldChar>'),
    ),
  ],
  'position tabs and layout content': [
    p(
      r('<w:ptab w:relativeTo="margin" w:alignment="center" w:leader="dot"/>') +
        r('<w:ptab w:alignment="right" w:leader="none"/>'),
    ),
    p(
      r('<w:ptab w:alignment="left"/>') +
        `<w:hyperlink>${r('<w:ptab w:alignment="right" w:leader="middleDot"/>')}</w:hyperlink>`,
    ),
    p(
      '<w:pPr><w:ptab w:alignment="center"/></w:pPr>' +
        r('<w:ptab w:alignment="CENTER"/><w:ptab/>'),
    ),
    p(
      r(
        '<w:ptab w:alignment="right" w:leader="heavy"/><w:ptab w:alignment="center" w:leader="bogus"/>',
      ),
    ),
    p(r('<w:tab/>')),
    p(r('<w:br/>')),
    p(r('<w:cr/>') + r('<w:sym w:font="Symbol" w:char="F0B7"/>')),
    p(r('<w:footnoteReference w:id="1"/>')),
    p('<w:pPr><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr>'),
    p(
      `<w:pPr><w:rPr><w:tab/></w:rPr></w:pPr><w:ins>${r(r('<w:endnoteReference w:id="2"/>'))}</w:ins>`,
    ),
    p(r('<w:tabs/><w:brx/>')),
  ],
  ruby: [
    p(
      r(
        '<w:ruby><w:rubyPr><w:rubyAlign w:val="center"/></w:rubyPr><w:rt><w:r><w:t>yo</w:t></w:r><w:r><w:t>mi</w:t></w:r></w:rt><w:rubyBase><w:r><w:t>base&#x21;</w:t></w:r></w:rubyBase></w:ruby>',
      ) +
        r(
          '<w:ruby><w:rt><w:r><w:t>second &amp;#65;</w:t></w:r></w:rt><w:rubyBase><w:ins><w:r><w:t>skipped: not a direct run</w:t></w:r></w:ins><w:r><w:tab/><w:t>a<w:x>b</w:x>c</w:t></w:r></w:rubyBase></w:ruby>',
        ),
    ),
    p(r('<w:ruby><w:rubyBase/></w:ruby><w:ruby/><w:ruby a="1"><w:rt/></w:ruby>')),
    p(r('<w:ruby>\n<w:rt><w:r><w:t>line\nbreak</w:t></w:r></w:rt>\n</w:ruby>')),
  ],
  'symbol and picture runs': [
    r(t('a') + '<w:sym w:font="Wingdings" w:char="F0FC"/>' + t('b'), '<w:b/>'),
    r('<w:sym w:font="Wingdings" w:char="F0FC"/><w:sym w:font="Symbol" w:char="F0B7"/>'),
    r('<w:sym w:font="Wingdings" w:char="F0FC"/>', '<w:i/>'),
    '<w:r w:rsidR="00AB12CD" w:rsidRPr="1"><w:rPr><w:b/></w:rPr><w:sym/><w:rPr><w:i/></w:rPr><w:t>x</w:t></w:r>',
    r(t('no symbol') + '<w:tab/>'),
    '<w:r w:rsidR="00AB12CD"><w:drawing/><w:t>x</w:t><w:pict/><w:t>y</w:t></w:r>',
    r('<w:drawing/><w:object/><mc:AlternateContent/>', '<w:noProof/>'),
    r(t('text only'), '<w:noProof/>'),
    r('', '<w:noProof/>'),
    '<w:r/>',
    'text before<w:r><w:pict/></w:r>',
  ],
  'empty paragraph marks': [
    p('<w:pPr><w:rPr><w:sz w:val="36"/></w:rPr></w:pPr>'),
    p('<w:pPr><w:rPr><w:rtl/><w:sz w:val="36"/></w:rPr></w:pPr>'),
    p('<w:pPr><w:rPr><w:rtl/><w:sz w:val="36"/><w:szCs w:val="28"/></w:rPr></w:pPr>'),
    p('<w:pPr><w:rPr><w:rtl w:val="0"/><w:sz w:val="36"/><w:szCs w:val="28"/></w:rPr></w:pPr>'),
    p(
      '<w:pPr><w:rPr><w:sz w:val=""/></w:rPr></w:pPr>' +
        r('', '<w:sz w:val="18"/>') +
        r('', '<w:sz w:val="2"/>'),
    ),
    p('<w:pPr><w:rPr><w:sz w:val="0"/></w:rPr></w:pPr>' + r('', '<w:sz w:val="18"/>')),
    p('<w:pPr><w:rPr><w:sz w:val="24.5pt"/></w:rPr></w:pPr>'),
    p('<w:pPr><w:rPr><w:sz/></w:rPr></w:pPr>' + r('', '<w:rtl/>') + r('', '<w:sz w:val="abc"/>')),
    p(r('', '<w:sz w:val="-4"/>')),
    p('<w:pPr><w:rPr><w:rFonts w:ascii="Arial" w:asciiTheme="minorHAnsi"/></w:rPr></w:pPr>'),
    p(
      '<w:pPr><w:rPr><w:rFonts w:eastAsia="SimSun"/></w:rPr></w:pPr>' +
        r('', '<w:rFonts w:ascii="Courier New"/>') +
        r('', '<w:rFonts w:ascii=""/>'),
    ),
    p(
      '<w:pPr><w:rPr><w:rFonts w:asciiTheme="majorBidi" w:hAnsiTheme="minorEastAsia" w:cstheme="minorBidi" w:eastAsiaTheme="majorEastAsia"/></w:rPr></w:pPr>',
    ),
    p(
      '<w:pPr><w:rPr><w:rFonts w:ascii="A" w:hAnsi="B" w:eastAsia="C" w:cs="D" w:asciiTheme="bogus" w:eastAsiaTheme="minorEastAsia"/></w:rPr></w:pPr>',
    ),
  ],
  'math and table text': [
    p(
      '<m:oMath><m:r><m:t>x&lt;y</m:t></m:r><m:r><m:t xml:space="preserve"> + &#x31; </m:t></m:r><m:r><m:tx>not a token</m:tx></m:r></m:oMath>',
    ),
    `<w:tbl><w:tr><w:tc>${p(r(t('a')))}</w:tc><w:tc>${p(r('<w:t xml:space="preserve"> b&amp;c </w:t>'))}</w:tc><w:tc>${p('')}</w:tc><w:tc>${p(r('<w:tab/><w:t\n>d</w:t>'))}</w:tc></w:tr></w:tbl>`,
    `<w:tbl><w:tr><w:tc>${p('')}</w:tc><w:tc>${p(r(t('first text after an empty cell')))}</w:tc></w:tr></w:tbl>`,
    p(r('<w:t>&amp;lt; stays &#38;amp; &#x26;#65; &quot;&apos;</w:t><w:tx>x</w:tx><w:t/>')),
  ],
  'paragraph formats': [
    p(
      '<w:pPr><w:tabs><w:tab w:val="left" w:pos="720"/><w:tab w:val="center" w:pos="4320" w:leader="dot"/><w:tab w:val="num" w:pos="100"/><w:tab w:pos="-360" w:leader="none"/><w:tab w:val="clear" w:pos="1440.9" w:leader="middleDot"/><w:tab w:val="decimal" w:pos="x"/><w:tab w:val="bar" w:pos=" 12 " w:leader="DOT"/></w:tabs><w:tabs><w:tab w:pos="1"/></w:tabs></w:pPr>',
    ),
    p('<w:pPr><w:tabs/></w:pPr>'),
    p('<w:pPr><w:ind w:left="720" w:right="-360" w:hanging="360" w:firstLine="200"/></w:pPr>'),
    p(
      '<w:pPr><w:ind w:start="100" w:end="200" w:firstLine="0" w:startChars="150" w:endChars="0"/></w:pPr>',
    ),
    p(
      '<w:pPr><w:ind w:left="1" w:start="2" w:hanging="0" w:firstLineChars="200" w:hangingChars="-100"/></w:pPr>',
    ),
    p(
      '<w:pPr><w:ind w:hanging="-5" w:firstLine="-10" w:leftChars="1.9" w:rightChars="abc"/></w:pPr>',
    ),
    p('<w:pPr><w:ind w:hanging="0" w:firstLine="200"/></w:pPr>'),
    p('<w:pPr><w:ind/></w:pPr>'),
    p('<w:pPr><w:autoSpaceDE/><w:autoSpaceDN w:val="0"/></w:pPr>'),
    p('<w:pPr><w:autoSpaceDE w:val="OFF"/></w:pPr>'),
    p('<w:pPr><w:autoSpaceDN w:val="on"/><w:autoSpaceDN w:val="0"/></w:pPr>'),
    p(
      '<w:pPr><w:pBdr><w:top w:val="single" w:sz="12" w:space="1" w:color="FF0000"/><w:bottom w:val="none" w:space="4"/><w:left w:val="nil"/><w:right w:val="double" w:sz="0" w:space="0" w:color="auto"/></w:pBdr></w:pPr>',
    ),
    p(
      '<w:pPr><w:pBdr><w:top w:val="single" w:sz="4" w:color="#00ff00" w:themeColor="accent1" w:themeTint="99"/><w:bottom w:themeColor="bogus" w:color="123456" w:sz="7"/></w:pBdr><w:pBdr><w:top w:val="dashed" w:sz="5.5"/><w:between w:val="single"/></w:pBdr></w:pPr>',
    ),
    p('<w:pPr><w:pBdr/></w:pPr>'),
    p('<w:pPr><w:pBdr><w:top/></w:pBdr></w:pPr>'),
    p('<w:pPr><w:shd w:val="clear" w:color="auto" w:fill="D9D9D9"/></w:pPr>'),
    p(
      '<w:pPr><w:shd w:val="pct25" w:color="FF0000" w:fill="auto"/><w:jc w:val="both"/><w:spacing w:line="276.5" w:lineRule="auto"/></w:pPr>',
    ),
  ],
  'run formats': [
    r(t('x'), '<w:color w:val="FF0000"/>'),
    r(t('x'), '<w:color w:val="auto"/>'),
    r(t('x'), '<w:color w:val="#00ff00" w:themeColor="accent2" w:themeShade="BF"/>'),
    r(t('x'), '<w:color w:themeColor="text1" w:themeTint="80"/><w:color w:val="000000"/>'),
    r(t('x'), '<w:color w:themeColor="none" w:val=" AABBCC "/>'),
    r(t('x'), '<w:color/>'),
    r(t('x'), '<w:bdr w:val="single" w:sz="4" w:space="0" w:color="auto"/>'),
    r(t('x'), '<w:bdr w:val="dashed" w:sz="0" w:space="3" w:color="#112233"/>'),
    r(t('x'), '<w:bdr w:val="nil" w:sz="8"/>'),
    r(t('x'), '<w:bdr w:sz="8"/>'),
    r(t('x'), '<w:bdr w:val="double" w:sz="x" w:space="-1"/>'),
    r(t('x'), '<w:shd w:val="solid" w:color="auto" w:fill="FFFF00"/>'),
    r(t('x'), '<w:shd w:val="pct12" w:color="000000" w:fill="FFFFFF"/>'),
    r(
      t('x'),
      '<w:shd w:val="pct50" w:themeColor="accent1" w:themeFill="background1" w:themeFillShade="D9"/>',
    ),
    r(t('x'), '<w:shd w:val="thinHorzStripe" w:color="0000FF"/>'),
    r(t('x'), '<w:shd w:val="diagCross" w:fill="#abcdef"/>'),
    r(t('x'), '<w:shd w:val="nil" w:fill="12345"/>'),
    r(t('x'), '<w:shd w:fill="auto" w:themeFill="accent6" w:themeFillTint="33"/>'),
    r(t('x'), '<w:b/><w:i w:val="0"/><w:rtl w:val="true"/><w:vanish w:val="off"/>'),
    r(t('x'), '<w:b w:val="1"></w:b><w:B/>'),
    r(t('x'), `<w:b w:val='false'/><w:rtl\tw:val="none"/>`),
  ],
  tables: [
    '<w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="1" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/></w:tblPr>',
    '<w:tblPr><w:tblLook w:val="01E0"/><w:tblStyleRowBandSize w:val="2"/></w:tblPr>',
    '<w:tblPr><w:tblLook w:val="zz" w:firstRow="false"/><w:tblStyleRowBandSize w:val="0"/></w:tblPr>',
    '<w:tblPr><w:tblLook w:firstRow="true" w:noHBand="true"/><w:tblStyleRowBandSize w:val="-1"/></w:tblPr>',
    '<w:tblPr><w:tblLook w:val="FFFFFFFF0020"/><w:tblStyleRowBandSize w:val="3.7"/></w:tblPr>',
    '<w:tblPr><w:tblLook w:val="0x0620"/><w:tblStyleRowBandSize/></w:tblPr>',
    '<w:tblPr/>',
    '<w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:left w:val="nil"/><w:start w:val="double" w:sz="8"/><w:end w:val="dotted" w:sz="0" w:color="#FF0000"/><w:right w:sz="4"/><w:insideH w:val="single" w:sz="0x10"/><w:insideV w:val="single" w:sz=" 6 "/><w:tl2br w:val="single"/></w:tblBorders></w:tblPr>',
    '<w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4"/></w:tblBorders><w:tblBorders><w:top w:val="double" w:sz="1e1"/><w:bottom w:val="single" w:sz="abc" w:color=""/></w:tblBorders></w:tblPr>',
    '<w:tcPr><w:tcBorders><w:top w:val="single" w:sz="4"/><w:tl2br w:val="single" w:sz="4" w:color="000000"/><w:tr2bl w:val=""/><w:insideH w:val="single"/></w:tcBorders><w:tcMar><w:top w:w="100" w:type="dxa"/><w:left w:w="-5" w:type="dxa"/><w:start w:w="20"/><w:bottom w:w="5" w:type="pct"/><w:right w:w="" w:type=""/><w:end w:w="7.5"/></w:tcMar><w:shd w:val="clear" w:fill="EEEEEE"/></w:tcPr>',
    '<w:tcPr><w:tcMar><w:top w:w="0x10"/><w:left w:w="1e2"/><w:bottom w:w=" 12 "/><w:right w:w="Infinity"/></w:tcMar></w:tcPr>',
    '<w:tblPr><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom/><w:right w:type="dxa"/></w:tblCellMar></w:tblPr>',
    '<w:tcPr><w:tcMar/></w:tcPr>',
  ],
  parts: [
    '<?xml version="1.0"?><w:document xmlns:w="urn:w" xml:space="preserve"><w:body/></w:document>',
    `<w:hdr xml:space='preserve'><w:p/></w:hdr>`,
    '<w:ftr\n  xmlns:w="urn:w"\n  xml:space="preserve"><w:p/></w:ftr>',
    '<w:document xmlns:w="urn:w"><w:body xml:space="preserve"/></w:document>',
    '<w:documentX xml:space="preserve"/><w:document/>',
    '<w:document xml:space="default"><w:t xml:space="preserve"> </w:t></w:document>',
    '<w:footnotes a="1"xml:space="preserve"/>',
    '<w:styles><w:docDefaults/></w:styles>',
  ],
  // U+0131 (dotless i), U+017F (long s) and U+212A (Kelvin sign) are an ASCII
  // letter only under Unicode case folding, which /i without /u does not apply
  'letters that fold to ASCII only in Unicode': [
    p(r(t('x'), '<w:vanish/>') + r(t('y'), '<w:vanish w:val="fal\u017fe"/>')),
    p(r(t('x'), '<w:vanish/>') + r(t('y'), '<w:van\u0131sh w:val="0"/>')),
    p(r(t('x'), '<w:vanish/>') + r(t('y'), `<w:vani\u017fh w:val='off'/>`)),
    p(r(t('x'), '<w:van\u0131sh/><w:\u0131/><w:rt\u212A/>')),
    p(r(t('x'), '<w:vani\u017fh w:val="0"/><w:hdr\u017f/>')),
    p(
      '<w:pPr><w:shd w:val="thinHorz\u017ftripe" w:color="FF0000" w:fill="FFFFFF"/></w:pPr>' +
        r(t('x'), '<w:shd w:val="diagCro\u017f\u017f" w:color="0000FF" w:fill="FFFF00"/>'),
    ),
    p(r(t('x'), '<w:shd w:val="horzStr\u0131pe" w:color="00FF00" w:fill="000000"/>')),
    p(field('ADD\u0131N ZOTERO_ITEM CSL_CITATION {}') + field('C\u017fL_CITATION {}')),
    // tags outside ASCII, with and without case, on and off
    p(
      r(t('x'), '<w:\uAC00/><w:\u00E9 w:val="0"/><w:\u00C9/>') +
        r(t('y'), '<w:\uAC00 w:val="off"/>'),
    ),
  ],
}

export const PROPS_INSTRUCTIONS = [
  ' PAGE ',
  'PAGE',
  'PAGES',
  ' PAGEREF _Toc1 \\h ',
  '\tDATE \\@ "yyyy-MM-dd"',
  'TIME',
  'CREATEDATE',
  'SAVEDATE',
  'NUMPAGES',
  'FILENAME \\p',
  'AUTHOR',
  'page',
  ' HYPERLINK "https://example.com" ',
  'HYPERLINK "https://example.com" \\o "tip"',
  'HYPERLINK "https://example.com" \\o ""',
  'HYPERLINK  "a"   \\o   "b"   ',
  'HYPERLINK "a" \\t "_blank"',
  'HYPERLINK "back\\slash"',
  'HYPERLINK ""',
  'HYPERLINK &#34;https://example.com&#34; \\o &#x22;tip&#x22;',
  'HYPERLINK "a" trailing',
  'hyperlink "a"',
  ' MERGEFIELD "First Name" \\* Upper ',
  'MERGEFIELD Name',
  'MERGEFIELD\u00A0Name',
  'MERGEFIELD ""',
  'MERGEFIELD',
  'MERGEFIELD  ',
  'ADDIN ZOTERO_ITEM CSL_CITATION {"a":1}',
  'ZOTERO_BIBL {"uncited":[]} CSL_BIBLIOGRAPHY',
  'addin  zotero_temp',
  'ADDIN CSL_CITATION {}',
  'ADD\u0131N ZOTERO_ITEM CSL_CITATION {}',
  'ZOTERO_\u0131TEM',
  'zotero_b\u0131bl',
  'C\u017fL_CITATION {}',
  'ADDIN CSL_B\u0131BLIOGRAPHY',
  'c\u017fl_item',
  'CSL_ITEMX',
  'ADDIN EN.CITE',
  ' XE "term" ',
  'XE"tight"',
  'XEROX',
  ' REF _Ref1 \\h ',
  'REF',
  ' EMBED Excel.Sheet.12 ',
  'LINK Word.Document "C:\\a.docx"',
  'EMBEDDED',
  ' FORMCHECKBOX ',
  'FORMCHECKBOX x',
  '',
  '   ',
  '\uFEFFPAGE',
  'DATE\u00E9',
]

/** Fields are loose on purpose: some lists hold values a parsed run would not. */
const run = (text: string, fields: Record<string, unknown> = {}): Run =>
  ({ text, ...fields }) as unknown as Run
const revision = { author: 'a', date: '2026-01-01T00:00:00Z', id: '1' }

/** Run lists for the functions over model runs. */
export const PROPS_RUN_LISTS: Run[][] = [
  [],
  [run(' ')],
  [run(' '), run('\u00A0\u3000')],
  [run(' '), run('')],
  [run(' \t')],
  [run('\f')],
  [run('\v '), run('\u3000')],
  [run('\f'), run('a')],
  [run(' '), run('\n')],
  [
    run('a'),
    run('b'),
    run('c', { bold: true }),
    run('d', { bold: true }),
    run('e', { bold: false }),
  ],
  [
    run('a', { rawRPr: '<w:rPr/>' }),
    run('b', { rawRPr: '<w:rPr/>' }),
    run('c', { rawRPr: '' }),
    run('d'),
  ],
  [run('a', { noteRef: { kind: 'footnote', id: '1' } }), run('b'), run('c')],
  [run('a', { xeTerm: '' }), run('b'), run('c', { refField: 'x' }), run('d')],
  [run('a', { instrField: 'PAGE' }), run('b', { sdtCheckboxXml: '' })],
  [run('a', { math: 'x' }), run('b', { sym: { font: 'f', char: 'c' } }), run('c'), run('d')],
  [
    run('a', { color: 'FF0000' }),
    run('b', { color: 'FF0000' }),
    run('c', { color: 'ff0000' }),
    run('d', { sizeHalfPoints: 24 }),
    run('e', { sizeHalfPoints: 24 }),
  ],
  [
    run('a', { link: { href: 'h' } }),
    run('b', { link: { href: 'h' } }),
    run('c', { link: { href: 'h', plain: true } }),
    run('d', { link: { href: '', rId: 'r1' } }),
    run('e'),
  ],
  [
    run('a', { wrap: [{ seq: 1, open: '<w:smartTag>', close: '</w:smartTag>' }] }),
    run('b', { wrap: [{ seq: 1, open: '<w:smartTag>', close: '</w:smartTag>' }] }),
    run('c', { wrap: [{ seq: 2, open: '<w:smartTag>', close: '</w:smartTag>' }] }),
    run('d', { wrap: [{ seq: 2, open: '<w:smartTag>', close: '</w:smartTag>' }, { seq: 3, open: '<w:ins>', close: '</w:ins>' }] }),
    run('e', { wrap: [] }),
    run('f'),
    run('g', { wrap: [{ seq: 2, open: '<w:sdt>', close: '</w:sdt>' }] }),
  ],
  [
    run('a', { commentIds: ['1', '2'] }),
    run('b', { commentIds: ['1', '2'] }),
    run('c', { commentIds: ['1,2'] }),
    run('d', { commentIds: [] }),
    run('e'),
  ],
  [
    run('a', { ins: revision }),
    run('b', { ins: { ...revision } }),
    run('c', { ins: { ...revision, id: '2' } }),
    run('d', { del: revision }),
    run('e'),
  ],
  [
    run('a', {
      cs: true,
      styleId: 's',
      font: 'F',
      fontAscii: 'F',
      csFont: 'C',
      highlight: 'yellow',
      vertAlign: 'superscript',
    }),
    run('b', {
      cs: true,
      styleId: 's',
      font: 'F',
      fontAscii: 'F',
      csFont: 'C',
      highlight: 'yellow',
      vertAlign: 'superscript',
    }),
    run('c', { cs: true, styleId: 's', font: 'F', fontAscii: 'G' }),
  ],
]

const NUMBER_PIECES = [
  ...'0123456789',
  ...'0123456789',
  ...'+-.eExXabcdefABCDEF',
  ' ',
  '\t',
  '\u00A0',
  '\uFEFF',
  '_',
  ',',
  'Infinity',
  'NaN',
  '0x',
  '0b',
  '0o',
  'e+',
  'e-',
  '.5',
  '00',
  '999999999',
]

/**
 * Texts that look like numbers, for the JavaScript number primitives: pieces
 * strung together, and doubles written every way JavaScript writes them.
 */
export function numberTexts(random: () => number, count: number): string[] {
  const pick = <T>(list: T[]): T => list[Math.floor(random() * list.length)]!
  const double = (): number => {
    const magnitude = 10 ** Math.floor(random() * 44 - 22)
    const value = (random() - 0.5) * 2 * magnitude
    return random() < 0.3 ? Math.round(value) : random() < 0.2 ? Math.round(value * 2) / 2 : value
  }
  return Array.from({ length: count }, (_, index) => {
    if (index % 2 === 0) {
      return Array.from({ length: Math.floor(random() * 9) }, () => pick(NUMBER_PIECES)).join('')
    }
    const x = double()
    return pick([
      () => String(x),
      () => x.toExponential(),
      () => x.toFixed(Math.floor(random() * 20)),
      () => x.toPrecision(1 + Math.floor(random() * 30)),
      () => Math.round(Math.abs(x)).toString(16),
      () => `0x${Math.round(Math.abs(x)).toString(16)}`,
      () => ` ${x} `,
      () => `${x}px`,
      () => String(x * 9525),
      () => String(Math.round(x) + 0.5),
      () => String(x * 100),
    ])()
  })
}
