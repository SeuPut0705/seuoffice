// The documents of the gate. No `.odt` is tracked in the repository (real files
// stay outside it), so the ODTs are built: from the test helpers of
// packages/odt-engine (every `buildOdt` configuration its tests use, the
// Hancom sample, the text, table, page and objects fixtures, fragments composed
// into documents) and from the `.docx` files tracked in the repository, which
// `docxToOdt` turns into ODTs to open. Seeded mutations of both come from
// `mutatedOdts` (the text of content.xml, styles.xml, meta.xml and the
// manifest) and `mutatedContainers` (the zip itself, `mutateContainer`).
//
// This module reads the TypeScript side only (ts.ts): the TS-only dry run
// (`run.mjs --ts-only`) builds the same corpus without the wasm.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import JSZip from 'jszip'
import { mutateContainer } from '../docx-diff/package-zips'
import { withClock } from './clock'
import * as ts from './ts'

const { PNG_1X1 } = ts.helpersHancomSample
const { PNG_GREY } = ts.helpersObjectsFixtures
const f = ts.helpersFragments
const { buildOdt } = ts.helpersBuildOdt
const { p, pictureRun, chartRun, shapeRun, sectPr, buildDocx } = ts.helpersBuildDocx

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

export interface OdtCase {
  name: string
  bytes: Uint8Array
  /** `built`, `sample`, `exported` (a tracked docx through docxToOdt), `mutation` */
  kind: string
  /** the ODT options it was built from, where it was */
  options?: ts.helpersBuildOdt.BuildOdtOptions
}

export interface DocxCase {
  name: string
  bytes: Uint8Array
  /** a file tracked in the repository */
  tracked: boolean
  /** the pictures `renderedObjects` of the second conversion are given */
  rendered?: Array<[key: string, object: { png: Uint8Array; widthEmu: number; heightEmu: number }]>
}

// ---------------------------------------------------------------------------
// Built ODTs

const NL2 =
  '<text:list-style style:name="NL2"><text:list-level-style-number text:level="1" style:num-format="1" style:num-suffix="."><style:list-level-properties text:list-level-position-and-space-mode="label-alignment"><style:list-level-label-alignment text:label-followed-by="listtab" fo:margin-left="0.635cm"/></style:list-level-properties></text:list-level-style-number><text:list-level-style-bullet text:level="2" text:bullet-char="\u2022"/></text:list-style>'

const formula =
  '<draw:frame draw:style-name="gr20" svg:width="2.000cm" svg:height="0.600cm" draw:z-index="30" text:anchor-type="as-char">' +
  '<draw:object xlink:href="./Object 1" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/>' +
  '<draw:image xlink:href="./ObjectReplacements/Object 1" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/>' +
  '</draw:frame>'
const formulaEntries: ts.helpersBuildOdt.OdtFixtureEntry[] = [
  { name: 'Object 1/content.xml', data: f.FORMULA_CONTENT_XML, mediaType: 'text/xml' },
  { name: 'Object 1/', data: '', mediaType: 'application/vnd.oasis.opendocument.formula' },
  { name: 'ObjectReplacements/Object 1', data: PNG_1X1, mediaType: '' },
]
const shape = f.hCustomShape('\ub3c4\ud615 \uae00')
const textBox =
  '<draw:frame draw:style-name="gr3" svg:width="5.000cm" svg:height="2.000cm" draw:z-index="2" text:anchor-type="as-char"><draw:text-box>' +
  f.hPara('\uae00\uc0c1\uc790 \uae00') +
  '</draw:text-box></draw:frame>'
const toc =
  '<text:table-of-content text:style-name="Sect2" text:protected="true" text:name="Table of Contents1"><text:table-of-content-source text:outline-level="3"/>' +
  `<text:index-body>${f.hPara('\ucc28\ub840 \ud558\ub098')}${f.hPara('\ucc28\ub840 \ub458')}</text:index-body></text:table-of-content>`
const trackedChanges =
  '<text:tracked-changes><text:changed-region text:id="ct1"><text:insertion><office:change-info><dc:creator>user</dc:creator><dc:date>2024-01-02T03:04:05</dc:date></office:change-info></text:insertion></text:changed-region></text:tracked-changes>'
const revision =
  '<text:p text:style-name="P1_0"><text:span text:style-name="T1">\ubc14\ub010 <text:change-start text:change-id="ct1"/>\uc0c8 \uae00<text:change-end text:change-id="ct1"/> \ub05d</text:span></text:p>'

const memo = f.hAnnotation('memo1', 'memo text', '\ub2ec\ub9b0 \uae00')
const note = f.hFootnote(' \uac01\uc8fc \ub0b4\uc6a9')
const endnote = `<text:note text:note-class="endnote"><text:note-citation>i</text:note-citation><text:note-body>${f.hPara('\ubbf8\uc8fc \uae00', { style: 'P425_11', span: 'T270' })}</text:note-body></text:note>`
const twoParagraphNote = `<text:note text:note-class="footnote"><text:note-citation>2)</text:note-citation><text:note-body>${f.hPara('\uccab \ubb38\ub2e8', { style: 'P425_11', span: 'T270' })}${f.hPara('\ub458\uc9f8 \ubb38\ub2e8', { style: 'P425_11', span: 'T270' })}</text:note-body></text:note>`

const picture = f.hImageFrame('Pictures/EMB0000a7a0be95.png')
const anchored = f.hImageFrame('Pictures/EMB0000a7a0be96.png', { anchor: 'paragraph', z: 7 })
const pictures = { 'EMB0000a7a0be95.png': PNG_1X1, 'EMB0000a7a0be96.png': PNG_GREY }

const heading1 =
  '<style:style style:name="Heading1" style:family="paragraph" style:display-name="Heading 1" style:default-outline-level="1"><style:text-properties fo:font-weight="bold"/></style:style>'

const tableOf = (name: string, rows: string[][]): string =>
  f.hTable(
    name,
    rows[0]!.length,
    rows.map((row) => f.hRow(row.map((text) => f.hCell(f.hPara(text))))),
  )

