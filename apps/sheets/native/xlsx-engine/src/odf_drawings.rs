//! The drawing layer of an `.ods` document: pictures, shapes, text boxes,
//! lines and chart frames, with the cell each one sits in.
//!
//! ODF puts a drawing inside the cell it is anchored to (or in a
//! `table:shapes` list for the ones pinned to the page) and keeps its look in
//! automatic styles, so this is one more streaming pass over `content.xml`. A
//! document without a single `<draw:` element is recognised before any XML is
//! parsed, which is the usual case and costs one decompression.
//!
//! Like the other readers of the package this one is best-effort: a drawing
//! it cannot follow is left out, and a document it cannot follow at all still
//! opens with its cells.

use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader, Read};
use std::path::Path;

use quick_xml::Reader;
use quick_xml::events::{BytesStart, Event};
use zip::ZipArchive;

use crate::SidecarError;
use crate::odf_layout::length_points;
use crate::xml_util::{decode_text, general_ref_text, read_zip_string, zip_entry};

pub(crate) const EMU_PER_POINT: f64 = 12_700.0;

/// A sheet full of drawings is still a finite list.
const MAX_SHAPES: usize = 20_000;
/// Runs of columns or rows of one size, per sheet. Rows that share a style
/// are one run, so a sheet reaches this only by alternating sizes.
const MAX_SPANS: usize = 200_000;
/// The text of one shape, in characters.
const MAX_SHAPE_TEXT: usize = 32_000;
const MAX_PATH_COMMANDS: usize = 4_000;
const MAX_ROW: u32 = 1_048_576;
const MAX_COLUMN: u32 = 16_384;

/// The properties a drawing style may set. Every field is optional so a
/// style can be laid over its parent.
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct DrawStyle {
    pub(crate) parent: Option<String>,
    /// `none`, `solid` or `dash`.
    pub(crate) stroke: Option<String>,
    /// The name of the dash a dashed stroke is drawn with.
    pub(crate) stroke_dash: Option<String>,
    /// The name of the gradient a gradient fill is drawn with.
    pub(crate) fill_gradient: Option<String>,
    /// In points.
    pub(crate) stroke_width: Option<f64>,
    /// `RRGGBB`.
    pub(crate) stroke_color: Option<String>,
    /// `none`, `solid`, `gradient`, `hatch` or `bitmap`.
    pub(crate) fill: Option<String>,
    pub(crate) fill_color: Option<String>,
    /// 0 to 1.
    pub(crate) opacity: Option<f64>,
    pub(crate) image_opacity: Option<f64>,
    /// `top`, `middle`, `bottom`.
    pub(crate) vertical_align: Option<String>,
    /// Where the text area sits across the shape: `left`, `center`, `right`
    /// or `justify` (the whole width, which is also what nothing means).
    pub(crate) horizontal_align: Option<String>,
    /// `wrap` or `no-wrap`.
    pub(crate) wrap: Option<String>,
    /// Left, top, right, bottom, in points.
    pub(crate) padding: [Option<f64>; 4],
    pub(crate) marker_start: Option<bool>,
    pub(crate) marker_end: Option<bool>,
    /// `start`, `center`, `end`, `justify`…
    pub(crate) align: Option<String>,
    pub(crate) color: Option<String>,
    /// In points.
    pub(crate) size: Option<f64>,
    pub(crate) bold: Option<bool>,
    pub(crate) italic: Option<bool>,
    pub(crate) underline: Option<bool>,
    pub(crate) font: Option<String>,
    pub(crate) font_asian: Option<String>,
}

impl DrawStyle {
    /// Fills what this style leaves open from `under`.
    pub(crate) fn over(mut self, under: &DrawStyle) -> DrawStyle {
        macro_rules! inherit {
            ($($field:ident),*) => {
                $(if self.$field.is_none() { self.$field = under.$field.clone(); })*
            };
        }
        inherit!(
            stroke, stroke_dash, fill_gradient, stroke_width, stroke_color, fill, fill_color, opacity,
            image_opacity,
            vertical_align, horizontal_align, wrap, marker_start, marker_end, align, color, size,
            bold, italic,
            underline, font, font_asian
        );
        for (own, inherited) in self.padding.iter_mut().zip(under.padding) {
            if own.is_none() {
                *own = inherited;
            }
        }
        self
    }
}

/// The graphic, paragraph and text styles of the document.
#[derive(Default)]
pub(crate) struct DrawStyles {
    styles: HashMap<(Family, String), DrawStyle>,
    defaults: HashMap<Family, DrawStyle>,
    /// The DrawingML preset each named dash of the document comes closest to.
    pub(crate) dashes: HashMap<String, &'static str>,
    /// The named linear gradients of the document.
    pub(crate) gradients: HashMap<String, Gradient>,
}

/// A linear gradient: the angle the way DrawingML counts it (degrees
/// clockwise, 0 = left to right) and the colours along it, 0 to 1.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Gradient {
    pub(crate) angle: f64,
    pub(crate) stops: Vec<(f64, String)>,
}

/// A document may declare many dashes and gradients; these are plenty.
const MAX_NAMED_STYLES: usize = 10_000;
const MAX_GRADIENT_STOPS: usize = 64;

/// A length of a dash in line widths: a percentage of the width, or a
/// measure taken against a line one point wide.
fn dash_units(value: Option<&str>) -> Option<f64> {
    let value = value?.trim();
    match value.strip_suffix('%') {
        Some(percent) => percent.trim().parse::<f64>().ok().map(|percent| percent / 100.0),
        None => length_points(value),
    }
    .filter(|units| units.is_finite() && *units >= 0.0)
}

/// The preset dash nearest to a `draw:stroke-dash`. One the export wrote is
/// found in its table; any other is told apart by how long its strokes are
/// and how many dots sit between them.
fn dash_preset(attributes: &[(String, String)]) -> &'static str {
    let count = |name: &str| {
        get(attributes, name)
            .and_then(|count| count.trim().parse::<u32>().ok())
            .unwrap_or(0)
    };
    let (dots1, dots2) = (count("draw:dots1"), count("draw:dots2"));
    let length1 = dash_units(get(attributes, "draw:dots1-length")).unwrap_or(1.0);
    let length2 = dash_units(get(attributes, "draw:dots2-length")).unwrap_or(1.0);
    let distance = dash_units(get(attributes, "draw:distance")).unwrap_or(1.0);
    let percent = |units: f64| (units * 100.0).round() as u32;
    if let Some(entry) = crate::ods_drawing::DASHES.iter().find(|entry| {
        u32::from(entry.1) == dots1
            && entry.2 == percent(length1)
            && u32::from(entry.3) == dots2
            && (dots2 == 0 || entry.4 == percent(length2))
            && entry.5 == percent(distance)
    }) {
        return entry.0;
    }
    // The longer kind of stroke is the dash, the shorter one the dots.
    let (long, dots) = match (dots1 > 0, dots2 > 0) {
        (true, true) if length1 >= length2 => (length1, dots2),
        (true, true) => (length2, dots1),
        (true, false) => (length1, 0),
        (false, true) => (length2, 0),
        (false, false) => return "dash",
    };
    match (dots, long) {
        (0, long) if long < 2.0 => {
            if distance < 2.0 {
                "sysDot"
            } else {
                "dot"
            }
        }
        (0, long) if long < 3.5 => "sysDash",
        (0, long) if long < 6.0 => "dash",
        (0, _) => "lgDash",
        (1, long) if long < 3.5 => "sysDashDot",
        (_, long) if long < 3.5 => "sysDashDotDot",
        (1, long) if long < 6.0 => "dashDot",
        (1, _) => "lgDashDot",
        _ => "lgDashDotDot",
    }
}

/// A gradient while its element is open: name, angle, the colours of its
/// two ends, and the stops listed inside it.
type PendingGradient = (String, f64, Vec<(f64, String)>, Vec<(f64, String)>);

/// Keeps a gradient that was read to its end. The stops listed inside it say
/// more than the two colours of its ends, and are used when there are two or
/// more of them.
fn finish_gradient(pending: &mut Option<PendingGradient>, styles: &mut DrawStyles) {
    let Some((name, angle, ends, listed)) = pending.take() else {
        return;
    };
    let mut stops = if listed.len() >= 2 { listed } else { ends };
    if stops.len() < 2 {
        return;
    }
    stops.sort_by(|a, b| a.0.total_cmp(&b.0));
    styles.gradients.insert(name, Gradient { angle, stops });
}

/// The angle of a `draw:gradient` in degrees. A bare number is in tenths of
/// a degree, the way the format wrote it before it took units.
fn gradient_degrees(value: Option<&str>) -> Option<f64> {
    let value = value.unwrap_or("0").trim();
    let degrees = if let Some(degrees) = value.strip_suffix("deg") {
        degrees.trim().parse::<f64>().ok()?
    } else if let Some(grads) = value.strip_suffix("grad") {
        grads.trim().parse::<f64>().ok()? * 0.9
    } else if let Some(radians) = value.strip_suffix("rad") {
        radians.trim().parse::<f64>().ok()?.to_degrees()
    } else {
        value.parse::<f64>().ok()? / 10.0
    };
    degrees.is_finite().then_some(degrees)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) enum Family {
    Graphic,
    Paragraph,
    Text,
}

impl Family {
    fn of(name: &str) -> Option<Self> {
        Some(match name {
            "graphic" => Family::Graphic,
            "paragraph" => Family::Paragraph,
            "text" => Family::Text,
            _ => return None,
        })
    }
}

impl DrawStyles {
    /// The style with everything its parents and the family default add.
    pub(crate) fn resolve(&self, family: Family, name: Option<&str>) -> DrawStyle {
        let mut resolved = DrawStyle::default();
        let mut next = name.map(str::to_owned);
        // A parent chain is short; the bound only stops a loop.
        for _ in 0..16 {
            let Some(current) = next.take() else {
                break;
            };
            let Some(style) = self.styles.get(&(family, current)) else {
                break;
            };
            next = style.parent.clone();
            resolved = resolved.over(style);
        }
        match self.defaults.get(&family) {
            Some(default) => resolved.over(default),
            None => resolved,
        }
    }
}

/// Where a two-cell anchor ends: a cell and an offset into it, in EMU.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct EndMarker {
    pub(crate) row: u32,
    pub(crate) column: u32,
    pub(crate) x: f64,
    pub(crate) y: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum PathCommand {
    Move(f64, f64),
    Line(f64, f64),
    Cubic([f64; 6]),
    Quad([f64; 4]),
    Close,
}

