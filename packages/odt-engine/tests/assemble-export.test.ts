/**
 * docx → new ODT (`docxToOdt`): the package is standard, the result re-reads
 * (through `odtToDocx`) with the same paragraphs, text, tables, drawables,
 * notes, page geometry, headers and document defaults as the source, objects
 * become pictures (rendered, fallback, or a label box) and the report lists
 * what changed.
 */
import { parseDocx } from '@genoffice/docx-engine'
import { describe, expect, it } from 'vitest'
import { docxToOdt, odtToDocx, odtToText } from '../src'
import { openOdt, readOdtPackage } from '../src/core'
import { textOf } from './helpers/api'
import { buildDocx, chartRun, p, pictureRun, sectPr, shapeRun } from './helpers/build-docx'
import { kitchenSink, TOC } from './helpers/docx-fixtures'
import { signature } from './helpers/docx-signature'
import { PNG_1X1 } from './helpers/hancom-sample'
import { PNG_GREY } from './helpers/objects-fixtures'

async function convert(spec: Parameters<typeof buildDocx>[0], options = {}) {
  const docx = await buildDocx(spec)
  const { odtBytes, report } = await docxToOdt(docx, options)
  const back = await odtToDocx(odtBytes)
  return {
    docx,
    odtBytes,
    report,
    source: await parseDocx(docx),
    reread: await parseDocx(back.docxBytes),
    pkg: await readOdtPackage(odtBytes),
  }
}

const THEME_PART = {
  rId: 'rIdTheme',
  type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme',
  path: 'word/theme/theme1.xml',
  data:
    '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="T"><a:themeElements>' +
    '<a:clrScheme name="T"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>' +
    '<a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2><a:accent1><a:srgbClr val="123456"/></a:accent1></a:clrScheme>' +
    '<a:fontScheme name="T"><a:majorFont><a:latin typeface="Georgia"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>' +
    '<a:minorFont><a:latin typeface="Verdana"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>' +
    '</a:themeElements></a:theme>',
  contentType: 'application/vnd.openxmlformats-officedocument.theme+xml',
}

const byFeature = (report: Array<{ kind: string; feature: string; count: number }>) =>
  Object.fromEntries(report.map((r) => [`${r.kind}:${r.feature}`, r.count]))

describe('docxToOdt: the package', () => {
  it('is standard: mimetype first and stored, ODF 1.3, every entry in the manifest', async () => {
    const { pkg, odtBytes } = await convert(kitchenSink())
    expect(pkg.mimetypeFirst).toBe(true)
    expect(pkg.mimetypeStored).toBe(true)
    for (const part of ['content.xml', 'styles.xml', 'meta.xml'])
      expect(textOf(pkg, part)).toMatch(/office:version="1\.3"/)
    const manifest = textOf(pkg, 'META-INF/manifest.xml')
    expect(manifest).toContain('manifest:version="1.3"')
    for (const e of pkg.entries) {
      if (e.name === 'mimetype' || e.name === 'META-INF/manifest.xml') continue
      expect(manifest).toContain(`manifest:full-path="${e.name}"`)
    }
    // it opens as a received ODT
    const doc = await openOdt(odtBytes)
    expect(doc.officeVersion).toBe('1.3')
  })
})

