//! Cell formatting for the `.ods` import: the document's styles read into one
//! shape, resolved through their parents, and written out as the workbook's
//! `styles.xml`.
//!
//! An ODF cell points at a style by name. The style may live in `content.xml`
//! (automatic styles) or `styles.xml` (the named ones), inherits from a parent,
//! and ends at the family default. Excel wants the opposite arrangement: every
//! distinct look is one `xf` built from indexes into font, fill, border and
//! number-format tables. `StyleBook` holds what the document says and
//! `XlsxStyles` turns each resolved look into an index.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use roxmltree::Node;

use crate::odf_layout::length_points;
use crate::odf_number_format::{DataStyles, FormatKind, attribute};
use crate::xlsx_package::escape_xml;

/// Indexes the importer relies on when a value has no style of its own: the
/// first four cell formats are always these.
#[cfg(test)]
const XF_DATE: u16 = 1;
#[cfg(test)]
const XF_DATE_TIME: u16 = 2;
#[cfg(test)]
const XF_TIME: u16 = 3;
const TIME_CODE: &str = "[h]:mm:ss";
/// The colour link text is shown in when nothing says otherwise.
const LINK_COLOR: &str = "0000FF";
/// Excel's ceiling on cell formats, with room to spare.
const MAX_XFS: usize = 64_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) enum Underline {
    None,
    Single,
    Double,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) enum Position {
    Normal,
    Super,
    Sub,
}

/// Character formatting. `None` means "not said here" and falls through to
/// the parent style.
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct FontProps {
    pub(crate) name: Option<String>,
    pub(crate) size: Option<f64>,
    pub(crate) bold: Option<bool>,
    pub(crate) italic: Option<bool>,
    pub(crate) underline: Option<Underline>,
    pub(crate) strike: Option<bool>,
    /// `Some(None)` is the automatic colour, said out loud.
    pub(crate) color: Option<Option<String>>,
    pub(crate) position: Option<Position>,
}

/// One edge of a cell. `style` is an OOXML border token; `None` there is an
/// edge the style explicitly leaves undrawn.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Border {
    pub(crate) style: Option<&'static str>,
    pub(crate) color: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct CellProps {
    pub(crate) font: FontProps,
    pub(crate) fill: Option<Option<String>>,
    pub(crate) top: Option<Border>,
    pub(crate) bottom: Option<Border>,
    pub(crate) left: Option<Border>,
    pub(crate) right: Option<Border>,
    /// Bottom-left to top-right.
    pub(crate) diagonal_up: Option<Border>,
    /// Top-left to bottom-right.
    pub(crate) diagonal_down: Option<Border>,
    pub(crate) horizontal: Option<&'static str>,
    /// False when the style leaves alignment to the value type.
    pub(crate) fixed_alignment: Option<bool>,
    pub(crate) vertical: Option<&'static str>,
    pub(crate) wrap: Option<bool>,
    pub(crate) shrink: Option<bool>,
    /// Excel's `textRotation`: 0–90 up, 91–180 down, 255 stacked.
    pub(crate) rotation: Option<u16>,
    pub(crate) indent: Option<u32>,
    pub(crate) repeat: Option<bool>,
    pub(crate) locked: Option<bool>,
    pub(crate) hidden: Option<bool>,
    pub(crate) data_style: Option<String>,
}

impl FontProps {
    fn inherit(&mut self, parent: &FontProps) {
        macro_rules! take {
            ($($field:ident),*) => {$(
                if self.$field.is_none() {
                    self.$field = parent.$field.clone();
                }
            )*};
        }
        take!(name, size, bold, italic, underline, strike, color, position);
    }

    /// Reads a `style:text-properties` element.
    pub(crate) fn read(&mut self, node: Node<'_, '_>, faces: &HashMap<String, String>) {
        let face = |name: &str| faces.get(name).cloned().unwrap_or_else(|| name.to_owned());
        // A reader shows Korean through the East Asian set, a writer may have
        // filled in only that one; the Western set wins when both are there.
        let name = attribute(node, "font-name")
            .map(face)
            .or_else(|| attribute(node, "font-family").map(clean_family))
            .or_else(|| attribute(node, "font-name-asian").map(face))
            .or_else(|| attribute(node, "font-family-asian").map(clean_family));
        if let Some(name) = name.filter(|name| !name.is_empty()) {
            self.name = Some(name);
        }
        let size = attribute(node, "font-size")
            .or_else(|| attribute(node, "font-size-asian"))
            .filter(|value| !value.ends_with('%'))
            .and_then(length_points)
            .filter(|size| (1.0..=409.0).contains(size));
        if let Some(size) = size {
            self.size = Some(size);
        }
        if let Some(weight) =
            attribute(node, "font-weight").or_else(|| attribute(node, "font-weight-asian"))
        {
            self.bold = Some(match weight {
                "bold" => true,
                "normal" => false,
                other => other.parse::<u32>().is_ok_and(|weight| weight >= 600),
            });
        }
        if let Some(style) =
            attribute(node, "font-style").or_else(|| attribute(node, "font-style-asian"))
        {
            self.italic = Some(matches!(style, "italic" | "oblique"));
        }
        if let Some(style) = attribute(node, "text-underline-style") {
            self.underline = Some(if style == "none" {
                Underline::None
            } else if attribute(node, "text-underline-type") == Some("double") {
                Underline::Double
            } else {
                Underline::Single
            });
        }
        if let Some(style) = attribute(node, "text-line-through-style") {
            self.strike = Some(style != "none");
        } else if let Some(kind) = attribute(node, "text-line-through-type") {
            self.strike = Some(kind != "none");
        }
        if attribute(node, "use-window-font-color") == Some("true") {
            self.color = Some(None);
        }
        if let Some(color) = attribute(node, "color").and_then(hex_color) {
            self.color = Some(Some(color));
        }
        if let Some(position) = attribute(node, "text-position") {
            let first = position.split_whitespace().next().unwrap_or("");
            self.position = Some(if first == "super" {
                Position::Super
            } else if first == "sub" {
                Position::Sub
            } else {
                match first.trim_end_matches('%').parse::<f64>() {
                    Ok(shift) if shift > 0.0 => Position::Super,
                    Ok(shift) if shift < 0.0 => Position::Sub,
                    _ => Position::Normal,
                }
            });
        }
    }

