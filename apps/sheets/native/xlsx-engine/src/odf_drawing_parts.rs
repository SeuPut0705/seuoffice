//! The drawing part of a sheet, written from the drawings an `.ods` document
//! placed on it.
//!
//! `odf_drawings` says what the document holds; this module says it in
//! SpreadsheetML: one `xl/drawings/drawingN.xml` per sheet with an anchor for
//! every picture, shape, line and chart, the relationships behind them, and
//! the chart parts. Pictures are not read here — the package writer streams
//! them from the source — so only their names travel.
//!
//! A drawing sits in the cell the document put it in. An offset that runs
//! past that cell is walked along the columns and rows as the workbook will
//! size them, because Excel stops an offset at the edge of its cell.

use std::collections::HashMap;
use std::fs::File;
use std::path::Path;

use zip::ZipArchive;

use crate::SidecarError;
use crate::odf_chart_parts;
use crate::odf_drawings::{
    CustomPath, DrawStyle, DrawStyles, EMU_PER_POINT, Family, Gradient, Outline, PathCommand, Shape,
    ShapeKind, SheetDrawings, Span, media_extension,
};
use crate::xlsx_package::{SheetArt, escape_xml};
use crate::xml_util::{copy_entry_bounded, decode_uri_path};

const EMU_PER_PIXEL: f64 = 9_525.0;
const MAX_ROW: u32 = 1_048_576;
const MAX_COLUMN: u32 = 16_384;
/// A chart document is a few kilobytes; one past this is not a chart worth
/// holding in memory.
const MAX_CHART_BYTES: u64 = 16 * 1024 * 1024;
/// Excel's own text insets, in EMU.
const DEFAULT_INSETS: [f64; 4] = [91_440.0, 45_720.0, 91_440.0, 45_720.0];
/// The colours a drawing has when neither its style nor the document's
/// default names one.
const DEFAULT_LINE: &str = "3465A4";
const DEFAULT_FILL: &str = "729FCF";

const CHART_TYPE: &str = "application/vnd.openxmlformats-officedocument.drawingml.chart+xml";

/// The sizes of the columns or the rows of a sheet, in EMU.
struct Axis {
    /// `(first, last, size)`, in order and apart.
    spans: Vec<(u32, u32, f64)>,
    default: f64,
    /// One past the last index the grid has.
    limit: u32,
}

impl Axis {
    fn new(spans: impl Iterator<Item = (u32, u32, f64)>, default: f64, limit: u32) -> Self {
        let mut kept: Vec<(u32, u32, f64)> = Vec::new();
        for (first, last, size) in spans {
            if first <= last && last < limit && kept.last().is_none_or(|span| span.1 < first) {
                kept.push((first, last, size.max(0.0)));
            }
        }
        Self {
            spans: kept,
            default,
            limit,
        }
    }

    fn size(&self, index: u32) -> f64 {
        let position = self.spans.partition_point(|span| span.1 < index);
        self.spans
            .get(position)
            .filter(|span| span.0 <= index)
            .map_or(self.default, |span| span.2)
    }

    /// The distance from the sheet's edge to the start of `index`.
    fn origin(&self, index: u32) -> f64 {
        let mut total = 0.0;
        let mut cursor = 0u32;
        for (first, last, size) in &self.spans {
            if *first >= index {
                break;
            }
            total += f64::from(first - cursor) * self.default;
            let end = (last + 1).min(index);
            total += f64::from(end - first) * size;
            cursor = end;
        }
        total + f64::from(index.saturating_sub(cursor)) * self.default
    }

    /// The cell a distance from the sheet's edge falls in, and how far into
    /// it.
    fn locate(&self, position: f64) -> (u32, f64) {
        let mut remaining = position.max(0.0);
        let mut cursor = 0u32;
        let within = |start: u32, count: u32, size: f64, remaining: f64| -> Option<(u32, f64)> {
            if size <= 0.0 {
                return None;
            }
            let steps = (remaining / size).floor();
            (steps < f64::from(count)).then(|| (start + steps as u32, remaining - steps * size))
        };
        for (first, last, size) in &self.spans {
            let gap = first - cursor;
            if let Some(found) = within(cursor, gap, self.default, remaining) {
                return found;
            }
            remaining -= f64::from(gap) * self.default;
            let count = last - first + 1;
            if let Some(found) = within(*first, count, *size, remaining) {
                return found;
            }
            remaining -= f64::from(count) * size;
            cursor = last + 1;
        }
        within(cursor, self.limit.saturating_sub(cursor), self.default, remaining)
            .unwrap_or((self.limit - 1, 0.0))
    }
}

/// The grid of one sheet twice over: as the document measured it when it
/// placed its drawings, and as the workbook will show it. They differ where
/// the document fitted a row to its content — the workbook leaves such a row
/// to Excel, which gives it its own height.
pub(crate) struct SheetGeometry {
    source_columns: Axis,
    source_rows: Axis,
    columns: Axis,
    rows: Axis,
}

impl SheetGeometry {
    pub(crate) fn new(sheet: &SheetDrawings) -> Self {
        // 64 pixels wide and 15 points (20 pixels) high.
        let default_column = 64.0 * EMU_PER_PIXEL;
        let default_row = 20.0 * EMU_PER_PIXEL;
        let stated = |span: &Span| {
            (
                span.first,
                span.last,
                if span.hidden { 0.0 } else { span.size },
            )
        };
        // A size the document sets goes into the workbook rounded to whole
        // pixels; one it only fitted does not go at all.
        let shown = |default: f64| {
            move |span: &Span| {
                let size = if span.hidden {
                    0.0
                } else if span.fitted {
                    default
                } else {
                    (span.size / EMU_PER_PIXEL).round() * EMU_PER_PIXEL
                };
                (span.first, span.last, size)
            }
        };
        Self {
            source_columns: Axis::new(sheet.columns.iter().map(stated), default_column, MAX_COLUMN),
            source_rows: Axis::new(sheet.rows.iter().map(stated), default_row, MAX_ROW),
            columns: Axis::new(
                sheet.columns.iter().map(shown(default_column)),
                default_column,
                MAX_COLUMN,
            ),
            rows: Axis::new(sheet.rows.iter().map(shown(default_row)), default_row, MAX_ROW),
        }
    }
}

