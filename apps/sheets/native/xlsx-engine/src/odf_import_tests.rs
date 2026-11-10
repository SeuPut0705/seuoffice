//! End-to-end tests for what the `.ods` import carries beyond values: a small
//! package goes in, and the worksheet, stylesheet and side parts of the
//! `.xlsx` that comes out are read back.

use std::fs::File;
use std::io::{Read, Write};
use std::path::Path;

use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

use crate::WorkbookSessions;
use crate::convert::convert_to_xlsx;

const NS: &str = concat!(
    r#"xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" "#,
    r#"xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" "#,
    r#"xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" "#,
    r#"xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" "#,
    r#"xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" "#,
    r#"xmlns:number="urn:oasis:names:tc:opendocument:xmlns:datastyle:1.0" "#,
    r#"xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" "#,
    r#"xmlns:xlink="http://www.w3.org/1999/xlink" "#,
    r#"xmlns:dc="http://purl.org/dc/elements/1.1/" "#,
    r#"xmlns:of="urn:oasis:names:tc:opendocument:xmlns:of:1.2" "#,
    r#"xmlns:calcext="urn:org:documentfoundation:names:experimental:calc:xmlns:calcext:1.0" "#,
    r#"xmlns:config="urn:oasis:names:tc:opendocument:xmlns:config:1.0""#,
);

/// The parts of a test package. Table markup must hold no whitespace between
/// elements: the value reader rejects text inside a row.
#[derive(Default)]
struct Package<'a> {
    /// Inside `office:automatic-styles` of `content.xml`.
    automatic: &'a str,
    /// Inside `office:spreadsheet`.
    body: &'a str,
    /// Inside `office:styles` of `styles.xml`.
    named: &'a str,
    /// Inside `office:automatic-styles` of `styles.xml`.
    page_styles: &'a str,
    /// Inside `office:master-styles`.
    masters: &'a str,
    /// Inside `office:settings`, when the package has a `settings.xml`.
    settings: Option<&'a str>,
}

fn write_package(path: &Path, package: &Package<'_>) {
    let mut writer = ZipWriter::new(File::create(path).unwrap());
    writer
        .start_file(
            "mimetype",
            SimpleFileOptions::default().compression_method(CompressionMethod::Stored),
        )
        .unwrap();
    writer
        .write_all(b"application/vnd.oasis.opendocument.spreadsheet")
        .unwrap();
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    let mut add = |name: &str, content: String| {
        writer.start_file(name, options).unwrap();
        writer.write_all(content.as_bytes()).unwrap();
    };
    add(
        "content.xml",
        format!(
            r#"<?xml version="1.0" encoding="UTF-8"?><office:document-content {NS} office:version="1.3"><office:automatic-styles>{}</office:automatic-styles><office:body><office:spreadsheet>{}</office:spreadsheet></office:body></office:document-content>"#,
            package.automatic, package.body
        ),
    );
    add(
        "styles.xml",
        format!(
            r#"<?xml version="1.0" encoding="UTF-8"?><office:document-styles {NS} office:version="1.3"><office:styles>{}</office:styles><office:automatic-styles>{}</office:automatic-styles><office:master-styles>{}</office:master-styles></office:document-styles>"#,
            package.named, package.page_styles, package.masters
        ),
    );
    if let Some(settings) = package.settings {
        add(
            "settings.xml",
            format!(
                r#"<?xml version="1.0" encoding="UTF-8"?><office:document-settings {NS} office:version="1.3"><office:settings>{settings}</office:settings></office:document-settings>"#
            ),
        );
    }
    add(
        "META-INF/manifest.xml",
        r#"<?xml version="1.0" encoding="UTF-8"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3"><manifest:file-entry manifest:full-path="/" manifest:version="1.3" manifest:media-type="application/vnd.oasis.opendocument.spreadsheet"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/><manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/></manifest:manifest>"#.to_owned(),
    );
    writer.finish().unwrap();
}

fn read_entry(path: &Path, name: &str) -> String {
    let mut archive = ZipArchive::new(File::open(path).unwrap()).unwrap();
    let mut entry = archive
        .by_name(name)
        .unwrap_or_else(|_| panic!("the package has no {name}"));
    let mut text = String::new();
    entry.read_to_string(&mut text).unwrap();
    text
}

fn has_entry(path: &Path, name: &str) -> bool {
    ZipArchive::new(File::open(path).unwrap())
        .unwrap()
        .by_name(name)
        .is_ok()
}

/// Converts the package and returns the directory that keeps the result
/// alive, plus the path of the `.xlsx`.
fn convert(package: &Package<'_>) -> (tempfile::TempDir, std::path::PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("book.ods");
    let target = dir.path().join("book.xlsx");
    write_package(&source, package);
    convert_to_xlsx(&source, &target).unwrap();
    (dir, target)
}