/// An outline in its own coordinate space, `width` by `height`.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct CustomPath {
    pub(crate) width: f64,
    pub(crate) height: f64,
    pub(crate) commands: Vec<PathCommand>,
    /// False for an outline that is drawn but not filled.
    pub(crate) filled: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Outline {
    /// A DrawingML preset name.
    Preset(&'static str),
    Custom(CustomPath),
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum ShapeKind {
    /// A picture stored in the package under `entry`.
    Picture { entry: String },
    /// A chart document in the directory `directory` of the package.
    Chart { directory: String },
    Shape { outline: Outline, text_box: bool },
    /// A line or connector, drawn with the preset `preset`.
    Line { preset: &'static str },
}

#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct Run {
    pub(crate) text: String,
    /// The text style the run names.
    pub(crate) style: Option<String>,
    /// A line break inside the paragraph; `text` is empty.
    pub(crate) line_break: bool,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct Paragraph {
    pub(crate) style: Option<String>,
    pub(crate) runs: Vec<Run>,
}

/// One drawing as the document places it. Lengths are EMU.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Shape {
    /// The cell the drawing is anchored to, as `(row, column)`; `None` for
    /// one pinned to the page.
    pub(crate) cell: Option<(u32, u32)>,
    /// Offset from the anchor cell (or the sheet's corner) of the unrotated
    /// frame.
    pub(crate) x: f64,
    pub(crate) y: f64,
    pub(crate) width: f64,
    pub(crate) height: f64,
    pub(crate) end: Option<EndMarker>,
    pub(crate) z_index: i64,
    pub(crate) name: Option<String>,
    pub(crate) description: Option<String>,
    pub(crate) title: Option<String>,
    pub(crate) link: Option<String>,
    pub(crate) style: Option<String>,
    /// The paragraph style the shape gives its text as a whole.
    pub(crate) text_style: Option<String>,
    pub(crate) kind: ShapeKind,
    pub(crate) flip_h: bool,
    pub(crate) flip_v: bool,
    /// Degrees clockwise.
    pub(crate) rotation: f64,
    /// A `draw:custom-shape`, whose text sits in the middle of its height
    /// when no style says where.
    pub(crate) figure: bool,
    pub(crate) paragraphs: Vec<Paragraph>,
}

/// The size of a run of columns or rows as the document states it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Span {
    pub(crate) first: u32,
    pub(crate) last: u32,
    /// In EMU.
    pub(crate) size: f64,
    /// True for a size the application fits to the content: the number is
    /// what it came to when the document was saved.
    pub(crate) fitted: bool,
    pub(crate) hidden: bool,
}

/// The drawings of one sheet and the grid they were placed on.
#[derive(Default)]
pub(crate) struct SheetDrawings {
    pub(crate) shapes: Vec<Shape>,
    /// Columns and rows that state a size or are hidden, in order.
    pub(crate) columns: Vec<Span>,
    pub(crate) rows: Vec<Span>,
}

/// Everything the drawing pass found.
#[derive(Default)]
pub(crate) struct OdfDrawings {
    /// Runs alongside the sheets.
    pub(crate) sheets: Vec<SheetDrawings>,
    pub(crate) styles: DrawStyles,
}

impl OdfDrawings {
    pub(crate) fn is_empty(&self) -> bool {
        self.sheets.iter().all(|sheet| sheet.shapes.is_empty())
    }
}

/// The sizes column and row styles state, by style.
#[derive(Default)]
struct Sizes {
    /// Style names as the elements spell them, numbered so a run of rows
    /// compares a number instead of keeping a string.
    names: HashMap<Vec<u8>, u32>,
    /// `(size in EMU, fitted to the content)`.
    columns: HashMap<u32, (f64, bool)>,
    rows: HashMap<u32, (f64, bool)>,
}

impl Sizes {
    fn id(&mut self, name: &[u8]) -> u32 {
        if let Some(id) = self.names.get(name) {
            return *id;
        }
        let id = self.names.len() as u32;
        self.names.insert(name.to_vec(), id);
        id
    }
}

/// A run of columns or rows before its style is looked up.
struct RawSpan {
    first: u32,
    last: u32,
    style: Option<u32>,
    hidden: bool,
}

#[derive(Default)]
struct SheetBuilder {
    shapes: Vec<Shape>,
    columns: Vec<RawSpan>,
    rows: Vec<RawSpan>,
}

/// Adds a run, joined to the one before it when they look the same.
fn push_span(spans: &mut Vec<RawSpan>, first: u32, last: u32, style: Option<u32>, hidden: bool) {
    if style.is_none() && !hidden {
        return;
    }
    if let Some(previous) = spans.last_mut() {
        if previous.style == style && previous.hidden == hidden && previous.last + 1 == first {
            previous.last = last;
            return;
        }
    }
    if spans.len() < MAX_SPANS {
        spans.push(RawSpan {
            first,
            last,
            style,
            hidden,
        });
    }
}

fn resolve_spans(spans: Vec<RawSpan>, sizes: &HashMap<u32, (f64, bool)>) -> Vec<Span> {
    spans
        .into_iter()
        .filter_map(|span| {
            let stated = span.style.and_then(|style| sizes.get(&style)).copied();
            match (stated, span.hidden) {
                (Some((size, fitted)), hidden) => Some(Span {
                    first: span.first,
                    last: span.last,
                    size,
                    fitted,
                    hidden,
                }),
                (None, true) => Some(Span {
                    first: span.first,
                    last: span.last,
                    size: 0.0,
                    fitted: true,
                    hidden: true,
                }),
                (None, false) => None,
            }
        })
        .collect()
}

/// The repeat count, the style and the visibility of a `table:table-column`
/// or `table:table-row`, read in one walk over its attributes.
fn span_attributes(
    element: &BytesStart<'_>,
    repeat_name: &[u8],
    sizes: &mut Sizes,
) -> (u32, Option<u32>, bool) {
    let mut repeats = 1u32;
    let mut style = None;
    let mut hidden = false;
    for attribute in element.attributes().with_checks(false).flatten() {
        let key = attribute.key.local_name();
        let key = key.as_ref();
        if key == repeat_name {
            repeats = std::str::from_utf8(&attribute.value)
                .ok()
                .and_then(|value| value.trim().parse::<u32>().ok())
                .unwrap_or(1)
                .max(1);
        } else if key == b"style-name" {
            style = Some(sizes.id(&attribute.value));
        } else if key == b"visibility" {
            hidden = attribute.value.as_ref() != b"visible";
        }
    }
    (repeats, style, hidden)
}

/// Reads the drawings of every sheet. A package with none returns at once.
pub(crate) fn read_drawings(source: &Path) -> Result<OdfDrawings, SidecarError> {
    let mut archive = ZipArchive::new(File::open(source)?)?;
    {
        let entry = zip_entry(&mut archive, "content.xml")?;
        if !mentions_drawings(entry)? {
            return Ok(OdfDrawings::default());
        }
    }
    let mut drawings = OdfDrawings::default();
    let mut sizes = Sizes::default();
    // `styles.xml` holds the named graphic styles and the family defaults the
    // automatic ones build on.
    if let Ok(xml) = read_zip_string(&mut archive, "styles.xml") {
        let mut reader = Reader::from_str(&xml);
        let mut ignored = Vec::new();
        // Its drawings, if any, belong to page headers; only styles matter.
        let _ = parse(&mut reader, &mut drawings.styles, &mut sizes, &mut ignored, false);
    }
    let entry = zip_entry(&mut archive, "content.xml")?;
    let mut reader = Reader::from_reader(BufReader::new(entry));
    let mut sheets = Vec::new();
    parse(&mut reader, &mut drawings.styles, &mut sizes, &mut sheets, true)?;
    drawings.sheets = finish_sheets(sheets, &sizes);
    Ok(drawings)
}

fn finish_sheets(sheets: Vec<SheetBuilder>, sizes: &Sizes) -> Vec<SheetDrawings> {
    sheets
        .into_iter()
        .map(|sheet| SheetDrawings {
            shapes: sheet.shapes,
            columns: resolve_spans(sheet.columns, &sizes.columns),
            rows: resolve_spans(sheet.rows, &sizes.rows),
        })
        .collect()
}

/// True when the stream holds `<draw:` anywhere.
fn mentions_drawings(mut entry: impl Read) -> Result<bool, SidecarError> {
    const NEEDLE: &[u8] = b"<draw:";
    let mut buffer = vec![0u8; 64 * 1024];
    // The tail of the previous block, so a needle split across two is found.
    let mut carried = 0usize;
    loop {
        let read = entry.read(&mut buffer[carried..])?;
        if read == 0 {
            return Ok(false);
        }
        let filled = carried + read;
        if buffer[..filled]
            .windows(NEEDLE.len())
            .any(|window| window[0] == b'<' && window == NEEDLE)
        {
            return Ok(true);
        }
        carried = filled.min(NEEDLE.len() - 1);
        buffer.copy_within(filled - carried..filled, 0);
    }
}

/// Every attribute of an element by its qualified name.
fn attributes<R: BufRead>(
    reader: &Reader<R>,
    element: &BytesStart<'_>,
) -> Result<Vec<(String, String)>, SidecarError> {
    let mut out = Vec::new();
    for attribute in element.attributes().with_checks(false) {
        let attribute = attribute.map_err(|error| SidecarError::Workbook(error.to_string()))?;
        out.push((
            String::from_utf8_lossy(attribute.key.as_ref()).into_owned(),
            attribute
                .decode_and_unescape_value(reader.decoder())?
                .into_owned(),
        ));
    }
    Ok(out)
}

fn get<'a>(attributes: &'a [(String, String)], name: &str) -> Option<&'a str> {
    attributes
        .iter()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.as_str())
}

/// A length attribute in EMU.
fn length(attributes: &[(String, String)], name: &str) -> Option<f64> {
    get(attributes, name)
        .and_then(length_points)
        .map(|points| points * EMU_PER_POINT)
}

/// `#rrggbb` as `RRGGBB`; anything else (a name, `transparent`) is no colour.
fn color(value: &str) -> Option<String> {
    let hex = value.trim().strip_prefix('#')?;
    (hex.len() == 6 && hex.chars().all(|character| character.is_ascii_hexdigit()))
        .then(|| hex.to_ascii_uppercase())
}

/// `50%` as 0.5.
fn percent(value: &str) -> Option<f64> {
    let number: f64 = value.trim().strip_suffix('%')?.trim().parse().ok()?;
    Some((number / 100.0).clamp(0.0, 1.0))
}