/** The `buildOdt` configurations, by name. */
export function builtOptions(): Array<[string, ts.helpersBuildOdt.BuildOdtOptions]> {
  const sample = ts.helpersHancomSample.hancomSample()
  const text = ts.helpersTextFixtures.textSample()
  const tables = ts.helpersTableFixtures.tablesDoc()
  const { pageDoc, singleRun, layoutXml, masterXml } = ts.helpersPageFixtures
  const out: Array<[string, ts.helpersBuildOdt.BuildOdtOptions]> = [
    // core-open
    ['default', {}],
    // inputs the first fault round asked for: a common style two parents deep
    // whose ancestors disagree, a weight of exactly 600 and a size that rounds
    // to 0 half points, and a page length of -0.5 twips
    [
      'style-chain-three-deep',
      {
        extraCommonStyles:
          '<style:style style:name="Grand" style:family="paragraph"><style:paragraph-properties fo:margin-left="1cm" fo:text-align="end"/><style:text-properties fo:font-size="10pt" fo:color="#111111"/></style:style>' +
          '<style:style style:name="Mid" style:family="paragraph" style:parent-style-name="Grand"><style:paragraph-properties fo:margin-left="2cm" fo:text-align="center"/><style:text-properties fo:font-size="14pt" fo:color="#222222"/></style:style>' +
          '<style:style style:name="Leaf" style:family="paragraph" style:parent-style-name="Mid"/>',
        extraContentAutomaticStyles:
          '<style:style style:name="PL" style:family="paragraph" style:parent-style-name="Leaf"/>',
        body: '<text:p text:style-name="Leaf">chain</text:p><text:p text:style-name="PL">auto over the chain</text:p>',
      },
    ],
    [
      'text-weight-600-size-tiny',
      {
        extraContentAutomaticStyles:
          '<style:style style:name="T600" style:family="text"><style:text-properties fo:font-weight="600" fo:font-size="0.1pt"/></style:style>' +
          '<style:style style:name="T599" style:family="text"><style:text-properties fo:font-weight="599"/></style:style>',
        body: f.hPara(
          '<text:span text:style-name="T600">semi</text:span> <text:span text:style-name="T599">light</text:span>',
        ),
      },
    ],
    ['pictures-raw', { pictures: { 'a.png': new Uint8Array([1, 2, 3]) } }],
    ['mimetype-first-1.3', { mimetypeFirst: true, officeVersion: '1.3' }],
    [
      'mimetype-first-stored-1.2',
      { mimetypeFirst: true, mimetypeCompressed: false, officeVersion: '1.2' },
    ],
    ['no-mimetype', { mimetype: null }],
    ['mimetype-crlf', { mimetype: 'application/vnd.oasis.opendocument.text\r\n' }],
    ['mimetype-spreadsheet', { mimetype: 'application/vnd.oasis.opendocument.spreadsheet' }],
    ['mimetype-template', { mimetype: 'application/vnd.oasis.opendocument.text-template' }],
    ['encrypted', { encrypted: true }],
    ['generator-server', { generator: ts.helpersBuildOdt.HANCOM_SERVER_GENERATOR }],
    ['generator-none', { generator: null }],
    [
      'generator-libreoffice',
      {
        generator: 'LibreOffice/7.6.2.1$Linux_X86_64 LibreOffice_project/60$Build-1',
        officeVersion: '1.3',
      },
    ],
    ['generator-word', { generator: 'MicrosoftOffice/16.0 MSWORD' }],
    ['generator-odfdom', { generator: 'ODFDOM/0.8.9 \uD55C\uAE00', officeVersion: '1.2' }],
    ['no-body', { body: '' }],
    [
      'unicode-body',
      {
        body:
          f.hPara('\u0131\u017f\u212a \u00e7\u0130 \ud55c\uae00 \ud83d\ude00 \u0e01 \u05d0') +
          f.hPara('  \uacf5\ubc31  \ub458 '),
      },
    ],
    [
      'big-entry',
      {
        extraEntries: [{ name: 'Pictures/big.bin', data: new Uint8Array(300_000), mediaType: '' }],
      },
    ],
    [
      'extra-entries',
      {
        extraEntries: [
          { name: 'Thumbnails/thumbnail.png', data: PNG_1X1, mediaType: 'image/png' },
          { name: 'Configurations2/accelerator/current.xml', data: '', mediaType: '' },
          {
            name: '\ud55c\uae00/\ud30c\uc77c.txt',
            data: 'x',
            mediaType: 'text/plain',
            compress: false,
          },
        ],
      },
    ],
    // core-styles
    [
      'escaped-style-name',
      {
        extraCommonStyles:
          '<style:style style:name="&lt;\uADF8\uB9BC&gt;" style:family="paragraph"><style:paragraph-properties fo:text-align="center"/></style:style>',
      },
    ],
    ['list-styles', { extraContentAutomaticStyles: NL2 }],
    [
      'heading-as-paragraph',
      {
        body: '<text:p text:style-name="Heading1">\uC81C\uBAA9</text:p>' + f.hPara('\uBCF8\uBB38'),
        extraCommonStyles: heading1,
      },
    ],
    // hancom sample, text, tables
    ['hancom-sample', sample.options],
    ['text-sample', text.options],
    ['tables-doc', tables.options],
    ['grid-2x2', ts.helpersTableFixtures.gridDoc(2, 2).options],
    ['grid-3x2', ts.helpersTableFixtures.gridDoc(3, 2).options],
    ['grid-3x3', ts.helpersTableFixtures.gridDoc(3, 3).options],
    [
      'grid-3x3-locked',
      (() => {
        const doc = ts.helpersTableFixtures.gridDoc(3, 3)
        const cell = f.hCell(f.hPara('r0c0'), { style: 'Table6.A1' })
        doc.options.body = doc.body.replace(
          cell,
          cell.replace('<table:table-cell ', '<table:table-cell table:protected="true" '),
        )
        return doc.options
      })(),
    ],
    // page
    ['page-three-runs', pageDoc()],
    ['page-single-header-footer', singleRun({ header: ['top', 'second'], footer: ['foot'] })],
    [
      'page-first-left',
      singleRun({ header: ['h'], 'header-first': ['f'], 'header-left': ['l'], footer: ['x'] }),
    ],
    [
      'page-first-footer',
      singleRun({ header: ['plain'], 'header-first': ['first'], footer: ['foot'] }),
    ],
    ['page-no-regions', singleRun({})],
    ['page-columns', pageDoc({ layouts: [layoutXml('Mpm1', { columns: 2 }), layoutXml('Mpm2')] })],
    [
      'page-negative-half-twip',
      pageDoc({
        layouts: [
          layoutXml('Mpm1', {
            width: '-0.025pt',
            height: '-0.075pt',
            margins: ['-0.025pt', '-0.025pt', '1cm', '1cm'],
          }),
          layoutXml('Mpm2'),
        ],
      }),
    ],
    [
      'page-roman',
      pageDoc({ layouts: [layoutXml('Mpm1', { numFormat: 'i' }), layoutXml('Mpm2')] }),
    ],
    [
      'page-geometries',
      pageDoc({
        layouts: [
          layoutXml('Mpm1', {
            margins: ['1.940cm', '1.950cm', '1.477cm', '2.117cm'],
            header: '1.058cm',
          }),
          layoutXml('Mpm2', {
            header: null,
            footer: null,
            margins: ['2.000cm', '2.000cm', '1.000cm', '2.000cm'],
          }),
          layoutXml('D', { header: '1.000cm', headerExtra: ' fo:margin-bottom="0.250cm"' }),
          layoutXml('E', { width: '29.699cm', height: '21.000cm', orientation: 'landscape' }),
        ],
        masterStyles:
          masterXml('Standard', 'Mpm1', { header: ['header'], footer: ['footer'] }) +
          masterXml('MP2', 'Mpm2', { header: ['header 2'] }) +
          masterXml('MP4', 'D', {}) +
          masterXml('MP5', 'E', { footer: ['landscape foot'] }),
      }),
    ],
    [
      'page-number-fields',
      pageDoc({
        masterStyles: `<style:master-page style:name="Standard" style:page-layout-name="Mpm1"><style:footer><text:p text:style-name="MP445_1"><text:span text:style-name="MT40">- <text:page-number text:select-page="current" style:num-format="1">7</text:page-number> -</text:span></text:p></style:footer></style:master-page>`,
        body: f.hPara('only'),
        layouts: [layoutXml('Mpm1')],
      }),
    ],
    [
      'page-header-framed-table',
      pageDoc({
        masterStyles:
          masterXml('Standard', 'Mpm1', { header: ['header'], footer: ['footer'] }) +
          `<style:master-page style:name="MP2" style:page-layout-name="Mpm2"><style:header>${ts.helpersPageFixtures.hp('header 2')}${f.hFramedTable(f.hTable('Table9', 1, [f.hRow([f.hCell(f.hPara('logo'))])]), { anchor: 'paragraph' }).paragraph}</style:header></style:master-page>`,
      }),
    ],
    [
      'page-section-columns',
      pageDoc({
        body:
          f.hPara('first', { style: 'PSN' }) +
          '<text:section text:style-name="Sect1" text:name="Section1">' +
          f.hPara('in section') +
          '</text:section>' +
          f.hPara('after'),
        layouts: [layoutXml('Mpm1', { columns: 2, numFormat: 'i' })],
        masterStyles: masterXml('Standard', 'Mpm1', { header: ['h'] }),
        contentExtra:
          '<style:style style:name="PSN" style:parent-style-name="Standard" style:master-page-name="Standard" style:family="paragraph"><style:paragraph-properties style:page-number="5"/></style:style>' +
          '<style:style style:name="Sect1" style:family="section"><style:section-properties><style:columns fo:column-count="3" fo:column-gap="0.300cm"/></style:section-properties></style:style>',
      }),
    ],
    [
      'page-run-ends-with-table',
      pageDoc({
        body:
          f.hPara('one a', { style: 'PS1' }) +
          f.hFramedTable(f.hTable('Table1', 1, [f.hRow([f.hCell(f.hPara('\uD45C'))])])).paragraph +
          f.hPara('two a', { style: 'PS2' }) +
          f.hPara('two b'),
      }),
    ],
    // objects
    ['comment-range', { body: f.hParaWith(`\uc55e ${memo.xml} \ub4a4`) + f.hPara('\ub2e4\uc74c') }],
    ['comment-point', { body: f.hParaWith(`\uc55e${memo.annotation}\ub4a4`) }],
    [
      'comment-two-paragraphs',
      {
        body:
          f.hParaWith(`\ucc98\uc74c ${memo.annotation}\uac00\uc6b4\ub370`) +
          f.hParaWith(`\uc774\uc5b4\uc11c${memo.end} \ub05d`),
      },
    ],
    [
      'note-footnote',
      { body: f.hParaWith(`\ubcf8\ubb38${note} \ub4a4`) + f.hPara('\ub2e4\uc74c') },
    ],
    [
      'notes-all',
      {
        body:
          f.hParaWith(`\ubcf8\ubb38${note} \ub458\uc9f8${twoParagraphNote}`) +
          f.hParaWith(`\ub05d${endnote}`),
      },
    ],
    ['picture-as-char', { body: f.hParaWith(`\uc55e${picture.frame}\ub4a4`), pictures }],
    ['picture-anchored', { body: f.hParaWith(anchored.frame), pictures }],
    [
      'picture-both',
      {
        body:
          f.hPara('a') + f.hParaWith(`\uc55e${picture.frame}\ub4a4`) + f.hParaWith(anchored.frame),
        pictures,
      },
    ],
    ['picture-alone', { body: f.hPara('a') + f.hParaWith(picture.frame), pictures }],
    [
      'picture-after-space',
      {
        body: f.hParaWith(`a ${f.hImageFrame('Pictures/a.png', { anchor: 'as-char' }).frame} b`),
        pictures: { 'a.png': PNG_1X1 },
      },
    ],
    [
      'picture-in-cell',
      {
        body: f.hTable('Table2', 1, [
          f.hRow([
            f.hCell(
              f.hParaWith(`\uc140${f.hImageFrame('Pictures/a.png', { anchor: 'as-char' }).frame}`),
            ),
          ]),
        ]),
        pictures: { 'a.png': PNG_1X1 },
      },
    ],
    [
      'picture-cell-bookmark',
      {
        body: f.hTable('Table1', 2, [
          f.hRow([
            f.hCell(
              `<text:p text:style-name="P1_0"><text:span text:style-name="T1">${f.hImageFrame('Pictures/a.png', { anchor: 'as-char' }).frame}</text:span><text:bookmark text:name="CellField1"/></text:p>`,
            ),
            f.hCell(f.hPara('b')),
          ]),
        ]),
        pictures: { 'a.png': PNG_1X1 },
      },
    ],
    [
      'picture-beside-framed-table',
      (() => {
        const framed = f.hFramedTable(f.hTable('Table1', 1, [f.hRow([f.hCell(f.hPara('\uD45C'))])]))
        const close = '</text:span></text:p>'
        const host =
          framed.paragraph.slice(0, -close.length) +
          f.hImageFrame('Pictures/a.png', { anchor: 'paragraph' }).frame +
          close
        return {
          body: f.hPara('\uC55E') + host + f.hPara('\uB4A4'),
          pictures: { 'a.png': PNG_1X1 },
        }
      })(),
    ],
    [
      'placeholders',
      {
        body:
          trackedChanges +
          f.hParaWith(`\uC2DD ${formula}`) +
          f.hParaWith(shape.shape) +
          f.hParaWith(`\uC0C1\uC790 ${textBox}`) +
          toc +
          revision,
        extraEntries: formulaEntries,
      },
    ],
    [
      'placeholders-edit',
      {
        body:
          f.hPara('\uC704') +
          f.hParaWith(`\uC2DD ${formula}\uB05D`) +
          f.hParaWith(shape.shape) +
          toc +
          f.hPara('\uC544\uB798'),
        extraEntries: formulaEntries,
      },
    ],
    [
      'textbox-table',
      {
        body: f.hFramedTable(f.hTable('Table1', 1, [f.hRow([f.hCell(f.hPara('\uCE78'))])]))
          .paragraph,
      },
    ],
    // assemble-api and integration
    [
      'framed-table-cell-a',
      {
        body:
          f.hPara('\uC55E') +
          f.hFramedTable(
            f.hTable('Table1', 2, [f.hRow([f.hCell(f.hPara('a')), f.hCell(f.hPara('b'))])]),
          ).paragraph +
          f.hPara('\uB4A4'),
      },
    ],
    [
      'ends-with-body-table',
      { body: f.hPara('\uC55E') + f.hTable('Table1', 1, [f.hRow([f.hCell(f.hPara('b'))])]) },
    ],
    [
      'ends-with-framed-table',
      {
        body:
          f.hPara('\uC55E') +
          f.hFramedTable(f.hTable('Table1', 1, [f.hRow([f.hCell(f.hPara('b'))])])).paragraph,
      },
    ],
    [
      'table-in-section',
      {
        body:
          f.hPara('\uC55E') +
          `<text:section text:style-name="Sect1" text:name="S1">${f.hTable('Table1', 2, [f.hRow([f.hCell(f.hPara('a')), f.hCell(f.hPara('b'))])])}</text:section>` +
          f.hPara('\uB4A4'),
      },
    ],
    [
      'note-in-cell',
      {
        body:
          f.hPara('\uC55E') +
          f.hTable('Table1', 2, [
            f.hRow([
              f.hCell(f.hParaWith(`\uCE78${f.hFootnote('\uC140 \uAC01\uC8FC')}`)),
              f.hCell(f.hPara('b')),
            ]),
          ]),
      },
    ],
    [
      'list-in-cell',
      {
        body: f.hTable('Table1', 1, [
          f.hRow([
            f.hCell(
              '<text:list text:style-name="NL2"><text:list-item>' +
                f.hPara('\uD558\uB098') +
                '</text:list-item><text:list-item>' +
                f.hPara('\uB458') +
                '</text:list-item></text:list>',
            ),
          ]),
        ]),
        extraContentAutomaticStyles: NL2,
      },
    ],
    [
      'empty-self-closing-cell',
      {
        body: f.hTable('Table1', 2, [
          f.hRow([
            f.hCell(f.hPara('\uAC00')),
            '<table:table-cell table:style-name="Table1.A1" office:value-type="string"/>',
          ]),
        ]),
      },
    ],
    [
      'nested-locked-cell',
      {
        body: f.hTable('Table2', 1, [
          f.hRow(
            [
              f.hCell(
                f.hPara('host') +
                  f.hTable('Table3', 2, [
                    f.hRow(
                      [
                        f.hCell(f.hPara('x'), { style: 'Table3.A1', protected: true }),
                        f.hCell(f.hPara('y')),
                      ],
                      'Table3.1',
                    ),
                  ]),
              ),
            ],
            'Table2.1',
          ),
        ]),
      },
    ],
    // text
    ['leading-spaces', { body: f.hParaWith('<text:s text:c="2"/>\uB4E4\uC5EC \uC4F4 \uC904') }],
    [
      'page-break-after',
      {
        body: f.hPara('\uC55E \uCABD', { style: 'PA' }) + f.hPara('\uB2E4\uC74C \uCABD'),
        extraContentAutomaticStyles: f
          .hParagraphAutoStyle('PA')
          .replace('fo:line-height="160%"', 'fo:line-height="160%" fo:break-after="page"'),
      },
    ],
    [
      'bold-parent-style',
      {
        body: f.hPara('\uBCF4\uD1B5 \uAE00\uC790', { style: 'PB' }),
        extraCommonStyles:
          '<style:style style:name="\uAD75\uAC8C" style:family="paragraph"><style:text-properties fo:font-weight="bold"/></style:style>',
        extraContentAutomaticStyles: f.hParagraphAutoStyle('PB', { parent: '\uAD75\uAC8C' }),
      },
    ],
    [
      'section-container',
      {
        body:
          f.hPara('\uBC16') +
          `<text:section text:style-name="Sect1" text:name="S1">${f.hPara('\uAD6C\uC5ED \uC548')}${f.hPara('\uB458\uC9F8')}</text:section>`,
      },
    ],
    [
      'opaque-blocks',
      {
        body:
          f.hPara('\uC55E') + tableOf('Table2', [['\uCE78']]) + f.hPara('\uB4A4') + '<!-- note -->',
      },
    ],
    ['cdata-and-pi', { body: f.hPara('a') + '<?pi data?><![CDATA[ raw ]]>' + f.hPara('b') }],
    [
      'bookmarks-fields',
      {
        body: f.hParaWith(
          `${f.hFieldBookmark('NormalField1\u00A1\uC774\uB984\u00A1\u00A1F\u00A1T', '\uD64D\uAE38\uB3D9').xml} <text:bookmark text:name="_Toc1"/><text:bookmark-start text:name="x"/>`,
        ),
      },
    ],
    ['entities-in-text', { body: f.hPara('a &amp; b &lt; c &gt; d &quot;q&quot; &#65;&#x1F600;') }],
    [
      'many-paragraphs',
      {
        body: Array.from({ length: 40 }, (_, i) =>
          f.hPara(`\uBB38\uB2E8 ${i} \uD55C\uAE00 text`),
        ).join(''),
      },
    ],
  ]
  // overrideParts: a BOM, an utf-16 content, an empty part, a part with a doctype
  const built = ts.helpersBuildOdt
  const bom = (xml: string): Uint8Array =>
    new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(xml)])
  out.push(
    ['content-bom', { overrideParts: { 'content.xml': bom(built.buildContentXml()) } }],
    ['styles-bom', { overrideParts: { 'styles.xml': bom(built.buildStylesXml()) } }],
    ['meta-bom', { overrideParts: { 'meta.xml': bom(built.buildMetaXml()) } }],
    [
      'meta-people',
      {
        overrideParts: {
          'meta.xml': built
            .buildMetaXml()
            .replace(
              '<dc:creator>tester</dc:creator>',
              '<dc:creator>tester</dc:creator><meta:initial-creator>\uAE40\uCCA0\uC218</meta:initial-creator><dc:date>2026-06-15T12:30:00+09:00</dc:date>',
            )
            .replace('2024-01-02T03:04:05.000', '2026-01-01T10:00:00-05:00'),
        },
      },
    ],
    [
      'meta-utc-created',
      {
        overrideParts: {
          'meta.xml': built
            .buildMetaXml()
            .replace('2024-01-02T03:04:05.000', '2026-01-01T10:00:00Z'),
        },
      },
    ],
    [
      'meta-no-timestamps',
      {
        overrideParts: {
          'meta.xml': built
            .buildMetaXml()
            .replace(/<meta:creation-date>[^<]*<\/meta:creation-date>/, ''),
        },
      },
    ],
    [
      'meta-bad-date',
      {
        overrideParts: {
          'meta.xml': built.buildMetaXml().replace('2024-01-02T03:04:05.000', 'not a date'),
        },
      },
    ],
    ['no-meta-part', { overrideParts: { 'meta.xml': '' } }],
    [
      'manifest-override',
      {
        overrideParts: {
          'META-INF/manifest.xml':
            '<?xml version="1.0"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3"><manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/></manifest:manifest>',
        },
      },
    ],
    [
      'content-doctype',
      { overrideParts: { 'content.xml': '<!DOCTYPE x>' + built.buildContentXml() } },
    ],
    [
      'content-no-text',
      {
        overrideParts: {
          'content.xml':
            '<?xml version="1.0"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"><office:body/></office:document-content>',
        },
      },
    ],
    ['content-empty', { overrideParts: { 'content.xml': '' } }],
    [
      'content-prefix-renamed',
      {
        overrideParts: {
          'content.xml': built
            .buildContentXml()
            .replaceAll('text:', 'tx:')
            .replace('xmlns:tx', 'xmlns:tx')
            .replace('xmlns:text=', 'xmlns:tx='),
        },
      },
    ],
    ['styles-missing', { overrideParts: { 'styles.xml': '' } }],
  )
  return out
}