/// A cell and an offset into it, in EMU.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Marker {
    column: u32,
    column_offset: f64,
    row: u32,
    row_offset: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Anchor {
    TwoCell { from: Marker, to: Marker },
    OneCell { from: Marker, width: f64, height: f64 },
    Absolute { x: f64, y: f64, width: f64, height: f64 },
}

/// Where a drawing goes: its anchor, and the unturned frame from the sheet's
/// corner that DrawingML repeats inside the drawing.
struct Placement {
    anchor: Anchor,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

/// One end of an anchor along one axis: the cell it falls in, the offset the
/// workbook gives it there, and how far both grids put it from the sheet's
/// edge.
struct Settled {
    index: u32,
    offset: f64,
    /// From the edge, on the document's grid.
    source: f64,
    /// From the edge, on the workbook's grid.
    target: f64,
}

/// Puts `offset` from the start of `index` where both grids agree it is. An
/// offset inside its cell stays in that cell; one that leaves it is walked
/// along the document's grid to the cell it lands in, because Excel stops an
/// offset at the edge of its cell. Inside the cell the offset keeps its share
/// of the cell's size when the two grids size the cell differently.
fn settle(index: u32, offset: f64, source: &Axis, target: &Axis) -> Settled {
    let index = index.min(source.limit - 1);
    let inside = offset >= 0.0 && (offset == 0.0 || offset < source.size(index));
    let position = (source.origin(index) + offset).max(0.0);
    let (index, offset) = if inside {
        (index, offset)
    } else {
        source.locate(position)
    };
    let (from, to) = (source.size(index), target.size(index));
    let offset = if (from - to).abs() < EMU_PER_PIXEL || from <= 0.0 {
        offset.min(to)
    } else {
        (offset / from).min(1.0) * to
    };
    // The far edge of a cell is the near edge of the next one, which is how
    // Excel names it.
    let (index, offset) = if to > 0.0 && to - offset < EMU_PER_PIXEL / 2.0 && index + 1 < source.limit
    {
        (index + 1, 0.0)
    } else {
        (index, offset)
    };
    Settled {
        index,
        offset,
        source: position,
        target: target.origin(index) + offset,
    }
}

fn place(shape: &Shape, geometry: &SheetGeometry) -> Placement {
    // Excel keeps the anchor of a shape turned onto its side around the
    // turned frame, which has the same centre.
    let quarter = shape.rotation.rem_euclid(180.0);
    let sideways = (45.0..135.0).contains(&quarter);
    let (box_width, box_height) = if sideways {
        (shape.height, shape.width)
    } else {
        (shape.width, shape.height)
    };
    let box_x = shape.x + (shape.width - box_width) / 2.0;
    let box_y = shape.y + (shape.height - box_height) / 2.0;
    let Some((row, column)) = shape.cell else {
        let (x, y) = (box_x.max(0.0), box_y.max(0.0));
        return Placement {
            anchor: Anchor::Absolute {
                x,
                y,
                width: box_width,
                height: box_height,
            },
            x: x + (box_width - shape.width) / 2.0,
            y: y + (box_height - shape.height) / 2.0,
            width: shape.width,
            height: shape.height,
        };
    };
    let left = settle(column, box_x, &geometry.source_columns, &geometry.columns);
    let top = settle(row, box_y, &geometry.source_rows, &geometry.rows);
    let from = Marker {
        column: left.index,
        column_offset: left.offset,
        row: top.index,
        row_offset: top.offset,
    };
    // The end cell the document names is kept when it lies past the start;
    // a turned shape's end cell describes its bounding box, not its frame.
    let to = shape
        .end
        .as_ref()
        .filter(|end| shape.rotation == 0.0 && end.row < MAX_ROW && end.column < MAX_COLUMN)
        .and_then(|end| {
            let right = settle(
                end.column,
                end.x.min(geometry.source_columns.size(end.column)),
                &geometry.source_columns,
                &geometry.columns,
            );
            let bottom = settle(
                end.row,
                end.y.min(geometry.source_rows.size(end.row)),
                &geometry.source_rows,
                &geometry.rows,
            );
            let past = right.source >= left.source
                && bottom.source >= top.source
                && (right.source > left.source || bottom.source > top.source);
            // An end cell says the drawing is sized with the cells. One that
            // lies before the start (a line some writers pin to the first
            // cell) is replaced by the cell the far corner falls in.
            Some(if past {
                (right, bottom)
            } else {
                (
                    settle(
                        0,
                        left.source + box_width,
                        &geometry.source_columns,
                        &geometry.columns,
                    ),
                    settle(
                        0,
                        top.source + box_height,
                        &geometry.source_rows,
                        &geometry.rows,
                    ),
                )
            })
        });
    match to {
        Some((right, bottom)) => Placement {
            anchor: Anchor::TwoCell {
                from,
                to: Marker {
                    column: right.index,
                    column_offset: right.offset,
                    row: bottom.index,
                    row_offset: bottom.offset,
                },
            },
            x: left.target,
            y: top.target,
            width: (right.target - left.target).max(0.0),
            height: (bottom.target - top.target).max(0.0),
        },
        None => Placement {
            anchor: Anchor::OneCell {
                from,
                width: box_width,
                height: box_height,
            },
            x: left.target + (box_width - shape.width) / 2.0,
            y: top.target + (box_height - shape.height) / 2.0,
            width: shape.width,
            height: shape.height,
        },
    }
}

fn emu(value: f64) -> i64 {
    value.round().max(0.0) as i64
}

fn marker_xml(element: &str, marker: &Marker) -> String {
    format!(
        "<xdr:{element}><xdr:col>{}</xdr:col><xdr:colOff>{}</xdr:colOff><xdr:row>{}</xdr:row><xdr:rowOff>{}</xdr:rowOff></xdr:{element}>",
        marker.column,
        emu(marker.column_offset),
        marker.row,
        emu(marker.row_offset),
    )
}

fn anchor_xml(anchor: &Anchor, object: &str) -> String {
    match anchor {
        Anchor::TwoCell { from, to } => format!(
            "<xdr:twoCellAnchor>{}{}{object}<xdr:clientData/></xdr:twoCellAnchor>",
            marker_xml("from", from),
            marker_xml("to", to),
        ),
        Anchor::OneCell { from, width, height } => format!(
            r#"<xdr:oneCellAnchor>{}<xdr:ext cx="{}" cy="{}"/>{object}<xdr:clientData/></xdr:oneCellAnchor>"#,
            marker_xml("from", from),
            emu(*width),
            emu(*height),
        ),
        Anchor::Absolute { x, y, width, height } => format!(
            r#"<xdr:absoluteAnchor><xdr:pos x="{}" y="{}"/><xdr:ext cx="{}" cy="{}"/>{object}<xdr:clientData/></xdr:absoluteAnchor>"#,
            emu(*x),
            emu(*y),
            emu(*width),
            emu(*height),
        ),
    }
}

/// XML cannot carry control characters; a line break in a name is a space.
fn printable(text: &str) -> String {
    text.chars()
        .map(|character| if character == '\n' || character == '\r' { ' ' } else { character })
        .filter(|character| *character == '\t' || (*character as u32) >= 0x20)
        .collect()
}

fn solid_fill(color: &str, opacity: Option<f64>) -> String {
    match opacity.filter(|opacity| *opacity < 1.0) {
        Some(opacity) => format!(
            r#"<a:solidFill><a:srgbClr val="{color}"><a:alpha val="{}"/></a:srgbClr></a:solidFill>"#,
            (opacity * 100_000.0).round() as i64
        ),
        None => format!(r#"<a:solidFill><a:srgbClr val="{color}"/></a:solidFill>"#),
    }
}

/// `a:xfrm` (or `xdr:xfrm`) with the frame, the turn and the flips.
fn transform_xml(element: &str, shape: &Shape, placement: &Placement) -> String {
    let mut attributes = String::new();
    if shape.rotation != 0.0 {
        attributes.push_str(&format!(
            r#" rot="{}""#,
            (shape.rotation.rem_euclid(360.0) * 60_000.0).round() as i64
        ));
    }
    if shape.flip_h {
        attributes.push_str(r#" flipH="1""#);
    }
    if shape.flip_v {
        attributes.push_str(r#" flipV="1""#);
    }
    format!(
        r#"<{element}{attributes}><a:off x="{}" y="{}"/><a:ext cx="{}" cy="{}"/></{element}>"#,
        emu(placement.x),
        emu(placement.y),
        emu(placement.width),
        emu(placement.height),
    )
}

/// The outline of a shape or a line.
fn line_xml(style: &DrawStyle, arrows: bool, styles: &DrawStyles) -> String {
    if style.stroke.as_deref() == Some("none") {
        return "<a:ln><a:noFill/></a:ln>".to_owned();
    }
    let width = match style.stroke_width.filter(|width| *width > 0.0) {
        Some(points) => {
            // A width that went through centimetres comes back a hair off
            // the quarter point it was.
            let quarter = (points * 4.0).round() / 4.0;
            let points = if quarter > 0.0 && (points - quarter).abs() < 0.02 {
                quarter
            } else {
                points
            };
            format!(r#" w="{}""#, emu(points * EMU_PER_POINT))
        }
        None => String::new(),
    };
    let mut out = format!(
        "<a:ln{width}>{}",
        solid_fill(style.stroke_color.as_deref().unwrap_or(DEFAULT_LINE), None)
    );
    if style.stroke.as_deref() == Some("dash") {
        // The dash the style names, or the plain one when it names none
        // this reader knows.
        let preset = style
            .stroke_dash
            .as_deref()
            .and_then(|name| styles.dashes.get(name).copied())
            .unwrap_or("dash");
        out.push_str(&format!(r#"<a:prstDash val="{preset}"/>"#));
    }
    if arrows {
        if style.marker_start == Some(true) {
            out.push_str(r#"<a:headEnd type="triangle"/>"#);
        }
        if style.marker_end == Some(true) {
            out.push_str(r#"<a:tailEnd type="triangle"/>"#);
        }
    }
    out.push_str("</a:ln>");
    out
}

fn fill_xml(style: &DrawStyle, filled: bool, styles: &DrawStyles) -> String {
    if !filled {
        return "<a:noFill/>".to_owned();
    }
    match style.fill.as_deref() {
        Some("none") => "<a:noFill/>".to_owned(),
        Some("gradient") => match style
            .fill_gradient
            .as_deref()
            .and_then(|name| styles.gradients.get(name))
        {
            Some(gradient) => gradient_fill(gradient, style.opacity),
            // A gradient this reader cannot follow keeps the flat colour
            // written beside it.
            None => match style.fill_color.as_deref() {
                Some(color) => solid_fill(color, style.opacity),
                None => "<a:noFill/>".to_owned(),
            },
        },
        // A hatch or a bitmap keeps the flat colour beside it.
        Some("solid") | None => solid_fill(
            style.fill_color.as_deref().unwrap_or(DEFAULT_FILL),
            style.opacity,
        ),
        Some(_) => match style.fill_color.as_deref() {
            Some(color) => solid_fill(color, style.opacity),
            None => "<a:noFill/>".to_owned(),
        },
    }
}

/// `a:gradFill` along a line: the stops in thousandths of a percent and the
/// angle in sixty-thousandths of a degree.
fn gradient_fill(gradient: &Gradient, opacity: Option<f64>) -> String {
    let alpha = match opacity.filter(|opacity| (0.0..1.0).contains(opacity)) {
        Some(opacity) => format!(r#"<a:alpha val="{}"/>"#, (opacity * 100_000.0).round() as i64),
        None => String::new(),
    };
    let stops: String = gradient
        .stops
        .iter()
        .map(|(at, color)| {
            format!(
                r#"<a:gs pos="{}"><a:srgbClr val="{color}">{alpha}</a:srgbClr></a:gs>"#,
                (at.clamp(0.0, 1.0) * 100_000.0).round() as i64
            )
        })
        .collect();
    format!(
        r#"<a:gradFill rotWithShape="1"><a:gsLst>{stops}</a:gsLst><a:lin ang="{}" scaled="0"/></a:gradFill>"#,
        (gradient.angle.rem_euclid(360.0) * 60_000.0).round() as i64
    )
}

fn custom_geometry(path: &CustomPath) -> String {
    // DrawingML paths hold whole numbers; a small box is scaled up so its
    // curves keep their shape.
    let scale = if path.width.max(path.height) < 1_000.0 {
        21_600.0 / path.width.max(path.height)
    } else {
        1.0
    };
    let unit = |value: f64| (value * scale).round() as i64;
    let point = |x: f64, y: f64| format!(r#"<a:pt x="{}" y="{}"/>"#, unit(x), unit(y));
    let mut commands = String::new();
    for command in &path.commands {
        match command {
            PathCommand::Move(x, y) => {
                commands.push_str(&format!("<a:moveTo>{}</a:moveTo>", point(*x, *y)));
            }
            PathCommand::Line(x, y) => {
                commands.push_str(&format!("<a:lnTo>{}</a:lnTo>", point(*x, *y)));
            }
            PathCommand::Cubic(points) => commands.push_str(&format!(
                "<a:cubicBezTo>{}{}{}</a:cubicBezTo>",
                point(points[0], points[1]),
                point(points[2], points[3]),
                point(points[4], points[5]),
            )),
            PathCommand::Quad(points) => commands.push_str(&format!(
                "<a:quadBezTo>{}{}</a:quadBezTo>",
                point(points[0], points[1]),
                point(points[2], points[3]),
            )),
            PathCommand::Close => commands.push_str("<a:close/>"),
        }
    }
    format!(
        r#"<a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/><a:rect l="l" t="t" r="r" b="b"/><a:pathLst><a:path w="{}" h="{}">{commands}</a:path></a:pathLst></a:custGeom>"#,
        unit(path.width).max(1),
        unit(path.height).max(1),
    )
}

fn preset_geometry(name: &str) -> String {
    format!(r#"<a:prstGeom prst="{name}"><a:avLst/></a:prstGeom>"#)
}

/// The text of a shape, or nothing when it holds none.
fn text_body(shape: &Shape, graphic: &DrawStyle, styles: &DrawStyles) -> String {
    let last = shape
        .paragraphs
        .iter()
        .rposition(|paragraph| paragraph.runs.iter().any(|run| !run.text.is_empty()));
    let Some(last) = last else {
        return String::new();
    };
    let shape_text = styles.resolve(Family::Paragraph, shape.text_style.as_deref());
    let mut body = String::from("<a:bodyPr");
    if graphic.wrap.as_deref() == Some("no-wrap") {
        body.push_str(r#" wrap="none""#);
    }
    // Insets are written when the document sets some that differ from the
    // ones Excel uses by itself.
    let insets: Vec<f64> = graphic
        .padding
        .iter()
        .zip(DEFAULT_INSETS)
        .map(|(padding, default)| padding.map_or(default, |points| points * EMU_PER_POINT))
        .collect();
    if insets
        .iter()
        .zip(DEFAULT_INSETS)
        .any(|(inset, default)| (inset - default).abs() > 2_000.0)
    {
        body.push_str(&format!(
            r#" lIns="{}" tIns="{}" rIns="{}" bIns="{}""#,
            emu(insets[0]),
            emu(insets[1]),
            emu(insets[2]),
            emu(insets[3]),
        ));
    }
    match graphic.vertical_align.as_deref() {
        Some("middle") => body.push_str(r#" anchor="ctr""#),
        Some("bottom") => body.push_str(r#" anchor="b""#),
        None if shape.figure => body.push_str(r#" anchor="ctr""#),
        _ => {}
    }
    body.push_str("/><a:lstStyle/>");
    // Where a paragraph that names no alignment goes is the text area's
    // business. One spread over the whole shape starts its lines at the
    // edge, unless the text is not wrapped: a reader centres that.
    let text_box = matches!(shape.kind, ShapeKind::Shape { text_box: true, .. });
    let area = match graphic.horizontal_align.as_deref() {
        Some("center") => Some("center"),
        Some("right") => Some("end"),
        None | Some("justify") if !text_box && graphic.wrap.as_deref() == Some("no-wrap") => {
            Some("center")
        }
        _ => None,
    };
    for paragraph in &shape.paragraphs[..=last] {
        let own = styles.resolve(Family::Paragraph, paragraph.style.as_deref());
        let align = own
            .align
            .as_deref()
            .or(shape_text.align.as_deref())
            .or(graphic.align.as_deref())
            .or(area);
        body.push_str("<a:p>");
        match align {
            Some("center") => body.push_str(r#"<a:pPr algn="ctr"/>"#),
            Some("end") | Some("right") => body.push_str(r#"<a:pPr algn="r"/>"#),
            Some("justify") => body.push_str(r#"<a:pPr algn="just"/>"#),
            _ => {}
        }
        for run in &paragraph.runs {
            if run.line_break {
                body.push_str("<a:br/>");
                continue;
            }
            if run.text.is_empty() {
                continue;
            }
            // The run's own style first, then what the paragraph and the
            // shape say about their text.
            let look = styles
                .resolve(Family::Text, run.style.as_deref())
                .over(&own)
                .over(&shape_text)
                .over(graphic);
            let mut attributes = String::new();
            if let Some(size) = look.size {
                attributes.push_str(&format!(r#" sz="{}""#, (size * 100.0).round() as i64));
            }
            if look.bold == Some(true) {
                attributes.push_str(r#" b="1""#);
            }
            if look.italic == Some(true) {
                attributes.push_str(r#" i="1""#);
            }
            if look.underline == Some(true) {
                attributes.push_str(r#" u="sng""#);
            }
            let mut children = String::new();
            if let Some(color) = &look.color {
                children.push_str(&solid_fill(color, None));
            }
            if let Some(font) = &look.font {
                children.push_str(&format!(
                    r#"<a:latin typeface="{0}"/><a:ea typeface="{1}"/>"#,
                    escape_xml(&printable(font)),
                    escape_xml(&printable(look.font_asian.as_deref().unwrap_or(font))),
                ));
            }
            body.push_str("<a:r>");
            if !attributes.is_empty() || !children.is_empty() {
                body.push_str(&format!("<a:rPr{attributes}>{children}</a:rPr>"));
            }
            body.push_str(&format!("<a:t>{}</a:t></a:r>", escape_xml(&printable(&run.text))));
        }
        body.push_str("</a:p>");
    }
    format!("<xdr:txBody>{body}</xdr:txBody>")
}

/// The relationships of one drawing part, in the order they were asked for.
#[derive(Default)]
struct Relationships {
    xml: String,
    count: usize,
    /// The id of each media part already linked.
    media: HashMap<String, String>,
}

impl Relationships {
    fn add(&mut self, kind: &str, target: &str, external: bool) -> String {
        self.count += 1;
        let id = format!("rId{}", self.count);
        self.xml.push_str(&format!(
            r#"<Relationship Id="{id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/{kind}" Target="{}"{}/>"#,
            escape_xml(target),
            if external { r#" TargetMode="External""# } else { "" },
        ));
        id
    }
}

/// Writes the drawing parts of a document's sheets. One writer serves the
/// whole document, so a picture used on two sheets is stored once and charts
/// are numbered across sheets.
pub(crate) struct DrawingWriter {
    archive: ZipArchive<File>,
    /// Source entry name to the media part it becomes.
    media: HashMap<String, String>,
    charts: usize,
}

impl DrawingWriter {
    pub(crate) fn new(source: &Path) -> Result<Self, SidecarError> {
        Ok(Self {
            archive: ZipArchive::new(File::open(source)?)?,
            media: HashMap::new(),
            charts: 0,
        })
    }

    /// The entry a picture reference names, when the package holds it and it
    /// is not past what the writer will copy.
    fn picture_entry(&mut self, href: &str) -> Option<String> {
        let decoded = decode_uri_path(href).ok();
        [Some(href), decoded.as_deref()]
            .into_iter()
            .flatten()
            .find(|name| {
                self.archive.by_name(name).is_ok_and(|entry| {
                    entry.is_file()
                        && entry.size() > 0
                        && entry.size() <= crate::archive::MAX_EXTRACTED_ENTRY_BYTES
                })
            })
            .map(str::to_owned)
    }

    /// The chart part for the chart document in `directory`.
    fn chart(&mut self, directory: &str) -> Option<String> {
        let mut entry = self.archive.by_name(&format!("{directory}/content.xml")).ok()?;
        let declared = entry.size();
        if declared > MAX_CHART_BYTES {
            return None;
        }
        let mut bytes = Vec::with_capacity(declared as usize);
        copy_entry_bounded(&mut entry, declared, MAX_CHART_BYTES, &mut bytes).ok()?;
        drop(entry);
        let content = String::from_utf8(bytes).ok()?;
        odf_chart_parts::chart_part(&content)
    }

    /// The drawing of one sheet, or `None` when nothing on it can be drawn.
    pub(crate) fn sheet_art(
        &mut self,
        shapes: &[Shape],
        styles: &DrawStyles,
        geometry: &SheetGeometry,
    ) -> Option<SheetArt> {
        // Later in the part is nearer the viewer, which is what the z-index
        // says.
        let mut order: Vec<&Shape> = shapes.iter().collect();
        order.sort_by_key(|shape| shape.z_index);

        let mut relationships = Relationships::default();
        let mut anchors = String::new();
        let mut copied: Vec<(String, String)> = Vec::new();
        let mut parts: Vec<(String, Option<&'static str>, Vec<u8>)> = Vec::new();
        let mut next_id = 2usize;
        for shape in order {
            let placement = place(shape, geometry);
            let graphic = styles.resolve(Family::Graphic, shape.style.as_deref());
            let id = next_id;
            let number = id - 1;
            let name = |fallback: &str| -> String {
                escape_xml(&printable(
                    &shape
                        .name
                        .clone()
                        .unwrap_or_else(|| format!("{fallback} {number}")),
                ))
            };
            let mut described = String::new();
            if let Some(description) = &shape.description {
                described.push_str(&format!(r#" descr="{}""#, escape_xml(&printable(description))));
            }
            if let Some(title) = &shape.title {
                described.push_str(&format!(r#" title="{}""#, escape_xml(&printable(title))));
            }
            let object = match &shape.kind {
                ShapeKind::Picture { entry } => {
                    let Some(entry) = self.picture_entry(entry) else {
                        continue;
                    };
                    let Some(extension) = entry
                        .rsplit_once('.')
                        .and_then(|(_, extension)| media_extension(extension))
                    else {
                        continue;
                    };
                    let part = match self.media.get(&entry) {
                        Some(part) => part.clone(),
                        None => {
                            let part =
                                format!("xl/media/image{}.{extension}", self.media.len() + 1);
                            self.media.insert(entry.clone(), part.clone());
                            copied.push((part.clone(), entry.clone()));
                            part
                        }
                    };
                    let embed = match relationships.media.get(&part) {
                        Some(id) => id.clone(),
                        None => {
                            let target = format!("../media/{}", part.rsplit('/').next().unwrap_or(""));
                            let id = relationships.add("image", &target, false);
                            relationships.media.insert(part, id.clone());
                            id
                        }
                    };
                    let link = link_xml(shape, &mut relationships);
                    let opacity = graphic
                        .image_opacity
                        .filter(|opacity| *opacity < 1.0)
                        .map(|opacity| {
                            format!(
                                r#"<a:alphaModFix amt="{}"/>"#,
                                (opacity * 100_000.0).round() as i64
                            )
                        })
                        .unwrap_or_default();
                    format!(
                        r#"<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="{id}" name="{}"{described}{}<xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr><xdr:blipFill><a:blip r:embed="{embed}"{}<a:stretch><a:fillRect/></a:stretch></xdr:blipFill><xdr:spPr>{}{}</xdr:spPr></xdr:pic>"#,
                        name("Picture"),
                        link,
                        if opacity.is_empty() {
                            "/>".to_owned()
                        } else {
                            format!(">{opacity}</a:blip>")
                        },
                        transform_xml("a:xfrm", shape, &placement),
                        preset_geometry("rect"),
                    )
                }
                ShapeKind::Chart { directory } => {
                    let Some(chart) = self.chart(directory) else {
                        continue;
                    };
                    self.charts += 1;
                    let part = format!("xl/charts/chart{}.xml", self.charts);
                    let target = format!("../charts/chart{}.xml", self.charts);
                    let relationship = relationships.add("chart", &target, false);
                    parts.push((part, Some(CHART_TYPE), chart.into_bytes()));
                    format!(
                        r#"<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="{id}" name="{}"{described}/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr>{}<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="{relationship}"/></a:graphicData></a:graphic></xdr:graphicFrame>"#,
                        name("Chart"),
                        transform_xml("xdr:xfrm", shape, &placement),
                    )
                }
                ShapeKind::Shape { outline, text_box } => {
                    let (geometry_xml, filled) = match outline {
                        Outline::Preset(preset) => (preset_geometry(preset), true),
                        Outline::Custom(path) => (custom_geometry(path), path.filled),
                    };
                    let link = link_xml(shape, &mut relationships);
                    format!(
                        r#"<xdr:sp macro="" textlink=""><xdr:nvSpPr><xdr:cNvPr id="{id}" name="{}"{described}{}<xdr:cNvSpPr{}/></xdr:nvSpPr><xdr:spPr>{}{geometry_xml}{}{}</xdr:spPr>{}</xdr:sp>"#,
                        name(if *text_box { "TextBox" } else { "Shape" }),
                        link,
                        if *text_box { r#" txBox="1""# } else { "" },
                        transform_xml("a:xfrm", shape, &placement),
                        fill_xml(&graphic, filled, styles),
                        line_xml(&graphic, false, styles),
                        text_body(shape, &graphic, styles),
                    )
                }
                ShapeKind::Line { preset } => {
                    let link = link_xml(shape, &mut relationships);
                    format!(
                        r#"<xdr:cxnSp macro=""><xdr:nvCxnSpPr><xdr:cNvPr id="{id}" name="{}"{described}{}<xdr:cNvCxnSpPr/></xdr:nvCxnSpPr><xdr:spPr>{}{}{}</xdr:spPr></xdr:cxnSp>"#,
                        name("Line"),
                        link,
                        transform_xml("a:xfrm", shape, &placement),
                        preset_geometry(preset),
                        line_xml(&graphic, true, styles),
                    )
                }
            };
            anchors.push_str(&anchor_xml(&placement.anchor, &object));
            next_id += 1;
        }
        if anchors.is_empty() {
            return None;
        }
        Some(SheetArt {
            xml: format!(
                r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">{anchors}</xdr:wsDr>"#,
            ),
            rels: format!(
                r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">{}</Relationships>"#,
                relationships.xml
            ),
            media: Vec::new(),
            parts,
            copied,
        })
    }
}

/// The end of `xdr:cNvPr`: closed at once, or holding the link a click
/// follows. Only a link that leaves the document travels.
fn link_xml(shape: &Shape, relationships: &mut Relationships) -> String {
    match shape
        .link
        .as_deref()
        .filter(|link| link.contains("://") || link.starts_with("mailto:"))
    {
        Some(link) => {
            let id = relationships.add("hyperlink", link, true);
            format!(r#"><a:hlinkClick r:id="{id}"/></xdr:cNvPr>"#)
        }
        None => "/>".to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::odf_drawings::EndMarker;

    fn span(first: u32, last: u32, pixels: f64) -> Span {
        Span {
            first,
            last,
            size: pixels * EMU_PER_PIXEL,
            fitted: false,
            hidden: false,
        }
    }

    fn geometry() -> SheetGeometry {
        // Column C is 100 pixels wide and rows 2 to 3 are 40 pixels high;
        // everything else has the default size.
        SheetGeometry::new(&SheetDrawings {
            shapes: Vec::new(),
            columns: vec![span(2, 2, 100.0)],
            rows: vec![span(1, 2, 40.0)],
        })
    }

    fn shape(cell: Option<(u32, u32)>, x: f64, y: f64, width: f64, height: f64) -> Shape {
        Shape {
            cell,
            x,
            y,
            width,
            height,
            end: None,
            z_index: 0,
            name: None,
            description: None,
            title: None,
            link: None,
            style: None,
            text_style: None,
            kind: ShapeKind::Shape {
                outline: Outline::Preset("rect"),
                text_box: false,
            },
            flip_h: false,
            flip_v: false,
            rotation: 0.0,
            figure: false,
            paragraphs: Vec::new(),
        }
    }

    #[test]
    fn sizes_and_positions_follow_the_sheet() {
        let geometry = geometry();
        let pixel = EMU_PER_PIXEL;
        assert_eq!(geometry.columns.size(1), 64.0 * pixel);
        assert_eq!(geometry.columns.size(2), 100.0 * pixel);
        assert_eq!(geometry.columns.origin(4), (64.0 + 64.0 + 100.0 + 64.0) * pixel);
        assert_eq!(geometry.rows.origin(3), (20.0 + 40.0 + 40.0) * pixel);
        let locate = |position: f64| geometry.columns.locate(position);
        assert_eq!(locate(0.0), (0, 0.0));
        assert_eq!(locate(130.0 * pixel), (2, 2.0 * pixel));
        assert_eq!(locate(228.0 * pixel), (3, 0.0));
        assert_eq!(locate(300.0 * pixel), (4, 8.0 * pixel));
    }

    #[test]
    fn an_offset_past_its_cell_is_walked_to_the_cell_it_lands_in() {
        let geometry = geometry();
        let pixel = EMU_PER_PIXEL;
        // Inside the cell: kept as written, with the size as an extent.
        let placed = place(&shape(Some((1, 2)), 10.0 * pixel, 5.0 * pixel, 50.0 * pixel, 30.0 * pixel), &geometry);
        assert_eq!(
            placed.anchor,
            Anchor::OneCell {
                from: Marker {
                    column: 2,
                    column_offset: 10.0 * pixel,
                    row: 1,
                    row_offset: 5.0 * pixel
                },
                width: 50.0 * pixel,
                height: 30.0 * pixel
            }
        );
        assert_eq!((placed.x, placed.y), (138.0 * pixel, 25.0 * pixel));
        // From A1 with an offset three columns wide.
        let placed = place(&shape(Some((0, 0)), 240.0 * pixel, 70.0 * pixel, pixel, pixel), &geometry);
        match placed.anchor {
            Anchor::OneCell { from, .. } => {
                assert_eq!((from.column, from.column_offset), (3, 12.0 * pixel));
                assert_eq!((from.row, from.row_offset), (2, 10.0 * pixel));
            }
            other => panic!("{other:?}"),
        }
        // A negative offset walks back.
        let placed = place(&shape(Some((1, 1)), -10.0 * pixel, -5.0 * pixel, pixel, pixel), &geometry);
        match placed.anchor {
            Anchor::OneCell { from, .. } => {
                assert_eq!((from.column, from.column_offset), (0, 54.0 * pixel));
                assert_eq!((from.row, from.row_offset), (0, 15.0 * pixel));
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn an_end_cell_is_kept_when_it_lies_past_the_start() {
        let geometry = geometry();
        let pixel = EMU_PER_PIXEL;
        let mut boxed = shape(Some((1, 1)), 0.0, 0.0, 100.0 * pixel, 40.0 * pixel);
        boxed.end = Some(EndMarker {
            row: 4,
            column: 3,
            // Past the width of its column: stopped at the edge, which is
            // the start of the next column.
            x: 500.0 * pixel,
            y: 3.0 * pixel,
        });
        assert_eq!(
            place(&boxed, &geometry).anchor,
            Anchor::TwoCell {
                from: Marker {
                    column: 1,
                    column_offset: 0.0,
                    row: 1,
                    row_offset: 0.0
                },
                to: Marker {
                    column: 4,
                    column_offset: 0.0,
                    row: 4,
                    row_offset: 3.0 * pixel
                },
            }
        );
        // An end cell before the start is not an end: the far corner of the
        // frame says where it ends.
        let mut line = shape(Some((0, 0)), 300.0 * pixel, 100.0 * pixel, 60.0 * pixel, 80.0 * pixel);
        line.end = Some(EndMarker {
            row: 0,
            column: 0,
            x: 4.0 * pixel,
            y: 4.0 * pixel,
        });
        match place(&line, &geometry).anchor {
            Anchor::TwoCell { from, to } => {
                assert_eq!((from.column, from.column_offset), (4, 8.0 * pixel));
                assert_eq!((from.row, from.row_offset), (3, 0.0));
                assert_eq!((to.column, to.column_offset), (5, 4.0 * pixel));
                assert_eq!((to.row, to.row_offset), (7, 0.0));
            }
            other => panic!("{other:?}"),
        }
        // Without an end cell the size stands.
        line.end = None;
        assert!(matches!(place(&line, &geometry).anchor, Anchor::OneCell { .. }));
        // Pinned to the page.
        let pinned = place(&shape(None, 7.0, 9.0, 11.0, 13.0), &geometry);
        assert_eq!(
            pinned.anchor,
            Anchor::Absolute {
                x: 7.0,
                y: 9.0,
                width: 11.0,
                height: 13.0
            }
        );
    }

    #[test]
    fn a_row_the_document_fitted_is_measured_its_way_and_shown_excels_way() {
        // The document fitted its rows to 12 pixels; the workbook leaves
        // them to Excel, which makes them 20. Row 4 is hidden.
        let pixel = EMU_PER_PIXEL;
        let geometry = SheetGeometry::new(&SheetDrawings {
            shapes: Vec::new(),
            columns: Vec::new(),
            rows: vec![
                Span {
                    first: 0,
                    last: 2,
                    size: 12.0 * pixel,
                    fitted: true,
                    hidden: false,
                },
                Span {
                    first: 3,
                    last: 3,
                    size: 12.0 * pixel,
                    fitted: true,
                    hidden: true,
                },
                Span {
                    first: 4,
                    last: 9,
                    size: 12.0 * pixel,
                    fitted: true,
                    hidden: false,
                },
            ],
        });
        // 30 pixels down from the top is half way into the third row as
        // the document counts, and stays half way into it.
        let placed = place(&shape(Some((0, 0)), 0.0, 30.0 * pixel, pixel, pixel), &geometry);
        match placed.anchor {
            Anchor::OneCell { from, .. } => {
                assert_eq!((from.row, from.row_offset), (2, 10.0 * pixel));
            }
            other => panic!("{other:?}"),
        }
        assert_eq!(placed.y, 50.0 * pixel);
        // The hidden row takes no room on either grid.
        let placed = place(&shape(Some((0, 0)), 0.0, 36.0 * pixel, pixel, pixel), &geometry);
        match placed.anchor {
            Anchor::OneCell { from, .. } => assert_eq!((from.row, from.row_offset), (4, 0.0)),
            other => panic!("{other:?}"),
        }
        assert_eq!(placed.y, 60.0 * pixel);
    }

    #[test]
    fn a_shape_on_its_side_is_anchored_around_its_turned_frame() {
        let geometry = geometry();
        let pixel = EMU_PER_PIXEL;
        let mut turned = shape(Some((0, 0)), 20.0 * pixel, 40.0 * pixel, 100.0 * pixel, 20.0 * pixel);
        turned.rotation = 90.0;
        let placed = place(&turned, &geometry);
        match placed.anchor {
            Anchor::OneCell { from, width, height } => {
                assert_eq!((width, height), (20.0 * pixel, 100.0 * pixel));
                assert_eq!((from.column, from.column_offset), (0, 60.0 * pixel));
                assert_eq!((from.row, from.row_offset), (0, 0.0));
            }
            other => panic!("{other:?}"),
        }
        // The frame inside the drawing is the unturned one.
        assert_eq!((placed.x, placed.y), (20.0 * pixel, 40.0 * pixel));
        assert_eq!((placed.width, placed.height), (100.0 * pixel, 20.0 * pixel));
        assert!(transform_xml("a:xfrm", &turned, &placed).starts_with(r#"<a:xfrm rot="5400000">"#));
    }

    #[test]
    fn writes_outlines_fills_and_lines() {
        let path = CustomPath {
            width: 10.0,
            height: 5.0,
            commands: vec![
                PathCommand::Move(0.0, 5.0),
                PathCommand::Line(5.0, 0.0),
                PathCommand::Cubic([7.5, 3.5, 2.5, 3.5, 0.0, 5.0]),
                PathCommand::Close,
            ],
            filled: true,
        };
        let xml = custom_geometry(&path);
        assert!(xml.contains(r#"<a:path w="21600" h="10800"><a:moveTo><a:pt x="0" y="10800"/></a:moveTo><a:lnTo><a:pt x="10800" y="0"/></a:lnTo><a:cubicBezTo><a:pt x="16200" y="7560"/>"#), "{xml}");
        let style = DrawStyle {
            stroke: Some("dash".into()),
            stroke_width: Some(1.5),
            stroke_color: Some("FF0000".into()),
            fill: Some("solid".into()),
            fill_color: Some("00FF00".into()),
            opacity: Some(0.5),
            marker_end: Some(true),
            ..DrawStyle::default()
        };
        assert_eq!(
            line_xml(&style, true, &DrawStyles::default()),
            r#"<a:ln w="19050"><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill><a:prstDash val="dash"/><a:tailEnd type="triangle"/></a:ln>"#
        );
        assert_eq!(
            fill_xml(&style, true, &DrawStyles::default()),
            r#"<a:solidFill><a:srgbClr val="00FF00"><a:alpha val="50000"/></a:srgbClr></a:solidFill>"#
        );
        assert_eq!(fill_xml(&style, false, &DrawStyles::default()), "<a:noFill/>");
        let bare = DrawStyle::default();
        assert_eq!(
            line_xml(&bare, false, &DrawStyles::default()),
            r#"<a:ln><a:solidFill><a:srgbClr val="3465A4"/></a:solidFill></a:ln>"#
        );
        let none = DrawStyle {
            stroke: Some("none".into()),
            fill: Some("none".into()),
            ..DrawStyle::default()
        };
        assert_eq!(line_xml(&none, true, &DrawStyles::default()), "<a:ln><a:noFill/></a:ln>");
        assert_eq!(fill_xml(&none, true, &DrawStyles::default()), "<a:noFill/>");
    }

    #[test]
    fn text_without_a_stated_place_goes_where_a_reader_draws_it() {
        use crate::odf_drawings::{Paragraph, Run};
        let styles = DrawStyles::default();
        let mut figure = shape(Some((0, 0)), 0.0, 0.0, 100.0, 100.0);
        figure.paragraphs = vec![Paragraph {
            style: None,
            runs: vec![Run {
                text: "yes?".into(),
                ..Run::default()
            }],
        }];
        // A plain shape with wrapped text: top, lines from the edge.
        let wrapped = DrawStyle::default();
        let body = text_body(&figure, &wrapped, &styles);
        assert!(body.starts_with("<xdr:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r>"), "{body}");
        // A custom shape puts its text in the middle of its height, and
        // unwrapped text that fills the width is centred.
        figure.figure = true;
        let unwrapped = DrawStyle {
            wrap: Some("no-wrap".into()),
            ..DrawStyle::default()
        };
        let body = text_body(&figure, &unwrapped, &styles);
        assert!(
            body.starts_with(r#"<xdr:txBody><a:bodyPr wrap="none" anchor="ctr"/><a:lstStyle/><a:p><a:pPr algn="ctr"/><a:r>"#),
            "{body}"
        );
        // What the style states wins.
        let stated = DrawStyle {
            wrap: Some("no-wrap".into()),
            vertical_align: Some("top".into()),
            horizontal_align: Some("left".into()),
            ..DrawStyle::default()
        };
        let body = text_body(&figure, &stated, &styles);
        assert!(
            body.starts_with(r#"<xdr:txBody><a:bodyPr wrap="none"/><a:lstStyle/><a:p><a:r>"#),
            "{body}"
        );
    }

    #[test]
    fn writes_the_dash_and_the_gradient_a_style_names() {
        let mut styles = DrawStyles::default();
        styles.dashes.insert("Long_20_Dash_20_Dot".into(), "lgDashDot");
        styles.gradients.insert(
            "Sky".into(),
            Gradient {
                angle: 90.0,
                stops: vec![(0.0, "FF0000".into()), (0.5, "FFFFFF".into()), (1.0, "0000FF".into())],
            },
        );
        let style = DrawStyle {
            stroke: Some("dash".into()),
            stroke_dash: Some("Long_20_Dash_20_Dot".into()),
            stroke_color: Some("C00000".into()),
            fill: Some("gradient".into()),
            fill_gradient: Some("Sky".into()),
            fill_color: Some("808080".into()),
            ..DrawStyle::default()
        };
        assert_eq!(
            line_xml(&style, false, &styles),
            r#"<a:ln><a:solidFill><a:srgbClr val="C00000"/></a:solidFill><a:prstDash val="lgDashDot"/></a:ln>"#
        );
        assert_eq!(
            fill_xml(&style, true, &styles),
            concat!(
                r#"<a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:srgbClr val="FF0000"></a:srgbClr></a:gs>"#,
                r#"<a:gs pos="50000"><a:srgbClr val="FFFFFF"></a:srgbClr></a:gs><a:gs pos="100000"><a:srgbClr val="0000FF"></a:srgbClr></a:gs></a:gsLst>"#,
                r#"<a:lin ang="5400000" scaled="0"/></a:gradFill>"#,
            )
        );
        // A dash or a gradient the document does not declare: the plain
        // dash, and the flat colour written beside the gradient.
        let unknown = DrawStyles::default();
        assert!(line_xml(&style, false, &unknown).contains(r#"<a:prstDash val="dash"/>"#));
        assert_eq!(
            fill_xml(&style, true, &unknown),
            r#"<a:solidFill><a:srgbClr val="808080"/></a:solidFill>"#
        );
    }
}
