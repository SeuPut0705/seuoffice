//! Styles for the `.ods` export.
//!
//! Excel keeps a cell's look in a shared `xf` table and its number format in a
//! code such as `#,##0.00` or `yyyy-mm-dd`. ODF wants the first as a
//! `style:style` of family `table-cell` and the second as a `number:*` data
//! style that the cell style points at. `StyleRegistry` builds both while the
//! table body is written: every distinct body it derives gets a name, and the
//! caller assembles the automatic-styles block from what it collected.
//!
//! A number format is read section by section (`positive;negative;zero;text`):
//! each section becomes its own data style and the last numeric one carries
//! `style:map` conditions that send a value to the others, which is how ODF
//! says "negative numbers in red". A code this module cannot read becomes no
//! data style at all. The value is still written as a number, so the only
//! thing lost is how it is displayed.

use std::collections::{BTreeSet, HashMap};

use crate::visuals::BorderEdge;
use crate::xlsx_package::escape_xml;
use crate::{CellStyle, RichRun};

/// What a number-format code says the cell holds. The content writer picks the
/// matching ODF value attribute and display text from it.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum ValueKind {
    Number,
    Date,
    Time,
}

/// One cell's formatting as the content writer needs it.
#[derive(Clone)]
pub(crate) struct ResolvedStyle {
    /// `table:style-name`, absent when the cell looks like the workbook
    /// default and needs no style element.
    pub(crate) name: Option<String>,
    pub(crate) kind: ValueKind,
}

/// The named cell style every default-looking cell can point at. A column
/// that carries a default cell style hands it to each of its cells that names
/// none, so a plain cell in such a column has to name this one.
pub(crate) const DEFAULT_CELL_STYLE: &str = "Default";

/// Automatic styles collected while the table body is written.
pub(crate) struct StyleRegistry {
    /// cellXfs[0]: the font, fill and size every cell starts from. The
    /// stylesheet writes it as the document default style, so cell styles
    /// only have to carry what differs.
    base: CellStyle,
    data_styles: HashMap<String, (Option<String>, ValueKind)>,
    data_bodies: Vec<String>,
    cell_styles: HashMap<String, String>,
    cell_bodies: Vec<(String, Option<String>, String)>,
    column_styles: HashMap<String, String>,
    column_bodies: Vec<String>,
    row_styles: HashMap<String, String>,
    row_bodies: Vec<String>,
    text_styles: HashMap<String, String>,
    text_bodies: Vec<String>,
    /// Named styles a conditional format applies, by their properties.
    conditional_names: HashMap<String, String>,
    conditional_bodies: Vec<(String, String)>,
    /// The name the workbook cached for its body font, which follows the
    /// theme.
    body_font: Option<String>,
    /// The East Asian face behind a font that follows the theme.
    scheme_asian: Option<String>,
    fonts: BTreeSet<String>,
    counter: usize,
}

impl StyleRegistry {
    pub(crate) fn new(base: CellStyle) -> Self {
        let mut fonts = BTreeSet::new();
        if let Some(family) = &base.font_family {
            fonts.insert(family.clone());
        }
        Self {
            base,
            data_styles: HashMap::new(),
            data_bodies: Vec::new(),
            cell_styles: HashMap::new(),
            cell_bodies: Vec::new(),
            column_styles: HashMap::new(),
            column_bodies: Vec::new(),
            row_styles: HashMap::new(),
            row_bodies: Vec::new(),
            text_styles: HashMap::new(),
            text_bodies: Vec::new(),
            conditional_names: HashMap::new(),
            conditional_bodies: Vec::new(),
            body_font: None,
            scheme_asian: None,
            fonts,
            counter: 0,
        }
    }

    /// Says what the fonts that follow the theme stand for. The model
    /// resolves such a font to the theme's Latin face. `body` is the name the
    /// workbook itself cached for its body font — the face Excel shows where
    /// the workbook was made, 맑은 고딕 for one made in Korean — and replaces
    /// the Latin face for every script. Without it, `asian` names the face
    /// the theme gives East Asian text.
    pub(crate) fn set_theme_fonts(&mut self, body: Option<String>, asian: Option<String>) {
        for family in body.iter().chain(asian.iter()) {
            self.fonts.insert(family.clone());
        }
        self.body_font = body;
        self.scheme_asian = asian;
    }

    /// The font name for Western, East Asian and complex text. A reader
    /// picks the property by script, so a Korean cell given only the Western
    /// one would keep the reader's own default font.
    fn font_names(&self, family: &str, scheme: Option<&str>) -> String {
        let family = match (scheme, &self.body_font) {
            (Some("minor"), Some(body)) => body.as_str(),
            _ => family,
        };
        let asian = match (scheme, &self.scheme_asian) {
            (Some(_), Some(asian)) if self.body_font.is_none() => asian.as_str(),
            _ => family,
        };
        format!(
            r#" style:font-name="{0}" style:font-name-asian="{1}" style:font-name-complex="{0}""#,
            escape_xml(family),
            escape_xml(asian)
        )
    }

    fn next_name(&mut self, prefix: &str) -> String {
        self.counter += 1;
        format!("{prefix}{}", self.counter)
    }

    /// The data style for a cell's number format, plus what the value is.
    fn data_style(&mut self, format: Option<&str>) -> (Option<String>, ValueKind) {
        let Some(format) = format.map(str::trim).filter(|code| !code.is_empty()) else {
            return (None, ValueKind::Number);
        };
        if let Some(cached) = self.data_styles.get(format) {
            return cached.clone();
        }
        let resolved = match data_style_plan(format) {
            None => (None, ValueKind::Number),
            Some(plan) => {
                let name = self.next_name("N");
                self.data_bodies.push(plan.xml(&name));
                (Some(name), plan.kind)
            }
        };
        self.data_styles.insert(format.to_owned(), resolved.clone());
        resolved
    }

    /// One cell style for a workbook `CellStyle`, or `None` when the cell looks
    /// exactly like the document default.
    pub(crate) fn resolve_cell(&mut self, style: &CellStyle) -> ResolvedStyle {
        let (data, kind) = self.data_style(style.number_format.as_deref());
        // A format that needs a data style needs a cell style to point at it,
        // even when the format is the workbook default's own.
        if data.is_none() && style.is_default_like(&self.base) {
            return ResolvedStyle { name: None, kind };
        }
        let inner = self.cell_properties(style);
        let key = format!("{}\u{1}{}", data.as_deref().unwrap_or(""), inner);
        if let Some(name) = self.cell_styles.get(&key) {
            return ResolvedStyle {
                name: Some(name.clone()),
                kind,
            };
        }
        let name = self.next_name("ce");
        self.cell_styles.insert(key, name.clone());
        self.cell_bodies.push((name.clone(), data, inner));
        ResolvedStyle {
            name: Some(name),
            kind,
        }
    }