/// Lays the attributes of one `style:*-properties` element onto `style`.
fn read_properties(kind: &[u8], attributes: &[(String, String)], style: &mut DrawStyle) {
    let text = |name: &str| get(attributes, name).map(str::to_owned);
    match kind {
        b"style:graphic-properties" => {
            style.stroke = text("draw:stroke").or(style.stroke.take());
            style.stroke_dash = text("draw:stroke-dash").or(style.stroke_dash.take());
            style.fill_gradient = text("draw:fill-gradient-name").or(style.fill_gradient.take());
            style.stroke_width = get(attributes, "svg:stroke-width")
                .and_then(length_points)
                .or(style.stroke_width);
            style.stroke_color = get(attributes, "svg:stroke-color")
                .and_then(color)
                .or(style.stroke_color.take());
            style.fill = text("draw:fill").or(style.fill.take());
            style.fill_color = get(attributes, "draw:fill-color")
                .and_then(color)
                .or(style.fill_color.take());
            style.opacity = get(attributes, "draw:opacity").and_then(percent).or(style.opacity);
            style.image_opacity = get(attributes, "draw:image-opacity")
                .and_then(percent)
                .or(style.image_opacity);
            style.vertical_align =
                text("draw:textarea-vertical-align").or(style.vertical_align.take());
            style.horizontal_align =
                text("draw:textarea-horizontal-align").or(style.horizontal_align.take());
            style.wrap = text("fo:wrap-option").or(style.wrap.take());
            for (slot, name) in style.padding.iter_mut().zip([
                "fo:padding-left",
                "fo:padding-top",
                "fo:padding-right",
                "fo:padding-bottom",
            ]) {
                if let Some(points) = get(attributes, name).and_then(length_points) {
                    *slot = Some(points);
                }
            }
            if let Some(marker) = get(attributes, "draw:marker-start") {
                style.marker_start = Some(!marker.is_empty());
            }
            if let Some(marker) = get(attributes, "draw:marker-end") {
                style.marker_end = Some(!marker.is_empty());
            }
        }
        b"style:paragraph-properties" => {
            style.align = text("fo:text-align").or(style.align.take());
        }
        b"style:text-properties" => {
            style.color = get(attributes, "fo:color").and_then(color).or(style.color.take());
            style.size = get(attributes, "fo:font-size")
                .and_then(length_points)
                .filter(|size| *size > 0.0)
                .or(style.size);
            if let Some(weight) = get(attributes, "fo:font-weight") {
                style.bold = Some(
                    weight == "bold" || weight.parse::<u32>().is_ok_and(|weight| weight >= 600),
                );
            }
            if let Some(slant) = get(attributes, "fo:font-style") {
                style.italic = Some(slant == "italic" || slant == "oblique");
            }
            if let Some(underline) = get(attributes, "style:text-underline-style") {
                style.underline = Some(underline != "none");
            }
            let family = |name: &str| {
                get(attributes, name)
                    .map(|family| family.trim().trim_matches('\'').to_owned())
                    .filter(|family| !family.is_empty())
            };
            style.font = family("fo:font-family")
                .or_else(|| family("style:font-name"))
                .or(style.font.take());
            style.font_asian = family("style:font-family-asian")
                .or_else(|| family("style:font-name-asian"))
                .or(style.font_asian.take());
        }
        _ => {}
    }
}

/// The cell a `table:end-cell-address` names: `Sheet.E6`, `'My sheet'.$E$6`.
fn end_cell(address: &str) -> Option<(u32, u32)> {
    let mut quoted = false;
    let mut split = None;
    for (index, character) in address.char_indices() {
        match character {
            '\'' => quoted = !quoted,
            '.' if !quoted => split = Some(index),
            _ => {}
        }
    }
    let cell: String = address[split.map_or(0, |index| index + 1)..]
        .chars()
        .filter(|character| *character != '$')
        .collect();
    let letters = cell.chars().take_while(char::is_ascii_alphabetic).count();
    if letters == 0 || letters > 3 {
        return None;
    }
    let column = cell[..letters].bytes().fold(0u32, |total, byte| {
        total * 26 + u32::from(byte.to_ascii_uppercase() - b'A') + 1
    });
    let row: u32 = cell[letters..].parse().ok()?;
    (row >= 1 && row <= MAX_ROW && column >= 1 && column <= MAX_COLUMN)
        .then(|| (row - 1, column - 1))
}

/// `rotate (a) translate (x y)`, the one transform a spreadsheet writes for
/// a turned shape: the angle in radians and the shift in EMU.
fn rotation_transform(text: &str) -> Option<(f64, f64, f64)> {
    let mut angle = None;
    let mut shift = None;
    let mut rest = text.trim();
    while !rest.is_empty() {
        let open = rest.find('(')?;
        let close = rest[open..].find(')')? + open;
        let name = rest[..open].trim();
        let arguments = &rest[open + 1..close];
        match name {
            "rotate" if angle.is_none() && shift.is_none() => {
                angle = Some(arguments.trim().parse::<f64>().ok()?);
            }
            "translate" if shift.is_none() => {
                let mut parts = arguments.split([' ', ',']).filter(|part| !part.is_empty());
                let x = length_points(parts.next()?)? * EMU_PER_POINT;
                let y = match parts.next() {
                    Some(y) => length_points(y)? * EMU_PER_POINT,
                    None => 0.0,
                };
                shift = Some((x, y));
            }
            // A skew, a scale or a matrix is not a frame this reader can name.
            _ => return None,
        }
        rest = rest[close + 1..].trim_start();
    }
    let (x, y) = shift.unwrap_or((0.0, 0.0));
    Some((angle.unwrap_or(0.0), x, y))
}