/** ODTs that are not `buildOdt` output: zips with something missing, and not a zip. */
async function irregularOdts(): Promise<Array<[string, Uint8Array]>> {
  const out: Array<[string, Uint8Array]> = []
  const text = new TextEncoder()
  out.push(['not-a-zip', text.encode('not a zip at all')], ['empty-bytes', new Uint8Array()])
  const noContent = new JSZip()
  noContent.file('mimetype', 'application/vnd.oasis.opendocument.text', { compression: 'STORE' })
  out.push(['zip-without-content', await noContent.generateAsync({ type: 'uint8array' })])
  const noManifest = new JSZip()
  noManifest.file('mimetype', 'application/vnd.oasis.opendocument.text', { compression: 'STORE' })
  noManifest.file('content.xml', ts.helpersBuildOdt.buildContentXml())
  noManifest.file('styles.xml', ts.helpersBuildOdt.buildStylesXml())
  out.push([
    'zip-without-manifest',
    await noManifest.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }),
  ])
  const noMimetypeNoManifest = new JSZip()
  noMimetypeNoManifest.file('content.xml', ts.helpersBuildOdt.buildContentXml())
  out.push(['zip-content-only', await noMimetypeNoManifest.generateAsync({ type: 'uint8array' })])
  const docx = new JSZip()
  docx.file('[Content_Types].xml', '<Types/>')
  docx.file('word/document.xml', '<w:document/>')
  out.push(['a-docx-is-not-an-odt', await docx.generateAsync({ type: 'uint8array' })])
  return out
}