    /// The properties of one cell style, as the inside of its `style:style`.
    fn cell_properties(&mut self, style: &CellStyle) -> String {
        let mut cell = String::new();
        let mut paragraph = String::new();
        let mut text = String::new();

        if let Some(color) = &style.fill_color {
            if self.base.fill_color.as_ref() != Some(color) {
                cell.push_str(&format!(
                    r#" fo:background-color="{}""#,
                    escape_xml(color)
                ));
            }
        }
        // Borders are always written: the ODF default is "no border", so a
        // cell edge the workbook draws has to say so even when the default xf
        // shares it.
        for (attribute, edge) in [
            ("fo:border-top", &style.border_top),
            ("fo:border-bottom", &style.border_bottom),
            ("fo:border-left", &style.border_left),
            ("fo:border-right", &style.border_right),
        ] {
            if let Some(edge) = edge {
                cell.push_str(&format!(
                    r#" {attribute}="{}""#,
                    escape_xml(&border_line(edge))
                ));
            }
        }
        if stroke_only(&self.base, style) {
            for attribute in [
                "fo:border-top",
                "fo:border-bottom",
                "fo:border-left",
                "fo:border-right",
            ] {
                cell.push_str(&format!(r#" {attribute}="none""#));
            }
        }
        if let Some(edge) = &style.border_diagonal {
            let line = escape_xml(&border_line(edge));
            if style.diagonal_up {
                cell.push_str(&format!(r#" style:diagonal-bl-tr="{line}""#));
            }
            if style.diagonal_down {
                cell.push_str(&format!(r#" style:diagonal-tl-br="{line}""#));
            }
        }
        if let Some(vertical) = &style.vertical_alignment {
            let value = match vertical.as_str() {
                "top" => Some("top"),
                "center" => Some("middle"),
                "bottom" => Some("bottom"),
                _ => None,
            };
            if let Some(value) = value {
                cell.push_str(&format!(r#" style:vertical-align="{value}""#));
            }
        }
        if style.wrap_text {
            cell.push_str(r#" fo:wrap-option="wrap""#);
        }
        if style.shrink_to_fit {
            cell.push_str(r#" style:shrink-to-fit="true""#);
        }
        match style.text_rotation {
            // 255 stacks the characters top to bottom without turning them.
            Some(255) => cell.push_str(r#" style:direction="ttb""#),
            // 1–90 turns counter-clockwise; 91–180 stands for 1–90 clockwise.
            Some(angle @ 1..=90) => {
                cell.push_str(&format!(r#" style:rotation-angle="{angle}""#));
            }
            Some(angle @ 91..=180) => {
                cell.push_str(&format!(r#" style:rotation-angle="{}""#, 450 - angle));
            }
            _ => {}
        }
        match (style.locked, style.hidden) {
            (Some(false), Some(true)) => cell.push_str(r#" style:cell-protect="formula-hidden""#),
            (Some(false), _) => cell.push_str(r#" style:cell-protect="none""#),
            (_, Some(true)) => {
                cell.push_str(r#" style:cell-protect="protected formula-hidden""#);
            }
            _ => {}
        }

        if let Some(horizontal) = &style.horizontal_alignment {
            let value = match horizontal.as_str() {
                "left" => Some("start"),
                "center" | "centerContinuous" => Some("center"),
                "right" => Some("end"),
                "justify" | "distributed" => Some("justify"),
                // Excel's "fill" repeats the text across the cell.
                "fill" => {
                    cell.push_str(r#" style:repeat-content="true""#);
                    Some("start")
                }
                _ => None,
            };
            if let Some(value) = value {
                // Without the "fix" source a reader aligns by value type and
                // ignores the paragraph's own alignment.
                cell.push_str(r#" style:text-align-source="fix""#);
                paragraph.push_str(&format!(r#" fo:text-align="{value}""#));
            }
        }
        if let Some(indent) = style.indent.filter(|steps| *steps > 0) {
            // One Excel indent step is three spaces of the default font,
            // which readers take as 7.5pt.
            paragraph.push_str(&format!(
                r#" fo:margin-left="{}pt""#,
                7.5 * f64::from(indent)
            ));
        }

        let font_family = style
            .font_family
            .as_ref()
            .filter(|family| font_family_differs(&self.base, family));
        if let Some(family) = font_family {
            self.fonts.insert(family.clone());
            text.push_str(&self.font_names(family, style.font_scheme.as_deref()));
        }
        if let Some(size) = style.font_size.filter(|size| {
            self.base.font_size.map(|base| (base - size).abs() > 1e-6) != Some(false)
        }) {
            text.push_str(&font_size_attributes(size));
        }
        if style.bold != self.base.bold {
            text.push_str(&font_weight_attributes(style.bold));
        }
        if style.italic != self.base.italic {
            text.push_str(&font_style_attributes(style.italic));
        }
        if style.underline != self.base.underline {
            if style.underline {
                text.push_str(
                    r#" style:text-underline-style="solid" style:text-underline-type="single" style:text-underline-width="auto" style:text-underline-color="font-color""#,
                );
            } else {
                text.push_str(r#" style:text-underline-style="none""#);
            }
        }
        if style.strikethrough != self.base.strikethrough {
            if style.strikethrough {
                text.push_str(
                    r#" style:text-line-through-style="solid" style:text-line-through-type="single""#,
                );
            } else {
                text.push_str(r#" style:text-line-through-style="none""#);
            }
        }
        if let Some(color) = &style.font_color {
            if self.base.font_color.as_ref() != Some(color) {
                text.push_str(&format!(r#" fo:color="{}""#, escape_xml(color)));
            }
        }
        if let Some(position) = text_position(style.vert_align.as_deref()) {
            text.push_str(&format!(r#" style:text-position="{position}""#));
        }

        let mut out = String::new();
        if !cell.is_empty() {
            out.push_str("<style:table-cell-properties");
            out.push_str(&cell);
            out.push_str("/>");
        }
        if !paragraph.is_empty() {
            out.push_str("<style:paragraph-properties");
            out.push_str(&paragraph);
            out.push_str("/>");
        }
        if !text.is_empty() {
            out.push_str("<style:text-properties");
            out.push_str(&text);
            out.push_str("/>");
        }
        out
    }

    /// A `table-column` style for a width in points and a page break ahead of
    /// the column; `None` when the column needs neither.
    pub(crate) fn column(&mut self, width_points: Option<f64>, break_before: bool) -> Option<String> {
        if width_points.is_none() && !break_before {
            return None;
        }
        let key = format!(
            "{}|{break_before}",
            width_points.map(|width| format!("{width:.2}")).unwrap_or_default()
        );
        if let Some(name) = self.column_styles.get(&key) {
            return Some(name.clone());
        }
        let name = self.next_name("co");
        self.column_styles.insert(key, name.clone());
        let width = width_points
            .map(|width| format!(r#" style:column-width="{width:.2}pt""#))
            .unwrap_or_default();
        self.column_bodies.push(format!(
            r#"<style:style style:name="{name}" style:family="table-column"><style:table-column-properties{width} fo:break-before="{}"/></style:style>"#,
            if break_before { "page" } else { "auto" },
        ));
        Some(name)
    }

    /// A `table-row` style for a height in points and a page break ahead of
    /// the row; `None` when the row needs neither. `fixed` is Excel's
    /// `customHeight`: without it the height is only the last auto-fit result
    /// and the reader may fit the row again.
    pub(crate) fn row(
        &mut self,
        height_points: Option<f64>,
        fixed: bool,
        break_before: bool,
    ) -> Option<String> {
        if height_points.is_none() && !break_before {
            return None;
        }
        let key = format!(
            "{}|{fixed}|{break_before}",
            height_points.map(|height| format!("{height:.2}")).unwrap_or_default()
        );
        if let Some(name) = self.row_styles.get(&key) {
            return Some(name.clone());
        }
        let name = self.next_name("ro");
        self.row_styles.insert(key, name.clone());
        let height = height_points
            .map(|height| {
                format!(
                    r#" style:row-height="{height:.2}pt" style:use-optimal-row-height="{}""#,
                    if fixed { "false" } else { "true" }
                )
            })
            .unwrap_or_default();
        self.row_bodies.push(format!(
            r#"<style:style style:name="{name}" style:family="table-row"><style:table-row-properties{height} fo:break-before="{}"/></style:style>"#,
            if break_before { "page" } else { "auto" },
        ));
        Some(name)
    }

    /// A `text` style for one run of a cell whose text carries its own
    /// formatting; `None` when the run sets nothing.
    ///
    /// A run only says what it turns on. Excel writes a run's whole font, but
    /// the model cannot tell "not bold" from "says nothing about bold", and
    /// turning a property off here would undo the cell's own style for every
    /// plain run.
    pub(crate) fn text_run(&mut self, run: &RichRun) -> Option<String> {
        let mut text = String::new();
        if let Some(family) = run.family.as_ref().filter(|family| !family.is_empty()) {
            if font_family_differs(&self.base, family) {
                self.fonts.insert(family.clone());
                text.push_str(&self.font_names(family, None));
            }
        }
        if let Some(size) = run.size.filter(|size| *size > 0.0) {
            if self.base.font_size.map(|base| (base - size).abs() > 1e-6) != Some(false) {
                text.push_str(&font_size_attributes(size));
            }
        }
        if run.bold {
            text.push_str(&font_weight_attributes(true));
        }
        if run.italic {
            text.push_str(&font_style_attributes(true));
        }
        if run.underline {
            text.push_str(
                r#" style:text-underline-style="solid" style:text-underline-type="single" style:text-underline-width="auto" style:text-underline-color="font-color""#,
            );
        }
        if run.strikethrough {
            text.push_str(
                r#" style:text-line-through-style="solid" style:text-line-through-type="single""#,
            );
        }
        if let Some(color) = run.color.as_ref().filter(|color| !color.is_empty()) {
            text.push_str(&format!(r#" fo:color="{}""#, escape_xml(color)));
        }
        if let Some(position) = text_position(run.vert_align.as_deref()) {
            text.push_str(&format!(r#" style:text-position="{position}""#));
        }
        if text.is_empty() {
            return None;
        }
        if let Some(name) = self.text_styles.get(&text) {
            return Some(name.clone());
        }
        let name = self.next_name("T");
        self.text_styles.insert(text.clone(), name.clone());
        self.text_bodies.push(format!(
            r#"<style:style style:name="{name}" style:family="text"><style:text-properties{text}/></style:style>"#
        ));
        Some(name)
    }

    /// The data style for a number format outside a cell — a chart axis or
    /// its data labels — and `None` for a format that needs none.
    pub(crate) fn number_format_style(&mut self, format: &str) -> Option<String> {
        self.data_style(Some(format)).0
    }

    /// The data styles alone, for a document that has no cells of its own.
    pub(crate) fn data_styles(&self) -> String {
        self.data_bodies.concat()
    }

    /// The named style a conditional format applies for a differential
    /// style. A differential style only says what it changes, so it is
    /// written against an empty base rather than the workbook's default: a
    /// rule that turns text bold must say so even in a workbook whose default
    /// is bold.
    pub(crate) fn conditional_style(&mut self, dxf: &CellStyle) -> String {
        let base = std::mem::take(&mut self.base);
        let inner = self.cell_properties(dxf);
        self.base = base;
        if let Some(name) = self.conditional_names.get(&inner) {
            return name.clone();
        }
        let name = format!("ConditionalStyle_{}", self.conditional_bodies.len() + 1);
        self.conditional_names.insert(inner.clone(), name.clone());
        self.conditional_bodies.push((name.clone(), inner));
        name
    }

    /// The conditional styles, for `<office:styles>`: a conditional format
    /// can only name a style that is not automatic.
    pub(crate) fn conditional_styles(&self) -> String {
        self.conditional_bodies
            .iter()
            .map(|(name, inner)| {
                format!(
                    r#"<style:style style:name="{name}" style:family="table-cell" style:parent-style-name="{DEFAULT_CELL_STYLE}">{inner}</style:style>"#
                )
            })
            .collect()
    }

    /// The `<office:automatic-styles>` content: data styles first (the cell
    /// styles point at them), then cell, column, row and text styles.
    pub(crate) fn automatic_styles(&self) -> String {
        let mut out = String::new();
        for body in &self.data_bodies {
            out.push_str(body);
        }
        for (name, data, inner) in &self.cell_bodies {
            out.push_str(&format!(
                r#"<style:style style:name="{name}" style:family="table-cell" style:parent-style-name="{DEFAULT_CELL_STYLE}"{}>{inner}</style:style>"#,
                data.as_ref()
                    .map(|data| format!(r#" style:data-style-name="{data}""#))
                    .unwrap_or_default(),
            ));
        }
        for body in &self.column_bodies {
            out.push_str(body);
        }
        for body in &self.row_bodies {
            out.push_str(body);
        }
        for body in &self.text_bodies {
            out.push_str(body);
        }
        out
    }

    /// `<office:font-face-decls>` for the fonts the cells name. ODF wants a
    /// declaration before a style may reference the font by name.
    pub(crate) fn font_face_decls(&self) -> String {
        let mut out = String::new();
        for family in &self.fonts {
            out.push_str(&format!(
                r#"<style:font-face style:name="{}" svg:font-family="{}"/>"#,
                escape_xml(family),
                escape_xml(&font_family_value(family)),
            ));
        }
        out
    }

    /// Registers a font a header or footer names, so it is declared too.
    pub(crate) fn declare_font(&mut self, family: &str) {
        if !family.is_empty() {
            self.fonts.insert(family.to_owned());
        }
    }

    /// The default cell style for `styles.xml`: the workbook's Normal xf, and
    /// the named style default-looking cells point at.
    pub(crate) fn default_cell_style(&self) -> String {
        let mut text = String::new();
        if let Some(family) = &self.base.font_family {
            text.push_str(&self.font_names(family, self.base.font_scheme.as_deref()));
        }
        if let Some(size) = self.base.font_size {
            text.push_str(&font_size_attributes(size));
        }
        if let Some(color) = &self.base.font_color {
            text.push_str(&format!(r#" fo:color="{}""#, escape_xml(color)));
        }
        if self.base.bold {
            text.push_str(&font_weight_attributes(true));
        }
        if self.base.italic {
            text.push_str(&font_style_attributes(true));
        }
        let mut cell = String::from(r#" fo:padding="0.02in""#);
        if let Some(fill) = &self.base.fill_color {
            cell.push_str(&format!(
                r#" fo:background-color="{}""#,
                escape_xml(fill)
            ));
        }
        let mut out = String::from(r#"<style:default-style style:family="table-cell">"#);
        out.push_str(&format!("<style:table-cell-properties{cell}/>"));
        out.push_str(r#"<style:paragraph-properties fo:margin="0in"/>"#);
        out.push_str(&format!("<style:text-properties{text}/>"));
        out.push_str("</style:default-style>");
        out.push_str(&format!(
            r#"<style:style style:name="{DEFAULT_CELL_STYLE}" style:family="table-cell"/>"#
        ));
        out
    }
}

fn font_size_attributes(size: f64) -> String {
    format!(
        r#" fo:font-size="{size}pt" style:font-size-asian="{size}pt" style:font-size-complex="{size}pt""#
    )
}

fn font_weight_attributes(bold: bool) -> String {
    let weight = if bold { "bold" } else { "normal" };
    format!(
        r#" fo:font-weight="{weight}" style:font-weight-asian="{weight}" style:font-weight-complex="{weight}""#
    )
}

fn font_style_attributes(italic: bool) -> String {
    let style = if italic { "italic" } else { "normal" };
    format!(
        r#" fo:font-style="{style}" style:font-style-asian="{style}" style:font-style-complex="{style}""#
    )
}

/// `svg:font-family` quotes a name that holds a space.
fn font_family_value(family: &str) -> String {
    if family.contains(' ') && !family.starts_with('\'') {
        format!("'{family}'")
    } else {
        family.to_owned()
    }
}

fn text_position(align: Option<&str>) -> Option<&'static str> {
    match align {
        Some("superscript") => Some("super 58%"),
        Some("subscript") => Some("sub 58%"),
        _ => None,
    }
}

fn font_family_differs(base: &CellStyle, family: &str) -> bool {
    base.font_family.as_deref() != Some(family)
}

/// True when the base xf has an edge this style turns off; ODF needs the
/// explicit `none` for that.
fn stroke_only(base: &CellStyle, style: &CellStyle) -> bool {
    let edge = |value: &Option<BorderEdge>| value.is_some();
    (edge(&base.border_top) && !edge(&style.border_top))
        || (edge(&base.border_bottom) && !edge(&style.border_bottom))
        || (edge(&base.border_left) && !edge(&style.border_left))
        || (edge(&base.border_right) && !edge(&style.border_right))
}

/// An OOXML border token as the ODF line it paints.
fn border_line(edge: &BorderEdge) -> String {
    let (width, style) = match edge.style.as_str() {
        "hair" => ("0.50", "solid"),
        "thin" => ("0.75", "solid"),
        "medium" => ("1.50", "solid"),
        "thick" => ("2.25", "solid"),
        "double" => ("1.50", "double"),
        "dotted" => ("0.75", "dotted"),
        "dashed" | "dashDot" | "dashDotDot" => ("0.75", "dashed"),
        "mediumDashed" | "mediumDashDot" | "mediumDashDotDot" | "slantDashDot" => {
            ("1.50", "dashed")
        }
        _ => ("0.75", "solid"),
    };
    format!(
        "{width}pt {style} {}",
        edge.color.as_deref().unwrap_or("#000000")
    )
}

impl CellStyle {
    /// True when nothing about this xf differs from the document default.
    fn is_default_like(&self, base: &CellStyle) -> bool {
        number_format_key(self) == number_format_key(base)
            && self.fill_color == base.fill_color
            && self.border_top.is_none()
            && self.border_bottom.is_none()
            && self.border_left.is_none()
            && self.border_right.is_none()
            && !(self.border_diagonal.is_some() && (self.diagonal_up || self.diagonal_down))
            && self.horizontal_alignment.is_none()
            && self.vertical_alignment.is_none()
            && self.indent.is_none()
            && !self.wrap_text
            && !self.shrink_to_fit
            && self.text_rotation.unwrap_or(0) == 0
            && self.locked != Some(false)
            && self.hidden != Some(true)
            && self.font_family.as_deref() == base.font_family.as_deref()
            && self.font_size == base.font_size
            && self.bold == base.bold
            && self.italic == base.italic
            && self.underline == base.underline
            && self.strikethrough == base.strikethrough
            && self.vert_align == base.vert_align
            && self.font_color == base.font_color
    }
}

/// A number format code that asks for nothing beyond the plain number, as a
/// key two styles can be compared by.
fn number_format_key(style: &CellStyle) -> Option<&str> {
    style
        .number_format
        .as_deref()
        .map(str::trim)
        .filter(|code| !code.is_empty() && !code.eq_ignore_ascii_case("general"))
}

// ---------------------------------------------------------------------------
// Number-format analysis
// ---------------------------------------------------------------------------

/// The digits a number section asks for.
#[derive(Default, Debug, PartialEq)]
struct NumberSpec {
    /// `General`: no fixed decimals, as many as the value needs.
    general: bool,
    decimals: u32,
    /// Decimals always shown (`0`), as opposed to shown when present (`#`).
    min_decimals: u32,
    min_integer_digits: u32,
    grouping: bool,
    /// Trailing `,` after the digits: each one divides the value by 1000.
    thousands: u32,
    /// Text between the integer digits, with the number of digits to its
    /// right: `000"-"00` shows 5 as `000-05`.
    embedded: Vec<(u32, String)>,
}

/// One field of a date or time format, in the order the code spells it.
#[derive(Debug)]
enum Field {
    Year { long: bool },
    Month { long: bool, textual: bool },
    Day { long: bool },
    DayOfWeek { long: bool },
    Hour { long: bool },
    Minute { long: bool },
    Second { long: bool, decimals: u32 },
    AmPm,
    Text(String),
}

/// A piece of a numeric section in reading order: literal text, a currency
/// symbol, or the place the value itself takes.
#[derive(Debug, PartialEq)]
enum Part {
    Text(String),
    Currency(String),
    Value,
}

/// What one `;`-separated section formats.
#[derive(Debug)]
enum Body {
    Number { parts: Vec<Part>, spec: NumberSpec, percent: bool },
    Scientific {
        parts: Vec<Part>,
        decimals: u32,
        min_decimals: u32,
        min_integer_digits: u32,
        interval: u32,
        exponent_digits: u32,
        forced_sign: bool,
    },
    Fraction {
        parts: Vec<Part>,
        /// `None` when the code has no whole part in front of the fraction.
        min_integer_digits: Option<u32>,
        numerator_digits: u32,
        denominator_digits: u32,
        fixed_denominator: Option<u32>,
    },
    /// `@`: the cell's text, with literal text around it.
    Text { parts: Vec<Part> },
    Calendar { fields: Vec<Field>, time_only: bool, elapsed: bool },
    /// Literal text only, or nothing: `"-"` for a zero, an empty section to
    /// hide a value.
    Literal(String),
    Unknown,
}

#[derive(Debug)]
struct Section {
    color: Option<&'static str>,
    /// `[>=100]`: the comparison and its number.
    condition: Option<(String, String)>,
    body: Body,
}

/// A token the scanner emits before the section is classified.
#[derive(Debug)]
enum Raw {
    Year(u32),
    MonthOrMinute(u32),
    Day(u32),
    DayName(u32),
    Hour(u32),
    Second(u32),
    Elapsed(char),
    AmPm,
    Text(String),
    Currency(String),
    General,
    Zero,
    Hash,
    Question,
    Decimal,
    Group,
    Percent,
    Slash,
    /// `E+` (sign always shown) or `E-`.
    Exponent(bool),
    At,
}

impl Raw {
    fn is_digit(&self) -> bool {
        matches!(self, Raw::Zero | Raw::Hash | Raw::Question)
    }

    fn is_calendar(&self) -> bool {
        matches!(
            self,
            Raw::Year(_)
                | Raw::MonthOrMinute(_)
                | Raw::Day(_)
                | Raw::DayName(_)
                | Raw::Hour(_)
                | Raw::Second(_)
                | Raw::Elapsed(_)
                | Raw::AmPm
        )
    }
}

/// Everything a format code turns into: the styles to write and what kind of
/// value the cell then holds.
struct DataStylePlan {
    kind: ValueKind,
    /// Sections a `style:map` sends values to, with their conditions.
    mapped: Vec<(String, Section)>,
    main: Section,
}

impl DataStylePlan {
    fn xml(&self, name: &str) -> String {
        let mut out = String::new();
        let mut maps = String::new();
        for (index, (condition, section)) in self.mapped.iter().enumerate() {
            let sub = format!("{name}P{index}");
            out.push_str(&section_xml(&sub, section, "", true));
            maps.push_str(&format!(
                r#"<style:map style:condition="value(){}" style:apply-style-name="{sub}"/>"#,
                escape_xml(condition)
            ));
        }
        out.push_str(&section_xml(name, &self.main, &maps, false));
        out
    }
}

/// Reads a whole format code. `None` when it asks for nothing (`General`) or
/// for something this module cannot write.
fn data_style_plan(code: &str) -> Option<DataStylePlan> {
    let mut sections: Vec<Section> = split_sections(code).into_iter().map(section).collect();
    if sections.is_empty() {
        return None;
    }
    if let Body::Calendar { time_only, .. } = &sections[0].body {
        // A date code's later sections (negative dates, text) have no ODF
        // counterpart worth the conditions; the first is the one Excel shows.
        let kind = if *time_only { ValueKind::Time } else { ValueKind::Date };
        return Some(DataStylePlan {
            kind,
            mapped: Vec::new(),
            main: sections.remove(0),
        });
    }
    // The text section says how a text cell looks. With four sections it is
    // the fourth, whatever it holds — an empty one hides the text; otherwise
    // it is a last section that names the text with `@`.
    let text_section = if sections.len() >= 4 {
        let fourth = sections.remove(3);
        Some(match fourth.body {
            Body::Literal(text) => Section {
                color: fourth.color,
                condition: None,
                body: Body::Text {
                    parts: if text.is_empty() { Vec::new() } else { vec![Part::Text(text)] },
                },
            },
            _ => fourth,
        })
    } else if sections.len() > 1
        && matches!(sections.last().map(|section| &section.body), Some(Body::Text { .. }))
    {
        sections.pop()
    } else {
        None
    };
    let text_section = text_section.filter(|section| matches!(section.body, Body::Text { .. }));
    sections.truncate(3);
    if sections
        .iter()
        .any(|section| matches!(section.body, Body::Unknown | Body::Calendar { .. }))
    {
        return None;
    }
    if let Some(text_section) = text_section {
        // Every number section is reached by a condition and the text
        // section is what is left: the style a text cell falls through to.
        let defaults: &[&str] = match sections.len() {
            1 => &[">=0"],
            2 => &[">=0", "<0"],
            _ => &[">0", "<0", "=0"],
        };
        let alone = sections.len() == 1;
        let mut mapped: Vec<(String, Section)> = sections
            .into_iter()
            .zip(defaults)
            .map(|(section, default)| {
                let condition = section
                    .condition
                    .as_ref()
                    .map(|(operator, value)| format!("{operator}{value}"))
                    .unwrap_or_else(|| (*default).to_owned());
                (condition, section)
            })
            .collect();
        if alone {
            // One section formats every number, and a section reached by a
            // condition is handed the number without its sign: the negative
            // side needs its own copy that says the minus.
            let mut negative = section(split_sections(code)[0]);
            let signed = match &mut negative.body {
                Body::Number { parts, .. }
                | Body::Scientific { parts, .. }
                | Body::Fraction { parts, .. } => {
                    parts.insert(0, Part::Text("-".to_owned()));
                    true
                }
                _ => false,
            };
            if signed && negative.condition.is_none() {
                mapped.push(("<0".to_owned(), negative));
            }
        }
        return Some(DataStylePlan {
            kind: ValueKind::Number,
            mapped,
            main: text_section,
        });
    }
    if sections.len() == 1 {
        let only = sections.remove(0);
        if let Body::Number { parts, spec, percent } = &only.body {
            let plain = parts.len() == 1 && spec.general && !percent && only.color.is_none();
            if plain {
                return None;
            }
        }
        return Some(DataStylePlan {
            kind: ValueKind::Number,
            mapped: Vec::new(),
            main: only,
        });
    }
    let main = sections.pop()?;
    let defaults: &[&str] = if sections.len() == 1 { &[">=0"] } else { &[">0", "<0"] };
    let mapped = sections
        .into_iter()
        .zip(defaults)
        .map(|(section, default)| {
            let condition = section
                .condition
                .as_ref()
                .map(|(operator, value)| format!("{operator}{value}"))
                .unwrap_or_else(|| (*default).to_owned());
            (condition, section)
        })
        .collect();
    Some(DataStylePlan {
        kind: ValueKind::Number,
        mapped,
        main,
    })
}

/// The `;`-separated sections of a code, outside quotes and brackets.
fn split_sections(code: &str) -> Vec<&str> {
    let mut sections = Vec::new();
    let mut quoted = false;
    let mut bracketed = false;
    let mut escaped = false;
    let mut start = 0;
    for (index, character) in code.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        match character {
            '\\' if !quoted => escaped = true,
            '"' => quoted = !quoted,
            '[' if !quoted => bracketed = true,
            ']' if !quoted => bracketed = false,
            ';' if !quoted && !bracketed => {
                sections.push(&code[start..index]);
                start = index + 1;
            }
            _ => {}
        }
    }
    sections.push(&code[start..]);
    sections
}

fn section(text: &str) -> Section {
    let mut tokens: Vec<Raw> = Vec::new();
    let mut color = None;
    let mut condition = None;
    let mut characters = text.chars().peekable();
    while let Some(character) = characters.next() {
        match character {
            '"' => {
                let mut literal = String::new();
                for next in characters.by_ref() {
                    if next == '"' {
                        break;
                    }
                    literal.push(next);
                }
                if is_currency_symbol(&literal) {
                    tokens.push(Raw::Currency(literal));
                } else if !literal.is_empty() {
                    tokens.push(Raw::Text(literal));
                }
            }
            '\\' => {
                if let Some(literal) = characters.next() {
                    tokens.push(Raw::Text(literal.to_string()));
                }
            }
            // `_x` reserves the width of x and `*x` repeats x to fill the
            // cell; neither is part of the value's shape.
            '_' | '*' => {
                characters.next();
            }
            '[' => {
                let mut inner = String::new();
                for next in characters.by_ref() {
                    if next == ']' {
                        break;
                    }
                    inner.push(next);
                }
                let lower = inner.to_ascii_lowercase();
                if !lower.is_empty() && lower.chars().all(|ch| matches!(ch, 'h' | 'm' | 's')) {
                    tokens.push(Raw::Elapsed(lower.chars().next().unwrap_or('h')));
                } else if inner.starts_with('$') {
                    if let Some(symbol) = currency_in_bracket(&inner) {
                        tokens.push(Raw::Currency(symbol));
                    }
                } else if let Some(named) = named_color(&lower) {
                    color = Some(named);
                } else if let Some(parsed) = bracket_condition(&inner) {
                    condition = Some(parsed);
                }
            }
            'y' | 'Y' => tokens.push(Raw::Year(run_length(character, &mut characters))),
            'm' | 'M' => tokens.push(Raw::MonthOrMinute(run_length(character, &mut characters))),
            'd' | 'D' => tokens.push(Raw::Day(run_length(character, &mut characters))),
            'h' | 'H' => tokens.push(Raw::Hour(run_length(character, &mut characters))),
            's' | 'S' => tokens.push(Raw::Second(run_length(character, &mut characters))),
            'a' | 'A' => {
                let rest: String = characters.clone().collect();
                let upper = rest.to_ascii_uppercase();
                if upper.starts_with("M/PM") {
                    for _ in 0..4 {
                        characters.next();
                    }
                    tokens.push(Raw::AmPm);
                } else if upper.starts_with("/P") {
                    for _ in 0..2 {
                        characters.next();
                    }
                    tokens.push(Raw::AmPm);
                } else {
                    // `aaa` / `aaaa`: the weekday name East Asian codes use.
                    let count = run_length(character, &mut characters);
                    if count >= 3 {
                        tokens.push(Raw::DayName(count));
                    } else {
                        tokens.push(Raw::Text(character.to_string().repeat(count as usize)));
                    }
                }
            }
            'g' | 'G' => {
                let rest: String = characters.clone().take(6).collect();
                if rest.eq_ignore_ascii_case("eneral") {
                    for _ in 0..6 {
                        characters.next();
                    }
                    tokens.push(Raw::General);
                } else {
                    tokens.push(Raw::Text(character.to_string()));
                }
            }
            'e' | 'E' => match characters.peek() {
                Some('+') => {
                    characters.next();
                    tokens.push(Raw::Exponent(true));
                }
                Some('-') => {
                    characters.next();
                    tokens.push(Raw::Exponent(false));
                }
                _ => tokens.push(Raw::Text(character.to_string())),
            },
            '0' => tokens.push(Raw::Zero),
            '#' => tokens.push(Raw::Hash),
            '?' => tokens.push(Raw::Question),
            '.' => {
                if tokens.last().is_some_and(Raw::is_digit)
                    || matches!(characters.peek(), Some('0' | '#' | '?'))
                {
                    tokens.push(Raw::Decimal);
                } else {
                    tokens.push(Raw::Text(".".into()));
                }
            }
            ',' => {
                if matches!(
                    tokens.last(),
                    Some(Raw::Zero | Raw::Hash | Raw::Question | Raw::Decimal | Raw::Group)
                ) {
                    tokens.push(Raw::Group);
                } else {
                    tokens.push(Raw::Text(",".into()));
                }
            }
            '/' => tokens.push(Raw::Slash),
            '%' => tokens.push(Raw::Percent),
            '@' => tokens.push(Raw::At),
            character if is_currency_character(character) => {
                tokens.push(Raw::Currency(character.to_string()));
            }
            _ => tokens.push(Raw::Text(character.to_string())),
        }
    }
    let body = if tokens.iter().any(Raw::is_calendar) {
        calendar_body(&tokens)
    } else {
        numeric_body(&tokens)
    };
    Section {
        color,
        condition,
        body,
    }
}

fn run_length(character: char, characters: &mut std::iter::Peekable<std::str::Chars<'_>>) -> u32 {
    let mut count = 1;
    while characters
        .peek()
        .is_some_and(|next| next.eq_ignore_ascii_case(&character))
    {
        characters.next();
        count += 1;
    }
    count
}

/// A quoted literal that is nothing but a currency sign, with or without the
/// letters some locales put beside it (`US$`).
fn is_currency_symbol(text: &str) -> bool {
    text.chars().any(is_currency_character)
        && text.chars().count() <= 3
        && text
            .chars()
            .all(|character| is_currency_character(character) || character.is_ascii_alphabetic())
}

fn is_currency_character(character: char) -> bool {
    matches!(character, '$' | '€' | '£' | '¥' | '₩' | '₹' | '₽' | '¢')
}

/// `[$€-407]` and `[$$-409]` carry the symbol between `[$` and `-`; a bare
/// `[$-412]` only names a locale.
fn currency_in_bracket(inner: &str) -> Option<String> {
    let inner = inner.strip_prefix('$')?;
    let (symbol, _) = inner.split_once('-').unwrap_or((inner, ""));
    let symbol = symbol.trim();
    if symbol.is_empty() {
        return None;
    }
    Some(symbol.to_owned())
}

fn named_color(lower: &str) -> Option<&'static str> {
    Some(match lower {
        "black" => "#000000",
        "blue" => "#0000FF",
        "cyan" => "#00FFFF",
        "green" => "#00FF00",
        "magenta" => "#FF00FF",
        "red" => "#FF0000",
        "white" => "#FFFFFF",
        "yellow" => "#FFFF00",
        _ => return None,
    })
}

/// `[>=100]` → `(">=", "100")`.
fn bracket_condition(inner: &str) -> Option<(String, String)> {
    let inner = inner.trim();
    let operator_len = inner
        .chars()
        .take_while(|character| matches!(character, '<' | '>' | '='))
        .count();
    if operator_len == 0 {
        return None;
    }
    let (operator, value) = inner.split_at(operator_len);
    let value = value.trim();
    value.parse::<f64>().ok()?;
    let operator = match operator {
        "<>" => "!=",
        "<" | "<=" | ">" | ">=" | "=" => operator,
        _ => return None,
    };
    Some((operator.to_owned(), value.to_owned()))
}

/// Literal text and currency signs as parts; `None` for a token that has no
/// place outside the digits.
fn literal_part(token: &Raw) -> Option<Part> {
    match token {
        Raw::Text(text) => Some(Part::Text(text.clone())),
        Raw::Currency(symbol) => Some(Part::Currency(symbol.clone())),
        Raw::Percent => Some(Part::Text("%".into())),
        Raw::Slash => Some(Part::Text("/".into())),
        _ => None,
    }
}

/// The parts around a value that sits in `tokens[first..=last]`.
fn parts_around(tokens: &[Raw], first: usize, last: usize) -> Option<Vec<Part>> {
    let mut parts = Vec::new();
    for token in &tokens[..first] {
        parts.push(literal_part(token)?);
    }
    parts.push(Part::Value);
    for token in &tokens[last + 1..] {
        parts.push(literal_part(token)?);
    }
    Some(merge_text(parts))
}

fn merge_text(parts: Vec<Part>) -> Vec<Part> {
    let mut merged: Vec<Part> = Vec::new();
    for part in parts {
        match (merged.last_mut(), part) {
            (Some(Part::Text(previous)), Part::Text(text)) => previous.push_str(&text),
            (_, part) => merged.push(part),
        }
    }
    merged
}

fn numeric_body(tokens: &[Raw]) -> Body {
    let has_digits = tokens.iter().any(Raw::is_digit);
    let general = tokens.iter().position(|token| matches!(token, Raw::General));
    let at = tokens.iter().position(|token| matches!(token, Raw::At));
    if !has_digits && general.is_none() {
        if let Some(at) = at {
            return match parts_around(tokens, at, at) {
                Some(parts) => Body::Text { parts },
                None => Body::Unknown,
            };
        }
        let mut text = String::new();
        for token in tokens {
            match literal_part(token) {
                Some(Part::Text(piece)) | Some(Part::Currency(piece)) => text.push_str(&piece),
                _ => return Body::Unknown,
            }
        }
        return Body::Literal(text);
    }
    if at.is_some() {
        return Body::Unknown;
    }
    if let Some(body) = fixed_fraction_body(tokens) {
        return body;
    }
    if let Some(general) = general {
        if has_digits {
            return Body::Unknown;
        }
        return match parts_around(tokens, general, general) {
            Some(parts) => Body::Number {
                parts,
                spec: NumberSpec {
                    general: true,
                    min_integer_digits: 1,
                    ..NumberSpec::default()
                },
                percent: tokens.iter().any(|token| matches!(token, Raw::Percent)),
            },
            None => Body::Unknown,
        };
    }
    if tokens.iter().any(|token| matches!(token, Raw::Exponent(_))) {
        return scientific_body(tokens);
    }
    let first = tokens.iter().position(Raw::is_digit).unwrap_or(0);
    let last = tokens.iter().rposition(Raw::is_digit).unwrap_or(first);
    if tokens[first..=last]
        .iter()
        .any(|token| matches!(token, Raw::Slash))
    {
        return fraction_body(tokens, first, last);
    }
    plain_number_body(tokens, first, last)
}

fn plain_number_body(tokens: &[Raw], first: usize, mut last: usize) -> Body {
    // Commas right after the last digit scale the value instead of grouping.
    while matches!(tokens.get(last + 1), Some(Raw::Group)) {
        last += 1;
    }
    let middle = &tokens[first..=last];
    let point = middle
        .iter()
        .position(|token| matches!(token, Raw::Decimal));
    let integer_end = point.unwrap_or(middle.len());
    let integer_digits = middle[..integer_end]
        .iter()
        .filter(|token| token.is_digit())
        .count() as u32;
    let mut spec = NumberSpec::default();
    let mut seen_integer = 0u32;
    for (index, token) in middle.iter().enumerate() {
        let after_point = point.is_some_and(|point| index > point);
        match token {
            Raw::Zero | Raw::Hash | Raw::Question => {
                if after_point {
                    spec.decimals += 1;
                    if matches!(token, Raw::Zero) {
                        spec.min_decimals += 1;
                    }
                } else {
                    seen_integer += 1;
                    if matches!(token, Raw::Zero) {
                        spec.min_integer_digits += 1;
                    }
                }
            }
            Raw::Decimal => {}
            Raw::Group => {
                let digit_follows = middle[index + 1..integer_end.max(index + 1)]
                    .iter()
                    .any(Raw::is_digit);
                if !after_point && digit_follows {
                    spec.grouping = true;
                } else {
                    spec.thousands += 1;
                }
            }
            other => {
                // Text between the integer digits travels as embedded text;
                // between the decimals ODF has no place for it.
                let text = match literal_part(other) {
                    Some(Part::Text(text)) | Some(Part::Currency(text)) => text,
                    _ => return Body::Unknown,
                };
                if after_point {
                    return Body::Unknown;
                }
                spec.embedded.push((integer_digits - seen_integer, text));
            }
        }
    }
    let Some(parts) = parts_around(tokens, first, last) else {
        return Body::Unknown;
    };
    Body::Number {
        parts,
        spec,
        percent: tokens.iter().any(|token| matches!(token, Raw::Percent)),
    }
}

fn scientific_body(tokens: &[Raw]) -> Body {
    let Some(exponent) = tokens
        .iter()
        .position(|token| matches!(token, Raw::Exponent(_)))
    else {
        return Body::Unknown;
    };
    let Some(first) = tokens.iter().position(Raw::is_digit) else {
        return Body::Unknown;
    };
    let last = tokens.iter().rposition(Raw::is_digit).unwrap_or(exponent);
    if first > exponent || last < exponent {
        return Body::Unknown;
    }
    let mantissa = &tokens[first..exponent];
    let point = mantissa
        .iter()
        .position(|token| matches!(token, Raw::Decimal));
    let mut decimals = 0;
    let mut min_decimals = 0;
    let mut min_integer_digits = 0;
    let mut interval = 0;
    for (index, token) in mantissa.iter().enumerate() {
        let after_point = point.is_some_and(|point| index > point);
        match token {
            Raw::Zero | Raw::Hash | Raw::Question if after_point => {
                decimals += 1;
                if matches!(token, Raw::Zero) {
                    min_decimals += 1;
                }
            }
            Raw::Zero | Raw::Hash | Raw::Question => {
                interval += 1;
                if matches!(token, Raw::Zero) {
                    min_integer_digits += 1;
                }
            }
            Raw::Decimal => {}
            _ => return Body::Unknown,
        }
    }
    if !tokens[exponent + 1..=last].iter().all(Raw::is_digit) {
        return Body::Unknown;
    }
    let Some(parts) = parts_around(tokens, first, last) else {
        return Body::Unknown;
    };
    Body::Scientific {
        parts,
        decimals,
        min_decimals,
        min_integer_digits,
        interval,
        exponent_digits: (last - exponent) as u32,
        forced_sign: matches!(tokens[exponent], Raw::Exponent(true)),
    }
}

fn fraction_body(tokens: &[Raw], first: usize, last: usize) -> Body {
    let Some(slash) = tokens[first..=last]
        .iter()
        .position(|token| matches!(token, Raw::Slash))
        .map(|offset| first + offset)
    else {
        return Body::Unknown;
    };
    // Numerator: the digits right in front of the slash.
    let mut numerator_start = slash;
    while numerator_start > first && tokens[numerator_start - 1].is_digit() {
        numerator_start -= 1;
    }
    let numerator_digits = (slash - numerator_start) as u32;
    if numerator_digits == 0 {
        return Body::Unknown;
    }
    // Whole part: any digits before that, separated by literal text.
    let whole = &tokens[first..numerator_start];
    let has_whole = whole.iter().any(Raw::is_digit);
    if whole
        .iter()
        .any(|token| !(token.is_digit() || matches!(token, Raw::Text(_))))
    {
        return Body::Unknown;
    }
    let min_integer_digits = has_whole.then(|| {
        whole
            .iter()
            .filter(|token| matches!(token, Raw::Zero))
            .count() as u32
    });
    // Denominator: placeholders, or a fixed number written in digits.
    let denominator = &tokens[slash + 1..=last];
    if !denominator.iter().all(Raw::is_digit) {
        return Body::Unknown;
    }
    let Some(parts) = parts_around(tokens, first, last) else {
        return Body::Unknown;
    };
    Body::Fraction {
        parts,
        min_integer_digits,
        numerator_digits,
        denominator_digits: denominator.len() as u32,
        fixed_denominator: None,
    }
}

/// `# ?/8`: a fraction whose denominator is written out. The scanner hands the
/// digits over as text, so the shape is recognised before the general rules.
fn fixed_fraction_body(tokens: &[Raw]) -> Option<Body> {
    let slash = tokens.iter().position(|token| matches!(token, Raw::Slash))?;
    let mut end = slash + 1;
    let mut digits = String::new();
    while let Some(Raw::Text(text)) = tokens.get(end) {
        if !text.chars().all(|character| character.is_ascii_digit()) {
            break;
        }
        digits.push_str(text);
        end += 1;
    }
    let fixed: u32 = digits.parse().ok().filter(|value| *value > 0)?;
    let first = tokens.iter().position(Raw::is_digit)?;
    if first > slash {
        return None;
    }
    let mut numerator_start = slash;
    while numerator_start > first && tokens[numerator_start - 1].is_digit() {
        numerator_start -= 1;
    }
    let numerator_digits = (slash - numerator_start) as u32;
    if numerator_digits == 0 {
        return None;
    }
    let whole = &tokens[first..numerator_start];
    if whole
        .iter()
        .any(|token| !(token.is_digit() || matches!(token, Raw::Text(_))))
    {
        return None;
    }
    let has_whole = whole.iter().any(Raw::is_digit);
    let mut parts = Vec::new();
    for token in &tokens[..first] {
        parts.push(literal_part(token)?);
    }
    parts.push(Part::Value);
    for token in &tokens[end..] {
        parts.push(literal_part(token)?);
    }
    Some(Body::Fraction {
        parts: merge_text(parts),
        min_integer_digits: has_whole.then(|| {
            whole
                .iter()
                .filter(|token| matches!(token, Raw::Zero))
                .count() as u32
        }),
        numerator_digits,
        denominator_digits: digits.len() as u32,
        fixed_denominator: Some(fixed),
    })
}

fn calendar_body(tokens: &[Raw]) -> Body {
    let fields = calendar_fields(tokens);
    let has_date = fields.iter().any(|field| {
        matches!(
            field,
            Field::Year { .. } | Field::Month { .. } | Field::Day { .. } | Field::DayOfWeek { .. }
        )
    });
    Body::Calendar {
        fields,
        time_only: !has_date,
        // `[h]`, `[m]` or `[s]` is the one thing an Excel code says about a
        // value running past a day, so it decides whether the ODF time style
        // may truncate at 24 hours.
        elapsed: tokens.iter().any(|token| matches!(token, Raw::Elapsed(_))),
    }
}

/// Date and time fields in the code's own order, with each `m` decided between
/// month and minute.
fn calendar_fields(tokens: &[Raw]) -> Vec<Field> {
    let mut fields = Vec::new();
    let mut skip = 0usize;
    for (index, token) in tokens.iter().enumerate() {
        if skip > 0 {
            skip -= 1;
            continue;
        }
        match token {
            Raw::Year(count) => fields.push(Field::Year { long: *count >= 3 }),
            Raw::MonthOrMinute(count) => {
                if is_minute(tokens, index) {
                    fields.push(Field::Minute { long: *count >= 2 });
                } else if *count >= 3 {
                    fields.push(Field::Month {
                        long: *count >= 4,
                        textual: true,
                    });
                } else {
                    fields.push(Field::Month {
                        long: *count >= 2,
                        textual: false,
                    });
                }
            }
            Raw::Day(count) => {
                if *count >= 3 {
                    fields.push(Field::DayOfWeek { long: *count >= 4 });
                } else {
                    fields.push(Field::Day { long: *count >= 2 });
                }
            }
            Raw::DayName(count) => fields.push(Field::DayOfWeek { long: *count >= 4 }),
            Raw::Hour(count) => fields.push(Field::Hour { long: *count >= 2 }),
            Raw::Second(count) => {
                // `ss.000`: the fraction digits belong to the seconds.
                let decimals = match tokens.get(index + 1) {
                    Some(Raw::Decimal) => tokens[index + 2..]
                        .iter()
                        .take_while(|next| next.is_digit())
                        .count(),
                    _ => 0,
                };
                if decimals > 0 {
                    skip = decimals + 1;
                }
                fields.push(Field::Second {
                    long: *count >= 2,
                    decimals: decimals as u32,
                });
            }
            Raw::Elapsed(unit) => match unit {
                'h' => fields.push(Field::Hour { long: true }),
                'm' => fields.push(Field::Minute { long: true }),
                _ => fields.push(Field::Second {
                    long: true,
                    decimals: 0,
                }),
            },
            Raw::AmPm => fields.push(Field::AmPm),
            Raw::Text(text) | Raw::Currency(text) => fields.push(Field::Text(text.clone())),
            Raw::Slash => fields.push(Field::Text("/".into())),
            Raw::Decimal => fields.push(Field::Text(".".into())),
            Raw::Group => fields.push(Field::Text(",".into())),
            Raw::Percent => fields.push(Field::Text("%".into())),
            _ => {}
        }
    }
    // Adjacent literals read better as one element.
    let mut merged: Vec<Field> = Vec::new();
    for field in fields {
        match (merged.last_mut(), field) {
            (Some(Field::Text(previous)), Field::Text(text)) => previous.push_str(&text),
            (_, field) => merged.push(field),
        }
    }
    merged
}

/// `m` is a minute when an hour came before it in the same time part, or when
/// it sits in front of `:ss`. Everything else is a month.
fn is_minute(tokens: &[Raw], index: usize) -> bool {
    let mut hour_before = false;
    let mut date_before = false;
    for token in &tokens[..index] {
        match token {
            Raw::Hour(_) | Raw::Elapsed('h') => {
                hour_before = true;
                date_before = false;
            }
            Raw::Year(_) | Raw::Day(_) | Raw::DayName(_) => date_before = true,
            _ => {}
        }
    }
    if hour_before && !date_before {
        return true;
    }
    let mut next = tokens[index + 1..].iter();
    match next.next() {
        Some(Raw::Text(text)) if text == ":" => matches!(next.next(), Some(Raw::Second(_))),
        _ => false,
    }
}

// ---------------------------------------------------------------------------
// Data-style XML
// ---------------------------------------------------------------------------

/// One section as a `number:*-style` element. `maps` are the conditions the
/// main style carries; `volatile` keeps a style no cell names directly.
fn section_xml(name: &str, section: &Section, maps: &str, volatile: bool) -> String {
    let volatile = if volatile {
        r#" style:volatile="true""#
    } else {
        ""
    };
    let color = section
        .color
        .map(|color| format!(r#"<style:text-properties fo:color="{color}"/>"#))
        .unwrap_or_default();
    match &section.body {
        Body::Calendar {
            fields,
            time_only,
            elapsed,
        } => calendar_style_xml(name, fields, *time_only, *elapsed),
        Body::Text { parts } => format!(
            r#"<number:text-style style:name="{name}"{volatile}>{color}{}{maps}</number:text-style>"#,
            parts_xml(parts, "<number:text-content/>"),
        ),
        Body::Literal(text) => format!(
            r#"<number:number-style style:name="{name}"{volatile}>{color}<number:text>{}</number:text>{maps}</number:number-style>"#,
            escape_xml(text),
        ),
        Body::Number { parts, spec, percent } => {
            let element = element_name(parts, *percent);
            format!(
                r#"<{element} style:name="{name}"{volatile}>{color}{}{maps}</{element}>"#,
                parts_xml(parts, &number_element(spec)),
            )
        }
        Body::Scientific {
            parts,
            decimals,
            min_decimals,
            min_integer_digits,
            interval,
            exponent_digits,
            forced_sign,
        } => {
            let element = element_name(parts, false);
            let mut attributes = format!(
                r#" number:decimal-places="{decimals}" number:min-decimal-places="{min_decimals}" number:min-integer-digits="{min_integer_digits}" number:min-exponent-digits="{exponent_digits}""#
            );
            if *interval > 1 {
                attributes.push_str(&format!(r#" number:exponent-interval="{interval}""#));
            }
            if *forced_sign {
                attributes.push_str(r#" number:forced-exponent-sign="true""#);
            }
            format!(
                r#"<{element} style:name="{name}"{volatile}>{color}{}{maps}</{element}>"#,
                parts_xml(parts, &format!("<number:scientific-number{attributes}/>")),
            )
        }
        Body::Fraction {
            parts,
            min_integer_digits,
            numerator_digits,
            denominator_digits,
            fixed_denominator,
        } => {
            let element = element_name(parts, false);
            let mut attributes = String::new();
            if let Some(digits) = min_integer_digits {
                attributes.push_str(&format!(r#" number:min-integer-digits="{digits}""#));
            }
            attributes.push_str(&format!(
                r#" number:min-numerator-digits="{numerator_digits}""#
            ));
            match fixed_denominator {
                Some(value) => {
                    attributes.push_str(&format!(r#" number:denominator-value="{value}""#));
                }
                None => {
                    attributes.push_str(&format!(
                        r#" number:min-denominator-digits="{denominator_digits}" number:max-denominator-value="{}""#,
                        10u64.pow((*denominator_digits).min(9)) - 1,
                    ));
                }
            }
            format!(
                r#"<{element} style:name="{name}"{volatile}>{color}{}{maps}</{element}>"#,
                parts_xml(parts, &format!("<number:fraction{attributes}/>")),
            )
        }
        Body::Unknown => String::new(),
    }
}

fn element_name(parts: &[Part], percent: bool) -> &'static str {
    if percent {
        "number:percentage-style"
    } else if parts.iter().any(|part| matches!(part, Part::Currency(_))) {
        "number:currency-style"
    } else {
        "number:number-style"
    }
}

fn parts_xml(parts: &[Part], value: &str) -> String {
    let mut out = String::new();
    for part in parts {
        match part {
            Part::Text(text) => out.push_str(&format!(
                "<number:text>{}</number:text>",
                escape_xml(text)
            )),
            Part::Currency(symbol) => out.push_str(&format!(
                "<number:currency-symbol>{}</number:currency-symbol>",
                escape_xml(symbol)
            )),
            Part::Value => out.push_str(value),
        }
    }
    out
}

fn number_element(spec: &NumberSpec) -> String {
    let mut attributes = String::new();
    if !spec.general {
        attributes.push_str(&format!(r#" number:decimal-places="{}""#, spec.decimals));
        if spec.min_decimals != spec.decimals {
            attributes.push_str(&format!(
                r#" number:min-decimal-places="{}""#,
                spec.min_decimals
            ));
        }
    }
    attributes.push_str(&format!(
        r#" number:min-integer-digits="{}""#,
        spec.min_integer_digits
    ));
    if spec.grouping {
        attributes.push_str(r#" number:grouping="true""#);
    }
    if spec.thousands > 0 {
        attributes.push_str(&format!(
            r#" number:display-factor="{}""#,
            1000u64.pow(spec.thousands.min(5))
        ));
    }
    if spec.embedded.is_empty() {
        return format!("<number:number{attributes}/>");
    }
    let mut embedded = String::new();
    for (position, text) in &spec.embedded {
        embedded.push_str(&format!(
            r#"<number:embedded-text number:position="{position}">{}</number:embedded-text>"#,
            escape_xml(text)
        ));
    }
    format!("<number:number{attributes}>{embedded}</number:number>")
}

fn calendar_style_xml(name: &str, fields: &[Field], time_only: bool, elapsed: bool) -> String {
    let element = if time_only {
        "number:time-style"
    } else {
        "number:date-style"
    };
    // A time style truncates at a day unless told otherwise, so a duration of
    // 30 hours would read as `06:00:00`. Excel asks for the full hours with the
    // bracketed `[h]`, which reaches here as an elapsed field; a plain `h:mm`
    // clock time keeps the truncating default because Excel wraps it too.
    let truncate = if time_only && elapsed {
        r#" number:truncate-on-overflow="false""#
    } else {
        ""
    };
    let mut body = String::new();
    for field in fields {
        match field {
            Field::Year { long } => body.push_str(&empty_element(
                "number:year",
                if *long { r#" number:style="long""# } else { "" },
            )),
            Field::Month { long, textual } => body.push_str(&empty_element(
                "number:month",
                &format!(
                    "{}{}",
                    if *textual {
                        r#" number:textual="true""#
                    } else {
                        ""
                    },
                    if *long { r#" number:style="long""# } else { "" },
                ),
            )),
            Field::Day { long } => body.push_str(&empty_element(
                "number:day",
                if *long { r#" number:style="long""# } else { "" },
            )),
            Field::DayOfWeek { long } => body.push_str(&empty_element(
                "number:day-of-week",
                if *long { r#" number:style="long""# } else { "" },
            )),
            Field::Hour { long } => body.push_str(&empty_element(
                "number:hours",
                if *long { r#" number:style="long""# } else { "" },
            )),
            Field::Minute { long } => body.push_str(&empty_element(
                "number:minutes",
                if *long { r#" number:style="long""# } else { "" },
            )),
            Field::Second { long, decimals } => {
                let mut attributes = String::new();
                if *long {
                    attributes.push_str(r#" number:style="long""#);
                }
                if *decimals > 0 {
                    attributes.push_str(&format!(r#" number:decimal-places="{decimals}""#));
                }
                body.push_str(&empty_element("number:seconds", &attributes));
            }
            Field::AmPm => body.push_str("<number:am-pm/>"),
            Field::Text(text) => body.push_str(&format!(
                "<number:text>{}</number:text>",
                escape_xml(text)
            )),
        }
    }
    if body.is_empty() {
        body.push_str(r#"<number:year number:style="long"/>"#);
    }
    format!(r#"<{element} style:name="{name}"{truncate}>{body}</{element}>"#)
}

fn empty_element(name: &str, attributes: &str) -> String {
    format!("<{name}{attributes}/>")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rendered(code: &str) -> String {
        data_style_plan(code)
            .unwrap_or_else(|| panic!("{code} has no data style"))
            .xml("N1")
    }

    fn spec_of(code: &str) -> (u32, u32, bool) {
        match section(code).body {
            Body::Number { spec, .. } => (spec.decimals, spec.min_integer_digits, spec.grouping),
            other => panic!("{code} is not a plain number format: {other:?}"),
        }
    }

    #[test]
    fn reads_the_common_number_formats() {
        assert_eq!(spec_of("0"), (0, 1, false));
        assert_eq!(spec_of("0.00"), (2, 1, false));
        assert_eq!(spec_of("#,##0"), (0, 1, true));
        assert_eq!(spec_of("#,##0.00"), (2, 1, true));
        assert_eq!(spec_of("00000"), (0, 5, false));
        assert!(rendered("0%").starts_with("<number:percentage-style"));
        assert!(rendered("0.00%").contains("<number:text>%</number:text>"));
        assert!(data_style_plan("General").is_none());
        assert!(rendered("@").contains("<number:text-content/>"));
        // A code this module cannot read asks for no style at all.
        assert!(data_style_plan("0.0\"x\"0").is_none());
    }

    #[test]
    fn finds_the_currency_symbol_and_its_place() {
        let front = rendered(r##""$"#,##0.00_);("$"#,##0.00)"##);
        assert!(front.contains("<number:currency-style"), "{front}");
        assert!(
            front.contains("<number:currency-symbol>$</number:currency-symbol><number:number"),
            "{front}"
        );
        let behind = rendered("#,##0.00 [$€-407]");
        assert!(
            behind.contains(
                "/><number:text> </number:text><number:currency-symbol>€</number:currency-symbol>"
            ),
            "{behind}"
        );
        // A bare locale tag is not a currency.
        assert!(rendered("[$-412]0.0").starts_with("<number:number-style"));
    }

    #[test]
    fn text_around_and_inside_the_digits_travels() {
        let won = rendered(r##"#,##0"원""##);
        assert!(
            won.contains(r#"number:grouping="true"/><number:text>원</number:text>"#),
            "{won}"
        );
        let embedded = rendered(r#"000"-"00"#);
        assert!(
            embedded.contains(
                r#"number:min-integer-digits="5"><number:embedded-text number:position="2">-</number:embedded-text></number:number>"#
            ),
            "{embedded}"
        );
        let thousands = rendered(r##"#,##0,"천""##);
        assert!(thousands.contains(r#"number:display-factor="1000""#), "{thousands}");
        assert!(thousands.contains("<number:text>천</number:text>"), "{thousands}");
        let optional = rendered("0.0#");
        assert!(
            optional.contains(r#"number:decimal-places="2" number:min-decimal-places="1""#),
            "{optional}"
        );
        let general = rendered(r#"General"개""#);
        assert!(
            general.contains(
                r#"<number:number number:min-integer-digits="1"/><number:text>개</number:text>"#
            ),
            "{general}"
        );
    }

    #[test]
    fn sections_become_mapped_styles() {
        // Two sections: the first is for zero and up, the second (the main
        // style) for negatives, shown the way the code spells them.
        let red = rendered("#,##0;[Red]-#,##0");
        assert!(
            red.starts_with(r#"<number:number-style style:name="N1P0" style:volatile="true">"#),
            "{red}"
        );
        assert!(
            red.contains(
                r##"<number:number-style style:name="N1"><style:text-properties fo:color="#FF0000"/><number:text>-</number:text>"##
            ),
            "{red}"
        );
        assert!(
            red.contains(r#"<style:map style:condition="value()&gt;=0" style:apply-style-name="N1P0"/>"#),
            "{red}"
        );
        // Three sections plus a text one: positive, negative, zero. The zero
        // section of an accounting format is a literal dash.
        let accounting = rendered(r##"_-* #,##0_-;-* #,##0_-;_-* "-"_-;_-@_-"##);
        assert!(
            accounting.contains(r#"<style:map style:condition="value()&gt;0" style:apply-style-name="N1P0"/>"#),
            "{accounting}"
        );
        assert!(
            accounting.contains(r#"<style:map style:condition="value()&lt;0" style:apply-style-name="N1P1"/>"#),
            "{accounting}"
        );
        assert!(
            accounting.contains(r#"<number:number-style style:name="N1P2" style:volatile="true"><number:text>-</number:text></number:number-style>"#),
            "{accounting}"
        );
        // The text section is the style a text cell falls through to.
        assert!(
            accounting.contains(r#"<number:text-style style:name="N1"><number:text-content/><style:map"#)
                && accounting.contains(r#"<style:map style:condition="value()=0" style:apply-style-name="N1P2"/>"#),
            "{accounting}"
        );
        // Parentheses for negatives.
        let parens = rendered("#,##0_);(#,##0)");
        assert!(
            parens.contains("<number:text>(</number:text><number:number"),
            "{parens}"
        );
        // An explicit condition replaces the default one.
        let conditional = rendered("[>=100]0.0;0.00");
        assert!(
            conditional.contains(r#"style:condition="value()&gt;=100""#),
            "{conditional}"
        );
    }

    #[test]
    fn scientific_fractions_and_text_have_their_own_elements() {
        let scientific = rendered("0.00E+00");
        assert!(
            scientific.contains(
                r#"<number:scientific-number number:decimal-places="2" number:min-decimal-places="2" number:min-integer-digits="1" number:min-exponent-digits="2" number:forced-exponent-sign="true"/>"#
            ),
            "{scientific}"
        );
        let fraction = rendered("# ?/?");
        assert!(
            fraction.contains(
                r#"<number:fraction number:min-integer-digits="0" number:min-numerator-digits="1" number:min-denominator-digits="1" number:max-denominator-value="9"/>"#
            ),
            "{fraction}"
        );
        let eighths = rendered("# ?/8");
        assert!(eighths.contains(r#"number:denominator-value="8""#), "{eighths}");
        let improper = rendered("??/??");
        assert!(!improper.contains("min-integer-digits"), "{improper}");
    }

    #[test]
    fn separates_dates_times_and_minutes() {
        for (code, time_only) in [
            ("yyyy-mm-dd", false),
            ("m/d/yyyy", false),
            ("m/d/yy hh:mm", false),
            ("h:mm", true),
            ("h:mm:ss AM/PM", true),
            ("mm:ss", true),
            ("[h]:mm:ss", true),
            ("d-mmm-yy", false),
        ] {
            match section(code).body {
                Body::Calendar { time_only: actual, .. } => {
                    assert_eq!(actual, time_only, "{code}")
                }
                other => panic!("{code} is not a calendar format: {other:?}"),
            }
        }
    }

    #[test]
    fn a_calendar_style_spells_the_minutes_not_the_months() {
        let rendered = rendered("hh:mm");
        assert!(rendered.contains("<number:hours"), "{rendered}");
        assert!(rendered.contains("<number:minutes"), "{rendered}");
        assert!(!rendered.contains("<number:month"), "{rendered}");
        // The date part's `m` stays a month even with a time behind it.
        let both = self::rendered("m/d/yy h:mm");
        assert!(both.contains("<number:month/>"), "{both}");
        assert!(both.contains("<number:minutes"), "{both}");
    }

    #[test]
    fn a_bracketed_hour_keeps_its_time_style_from_truncating_at_a_day() {
        let elapsed = rendered("[h]:mm:ss");
        assert!(
            elapsed.contains(r#"number:truncate-on-overflow="false""#),
            "{elapsed}"
        );
        // A plain clock time keeps the ODF default, which matches Excel's
        // `h:mm` wrapping at midnight.
        let clock = rendered("h:mm");
        assert!(!clock.contains("truncate-on-overflow"), "{clock}");
    }

    #[test]
    fn localised_date_formats_keep_their_literals() {
        let korean = rendered(r#"yyyy"년" mm"월" dd"일""#);
        assert!(korean.contains("<number:text>년 </number:text>"), "{korean}");
        assert!(korean.contains("<number:month"), "{korean}");
        // `aaa` is the short weekday name, not three letters of text.
        let weekday = rendered("yyyy-mm-dd(aaa)");
        assert!(
            weekday.contains("<number:text>(</number:text><number:day-of-week/><number:text>)</number:text>"),
            "{weekday}"
        );
        let seconds = rendered("mm:ss.000");
        assert!(
            seconds.contains(r#"<number:seconds number:style="long" number:decimal-places="3"/>"#),
            "{seconds}"
        );
    }

    #[test]
    fn a_run_only_carries_what_it_turns_on() {
        let mut registry = StyleRegistry::new(CellStyle::default());
        assert!(registry.text_run(&RichRun::default()).is_none());
        let bold = RichRun {
            bold: true,
            color: Some("#FF0000".into()),
            ..RichRun::default()
        };
        let name = registry.text_run(&bold).expect("a bold red run needs a style");
        assert_eq!(registry.text_run(&bold).as_deref(), Some(name.as_str()));
        let styles = registry.automatic_styles();
        assert!(styles.contains(r#"style:family="text""#), "{styles}");
        assert!(styles.contains(r#"style:font-weight-asian="bold""#), "{styles}");
        assert!(!styles.contains("font-style"), "{styles}");
    }

    #[test]
    fn a_cell_style_says_what_a_reader_needs_to_hear() {
        let mut registry = StyleRegistry::new(CellStyle::default());
        let style = CellStyle {
            wrap_text: true,
            bold: true,
            horizontal_alignment: Some("center".into()),
            text_rotation: Some(135),
            indent: Some(2),
            locked: Some(false),
            ..CellStyle::default()
        };
        registry.resolve_cell(&style).name.expect("a styled cell");
        let styles = registry.automatic_styles();
        assert!(styles.contains(r#"fo:wrap-option="wrap""#), "{styles}");
        assert!(styles.contains(r#"style:text-align-source="fix""#), "{styles}");
        assert!(styles.contains(r#"style:rotation-angle="315""#), "{styles}");
        assert!(styles.contains(r#"fo:margin-left="15pt""#), "{styles}");
        assert!(styles.contains(r#"style:cell-protect="none""#), "{styles}");
        // East Asian text reads its own weight property.
        assert!(styles.contains(r#"style:font-weight-asian="bold""#), "{styles}");
    }
    #[test]
    fn a_text_section_is_what_a_text_cell_falls_through_to() {
        // Four sections: the numbers are reached by conditions and the text
        // section is the style itself.
        let four = rendered("0;-0;;@");
        assert!(
            four.ends_with(concat!(
                r#"<number:text-style style:name="N1"><number:text-content/>"#,
                r#"<style:map style:condition="value()&gt;0" style:apply-style-name="N1P0"/>"#,
                r#"<style:map style:condition="value()&lt;0" style:apply-style-name="N1P1"/>"#,
                r#"<style:map style:condition="value()=0" style:apply-style-name="N1P2"/></number:text-style>"#,
            )),
            "{four}"
        );
        // `;;;` hides text as well as numbers: a text style with no content.
        let hidden = rendered(";;;");
        assert!(
            hidden.contains(r#"<number:text-style style:name="N1"><style:map"#),
            "{hidden}"
        );
        assert!(!hidden.contains("number:text-content"), "{hidden}");
        // One number section and a text section: the negative side says its
        // own minus, because a mapped section is handed the bare number.
        let two = rendered("0.0;\"t:\"@");
        assert!(
            two.contains(concat!(
                r#"<number:number-style style:name="N1P1" style:volatile="true"><number:text>-</number:text>"#,
                r#"<number:number number:decimal-places="1" number:min-integer-digits="1"/></number:number-style>"#,
                r#"<number:text-style style:name="N1"><number:text>t:</number:text><number:text-content/>"#,
                r#"<style:map style:condition="value()&gt;=0" style:apply-style-name="N1P0"/>"#,
                r#"<style:map style:condition="value()&lt;0" style:apply-style-name="N1P1"/>"#,
            )),
            "{two}"
        );
    }

    #[test]
    fn a_font_that_follows_the_theme_names_its_east_asian_face() {
        let mut registry = StyleRegistry::new(CellStyle {
            font_family: Some("Calibri".into()),
            font_scheme: Some("minor".into()),
            ..CellStyle::default()
        });
        // Only the East Asian face of the theme is known: it is the Asian font.
        registry.set_theme_fonts(None, Some("맑은 고딕".into()));
        let default = registry.default_cell_style();
        assert!(
            default.contains(r#" style:font-name="Calibri" style:font-name-asian="맑은 고딕" style:font-name-complex="Calibri""#),
            "{default}"
        );
        // The workbook cached a name for its body font: that is the font.
        registry.set_theme_fonts(Some("맑은 고딕".into()), None);
        let default = registry.default_cell_style();
        assert!(
            default.contains(r#" style:font-name="맑은 고딕" style:font-name-asian="맑은 고딕" style:font-name-complex="맑은 고딕""#),
            "{default}"
        );
        assert!(registry.font_face_decls().contains(r#"style:name="맑은 고딕""#));
        // A font the cell names outright keeps that name for every script.
        let named = registry.resolve_cell(&CellStyle {
            font_family: Some("Arial".into()),
            ..CellStyle::default()
        });
        let styles = registry.automatic_styles();
        assert!(named.name.is_some());
        assert!(
            styles.contains(r#" style:font-name="Arial" style:font-name-asian="Arial" style:font-name-complex="Arial""#),
            "{styles}"
        );
    }
}
