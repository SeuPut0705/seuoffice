//! Print settings for the `.ods` export: page layouts, master pages and the
//! header/footer text Excel keeps in its own `&`-code language.
//!
//! Excel stores a sheet's header as one string — `&L&D&C&"Arial,Bold"&14Report
//! &P of &N` — where `&L`/`&C`/`&R` switch the section and the other codes are
//! fields or formatting. ODF wants three regions of paragraphs with field
//! elements and text styles. A page style without a header has to say so as
//! well: a reader that finds no header element assumes its own default one,
//! which pushes the sheet down the page.

use std::collections::HashMap;
use std::fs::File;
use std::io::Read;
use std::path::Path;

use quick_xml::Reader;
use quick_xml::events::{BytesStart, Event};
use zip::ZipArchive;

use crate::ods_styles::StyleRegistry;
use crate::xlsx_package::escape_xml;
use crate::PagePrintInfo;

/// Excel's default margins, in inches, for a sheet that declares none.
const DEFAULT_SIDE_MARGIN: f64 = 0.7;
const DEFAULT_EDGE_MARGIN: f64 = 0.75;
const DEFAULT_HEADER_MARGIN: f64 = 0.3;

/// Print settings the editor's model does not read, taken straight from the
/// worksheet part: centring on the page, the first page number, the order
/// pages are numbered in, and whether notes print.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(crate) struct PrintExtras {
    pub(crate) center_horizontal: bool,
    pub(crate) center_vertical: bool,
    pub(crate) first_page_number: Option<u32>,
    pub(crate) over_then_down: bool,
    pub(crate) notes: bool,
}

/// How much of a worksheet part is kept after `</sheetData>`. The print
/// elements sit there, behind the merges, rules and links; a tail larger than
/// this is cut and the extras fall back to their defaults.
const MAX_TAIL_BYTES: usize = 64 * 1024 * 1024;

/// Reads the extras of one worksheet part.
#[cfg(test)]
fn read_print_extras(source: &Path, worksheet_path: &str) -> PrintExtras {
    let Some(tail) = worksheet_tail(source, worksheet_path) else {
        return PrintExtras::default();
    };
    parse_print_extras(&tail)
}

/// Everything after the sheet data, without parsing the cells a second time:
/// the part is inflated in chunks and only searched for the end of
/// `sheetData`. `None` when the part cannot be read or its tail is too large;
/// what is read from the tail refines the export and must not fail it.
pub(crate) fn worksheet_tail(source: &Path, worksheet_path: &str) -> Option<Vec<u8>> {
    let mut archive = ZipArchive::new(File::open(source).ok()?).ok()?;
    let mut entry = archive.by_name(worksheet_path).ok()?;
    const NAME: &[u8] = b"sheetData";
    let mut chunk = vec![0u8; 64 * 1024];
    // Bytes carried over so a name split across two chunks is still found.
    let mut window: Vec<u8> = Vec::new();
    let mut seen = 0;
    let mut tail: Option<Vec<u8>> = None;
    loop {
        let read = entry.read(&mut chunk).ok()?;
        if read == 0 {
            break;
        }
        if let Some(tail) = tail.as_mut() {
            if tail.len() + read > MAX_TAIL_BYTES {
                return None;
            }
            tail.extend_from_slice(&chunk[..read]);
            continue;
        }
        window.extend_from_slice(&chunk[..read]);
        let mut from = 0;
        while let Some(found) = window[from..]
            .windows(NAME.len())
            .position(|candidate| candidate == NAME)
        {
            let after = from + found + NAME.len();
            let Some(next) = window.get(after) else {
                // The byte that tells an empty element from an opening tag is
                // in the next chunk.
                break;
            };
            from = after;
            seen += 1;
            // `<sheetData/>` ends the data at once; otherwise the second
            // mention of the name is the closing tag.
            if *next == b'/' || seen == 2 {
                tail = Some(window[after..].to_vec());
                break;
            }
        }
        if tail.is_none() {
            let keep = window.len().saturating_sub(from).min(NAME.len() + 1);
            let start = window.len() - keep;
            window.drain(..start);
        }
    }
    tail
}