/** Fragments composed into documents: seeded combinations of the blocks the fixtures hold. */
function composedOptions(
  random: () => number,
  count: number,
): Array<[string, ts.helpersBuildOdt.BuildOdtOptions]> {
  const sample = ts.helpersHancomSample.hancomSample()
  const text = ts.helpersTextFixtures.textSample()
  const tables = ts.helpersTableFixtures.tablesDoc()
  const pool: string[] = [
    ...sample.blocks,
    ...text.blocks,
    ...tables.body
      .match(/<text:p [\s\S]*?<\/text:p>|<table:table [\s\S]*?<\/table:table>/g)!
      .slice(0, 8),
    f.hParaWith(`\uc55e ${memo.xml} \ub4a4`),
    f.hParaWith(`\ubcf8\ubb38${note} \ub458\uc9f8${twoParagraphNote}`),
    f.hParaWith(`\uc55e${picture.frame}\ub4a4`),
    f.hParaWith(`\uC2DD ${formula}`),
    tableOf('Table2', [
      ['\u0131', '\u017f'],
      ['\u212a', '\ud83d\ude00'],
    ]),
    '<text:list text:style-name="NL2"><text:list-item>' +
      f.hPara('\uC544\uC774\uD15C') +
      '</text:list-item></text:list>',
  ]
  // the blocks that name a style of a fixture bring its styles along
  const extra =
    ts.helpersTextFixtures.textAutoStyles() +
    tables.options.extraContentAutomaticStyles +
    NL2 +
    ts.helpersTableFixtures.frameStyle('tableinfakeframe_gr2', '4.000cm')
  const out: Array<[string, ts.helpersBuildOdt.BuildOdtOptions]> = []
  for (let n = 0; n < count; n++) {
    const length = 2 + Math.floor(random() * 5)
    const picked = Array.from({ length }, () => pool[Math.floor(random() * pool.length)]!)
    out.push([
      `composed-${n}`,
      {
        body: picked.join(''),
        extraContentAutomaticStyles: extra,
        pictures,
        extraEntries: [
          ...(picked.some((block) => block.includes('Object 1')) ? formulaEntries : []),
        ],
      },
    ])
  }
  return out
}