/// Numbers of a path, split from the letters around them.
fn path_tokens(text: &str) -> Option<Vec<PathToken>> {
    let mut tokens = Vec::new();
    let mut number = String::new();
    let flush = |number: &mut String, tokens: &mut Vec<PathToken>| -> Option<()> {
        if !number.is_empty() {
            tokens.push(PathToken::Number(number.parse().ok()?));
            number.clear();
        }
        Some(())
    };
    for character in text.chars() {
        match character {
            '0'..='9' | '.' => number.push(character),
            'e' | 'E' if !number.is_empty() => number.push(character),
            '-' | '+' => {
                if !number.is_empty() && !number.ends_with(['e', 'E']) {
                    flush(&mut number, &mut tokens)?;
                }
                number.push(character);
            }
            ' ' | ',' | '\n' | '\t' | '\r' => flush(&mut number, &mut tokens)?,
            'A'..='Z' | 'a'..='z' => {
                flush(&mut number, &mut tokens)?;
                tokens.push(PathToken::Command(character));
            }
            // A formula reference (`?f0`), a modifier (`$0`): not a plain path.
            _ => return None,
        }
        if tokens.len() > MAX_PATH_COMMANDS * 6 {
            return None;
        }
    }
    flush(&mut number, &mut tokens)?;
    Some(tokens)
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum PathToken {
    Command(char),
    Number(f64),
}

/// Reads the numbers that follow a command, `count` at a time.
fn arguments(tokens: &[PathToken], index: &mut usize, count: usize) -> Option<Vec<f64>> {
    let mut out = Vec::with_capacity(count);
    for _ in 0..count {
        match tokens.get(*index) {
            Some(PathToken::Number(value)) => out.push(*value),
            _ => return None,
        }
        *index += 1;
    }
    Some(out)
}

fn more_arguments(tokens: &[PathToken], index: usize) -> bool {
    matches!(tokens.get(index), Some(PathToken::Number(_)))
}

/// An enhanced path made of moves, lines, curves and closes. `None` for one
/// that uses arcs, formulas or any other command.
pub(crate) fn enhanced_path(text: &str) -> Option<(Vec<PathCommand>, bool)> {
    let tokens = path_tokens(text)?;
    let mut commands = Vec::new();
    let mut filled = true;
    let mut index = 0;
    while index < tokens.len() {
        let PathToken::Command(command) = tokens[index] else {
            return None;
        };
        index += 1;
        match command {
            'M' => {
                let point = arguments(&tokens, &mut index, 2)?;
                commands.push(PathCommand::Move(point[0], point[1]));
                // Further pairs after a move are lines.
                while more_arguments(&tokens, index) {
                    let point = arguments(&tokens, &mut index, 2)?;
                    commands.push(PathCommand::Line(point[0], point[1]));
                }
            }
            'L' => {
                let point = arguments(&tokens, &mut index, 2)?;
                commands.push(PathCommand::Line(point[0], point[1]));
                while more_arguments(&tokens, index) {
                    let point = arguments(&tokens, &mut index, 2)?;
                    commands.push(PathCommand::Line(point[0], point[1]));
                }
            }
            'C' => loop {
                let points = arguments(&tokens, &mut index, 6)?;
                commands.push(PathCommand::Cubic([
                    points[0], points[1], points[2], points[3], points[4], points[5],
                ]));
                if !more_arguments(&tokens, index) {
                    break;
                }
            },
            'Q' => loop {
                let points = arguments(&tokens, &mut index, 4)?;
                commands.push(PathCommand::Quad([points[0], points[1], points[2], points[3]]));
                if !more_arguments(&tokens, index) {
                    break;
                }
            },
            'Z' => commands.push(PathCommand::Close),
            // The end of a sub-path.
            'N' => {}
            'F' => filled = false,
            // "No stroke" still leaves the outline to fill.
            'S' => {}
            _ => return None,
        }
        if commands.len() > MAX_PATH_COMMANDS {
            return None;
        }
    }
    drawable(&commands).then_some((commands, filled))
}

/// An SVG path (`svg:d`) made of moves, lines, curves and closes, absolute or
/// relative.
pub(crate) fn svg_path(text: &str) -> Option<Vec<PathCommand>> {
    let tokens = path_tokens(text)?;
    let mut commands = Vec::new();
    let (mut x, mut y) = (0.0f64, 0.0f64);
    let (mut start_x, mut start_y) = (0.0f64, 0.0f64);
    let mut index = 0;
    while index < tokens.len() {
        let PathToken::Command(command) = tokens[index] else {
            return None;
        };
        index += 1;
        let relative = command.is_ascii_lowercase();
        let base = |x: f64, y: f64| if relative { (x, y) } else { (0.0, 0.0) };
        match command.to_ascii_uppercase() {
            'M' => {
                let mut first = true;
                loop {
                    let point = arguments(&tokens, &mut index, 2)?;
                    let (dx, dy) = base(x, y);
                    x = point[0] + dx;
                    y = point[1] + dy;
                    if first {
                        commands.push(PathCommand::Move(x, y));
                        start_x = x;
                        start_y = y;
                        first = false;
                    } else {
                        commands.push(PathCommand::Line(x, y));
                    }
                    if !more_arguments(&tokens, index) {
                        break;
                    }
                }
            }
            'L' => loop {
                let point = arguments(&tokens, &mut index, 2)?;
                let (dx, dy) = base(x, y);
                x = point[0] + dx;
                y = point[1] + dy;
                commands.push(PathCommand::Line(x, y));
                if !more_arguments(&tokens, index) {
                    break;
                }
            },
            'H' => loop {
                let point = arguments(&tokens, &mut index, 1)?;
                x = point[0] + base(x, y).0;
                commands.push(PathCommand::Line(x, y));
                if !more_arguments(&tokens, index) {
                    break;
                }
            },
            'V' => loop {
                let point = arguments(&tokens, &mut index, 1)?;
                y = point[0] + base(x, y).1;
                commands.push(PathCommand::Line(x, y));
                if !more_arguments(&tokens, index) {
                    break;
                }
            },
            'C' => loop {
                let points = arguments(&tokens, &mut index, 6)?;
                let (dx, dy) = base(x, y);
                let curve = [
                    points[0] + dx,
                    points[1] + dy,
                    points[2] + dx,
                    points[3] + dy,
                    points[4] + dx,
                    points[5] + dy,
                ];
                x = curve[4];
                y = curve[5];
                commands.push(PathCommand::Cubic(curve));
                if !more_arguments(&tokens, index) {
                    break;
                }
            },
            'Q' => loop {
                let points = arguments(&tokens, &mut index, 4)?;
                let (dx, dy) = base(x, y);
                let curve = [points[0] + dx, points[1] + dy, points[2] + dx, points[3] + dy];
                x = curve[2];
                y = curve[3];
                commands.push(PathCommand::Quad(curve));
                if !more_arguments(&tokens, index) {
                    break;
                }
            },
            'Z' => {
                commands.push(PathCommand::Close);
                x = start_x;
                y = start_y;
            }
            _ => return None,
        }
        if commands.len() > MAX_PATH_COMMANDS {
            return None;
        }
    }
    drawable(&commands).then_some(commands)
}

/// A path has to start with a move and go somewhere.
fn drawable(commands: &[PathCommand]) -> bool {
    matches!(commands.first(), Some(PathCommand::Move(..)))
        && commands
            .iter()
            .any(|command| !matches!(command, PathCommand::Move(..) | PathCommand::Close))
}

/// `x,y x,y …` of a polygon or polyline.
fn points_path(text: &str, close: bool) -> Option<Vec<PathCommand>> {
    let mut commands = Vec::new();
    for pair in text.split_whitespace() {
        let (x, y) = pair.split_once(',')?;
        let (x, y): (f64, f64) = (x.parse().ok()?, y.parse().ok()?);
        commands.push(if commands.is_empty() {
            PathCommand::Move(x, y)
        } else {
            PathCommand::Line(x, y)
        });
        if commands.len() > MAX_PATH_COMMANDS {
            return None;
        }
    }
    if close {
        commands.push(PathCommand::Close);
    }
    drawable(&commands).then_some(commands)
}

/// `min-x min-y width height`.
fn view_box(text: &str) -> Option<[f64; 4]> {
    let mut numbers = text
        .split([' ', ','])
        .filter(|part| !part.is_empty())
        .map(|part| part.parse::<f64>().ok());
    let parsed = [
        numbers.next()??,
        numbers.next()??,
        numbers.next()??,
        numbers.next()??,
    ];
    Some(parsed)
}

/// A path in a view box as a custom outline with its origin at zero.
fn custom_outline(
    commands: Vec<PathCommand>,
    filled: bool,
    bounds: Option<[f64; 4]>,
) -> Option<CustomPath> {
    let [min_x, min_y, width, height] = bounds?;
    if !(width > 0.0 && height > 0.0) {
        return None;
    }
    let shift = |x: f64, y: f64| (x - min_x, y - min_y);
    let commands = commands
        .into_iter()
        .map(|command| match command {
            PathCommand::Move(x, y) => {
                let (x, y) = shift(x, y);
                PathCommand::Move(x, y)
            }
            PathCommand::Line(x, y) => {
                let (x, y) = shift(x, y);
                PathCommand::Line(x, y)
            }
            PathCommand::Cubic(points) => PathCommand::Cubic([
                points[0] - min_x,
                points[1] - min_y,
                points[2] - min_x,
                points[3] - min_y,
                points[4] - min_x,
                points[5] - min_y,
            ]),
            PathCommand::Quad(points) => PathCommand::Quad([
                points[0] - min_x,
                points[1] - min_y,
                points[2] - min_x,
                points[3] - min_y,
            ]),
            PathCommand::Close => PathCommand::Close,
        })
        .collect();
    Some(CustomPath {
        width,
        height,
        commands,
        filled,
    })
}

/// The DrawingML preset names (ECMA-376 `ST_ShapeType`), sorted, so a type
/// taken from a document is only written when it is one of them.
const PRESETS: &[&str] = &[
    "accentBorderCallout1", "accentBorderCallout2", "accentBorderCallout3", "accentCallout1",
    "accentCallout2", "accentCallout3", "actionButtonBackPrevious", "actionButtonBeginning",
    "actionButtonBlank", "actionButtonDocument", "actionButtonEnd", "actionButtonForwardNext",
    "actionButtonHelp", "actionButtonHome", "actionButtonInformation", "actionButtonMovie",
    "actionButtonReturn", "actionButtonSound", "arc", "bentArrow", "bentConnector2",
    "bentConnector3", "bentConnector4", "bentConnector5", "bentUpArrow", "bevel", "blockArc",
    "borderCallout1", "borderCallout2", "borderCallout3", "bracePair", "bracketPair", "callout1",
    "callout2", "callout3", "can", "chartPlus", "chartStar", "chartX", "chevron", "chord",
    "circularArrow", "cloud", "cloudCallout", "corner", "cornerTabs", "cube", "curvedConnector2",
    "curvedConnector3", "curvedConnector4", "curvedConnector5", "curvedDownArrow",
    "curvedLeftArrow", "curvedRightArrow", "curvedUpArrow", "decagon", "diagStripe", "diamond",
    "dodecagon", "donut", "doubleWave", "downArrow", "downArrowCallout", "ellipse",
    "ellipseRibbon", "ellipseRibbon2", "flowChartAlternateProcess", "flowChartCollate",
    "flowChartConnector", "flowChartDecision", "flowChartDelay", "flowChartDisplay",
    "flowChartDocument", "flowChartExtract", "flowChartInputOutput", "flowChartInternalStorage",
    "flowChartMagneticDisk", "flowChartMagneticDrum", "flowChartMagneticTape",
    "flowChartManualInput", "flowChartManualOperation", "flowChartMerge",
    "flowChartMultidocument", "flowChartOfflineStorage", "flowChartOffpageConnector",
    "flowChartOnlineStorage", "flowChartOr", "flowChartPredefinedProcess",
    "flowChartPreparation", "flowChartProcess", "flowChartPunchedCard", "flowChartPunchedTape",
    "flowChartSort", "flowChartSummingJunction", "flowChartTerminator", "foldedCorner", "frame",
    "funnel", "gear6", "gear9", "halfFrame", "heart", "heptagon", "hexagon", "homePlate",
    "horizontalScroll", "irregularSeal1", "irregularSeal2", "leftArrow", "leftArrowCallout",
    "leftBrace", "leftBracket", "leftCircularArrow", "leftRightArrow", "leftRightArrowCallout",
    "leftRightCircularArrow", "leftRightRibbon", "leftRightUpArrow", "leftUpArrow",
    "lightningBolt", "line", "lineInv", "mathDivide", "mathEqual", "mathMinus", "mathMultiply",
    "mathNotEqual", "mathPlus", "moon", "noSmoking", "nonIsoscelesTrapezoid",
    "notchedRightArrow", "octagon", "parallelogram", "pentagon", "pie", "pieWedge", "plaque",
    "plaqueTabs", "plus", "quadArrow", "quadArrowCallout", "rect", "ribbon", "ribbon2",
    "rightArrow", "rightArrowCallout", "rightBrace", "rightBracket", "round1Rect",
    "round2DiagRect", "round2SameRect", "roundRect", "rtTriangle", "smileyFace", "snip1Rect",
    "snip2DiagRect", "snip2SameRect", "snipRoundRect", "squareTabs", "star10", "star12",
    "star16", "star24", "star32", "star4", "star5", "star6", "star7", "star8",
    "straightConnector1", "stripedRightArrow", "sun", "swooshArrow", "teardrop", "trapezoid",
    "triangle", "upArrow", "upArrowCallout", "upDownArrow", "upDownArrowCallout", "uturnArrow",
    "verticalScroll", "wave", "wedgeEllipseCallout", "wedgeRectCallout",
    "wedgeRoundRectCallout",
];

fn preset(name: &str) -> Option<&'static str> {
    PRESETS
        .binary_search(&name)
        .ok()
        .map(|index| PRESETS[index])
}

/// The names ODF applications give their own shapes (`draw:type`), with the
/// DrawingML preset that draws the same figure.
const ODF_SHAPE_TYPES: &[(&str, &str)] = &[
    ("rectangle", "rect"),
    ("round-rectangle", "roundRect"),
    ("ellipse", "ellipse"),
    ("isosceles-triangle", "triangle"),
    ("right-triangle", "rtTriangle"),
    ("trapezoid", "trapezoid"),
    ("diamond", "diamond"),
    ("parallelogram", "parallelogram"),
    ("pentagon", "pentagon"),
    ("hexagon", "hexagon"),
    ("octagon", "octagon"),
    ("cross", "plus"),
    ("star4", "star4"),
    ("star5", "star5"),
    ("star6", "star6"),
    ("star8", "star8"),
    ("star12", "star12"),
    ("star24", "star24"),
    ("right-arrow", "rightArrow"),
    ("left-arrow", "leftArrow"),
    ("up-arrow", "upArrow"),
    ("down-arrow", "downArrow"),
    ("left-right-arrow", "leftRightArrow"),
    ("up-down-arrow", "upDownArrow"),
    ("quad-arrow", "quadArrow"),
    ("notched-right-arrow", "notchedRightArrow"),
    ("striped-right-arrow", "stripedRightArrow"),
    ("circular-arrow", "circularArrow"),
    ("up-right-arrow", "leftUpArrow"),
    ("up-right-down-arrow", "leftRightUpArrow"),
    ("corner-right-arrow", "bentUpArrow"),
    ("right-arrow-callout", "rightArrowCallout"),
    ("left-arrow-callout", "leftArrowCallout"),
    ("up-arrow-callout", "upArrowCallout"),
    ("down-arrow-callout", "downArrowCallout"),
    ("left-right-arrow-callout", "leftRightArrowCallout"),
    ("up-down-arrow-callout", "upDownArrowCallout"),
    ("quad-arrow-callout", "quadArrowCallout"),
    ("chevron", "chevron"),
    ("pentagon-right", "homePlate"),
    ("heart", "heart"),
    ("sun", "sun"),
    ("moon", "moon"),
    ("cloud", "cloud"),
    ("lightning", "lightningBolt"),
    ("smiley", "smileyFace"),
    ("can", "can"),
    ("cube", "cube"),
    ("ring", "donut"),
    ("frame", "frame"),
    ("paper", "foldedCorner"),
    ("quad-bevel", "bevel"),
    ("forbidden", "noSmoking"),
    ("block-arc", "blockArc"),
    ("bracket-pair", "bracketPair"),
    ("brace-pair", "bracePair"),
    ("left-bracket", "leftBracket"),
    ("right-bracket", "rightBracket"),
    ("left-brace", "leftBrace"),
    ("right-brace", "rightBrace"),
    ("horizontal-scroll", "horizontalScroll"),
    ("vertical-scroll", "verticalScroll"),
    ("wave", "wave"),
    ("doublewave", "doubleWave"),
    ("bang", "irregularSeal1"),
    ("rectangular-callout", "wedgeRectCallout"),
    ("round-rectangular-callout", "wedgeRoundRectCallout"),
    ("round-callout", "wedgeEllipseCallout"),
    ("cloud-callout", "cloudCallout"),
    ("line-callout-1", "borderCallout1"),
    ("line-callout-2", "borderCallout2"),
    ("line-callout-3", "borderCallout3"),
    ("flowchart-process", "flowChartProcess"),
    ("flowchart-alternate-process", "flowChartAlternateProcess"),
    ("flowchart-decision", "flowChartDecision"),
    ("flowchart-data", "flowChartInputOutput"),
    ("flowchart-predefined-process", "flowChartPredefinedProcess"),
    ("flowchart-internal-storage", "flowChartInternalStorage"),
    ("flowchart-document", "flowChartDocument"),
    ("flowchart-multidocument", "flowChartMultidocument"),
    ("flowchart-terminator", "flowChartTerminator"),
    ("flowchart-preparation", "flowChartPreparation"),
    ("flowchart-manual-input", "flowChartManualInput"),
    ("flowchart-manual-operation", "flowChartManualOperation"),
    ("flowchart-connector", "flowChartConnector"),
    ("flowchart-off-page-connector", "flowChartOffpageConnector"),
    ("flowchart-card", "flowChartPunchedCard"),
    ("flowchart-punched-tape", "flowChartPunchedTape"),
    ("flowchart-summing-junction", "flowChartSummingJunction"),
    ("flowchart-or", "flowChartOr"),
    ("flowchart-collate", "flowChartCollate"),
    ("flowchart-sort", "flowChartSort"),
    ("flowchart-extract", "flowChartExtract"),
    ("flowchart-merge", "flowChartMerge"),
    ("flowchart-stored-data", "flowChartOnlineStorage"),
    ("flowchart-delay", "flowChartDelay"),
    ("flowchart-sequential-access", "flowChartMagneticTape"),
    ("flowchart-magnetic-disk", "flowChartMagneticDisk"),
    ("flowchart-direct-access-storage", "flowChartMagneticDrum"),
    ("flowchart-display", "flowChartDisplay"),
];

