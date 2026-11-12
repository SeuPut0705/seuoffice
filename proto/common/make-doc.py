#!/usr/bin/env python3
"""Writes bench-50p.docx: a mock 50-page Word document (Korean and English
body text, headings, bold and italic runs, a table every few pages) for the
shell measurement. Deterministic: the same bytes on every run.

The first and last paragraphs carry the markers BENCH-FIRST-PARAGRAPH and
BENCH-LAST-PARAGRAPH that host.js looks for in the editor's DOM.

  python3 make-doc.py out.docx [pages]
"""
import sys
import zipfile

W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'

KO = (
    '이 문단은 껍데기 측정을 위한 모의 문서의 본문이다. 한글과 영어가 섞인 글이 여러 줄에 걸쳐 '
    '이어지고, 줄바꿈과 쪽 나누기가 화면 엔진마다 같게 되는지를 본다. 숫자 1234567890과 '
    '기호(괄호, 따옴표 “ ”, 가운뎃점 ·)도 함께 넣었다.'
)
EN = (
    'The quick brown fox jumps over the lazy dog while the editor lays out this paragraph '
    'across several lines, so that line breaking, kerning and page breaks can be compared '
    'between rendering engines on the same operating system.'
)


def esc(s):
    return s.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')


def run(text, bold=False, italic=False):
    props = ''
    if bold or italic:
        props = '<w:rPr>' + ('<w:b/>' if bold else '') + ('<w:i/>' if italic else '') + '</w:rPr>'
    return f'<w:r>{props}<w:t xml:space="preserve">{esc(text)}</w:t></w:r>'


def para(runs, style=None):
    ppr = f'<w:pPr><w:pStyle w:val="{style}"/></w:pPr>' if style else ''
    return f'<w:p>{ppr}{"".join(runs)}</w:p>'


def table(n):
    rows = []
    for r in range(4):
        cells = []
        for c in range(3):
            text = f'표 {n} 행 {r + 1} 열 {c + 1}' if r else f'Header {c + 1}'
            cells.append(
                '<w:tc><w:tcPr><w:tcW w:w="3000" w:type="dxa"/></w:tcPr>'
                + para([run(text, bold=(r == 0))])
                + '</w:tc>'
            )
        rows.append('<w:tr>' + ''.join(cells) + '</w:tr>')
    borders = ''.join(
        f'<w:{side} w:val="single" w:sz="4" w:space="0" w:color="000000"/>'
        for side in ('top', 'left', 'bottom', 'right', 'insideH', 'insideV')
    )
    return (
        '<w:tbl><w:tblPr><w:tblW w:w="9000" w:type="dxa"/>'
        f'<w:tblBorders>{borders}</w:tblBorders></w:tblPr>'
        '<w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/></w:tblGrid>'
        + ''.join(rows)
        + '</w:tbl>'
    )


def body(pages):
    # about 9 body paragraphs of this length fill an A4 page at 11pt (51 pages in the Chromium editor)
    count = pages * 9
    parts = [para([run('BENCH-FIRST-PARAGRAPH ', bold=True), run(KO)], 'Heading1')]
    for i in range(1, count):
        if i % 16 == 0:
            parts.append(para([run(f'{i // 16}장. 측정용 제목 Section {i // 16}')], 'Heading1'))
        if i % 24 == 0:
            parts.append(table(i // 24))
        text = KO if i % 2 else EN
        parts.append(
            para(
                [
                    run(f'{i}. '),
                    run(text[:40], bold=(i % 3 == 0)),
                    run(text[40:], italic=(i % 5 == 0)),
                ]
            )
        )
    parts.append(para([run('BENCH-LAST-PARAGRAPH', bold=True)]))
    sect = (
        '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>'
        '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" '
        'w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>'
    )
    return ''.join(parts) + sect


STYLES = f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="{W}">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Malgun Gothic"/>
<w:sz w:val="22"/><w:lang w:val="ko-KR" w:eastAsia="ko-KR"/></w:rPr></w:rPrDefault>
<w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="259" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/>
<w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr>
<w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style>
</w:styles>'''

CONTENT_TYPES = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>'''

RELS = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>'''

DOC_RELS = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>'''


def main():
    out = sys.argv[1]
    pages = int(sys.argv[2]) if len(sys.argv) > 2 else 50
    document = (
        f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<w:document xmlns:w="{W}"><w:body>{body(pages)}</w:body></w:document>'
    )
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
        for name, data in (
            ('[Content_Types].xml', CONTENT_TYPES),
            ('_rels/.rels', RELS),
            ('word/_rels/document.xml.rels', DOC_RELS),
            ('word/document.xml', document),
            ('word/styles.xml', STYLES),
        ):
            info = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(info, data)


if __name__ == '__main__':
    main()