pub(crate) fn parse_print_extras(tail: &[u8]) -> PrintExtras {
    let mut extras = PrintExtras::default();
    let mut reader = Reader::from_reader(tail);
    // The tail starts in the middle of the document, so its end tags have no
    // start tags to match.
    reader.config_mut().check_end_names = false;
    reader.config_mut().allow_unmatched_ends = true;
    let mut buffer = Vec::new();
    let mut custom_views = 0usize;
    let flag = |element: &BytesStart<'_>, name: &[u8]| {
        attribute(element, name).is_some_and(|value| value == "1" || value == "true")
    };
    loop {
        let event = match reader.read_event_into(&mut buffer) {
            Ok(Event::Eof) | Err(_) => break,
            Ok(event) => event,
        };
        match &event {
            // A custom view carries its own print settings; only the sheet's
            // own count.
            Event::Start(element) if element.local_name().as_ref() == b"customSheetViews" => {
                custom_views += 1;
            }
            Event::End(element) if element.local_name().as_ref() == b"customSheetViews" => {
                custom_views = custom_views.saturating_sub(1);
            }
            Event::Start(element) | Event::Empty(element) if custom_views == 0 => {
                match element.local_name().as_ref() {
                    b"printOptions" => {
                        extras.center_horizontal = flag(element, b"horizontalCentered");
                        extras.center_vertical = flag(element, b"verticalCentered");
                    }
                    b"pageSetup" => {
                        if flag(element, b"useFirstPageNumber") {
                            extras.first_page_number = attribute(element, b"firstPageNumber")
                                .and_then(|value| value.parse::<u32>().ok())
                                .filter(|value| *value >= 1);
                        }
                        extras.over_then_down = attribute(element, b"pageOrder")
                            .is_some_and(|value| value == "overThenDown");
                        extras.notes = attribute(element, b"cellComments")
                            .is_some_and(|value| value == "atEnd" || value == "asDisplayed");
                    }
                    _ => {}
                }
            }
            _ => {}
        }
        buffer.clear();
    }
    extras
}

fn attribute(element: &BytesStart<'_>, name: &[u8]) -> Option<String> {
    element
        .attributes()
        .flatten()
        .find(|attribute| attribute.key.local_name().as_ref() == name)
        // Flags, numbers and enumerated words: nothing here needs unescaping.
        .map(|attribute| String::from_utf8_lossy(&attribute.value).into_owned())
}

/// Page layouts and master pages for the sheets, deduplicated: sheets with the
/// same print setup share one.
#[derive(Default)]
pub(crate) struct PageStyles {
    pub(crate) layouts: String,
    pub(crate) masters: String,
    /// `text` styles the header and footer runs point at.
    pub(crate) text_styles: String,
    text_names: HashMap<String, String>,
    seen: Vec<(String, String)>,
    counter: usize,
}