/// The preset behind a `draw:type`, when both sides have the figure.
fn preset_of_type(shape_type: &str) -> Option<&'static str> {
    // A shape that came from an OOXML file keeps its preset name.
    if let Some(name) = shape_type.strip_prefix("ooxml-") {
        return preset(name);
    }
    ODF_SHAPE_TYPES
        .iter()
        .find(|(odf, _)| *odf == shape_type)
        .map(|(_, ooxml)| *ooxml)
}

/// The outline of a `draw:enhanced-geometry`: a preset both sides know, the
/// path itself when it is a plain one, or the bounding rectangle.
fn outline_of(geometry: &EnhancedGeometry) -> Outline {
    let shape_type = geometry.shape_type.as_deref().unwrap_or("");
    if let Some(name) = preset_of_type(shape_type) {
        return Outline::Preset(name);
    }
    let Some(path) = geometry.path.as_deref() else {
        return Outline::Preset("rect");
    };
    // The export writes the presets it knows as paths on a 21600 grid; the
    // same path read back is the same preset.
    if geometry.view_box.as_deref().map(str::trim) == Some("0 0 21600 21600") {
        if let Some(name) = crate::ods_drawing::preset_of_path(path) {
            return preset(name).map_or(Outline::Preset("rect"), Outline::Preset);
        }
    }
    let bounds = geometry
        .view_box
        .as_deref()
        .and_then(view_box)
        .filter(|bounds| bounds[2] > 0.0 && bounds[3] > 0.0)
        // An outline that came from OOXML states its size apart from the box.
        .or_else(|| {
            let size = geometry.sub_view_size.as_deref()?;
            let mut numbers = size.split_whitespace().map(|part| part.parse::<f64>().ok());
            Some([0.0, 0.0, numbers.next()??, numbers.next()??])
        });
    enhanced_path(path)
        .and_then(|(commands, filled)| custom_outline(commands, filled, bounds))
        .map_or(Outline::Preset("rect"), Outline::Custom)
}

#[derive(Default)]
struct EnhancedGeometry {
    shape_type: Option<String>,
    view_box: Option<String>,
    path: Option<String>,
    sub_view_size: Option<String>,
    mirror_horizontal: bool,
    mirror_vertical: bool,
}

/// What a text event inside a shape belongs to.
#[derive(Clone, Copy, PartialEq)]
enum Capture {
    None,
    Description,
    Title,
}

/// A drawing while its element is being read.
struct ShapeBuilder {
    element: Vec<u8>,
    attributes: Vec<(String, String)>,
    cell: Option<(u32, u32)>,
    link: Option<String>,
    depth: usize,
    images: Vec<String>,
    object: Option<String>,
    text_box: bool,
    geometry: Option<EnhancedGeometry>,
    paragraphs: Vec<Paragraph>,
    /// How deep the open `text:p` elements go; text outside one is ignored.
    paragraph_depth: usize,
    spans: Vec<Option<String>>,
    text_length: usize,
    capture: Capture,
    description: String,
    title: String,
}

impl ShapeBuilder {
    fn new(
        element: &[u8],
        attributes: Vec<(String, String)>,
        cell: Option<(u32, u32)>,
        link: Option<String>,
    ) -> Self {
        Self {
            element: element.to_vec(),
            attributes,
            cell,
            link,
            depth: 1,
            images: Vec::new(),
            object: None,
            text_box: false,
            geometry: None,
            paragraphs: Vec::new(),
            paragraph_depth: 0,
            spans: Vec::new(),
            text_length: 0,
            capture: Capture::None,
            description: String::new(),
            title: String::new(),
        }
    }

    fn push_text(&mut self, text: &str) {
        match self.capture {
            Capture::Description => {
                if self.description.len() < MAX_SHAPE_TEXT {
                    self.description.push_str(text);
                }
            }
            Capture::Title => {
                if self.title.len() < MAX_SHAPE_TEXT {
                    self.title.push_str(text);
                }
            }
            Capture::None => {
                if self.paragraph_depth == 0 || self.text_length >= MAX_SHAPE_TEXT {
                    return;
                }
                self.text_length += text.chars().count();
                let style = self.spans.last().cloned().flatten();
                let Some(paragraph) = self.paragraphs.last_mut() else {
                    return;
                };
                match paragraph.runs.last_mut() {
                    Some(run) if !run.line_break && run.style == style => run.text.push_str(text),
                    _ => paragraph.runs.push(Run {
                        text: text.to_owned(),
                        style,
                        line_break: false,
                    }),
                }
            }
        }
    }

    fn child<R: BufRead>(
        &mut self,
        reader: &Reader<R>,
        element: &BytesStart<'_>,
        empty: bool,
    ) -> Result<(), SidecarError> {
        match element.name().as_ref() {
            b"draw:image" => {
                let attributes = attributes(reader, element)?;
                if let Some(href) = get(&attributes, "xlink:href") {
                    if self.images.len() < 4 {
                        self.images.push(href.to_owned());
                    }
                }
            }
            b"draw:object" => {
                let attributes = attributes(reader, element)?;
                self.object = get(&attributes, "xlink:href").map(str::to_owned);
            }
            b"draw:text-box" => self.text_box = true,
            b"draw:enhanced-geometry" => {
                let attributes = attributes(reader, element)?;
                let text = |name: &str| get(&attributes, name).map(str::to_owned);
                self.geometry = Some(EnhancedGeometry {
                    shape_type: text("draw:type"),
                    view_box: text("svg:viewBox"),
                    path: text("draw:enhanced-path"),
                    sub_view_size: text("drawooo:sub-view-size"),
                    mirror_horizontal: get(&attributes, "draw:mirror-horizontal") == Some("true"),
                    mirror_vertical: get(&attributes, "draw:mirror-vertical") == Some("true"),
                });
            }
            b"text:p" | b"text:h" => {
                if self.capture == Capture::None && self.paragraphs.len() < 2_000 {
                    let attributes = attributes(reader, element)?;
                    self.paragraphs.push(Paragraph {
                        style: get(&attributes, "text:style-name").map(str::to_owned),
                        runs: Vec::new(),
                    });
                    if !empty {
                        self.paragraph_depth += 1;
                    }
                }
            }
            b"text:span" => {
                if !empty {
                    let attributes = attributes(reader, element)?;
                    self.spans
                        .push(get(&attributes, "text:style-name").map(str::to_owned));
                }
            }
            b"text:s" => {
                let attributes = attributes(reader, element)?;
                let count = get(&attributes, "text:c")
                    .and_then(|count| count.parse::<usize>().ok())
                    .unwrap_or(1)
                    .clamp(1, 1_000);
                self.push_text(&" ".repeat(count));
            }
            b"text:tab" => self.push_text("\t"),
            b"text:line-break" => {
                if self.capture == Capture::None && self.paragraph_depth > 0 {
                    if let Some(paragraph) = self.paragraphs.last_mut() {
                        paragraph.runs.push(Run {
                            text: String::new(),
                            style: None,
                            line_break: true,
                        });
                    }
                }
            }
            b"svg:desc" if !empty => self.capture = Capture::Description,
            b"svg:title" if !empty => self.capture = Capture::Title,
            _ => {}
        }
        Ok(())
    }

    fn close(&mut self, name: &[u8]) {
        match name {
            b"text:p" | b"text:h" => self.paragraph_depth = self.paragraph_depth.saturating_sub(1),
            b"text:span" => {
                self.spans.pop();
            }
            b"svg:desc" | b"svg:title" => self.capture = Capture::None,
            _ => {}
        }
    }