describe('docxToOdt: faithful content', () => {
  it('re-reads with the same paragraphs, text, tables, drawables, notes and pages', async () => {
    const spec = kitchenSink()
    spec.body = TOC + spec.body
    const { source, reread } = await convert(spec)
    const a = signature(source)
    const b = signature(reread)
    expect(b.paragraphs).toBe(a.paragraphs)
    expect(b.text).toBe(a.text.replace('지운', ''))
    expect(b.tables).toEqual(a.tables)
    expect(b.drawables).toBe(a.drawables)
    expect(b.notes).toEqual(a.notes)
    expect(b.pages).toEqual(a.pages)
    expect(b.headers).toEqual(a.headers)
    expect(b.defaults).toEqual(a.defaults)
  })

  it('keeps headings, lists, links, styles and character formatting', async () => {
    const spec = kitchenSink()
    spec.body =
      p('제목', '<w:pStyle w:val="Heading1"/>') +
      '<w:p><w:hyperlink r:id="rIdLink"><w:r><w:t>링크</w:t></w:r></w:hyperlink></w:p>' +
      p(
        '빨강 큰 글',
        '<w:jc w:val="center"/><w:spacing w:line="360" w:lineRule="auto"/>',
        '<w:color w:val="FF0000"/><w:sz w:val="28"/><w:i/>',
      ) +
      sectPr()
    spec.extra = [
      {
        rId: 'rIdLink',
        type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink',
        path: 'word/unused.xml',
        data: '<x/>',
        contentType: 'application/xml',
      },
    ]
    const { reread } = await convert(spec)
    const blocks = reread.blocks.filter((b) => !b.hidden)
    expect(blocks[0]).toMatchObject({ type: 'heading', level: 1 })
    const heading = reread.styles.get(blocks[0].styleId as string)?.display
    expect(heading).toMatchObject({ sizeHalfPoints: 32, bold: true, fontAscii: 'Arial' })
    const run = blocks[2].runs?.[0]
    expect(run).toMatchObject({
      text: '빨강 큰 글',
      color: 'FF0000',
      sizeHalfPoints: 28,
      italic: true,
    })
    expect(blocks[2].format).toMatchObject({ align: 'center', lineSpacing: 1.5 })
  })

  it('writes each page section with its own master page and header', async () => {
    const { pkg } = await convert(kitchenSink())
    const styles = textOf(pkg, 'styles.xml')
    const content = textOf(pkg, 'content.xml')
    expect(styles).toMatch(
      /<style:master-page style:name="Standard"[^>]*><style:header><text:p[^>]*>머리글 하나/,
    )
    expect(styles).toMatch(
      /<style:master-page style:name="MP2"[^>]*><style:header><text:p[^>]*>머리글 둘/,
    )
    expect(styles).toMatch(/style:print-orientation="landscape"/)
    // the second section starts at its heading
    const heading = /<text:p text:style-name="([^"]+)"[^>]*>둘째 구역/.exec(content)?.[1]
    expect(content).toMatch(new RegExp(`style:name="${heading}"[^>]*style:master-page-name="MP2"`))
  })

  it('keeps the header distance and the top margin apart (geometry)', async () => {
    const body =
      p('본문') +
      '<w:sectPr><w:headerReference w:type="default" r:id="rIdH"/><w:pgSz w:w="11906" w:h="16838"/>' +
      '<w:pgMar w:top="3540" w:right="1440" w:bottom="1440" w:left="1440" w:header="3660" w:footer="720" w:gutter="0"/></w:sectPr>'
    const { reread, pkg } = await convert({
      body,
      parts: { rIdH: { kind: 'header', inner: p('머리') } },
    })
    const styles = textOf(pkg, 'styles.xml')
    expect(styles).toContain('fo:margin-top="6.244cm"')
    const s = reread.blocks.length ? signature(reread).pages[0] : ''
    expect(s.split(',').slice(3, 4)).toEqual(['3540'])
  })

  it('keeps a continuous section with its own columns as a text:section', async () => {
    const body =
      p('하나') +
      `<w:p><w:pPr>${sectPr('<w:type w:val="continuous"/>')}</w:pPr><w:r><w:t>둘</w:t></w:r></w:p>` +
      p('셋') +
      sectPr('<w:type w:val="continuous"/><w:cols w:num="2" w:space="720"/>')
    const { report, reread, pkg } = await convert({ body })
    const content = textOf(pkg, 'content.xml')
    expect(content).toMatch(
      /<text:p[^>]*>둘<\/text:p><text:section text:style-name="([^"]+)"[^>]*><text:p[^>]*>셋/,
    )
    const style = /<text:section text:style-name="([^"]+)"/.exec(content)?.[1]
    expect(content).toMatch(
      new RegExp(
        `style:name="${style}" style:family="section"><style:section-properties><style:columns fo:column-count="2" fo:column-gap="1\\.27\\d*cm"><style:column `,
      ),
    )
    expect(byFeature(report)['converted:columns']).toBeUndefined()
    // one page run; the bridge shows the continuous section break again
    expect(signature(reread).pages.length).toBe(1)
  })

  it('writes page-wide columns into the page layout', async () => {
    const { pkg } = await convert({
      body: p('하나') + sectPr('<w:cols w:num="2" w:space="720"/>'),
    })
    expect(textOf(pkg, 'styles.xml')).toMatch(
      /<style:page-layout-properties [^>]*><style:columns fo:column-count="2" fo:column-gap="1\.27\d*cm"><style:column [^>]*\/><style:column [^>]*\/><\/style:columns><\/style:page-layout-properties>/,
    )
  })

  it('makes each page section a master page of its own, even when alike', async () => {
    const body =
      p('하나') +
      `<w:p><w:pPr>${sectPr()}</w:pPr><w:r><w:t>둘</w:t></w:r></w:p>` +
      p('셋') +
      sectPr()
    const { pkg, reread } = await convert({ body })
    const styles = textOf(pkg, 'styles.xml')
    expect(styles).toMatch(/<style:master-page style:name="Standard"/)
    expect(styles).toMatch(/<style:master-page style:name="MP2"/)
    expect(signature(reread).pages.length).toBe(2)
  })
})