/// The schema fixes the order of a worksheet's children; a part out of place
/// is a file Excel repairs or refuses.
fn assert_in_order(xml: &str, parts: &[&str]) {
    let mut last = 0;
    for part in parts {
        let position = xml
            .find(part)
            .unwrap_or_else(|| panic!("{part} is missing from {xml}"));
        assert!(position >= last, "{part} is out of order in {xml}");
        last = position;
    }
}

#[test]
fn carries_cell_formatting_from_ods() {
    let (_dir, target) = convert(&Package {
        named: concat!(
            r#"<style:default-style style:family="table-cell"><style:text-properties style:font-name="맑은 고딕" fo:font-size="10pt"/></style:default-style>"#,
            r#"<style:style style:name="Default" style:family="table-cell"/>"#,
            r##"<style:style style:name="Heading" style:family="table-cell" style:parent-style-name="Default"><style:table-cell-properties fo:background-color="#ddebf7"/><style:text-properties fo:font-weight="bold"/></style:style>"##,
        ),
        automatic: concat!(
            r#"<number:number-style style:name="N1"><number:number number:decimal-places="2" number:min-decimal-places="2" number:min-integer-digits="1" number:grouping="true"/></number:number-style>"#,
            r#"<number:date-style style:name="N2"><number:year number:style="long"/><number:text>-</number:text><number:month number:style="long"/><number:text>-</number:text><number:day number:style="long"/></number:date-style>"#,
            r##"<style:style style:name="ce1" style:family="table-cell" style:parent-style-name="Heading" style:data-style-name="N1"><style:table-cell-properties fo:border="0.75pt solid #000000" fo:border-bottom="1.5pt double #ff0000" style:vertical-align="middle" fo:wrap-option="wrap" style:text-align-source="fix"/><style:paragraph-properties fo:text-align="center"/><style:text-properties style:font-size-asian="14pt" fo:font-style="italic" fo:color="#0000ff"/></style:style>"##,
            r#"<style:style style:name="ce2" style:family="table-cell" style:parent-style-name="Default" style:data-style-name="N2"/>"#,
            r##"<style:style style:name="ce3" style:family="table-cell" style:parent-style-name="Default"><style:table-cell-properties fo:background-color="#ffff00"/></style:style>"##,
        ),
        body: concat!(
            r#"<table:table table:name="Data">"#,
            r#"<table:table-column table:number-columns-repeated="2"/><table:table-column table:default-cell-style-name="ce3"/><table:table-column table:number-columns-repeated="3"/>"#,
            r#"<table:table-row>"#,
            r#"<table:table-cell table:style-name="ce1" office:value-type="float" office:value="1234.5"><text:p>1,234.50</text:p></table:table-cell>"#,
            r#"<table:table-cell table:style-name="ce1"/>"#,
            r#"<table:table-cell office:value-type="string"><text:p>in the yellow column</text:p></table:table-cell>"#,
            r#"<table:table-cell table:style-name="ce2" office:value-type="date" office:date-value="2026-03-05"><text:p>2026-03-05</text:p></table:table-cell>"#,
            r#"<table:table-cell office:value-type="date" office:date-value="2026-03-05"><text:p>2026-03-05</text:p></table:table-cell>"#,
            r#"<table:table-cell table:style-name="ce1" office:value-type="date" office:date-value="2026-03-05"><text:p>2026-03-05</text:p></table:table-cell>"#,
            r#"</table:table-row>"#,
            r#"<table:table-row table:default-cell-style-name="Heading"><table:table-cell office:value-type="string"><text:p>row style</text:p></table:table-cell><table:table-cell table:number-columns-repeated="5"/></table:table-row>"#,
            r#"</table:table>"#,
        ),
        ..Package::default()
    });
    let styles = read_entry(&target, "xl/styles.xml");
    // the default cell is the document's, not the importer's own
    assert!(
        styles.contains(r#"<fonts count="3"><font><sz val="10"/><name val="맑은 고딕"/></font>"#),
        "{styles}"
    );
    assert!(
        styles.contains(r#"<font><b/><i/><sz val="14"/><color rgb="FF0000FF"/><name val="맑은 고딕"/></font>"#),
        "{styles}"
    );
    assert!(
        styles.contains(r#"<fill><patternFill patternType="solid"><fgColor rgb="FFDDEBF7"/><bgColor indexed="64"/></patternFill></fill>"#),
        "{styles}"
    );
    assert!(
        styles.contains(r#"<border><left style="thin"><color rgb="FF000000"/></left><right style="thin"><color rgb="FF000000"/></right><top style="thin"><color rgb="FF000000"/></top><bottom style="double"><color rgb="FFFF0000"/></bottom><diagonal/></border>"#),
        "{styles}"
    );
    assert!(styles.contains(r#"<numFmt numFmtId="165" formatCode="yyyy-mm-dd"/>"#), "{styles}");
    // xf 4 is the yellow column, xf 5 the styled number
    assert!(
        styles.contains(r#"<xf numFmtId="4" fontId="1" fillId="3" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>"#),
        "{styles}"
    );
    let sheet = read_entry(&target, "xl/worksheets/sheet1.xml");
    assert!(sheet.contains(r#"<c r="A1" s="5"><v>1234.5</v></c>"#), "{sheet}");
    assert!(sheet.contains(r#"<c r="B1" s="5"/>"#), "a styled empty cell exists: {sheet}");
    // the column's default cell style reaches a cell that names none
    let yellow = sheet
        .split(r#"<c r="C1" s=""#)
        .nth(1)
        .and_then(|rest| rest.split('"').next())
        .unwrap_or_else(|| panic!("C1 has no style: {sheet}"))
        .to_owned();
    assert!(sheet.contains(&format!(r#"<col min="3" max="3" width="8.43" style="{yellow}"/>"#)), "{sheet}");
    // a date keeps its style's date format; without one it takes the fallback
    let dated = sheet
        .split(r#"<c r="D1" s=""#)
        .nth(1)
        .and_then(|rest| rest.split('"').next())
        .unwrap()
        .to_owned();
    assert!(sheet.contains(&format!(r#"<c r="D1" s="{dated}"><v>46086</v></c>"#)), "{sheet}");
    assert!(sheet.contains(r#"<c r="E1" s="1"><v>46086</v></c>"#), "{sheet}");
    assert!(!sheet.contains(r#"<c r="F1" s="5">"#), "a number format gives way on a date: {sheet}");
    // the row's default cell style is the row's style and its cell's
    assert!(sheet.contains(r#"<row r="2" s=""#) && sheet.contains(r#"customFormat="1""#), "{sheet}");

    // the engine reads back what the importer wrote
    let mut sessions = WorkbookSessions::new();
    let metadata = sessions.open(&target).unwrap();
    assert!(metadata.styles.len() > 6, "{}", metadata.styles.len());
    let _ = sessions.close(&metadata.session_id);
}

#[test]
fn carries_structure_and_the_saved_window_from_ods() {
    let (_dir, target) = convert(&Package {
        automatic: concat!(
            r##"<style:style style:name="ta1" style:family="table"><style:table-properties table:display="true" style:writing-mode="rl-tb" table:tab-color="#00ff00"/></style:style>"##,
            r#"<style:style style:name="co1" style:family="table-column"><style:table-column-properties style:column-width="1in"/></style:style>"#,
        ),
        body: concat!(
            r#"<table:table table:name="First"><table:table-column/><table:table-row><table:table-cell office:value-type="float" office:value="1"><text:p>1</text:p></table:table-cell></table:table-row></table:table>"#,
            r#"<table:table table:name="Data" table:style-name="ta1" table:protected="true">"#,
            r#"<table:table-column table:style-name="co1"/>"#,
            r#"<table:table-column-group table:display="false"><table:table-column table:style-name="co1" table:visibility="collapse" table:number-columns-repeated="2"/></table:table-column-group>"#,
            r#"<table:table-column table:style-name="co1"/>"#,
            r#"<table:table-row><table:table-cell office:value-type="string"><text:p>name</text:p></table:table-cell><table:table-cell office:value-type="string"><text:p>a</text:p></table:table-cell><table:table-cell office:value-type="string"><text:p>b</text:p></table:table-cell><table:table-cell office:value-type="string"><text:p>c</text:p></table:table-cell></table:table-row>"#,
            r#"<table:table-row-group><table:table-row table:visibility="filter"><table:table-cell office:value-type="string"><text:p>x</text:p></table:table-cell><table:table-cell table:number-columns-repeated="3"/></table:table-row><table:table-row table:number-rows-repeated="2"><table:table-cell office:value-type="string"><text:p>y</text:p></table:table-cell><table:table-cell table:number-columns-repeated="3"/></table:table-row></table:table-row-group>"#,
            r#"<table:table-row><table:table-cell office:value-type="string"><text:p>sum</text:p></table:table-cell><table:table-cell table:number-columns-repeated="3"/></table:table-row>"#,
            r#"<table:table-row table:visibility="collapse" table:number-rows-repeated="1048571"><table:table-cell table:number-columns-repeated="4"/></table:table-row>"#,
            r#"</table:table>"#,
            r#"<table:database-ranges><table:database-range table:name="__Anonymous_Sheet_DB__1" table:target-range-address="Data.A1:Data.D4" table:display-filter-buttons="true"><table:filter><table:filter-and><table:filter-condition table:field-number="0" table:operator="=" table:value="y"><table:filter-set-item table:value="y"/></table:filter-condition><table:filter-or><table:filter-condition table:field-number="1" table:operator="&gt;" table:value="5" table:data-type="number"/><table:filter-condition table:field-number="1" table:operator="&lt;" table:value="2" table:data-type="number"/></table:filter-or></table:filter-and></table:filter></table:database-range></table:database-ranges>"#,
        ),
        settings: Some(concat!(
            r#"<config:config-item-set config:name="ooo:view-settings"><config:config-item-map-indexed config:name="Views"><config:config-item-map-entry>"#,
            r#"<config:config-item-map-named config:name="Tables"><config:config-item-map-entry config:name="Data">"#,
            r#"<config:config-item config:name="HorizontalSplitMode" config:type="short">2</config:config-item><config:config-item config:name="VerticalSplitMode" config:type="short">2</config:config-item><config:config-item config:name="HorizontalSplitPosition" config:type="int">1</config:config-item><config:config-item config:name="VerticalSplitPosition" config:type="int">1</config:config-item><config:config-item config:name="PositionLeft" config:type="int">0</config:config-item><config:config-item config:name="PositionRight" config:type="int">3</config:config-item><config:config-item config:name="PositionTop" config:type="int">0</config:config-item><config:config-item config:name="PositionBottom" config:type="int">1</config:config-item><config:config-item config:name="ZoomValue" config:type="int">150</config:config-item><config:config-item config:name="ShowGrid" config:type="boolean">false</config:config-item>"#,
            r#"</config:config-item-map-entry></config:config-item-map-named>"#,
            r#"<config:config-item config:name="ActiveTable" config:type="string">Data</config:config-item>"#,
            r#"</config:config-item-map-entry></config:config-item-map-indexed></config:config-item-set>"#,
        )),
        ..Package::default()
    });
    let sheet = read_entry(&target, "xl/worksheets/sheet2.xml");
    assert_in_order(
        &sheet,
        &[
            "<sheetPr>",
            "<dimension ",
            "<sheetViews>",
            "<sheetFormatPr ",
            "<cols>",
            "<sheetData>",
            "<sheetProtection ",
            "<autoFilter ",
        ],
    );
    assert!(sheet.contains(r#"<sheetPr><tabColor rgb="FF00FF00"/></sheetPr>"#), "{sheet}");
    assert!(
        sheet.contains(r#"<sheetViews><sheetView showGridLines="0" rightToLeft="1" tabSelected="1" zoomScale="150" workbookViewId="0"><pane xSplit="1" ySplit="1" topLeftCell="D2" activePane="bottomRight" state="frozen"/><selection pane="bottomRight"/></sheetView></sheetViews>"#),
        "{sheet}"
    );
    // the rows above a hidden tail are written; the default row is the hidden one
    assert!(
        sheet.contains(r#"outlineLevelRow="1""#) && sheet.contains(r#"outlineLevelCol="1""#) && sheet.contains(r#"zeroHeight="1""#),
        "{sheet}"
    );
    assert!(
        sheet.contains(r#"<cols><col min="1" max="1" width="13.00" customWidth="1"/><col min="2" max="3" width="13.00" customWidth="1" hidden="1" outlineLevel="1"/><col min="4" max="4" width="13.00" customWidth="1" collapsed="1"/></cols>"#),
        "{sheet}"
    );
    assert!(sheet.contains(r#"<row r="2" hidden="1" outlineLevel="1">"#), "{sheet}");
    assert!(sheet.contains(r#"<row r="3" outlineLevel="1">"#), "{sheet}");
    assert!(sheet.contains(r#"<row r="5">"#), "the row below the group is not hidden: {sheet}");
    assert!(sheet.len() < 4_000, "a million hidden rows stay one flag: {}", sheet.len());
    assert!(sheet.contains(r#"<sheetProtection sheet="1" objects="1" scenarios="1"/>"#), "{sheet}");
    assert!(
        sheet.contains(r#"<autoFilter ref="A1:D4"><filterColumn colId="0"><filters><filter val="y"/></filters></filterColumn><filterColumn colId="1"><customFilters><customFilter operator="greaterThan" val="5"/><customFilter operator="lessThan" val="2"/></customFilters></filterColumn></autoFilter>"#),
        "{sheet}"
    );
    let workbook = read_entry(&target, "xl/workbook.xml");
    assert!(workbook.contains(r#"<bookViews><workbookView activeTab="1"/></bookViews><sheets>"#), "{workbook}");
    assert!(
        workbook.contains(r#"<definedName name="_xlnm._FilterDatabase" localSheetId="1" hidden="1">'Data'!$A$1:$D$4</definedName>"#),
        "{workbook}"
    );

    let mut sessions = WorkbookSessions::new();
    let metadata = sessions.open(&target).unwrap();
    let data = &metadata.sheets[1];
    assert!(data.right_to_left && !data.show_grid_lines);
    assert_eq!(data.zoom_scale, Some(150));
    assert_eq!(data.tab_color.as_deref().map(str::to_uppercase).as_deref(), Some("#00FF00"));
    assert!(data.freeze.is_some());
    assert_eq!((data.outline_level_row, data.outline_level_col), (1, 1));
    let _ = sessions.close(&metadata.session_id);
}

#[test]
fn carries_links_notes_and_text_runs_from_ods() {
    let (_dir, target) = convert(&Package {
        automatic: r##"<style:style style:name="T1" style:family="text"><style:text-properties fo:font-weight="bold" fo:color="#ff0000" style:text-position="super 58%"/></style:style>"##,
        body: concat!(
            r#"<table:table table:name="Data"><table:table-column table:number-columns-repeated="3"/><table:table-row>"#,
            r#"<table:table-cell office:value-type="string"><office:annotation><dc:creator>Kim &amp; Lee</dc:creator><dc:date>2026-01-01T00:00:00</dc:date><text:p>first line</text:p><text:p>second &lt;line&gt;</text:p></office:annotation><text:p><text:a xlink:type="simple" xlink:href="https://example.com/?a=1&amp;b=2">site</text:a></text:p></table:table-cell>"#,
            r##"<table:table-cell office:value-type="string"><text:p><text:a xlink:type="simple" xlink:href="#'My sheet'.B3">jump</text:a></text:p></table:table-cell>"##,
            r#"<table:table-cell office:value-type="string"><text:p>H<text:span text:style-name="T1">2</text:span>O</text:p></table:table-cell>"#,
            r#"</table:table-row></table:table>"#,
            r#"<table:table table:name="My sheet"><table:table-column/><table:table-row><table:table-cell office:value-type="float" office:value="1"><text:p>1</text:p></table:table-cell></table:table-row></table:table>"#,
        ),
        ..Package::default()
    });
    let sheet = read_entry(&target, "xl/worksheets/sheet1.xml");
    assert!(sheet.contains(r#"<t xml:space="preserve">site</t>"#), "the note is not part of the value: {sheet}");
    assert!(
        sheet.contains(r#"<hyperlinks><hyperlink ref="A1" r:id="rIdL1"/><hyperlink ref="B1" location="'My sheet'!B3"/></hyperlinks>"#),
        "{sheet}"
    );
    assert!(
        sheet.contains(r#"<c r="C1" t="inlineStr"><is><r><t xml:space="preserve">H</t></r><r><rPr><b/><color rgb="FFFF0000"/><vertAlign val="superscript"/></rPr><t xml:space="preserve">2</t></r><r><t xml:space="preserve">O</t></r></is></c>"#),
        "{sheet}"
    );
    assert_in_order(&sheet, &["<sheetData>", "<hyperlinks>", "<legacyDrawing "]);
    let rels = read_entry(&target, "xl/worksheets/_rels/sheet1.xml.rels");
    assert!(
        rels.contains(r#"<Relationship Id="rIdL1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/?a=1&amp;b=2" TargetMode="External"/>"#),
        "{rels}"
    );
    assert!(rels.contains(r#"Target="../comments1.xml""#) && rels.contains(r#"Target="../drawings/vmlDrawing1.vml""#), "{rels}");
    let comments = read_entry(&target, "xl/comments1.xml");
    assert!(
        comments.contains("<authors><author>Kim &amp; Lee</author></authors>")
            && comments.contains(r#"<comment ref="A1" authorId="0"><text><r><t xml:space="preserve">first line"#)
            && comments.contains("second &lt;line&gt;</t>"),
        "{comments}"
    );
    let vml = read_entry(&target, "xl/drawings/vmlDrawing1.vml");
    assert!(vml.contains("<x:Row>0</x:Row><x:Column>0</x:Column>"), "{vml}");
    let types = read_entry(&target, "[Content_Types].xml");
    assert!(
        types.contains(r#"<Default Extension="vml" ContentType="application/vnd.openxmlformats-officedocument.vmlDrawing"/>"#)
            && types.contains(r#"<Override PartName="/xl/comments1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.comments+xml"/>"#),
        "{types}"
    );
    assert!(!has_entry(&target, "xl/worksheets/_rels/sheet2.xml.rels"));

    let mut sessions = WorkbookSessions::new();
    let metadata = sessions.open(&target).unwrap();
    assert_eq!(metadata.sheets[0].comments.len(), 1);
    assert_eq!(metadata.sheets[0].comments[0].text, "first line\nsecond <line>");
    let _ = sessions.close(&metadata.session_id);
}

#[test]
fn carries_the_print_setup_from_ods() {
    let (_dir, target) = convert(&Package {
        page_styles: concat!(
            r#"<style:style style:name="MT1" style:family="text"><style:text-properties fo:font-weight="bold"/></style:style>"#,
            r#"<style:page-layout style:name="pm1"><style:page-layout-properties fo:page-width="29.700cm" fo:page-height="21.000cm" style:print-orientation="landscape" fo:margin-left="0.5in" fo:margin-right="0.5in" fo:margin-top="0.3in" fo:margin-bottom="1in" style:scale-to-X="1" style:scale-to-Y="2" style:print="grid headers" style:table-centering="both" style:first-page-number="5"/><style:header-style><style:header-footer-properties svg:height="0.45in"/></style:header-style><style:footer-style><style:header-footer-properties svg:height="0in"/></style:footer-style></style:page-layout>"#,
        ),
        masters: r#"<style:master-page style:name="m1" style:page-layout-name="pm1"><style:header><style:region-left><text:p><text:sheet-name>?</text:sheet-name></text:p></style:region-left><style:region-right><text:p><text:span text:style-name="MT1">Page <text:page-number>1</text:page-number></text:span> / <text:page-count>1</text:page-count></text:p></style:region-right></style:header><style:header-left style:display="false"/><style:footer style:display="false"/><style:footer-left style:display="false"/></style:master-page>"#,
        automatic: concat!(
            r#"<style:style style:name="ta1" style:family="table" style:master-page-name="m1"><style:table-properties table:display="true"/></style:style>"#,
            r#"<style:style style:name="ro1" style:family="table-row"><style:table-row-properties fo:break-before="page"/></style:style>"#,
            r#"<style:style style:name="co1" style:family="table-column"><style:table-column-properties fo:break-before="page" style:column-width="1in"/></style:style>"#,
        ),
        body: concat!(
            r#"<table:table table:name="It's" table:style-name="ta1" table:print-ranges="$'It''s'.$A$1:.$C$9 $'It''s'.$E$1:.$F$3">"#,
            r#"<table:table-header-columns><table:table-column/></table:table-header-columns><table:table-column/><table:table-column table:style-name="co1"/>"#,
            r#"<table:table-header-rows><table:table-row table:number-rows-repeated="2"><table:table-cell office:value-type="string"><text:p>head</text:p></table:table-cell><table:table-cell table:number-columns-repeated="2"/></table:table-row></table:table-header-rows>"#,
            r#"<table:table-row><table:table-cell office:value-type="float" office:value="1"><text:p>1</text:p></table:table-cell><table:table-cell table:number-columns-repeated="2"/></table:table-row>"#,
            r#"<table:table-row table:style-name="ro1"><table:table-cell office:value-type="float" office:value="2"><text:p>2</text:p></table:table-cell><table:table-cell table:number-columns-repeated="2"/></table:table-row>"#,
            r#"</table:table>"#,
        ),
        ..Package::default()
    });
    let sheet = read_entry(&target, "xl/worksheets/sheet1.xml");
    assert_in_order(
        &sheet,
        &[
            "<sheetPr>",
            "<sheetData>",
            "<printOptions ",
            "<pageMargins ",
            "<pageSetup ",
            "<headerFooter>",
            "<rowBreaks ",
            "<colBreaks ",
        ],
    );
    assert!(sheet.contains(r#"<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>"#), "{sheet}");
    assert!(
        sheet.contains(r#"<printOptions horizontalCentered="1" verticalCentered="1" headings="1" gridLines="1"/>"#),
        "{sheet}"
    );
    // the header sits in the page margin and the body below it
    assert!(
        sheet.contains(r#"<pageMargins left="0.5" right="0.5" top="0.75" bottom="1" header="0.3" footer="0.3"/>"#),
        "{sheet}"
    );
    assert!(
        sheet.contains(r#"<pageSetup paperSize="9" firstPageNumber="5" fitToWidth="1" fitToHeight="2" orientation="landscape" useFirstPageNumber="1"/>"#),
        "{sheet}"
    );
    assert!(
        sheet.contains(r#"<headerFooter><oddHeader>&amp;L&amp;A&amp;R&amp;&quot;-,Bold&quot;Page &amp;P&amp;&quot;-,Regular&quot; / &amp;N</oddHeader></headerFooter>"#),
        "{sheet}"
    );
    assert!(sheet.contains(r#"<rowBreaks count="1" manualBreakCount="1"><brk id="3" max="16383" man="1"/></rowBreaks>"#), "{sheet}");
    assert!(sheet.contains(r#"<colBreaks count="1" manualBreakCount="1"><brk id="2" max="1048575" man="1"/></colBreaks>"#), "{sheet}");
    let workbook = read_entry(&target, "xl/workbook.xml");
    assert!(
        workbook.contains(r#"<definedName name="_xlnm.Print_Area" localSheetId="0">'It''s'!$A$1:$C$9,'It''s'!$E$1:$F$3</definedName>"#),
        "{workbook}"
    );
    assert!(
        workbook.contains(r#"<definedName name="_xlnm.Print_Titles" localSheetId="0">'It''s'!$A:$A,'It''s'!$1:$2</definedName>"#),
        "{workbook}"
    );
}

#[test]
fn carries_validations_and_conditional_formats_from_ods() {
    let (_dir, target) = convert(&Package {
        named: concat!(
            r#"<style:style style:name="Default" style:family="table-cell"/>"#,
            r##"<style:style style:name="Good" style:family="table-cell" style:parent-style-name="Default"><style:table-cell-properties fo:background-color="#ccffcc"/><style:text-properties fo:color="#006600" fo:font-weight="bold"/></style:style>"##,
        ),
        body: concat!(
            r#"<table:content-validations>"#,
            r#"<table:content-validation table:name="val1" table:condition="of:cell-content-is-in-list(&quot;yes&quot;;&quot;no&quot;)" table:allow-empty-cell="true" table:base-cell-address="Data.B1"><table:help-message table:title="Pick" table:display="true"><text:p>yes or no</text:p></table:help-message><table:error-message table:message-type="warning" table:title="Oops" table:display="true"><text:p>not in the list</text:p></table:error-message></table:content-validation>"#,
            r#"<table:content-validation table:name="val2" table:condition="of:cell-content-is-whole-number() and cell-content()&gt;=[.A1]" table:allow-empty-cell="false" table:base-cell-address="Data.C1"/>"#,
            r#"</table:content-validations>"#,
            r#"<table:table table:name="Data"><table:table-column table:number-columns-repeated="3"/>"#,
            r#"<table:table-row table:number-rows-repeated="3"><table:table-cell office:value-type="float" office:value="7"><text:p>7</text:p></table:table-cell><table:table-cell table:content-validation-name="val1"/><table:table-cell/></table:table-row>"#,
            r#"<table:table-row><table:table-cell office:value-type="float" office:value="9"><text:p>9</text:p></table:table-cell><table:table-cell/><table:table-cell table:content-validation-name="val2"/></table:table-row>"#,
            r##"<calcext:conditional-formats><calcext:conditional-format calcext:target-range-address="Data.A1:Data.A4"><calcext:condition calcext:apply-style-name="Good" calcext:value="&gt;[.C1]" calcext:base-cell-address="Data.A1"/><calcext:condition calcext:apply-style-name="Good" calcext:value="formula-is(MOD(ROW();2)=0)" calcext:base-cell-address="Data.A1"/><calcext:color-scale><calcext:color-scale-entry calcext:value="0" calcext:type="minimum" calcext:color="#ff0000"/><calcext:color-scale-entry calcext:value="50" calcext:type="percentile" calcext:color="#ffff00"/><calcext:color-scale-entry calcext:value="0" calcext:type="maximum" calcext:color="#00ff00"/></calcext:color-scale></calcext:conditional-format></calcext:conditional-formats>"##,
            r#"</table:table>"#,
        ),
        ..Package::default()
    });
    let sheet = read_entry(&target, "xl/worksheets/sheet1.xml");
    assert_in_order(&sheet, &["<sheetData>", "<conditionalFormatting ", "<dataValidations "]);
    assert!(
        sheet.contains(concat!(
            r#"<conditionalFormatting sqref="A1:A4">"#,
            r#"<cfRule type="cellIs" operator="greaterThan" dxfId="0" priority="1"><formula>C1</formula></cfRule>"#,
            r#"<cfRule type="expression" dxfId="0" priority="2"><formula>MOD(ROW(),2)=0</formula></cfRule>"#,
            r#"<cfRule type="colorScale" priority="3"><colorScale><cfvo type="min"/><cfvo type="percentile" val="50"/><cfvo type="max"/><color rgb="FFFF0000"/><color rgb="FFFFFF00"/><color rgb="FF00FF00"/></colorScale></cfRule>"#,
            r#"</conditionalFormatting>"#,
        )),
        "{sheet}"
    );
    assert!(
        sheet.contains(concat!(
            r#"<dataValidations count="2">"#,
            r#"<dataValidation type="list" errorStyle="warning" allowBlank="1" showInputMessage="1" showErrorMessage="1" errorTitle="Oops" error="not in the list" promptTitle="Pick" prompt="yes or no" sqref="B1:B3"><formula1>&quot;yes,no&quot;</formula1></dataValidation>"#,
            // written for C1, read from C4: the reference moves three rows down
            r#"<dataValidation type="whole" operator="greaterThanOrEqual" sqref="C4"><formula1>A4</formula1></dataValidation>"#,
            r#"</dataValidations>"#,
        )),
        "{sheet}"
    );
    let styles = read_entry(&target, "xl/styles.xml");
    assert!(
        styles.contains(r#"<dxfs count="1"><dxf><font><b/><color rgb="FF006600"/></font><fill><patternFill patternType="solid"><fgColor rgb="FFCCFFCC"/><bgColor rgb="FFCCFFCC"/></patternFill></fill></dxf></dxfs>"#),
        "{styles}"
    );
    let mut sessions = WorkbookSessions::new();
    let metadata = sessions.open(&target).unwrap();
    let _ = sessions.close(&metadata.session_id);
}

#[test]
fn repeats_become_column_and_row_styles_and_merges_spread_their_frame() {
    let (_dir, target) = convert(&Package {
        automatic: concat!(
            r##"<style:style style:name="ce1" style:family="table-cell"><style:table-cell-properties fo:background-color="#eeeeee"/></style:style>"##,
            r##"<style:style style:name="ce2" style:family="table-cell"><style:table-cell-properties fo:border="0.75pt solid #000000" fo:background-color="#ffcc00"/></style:style>"##,
            r##"<style:style style:name="ce3" style:family="table-cell"><style:table-cell-properties fo:background-color="#00ccff"/></style:style>"##,
        ),
        body: concat!(
            r#"<table:table table:name="Data"><table:table-column table:number-columns-repeated="16384"/>"#,
            // a merge three wide and two high, framed on its first cell
            r#"<table:table-row><table:table-cell table:style-name="ce2" table:number-columns-spanned="3" table:number-rows-spanned="2" office:value-type="string"><text:p>title</text:p></table:table-cell><table:covered-table-cell table:number-columns-repeated="2"/><table:table-cell table:number-columns-repeated="16381"/></table:table-row>"#,
            r#"<table:table-row><table:covered-table-cell table:number-columns-repeated="3"/><table:table-cell table:number-columns-repeated="16381"/></table:table-row>"#,
            // a row painted from edge to edge
            r#"<table:table-row><table:table-cell table:style-name="ce3" table:number-columns-repeated="16384"/></table:table-row>"#,
            // the empty tail carries the fifth column's look down the sheet
            r#"<table:table-row table:number-rows-repeated="1048573"><table:table-cell table:number-columns-repeated="4"/><table:table-cell table:style-name="ce1"/><table:table-cell table:number-columns-repeated="16379"/></table:table-row>"#,
            r#"</table:table>"#,
        ),
        ..Package::default()
    });
    let sheet = read_entry(&target, "xl/worksheets/sheet1.xml");
    assert!(sheet.len() < 3_000, "repeats are not written cell by cell: {}", sheet.len());
    let cell_style = |reference: &str| -> String {
        sheet
            .split(&format!(r#"<c r="{reference}" s=""#))
            .nth(1)
            .and_then(|rest| rest.split('"').next())
            .unwrap_or_else(|| panic!("{reference} has no style: {sheet}"))
            .to_owned()
    };
    // the tail's style is the column's
    let column = sheet
        .split(r#"<col min="5" max="5" width="8.43" style=""#)
        .nth(1)
        .and_then(|rest| rest.split('"').next())
        .unwrap_or_else(|| panic!("column E has no style: {sheet}"));
    assert_ne!(column, "0");
    // the painted row is a row style
    assert!(sheet.contains(r#"<row r="3" s=""#), "{sheet}");
    // the merge's frame goes onto the covered cells, each with its own edges
    let styles = read_entry(&target, "xl/styles.xml");
    let xf = |index: &str| -> String {
        let cell_xfs = styles.split("<cellXfs").nth(1).unwrap();
        cell_xfs
            .split("<xf ")
            .nth(index.parse::<usize>().unwrap() + 1)
            .unwrap()
            .to_owned()
    };
    let border_of = |index: &str| -> String {
        let id: usize = xf(index)
            .split(r#"borderId=""#)
            .nth(1)
            .and_then(|rest| rest.split('"').next())
            .unwrap()
            .parse()
            .unwrap();
        styles
            .split("<borders")
            .nth(1)
            .unwrap()
            .split("<border>")
            .nth(id + 1)
            .unwrap()
            .split("</border>")
            .next()
            .unwrap()
            .to_owned()
    };
    let top_right = border_of(&cell_style("C1"));
    assert!(top_right.contains(r#"<right style="thin">"#) && top_right.contains(r#"<top style="thin">"#), "{top_right}");
    assert!(top_right.contains("<left/>") && top_right.contains("<bottom/>"), "{top_right}");
    let bottom_middle = border_of(&cell_style("B2"));
    assert!(bottom_middle.contains(r#"<bottom style="thin">"#), "{bottom_middle}");
    assert!(bottom_middle.contains("<left/><right/><top/>"), "{bottom_middle}");
    assert!(sheet.contains(r#"<mergeCell ref="A1:C2"/>"#), "{sheet}");
}