/** The ODTs that need no docx: built, irregular, composed. */
export async function builtOdts(random: () => number, composed = 24): Promise<OdtCase[]> {
  const out: OdtCase[] = []
  for (const [name, options] of [...builtOptions(), ...composedOptions(random, composed)]) {
    out.push({
      name,
      bytes: await withClock(() => buildOdt(options)),
      kind: name === 'hancom-sample' ? 'sample' : 'built',
      options,
    })
  }
  for (const [name, bytes] of await irregularOdts()) out.push({ name, bytes, kind: 'built' })
  return out
}

// ---------------------------------------------------------------------------
// Docx

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

const { kitchenSink, TOC } = ts.helpersDocxFixtures

/** The docx fixtures of the odt tests (kitchenSink and the specs of assemble-export.test.ts). */
export async function builtDocxSpecs(): Promise<Array<[string, Parameters<typeof buildDocx>[0]]>> {
  const br = '<w:r><w:br w:type="page"/></w:r>'
  const cell = (t: string, pPr = '') =>
    `<w:tc><w:tcPr><w:tcW w:w="3000" w:type="dxa"/></w:tcPr>${p(t, pPr)}</w:tc>`
  const kitchenToc = kitchenSink()
  kitchenToc.body = TOC + kitchenToc.body
  kitchenToc.settings = '<w:mirrorMargins/>'
  const themed = (attr: string) => `<w:p><w:r><w:rPr>${attr}</w:rPr><w:t>\uAE00</w:t></w:r></w:p>`
  return [
    ['kitchen-sink', kitchenSink()],
    ['kitchen-sink-toc-mirror', kitchenToc],
    [
      'styles-and-links',
      {
        body:
          p('\uC81C\uBAA9', '<w:pStyle w:val="Heading1"/>') +
          '<w:p><w:hyperlink r:id="rIdLink"><w:r><w:t>\uB9C1\uD06C</w:t></w:r></w:hyperlink></w:p>' +
          p(
            '\uBE68\uAC15 \uD070 \uAE00',
            '<w:jc w:val="center"/><w:spacing w:line="360" w:lineRule="auto"/>',
            '<w:color w:val="FF0000"/><w:sz w:val="28"/><w:i/>',
          ) +
          sectPr(),
        extra: [
          {
            rId: 'rIdLink',
            type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink',
            path: 'word/unused.xml',
            data: '<x/>',
            contentType: 'application/xml',
          },
        ],
      },
    ],
    [
      'header-distance-top-margin',
      {
        body:
          p('\uBCF8\uBB38') +
          '<w:sectPr><w:headerReference w:type="default" r:id="rIdH"/><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="3540" w:right="1440" w:bottom="1440" w:left="1440" w:header="3660" w:footer="720" w:gutter="0"/></w:sectPr>',
        parts: { rIdH: { kind: 'header', inner: p('\uBA38\uB9AC') } },
      },
    ],
    [
      'continuous-columns',
      {
        body:
          p('\uD558\uB098') +
          `<w:p><w:pPr>${sectPr('<w:type w:val="continuous"/>')}</w:pPr><w:r><w:t>\uB458</w:t></w:r></w:p>` +
          p('\uC14B') +
          sectPr('<w:type w:val="continuous"/><w:cols w:num="2" w:space="720"/>'),
      },
    ],
    ['page-columns', { body: p('\uD558\uB098') + sectPr('<w:cols w:num="2" w:space="720"/>') }],
    [
      'three-sections',
      {
        body:
          p('\uD558\uB098') +
          `<w:p><w:pPr>${sectPr()}</w:pPr><w:r><w:t>\uB458</w:t></w:r></w:p>` +
          p('\uC14B') +
          sectPr(),
      },
    ],
    [
      'headings-outline',
      {
        body:
          p('\uC81C\uBAA9', '<w:pStyle w:val="Heading1"/>') +
          p('\uC808', '<w:outlineLvl w:val="1"/>') +
          p('\uBCF8\uBB38') +
          sectPr(),
      },
    ],
    [
      'page-breaks-inside',
      {
        body:
          `<w:p><w:r><w:t>\uC55E</w:t></w:r>${br}<w:r><w:t>\uB4A4</w:t></w:r></w:p><w:p>${br}</w:p>${p('\uB2E4\uC74C')}<w:p><w:r><w:t>\uB05D</w:t></w:r>${br}</w:p>` +
          '<w:tbl><w:tblGrid><w:gridCol w:w="2000"/></w:tblGrid><w:tr><w:tc><w:p><w:r><w:t>\uCE78</w:t></w:r></w:p></w:tc></w:tr></w:tbl>' +
          sectPr(),
      },
    ],
    ['trailing-page-break', { body: p('\uC55E') + `<w:p>${br}</w:p>` + sectPr() }],
    [
      'row-heights',
      {
        body:
          '<w:tbl><w:tblPr><w:tblW w:w="6000" w:type="dxa"/></w:tblPr><w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/></w:tblGrid>' +
          `<w:tr>${cell('\uD55C \uC904')}${cell('\uB458\uC9F8', '<w:spacing w:before="100" w:after="0" w:line="480" w:lineRule="auto"/>')}</w:tr>` +
          `<w:tr><w:trPr><w:trHeight w:val="400" w:hRule="exact"/></w:trPr>${cell('\uACE0\uC815')}${cell('\uCE78')}</w:tr>` +
          `<w:tr><w:trPr><w:trHeight w:val="2000"/></w:trPr>${cell('\uB192\uC740')}${cell('\uCE78')}</w:tr></w:tbl>` +
          sectPr(),
      },
    ],
    ['plain', { body: p('\uBCF8\uBB38') + sectPr() }],
    [
      'plain-unicode',
      { body: p('\u0131\u017f\u212a \u00e7 \ud55c\uae00 \ud83d\ude00') + sectPr() },
    ],
    [
      'objects-fallback-label',
      {
        body:
          `<w:p>${shapeRun(1270000, 635000, 'rIdFallback')}</w:p><w:p>${shapeRun(1270000, 635000, null, 21)}</w:p><w:p>${chartRun(2743200, 1371600)}</w:p>` +
          sectPr(),
        media: { rIdFallback: { name: 'fallback.png', data: PNG_GREY } },
      },
    ],
    [
      'picture-from-odt-bridge',
      {
        body:
          `<w:p>${pictureRun('rIdImg', 914400, 914400, 7).replace(/name="Picture 7"/g, 'name="odt-pic:Picture1"')}</w:p>` +
          sectPr(),
        media: { rIdImg: { name: 'image1.png', data: PNG_1X1 } },
      },
    ],
    [
      'chart-and-math',
      {
        body: `<w:p>${chartRun(2743200, 1371600)}</w:p><w:p><w:r><w:t>\uC2DD </w:t></w:r><m:oMath><m:r><m:t>x</m:t></m:r></m:oMath></w:p>${sectPr()}`,
      },
    ],
    ['theme-plain', { body: p('\uBCF8\uBB38') + sectPr(), extra: [THEME_PART] }],
    [
      'theme-accent1',
      {
        body: themed('<w:color w:val="111111" w:themeColor="accent1"/>') + sectPr(),
        extra: [THEME_PART],
      },
    ],
    [
      'theme-accent5-missing',
      {
        body: themed('<w:color w:val="111111" w:themeColor="accent5"/>') + sectPr(),
        extra: [THEME_PART],
      },
    ],
    [
      'theme-font-no-theme',
      {
        body:
          themed(
            '<w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:asciiTheme="minorHAnsi" w:hAnsiTheme="minorHAnsi"/>',
          ) + sectPr(),
      },
    ],
    [
      'theme-font-with-theme',
      {
        body:
          themed(
            '<w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:asciiTheme="minorHAnsi" w:hAnsiTheme="minorHAnsi"/>',
          ) + sectPr(),
        extra: [THEME_PART],
      },
    ],
    [
      'comment-dropped',
      {
        body:
          '<w:p><w:commentRangeStart w:id="0"/><w:r><w:t>\uBA54\uBAA8 \uB2EC\uB9B0 \uAE00</w:t></w:r><w:commentRangeEnd w:id="0"/><w:r><w:commentReference w:id="0"/></w:r></w:p>' +
          sectPr(),
        extra: [
          {
            rId: 'rIdComments',
            type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments',
            path: 'word/comments.xml',
            data: '<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:comment w:id="0" w:author="a"><w:p><w:r><w:t>\uBA54\uBAA8</w:t></w:r></w:p></w:comment></w:comments>',
            contentType:
              'application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml',
          },
        ],
      },
    ],
  ]
}