describe('docxToOdt: what Hancom reads differently', () => {
  it('writes headings as paragraphs of an outline-level style, not text:h', async () => {
    const body =
      p('제목', '<w:pStyle w:val="Heading1"/>') +
      p('절', '<w:outlineLvl w:val="1"/>') +
      p('본문') +
      sectPr()
    const { pkg, reread } = await convert({ body })
    const content = textOf(pkg, 'content.xml')
    const styles = textOf(pkg, 'styles.xml')
    expect(content).not.toMatch(/<text:h[\s>]/)
    // Hancom numbers every text:h; an outline-level style keeps the heading unnumbered
    const first = /<text:p text:style-name="([^"]+)">제목/.exec(content)?.[1]
    expect(content).toMatch(
      new RegExp(
        `style:name="${first}"[^>]*style:parent-style-name="Heading1"[^>]*style:default-outline-level="1"`,
      ),
    )
    expect(styles).toMatch(/style:name="Heading1"[^>]*style:default-outline-level="1"/)
    const second = /<text:p text:style-name="([^"]+)">절/.exec(content)?.[1]
    expect(content).toMatch(
      new RegExp(`style:name="${second}"[^>]*style:default-outline-level="2"`),
    )
    // the plain paragraph's style takes no level
    const plain = /<text:p text:style-name="([^"]+)">본문/.exec(content)?.[1]
    expect(plain).not.toBe(second)
    expect(styles).toMatch(/<text:outline-style style:name="Outline">/)
    const blocks = reread.blocks.filter((b) => !b.hidden)
    expect(blocks[0]).toMatchObject({ type: 'heading', level: 1 })
  })

  it('starts a page where a page break sits inside a paragraph', async () => {
    const br = '<w:r><w:br w:type="page"/></w:r>'
    const body =
      '<w:p><w:r><w:t>앞</w:t></w:r>' +
      br +
      '<w:r><w:t>뒤</w:t></w:r></w:p>' +
      '<w:p>' +
      br +
      '</w:p>' +
      p('다음') +
      '<w:p><w:r><w:t>끝</w:t></w:r>' +
      br +
      '</w:p>' +
      '<w:tbl><w:tblGrid><w:gridCol w:w="2000"/></w:tblGrid><w:tr><w:tc><w:p><w:r><w:t>칸</w:t></w:r></w:p></w:tc></w:tr></w:tbl>' +
      sectPr()
    const { pkg } = await convert({ body })
    const content = textOf(pkg, 'content.xml')
    const breaks = new Set(
      [
        ...content.matchAll(
          /style:name="([^"]+)"[^>]*><style:paragraph-properties[^>]*fo:break-before="page"/g,
        ),
      ].map((m) => m[1]),
    )
    const styleOf = (text: string) =>
      new RegExp(`<text:p text:style-name="([^"]+)">${text}<`).exec(content)?.[1] ?? ''
    expect(breaks.has(styleOf('앞'))).toBe(false)
    expect(breaks.has(styleOf('뒤'))).toBe(true)
    // a paragraph holding only the break leaves none behind; the next one starts the page
    expect(breaks.has(styleOf('다음'))).toBe(true)
    expect(content).not.toMatch(/<text:p[^>]*><\/text:p><text:p[^>]*>다음/)
    // a break at the end of a paragraph starts the page of the table after it
    expect(content).toMatch(
      />끝<\/text:p><text:p text:style-name="([^"]+)"\/?>(<\/text:p>)?<table:table /,
    )
    const before = /<text:p text:style-name="([^"]+)"\/?>(?:<\/text:p>)?<table:table /.exec(
      content,
    )?.[1]
    expect(breaks.has(before ?? '')).toBe(true)
  })

  it('keeps the last page a page break at the end of the document starts', async () => {
    const body = p('앞') + '<w:p><w:r><w:br w:type="page"/></w:r></w:p>' + sectPr()
    const { pkg } = await convert({ body })
    const content = textOf(pkg, 'content.xml')
    const last = /<text:p text:style-name="([^"]+)"\/?>(?:<\/text:p>)?<\/office:text>/.exec(
      content,
    )?.[1]
    expect(content).toMatch(
      new RegExp(
        `style:name="${last}"[^>]*><style:paragraph-properties[^>]*fo:break-before="page"`,
      ),
    )
  })

  it('gives table rows the least height Word lays them out at', async () => {
    const cell = (text: string, pPr = '') =>
      `<w:tc><w:tcPr><w:tcW w:w="3000" w:type="dxa"/></w:tcPr>${p(text, pPr)}</w:tc>`
    const body =
      '<w:tbl><w:tblPr><w:tblW w:w="6000" w:type="dxa"/></w:tblPr><w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/></w:tblGrid>' +
      `<w:tr>${cell('한 줄')}${cell('둘째', '<w:spacing w:before="100" w:after="0" w:line="480" w:lineRule="auto"/>')}</w:tr>` +
      `<w:tr><w:trPr><w:trHeight w:val="400" w:hRule="exact"/></w:trPr>${cell('고정')}${cell('칸')}</w:tr>` +
      `<w:tr><w:trPr><w:trHeight w:val="2000"/></w:trPr>${cell('높은')}${cell('칸')}</w:tr>` +
      '</w:tbl>' +
      sectPr()
    const { pkg } = await convert({ body })
    const content = textOf(pkg, 'content.xml')
    const rows = [...content.matchAll(/<table:table-row(?: table:style-name="([^"]+)")?>/g)].map(
      (m) =>
        m[1]
          ? new RegExp(`style:name="${m[1]}"[^>]*><style:table-row-properties ([^/]*)/>`).exec(
              content,
            )?.[1]
          : '',
    )
    // Hangul in Malgun Gothic (a 1.3301 line): 11pt at 259/240 lines + 160 after = 475 twips;
    // doubled + 100 before = 685 twips = 1.208cm
    expect(rows[0]).toMatch(/^style:min-row-height="1\.20\d*cm"$/)
    expect(rows[1]).toMatch(/^style:row-height="0\.70\d*cm"$/)
    expect(rows[2]).toMatch(/^style:min-row-height="3\.52\d*cm"$/)
  })

  it('states the whole look in every common paragraph style', async () => {
    const { pkg } = await convert({ body: p('본문') + sectPr() })
    const styles = textOf(pkg, 'styles.xml')
    // Hancom does not take line spacing or alignment from style:default-style
    expect(styles).toMatch(
      /<style:style style:name="Standard"[^>]*><style:paragraph-properties fo:text-align="start" fo:margin-bottom="0\.282cm" fo:line-height="108%"/,
    )
    expect(styles).toMatch(
      /<style:style style:name="Heading1"[^>]*><style:paragraph-properties fo:text-align="start"[^>]*fo:line-height="108%"/,
    )
  })
})