impl PageStyles {
    /// Registers a sheet's print setup and returns the master page name its
    /// table style points at.
    pub(crate) fn register(
        &mut self,
        setup: Option<&PagePrintInfo>,
        extras: PrintExtras,
        registry: &mut StyleRegistry,
    ) -> String {
        let key = match setup {
            Some(setup) => format!("{setup:?}{extras:?}"),
            None => format!("default{extras:?}"),
        };
        if let Some((_, master)) = self.seen.iter().find(|(entry, _)| *entry == key) {
            return master.clone();
        }
        self.counter += 1;
        let layout = format!("pm{}", self.counter);
        let master = format!("m{}", self.counter);

        let (width, height) = paper_size(setup.and_then(|setup| setup.paper_size));
        let orientation = setup
            .and_then(|setup| setup.orientation.as_deref())
            .filter(|value| *value == "landscape")
            .unwrap_or("portrait");
        let (width, height) = if orientation == "landscape" {
            (height, width)
        } else {
            (width, height)
        };
        let margins = setup.and_then(|setup| setup.margins);
        let left = margins.map_or(DEFAULT_SIDE_MARGIN, |margins| margins.left.max(0.0));
        let right = margins.map_or(DEFAULT_SIDE_MARGIN, |margins| margins.right.max(0.0));
        let top = margins.map_or(DEFAULT_EDGE_MARGIN, |margins| margins.top.max(0.0));
        let bottom = margins.map_or(DEFAULT_EDGE_MARGIN, |margins| margins.bottom.max(0.0));
        let header_margin = margins.map_or(DEFAULT_HEADER_MARGIN, |margins| margins.header.max(0.0));
        let footer_margin = margins.map_or(DEFAULT_HEADER_MARGIN, |margins| margins.footer.max(0.0));

        let header = setup.map(|setup| Band::header(setup)).unwrap_or_default();
        let footer = setup.map(|setup| Band::footer(setup)).unwrap_or_default();

        // Excel measures the body margin from the paper edge and puts the
        // header inside it; ODF measures the page margin to the header and
        // gives the header its own height below that. The body starts at the
        // same place either way.
        let (page_top, header_height) = split_margin(top, header_margin, header.shown());
        let (page_bottom, footer_height) = split_margin(bottom, footer_margin, footer.shown());

        let mut properties = format!(
            r#" fo:page-width="{width:.3}cm" fo:page-height="{height:.3}cm" style:print-orientation="{orientation}" fo:margin-left="{left:.4}in" fo:margin-right="{right:.4}in" fo:margin-top="{page_top:.4}in" fo:margin-bottom="{page_bottom:.4}in" style:print-page-order="{}""#,
            // Excel numbers pages down a column of pages first unless told
            // to go across.
            if extras.over_then_down { "ltr" } else { "ttb" }
        );
        match (extras.center_horizontal, extras.center_vertical) {
            (true, true) => properties.push_str(r#" style:table-centering="both""#),
            (true, false) => properties.push_str(r#" style:table-centering="horizontal""#),
            (false, true) => properties.push_str(r#" style:table-centering="vertical""#),
            (false, false) => {}
        }
        // Left unsaid, a reader starts every sheet at page one; Excel carries
        // the count on from the sheet before.
        match extras.first_page_number {
            Some(number) => {
                properties.push_str(&format!(r#" style:first-page-number="{number}""#))
            }
            None => properties.push_str(r#" style:first-page-number="continue""#),
        }
        if let Some(setup) = setup {
            if setup.fit_to_page {
                // Excel's absent count means one page; zero means "as many as
                // it takes", which ODF says by leaving the axis out.
                let across = setup.fit_to_width.unwrap_or(1);
                let down = setup.fit_to_height.unwrap_or(1);
                if across > 0 {
                    properties.push_str(&format!(r#" style:scale-to-X="{across}""#));
                }
                if down > 0 {
                    properties.push_str(&format!(r#" style:scale-to-Y="{down}""#));
                }
            } else if let Some(scale) = setup.scale.filter(|scale| (10..=400).contains(scale)) {
                properties.push_str(&format!(r#" style:scale-to="{scale}%""#));
            }
        }
        let mut print = String::from("charts drawings objects zero-values");
        if setup.is_some_and(|setup| setup.print_gridlines) {
            print.push_str(" grid");
        }
        if setup.is_some_and(|setup| setup.print_headings) {
            print.push_str(" headers");
        }
        if extras.notes {
            print.push_str(" annotations");
        }
        properties.push_str(&format!(r#" style:print="{print}""#));

        self.layouts.push_str(&format!(
            r#"<style:page-layout style:name="{layout}"><style:page-layout-properties{properties}/>{}{}</style:page-layout>"#,
            band_style("style:header-style", "fo:margin-bottom", header_height),
            band_style("style:footer-style", "fo:margin-top", footer_height),
        ));

        let mut content = String::new();
        content.push_str(&self.band_xml("style:header", &header, registry));
        content.push_str(&self.band_xml("style:footer", &footer, registry));
        self.masters.push_str(&format!(
            r#"<style:master-page style:name="{master}" style:page-layout-name="{layout}">{content}</style:master-page>"#
        ));
        self.seen.push((key, master.clone()));
        master
    }

    /// One band (header or footer) with its even-page and first-page variants.
    fn band_xml(&mut self, element: &str, band: &Band, registry: &mut StyleRegistry) -> String {
        let mut out = String::new();
        if !band.shown() {
            return format!(
                r#"<{element} style:display="false"/><{element}-left style:display="false"/><{element}-first style:display="false"/>"#
            );
        }
        out.push_str(&format!(
            "<{element}>{}</{element}>",
            self.regions_xml(band.odd.as_deref().unwrap_or(""), registry)
        ));
        match &band.even {
            Some(text) => out.push_str(&format!(
                "<{element}-left>{}</{element}-left>",
                self.regions_xml(text, registry)
            )),
            None => out.push_str(&format!(r#"<{element}-left style:display="false"/>"#)),
        }
        match &band.first {
            Some(text) => out.push_str(&format!(
                "<{element}-first>{}</{element}-first>",
                self.regions_xml(text, registry)
            )),
            None => out.push_str(&format!(r#"<{element}-first style:display="false"/>"#)),
        }
        out
    }

    fn regions_xml(&mut self, text: &str, registry: &mut StyleRegistry) -> String {
        let sections = parse_header(text);
        let mut out = String::new();
        for (element, runs) in [
            ("style:region-left", &sections.left),
            ("style:region-center", &sections.center),
            ("style:region-right", &sections.right),
        ] {
            out.push_str(&format!(
                "<{element}>{}</{element}>",
                self.paragraphs_xml(runs, registry)
            ));
        }
        out
    }

    fn paragraphs_xml(&mut self, runs: &[Run], registry: &mut StyleRegistry) -> String {
        let mut out = String::from("<text:p>");
        for run in runs {
            let style = self.text_style(&run.look, registry);
            for piece in &run.pieces {
                let xml = match piece {
                    Piece::Text(text) => escape_xml(text),
                    Piece::Field(field) => (*field).to_owned(),
                    Piece::Break => {
                        out.push_str("</text:p><text:p>");
                        continue;
                    }
                };
                match &style {
                    Some(name) => out.push_str(&format!(
                        r#"<text:span text:style-name="{name}">{xml}</text:span>"#
                    )),
                    None => out.push_str(&xml),
                }
            }
        }
        out.push_str("</text:p>");
        out
    }

    fn text_style(&mut self, look: &Look, registry: &mut StyleRegistry) -> Option<String> {
        let mut properties = String::new();
        if let Some(family) = &look.family {
            registry.declare_font(family);
            let family = escape_xml(family);
            properties.push_str(&format!(
                r#" style:font-name="{family}" style:font-name-asian="{family}" style:font-name-complex="{family}""#
            ));
        }
        if let Some(size) = look.size {
            properties.push_str(&format!(
                r#" fo:font-size="{size}pt" style:font-size-asian="{size}pt" style:font-size-complex="{size}pt""#
            ));
        }
        if look.bold {
            properties.push_str(
                r#" fo:font-weight="bold" style:font-weight-asian="bold" style:font-weight-complex="bold""#,
            );
        }
        if look.italic {
            properties.push_str(
                r#" fo:font-style="italic" style:font-style-asian="italic" style:font-style-complex="italic""#,
            );
        }
        if look.underline || look.double_underline {
            properties.push_str(&format!(
                r#" style:text-underline-style="solid" style:text-underline-type="{}" style:text-underline-width="auto" style:text-underline-color="font-color""#,
                if look.double_underline { "double" } else { "single" }
            ));
        }
        if look.strike {
            properties.push_str(
                r#" style:text-line-through-style="solid" style:text-line-through-type="single""#,
            );
        }
        if look.superscript {
            properties.push_str(r#" style:text-position="super 58%""#);
        } else if look.subscript {
            properties.push_str(r#" style:text-position="sub 58%""#);
        }
        if let Some(color) = &look.color {
            properties.push_str(&format!(r#" fo:color="{}""#, escape_xml(color)));
        }
        if properties.is_empty() {
            return None;
        }
        if let Some(name) = self.text_names.get(&properties) {
            return Some(name.clone());
        }
        let name = format!("MT{}", self.text_names.len() + 1);
        self.text_styles.push_str(&format!(
            r#"<style:style style:name="{name}" style:family="text"><style:text-properties{properties}/></style:style>"#
        ));
        self.text_names.insert(properties, name.clone());
        Some(name)
    }
}

/// `(page margin, band height)` in inches. With no band the page margin is the
/// whole of Excel's body margin.
fn split_margin(body: f64, band: f64, shown: bool) -> (f64, f64) {
    if !shown || band >= body {
        return (body, 0.0);
    }
    (band, body - band)
}

fn band_style(element: &str, spacing: &str, height: f64) -> String {
    format!(
        r#"<{element}><style:header-footer-properties svg:height="{height:.4}in" fo:margin-left="0in" fo:margin-right="0in" {spacing}="0in"/></{element}>"#
    )
}

/// The texts of one band. `even` and `first` are only present when the sheet
/// says those pages differ.
#[derive(Default)]
struct Band {
    odd: Option<String>,
    even: Option<String>,
    first: Option<String>,
}

impl Band {
    fn header(setup: &PagePrintInfo) -> Self {
        Self::new(setup, &setup.odd_header, &setup.even_header, &setup.first_header)
    }

    fn footer(setup: &PagePrintInfo) -> Self {
        Self::new(setup, &setup.odd_footer, &setup.even_footer, &setup.first_footer)
    }

    fn new(
        setup: &PagePrintInfo,
        odd: &Option<String>,
        even: &Option<String>,
        first: &Option<String>,
    ) -> Self {
        let filled = |text: &Option<String>| text.clone().filter(|text| !text.is_empty());
        Self {
            odd: filled(odd),
            // A sheet that says even pages differ but gives them no text
            // prints an empty band there, which is still a difference.
            even: setup
                .different_odd_even
                .then(|| even.clone().unwrap_or_default()),
            first: setup
                .different_first
                .then(|| first.clone().unwrap_or_default()),
        }
    }

    fn shown(&self) -> bool {
        let filled = |text: &Option<String>| text.as_ref().is_some_and(|text| !text.is_empty());
        filled(&self.odd) || filled(&self.even) || filled(&self.first)
    }
}

/// Formatting an Excel header code turns on for the text that follows it.
#[derive(Clone, Default, PartialEq)]
struct Look {
    family: Option<String>,
    size: Option<u32>,
    bold: bool,
    italic: bool,
    underline: bool,
    double_underline: bool,
    strike: bool,
    superscript: bool,
    subscript: bool,
    color: Option<String>,
}

enum Piece {
    Text(String),
    Field(&'static str),
    Break,
}

struct Run {
    look: Look,
    pieces: Vec<Piece>,
}

#[derive(Default)]
struct Sections {
    left: Vec<Run>,
    center: Vec<Run>,
    right: Vec<Run>,
}

/// Splits an Excel header string into its three sections. Text ahead of the
/// first section code belongs to the centre, as Excel prints it.
fn parse_header(text: &str) -> Sections {
    let mut sections = Sections::default();
    let mut target = 1usize;
    let mut look = Look::default();
    let mut buffer = String::new();
    let mut pieces: Vec<Piece> = Vec::new();
    let characters: Vec<char> = text.chars().collect();
    let mut index = 0;

    fn flush_text(buffer: &mut String, pieces: &mut Vec<Piece>) {
        if !buffer.is_empty() {
            pieces.push(Piece::Text(std::mem::take(buffer)));
        }
    }
    fn flush_run(sections: &mut Sections, target: usize, look: &Look, pieces: &mut Vec<Piece>) {
        if pieces.is_empty() {
            return;
        }
        let run = Run {
            look: look.clone(),
            pieces: std::mem::take(pieces),
        };
        match target {
            0 => sections.left.push(run),
            1 => sections.center.push(run),
            _ => sections.right.push(run),
        }
    }

    while index < characters.len() {
        let character = characters[index];
        index += 1;
        if character == '\n' {
            flush_text(&mut buffer, &mut pieces);
            pieces.push(Piece::Break);
            continue;
        }
        if character == '\r' {
            continue;
        }
        if character != '&' {
            buffer.push(character);
            continue;
        }
        let Some(code) = characters.get(index).copied() else {
            break;
        };
        index += 1;
        // A code that changes the look ends the run in front of it.
        let mut next = look.clone();
        let mut field: Option<&'static str> = None;
        match code {
            '&' => {
                buffer.push('&');
                continue;
            }
            'L' | 'C' | 'R' => {
                flush_text(&mut buffer, &mut pieces);
                flush_run(&mut sections, target, &look, &mut pieces);
                target = match code {
                    'L' => 0,
                    'C' => 1,
                    _ => 2,
                };
                look = Look::default();
                continue;
            }
            'P' => field = Some("<text:page-number>1</text:page-number>"),
            'N' => field = Some("<text:page-count>1</text:page-count>"),
            'D' => field = Some("<text:date/>"),
            'T' => field = Some("<text:time/>"),
            'A' => field = Some("<text:sheet-name>?</text:sheet-name>"),
            'F' => {
                field = Some(r#"<text:file-name text:display="name-and-extension">?</text:file-name>"#)
            }
            'Z' => field = Some(r#"<text:file-name text:display="path">?</text:file-name>"#),
            // A picture: nothing this export carries.
            'G' => continue,
            'B' => next.bold = !next.bold,
            'I' => next.italic = !next.italic,
            'U' => {
                next.underline = !next.underline;
                next.double_underline = false;
            }
            'E' => {
                next.double_underline = !next.double_underline;
                next.underline = false;
            }
            'S' => next.strike = !next.strike,
            'X' => {
                next.superscript = !next.superscript;
                next.subscript = false;
            }
            'Y' => {
                next.subscript = !next.subscript;
                next.superscript = false;
            }
            'K' => {
                let value: String = characters[index..].iter().take(6).collect();
                if value.len() == 6 && value.chars().all(|ch| ch.is_ascii_hexdigit()) {
                    next.color = Some(format!("#{}", value.to_ascii_uppercase()));
                    index += 6;
                } else {
                    // A theme colour (`&K01+000`): skipped, with its digits.
                    index += characters[index..]
                        .iter()
                        .take(6)
                        .take_while(|ch| ch.is_ascii_digit() || matches!(ch, '+' | '-'))
                        .count();
                }
            }
            '"' => {
                let mut name = String::new();
                while let Some(ch) = characters.get(index).copied() {
                    index += 1;
                    if ch == '"' {
                        break;
                    }
                    name.push(ch);
                }
                let (family, style) = name.split_once(',').unwrap_or((name.as_str(), ""));
                let family = family.trim();
                next.family = (!family.is_empty() && family != "-").then(|| family.to_owned());
                let style = style.to_ascii_lowercase();
                next.bold = style.contains("bold");
                next.italic = style.contains("italic") || style.contains("oblique");
            }
            digit if digit.is_ascii_digit() => {
                let mut size = digit.to_digit(10).unwrap_or(0);
                let mut taken = 1;
                while let Some(more) = characters.get(index).and_then(|ch| ch.to_digit(10)) {
                    if taken == 3 {
                        break;
                    }
                    size = size * 10 + more;
                    index += 1;
                    taken += 1;
                }
                next.size = (size > 0).then_some(size);
            }
            other => {
                // An unknown code prints as it was typed.
                buffer.push('&');
                buffer.push(other);
                continue;
            }
        }
        if let Some(field) = field {
            flush_text(&mut buffer, &mut pieces);
            pieces.push(Piece::Field(field));
            continue;
        }
        if next != look {
            flush_text(&mut buffer, &mut pieces);
            flush_run(&mut sections, target, &look, &mut pieces);
            look = next;
        }
    }
    flush_text(&mut buffer, &mut pieces);
    flush_run(&mut sections, target, &look, &mut pieces);
    sections
}

/// Paper size in centimetres for an Excel `paperSize` code; A4 when the code
/// is one this table does not know.
fn paper_size(code: Option<u32>) -> (f64, f64) {
    match code {
        Some(1) => (21.59, 27.94),  // Letter
        Some(3) => (27.94, 43.18),  // Tabloid
        Some(5) => (21.59, 35.56),  // Legal
        Some(7) => (18.415, 26.67), // Executive
        Some(8) => (29.7, 42.0),    // A3
        Some(11) => (14.8, 21.0),   // A5
        Some(12) => (25.7, 36.4),   // B4 (JIS)
        Some(13) => (18.2, 25.7),   // B5 (JIS)
        _ => (21.0, 29.7),          // A4
    }
}

/// The rows and columns a sheet repeats on every printed page, as 0-based
/// inclusive spans, read from its `_xlnm.Print_Titles` formula
/// (`Data!$1:$2,Data!$A:$B`).
pub(crate) fn print_titles(formula: Option<&str>) -> (Option<(usize, usize)>, Option<(usize, usize)>) {
    let mut rows = None;
    let mut columns = None;
    let Some(formula) = formula else {
        return (rows, columns);
    };
    for part in split_outside_quotes(formula, ',') {
        let address = match part.rfind('!') {
            Some(position) => &part[position + 1..],
            None => part,
        };
        let address = address.replace('$', "");
        let Some((first, second)) = address.split_once(':') else {
            continue;
        };
        if let (Ok(first), Ok(second)) = (first.parse::<usize>(), second.parse::<usize>()) {
            if first >= 1 && second >= first {
                rows = Some((first - 1, second - 1));
            }
        } else if let (Some(first), Some(second)) = (column_index(first), column_index(second)) {
            if second >= first {
                columns = Some((first, second));
            }
        }
    }
    (rows, columns)
}

pub(crate) fn split_outside_quotes(text: &str, separator: char) -> Vec<&str> {
    let mut parts = Vec::new();
    let mut quoted = false;
    let mut start = 0;
    for (index, character) in text.char_indices() {
        if character == '\'' {
            quoted = !quoted;
        } else if character == separator && !quoted {
            parts.push(text[start..index].trim());
            start = index + character.len_utf8();
        }
    }
    parts.push(text[start..].trim());
    parts
}

/// `A` → 0, `AB` → 27; `None` for anything that is not a column name.
fn column_index(name: &str) -> Option<usize> {
    if name.is_empty() || name.len() > 3 || !name.chars().all(|ch| ch.is_ascii_alphabetic()) {
        return None;
    }
    let number = name.chars().fold(0usize, |total, ch| {
        total * 26 + (ch.to_ascii_uppercase() as usize - 'A' as usize + 1)
    });
    Some(number - 1)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{CellStyle, PageMarginsInfo};

    fn registered(setup: &PagePrintInfo) -> PageStyles {
        let mut pages = PageStyles::default();
        let mut registry = StyleRegistry::new(CellStyle::default());
        pages.register(Some(setup), PrintExtras::default(), &mut registry);
        pages
    }

    #[test]
    fn a_sheet_without_a_header_says_so_and_keeps_its_margin() {
        let setup = PagePrintInfo {
            margins: Some(PageMarginsInfo {
                left: 0.5,
                right: 0.75,
                top: 1.0,
                bottom: 0.9,
                header: 0.3,
                footer: 0.4,
            }),
            ..PagePrintInfo::default()
        };
        let pages = registered(&setup);
        assert!(
            pages.masters.contains(r#"<style:header style:display="false"/>"#),
            "{}",
            pages.masters
        );
        assert!(
            pages.masters.contains(r#"<style:footer style:display="false"/>"#),
            "{}",
            pages.masters
        );
        assert!(pages.layouts.contains(r#"fo:margin-top="1.0000in""#), "{}", pages.layouts);
        assert!(pages.layouts.contains(r#"fo:margin-bottom="0.9000in""#), "{}", pages.layouts);
    }

    #[test]
    fn a_header_takes_its_height_out_of_the_body_margin() {
        let setup = PagePrintInfo {
            margins: Some(PageMarginsInfo {
                left: 0.5,
                right: 0.75,
                top: 1.0,
                bottom: 0.9,
                header: 0.3,
                footer: 0.4,
            }),
            odd_header: Some("&L&D &T&C&\"Arial,Bold\"&14Report &P of &N&R&F - &A".into()),
            odd_footer: Some("&CPage &P".into()),
            ..PagePrintInfo::default()
        };
        let pages = registered(&setup);
        // 0.3in to the header, then a 0.7in band: the body still starts 1in in.
        assert!(pages.layouts.contains(r#"fo:margin-top="0.3000in""#), "{}", pages.layouts);
        assert!(
            pages.layouts.contains(
                r#"<style:header-style><style:header-footer-properties svg:height="0.7000in""#
            ),
            "{}",
            pages.layouts
        );
        assert!(
            pages.masters.contains(
                "<style:region-left><text:p><text:date/> <text:time/></text:p></style:region-left>"
            ),
            "{}",
            pages.masters
        );
        assert!(
            pages.masters.contains(
                r#"<text:span text:style-name="MT1">Report </text:span><text:span text:style-name="MT1"><text:page-number>1</text:page-number></text:span>"#
            ),
            "{}",
            pages.masters
        );
        assert!(pages.text_styles.contains(r#"style:font-name="Arial""#), "{}", pages.text_styles);
        assert!(pages.text_styles.contains(r#"fo:font-size="14pt""#), "{}", pages.text_styles);
        assert!(pages.text_styles.contains(r#"fo:font-weight="bold""#), "{}", pages.text_styles);
        assert!(
            pages.masters.contains(
                "<style:region-center><text:p>Page <text:page-number>1</text:page-number></text:p></style:region-center>"
            ),
            "{}",
            pages.masters
        );
        assert!(
            pages.masters.contains(r#"<style:header-left style:display="false"/>"#),
            "{}",
            pages.masters
        );
    }

    #[test]
    fn fitting_scaling_and_what_gets_printed_travel() {
        let fitted = registered(&PagePrintInfo {
            fit_to_page: true,
            fit_to_width: Some(1),
            fit_to_height: Some(0),
            orientation: Some("landscape".into()),
            print_gridlines: true,
            print_headings: true,
            ..PagePrintInfo::default()
        });
        assert!(fitted.layouts.contains(r#"style:scale-to-X="1""#), "{}", fitted.layouts);
        assert!(!fitted.layouts.contains("style:scale-to-Y"), "{}", fitted.layouts);
        assert!(
            fitted.layouts.contains(r#"style:print="charts drawings objects zero-values grid headers""#),
            "{}",
            fitted.layouts
        );
        assert!(fitted.layouts.contains(r#"fo:page-width="29.700cm""#), "{}", fitted.layouts);
        // "Fit to page" with no counts is one page each way.
        let one_page = registered(&PagePrintInfo {
            fit_to_page: true,
            ..PagePrintInfo::default()
        });
        assert!(one_page.layouts.contains(r#"style:scale-to-X="1" style:scale-to-Y="1""#));
        let scaled = registered(&PagePrintInfo {
            scale: Some(80),
            ..PagePrintInfo::default()
        });
        assert!(scaled.layouts.contains(r#"style:scale-to="80%""#), "{}", scaled.layouts);
    }

    #[test]
    fn different_first_and_even_pages_get_their_own_bands() {
        let pages = registered(&PagePrintInfo {
            odd_header: Some("&Codd".into()),
            even_header: Some("&Ceven".into()),
            first_footer: Some("&Cfirst".into()),
            different_odd_even: true,
            different_first: true,
            ..PagePrintInfo::default()
        });
        assert!(
            pages.masters.contains("<style:header-left><style:region-left><text:p></text:p></style:region-left><style:region-center><text:p>even</text:p>"),
            "{}",
            pages.masters
        );
        assert!(pages.masters.contains("<style:footer-first>"), "{}", pages.masters);
        assert!(pages.masters.contains("<text:p>first</text:p>"), "{}", pages.masters);
    }

    #[test]
    fn header_codes_escape_toggle_and_break_lines() {
        let sections = parse_header("A && B\nsecond&R&BBold&B plain&KFF0000red&K01+000theme");
        let center: Vec<String> = sections
            .center
            .iter()
            .flat_map(|run| &run.pieces)
            .map(|piece| match piece {
                Piece::Text(text) => text.clone(),
                Piece::Field(field) => (*field).to_owned(),
                Piece::Break => "|".to_owned(),
            })
            .collect();
        assert_eq!(center, vec!["A & B", "|", "second"]);
        assert_eq!(sections.right.len(), 3);
        assert!(sections.right[0].look.bold);
        assert!(!sections.right[1].look.bold);
        assert_eq!(sections.right[2].look.color.as_deref(), Some("#FF0000"));
    }

    #[test]
    fn reads_the_repeated_rows_and_columns() {
        assert_eq!(
            print_titles(Some("Data!$1:$2,Data!$A:$B")),
            (Some((0, 1)), Some((0, 1)))
        );
        assert_eq!(print_titles(Some("'My, Sheet'!$3:$3")), (Some((2, 2)), None));
        assert_eq!(print_titles(Some("Sheet1!$C:$D")), (None, Some((2, 3))));
        assert_eq!(print_titles(None), (None, None));
    }

    #[test]
    fn reads_centring_first_page_and_page_order_from_the_sheet_tail() {
        let tail = concat!(
            r#"<customSheetViews><customSheetView guid="{1}"><printOptions verticalCentered="1"/><pageSetup pageOrder="overThenDown"/></customSheetView></customSheetViews>"#,
            r#"<printOptions horizontalCentered="1"/><pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>"#,
            r#"<pageSetup paperSize="9" firstPageNumber="5" useFirstPageNumber="1" cellComments="atEnd"/></worksheet>"#,
        );
        let extras = parse_print_extras(tail.as_bytes());
        assert_eq!(
            extras,
            PrintExtras {
                center_horizontal: true,
                center_vertical: false,
                first_page_number: Some(5),
                over_then_down: false,
                notes: true,
            },
            "the custom view's settings are not the sheet's"
        );
        // A first page number Excel was not told to use is not one.
        let unused = parse_print_extras(br#"<pageSetup firstPageNumber="5" pageOrder="overThenDown"/>"#);
        assert_eq!(unused.first_page_number, None);
        assert!(unused.over_then_down);

        let mut pages = PageStyles::default();
        let mut registry = StyleRegistry::new(CellStyle::default());
        let plain = pages.register(None, PrintExtras::default(), &mut registry);
        let centred = pages.register(
            None,
            PrintExtras {
                center_horizontal: true,
                center_vertical: true,
                first_page_number: Some(3),
                over_then_down: true,
                notes: true,
            },
            &mut registry,
        );
        assert_ne!(plain, centred, "different extras are different page styles");
        assert!(pages.layouts.contains(r#"style:print-page-order="ltr" style:table-centering="both" style:first-page-number="3""#), "{}", pages.layouts);
        assert!(pages.layouts.contains("zero-values annotations"), "{}", pages.layouts);
    }

    #[test]
    fn finds_the_print_settings_behind_sheet_data_of_any_size() {
        use std::io::Write;
        let dir = tempfile::tempdir().unwrap();
        let package = |name: &str, sheet: &str| {
            let path = dir.path().join(name);
            let mut writer = zip::ZipWriter::new(File::create(&path).unwrap());
            writer
                .start_file("xl/worksheets/sheet1.xml", zip::write::SimpleFileOptions::default())
                .unwrap();
            writer.write_all(sheet.as_bytes()).unwrap();
            writer.finish().unwrap();
            path
        };
        let tail = r#"<printOptions horizontalCentered="1"/><pageSetup pageOrder="overThenDown"/></worksheet>"#;
        // Rows of every length, so the closing tag lands on each side of a
        // chunk boundary in turn.
        for padding in [0usize, 1, 7, 8, 9, 10, 11, 4096] {
            let mut sheet = String::from(r#"<worksheet><sheetData>"#);
            sheet.push_str(&" ".repeat(padding));
            while sheet.len() < 200_000 {
                sheet.push_str(r#"<row r="1"><c r="A1"><v>1</v></c></row>"#);
            }
            sheet.push_str("</sheetData>");
            sheet.push_str(tail);
            let extras = read_print_extras(&package("big.xlsx", &sheet), "xl/worksheets/sheet1.xml");
            assert!(extras.center_horizontal && extras.over_then_down, "padding {padding}");
        }
        let empty = format!("<worksheet><sheetData/>{tail}");
        let extras = read_print_extras(&package("empty.xlsx", &empty), "xl/worksheets/sheet1.xml");
        assert!(extras.center_horizontal && extras.over_then_down);
        // A part that is not there answers the defaults instead of failing.
        assert_eq!(
            read_print_extras(&package("none.xlsx", "<worksheet/>"), "xl/worksheets/missing.xml"),
            PrintExtras::default()
        );
    }
}