/** The `renderedObjects` the editor would give a docx that has charts and equations: small PNGs. */
export function renderedFor(name: string): DocxCase['rendered'] {
  if (name === 'chart-and-math') {
    return [
      ['0', { png: PNG_GREY, widthEmu: 1800000, heightEmu: 900000 }],
      ['1:0', { png: PNG_1X1, widthEmu: 360000, heightEmu: 180000 }],
    ]
  }
  if (name === 'kitchen-sink' || name === 'kitchen-sink-toc-mirror') {
    const solid = ts.exportObjects.solidPng
    // body positions of kitchenSink: chart, two shapes, two equations
    return [
      ['0', { png: solid(200, 30, 30), widthEmu: 2743200, heightEmu: 1371600 }],
      ['1:0', { png: solid(30, 200, 30), widthEmu: 1270000, heightEmu: 635000 }],
      ['5', { png: PNG_GREY, widthEmu: 100, heightEmu: 100 }],
      ['7', { png: solid(30, 30, 200), widthEmu: 914400, heightEmu: 457200 }],
      ['no-such-key', { png: PNG_1X1, widthEmu: 1, heightEmu: 1 }],
    ]
  }
  if (name === 'objects-fallback-label') {
    return [
      ['0', { png: PNG_1X1, widthEmu: 1270000, heightEmu: 635000 }],
      ['1', { png: PNG_GREY, widthEmu: 0, heightEmu: 0 }],
      [
        '2:0',
        { png: ts.exportObjects.solidPng(255, 255, 0), widthEmu: 2743200, heightEmu: 1371600 },
      ],
    ]
  }
  return undefined
}

