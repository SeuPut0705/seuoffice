//! Print setup for the `.ods` import: an ODF page layout and master page as
//! the worksheet's `printOptions`, `pageMargins`, `pageSetup` and
//! `headerFooter`.
//!
//! ODF keeps a header as up to three regions of paragraphs with field
//! elements and character styles; Excel keeps one string in its `&`-code
//! language (`&L&D&C&"Arial,Bold"&14Report &P of &N`). The margins differ the
//! same way round: ODF measures the page margin to the header and gives the
//! header its own height, Excel measures the body margin from the paper edge
//! and places the header inside it.

use std::collections::HashMap;

use roxmltree::Node;

use crate::odf_cell_styles::{FontProps, Position, StyleBook, Underline};
use crate::odf_layout::length_points;
use crate::odf_number_format::attribute;
use crate::xlsx_package::escape_xml;

/// Excel's header margin for a sheet that has no header to measure from.
const DEFAULT_HEADER_MARGIN: f64 = 0.3;

#[derive(Clone, Debug, Default)]
struct PageLayout {
    /// Paper size in points.
    width: Option<f64>,
    height: Option<f64>,
    landscape: bool,
    /// Margins in points.
    left: Option<f64>,
    right: Option<f64>,
    top: Option<f64>,
    bottom: Option<f64>,
    header_height: f64,
    footer_height: f64,
    scale: Option<u32>,
    fit_pages: Option<u32>,
    fit_across: Option<u32>,
    fit_down: Option<u32>,
    fits: bool,
    grid: bool,
    headings: bool,
    center_horizontal: bool,
    center_vertical: bool,
    first_page: Option<u32>,
    over_then_down: bool,
}

/// The six texts a master page may carry, already in Excel's code language.
#[derive(Clone, Debug, Default)]
struct MasterPage {
    layout: Option<String>,
    header: Option<String>,
    header_even: Option<String>,
    header_first: Option<String>,
    footer: Option<String>,
    footer_even: Option<String>,
    footer_first: Option<String>,
}

/// The page layouts and master pages of `styles.xml`.
#[derive(Default)]
pub(crate) struct PageBook {
    layouts: HashMap<String, PageLayout>,
    masters: HashMap<String, MasterPage>,
    /// Character styles the header and footer runs point at. These are the
    /// automatic styles of `styles.xml`, a different set from the ones cell
    /// text uses.
    text: HashMap<String, FontProps>,
}

/// What one sheet prints with, as worksheet XML.
#[derive(Debug, Default, PartialEq)]
pub(crate) struct PageXml {
    /// `printOptions`, `pageMargins`, `pageSetup`, `headerFooter`, in the
    /// order the worksheet wants them.
    pub(crate) tail: String,
    /// True when the sheet scales to a page count, which `sheetPr` says.
    pub(crate) fit_to_page: bool,
}

impl PageBook {
    /// Reads the page layouts and the text styles of an
    /// `office:automatic-styles` element.
    pub(crate) fn read_automatic(&mut self, scope: Node<'_, '_>, book: &StyleBook) {
        for node in scope.children().filter(Node::is_element) {
            match node.tag_name().name() {
                "page-layout" => {
                    if let Some(name) = attribute(node, "name") {
                        self.layouts.insert(name.to_owned(), read_layout(node));
                    }
                }
                "style" if attribute(node, "family") == Some("text") => {
                    if let Some(name) = attribute(node, "name") {
                        self.text.insert(name.to_owned(), book.font_props(node));
                    }
                }
                _ => {}
            }
        }
    }