describe('docxToOdt: objects become pictures', () => {
  it('uses the fallback picture when there is one, else a label box', async () => {
    const spec = {
      body:
        `<w:p>${shapeRun(1270000, 635000, 'rIdFallback')}</w:p>` +
        `<w:p>${shapeRun(1270000, 635000, null, 21)}</w:p>` +
        `<w:p>${chartRun(2743200, 1371600)}</w:p>` +
        sectPr(),
      media: { rIdFallback: { name: 'fallback.png', data: PNG_GREY } },
    }
    const { pkg, report } = await convert(spec)
    const content = textOf(pkg, 'content.xml')
    const frames = content.match(/<draw:frame\b[\s\S]*?<\/draw:frame>/g) ?? []
    expect(frames.length).toBe(3)
    expect(frames[0]).toMatch(/<draw:image xlink:href="Pictures\/io_1\.png"/)
    expect(frames[0]).toMatch(/svg:width="3\.528cm" svg:height="1\.764cm"/)
    expect(frames[1]).toMatch(/<draw:text-box><text:p[^>]*>Shape<\/text:p>/)
    expect(frames[2]).toMatch(/<draw:text-box><text:p[^>]*>Chart<\/text:p>/)
    expect(pkg.get('Pictures/io_1.png')?.bytes).toEqual(PNG_GREY)
    expect(byFeature(report)).toMatchObject({ 'converted:shape': 2, 'converted:chart': 1 })
  })

  it('keeps pictures named by the ODT bridge (a docx that came from an ODT)', async () => {
    const run = pictureRun('rIdImg', 914400, 914400, 7).replace(
      /name="Picture 7"/g,
      'name="odt-pic:Picture1"',
    )
    const { pkg, report } = await convert({
      body: `<w:p>${run}</w:p>` + sectPr(),
      media: { rIdImg: { name: 'image1.png', data: PNG_1X1 } },
    })
    expect(textOf(pkg, 'content.xml')).toMatch(
      /<draw:frame [^>]*><draw:image xlink:href="Pictures\//,
    )
    expect(byFeature(report)['dropped:locked-object']).toBeUndefined()
  })

  it('uses the pictures the editor rendered', async () => {
    const spec = {
      body: `<w:p>${chartRun(2743200, 1371600)}</w:p><w:p><w:r><w:t>식 </w:t></w:r><m:oMath><m:r><m:t>x</m:t></m:r></m:oMath></w:p>${sectPr()}`,
    }
    const { pkg } = await convert(spec, {
      renderedObjects: {
        '0': { png: PNG_GREY, widthEmu: 1800000, heightEmu: 900000 },
        '1:0': { png: PNG_1X1, widthEmu: 360000, heightEmu: 180000 },
      },
    })
    const content = textOf(pkg, 'content.xml')
    expect(content).not.toContain('<draw:text-box>')
    expect(content).toMatch(/svg:width="5(?:\.0+)?cm" svg:height="2\.50*cm"/)
    // (the run's trailing space is not preserved in this docx: no xml:space)
    expect(content).toMatch(/식<draw:frame[^>]*svg:width="1(?:\.0+)?cm"/)
    expect(pkg.entries.filter((e) => e.name.startsWith('Pictures/')).length).toBe(2)
  })
})