    /// `<font>` children in the order the schema lists them. `rich` writes
    /// the run spelling (`rFont`) instead of the cell one (`name`).
    pub(crate) fn xml(&self, rich: bool) -> String {
        let mut out = String::new();
        if rich {
            if let Some(name) = &self.name {
                out.push_str(&format!(r#"<rFont val="{}"/>"#, escape_xml(name)));
            }
        }
        if self.bold == Some(true) {
            out.push_str("<b/>");
        }
        if self.italic == Some(true) {
            out.push_str("<i/>");
        }
        if self.strike == Some(true) {
            out.push_str("<strike/>");
        }
        if rich {
            if let Some(Some(color)) = &self.color {
                out.push_str(&format!(r#"<color rgb="{}"/>"#, argb(color)));
            }
            if let Some(size) = self.size {
                out.push_str(&format!(r#"<sz val="{}"/>"#, trim_number(size)));
            }
        }
        match self.underline {
            Some(Underline::Single) => out.push_str("<u/>"),
            Some(Underline::Double) => out.push_str(r#"<u val="double"/>"#),
            _ => {}
        }
        match self.position {
            Some(Position::Super) => out.push_str(r#"<vertAlign val="superscript"/>"#),
            Some(Position::Sub) => out.push_str(r#"<vertAlign val="subscript"/>"#),
            _ => {}
        }
        if !rich {
            if let Some(size) = self.size {
                out.push_str(&format!(r#"<sz val="{}"/>"#, trim_number(size)));
            }
            if let Some(Some(color)) = &self.color {
                out.push_str(&format!(r#"<color rgb="{}"/>"#, argb(color)));
            }
            if let Some(name) = &self.name {
                out.push_str(&format!(r#"<name val="{}"/>"#, escape_xml(name)));
            }
        }
        out
    }
}

impl CellProps {
    fn inherit(&mut self, parent: &CellProps) {
        self.font.inherit(&parent.font);
        macro_rules! take {
            ($($field:ident),*) => {$(
                if self.$field.is_none() {
                    self.$field = parent.$field.clone();
                }
            )*};
        }
        take!(
            fill,
            top,
            bottom,
            left,
            right,
            diagonal_up,
            diagonal_down,
            horizontal,
            fixed_alignment,
            vertical,
            wrap,
            shrink,
            rotation,
            indent,
            repeat,
            locked,
            hidden,
            data_style
        );
    }

    /// Reads a cell-family `style:style` or `style:default-style` element.
    fn read(node: Node<'_, '_>, faces: &HashMap<String, String>) -> Self {
        let mut props = CellProps {
            data_style: attribute(node, "data-style-name").map(str::to_owned),
            ..CellProps::default()
        };
        for child in node.children().filter(Node::is_element) {
            match child.tag_name().name() {
                "table-cell-properties" => props.read_cell(child),
                "paragraph-properties" => props.read_paragraph(child),
                "text-properties" => props.font.read(child, faces),
                _ => {}
            }
        }
        props
    }

    fn read_cell(&mut self, node: Node<'_, '_>) {
        if let Some(color) = attribute(node, "background-color") {
            if color == "transparent" {
                self.fill = Some(None);
            } else if let Some(color) = hex_color(color) {
                self.fill = Some(Some(color));
            }
        }
        if let Some(all) = attribute(node, "border").and_then(parse_border) {
            self.top = Some(all.clone());
            self.bottom = Some(all.clone());
            self.left = Some(all.clone());
            self.right = Some(all);
        }
        for (name, slot) in [
            ("border-top", &mut self.top),
            ("border-bottom", &mut self.bottom),
            ("border-left", &mut self.left),
            ("border-right", &mut self.right),
            ("diagonal-bl-tr", &mut self.diagonal_up),
            ("diagonal-tl-br", &mut self.diagonal_down),
        ] {
            if let Some(border) = attribute(node, name).and_then(parse_border) {
                *slot = Some(border);
            }
        }
        if let Some(vertical) = attribute(node, "vertical-align") {
            self.vertical = match vertical {
                "top" => Some("top"),
                "middle" => Some("center"),
                "bottom" => Some("bottom"),
                _ => self.vertical,
            };
        }
        if let Some(wrap) = attribute(node, "wrap-option") {
            self.wrap = Some(wrap == "wrap");
        }
        if let Some(shrink) = attribute(node, "shrink-to-fit") {
            self.shrink = Some(shrink == "true");
        }
        if attribute(node, "direction") == Some("ttb") {
            self.rotation = Some(255);
        } else if let Some(angle) = attribute(node, "rotation-angle") {
            let degrees = angle
                .trim_end_matches("deg")
                .trim()
                .parse::<f64>()
                .ok()
                .map(|degrees| degrees.rem_euclid(360.0).round() as u16);
            // ODF turns counter-clockwise through the full circle; Excel
            // says 1–90 for that and 91–180 for the clockwise quarter.
            self.rotation = match degrees {
                Some(angle @ 0..=90) => Some(angle),
                Some(angle @ 270..=359) => Some(450 - angle),
                _ => self.rotation,
            };
        }
        if let Some(protect) = attribute(node, "cell-protect") {
            let has = |token: &str| protect.split_whitespace().any(|word| word == token);
            let both = has("hidden-and-protected");
            self.locked = Some(both || has("protected"));
            self.hidden = Some(both || has("formula-hidden"));
        }
        if let Some(repeat) = attribute(node, "repeat-content") {
            self.repeat = Some(repeat == "true");
        }
        if let Some(source) = attribute(node, "text-align-source") {
            self.fixed_alignment = Some(source == "fix");
        }
    }

    fn read_paragraph(&mut self, node: Node<'_, '_>) {
        if let Some(align) = attribute(node, "text-align") {
            self.horizontal = match align {
                "start" | "left" => Some("left"),
                "end" | "right" => Some("right"),
                "center" => Some("center"),
                "justify" => Some("justify"),
                _ => self.horizontal,
            };
        }
        if let Some(points) = attribute(node, "margin-left").and_then(length_points) {
            self.indent = Some(indent_steps(points));
        }
    }
}

/// One Excel indent step is three spaces of the default font. The export
/// writes a step as 7.5 points; a document written elsewhere steps by ten.
fn indent_steps(points: f64) -> u32 {
    if points < 3.0 {
        return 0;
    }
    let exported = points / 7.5;
    let steps = if (exported - exported.round()).abs() < 0.02 {
        exported.round()
    } else {
        (points / 10.0).round()
    };
    (steps as u32).clamp(1, 250)
}

/// `"0.74pt solid #000000"` as an OOXML border. `None` when the value cannot
/// be read at all, which leaves the parent's edge in place.
fn parse_border(value: &str) -> Option<Border> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    if matches!(value, "none" | "hidden") {
        return Some(Border {
            style: None,
            color: None,
        });
    }
    let mut width = None;
    let mut line = "solid";
    let mut color = None;
    for token in value.split_whitespace() {
        if let Some(points) = length_points(token) {
            width = Some(points);
        } else if let Some(hex) = hex_color(token) {
            color = Some(hex);
        } else {
            line = match token {
                "none" | "hidden" => "none",
                "double" | "double-thin" => "double",
                "dotted" => "dotted",
                "dashed" | "fine-dashed" => "dashed",
                "dash-dot" => "dash-dot",
                "dash-dot-dot" => "dash-dot-dot",
                _ => line,
            };
        }
    }
    let width = width.unwrap_or(0.75);
    let heavy = width >= 1.2;
    let style = match line {
        "none" => None,
        "double" => Some("double"),
        "dotted" => Some("dotted"),
        "dashed" => Some(if heavy { "mediumDashed" } else { "dashed" }),
        "dash-dot" => Some(if heavy { "mediumDashDot" } else { "dashDot" }),
        "dash-dot-dot" => Some(if heavy { "mediumDashDotDot" } else { "dashDotDot" }),
        _ if width <= 0.0 => None,
        _ if width < 0.6 => Some("hair"),
        _ if width < 1.2 => Some("thin"),
        _ if width < 2.0 => Some("medium"),
        _ => Some("thick"),
    };
    Some(Border { style, color })
}

/// `#rgb` or `#rrggbb` as upper-case `RRGGBB`.
pub(crate) fn hex_color(value: &str) -> Option<String> {
    let digits = value.trim().strip_prefix('#')?;
    if !digits.chars().all(|character| character.is_ascii_hexdigit()) {
        return None;
    }
    match digits.len() {
        6 => Some(digits.to_ascii_uppercase()),
        3 => Some(
            digits
                .chars()
                .flat_map(|character| [character, character])
                .collect::<String>()
                .to_ascii_uppercase(),
        ),
        _ => None,
    }
}

fn argb(color: &str) -> String {
    format!("FF{color}")
}

/// A `svg:font-family` value: the first family of the list, without quotes.
fn clean_family(value: &str) -> String {
    value
        .split(',')
        .next()
        .unwrap_or("")
        .trim()
        .trim_matches(['\'', '"'])
        .to_owned()
}

fn trim_number(value: f64) -> String {
    let rounded = (value * 100.0).round() / 100.0;
    format!("{rounded}")
}

/// What a table style says about its sheet.
#[derive(Clone, Debug, Default)]
pub(crate) struct TableStyle {
    pub(crate) master_page: Option<String>,
    pub(crate) tab_color: Option<String>,
    pub(crate) right_to_left: bool,
}

struct RawCellStyle {
    props: CellProps,
    parent: Option<String>,
}

/// Everything the document's styles say that the import uses.
#[derive(Default)]
pub(crate) struct StyleBook {
    faces: HashMap<String, String>,
    cells: HashMap<String, RawCellStyle>,
    default_cell: CellProps,
    pub(crate) data: DataStyles,
    /// Character styles the cell text points at.
    pub(crate) text: HashMap<String, FontProps>,
    pub(crate) tables: HashMap<String, TableStyle>,
    /// Row and column styles that start a new page.
    pub(crate) row_breaks: HashMap<String, bool>,
    pub(crate) column_breaks: HashMap<String, bool>,
    resolved: RefCell<HashMap<String, Rc<CellProps>>>,
}

impl StyleBook {
    /// Font declarations come first in a document; cell styles look them up.
    pub(crate) fn read_fonts(&mut self, root: Node<'_, '_>) {
        for node in root.descendants() {
            if node.tag_name().name() == "font-face" {
                if let (Some(name), Some(family)) =
                    (attribute(node, "name"), attribute(node, "font-family"))
                {
                    self.faces.insert(name.to_owned(), clean_family(family));
                }
            }
        }
    }

    /// Reads the styles under `scope` (an `office:styles` or
    /// `office:automatic-styles` element).
    pub(crate) fn read_styles(&mut self, scope: Node<'_, '_>) {
        for node in scope.children().filter(Node::is_element) {
            match node.tag_name().name() {
                "default-style" => {
                    if attribute(node, "family") == Some("table-cell") {
                        self.default_cell = CellProps::read(node, &self.faces);
                    }
                }
                "font-face" => {}
                "style" => self.read_style(node),
                _ => self.data.read(node),
            }
        }
    }

    /// Reads only the data styles under `scope`. A cell style may name a
    /// number format that the document declares among the page styles of
    /// `styles.xml`, because a header field uses it too.
    pub(crate) fn read_data_styles(&mut self, scope: Node<'_, '_>) {
        for node in scope.children().filter(Node::is_element) {
            self.data.read(node);
        }
    }

    fn read_style(&mut self, node: Node<'_, '_>) {
        let (Some(name), Some(family)) = (attribute(node, "name"), attribute(node, "family"))
        else {
            return;
        };
        let properties = |local: &str| {
            node.children()
                .find(|child| child.is_element() && child.tag_name().name() == local)
        };
        match family {
            "table-cell" => {
                self.cells.insert(
                    name.to_owned(),
                    RawCellStyle {
                        props: CellProps::read(node, &self.faces),
                        parent: attribute(node, "parent-style-name").map(str::to_owned),
                    },
                );
            }
            "text" => {
                let font = self.font_props(node);
                self.text.insert(name.to_owned(), font);
            }
            "table" => {
                let mut style = TableStyle {
                    master_page: attribute(node, "master-page-name").map(str::to_owned),
                    ..TableStyle::default()
                };
                if let Some(child) = properties("table-properties") {
                    style.tab_color = attribute(child, "tab-color").and_then(hex_color);
                    style.right_to_left = attribute(child, "writing-mode") == Some("rl-tb");
                }
                self.tables.insert(name.to_owned(), style);
            }
            "table-row" => {
                if let Some(child) = properties("table-row-properties") {
                    if attribute(child, "break-before") == Some("page") {
                        self.row_breaks.insert(name.to_owned(), true);
                    }
                }
            }
            "table-column" => {
                if let Some(child) = properties("table-column-properties") {
                    if attribute(child, "break-before") == Some("page") {
                        self.column_breaks.insert(name.to_owned(), true);
                    }
                }
            }
            _ => {}
        }
    }

    /// Call once every style is read. A document that names no default font
    /// keeps the one this importer has always written, so column widths read
    /// as before.
    pub(crate) fn seal(&mut self) {
        let named = self.cells.get("Default").map(|style| &style.props.font);
        if self.default_cell.font.name.is_none() && named.is_none_or(|font| font.name.is_none()) {
            self.default_cell.font.name = Some("Calibri".to_owned());
        }
        if self.default_cell.font.size.is_none() && named.is_none_or(|font| font.size.is_none()) {
            self.default_cell.font.size = Some(11.0);
        }
        self.resolved.borrow_mut().clear();
    }

    /// The character formatting of a text-family style element.
    pub(crate) fn font_props(&self, node: Node<'_, '_>) -> FontProps {
        let mut font = FontProps::default();
        for child in node.children().filter(Node::is_element) {
            if child.tag_name().name() == "text-properties" {
                font.read(child, &self.faces);
            }
        }
        font
    }

    /// A cell style with everything it inherits filled in. An unknown name
    /// (or none) is the document's default cell.
    pub(crate) fn resolve(&self, name: Option<&str>) -> Rc<CellProps> {
        let key = match name {
            Some(name) if self.cells.contains_key(name) => name,
            _ => "Default",
        };
        if let Some(found) = self.resolved.borrow().get(key) {
            return Rc::clone(found);
        }
        let mut props = CellProps::default();
        let mut next = Some(key.to_owned());
        // A parent chain that loops back on itself stops at the depth limit.
        for _ in 0..32 {
            let Some(current) = next.take() else {
                break;
            };
            let Some(style) = self.cells.get(&current) else {
                break;
            };
            props.inherit(&style.props);
            next = style.parent.clone();
        }
        props.inherit(&self.default_cell);
        let props = Rc::new(props);
        self.resolved
            .borrow_mut()
            .insert(key.to_owned(), Rc::clone(&props));
        props
    }
}

/// What kind of value a cell holds, for the format it falls back to when its
/// style has none that suits.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) enum ValueKind {
    Plain,
    Date,
    DateTime,
    Time,
}

/// The workbook's `styles.xml` under construction.
pub(crate) struct XlsxStyles {
    fonts: Vec<String>,
    font_index: HashMap<String, usize>,
    fills: Vec<String>,
    fill_index: HashMap<String, usize>,
    borders: Vec<String>,
    border_index: HashMap<String, usize>,
    formats: Vec<(u32, String)>,
    format_index: HashMap<String, u32>,
    xfs: Vec<String>,
    xf_index: HashMap<String, u16>,
    /// Differential formats, for conditional rules.
    dxfs: Vec<String>,
    dxf_index: HashMap<String, usize>,
    /// `(style name, value kind)` already turned into an index.
    named: HashMap<(Option<String>, ValueKind), u16>,
    /// `(style name, edges kept)` for the cells a merge covers.
    covered: HashMap<(String, [bool; 4]), Option<u16>>,
    /// Style name to the format of a cell that holds a link.
    linked: HashMap<Option<String>, Option<u16>>,
}

impl XlsxStyles {
    /// A stylesheet whose first cell format is the document's default cell,
    /// followed by the three date and time fallbacks.
    pub(crate) fn new(book: &StyleBook) -> Self {
        let mut styles = Self {
            fonts: Vec::new(),
            font_index: HashMap::new(),
            fills: vec![
                r#"<fill><patternFill patternType="none"/></fill>"#.to_owned(),
                r#"<fill><patternFill patternType="gray125"/></fill>"#.to_owned(),
            ],
            fill_index: HashMap::new(),
            borders: Vec::new(),
            border_index: HashMap::new(),
            formats: Vec::new(),
            format_index: HashMap::new(),
            xfs: Vec::new(),
            xf_index: HashMap::new(),
            dxfs: Vec::new(),
            dxf_index: HashMap::new(),
            named: HashMap::new(),
            covered: HashMap::new(),
            linked: HashMap::new(),
        };
        let base = book.resolve(None);
        let code = base
            .data_style
            .as_deref()
            .and_then(|name| book.data.code(name))
            .map(|(code, _)| code);
        styles.push_xf(&base, code.as_deref());
        for code in ["m/d/yyyy", "m/d/yyyy h:mm", TIME_CODE] {
            // The fallbacks use the built-in ids where Excel has them, so a
            // date follows the reader's locale as it did before.
            styles.push_xf(&base, Some(code));
        }
        styles
    }

    /// The cell format for a style name and the kind of value it will show.
    pub(crate) fn cell(&mut self, book: &StyleBook, name: Option<&str>, kind: ValueKind) -> u16 {
        let key = (name.map(str::to_owned), kind);
        if let Some(index) = self.named.get(&key) {
            return *index;
        }
        let props = book.resolve(name);
        let format = props
            .data_style
            .as_deref()
            .and_then(|data| book.data.code(data));
        let code = match (kind, format) {
            // A date shown through a format that is not one would read as a
            // bare serial number.
            (ValueKind::Date, Some((code, FormatKind::Date | FormatKind::Time))) => Some(code),
            (ValueKind::DateTime, Some((code, FormatKind::Date | FormatKind::Time))) => Some(code),
            (ValueKind::Time, Some((code, FormatKind::Date | FormatKind::Time))) => Some(code),
            (ValueKind::Date, _) => Some("m/d/yyyy".to_owned()),
            (ValueKind::DateTime, _) => Some("m/d/yyyy h:mm".to_owned()),
            (ValueKind::Time, _) => Some(TIME_CODE.to_owned()),
            (ValueKind::Plain, format) => format.map(|(code, _)| code),
        };
        let index = self.xf(&props, code.as_deref());
        self.named.insert(key, index);
        index
    }

    /// The format of a cell a merge covers, from the style of the merge's
    /// first cell. ODF draws a merged cell's frame from that one style; Excel
    /// draws each outer edge from the cell that sits on it, so every covered
    /// cell gets the fill and the edges of its own position. `keep` is top,
    /// bottom, left, right. `None` when the style has nothing to spread.
    pub(crate) fn covered_cell(
        &mut self,
        book: &StyleBook,
        name: &str,
        keep: [bool; 4],
    ) -> Option<u16> {
        let key = (name.to_owned(), keep);
        if let Some(index) = self.covered.get(&key) {
            return *index;
        }
        let anchor = book.resolve(Some(name));
        let drawn = |border: &Option<Border>| {
            border
                .as_ref()
                .is_some_and(|border| border.style.is_some())
        };
        let framed = drawn(&anchor.top)
            || drawn(&anchor.bottom)
            || drawn(&anchor.left)
            || drawn(&anchor.right);
        let filled = matches!(anchor.fill, Some(Some(_)));
        let index = if framed || filled {
            let mut props = (*anchor).clone();
            let [top, bottom, left, right] = keep;
            if !top {
                props.top = None;
            }
            if !bottom {
                props.bottom = None;
            }
            if !left {
                props.left = None;
            }
            if !right {
                props.right = None;
            }
            props.diagonal_up = None;
            props.diagonal_down = None;
            let code = props
                .data_style
                .as_deref()
                .and_then(|data| book.data.code(data))
                .map(|(code, _)| code);
            Some(self.xf(&props, code.as_deref()))
        } else {
            None
        };
        self.covered.insert(key, index);
        index
    }

    /// The format of a cell whose text is a link. A reader of the document
    /// paints link text in the link colour without the cell style saying so;
    /// Excel paints what the cell format says. `None` when the style already
    /// names a colour, which stays.
    pub(crate) fn linked_cell(&mut self, book: &StyleBook, name: Option<&str>) -> Option<u16> {
        let key = name.map(str::to_owned);
        if let Some(index) = self.linked.get(&key) {
            return *index;
        }
        let props = book.resolve(name);
        let index = if matches!(props.font.color, Some(Some(_))) {
            None
        } else {
            let mut props = (*props).clone();
            props.font.color = Some(Some(LINK_COLOR.to_owned()));
            let code = props
                .data_style
                .as_deref()
                .and_then(|data| book.data.code(data))
                .map(|(code, _)| code);
            Some(self.xf(&props, code.as_deref()))
        };
        self.linked.insert(key, index);
        index
    }

    fn format_id(&mut self, code: Option<&str>) -> u32 {
        let Some(code) = code else {
            return 0;
        };
        let builtin = match code {
            "General" => Some(0),
            "0" => Some(1),
            "0.00" => Some(2),
            "#,##0" => Some(3),
            "#,##0.00" => Some(4),
            "0%" => Some(9),
            "0.00%" => Some(10),
            "0.00E+00" => Some(11),
            "m/d/yyyy" => Some(14),
            "m/d/yyyy h:mm" => Some(22),
            "@" => Some(49),
            _ => None,
        };
        if let Some(id) = builtin {
            return id;
        }
        if let Some(id) = self.format_index.get(code) {
            return *id;
        }
        let id = 164 + self.formats.len() as u32;
        self.formats.push((id, code.to_owned()));
        self.format_index.insert(code.to_owned(), id);
        id
    }

    fn font_id(&mut self, font: &FontProps) -> usize {
        let xml = format!("<font>{}</font>", font.xml(false));
        intern(&mut self.fonts, &mut self.font_index, xml)
    }

    fn fill_id(&mut self, fill: &Option<Option<String>>) -> usize {
        match fill {
            Some(Some(color)) => {
                let xml = format!(
                    r#"<fill><patternFill patternType="solid"><fgColor rgb="{}"/><bgColor indexed="64"/></patternFill></fill>"#,
                    argb(color)
                );
                intern(&mut self.fills, &mut self.fill_index, xml)
            }
            _ => 0,
        }
    }

    fn border_id(&mut self, props: &CellProps) -> usize {
        let edge = |tag: &str, border: &Option<Border>| match border {
            Some(Border {
                style: Some(style),
                color,
            }) => format!(
                r#"<{tag} style="{style}"><color rgb="{}"/></{tag}>"#,
                argb(color.as_deref().unwrap_or("000000"))
            ),
            _ => format!("<{tag}/>"),
        };
        let drawn = |border: &Option<Border>| {
            border
                .as_ref()
                .is_some_and(|border| border.style.is_some())
        };
        let up = drawn(&props.diagonal_up);
        let down = drawn(&props.diagonal_down);
        let diagonal = if up {
            &props.diagonal_up
        } else if down {
            &props.diagonal_down
        } else {
            &None
        };
        let mut attributes = String::new();
        if up {
            attributes.push_str(r#" diagonalUp="1""#);
        }
        if down {
            attributes.push_str(r#" diagonalDown="1""#);
        }
        let xml = format!(
            "<border{attributes}>{}{}{}{}{}</border>",
            edge("left", &props.left),
            edge("right", &props.right),
            edge("top", &props.top),
            edge("bottom", &props.bottom),
            edge("diagonal", diagonal),
        );
        intern(&mut self.borders, &mut self.border_index, xml)
    }

    fn alignment_xml(props: &CellProps) -> String {
        let mut attributes = String::new();
        let horizontal = if props.repeat == Some(true) {
            Some("fill")
        } else if props.fixed_alignment == Some(false) {
            // The style leaves alignment to the value type, as General does.
            None
        } else {
            props.horizontal
        };
        if let Some(horizontal) = horizontal {
            attributes.push_str(&format!(r#" horizontal="{horizontal}""#));
        }
        if let Some(vertical) = props.vertical {
            attributes.push_str(&format!(r#" vertical="{vertical}""#));
        }
        if let Some(rotation) = props.rotation.filter(|rotation| *rotation != 0) {
            attributes.push_str(&format!(r#" textRotation="{rotation}""#));
        }
        if props.wrap == Some(true) {
            attributes.push_str(r#" wrapText="1""#);
        }
        if let Some(indent) = props.indent.filter(|indent| *indent > 0) {
            // An indent only shows on a side the text is aligned to.
            if horizontal.is_none() {
                attributes.push_str(r#" horizontal="left""#);
            }
            attributes.push_str(&format!(r#" indent="{indent}""#));
        }
        if props.shrink == Some(true) && props.wrap != Some(true) {
            attributes.push_str(r#" shrinkToFit="1""#);
        }
        if attributes.is_empty() {
            String::new()
        } else {
            format!("<alignment{attributes}/>")
        }
    }

    fn protection_xml(props: &CellProps) -> String {
        let mut attributes = String::new();
        if props.locked == Some(false) {
            attributes.push_str(r#" locked="0""#);
        }
        if props.hidden == Some(true) {
            attributes.push_str(r#" hidden="1""#);
        }
        if attributes.is_empty() {
            String::new()
        } else {
            format!("<protection{attributes}/>")
        }
    }

    /// Appends a cell format whether or not an identical one exists: the
    /// leading four are known by position.
    fn push_xf(&mut self, props: &CellProps, code: Option<&str>) {
        let xml = self.xf_xml(props, code);
        let index = self.xfs.len() as u16;
        self.xf_index.entry(xml.clone()).or_insert(index);
        self.xfs.push(xml);
    }

    /// The index of the cell format for these resolved properties.
    fn xf(&mut self, props: &CellProps, code: Option<&str>) -> u16 {
        let xml = self.xf_xml(props, code);
        if let Some(index) = self.xf_index.get(&xml) {
            return *index;
        }
        if self.xfs.len() >= MAX_XFS {
            return 0;
        }
        let index = self.xfs.len() as u16;
        self.xf_index.insert(xml.clone(), index);
        self.xfs.push(xml);
        index
    }

    fn xf_xml(&mut self, props: &CellProps, code: Option<&str>) -> String {
        let format = self.format_id(code);
        let font = self.font_id(&props.font);
        let fill = self.fill_id(&props.fill);
        let border = self.border_id(props);
        let alignment = Self::alignment_xml(props);
        let protection = Self::protection_xml(props);
        let mut attributes = format!(
            r#"numFmtId="{format}" fontId="{font}" fillId="{fill}" borderId="{border}" xfId="0""#
        );
        if format != 0 {
            attributes.push_str(r#" applyNumberFormat="1""#);
        }
        if font != 0 {
            attributes.push_str(r#" applyFont="1""#);
        }
        if fill != 0 {
            attributes.push_str(r#" applyFill="1""#);
        }
        if border != 0 {
            attributes.push_str(r#" applyBorder="1""#);
        }
        if !alignment.is_empty() {
            attributes.push_str(r#" applyAlignment="1""#);
        }
        if !protection.is_empty() {
            attributes.push_str(r#" applyProtection="1""#);
        }
        if alignment.is_empty() && protection.is_empty() {
            format!("<xf {attributes}/>")
        } else {
            format!("<xf {attributes}>{alignment}{protection}</xf>")
        }
    }

    /// A differential format for a conditional rule: only what the style
    /// itself says, without what it inherits.
    pub(crate) fn dxf(&mut self, book: &StyleBook, name: &str) -> Option<usize> {
        let props = book.resolve(Some(name));
        let default = book.resolve(None);
        let mut xml = String::new();
        let mut font = props.font.clone();
        // Only the differences from the default cell are the rule's own.
        if font.name == default.font.name {
            font.name = None;
        }
        if font.size == default.font.size {
            font.size = None;
        }
        if font.color == default.font.color {
            font.color = None;
        }
        if font.bold == default.font.bold {
            font.bold = None;
        }
        if font.italic == default.font.italic {
            font.italic = None;
        }
        if font.underline == default.font.underline {
            font.underline = None;
        }
        if font.strike == default.font.strike {
            font.strike = None;
        }
        font.position = None;
        font.name = None;
        font.size = None;
        let font_xml = font.xml(false);
        if !font_xml.is_empty() {
            xml.push_str(&format!("<font>{font_xml}</font>"));
        }
        if let Some(Some(color)) = &props.fill {
            if props.fill != default.fill {
                xml.push_str(&format!(
                    r#"<fill><patternFill patternType="solid"><fgColor rgb="{0}"/><bgColor rgb="{0}"/></patternFill></fill>"#,
                    argb(color)
                ));
            }
        }
        let mut border = String::new();
        for (tag, edge, base) in [
            ("left", &props.left, &default.left),
            ("right", &props.right, &default.right),
            ("top", &props.top, &default.top),
            ("bottom", &props.bottom, &default.bottom),
        ] {
            if edge == base {
                continue;
            }
            if let Some(Border {
                style: Some(style),
                color,
            }) = edge
            {
                border.push_str(&format!(
                    r#"<{tag} style="{style}"><color rgb="{}"/></{tag}>"#,
                    argb(color.as_deref().unwrap_or("000000"))
                ));
            }
        }
        if !border.is_empty() {
            xml.push_str(&format!("<border>{border}</border>"));
        }
        if xml.is_empty() {
            return None;
        }
        let xml = format!("<dxf>{xml}</dxf>");
        Some(intern(&mut self.dxfs, &mut self.dxf_index, xml))
    }

    /// The finished part.
    pub(crate) fn xml(&self) -> String {
        let formats = if self.formats.is_empty() {
            String::new()
        } else {
            format!(
                r#"<numFmts count="{}">{}</numFmts>"#,
                self.formats.len(),
                self.formats
                    .iter()
                    .map(|(id, code)| format!(
                        r#"<numFmt numFmtId="{id}" formatCode="{}"/>"#,
                        escape_xml(code)
                    ))
                    .collect::<String>()
            )
        };
        let dxfs = if self.dxfs.is_empty() {
            String::new()
        } else {
            format!(
                r#"<dxfs count="{}">{}</dxfs>"#,
                self.dxfs.len(),
                self.dxfs.concat()
            )
        };
        let base = self.xfs.first().map(String::as_str).unwrap_or("");
        // The style xf is the default cell without the reference to itself.
        let style_xf = base.replacen(r#" xfId="0""#, "", 1);
        format!(
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">{formats}<fonts count="{}">{}</fonts><fills count="{}">{}</fills><borders count="{}">{}</borders><cellStyleXfs count="1">{style_xf}</cellStyleXfs><cellXfs count="{}">{}</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>{dxfs}</styleSheet>"#,
            self.fonts.len(),
            self.fonts.concat(),
            self.fills.len(),
            self.fills.concat(),
            self.borders.len(),
            self.borders.concat(),
            self.xfs.len(),
            self.xfs.concat(),
        )
    }
}

fn intern(list: &mut Vec<String>, index: &mut HashMap<String, usize>, xml: String) -> usize {
    if let Some(found) = index.get(&xml) {
        return *found;
    }
    let position = list.len();
    index.insert(xml.clone(), position);
    list.push(xml);
    position
}

#[cfg(test)]
mod tests {
    use super::*;

    const NS: &str = r#"xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:number="urn:oasis:names:tc:opendocument:xmlns:datastyle:1.0" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0""#;

    fn book(styles: &str) -> StyleBook {
        let xml = format!("<office:styles {NS}>{styles}</office:styles>");
        let document = roxmltree::Document::parse(&xml).unwrap();
        let mut book = StyleBook::default();
        book.read_fonts(document.root_element());
        book.read_styles(document.root_element());
        book.seal();
        book
    }

    #[test]
    fn styles_inherit_through_parents_to_the_default() {
        let book = book(concat!(
            r#"<style:font-face style:name="맑은 고딕" svg:font-family="'맑은 고딕'"/>"#,
            r#"<style:default-style style:family="table-cell"><style:text-properties style:font-name="맑은 고딕" fo:font-size="11pt"/></style:default-style>"#,
            r#"<style:style style:name="Default" style:family="table-cell"/>"#,
            r##"<style:style style:name="Head" style:family="table-cell" style:parent-style-name="Default"><style:table-cell-properties fo:background-color="#ddebf7" fo:border="0.75pt solid #000000"/><style:text-properties fo:font-weight="bold"/></style:style>"##,
            r##"<style:style style:name="ce1" style:family="table-cell" style:parent-style-name="Head"><style:table-cell-properties fo:border-top="none" style:rotation-angle="315" style:cell-protect="none"/><style:paragraph-properties fo:text-align="end" fo:margin-left="15pt"/><style:text-properties style:font-size-asian="14pt" fo:color="#ff0000"/></style:style>"##,
        ));
        let props = book.resolve(Some("ce1"));
        assert_eq!(props.font.name.as_deref(), Some("맑은 고딕"));
        assert_eq!(props.font.size, Some(14.0), "the East Asian size stands in");
        assert_eq!(props.font.bold, Some(true));
        assert_eq!(props.font.color, Some(Some("FF0000".to_owned())));
        assert_eq!(props.fill, Some(Some("DDEBF7".to_owned())));
        assert_eq!(props.top.as_ref().unwrap().style, None, "the child removes the edge");
        assert_eq!(props.left.as_ref().unwrap().style, Some("thin"));
        assert_eq!(props.rotation, Some(135));
        assert_eq!(props.indent, Some(2));
        assert_eq!(props.locked, Some(false));
        assert_eq!(props.horizontal, Some("right"));
        // an unknown name is the default cell
        assert_eq!(book.resolve(Some("nope")).font.size, Some(11.0));
    }

    #[test]
    fn the_stylesheet_keeps_the_fallback_formats_first() {
        let book = book(concat!(
            r#"<number:number-style style:name="N1"><number:number number:decimal-places="2" number:min-decimal-places="2" number:min-integer-digits="1" number:grouping="true"/></number:number-style>"#,
            r#"<number:date-style style:name="N2"><number:year number:style="long"/><number:text>-</number:text><number:month number:style="long"/></number:date-style>"#,
            r#"<style:style style:name="Default" style:family="table-cell"/>"#,
            r#"<style:style style:name="ce1" style:family="table-cell" style:parent-style-name="Default" style:data-style-name="N1"><style:text-properties fo:font-weight="bold"/></style:style>"#,
            r#"<style:style style:name="ce2" style:family="table-cell" style:parent-style-name="Default" style:data-style-name="N2"/>"#,
        ));
        let mut styles = XlsxStyles::new(&book);
        assert_eq!(styles.cell(&book, None, ValueKind::Plain), 0);
        assert_eq!(styles.cell(&book, None, ValueKind::Date), XF_DATE);
        assert_eq!(styles.cell(&book, None, ValueKind::DateTime), XF_DATE_TIME);
        assert_eq!(styles.cell(&book, None, ValueKind::Time), XF_TIME);
        let bold = styles.cell(&book, Some("ce1"), ValueKind::Plain);
        assert_eq!(bold, 4);
        assert_eq!(styles.cell(&book, Some("ce1"), ValueKind::Plain), 4, "one look, one index");
        // a number format on a date value gives way to a date format
        let bold_date = styles.cell(&book, Some("ce1"), ValueKind::Date);
        assert_ne!(bold_date, bold);
        let month = styles.cell(&book, Some("ce2"), ValueKind::Date);
        let xml = styles.xml();
        assert!(xml.contains(r#"<numFmt numFmtId="165" formatCode="yyyy-mm"/>"#), "{xml}");
        assert!(xml.contains(r#"<xf numFmtId="4" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>"#), "{xml}");
        assert!(xml.contains(r#"<xf numFmtId="14" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>"#), "{xml}");
        assert!(month > bold_date);
        assert!(xml.contains(r#"<cellXfs count="7">"#), "{xml}");
        assert!(xml.contains(r#"<font><sz val="11"/><name val="Calibri"/></font>"#), "{xml}");
    }
}