    /// Reads the master pages of an `office:master-styles` element.
    pub(crate) fn read_masters(&mut self, scope: Node<'_, '_>) {
        for node in scope.children().filter(Node::is_element) {
            if node.tag_name().name() != "master-page" {
                continue;
            }
            let Some(name) = attribute(node, "name") else {
                continue;
            };
            let mut master = MasterPage {
                layout: attribute(node, "page-layout-name").map(str::to_owned),
                ..MasterPage::default()
            };
            for band in node.children().filter(Node::is_element) {
                if attribute(band, "display") == Some("false") {
                    continue;
                }
                let text = Some(band_code(band, &self.text)).filter(|text| !text.is_empty());
                match band.tag_name().name() {
                    "header" => master.header = text,
                    "header-left" => master.header_even = text.or(Some(String::new())),
                    "header-first" => master.header_first = text.or(Some(String::new())),
                    "footer" => master.footer = text,
                    "footer-left" => master.footer_even = text.or(Some(String::new())),
                    "footer-first" => master.footer_first = text.or(Some(String::new())),
                    _ => {}
                }
            }
            self.masters.insert(name.to_owned(), master);
        }
    }

    /// The print parts of a sheet whose table style points at this master
    /// page. `None` when the document does not describe the page.
    pub(crate) fn page_xml(&self, master: Option<&str>) -> Option<PageXml> {
        let master = self.masters.get(master?)?;
        let layout = master
            .layout
            .as_deref()
            .and_then(|name| self.layouts.get(name))?;
        let mut tail = String::new();

        let mut options = String::new();
        if layout.center_horizontal {
            options.push_str(r#" horizontalCentered="1""#);
        }
        if layout.center_vertical {
            options.push_str(r#" verticalCentered="1""#);
        }
        if layout.headings {
            options.push_str(r#" headings="1""#);
        }
        if layout.grid {
            options.push_str(r#" gridLines="1""#);
        }
        if !options.is_empty() {
            tail.push_str(&format!("<printOptions{options}/>"));
        }

        let has_header = master.header.is_some()
            || master.header_even.as_ref().is_some_and(|text| !text.is_empty())
            || master.header_first.as_ref().is_some_and(|text| !text.is_empty());
        let has_footer = master.footer.is_some()
            || master.footer_even.as_ref().is_some_and(|text| !text.is_empty())
            || master.footer_first.as_ref().is_some_and(|text| !text.is_empty());
        let inches = |points: Option<f64>, fallback: f64| points.map_or(fallback, |points| points / 72.0);
        let page_top = inches(layout.top, 0.75);
        let page_bottom = inches(layout.bottom, 0.75);
        // With a header the page margin is where the header starts and the
        // body begins below the header's own height.
        let (top, header) = if has_header {
            (page_top + layout.header_height / 72.0, page_top)
        } else {
            (page_top, DEFAULT_HEADER_MARGIN.min(page_top))
        };
        let (bottom, footer) = if has_footer {
            (page_bottom + layout.footer_height / 72.0, page_bottom)
        } else {
            (page_bottom, DEFAULT_HEADER_MARGIN.min(page_bottom))
        };
        tail.push_str(&format!(
            r#"<pageMargins left="{}" right="{}" top="{}" bottom="{}" header="{}" footer="{}"/>"#,
            number(inches(layout.left, 0.7)),
            number(inches(layout.right, 0.7)),
            number(top),
            number(bottom),
            number(header),
            number(footer),
        ));

        let mut setup = String::new();
        if let Some(code) = paper_code(layout) {
            setup.push_str(&format!(r#" paperSize="{code}""#));
        }
        if let Some(scale) = layout.scale.filter(|scale| *scale != 100 && !layout.fits) {
            setup.push_str(&format!(r#" scale="{scale}""#));
        }
        if let Some(first) = layout.first_page {
            setup.push_str(&format!(r#" firstPageNumber="{first}""#));
        }
        if layout.fits {
            let (across, down) = match layout.fit_pages {
                Some(pages) => (1, pages),
                None => (layout.fit_across.unwrap_or(0), layout.fit_down.unwrap_or(0)),
            };
            setup.push_str(&format!(r#" fitToWidth="{across}" fitToHeight="{down}""#));
        }
        if layout.over_then_down {
            setup.push_str(r#" pageOrder="overThenDown""#);
        }
        setup.push_str(if layout.landscape {
            r#" orientation="landscape""#
        } else {
            r#" orientation="portrait""#
        });
        if layout.first_page.is_some() {
            setup.push_str(r#" useFirstPageNumber="1""#);
        }
        tail.push_str(&format!("<pageSetup{setup}/>"));

        if has_header || has_footer {
            let mut attributes = String::new();
            let mut body = String::new();
            let even = master.header_even.is_some() || master.footer_even.is_some();
            let first = master.header_first.is_some() || master.footer_first.is_some();
            if even {
                attributes.push_str(r#" differentOddEven="1""#);
            }
            if first {
                attributes.push_str(r#" differentFirst="1""#);
            }
            for (tag, text) in [
                ("oddHeader", &master.header),
                ("oddFooter", &master.footer),
                ("evenHeader", &master.header_even),
                ("evenFooter", &master.footer_even),
                ("firstHeader", &master.header_first),
                ("firstFooter", &master.footer_first),
            ] {
                if let Some(text) = text.as_ref().filter(|text| !text.is_empty()) {
                    body.push_str(&format!("<{tag}>{}</{tag}>", escape_xml(text)));
                }
            }
            tail.push_str(&format!("<headerFooter{attributes}>{body}</headerFooter>"));
        }
        Some(PageXml {
            tail,
            fit_to_page: layout.fits,
        })
    }
}

/// A measure in inches, without the noise a division leaves behind.
fn number(value: f64) -> String {
    let rounded = (value * 10_000.0).round() / 10_000.0;
    format!("{rounded}")
}

fn read_layout(node: Node<'_, '_>) -> PageLayout {
    let mut layout = PageLayout::default();
    for child in node.children().filter(Node::is_element) {
        match child.tag_name().name() {
            "page-layout-properties" => {
                let length = |name: &str| attribute(child, name).and_then(length_points);
                layout.width = length("page-width");
                layout.height = length("page-height");
                layout.landscape = attribute(child, "print-orientation") == Some("landscape");
                let all = length("margin");
                layout.left = length("margin-left").or(all);
                layout.right = length("margin-right").or(all);
                layout.top = length("margin-top").or(all);
                layout.bottom = length("margin-bottom").or(all);
                layout.scale = attribute(child, "scale-to")
                    .and_then(|value| value.trim().trim_end_matches('%').parse::<f64>().ok())
                    .map(|scale| scale.round() as u32)
                    .filter(|scale| (10..=400).contains(scale));
                let pages = |name: &str| {
                    attribute(child, name).and_then(|value| value.trim().parse::<u32>().ok())
                };
                layout.fit_pages = pages("scale-to-pages").filter(|pages| *pages > 0);
                layout.fit_across = pages("scale-to-X");
                layout.fit_down = pages("scale-to-Y");
                layout.fits = layout.fit_pages.is_some()
                    || layout.fit_across.is_some()
                    || layout.fit_down.is_some();
                if let Some(print) = attribute(child, "print") {
                    layout.grid = print.split_whitespace().any(|token| token == "grid");
                    layout.headings = print.split_whitespace().any(|token| token == "headers");
                }
                match attribute(child, "table-centering") {
                    Some("horizontal") => layout.center_horizontal = true,
                    Some("vertical") => layout.center_vertical = true,
                    Some("both") => {
                        layout.center_horizontal = true;
                        layout.center_vertical = true;
                    }
                    _ => {}
                }
                layout.first_page = pages("first-page-number");
                layout.over_then_down = attribute(child, "print-page-order") == Some("ltr");
            }
            band @ ("header-style" | "footer-style") => {
                let height = child
                    .children()
                    .find(|properties| properties.tag_name().name() == "header-footer-properties")
                    .and_then(|properties| {
                        attribute(properties, "height")
                            .or_else(|| attribute(properties, "min-height"))
                            .and_then(length_points)
                    })
                    .unwrap_or(0.0)
                    .max(0.0);
                if band == "header-style" {
                    layout.header_height = height;
                } else {
                    layout.footer_height = height;
                }
            }
            _ => {}
        }
    }
    layout
}

/// Excel's paper code for a page size, when it is one of the sizes Excel
/// names. Either orientation of the sheet matches.
fn paper_code(layout: &PageLayout) -> Option<u32> {
    let (width, height) = (layout.width? * 25.4 / 72.0, layout.height? * 25.4 / 72.0);
    let (short, long) = if width <= height {
        (width, height)
    } else {
        (height, width)
    };
    const SIZES: [(u32, f64, f64); 9] = [
        (9, 210.0, 297.0),
        (1, 215.9, 279.4),
        (5, 215.9, 355.6),
        (8, 297.0, 420.0),
        (11, 148.0, 210.0),
        (12, 257.0, 364.0),
        (13, 182.0, 257.0),
        (3, 279.4, 431.8),
        (7, 184.15, 266.7),
    ];
    SIZES
        .iter()
        .find(|(_, a, b)| (short - a).abs() < 1.5 && (long - b).abs() < 1.5)
        .map(|(code, _, _)| *code)
}

/// The formatting codes in force while a header section is written. Excel's
/// codes for underline and the like are switches, so the writer has to know
/// what is on.
#[derive(Default)]
struct RunState {
    font: Option<String>,
    size: Option<u32>,
    underline: bool,
    double: bool,
    strike: bool,
    superscript: bool,
    subscript: bool,
    color: Option<String>,
}

/// One `style:header` (or footer) element as `&L…&C…&R…`.
fn band_code(band: Node<'_, '_>, styles: &HashMap<String, FontProps>) -> String {
    let mut out = String::new();
    let mut loose: Vec<Node<'_, '_>> = Vec::new();
    for child in band.children().filter(Node::is_element) {
        let section = match child.tag_name().name() {
            "region-left" => "&L",
            "region-center" => "&C",
            "region-right" => "&R",
            "p" => {
                loose.push(child);
                continue;
            }
            _ => continue,
        };
        let paragraphs: Vec<Node<'_, '_>> = child
            .children()
            .filter(|node| node.tag_name().name() == "p")
            .collect();
        let text = paragraphs_code(&paragraphs, styles);
        if !text.is_empty() {
            out.push_str(section);
            out.push_str(&text);
        }
    }
    // Paragraphs outside a region are the band's centred text.
    if out.is_empty() && !loose.is_empty() {
        let text = paragraphs_code(&loose, styles);
        if !text.is_empty() {
            out.push_str("&C");
            out.push_str(&text);
        }
    }
    out
}

fn paragraphs_code(paragraphs: &[Node<'_, '_>], styles: &HashMap<String, FontProps>) -> String {
    let mut out = String::new();
    let mut state = RunState::default();
    for (index, paragraph) in paragraphs.iter().enumerate() {
        if index > 0 {
            out.push('\n');
        }
        inline_code(*paragraph, None, styles, &mut state, &mut out);
    }
    // A band that holds only line breaks holds nothing.
    if out.trim().is_empty() { String::new() } else { out }
}

fn inline_code(
    node: Node<'_, '_>,
    style: Option<&FontProps>,
    styles: &HashMap<String, FontProps>,
    state: &mut RunState,
    out: &mut String,
) {
    for child in node.children() {
        if child.is_text() {
            let text = child.text().unwrap_or("");
            if text.is_empty() {
                continue;
            }
            switch_look(style, state, out);
            // A size code swallows digits that follow it.
            if out.ends_with(|last: char| last.is_ascii_digit())
                && text.starts_with(|first: char| first.is_ascii_digit())
                && size_code_at_end(out)
            {
                out.push(' ');
            }
            out.push_str(&text.replace('&', "&&"));
            continue;
        }
        if !child.is_element() {
            continue;
        }
        let field = match child.tag_name().name() {
            "span" => {
                let inner = attribute(child, "style-name")
                    .and_then(|name| styles.get(name))
                    .or(style);
                inline_code(child, inner, styles, state, out);
                continue;
            }
            "a" => {
                inline_code(child, style, styles, state, out);
                continue;
            }
            "page-number" => "&P",
            "page-count" => "&N",
            "date" => "&D",
            "time" => "&T",
            "sheet-name" => "&A",
            "title" => "&F",
            "file-name" => match attribute(child, "display") {
                Some("path") => "&Z",
                Some("full") => "&Z&F",
                _ => "&F",
            },
            "s" => {
                let spaces = attribute(child, "c")
                    .and_then(|value| value.parse::<usize>().ok())
                    .unwrap_or(1)
                    .min(1000);
                out.push_str(&" ".repeat(spaces));
                continue;
            }
            "tab" => {
                out.push('\t');
                continue;
            }
            "line-break" => {
                out.push('\n');
                continue;
            }
            _ => continue,
        };
        switch_look(style, state, out);
        out.push_str(field);
    }
}

/// True when the text ends in a size code (`&12`) rather than in digits the
/// header shows.
fn size_code_at_end(text: &str) -> bool {
    let digits = text.chars().rev().take_while(char::is_ascii_digit).count();
    text[..text.len() - digits].ends_with('&') && !text[..text.len() - digits].ends_with("&&")
}

/// Emits the codes that take the running look to the one this run wants.
fn switch_look(style: Option<&FontProps>, state: &mut RunState, out: &mut String) {
    let plain = FontProps::default();
    let style = style.unwrap_or(&plain);
    let face = {
        let bold = style.bold == Some(true);
        let italic = style.italic == Some(true);
        let weight = match (bold, italic) {
            (true, true) => "Bold Italic",
            (true, false) => "Bold",
            (false, true) => "Italic",
            (false, false) => "Regular",
        };
        if style.name.is_some() || bold || italic || state.font.is_some() {
            Some(format!(
                "{},{weight}",
                style.name.as_deref().unwrap_or("-").replace('"', "")
            ))
        } else {
            None
        }
    };
    if face.is_some() && face != state.font {
        out.push_str(&format!("&\"{}\"", face.as_deref().unwrap_or("-,Regular")));
        state.font = face;
    }
    let size = style.size.map(|size| size.round() as u32).filter(|size| (1..=409).contains(size));
    if size.is_some() && size != state.size {
        out.push_str(&format!("&{}", size.unwrap_or(11)));
        state.size = size;
    }
    let double = style.underline == Some(Underline::Double);
    let single = style.underline == Some(Underline::Single);
    if single != state.underline {
        out.push_str("&U");
        state.underline = single;
    }
    if double != state.double {
        out.push_str("&E");
        state.double = double;
    }
    let strike = style.strike == Some(true);
    if strike != state.strike {
        out.push_str("&S");
        state.strike = strike;
    }
    let superscript = style.position == Some(Position::Super);
    if superscript != state.superscript {
        out.push_str("&X");
        state.superscript = superscript;
    }
    let subscript = style.position == Some(Position::Sub);
    if subscript != state.subscript {
        out.push_str("&Y");
        state.subscript = subscript;
    }
    let color = style.color.clone().flatten();
    if color.is_some() && color != state.color {
        out.push_str(&format!("&K{}", color.as_deref().unwrap_or("000000")));
        state.color = color;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NS: &str = r#"xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0""#;

    fn pages(automatic: &str, masters: &str) -> PageBook {
        let xml = format!(
            "<office:document-styles {NS}><office:automatic-styles>{automatic}</office:automatic-styles><office:master-styles>{masters}</office:master-styles></office:document-styles>"
        );
        let document = roxmltree::Document::parse(&xml).unwrap();
        let book = StyleBook::default();
        let mut pages = PageBook::default();
        for scope in document.root_element().children().filter(Node::is_element) {
            match scope.tag_name().name() {
                "automatic-styles" => pages.read_automatic(scope, &book),
                "master-styles" => pages.read_masters(scope),
                _ => {}
            }
        }
        pages
    }

    #[test]
    fn a_page_layout_becomes_margins_setup_and_header_codes() {
        let pages = pages(
            concat!(
                r#"<style:style style:name="MT1" style:family="text"><style:text-properties fo:font-weight="bold" fo:font-size="14pt" style:font-name="Arial"/></style:style>"#,
                r#"<style:page-layout style:name="pm1"><style:page-layout-properties fo:page-width="29.700cm" fo:page-height="21.000cm" style:print-orientation="landscape" fo:margin-left="0.5in" fo:margin-right="0.5in" fo:margin-top="0.3in" fo:margin-bottom="0.75in" style:scale-to-X="1" style:print="charts grid headers" style:table-centering="horizontal" style:first-page-number="3" style:print-page-order="ltr"/><style:header-style><style:header-footer-properties svg:height="0.45in" fo:margin-bottom="0in"/></style:header-style><style:footer-style><style:header-footer-properties svg:height="0in"/></style:footer-style></style:page-layout>"#,
            ),
            concat!(
                r#"<style:master-page style:name="m1" style:page-layout-name="pm1">"#,
                r#"<style:header><style:region-left><text:p><text:date/> <text:time/></text:p></style:region-left><style:region-center><text:p><text:span text:style-name="MT1">Report </text:span><text:span text:style-name="MT1"><text:page-number>1</text:page-number></text:span> of <text:page-count>1</text:page-count></text:p></style:region-center><style:region-right><text:p>A &amp; B</text:p><text:p><text:sheet-name>?</text:sheet-name></text:p></style:region-right></style:header>"#,
                r#"<style:header-left style:display="false"/><style:footer style:display="false"/><style:footer-left style:display="false"/>"#,
                r#"</style:master-page>"#,
            ),
        );
        let page = pages.page_xml(Some("m1")).unwrap();
        assert!(page.fit_to_page);
        assert!(
            page.tail.starts_with(r#"<printOptions horizontalCentered="1" headings="1" gridLines="1"/>"#),
            "{}",
            page.tail
        );
        assert!(
            page.tail.contains(r#"<pageMargins left="0.5" right="0.5" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>"#),
            "{}",
            page.tail
        );
        assert!(
            page.tail.contains(r#"<pageSetup paperSize="9" firstPageNumber="3" fitToWidth="1" fitToHeight="0" pageOrder="overThenDown" orientation="landscape" useFirstPageNumber="1"/>"#),
            "{}",
            page.tail
        );
        assert!(
            page.tail.contains("<headerFooter><oddHeader>&amp;L&amp;D &amp;T&amp;C&amp;&quot;Arial,Bold&quot;&amp;14Report &amp;P&amp;&quot;-,Regular&quot; of &amp;N&amp;RA &amp;&amp; B\n&amp;A</oddHeader></headerFooter>"),
            "{}",
            page.tail
        );
        assert_eq!(pages.page_xml(Some("nope")), None);
    }

    #[test]
    fn loose_paragraphs_are_centred_and_sizes_keep_clear_of_digits() {
        let pages = pages(
            concat!(
                r#"<style:style style:name="T1" style:family="text"><style:text-properties fo:font-size="9pt"/></style:style>"#,
                r#"<style:page-layout style:name="pm1"><style:page-layout-properties fo:margin="2cm"/></style:page-layout>"#,
            ),
            r#"<style:master-page style:name="Default" style:page-layout-name="pm1"><style:header><text:p><text:span text:style-name="T1">2026 plan</text:span></text:p></style:header><style:footer><text:p>Page <text:page-number/></text:p></style:footer></style:master-page>"#,
        );
        let page = pages.page_xml(Some("Default")).unwrap();
        assert!(page.tail.contains("<oddHeader>&amp;C&amp;9 2026 plan</oddHeader>"), "{}", page.tail);
        assert!(page.tail.contains("<oddFooter>&amp;CPage &amp;P</oddFooter>"), "{}", page.tail);
        assert!(!page.fit_to_page);
        assert!(page.tail.contains(r#"<pageSetup orientation="portrait"/>"#), "{}", page.tail);
    }
}