    /// The finished drawing, or `None` for one with nothing this reader can
    /// place or draw.
    fn finish(self) -> Option<Shape> {
        let attributes = &self.attributes;
        let name = self.element.as_slice();
        let style_of = |key: &str| get(attributes, key).map(str::to_owned);
        let mut flip_h = false;
        let mut flip_v = false;
        let (mut x, mut y, width, height);
        let mut rotation = 0.0;
        let line = matches!(name, b"draw:line" | b"draw:connector");
        if line {
            let x1 = length(attributes, "svg:x1")?;
            let y1 = length(attributes, "svg:y1")?;
            let x2 = length(attributes, "svg:x2")?;
            let y2 = length(attributes, "svg:y2")?;
            x = x1.min(x2);
            y = y1.min(y2);
            width = (x2 - x1).abs();
            height = (y2 - y1).abs();
            flip_h = x2 < x1;
            flip_v = y2 < y1;
        } else {
            width = length(attributes, "svg:width")?;
            height = length(attributes, "svg:height")?;
            x = length(attributes, "svg:x").unwrap_or(0.0);
            y = length(attributes, "svg:y").unwrap_or(0.0);
            if let Some(transform) = get(attributes, "draw:transform") {
                // The frame is turned about its own corner and then moved;
                // its centre says where the unturned frame sits. The angle
                // runs counter-clockwise.
                let (angle, shift_x, shift_y) = rotation_transform(transform)?;
                let turn = -angle;
                let (sin, cos) = turn.sin_cos();
                let centre_x = width / 2.0 * cos - height / 2.0 * sin + shift_x;
                let centre_y = width / 2.0 * sin + height / 2.0 * cos + shift_y;
                x = centre_x - width / 2.0;
                y = centre_y - height / 2.0;
                rotation = turn.to_degrees().rem_euclid(360.0);
            }
        }
        if !(width.is_finite() && height.is_finite() && x.is_finite() && y.is_finite()) {
            return None;
        }
        if width < 0.0 || height < 0.0 || (width == 0.0 && height == 0.0) {
            return None;
        }

        let kind = match name {
            b"draw:frame" => {
                let chart = self
                    .object
                    .as_deref()
                    .map(|href| href.trim_start_matches("./").trim_end_matches('/'))
                    .filter(|href| !href.is_empty() && !href.contains("://") && !href.contains(".."));
                // The formats Excel draws; a vector original usually comes
                // with a bitmap copy next to it.
                let picture = self.images.iter().find(|href| {
                    !href.contains("://")
                        && !href.starts_with("..")
                        && !href.starts_with('/')
                        && href
                            .rsplit_once('.')
                            .is_some_and(|(_, extension)| media_extension(extension).is_some())
                });
                match (chart, picture) {
                    (Some(directory), _) => ShapeKind::Chart {
                        directory: directory.to_owned(),
                    },
                    (None, Some(href)) => ShapeKind::Picture {
                        entry: href.trim_start_matches("./").to_owned(),
                    },
                    (None, None) if self.text_box => ShapeKind::Shape {
                        outline: Outline::Preset("rect"),
                        text_box: true,
                    },
                    (None, None) => return None,
                }
            }
            b"draw:custom-shape" => {
                let geometry = self.geometry.as_ref();
                flip_h = geometry.is_some_and(|geometry| geometry.mirror_horizontal);
                flip_v = geometry.is_some_and(|geometry| geometry.mirror_vertical);
                ShapeKind::Shape {
                    outline: geometry.map_or(Outline::Preset("rect"), outline_of),
                    text_box: false,
                }
            }
            b"draw:rect" | b"draw:caption" => ShapeKind::Shape {
                outline: Outline::Preset(
                    if length(attributes, "draw:corner-radius").is_some_and(|radius| radius > 0.0) {
                        "roundRect"
                    } else {
                        "rect"
                    },
                ),
                text_box: false,
            },
            b"draw:ellipse" | b"draw:circle" => ShapeKind::Shape {
                outline: Outline::Preset("ellipse"),
                text_box: false,
            },
            b"draw:line" => ShapeKind::Line { preset: "line" },
            b"draw:connector" => ShapeKind::Line {
                preset: match get(attributes, "draw:type") {
                    Some("curve") => "curvedConnector3",
                    Some("line") | Some("lines") => "line",
                    // An elbow connector is the default kind.
                    _ => "bentConnector3",
                },
            },
            b"draw:polygon" | b"draw:polyline" => {
                let closed = name == b"draw:polygon";
                let outline = get(attributes, "draw:points")
                    .and_then(|points| points_path(points, closed))
                    .and_then(|commands| {
                        custom_outline(
                            commands,
                            closed,
                            get(attributes, "svg:viewBox").and_then(view_box),
                        )
                    });
                ShapeKind::Shape {
                    outline: outline.map_or(Outline::Preset("rect"), Outline::Custom),
                    text_box: false,
                }
            }
            b"draw:path" => {
                let outline = get(attributes, "svg:d").and_then(svg_path).and_then(|commands| {
                    let closed = commands.contains(&PathCommand::Close);
                    custom_outline(
                        commands,
                        closed,
                        get(attributes, "svg:viewBox").and_then(view_box),
                    )
                });
                ShapeKind::Shape {
                    outline: outline.map_or(Outline::Preset("rect"), Outline::Custom),
                    text_box: false,
                }
            }
            _ => return None,
        };

        let end = get(attributes, "table:end-cell-address")
            .and_then(end_cell)
            .map(|(row, column)| EndMarker {
                row,
                column,
                x: length(attributes, "table:end-x").unwrap_or(0.0).max(0.0),
                y: length(attributes, "table:end-y").unwrap_or(0.0).max(0.0),
            });
        let trimmed = |text: String| {
            let text = text.trim().to_owned();
            (!text.is_empty()).then_some(text)
        };
        Some(Shape {
            cell: self.cell,
            x,
            y,
            width,
            height,
            end,
            z_index: get(attributes, "draw:z-index")
                .and_then(|index| index.parse().ok())
                .unwrap_or(0),
            name: style_of("draw:name").filter(|name| !name.is_empty()),
            description: trimmed(self.description),
            title: trimmed(self.title),
            link: self.link,
            style: style_of("draw:style-name"),
            text_style: style_of("draw:text-style-name"),
            kind,
            flip_h,
            flip_v,
            rotation,
            figure: name == b"draw:custom-shape",
            paragraphs: self.paragraphs,
        })
    }
}

/// The extension a picture is written under in the workbook, for the formats
/// Excel draws.
pub(crate) fn media_extension(extension: &str) -> Option<&'static str> {
    let extension = extension.to_ascii_lowercase();
    crate::xlsx_package::MEDIA_TYPES
        .iter()
        .find(|(known, _)| *known == extension)
        .map(|(known, _)| *known)
}

fn is_shape_element(name: &[u8]) -> bool {
    matches!(
        name,
        b"draw:frame"
            | b"draw:custom-shape"
            | b"draw:rect"
            | b"draw:ellipse"
            | b"draw:circle"
            | b"draw:line"
            | b"draw:connector"
            | b"draw:polygon"
            | b"draw:polyline"
            | b"draw:path"
            | b"draw:caption"
    )
}