describe('docxToOdt: report', () => {
  it('lists converted and dropped features', async () => {
    const spec = kitchenSink()
    spec.body = TOC + spec.body
    spec.settings = '<w:mirrorMargins/>'
    const { report } = await convert(spec)
    expect(byFeature(report)).toMatchObject({
      'converted:toc': 1,
      'converted:chart': 1,
      'converted:equation': 2,
      'converted:shape': 2,
      'dropped:revision': 2,
    })
    // mirror margins are kept (style:page-usage="mirrored"): nothing to report
    expect(byFeature(report)['converted:mirror_margins']).toBeUndefined()
    for (const r of report) expect(r.count).toBeGreaterThan(0)
  })

  it('reports nothing for a plain document that ships a theme part', async () => {
    const { report } = await convert({ body: p('본문') + sectPr(), extra: [THEME_PART] })
    expect(report).toEqual([])
  })

  it('reports theme references only when the theme cannot answer them', async () => {
    const themed = (attr: string) => `<w:p><w:r><w:rPr>${attr}</w:rPr><w:t>글</w:t></w:r></w:p>`
    // resolved exactly: the run shows the theme's accent1, and so does the ODT
    const exact = await convert({
      body: themed('<w:color w:val="111111" w:themeColor="accent1"/>') + sectPr(),
      extra: [THEME_PART],
    })
    expect(byFeature(exact.report)['converted:theme']).toBeUndefined()
    expect(textOf(exact.pkg, 'content.xml')).toContain('fo:color="#123456"')
    // a slot the theme does not hold: the cached 111111 stands in for it
    const missing = await convert({
      body: themed('<w:color w:val="111111" w:themeColor="accent5"/>') + sectPr(),
      extra: [THEME_PART],
    })
    expect(byFeature(missing.report)['converted:theme']).toBe(1)
    // a theme font without a theme part falls back to the literal face
    const noTheme = await convert({
      body:
        themed(
          '<w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:asciiTheme="minorHAnsi" w:hAnsiTheme="minorHAnsi"/>',
        ) + sectPr(),
    })
    expect(byFeature(noTheme.report)['converted:theme']).toBe(2)
    const withTheme = await convert({
      body:
        themed(
          '<w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:asciiTheme="minorHAnsi" w:hAnsiTheme="minorHAnsi"/>',
        ) + sectPr(),
      extra: [THEME_PART],
    })
    expect(byFeature(withTheme.report)['converted:theme']).toBeUndefined()
  })

  it('reports comments as dropped', async () => {
    const body =
      '<w:p><w:commentRangeStart w:id="0"/><w:r><w:t>메모 달린 글</w:t></w:r><w:commentRangeEnd w:id="0"/><w:r><w:commentReference w:id="0"/></w:r></w:p>' +
      sectPr()
    const spec = {
      body,
      extra: [
        {
          rId: 'rIdComments',
          type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments',
          path: 'word/comments.xml',
          data: '<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:comment w:id="0" w:author="a"><w:p><w:r><w:t>메모</w:t></w:r></w:p></w:comment></w:comments>',
          contentType:
            'application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml',
        },
      ],
    }
    const { report, odtBytes } = await convert(spec)
    expect(byFeature(report)['dropped:comment']).toBe(1)
    expect(await odtToText(odtBytes)).toBe('메모 달린 글')
  })
})