/** The docx files tracked in the repository, and the docx fixtures of the odt tests. */
export async function docxCases(): Promise<DocxCase[]> {
  const out: DocxCase[] = []
  const tracked = execFileSync('git', ['ls-files', '-z', '*.docx'], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean)
  for (const path of tracked)
    out.push({
      name: path,
      bytes: new Uint8Array(readFileSync(resolve(repoRoot, path))),
      tracked: true,
    })
  for (const [name, spec] of await builtDocxSpecs()) {
    out.push({
      name: `built ${name}`,
      bytes: await withClock(() => buildDocx(spec)),
      tracked: false,
      rendered: renderedFor(name),
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// Mutations

// `mutate` of ../docx-diff/compare-xml.ts, which sits in a module that loads the
// wasm when it is imported: the TypeScript-only dry run has none. The same
// tokens and the same three kinds of edit.
const MUTATION_TOKENS = [
  ...'<>/"\'=&; \t\r\n',
  '\r\n',
  '&amp;',
  '&lt;',
  '&quot;',
  '&#0;',
  '&#x1F;',
  '&#65;',
  '&#xD800;',
  '&unknown;',
  '<!--',
  '-->',
  '<![CDATA[',
  ']]>',
  '<![',
  '<?',
  '?>',
  '<?xml version="1.1"?>',
  '</w:x>',
  '<w:x>',
  '<w:x/>',
  ' a="b"',
  '\u00E9',
  '\u{1F600}',
  '\u00A0',
  '\uFEFF',
  '\u0001',
  'constructor',
  'toString',
  '__proto__',
  '#text',
  '10',
  '\u0131',
  '\u017F',
  '\u212A',
  '<text:p>',
  '</text:p>',
  '<text:span text:style-name="T1">',
  'text:style-name="',
  '<office:text>',
  '</office:text>',
]

/** One to three edits on code point boundaries: delete, insert a token, duplicate a slice. */
function mutate(fragment: string, random: () => number): string {
  const points = Array.from(fragment)
  const at = (): number => Math.floor(random() * (points.length + 1))
  for (let edits = 1 + Math.floor(random() * 3); edits > 0; edits--) {
    const kind = random()
    if (kind < 0.35) {
      points.splice(at(), 1 + Math.floor(random() * 6))
    } else if (kind < 0.85) {
      points.splice(at(), 0, MUTATION_TOKENS[Math.floor(random() * MUTATION_TOKENS.length)]!)
    } else {
      const from = at()
      points.splice(at(), 0, ...points.slice(from, from + 1 + Math.floor(random() * 12)))
    }
  }
  return points.join('')
}

const PARTS = ['content.xml', 'styles.xml', 'meta.xml', 'META-INF/manifest.xml'] as const

/** `bytes` with one part of the package replaced by `text`, everything else as it was. */
export async function withPart(
  bytes: Uint8Array,
  name: string,
  text: string,
): Promise<Uint8Array | null> {
  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(bytes)
  } catch {
    return null
  }
  if (!zip.file(name)) return null
  const stored = name === 'mimetype'
  zip.file(name, text, { compression: stored ? 'STORE' : 'DEFLATE' })
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
}

/** The text of a part of an ODT, `null` where there is none. */
export async function partText(bytes: Uint8Array, name: string): Promise<string | null> {
  try {
    const zip = await JSZip.loadAsync(bytes)
    return (await zip.file(name)?.async('string')) ?? null
  } catch {
    return null
  }
}

/** Seeded mutations of the text of one part of a seed ODT (`count` of them). */
export async function mutatedOdts(
  seeds: OdtCase[],
  random: () => number,
  count: number,
): Promise<OdtCase[]> {
  const usable = seeds.filter((seed) => seed.kind !== 'mutation')
  const out: OdtCase[] = []
  for (let done = 0, tried = 0; done < count && tried < count * 4; tried++) {
    const seed = usable[Math.floor(random() * usable.length)]!
    const part = PARTS[Math.floor(random() * PARTS.length)]!
    const original = await partText(seed.bytes, part)
    if (original === null) continue
    const mutated = await withPart(seed.bytes, part, mutate(original, random))
    if (mutated === null) continue
    out.push({
      name: `mutation ${done} of ${seed.name}: ${part}`,
      bytes: mutated,
      kind: 'mutation',
    })
    done += 1
  }
  return out
}

/** Seeded mutations of the container: header fields, slices, the end cut off. */
export function mutatedContainers(
  seeds: OdtCase[],
  random: () => number,
  count: number,
): OdtCase[] {
  const usable = seeds.filter((seed) => seed.kind !== 'mutation' && seed.bytes.length >= 60)
  return Array.from({ length: count }, (_, done) => {
    const seed = usable[Math.floor(random() * usable.length)]!
    return {
      name: `container mutation ${done} of ${seed.name}`,
      bytes: mutateContainer(seed.bytes, random),
      kind: 'mutation',
    }
  })
}

/** Seeded mutations of the XML text of a docx part, for docxToOdt. */
export async function mutatedDocx(
  seeds: DocxCase[],
  random: () => number,
  count: number,
): Promise<DocxCase[]> {
  const usable = seeds.filter((seed) => !seed.tracked || seed.bytes.length < 400_000)
  const parts = [
    'word/document.xml',
    'word/styles.xml',
    'word/numbering.xml',
    'word/footnotes.xml',
    '[Content_Types].xml',
  ]
  const out: DocxCase[] = []
  for (let done = 0, tried = 0; done < count && tried < count * 6; tried++) {
    const seed = usable[Math.floor(random() * usable.length)]!
    const part = parts[Math.floor(random() * parts.length)]!
    const original = await partText(seed.bytes, part)
    if (original === null || original.length > 400_000) continue
    const mutated = await withPart(seed.bytes, part, mutate(original, random))
    if (mutated === null) continue
    out.push({ name: `mutation ${done} of ${seed.name}: ${part}`, bytes: mutated, tracked: false })
    done += 1
  }
  return out
}

export function mutatedDocxContainers(
  seeds: DocxCase[],
  random: () => number,
  count: number,
): DocxCase[] {
  const usable = seeds.filter((seed) => seed.bytes.length >= 60 && seed.bytes.length < 400_000)
  return Array.from({ length: count }, (_, done) => {
    const seed = usable[Math.floor(random() * usable.length)]!
    return {
      name: `container mutation ${done} of ${seed.name}`,
      bytes: mutateContainer(seed.bytes, random),
      tracked: false,
    }
  })
}