/// Streams a document for its drawing styles and the sizes its column and
/// row styles state and, when `body` is set, for the drawings and the grid of
/// each `table:table`.
fn parse<R: BufRead>(
    reader: &mut Reader<R>,
    styles: &mut DrawStyles,
    sizes: &mut Sizes,
    sheets: &mut Vec<SheetBuilder>,
    body: bool,
) -> Result<(), SidecarError> {
    // The style being read: its family, its name (none for a family default)
    // and what it has set so far.
    let mut style: Option<(Family, Option<String>, DrawStyle)> = None;
    // The gradient being read: its name, its angle, the two colours it
    // states itself and the stops listed inside it.
    let mut gradient: Option<PendingGradient> = None;
    // The column or row style being read: true for a row style, and its id.
    let mut size_style: Option<(bool, u32)> = None;
    let mut next_column_definition = 0u32;
    let mut builder: Option<ShapeBuilder> = None;
    let mut link: Option<String> = None;
    let mut total = 0usize;
    // Where the cursor stands in the current table.
    let mut in_table = false;
    let mut in_cell = false;
    let mut in_shapes = false;
    let mut row = 0u32;
    let mut next_row = 0u32;
    let mut column = 0u32;
    let mut next_column = 0u32;
    let repeat = |reader: &Reader<R>, element: &BytesStart<'_>, name: &[u8]| -> u32 {
        crate::xml_util::attribute_value(reader, element, name)
            .ok()
            .flatten()
            .and_then(|value| value.trim().parse::<u32>().ok())
            .unwrap_or(1)
            .max(1)
    };
    let mut buf = Vec::new();
    loop {
        let event = reader.read_event_into(&mut buf)?;
        let empty = matches!(&event, Event::Empty(_));
        match event {
            Event::Eof => break,
            Event::Start(element) | Event::Empty(element) => {
                let name = element.name();
                let name = name.as_ref();
                if let Some(shape) = builder.as_mut() {
                    shape.child(reader, &element, empty)?;
                    if !empty {
                        shape.depth += 1;
                    }
                    buf.clear();
                    continue;
                }
                match name {
                    b"draw:stroke-dash" => {
                        let attributes = attributes(reader, &element)?;
                        if let Some(name) = get(&attributes, "draw:name") {
                            if styles.dashes.len() < MAX_NAMED_STYLES {
                                styles.dashes.insert(name.to_owned(), dash_preset(&attributes));
                            }
                        }
                    }
                    b"draw:gradient" => {
                        let attributes = attributes(reader, &element)?;
                        // Only a gradient along a line has a counterpart
                        // this reader writes; the others keep the flat fill.
                        gradient = match (
                            get(&attributes, "draw:name"),
                            get(&attributes, "draw:style").unwrap_or("linear"),
                            gradient_degrees(get(&attributes, "draw:angle")),
                        ) {
                            (Some(name), "linear", Some(degrees))
                                if styles.gradients.len() < MAX_NAMED_STYLES =>
                            {
                                let ends: Vec<(f64, String)> = [
                                    (0.0, get(&attributes, "draw:start-color")),
                                    (1.0, get(&attributes, "draw:end-color")),
                                ]
                                .into_iter()
                                .filter_map(|(at, value)| Some((at, color(value?)?)))
                                .collect();
                                Some((
                                    name.to_owned(),
                                    // The format turns a top-to-bottom
                                    // gradient anticlockwise.
                                    (90.0 - degrees).rem_euclid(360.0),
                                    ends,
                                    Vec::new(),
                                ))
                            }
                            _ => None,
                        };
                        if empty {
                            finish_gradient(&mut gradient, styles);
                        }
                    }
                    b"loext:gradient-stop" => {
                        if let Some((_, _, _, stops)) = gradient.as_mut() {
                            let attributes = attributes(reader, &element)?;
                            let at = get(&attributes, "svg:offset")
                                .and_then(|offset| offset.trim().parse::<f64>().ok())
                                .filter(|offset| offset.is_finite());
                            let value = get(&attributes, "loext:color-value").and_then(color);
                            if let (Some(at), Some(value)) = (at, value) {
                                if stops.len() < MAX_GRADIENT_STOPS {
                                    stops.push((at.clamp(0.0, 1.0), value));
                                }
                            }
                        }
                    }
                    b"style:style" | b"style:default-style" => {
                        let attributes = attributes(reader, &element)?;
                        size_style = match (
                            get(&attributes, "style:family"),
                            get(&attributes, "style:name"),
                        ) {
                            (Some("table-column"), Some(name)) if !empty => {
                                Some((false, sizes.id(name.as_bytes())))
                            }
                            (Some("table-row"), Some(name)) if !empty => {
                                Some((true, sizes.id(name.as_bytes())))
                            }
                            _ => None,
                        };
                        style = get(&attributes, "style:family").and_then(Family::of).map(|family| {
                            let own = DrawStyle {
                                parent: get(&attributes, "style:parent-style-name")
                                    .map(str::to_owned),
                                ..DrawStyle::default()
                            };
                            let name = (name == b"style:style")
                                .then(|| get(&attributes, "style:name").map(str::to_owned))
                                .flatten();
                            (family, name, own)
                        });
                        if empty {
                            if let Some((family, Some(name), own)) = style.take() {
                                styles.styles.insert((family, name), own);
                            }
                        }
                    }
                    b"style:graphic-properties"
                    | b"style:paragraph-properties"
                    | b"style:text-properties" => {
                        if let Some((_, _, own)) = style.as_mut() {
                            let attributes = attributes(reader, &element)?;
                            read_properties(name, &attributes, own);
                        }
                    }
                    b"style:table-column-properties" | b"style:table-row-properties" => {
                        if let Some((is_row, id)) = size_style {
                            let attributes = attributes(reader, &element)?;
                            let (size, fitted) = if is_row {
                                ("style:row-height", "style:use-optimal-row-height")
                            } else {
                                ("style:column-width", "style:use-optimal-column-width")
                            };
                            if let Some(size) = length(&attributes, size).filter(|size| *size >= 0.0) {
                                let fitted = get(&attributes, fitted) == Some("true");
                                let table = if is_row { &mut sizes.rows } else { &mut sizes.columns };
                                table.insert(id, (size, fitted));
                            }
                        }
                    }
                    b"table:table" if body => {
                        sheets.push(SheetBuilder::default());
                        in_table = !empty;
                        in_cell = false;
                        in_shapes = false;
                        row = 0;
                        next_row = 0;
                        column = 0;
                        next_column = 0;
                        next_column_definition = 0;
                    }
                    b"table:table-column" if in_table => {
                        let (repeats, style, hidden) =
                            span_attributes(&element, b"number-columns-repeated", sizes);
                        let first = next_column_definition;
                        next_column_definition =
                            next_column_definition.saturating_add(repeats).min(MAX_COLUMN);
                        if let Some(sheet) = sheets.last_mut().filter(|_| first < MAX_COLUMN) {
                            push_span(
                                &mut sheet.columns,
                                first,
                                next_column_definition - 1,
                                style,
                                hidden,
                            );
                        }
                    }
                    b"table:table-row" if in_table => {
                        let (repeats, style, hidden) =
                            span_attributes(&element, b"number-rows-repeated", sizes);
                        row = next_row;
                        next_row = next_row.saturating_add(repeats).min(MAX_ROW);
                        column = 0;
                        next_column = 0;
                        if let Some(sheet) = sheets.last_mut().filter(|_| row < MAX_ROW) {
                            push_span(&mut sheet.rows, row, next_row - 1, style, hidden);
                        }
                    }
                    b"table:table-cell" | b"table:covered-table-cell" if in_table => {
                        let repeats = repeat(reader, &element, b"number-columns-repeated");
                        column = next_column;
                        next_column = next_column.saturating_add(repeats).min(MAX_COLUMN);
                        in_cell = !empty;
                    }
                    b"table:shapes" if in_table => in_shapes = !empty,
                    b"draw:a" if in_cell || in_shapes => {
                        if !empty {
                            let attributes = attributes(reader, &element)?;
                            link = get(&attributes, "xlink:href").map(str::to_owned);
                        }
                    }
                    _ if (in_cell || in_shapes) && is_shape_element(name) => {
                        let cell = (in_cell && !in_shapes)
                            .then_some((row.min(MAX_ROW - 1), column.min(MAX_COLUMN - 1)));
                        let shape =
                            ShapeBuilder::new(name, attributes(reader, &element)?, cell, link.clone());
                        if empty {
                            if let (Some(shape), Some(sheet)) = (shape.finish(), sheets.last_mut()) {
                                if total < MAX_SHAPES {
                                    sheet.shapes.push(shape);
                                    total += 1;
                                }
                            }
                        } else {
                            builder = Some(shape);
                        }
                    }
                    _ => {}
                }
            }
            Event::Text(text) => {
                if let Some(shape) = builder.as_mut() {
                    shape.push_text(&decode_text(&text)?);
                }
            }
            Event::GeneralRef(reference) => {
                if let Some(shape) = builder.as_mut() {
                    shape.push_text(&general_ref_text(&reference)?);
                }
            }
            Event::End(end) => {
                let name = end.name();
                let name = name.as_ref();
                if let Some(shape) = builder.as_mut() {
                    shape.close(name);
                    shape.depth -= 1;
                    if shape.depth == 0 {
                        let finished = builder.take().and_then(ShapeBuilder::finish);
                        if let (Some(shape), Some(sheet)) = (finished, sheets.last_mut()) {
                            if total < MAX_SHAPES {
                                sheet.shapes.push(shape);
                                total += 1;
                            }
                        }
                    }
                    buf.clear();
                    continue;
                }
                match name {
                    b"draw:gradient" => finish_gradient(&mut gradient, styles),
                    b"style:style" | b"style:default-style" => {
                        size_style = None;
                        match style.take() {
                            Some((family, Some(name), own)) => {
                                styles.styles.insert((family, name), own);
                            }
                            Some((family, None, own)) => {
                                styles.defaults.insert(family, own);
                            }
                            None => {}
                        }
                    }
                    b"table:table" => {
                        in_table = false;
                        in_cell = false;
                        in_shapes = false;
                    }
                    b"table:table-cell" | b"table:covered-table-cell" => in_cell = false,
                    b"table:shapes" => in_shapes = false,
                    b"draw:a" => link = None,
                    _ => {}
                }
            }
            _ => {}
        }
        buf.clear();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read(automatic: &str, body: &str) -> OdfDrawings {
        let xml = format!(
            r#"<office:document-content><office:automatic-styles>{automatic}</office:automatic-styles><office:body><office:spreadsheet>{body}</office:spreadsheet></office:body></office:document-content>"#
        );
        let mut drawings = OdfDrawings::default();
        let mut sizes = Sizes::default();
        let mut reader = Reader::from_str(&xml);
        let mut sheets = Vec::new();
        parse(&mut reader, &mut drawings.styles, &mut sizes, &mut sheets, true).unwrap();
        drawings.sheets = finish_sheets(sheets, &sizes);
        drawings
    }

    #[test]
    fn reads_the_grid_the_drawings_sit_on() {
        let drawings = read(
            concat!(
                r#"<style:style style:name="co1" style:family="table-column"><style:table-column-properties style:column-width="2.54cm"/></style:style>"#,
                r#"<style:style style:name="ro1" style:family="table-row"><style:table-row-properties style:row-height="0.452cm" style:use-optimal-row-height="true"/></style:style>"#,
                r#"<style:style style:name="ro2" style:family="table-row"><style:table-row-properties style:row-height="1cm" style:use-optimal-row-height="false"/></style:style>"#,
            ),
            concat!(
                r#"<table:table table:name="S"><table:table-column table:style-name="co1" table:number-columns-repeated="2"/><table:table-column table:visibility="collapse"/><table:table-column/><table:table-column table:style-name="co1"/>"#,
                r#"<table:table-row table:style-name="ro1"><table:table-cell/></table:table-row>"#,
                r#"<table:table-row table:style-name="ro1" table:number-rows-repeated="3"><table:table-cell/></table:table-row>"#,
                r#"<table:table-row table:style-name="ro2" table:visibility="filter"><table:table-cell/></table:table-row>"#,
                r#"<table:table-row><table:table-cell/></table:table-row>"#,
                r#"<table:table-row table:style-name="ro2"><table:table-cell><draw:rect svg:width="1cm" svg:height="1cm"/></table:table-cell></table:table-row>"#,
                r#"</table:table>"#,
            ),
        );
        let sheet = &drawings.sheets[0];
        let inch = 914_400.0;
        assert_eq!(
            sheet.columns,
            vec![
                Span { first: 0, last: 1, size: inch, fitted: false, hidden: false },
                Span { first: 2, last: 2, size: 0.0, fitted: true, hidden: true },
                Span { first: 4, last: 4, size: inch, fitted: false, hidden: false },
            ]
        );
        // Rows that share a style are one run.
        assert_eq!(sheet.rows.len(), 3);
        assert_eq!((sheet.rows[0].first, sheet.rows[0].last, sheet.rows[0].fitted), (0, 3, true));
        assert!((sheet.rows[0].size - 0.452 * 360_000.0).abs() < 1.0);
        assert_eq!((sheet.rows[1].first, sheet.rows[1].hidden), (4, true));
        assert_eq!((sheet.rows[2].first, sheet.rows[2].last, sheet.rows[2].fitted), (6, 6, false));
        assert_eq!(sheet.shapes[0].cell, Some((6, 0)));
    }

    #[test]
    fn finds_the_drawing_marker_across_a_block_boundary() {
        let mut text = vec![b' '; 64 * 1024 - 3];
        text.extend_from_slice(b"<draw:frame/>");
        assert!(mentions_drawings(text.as_slice()).unwrap());
        assert!(!mentions_drawings(&b"<table:table><text:p>draw:</text:p></table:table>"[..]).unwrap());
        assert!(!mentions_drawings(&b""[..]).unwrap());
    }

    #[test]
    fn places_a_drawing_in_the_cell_that_holds_it() {
        let drawings = read(
            "",
            concat!(
                r#"<table:table table:name="One"><table:table-column table:number-columns-repeated="8"/>"#,
                r#"<table:table-row table:number-rows-repeated="3"><table:table-cell table:number-columns-repeated="8"/></table:table-row>"#,
                r#"<table:table-row><table:table-cell table:number-columns-repeated="2"/><table:table-cell office:value-type="string"><text:p>cell text</text:p>"#,
                r#"<draw:frame draw:style-name="gr1" table:end-cell-address="One.F9" table:end-x="0.529cm" table:end-y="0.265cm" draw:z-index="3" draw:name="Pic &amp; co" svg:width="2cm" svg:height="1cm" svg:x="0.1cm" svg:y="0.2cm">"#,
                r#"<draw:image xlink:href="Pictures/a.svg"/><draw:image xlink:href="Pictures/a.png"><text:p/></draw:image><svg:title>T</svg:title><svg:desc>alt &lt;text&gt;</svg:desc></draw:frame>"#,
                r#"</table:table-cell></table:table-row></table:table>"#,
                r#"<table:table table:name="Two"><table:shapes><draw:rect svg:x="3cm" svg:y="4cm" svg:width="1cm" svg:height="1cm"/></table:shapes>"#,
                r#"<table:table-row><table:table-cell/></table:table-row></table:table>"#,
            ),
        );
        assert_eq!(drawings.sheets.len(), 2);
        let picture = &drawings.sheets[0].shapes[0];
        assert_eq!(picture.cell, Some((3, 2)));
        // The bitmap is taken; the vector original next to it is not a
        // format a workbook can show.
        assert_eq!(
            picture.kind,
            ShapeKind::Picture {
                entry: "Pictures/a.png".into()
            }
        );
        assert_eq!(picture.name.as_deref(), Some("Pic & co"));
        assert_eq!(picture.description.as_deref(), Some("alt <text>"));
        assert_eq!(picture.title.as_deref(), Some("T"));
        assert_eq!(picture.z_index, 3);
        assert_eq!(picture.x.round(), 36_000.0);
        assert_eq!(picture.width.round(), 720_000.0);
        assert_eq!(
            picture.end,
            Some(EndMarker {
                row: 8,
                column: 5,
                x: length(&[("x".into(), "0.529cm".into())], "x").unwrap(),
                y: length(&[("x".into(), "0.265cm".into())], "x").unwrap(),
            })
        );
        // The cell's own text is not the picture's.
        assert!(picture.paragraphs.iter().all(|paragraph| paragraph.runs.is_empty()));
        let pinned = &drawings.sheets[1].shapes[0];
        assert_eq!(pinned.cell, None);
        assert_eq!(pinned.x.round(), 1_080_000.0);
    }

    #[test]
    fn reads_shapes_their_text_and_their_styles() {
        let drawings = read(
            concat!(
                r##"<style:style style:name="gr1" style:family="graphic" style:parent-style-name="Base"><style:graphic-properties draw:stroke="solid" svg:stroke-width="0.053cm" svg:stroke-color="#1f3864" draw:fill-color="#4472c4" draw:textarea-vertical-align="middle" fo:padding-left="0.25cm"/><style:text-properties fo:font-size="18pt"/></style:style>"##,
                r##"<style:style style:name="Base" style:family="graphic"><style:graphic-properties draw:fill="none" draw:fill-color="#ffffff"/></style:style>"##,
                r##"<style:style style:name="P1" style:family="paragraph"><style:paragraph-properties fo:text-align="center"/></style:style>"##,
                r##"<style:style style:name="T1" style:family="text"><style:text-properties fo:color="#c00000" fo:font-size="14pt" fo:font-weight="bold" fo:font-style="italic" style:text-underline-style="solid" fo:font-family="'Malgun Gothic'"/></style:style>"##,
                r##"<style:style style:name="ce1" style:family="table-cell"><style:text-properties fo:color="#00ff00"/></style:style>"##,
            ),
            concat!(
                r#"<table:table table:name="S"><table:table-row><table:table-cell>"#,
                r#"<draw:a xlink:type="simple" xlink:href="https://example.com/"><draw:custom-shape draw:style-name="gr1" svg:width="3cm" svg:height="2cm" svg:x="0cm" svg:y="0cm">"#,
                r#"<text:p text:style-name="P1"><text:span text:style-name="T1">글상자 <text:s text:c="2"/>A&amp;B</text:span><text:line-break/>tail</text:p><text:p/>"#,
                r#"<draw:enhanced-geometry svg:viewBox="0 0 21600 21600" draw:type="non-primitive" draw:mirror-horizontal="true" draw:enhanced-path="M 0 5400 L 16200 5400 16200 0 21600 10800 16200 21600 16200 16200 0 16200 Z N"/></draw:custom-shape></draw:a>"#,
                r#"<draw:custom-shape svg:width="1cm" svg:height="1cm"><draw:enhanced-geometry svg:viewBox="0 0 0 0" drawooo:sub-view-size="1000 1000" draw:type="ooxml-non-primitive" draw:enhanced-path="M 0 1000 L 500 0 1000 1000 C 750 700 250 700 0 1000 Z N"/></draw:custom-shape>"#,
                r#"<draw:custom-shape svg:width="1cm" svg:height="1cm"><draw:enhanced-geometry svg:viewBox="0 0 0 0" draw:type="ooxml-cloud" draw:enhanced-path="M 3900 14370 Z N M ?f14 ?f15 F N"/></draw:custom-shape>"#,
                r#"<draw:custom-shape svg:width="1cm" svg:height="1cm"><draw:enhanced-geometry svg:viewBox="0 0 21600 21600" draw:type="mso-spt100" draw:enhanced-path="M ?f0 0 L 21600 21600 Z N"/></draw:custom-shape>"#,
                r#"<draw:line svg:x1="1cm" svg:y1="2cm" svg:x2="0cm" svg:y2="0.5cm"/>"#,
                r#"</table:table-cell></table:table-row></table:table>"#,
            ),
        );
        let shapes = &drawings.sheets[0].shapes;
        assert_eq!(shapes.len(), 5);
        let arrow = &shapes[0];
        assert_eq!(
            arrow.kind,
            ShapeKind::Shape {
                outline: Outline::Preset("rightArrow"),
                text_box: false
            }
        );
        assert!(arrow.flip_h && !arrow.flip_v);
        assert_eq!(arrow.link.as_deref(), Some("https://example.com/"));
        assert_eq!(arrow.paragraphs.len(), 2);
        assert_eq!(arrow.paragraphs[0].style.as_deref(), Some("P1"));
        assert_eq!(
            arrow.paragraphs[0].runs,
            vec![
                Run {
                    text: "글상자   A&B".into(),
                    style: Some("T1".into()),
                    line_break: false
                },
                Run {
                    text: String::new(),
                    style: None,
                    line_break: true
                },
                Run {
                    text: "tail".into(),
                    style: None,
                    line_break: false
                },
            ]
        );
        // The link belongs to the shape it wraps only.
        assert_eq!(shapes[1].link, None);
        match &shapes[1].kind {
            ShapeKind::Shape {
                outline: Outline::Custom(path),
                ..
            } => {
                assert_eq!((path.width, path.height), (1000.0, 1000.0));
                assert_eq!(path.commands.len(), 5);
                assert_eq!(path.commands[3], PathCommand::Cubic([750.0, 700.0, 250.0, 700.0, 0.0, 1000.0]));
                assert!(path.filled);
            }
            other => panic!("{other:?}"),
        }
        // A preset both sides name wins over a path full of formulas, and a
        // figure neither can be read from falls back to its box.
        assert_eq!(
            shapes[2].kind,
            ShapeKind::Shape {
                outline: Outline::Preset("cloud"),
                text_box: false
            }
        );
        assert_eq!(
            shapes[3].kind,
            ShapeKind::Shape {
                outline: Outline::Preset("rect"),
                text_box: false
            }
        );
        let line = &shapes[4];
        assert_eq!(line.kind, ShapeKind::Line { preset: "line" });
        assert!(line.flip_h && line.flip_v);
        assert_eq!((line.x, line.width.round()), (0.0, 360_000.0));
        assert_eq!(line.height.round(), 540_000.0);

        let style = drawings.styles.resolve(Family::Graphic, Some("gr1"));
        assert_eq!(style.stroke.as_deref(), Some("solid"));
        assert!((style.stroke_width.unwrap() - 0.053 / 2.54 * 72.0).abs() < 1e-9);
        assert_eq!(style.stroke_color.as_deref(), Some("1F3864"));
        // The style's own colour over the parent's, the parent's fill kind.
        assert_eq!(style.fill_color.as_deref(), Some("4472C4"));
        assert_eq!(style.fill.as_deref(), Some("none"));
        assert_eq!(style.vertical_align.as_deref(), Some("middle"));
        assert_eq!(style.size, Some(18.0));
        let text = drawings.styles.resolve(Family::Text, Some("T1"));
        assert_eq!(text.color.as_deref(), Some("C00000"));
        assert_eq!((text.bold, text.italic, text.underline), (Some(true), Some(true), Some(true)));
        assert_eq!(text.font.as_deref(), Some("Malgun Gothic"));
        assert_eq!(drawings.styles.resolve(Family::Text, Some("ce1")), DrawStyle::default());
    }

    #[test]
    fn a_turned_shape_gives_its_unturned_frame_and_angle() {
        // Thirty degrees clockwise, as a spreadsheet writes it.
        let drawings = read(
            "",
            concat!(
                r#"<table:table table:name="S"><table:table-row><table:table-cell>"#,
                r#"<draw:custom-shape svg:width="3.4cm" svg:height="1.805cm" draw:transform="rotate (-0.5235987755983) translate (0.679cm -0.277cm)"><draw:enhanced-geometry draw:type="ooxml-rightArrow"/></draw:custom-shape>"#,
                r#"<draw:custom-shape svg:width="1cm" svg:height="1cm" draw:transform="skewX (0.3) translate (1cm 1cm)"/>"#,
                r#"</table:table-cell></table:table-row></table:table>"#,
            ),
        );
        let shapes = &drawings.sheets[0].shapes;
        // The skewed one has no frame to name and is left out.
        assert_eq!(shapes.len(), 1);
        let shape = &shapes[0];
        assert!((shape.rotation - 30.0).abs() < 1e-6, "{}", shape.rotation);
        let cm = 360_000.0;
        assert!((shape.x / cm - 0.0).abs() < 0.01, "{}", shape.x / cm);
        assert!((shape.y / cm - 0.452).abs() < 0.01, "{}", shape.y / cm);
    }

    #[test]
    fn reads_paths_and_cell_addresses() {
        assert_eq!(end_cell("Sheet.E6"), Some((5, 4)));
        assert_eq!(end_cell("'My. sheet'.$AB$10"), Some((9, 27)));
        assert_eq!(end_cell("Sheet.6"), None);
        assert_eq!(end_cell("Sheet.A0"), None);
        assert_eq!(
            svg_path("m0 0 10 0v5h-10z"),
            Some(vec![
                PathCommand::Move(0.0, 0.0),
                PathCommand::Line(10.0, 0.0),
                PathCommand::Line(10.0, 5.0),
                PathCommand::Line(0.0, 5.0),
                PathCommand::Close,
            ])
        );
        assert_eq!(svg_path("M0 0A5 5 0 0 1 10 10"), None);
        assert_eq!(enhanced_path("M 0 0 X 10 10 Z N"), None);
        assert_eq!(enhanced_path("M 0 0 Z N"), None, "a path that goes nowhere");
        assert_eq!(preset("cloud"), Some("cloud"));
        assert_eq!(preset("notAShape"), None);
        assert!(PRESETS.windows(2).all(|pair| pair[0] < pair[1]), "sorted for the search");
        assert_eq!(PRESETS.len(), 187);
        assert!(ODF_SHAPE_TYPES.iter().all(|(_, name)| preset(name).is_some()));
        assert_eq!(preset_of_type("isosceles-triangle"), Some("triangle"));
        assert_eq!(preset_of_type("ooxml-roundRect"), Some("roundRect"));
        assert_eq!(preset_of_type("ooxml-bogus"), None);
        assert_eq!(color("#Ab01ef").as_deref(), Some("AB01EF"));
        assert_eq!(color("transparent"), None);
        assert_eq!(media_extension("JPG"), Some("jpg"));
        assert_eq!(media_extension("svg"), None);
    }

    #[test]
    fn a_named_dash_becomes_the_nearest_preset() {
        let dash = |pairs: &[(&str, &str)]| {
            let attributes: Vec<(String, String)> = pairs
                .iter()
                .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
                .collect();
            dash_preset(&attributes)
        };
        // The ones the export writes come back as they went.
        for entry in crate::ods_drawing::DASHES {
            let (one, two, gap) = (format!("{}%", entry.2), format!("{}%", entry.4), format!("{}%", entry.5));
            let (count1, count2) = (entry.1.to_string(), entry.3.to_string());
            let mut pairs = vec![
                ("draw:dots1", count1.as_str()),
                ("draw:dots1-length", one.as_str()),
                ("draw:distance", gap.as_str()),
            ];
            if entry.3 > 0 {
                pairs.push(("draw:dots2", count2.as_str()));
                pairs.push(("draw:dots2-length", two.as_str()));
            }
            assert_eq!(dash(&pairs), entry.0);
        }
        // Another writer's dashes, in lengths and with the dots first.
        assert_eq!(
            dash(&[("draw:dots1", "1"), ("draw:dots1-length", "0.2cm"), ("draw:distance", "0.1cm")]),
            "dash"
        );
        assert_eq!(
            dash(&[
                ("draw:dots1", "2"),
                ("draw:dots1-length", "100%"),
                ("draw:dots2", "1"),
                ("draw:dots2-length", "900%"),
                ("draw:distance", "300%"),
            ]),
            "lgDashDotDot"
        );
        assert_eq!(dash(&[("draw:dots1", "1"), ("draw:distance", "100%")]), "sysDot");
        assert_eq!(dash(&[]), "dash");
        // Angles: with a unit, and in tenths of a degree without one.
        assert_eq!(gradient_degrees(Some("45deg")), Some(45.0));
        assert_eq!(gradient_degrees(Some("900")), Some(90.0));
        assert_eq!(gradient_degrees(None), Some(0.0));
        assert_eq!(gradient_degrees(Some("soon")), None);
    }
}
