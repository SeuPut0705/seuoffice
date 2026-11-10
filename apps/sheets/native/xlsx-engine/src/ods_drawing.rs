//! Pictures, shapes and chart frames for the `.ods` export.
//!
//! Excel floats a drawing over the grid and pins it to cells: a start cell
//! with an offset, and usually an end cell with one too. ODF says the same
//! thing by putting the shape inside its start cell, with the offset as its
//! position and the end cell named on the shape. So a drawing is written by
//! the row writer when it reaches the start cell, which keeps the export a
//! single pass.
//!
//! Sizes are computed from the column widths and row heights the drawing
//! spans, because a reader wants a width and a height even when an end cell
//! is named.

use std::collections::HashMap;

use crate::odf_formula;
use crate::ods_chart::ChartDocument;
use crate::xlsx_package::escape_xml;
use crate::visuals::DrawingAnchor;
use crate::{ColumnWidth, SheetMetadata, VisualObject};

const EMU_PER_POINT: f64 = 12_700.0;
const EMU_PER_CM: f64 = 360_000.0;
const POINTS_PER_CM: f64 = 72.0 / 2.54;

/// Excel's column width (characters of the default font) as the points ODF
/// measures lengths in: characters → pixels at 96 dpi → points.
pub(crate) fn width_points(width: f64) -> f64 {
    ((width * 7.0 + 5.0) * 0.75).max(0.0)
}

/// The width of a column that declares none. Excel derives it from the base
/// width in characters, padded and rounded up to a multiple of eight pixels —
/// 64 pixels for the usual base of eight.
pub(crate) fn default_column_points(sheet: &SheetMetadata) -> f64 {
    match sheet.default_column_width.filter(|width| *width > 0.0) {
        Some(width) => width_points(width),
        None => {
            let base = sheet.base_column_width.filter(|base| *base > 0.0).unwrap_or(8.0);
            ((base * 7.0 + 5.0) / 8.0).ceil() * 8.0 * 0.75
        }
    }
}

/// Column widths and row heights of one sheet, in points, for the anchor
/// arithmetic. A hidden column or row takes no room.
pub(crate) struct Geometry<'a> {
    columns: &'a [ColumnWidth],
    default_column: f64,
    rows: HashMap<usize, f64>,
    default_row: f64,
}

impl<'a> Geometry<'a> {
    /// `rows` holds the rows that differ from the default height: their
    /// height in points, zero when hidden.
    pub(crate) fn new(sheet: &'a SheetMetadata, rows: HashMap<usize, f64>) -> Self {
        Self {
            columns: &sheet.column_widths,
            default_column: default_column_points(sheet),
            rows,
            default_row: sheet
                .default_row_height
                .filter(|height| *height > 0.0)
                .unwrap_or(15.0),
        }
    }

    fn column(&self, column: usize) -> f64 {
        match self
            .columns
            .iter()
            .find(|span| span.start_column <= column && column <= span.end_column)
        {
            Some(span) if span.hidden => 0.0,
            Some(span) => span
                .width
                .filter(|width| *width > 0.0)
                .map_or(self.default_column, width_points),
            None => self.default_column,
        }
    }

    fn row(&self, row: usize) -> f64 {
        self.rows.get(&row).copied().unwrap_or(self.default_row)
    }
}

/// The distance between two anchor markers along one axis, in EMU. A real
/// end marker stops at its cell's far edge, as Excel clamps it; a made-up one
/// (a one-cell or absolute anchor) carries the size past the edge.
fn extent(
    size: impl Fn(usize) -> f64,
    from: usize,
    from_offset: i64,
    to: usize,
    to_offset: i64,
    clamp: bool,
) -> f64 {
    let mut total = 0.0;
    for index in from..to {
        total += size(index) * EMU_PER_POINT;
    }
    let to_offset = if clamp {
        (to_offset as f64).min(size(to) * EMU_PER_POINT)
    } else {
        to_offset as f64
    };
    total - from_offset as f64 + to_offset
}

fn cm(emu: f64) -> String {
    format!("{:.3}cm", emu / EMU_PER_CM)
}

fn points_cm(points: f64) -> String {
    format!("{:.3}cm", points / POINTS_PER_CM)
}

fn column_name(index: usize) -> String {
    let mut name = String::new();
    let mut number = index + 1;
    while number > 0 {
        let remainder = (number - 1) % 26;
        name.insert(0, (b'A' + remainder as u8) as char);
        number = (number - 1) / 26;
    }
    name
}

/// A picture the package has to carry: where it goes and where it comes from.
pub(crate) struct Picture {
    /// The entry name inside the ODS package (`Pictures/image1.png`).
    pub(crate) name: String,
    /// The entry inside the source workbook.
    pub(crate) source: String,
    pub(crate) media_type: String,
}

/// A document embedded in the package: a chart in its own directory.
pub(crate) struct EmbeddedObject {
    /// `Object 1`, the directory the frame points at.
    pub(crate) directory: String,
    pub(crate) content: String,
}

/// The drawings of the whole document: graphic styles and pictures collected
/// while the sheets are written.
#[derive(Default)]
pub(crate) struct Drawings {
    styles: Vec<String>,
    style_names: HashMap<String, String>,
    pub(crate) pictures: Vec<Picture>,
    picture_names: HashMap<String, String>,
    pub(crate) objects: Vec<EmbeddedObject>,
    z_index: usize,
    /// What a graphic style refers to by name — dashes and gradients — in
    /// the order it was first asked for.
    named: Vec<String>,
    named_keys: HashMap<String, String>,
}

/// The preset dashes of DrawingML as an ODF dash: the name, the count and
/// length of the first and second kind of dot, and the gap, in percent of the
/// line's width. The importer reads the same table back.
pub(crate) const DASHES: &[(&str, u8, u32, u8, u32, u32)] = &[
    ("sysDot", 1, 100, 0, 0, 100),
    ("sysDash", 1, 300, 0, 0, 100),
    ("dash", 1, 400, 0, 0, 300),
    ("dashDot", 1, 400, 1, 100, 300),
    ("lgDash", 1, 800, 0, 0, 300),
    ("lgDashDot", 1, 800, 1, 100, 300),
    ("lgDashDotDot", 1, 800, 2, 100, 300),
    ("dot", 1, 100, 0, 0, 300),
    ("sysDashDot", 1, 300, 1, 100, 100),
    ("sysDashDotDot", 1, 300, 2, 100, 100),
];

impl Drawings {
    pub(crate) fn automatic_styles(&self) -> String {
        self.styles.concat()
    }

    /// The dashes and gradients the graphic styles name, for
    /// `<office:styles>`.
    pub(crate) fn named_styles(&self) -> String {
        self.named.concat()
    }

    /// The name of the dash a preset stands for, declared on first use.
    fn dash(&mut self, preset: &str) -> Option<&'static str> {
        let (name, dots1, length1, dots2, length2, distance) =
            *DASHES.iter().find(|entry| entry.0 == preset)?;
        if !self.named_keys.contains_key(name) {
            let second = if dots2 > 0 {
                format!(r#" draw:dots2="{dots2}" draw:dots2-length="{length2}%""#)
            } else {
                String::new()
            };
            self.named.push(format!(
                r#"<draw:stroke-dash draw:name="{name}" draw:style="rect" draw:dots1="{dots1}" draw:dots1-length="{length1}%"{second} draw:distance="{distance}%"/>"#
            ));
            self.named_keys.insert(name.to_owned(), name.to_owned());
        }
        Some(name)
    }

    /// The name of a linear gradient, declared on first use. `None` for one
    /// with fewer than two usable stops.
    fn gradient(&mut self, gradient: &crate::visuals::FillGradient) -> Option<String> {
        let mut stops: Vec<(f64, String)> = gradient
            .stops
            .iter()
            .filter(|stop| stop.position.is_finite())
            .map(|stop| (stop.position.clamp(0.0, 1.0), hex_color(&stop.color)))
            .collect();
        if stops.len() < 2 || !gradient.angle.is_finite() {
            return None;
        }
        stops.sort_by(|a, b| a.0.total_cmp(&b.0));
        // DrawingML counts the angle clockwise from left-to-right; ODF turns
        // a top-to-bottom gradient the other way round.
        let angle = (90.0_f64 - gradient.angle).rem_euclid(360.0).round();
        let listed: String = stops
            .iter()
            .map(|(position, color)| {
                format!(
                    r#"<loext:gradient-stop svg:offset="{position}" loext:color-type="rgb" loext:color-value="{}"/>"#,
                    escape_xml(color)
                )
            })
            .collect();
        let body = format!(
            r#" draw:style="linear" draw:start-color="{}" draw:end-color="{}" draw:start-intensity="100%" draw:end-intensity="100%" draw:angle="{angle}deg" draw:border="0%">{listed}</draw:gradient>"#,
            escape_xml(&stops[0].1),
            escape_xml(&stops[stops.len() - 1].1),
        );
        if let Some(name) = self.named_keys.get(&body) {
            return Some(name.clone());
        }
        let name = format!("gradient{}", self.named_keys.len() + 1);
        self.named
            .push(format!(r#"<draw:gradient draw:name="{name}"{body}"#));
        self.named_keys.insert(body, name.clone());
        Some(name)
    }

    /// An automatic style of one family, shared by everything that asks for
    /// the same properties. The prefixes keep the names apart from the cell
    /// writer's own text styles.
    fn style(&mut self, prefix: &str, family: &str, element: &str, properties: &str) -> String {
        let key = format!("{family}\u{1}{properties}");
        if let Some(name) = self.style_names.get(&key) {
            return name.clone();
        }
        let name = format!("{prefix}{}", self.styles.len() + 1);
        self.styles.push(format!(
            r#"<style:style style:name="{name}" style:family="{family}"><{element}{properties}/></style:style>"#
        ));
        self.style_names.insert(key, name.clone());
        name
    }

    fn graphic_style(&mut self, properties: &str) -> String {
        self.style("gr", "graphic", "style:graphic-properties", properties)
    }

    /// The paragraphs of a shape's text. A reader takes the alignment from a
    /// paragraph style and the look of a run from a text style; properties
    /// put on the shape's own style are not applied to its text.
    fn shape_text(&mut self, visual: &VisualObject) -> String {
        let Some(paragraphs) = &visual.paragraphs else {
            return visual
                .text
                .as_deref()
                .filter(|text| !text.is_empty())
                .map(|text| {
                    text.split('\n')
                        .map(|line| format!("<text:p>{}</text:p>", escape_xml(&printable(line))))
                        .collect()
                })
                .unwrap_or_default();
        };
        if paragraphs
            .iter()
            .all(|paragraph| paragraph.runs.iter().all(|run| run.text.is_empty()))
        {
            return String::new();
        }
        let mut out = String::new();
        for paragraph in paragraphs {
            let align = match paragraph.align.as_deref() {
                Some("ctr") => Some("center"),
                Some("r") => Some("end"),
                Some("just") => Some("justify"),
                _ => None,
            };
            match align {
                Some(align) => {
                    let name = self.style(
                        "gp",
                        "paragraph",
                        "style:paragraph-properties",
                        &format!(r#" fo:text-align="{align}""#),
                    );
                    out.push_str(&format!(r#"<text:p text:style-name="{name}">"#));
                }
                None => out.push_str("<text:p>"),
            }
            for run in &paragraph.runs {
                let mut properties = String::new();
                if let Some(color) = run.color.as_deref().or(visual.text_color.as_deref()) {
                    properties.push_str(&format!(r#" fo:color="{}""#, escape_xml(&hex_color(color))));
                }
                if let Some(size) = run.size.filter(|size| *size > 0.0) {
                    properties.push_str(&format!(
                        r#" fo:font-size="{size}pt" style:font-size-asian="{size}pt" style:font-size-complex="{size}pt""#
                    ));
                }
                if run.bold {
                    properties.push_str(
                        r#" fo:font-weight="bold" style:font-weight-asian="bold" style:font-weight-complex="bold""#,
                    );
                }
                if run.italic {
                    properties.push_str(
                        r#" fo:font-style="italic" style:font-style-asian="italic" style:font-style-complex="italic""#,
                    );
                }
                if run.underline {
                    properties.push_str(
                        r#" style:text-underline-style="solid" style:text-underline-width="auto" style:text-underline-color="font-color""#,
                    );
                }
                let text = escape_xml(&printable(&run.text));
                if properties.is_empty() {
                    out.push_str(&text);
                } else {
                    let name = self.style("gt", "text", "style:text-properties", &properties);
                    out.push_str(&format!(r#"<text:span text:style-name="{name}">{text}</text:span>"#));
                }
            }
            out.push_str("</text:p>");
        }
        out
    }

    fn picture(&mut self, source: &str, media_type: Option<&str>) -> String {
        if let Some(name) = self.picture_names.get(source) {
            return name.clone();
        }
        let extension = source
            .rsplit('/')
            .next()
            .and_then(|file| file.rsplit_once('.'))
            .map(|(_, extension)| extension.to_ascii_lowercase())
            .filter(|extension| {
                !extension.is_empty() && extension.chars().all(|c| c.is_ascii_alphanumeric())
            })
            .unwrap_or_else(|| "bin".to_owned());
        let name = format!("Pictures/image{}.{extension}", self.pictures.len() + 1);
        let media_type = media_type
            .map(str::to_owned)
            .unwrap_or_else(|| media_type_of(&extension).to_owned());
        self.pictures.push(Picture {
            name: name.clone(),
            source: source.to_owned(),
            media_type,
        });
        self.picture_names.insert(source.to_owned(), name.clone());
        name
    }

    /// The width and height of a drawing in EMU, or `None` when its anchor
    /// has no area to draw in.
    pub(crate) fn size(geometry: &Geometry<'_>, visual: &VisualObject) -> Option<(f64, f64)> {
        let anchor: &DrawingAnchor = &visual.anchor;
        let width = extent(
            |column| geometry.column(column),
            anchor.from_column,
            anchor.from_column_offset,
            anchor.to_column,
            anchor.to_column_offset,
            anchor.explicit_to,
        );
        let height = extent(
            |row| geometry.row(row),
            anchor.from_row,
            anchor.from_row_offset,
            anchor.to_row,
            anchor.to_row_offset,
            anchor.explicit_to,
        );
        // A rotated frame keeps its true size apart from the bounds the
        // anchor describes; where the anchor collapsed (hidden rows), that
        // size is all there is.
        let width = if width > 0.0 {
            width
        } else {
            visual.frame_width.filter(|width| *width > 0.0)?
        };
        let height = if height > 0.0 {
            height
        } else {
            visual.frame_height.filter(|height| *height > 0.0)?
        };
        Some((width, height))
    }

    /// The position and size attributes every drawing shares.
    fn placement(
        &mut self,
        sheet: &SheetMetadata,
        geometry: &Geometry<'_>,
        visual: &VisualObject,
    ) -> Option<String> {
        let anchor: &DrawingAnchor = &visual.anchor;
        let (width, height) = Self::size(geometry, visual)?;
        let turn = visual
            .rotation
            .filter(|degrees| degrees.is_finite() && degrees.rem_euclid(360.0) != 0.0);
        let mut attributes = String::new();
        // A two-cell anchor follows its end cell when rows or columns are
        // resized; naming the end cell asks a reader for the same. A turned
        // drawing is left out: a reader stretches it to its end cell along
        // the sheet's axes, which shears it.
        if anchor.explicit_to && visual.edit_as.as_deref() != Some("absolute") && turn.is_none() {
            let end_x = (anchor.to_column_offset as f64)
                .clamp(0.0, geometry.column(anchor.to_column) * EMU_PER_POINT);
            let end_y =
                (anchor.to_row_offset as f64).clamp(0.0, geometry.row(anchor.to_row) * EMU_PER_POINT);
            attributes.push_str(&format!(
                r#" table:end-cell-address="{}.{}{}" table:end-x="{}" table:end-y="{}""#,
                escape_xml(&odf_formula::odf_sheet_name(&sheet.name)),
                column_name(anchor.to_column),
                anchor.to_row + 1,
                cm(end_x),
                cm(end_y),
            ));
        }
        attributes.push_str(&format!(r#" draw:z-index="{}""#, self.z_index));
        self.z_index += 1;
        if let Some(name) = visual.name.as_deref().filter(|name| !name.is_empty()) {
            attributes.push_str(&format!(r#" draw:name="{}""#, escape_xml(name)));
        }
        let x = (anchor.from_column_offset as f64).max(0.0);
        let y = (anchor.from_row_offset as f64).max(0.0);
        let Some(degrees) = turn else {
            attributes.push_str(&format!(
                r#" svg:width="{}" svg:height="{}" svg:x="{}" svg:y="{}""#,
                cm(width),
                cm(height),
                cm(x),
                cm(y),
            ));
            return Some(attributes);
        };
        // The anchor of a turned drawing is around its centre and may be the
        // turned bounds; the drawing keeps the size its frame states. Without
        // one the anchor is the frame, which is how the editor draws it.
        let (own_width, own_height) = match (visual.frame_width, visual.frame_height) {
            (Some(own_width), Some(own_height)) if own_width > 0.0 && own_height > 0.0 => {
                (own_width, own_height)
            }
            _ => (width, height),
        };
        // ODF turns the frame around its own corner and then moves it, with
        // the angle counted the other way round.
        let (sin, cos) = degrees.to_radians().sin_cos();
        let (half_width, half_height) = (own_width / 2.0, own_height / 2.0);
        let shift_x = x + width / 2.0 - (half_width * cos - half_height * sin);
        let shift_y = y + height / 2.0 - (half_width * sin + half_height * cos);
        attributes.push_str(&format!(
            r#" svg:width="{}" svg:height="{}" draw:transform="rotate ({:.10}) translate ({} {})""#,
            cm(own_width),
            cm(own_height),
            -degrees.to_radians(),
            cm(shift_x),
            cm(shift_y),
        ));
        Some(attributes)
    }

    /// The frame of a picture floating over the grid.
    pub(crate) fn image(
        &mut self,
        sheet: &SheetMetadata,
        geometry: &Geometry<'_>,
        visual: &VisualObject,
    ) -> Option<String> {
        let source = visual.media_path.as_deref()?;
        let placement = self.placement(sheet, geometry, visual)?;
        let name = self.picture(source, visual.media_type.as_deref());
        let mut graphic = String::from(r#" draw:stroke="none" draw:fill="none""#);
        if let Some(opacity) = visual.opacity.filter(|opacity| (0.0..1.0).contains(opacity)) {
            graphic.push_str(&format!(
                r#" draw:image-opacity="{}%""#,
                (opacity * 100.0).round()
            ));
        }
        let style = self.graphic_style(&graphic);
        let media_type = self
            .pictures
            .iter()
            .find(|picture| picture.name == name)
            .map(|picture| picture.media_type.clone())
            .unwrap_or_default();
        let description = visual
            .alt_text
            .as_deref()
            .filter(|text| !text.is_empty())
            .map(|text| format!("<svg:desc>{}</svg:desc>", escape_xml(&printable(text))))
            .unwrap_or_default();
        Some(linked(
            visual,
            format!(
                r#"<draw:frame draw:style-name="{style}"{placement}><draw:image xlink:href="{name}" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad" draw:mime-type="{}"/>{description}</draw:frame>"#,
                escape_xml(&media_type)
            ),
        ))
    }

    /// The frame of a picture that lives inside a cell: it takes the cell's
    /// size.
    pub(crate) fn cell_image(
        &mut self,
        geometry: &Geometry<'_>,
        row: usize,
        column: usize,
        source: &str,
    ) -> Option<String> {
        let width = geometry.column(column);
        let height = geometry.row(row);
        if width <= 0.0 || height <= 0.0 {
            return None;
        }
        let name = self.picture(source, None);
        let style = self.graphic_style(r#" draw:stroke="none" draw:fill="none""#);
        let media_type = self
            .pictures
            .iter()
            .find(|picture| picture.name == name)
            .map(|picture| picture.media_type.clone())
            .unwrap_or_default();
        let z_index = self.z_index;
        self.z_index += 1;
        Some(format!(
            r#"<draw:frame draw:style-name="{style}" draw:z-index="{z_index}" svg:width="{}" svg:height="{}" svg:x="0cm" svg:y="0cm"><draw:image xlink:href="{name}" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad" draw:mime-type="{}"/></draw:frame>"#,
            points_cm(width),
            points_cm(height),
            escape_xml(&media_type)
        ))
    }

    /// The frame of an embedded chart. `document` builds the chart for the
    /// frame's size in centimetres; a chart it cannot build leaves no frame.
    pub(crate) fn chart(
        &mut self,
        sheet: &SheetMetadata,
        geometry: &Geometry<'_>,
        visual: &VisualObject,
        document: impl FnOnce(f64, f64) -> Option<ChartDocument>,
    ) -> Option<String> {
        let (width, height) = Self::size(geometry, visual)?;
        let chart = document(width / EMU_PER_CM, height / EMU_PER_CM)?;
        let placement = self.placement(sheet, geometry, visual)?;
        let style = self.graphic_style(r#" draw:stroke="none" draw:fill="none""#);
        let directory = format!("Object {}", self.objects.len() + 1);
        let ranges = if chart.ranges.is_empty() {
            String::new()
        } else {
            format!(
                r#" draw:notify-on-update-of-ranges="{}""#,
                escape_xml(&chart.ranges)
            )
        };
        let frame = format!(
            r#"<draw:frame draw:style-name="{style}"{placement}><draw:object{ranges} xlink:href="./{directory}" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/></draw:frame>"#
        );
        self.objects.push(EmbeddedObject {
            directory,
            content: chart.content,
        });
        Some(frame)
    }

    /// A drawn shape or text box.
    pub(crate) fn shape(
        &mut self,
        sheet: &SheetMetadata,
        geometry: &Geometry<'_>,
        visual: &VisualObject,
    ) -> Option<String> {
        let placement = self.placement(sheet, geometry, visual)?;
        let kind = visual.shape_type.as_deref().unwrap_or("rect");

        let mut graphic = String::new();
        let stroke_only = visual
            .custom_path
            .as_ref()
            .is_some_and(|path| path.stroke_only);
        match visual.line_color.as_deref() {
            Some(color) if color != "none" => {
                let stroke = match visual.line_dash.as_deref().and_then(|dash| self.dash(dash)) {
                    Some(dash) => format!(r#"dash" draw:stroke-dash="{dash}"#),
                    None => "solid".to_owned(),
                };
                graphic.push_str(&format!(
                    r#" draw:stroke="{stroke}" svg:stroke-width="{}pt" svg:stroke-color="{}""#,
                    visual.line_width.filter(|width| *width > 0.0).unwrap_or(0.75),
                    escape_xml(&hex_color(color))
                ));
            }
            _ => graphic.push_str(r#" draw:stroke="none""#),
        }
        if is_line(kind) {
            let style = self.graphic_style(&graphic);
            // The anchor box is the line's bounding box; the flips say which
            // diagonal of it the line runs along.
            let anchor = &visual.anchor;
            let x = (anchor.from_column_offset as f64).max(0.0);
            let y = (anchor.from_row_offset as f64).max(0.0);
            let width = extent(
                |column| geometry.column(column),
                anchor.from_column,
                anchor.from_column_offset,
                anchor.to_column,
                anchor.to_column_offset,
                anchor.explicit_to,
            )
            .max(0.0);
            let height = extent(
                |row| geometry.row(row),
                anchor.from_row,
                anchor.from_row_offset,
                anchor.to_row,
                anchor.to_row_offset,
                anchor.explicit_to,
            )
            .max(0.0);
            let (x1, x2) = if visual.flip_h { (x + width, x) } else { (x, x + width) };
            let (y1, y2) = if visual.flip_v { (y + height, y) } else { (y, y + height) };
            // `placement` wrote the box; a line wants its two ends instead.
            let shared = placement
                .split(" svg:width=")
                .next()
                .unwrap_or_default()
                .to_owned();
            return Some(format!(
                r#"<draw:line draw:style-name="{style}"{shared} svg:x1="{}" svg:y1="{}" svg:x2="{}" svg:y2="{}"/>"#,
                cm(x1),
                cm(y1),
                cm(x2),
                cm(y2)
            ));
        }
        match visual.fill_color.as_deref() {
            Some(color) if color != "none" && !stroke_only => {
                // The flat colour stays beside a gradient for a reader that
                // does not draw one.
                let fill = match visual
                    .fill_gradient
                    .as_ref()
                    .and_then(|gradient| self.gradient(gradient))
                {
                    Some(gradient) => format!(r#"gradient" draw:fill-gradient-name="{gradient}"#),
                    None => "solid".to_owned(),
                };
                graphic.push_str(&format!(
                    r#" draw:fill="{fill}" draw:fill-color="{}""#,
                    escape_xml(&hex_color(color))
                ));
            }
            _ => graphic.push_str(r#" draw:fill="none""#),
        }
        graphic.push_str(match visual.text_anchor.as_deref() {
            Some("ctr") => r#" draw:textarea-vertical-align="middle""#,
            Some("b") => r#" draw:textarea-vertical-align="bottom""#,
            _ => r#" draw:textarea-vertical-align="top""#,
        });
        // Excel's default text insets, and a box that keeps its size.
        graphic.push_str(
            r#" draw:auto-grow-height="false" draw:auto-grow-width="false" fo:padding-top="0.127cm" fo:padding-bottom="0.127cm" fo:padding-left="0.254cm" fo:padding-right="0.254cm" fo:wrap-option="wrap""#,
        );

        let paragraphs = self.shape_text(visual);
        let style = self.graphic_style(&graphic);

        let (view_box, shape_type, path) = match &visual.custom_path {
            Some(custom) => (
                format!(
                    "0 0 {} {}",
                    custom.width.max(1.0).round(),
                    custom.height.max(1.0).round()
                ),
                "non-primitive".to_owned(),
                enhanced_path(&custom.d)?,
            ),
            None => {
                let (shape_type, path) = preset_path(kind);
                // A preset drawn as its bounding rectangle keeps its name, so
                // a reader that knows the figure can bring it back.
                let shape_type = if shape_type == "rectangle"
                    && kind != "rect"
                    && !kind.is_empty()
                    && kind.chars().all(|character| character.is_ascii_alphanumeric())
                {
                    format!("ooxml-{kind}")
                } else {
                    shape_type.to_owned()
                };
                ("0 0 21600 21600".to_owned(), shape_type, path.to_owned())
            }
        };
        let mut geometry_attributes = format!(
            r#" svg:viewBox="{view_box}" draw:type="{shape_type}" draw:enhanced-path="{path}""#
        );
        if visual.flip_h {
            geometry_attributes.push_str(r#" draw:mirror-horizontal="true""#);
        }
        if visual.flip_v {
            geometry_attributes.push_str(r#" draw:mirror-vertical="true""#);
        }
        Some(linked(
            visual,
            format!(
                r#"<draw:custom-shape draw:style-name="{style}"{placement}>{paragraphs}<draw:enhanced-geometry{geometry_attributes}/></draw:custom-shape>"#
            ),
        ))
    }
}

/// A drawing that carries a web link is wrapped in one.
fn linked(visual: &VisualObject, shape: String) -> String {
    match visual
        .hyperlink
        .as_deref()
        .filter(|link| link.contains("://") || link.starts_with("mailto:"))
    {
        Some(link) => format!(
            r#"<draw:a xlink:type="simple" xlink:href="{}">{shape}</draw:a>"#,
            escape_xml(link)
        ),
        None => shape,
    }
}

/// XML cannot carry control characters; a line break inside a run becomes a
/// space.
fn printable(text: &str) -> String {
    text.chars()
        .map(|character| if character == '\n' || character == '\r' { ' ' } else { character })
        .filter(|character| *character == '\t' || (*character as u32) >= 0x20)
        .collect()
}

fn hex_color(value: &str) -> String {
    let value = value.trim();
    let hex = value.strip_prefix('#').unwrap_or(value);
    let hex = if hex.len() == 8 { &hex[2..] } else { hex };
    format!("#{}", hex.to_ascii_lowercase())
}

fn is_line(kind: &str) -> bool {
    matches!(kind, "line" | "straightConnector1")
}

/// The outline of a preset shape on a 21600 grid. A preset this table does
/// not know is drawn as its bounding rectangle: its place, size, colours and
/// text survive, its outline does not.
fn preset_path(kind: &str) -> (&'static str, &'static str) {
    match kind {
        "ellipse" => ("ellipse", "U 10800 10800 10800 10800 0 360 Z N"),
        "roundRect" | "flowChartAlternateProcess" => (
            "non-primitive",
            "M 3600 0 X 0 3600 L 0 18000 Y 3600 21600 L 18000 21600 X 21600 18000 L 21600 3600 Y 18000 0 Z N",
        ),
        "triangle" => ("non-primitive", "M 10800 0 L 21600 21600 0 21600 Z N"),
        "rtTriangle" => ("non-primitive", "M 0 0 L 21600 21600 0 21600 Z N"),
        "diamond" | "flowChartDecision" => (
            "non-primitive",
            "M 10800 0 L 21600 10800 10800 21600 0 10800 Z N",
        ),
        "parallelogram" => ("non-primitive", "M 5400 0 L 21600 0 16200 21600 0 21600 Z N"),
        "trapezoid" => ("non-primitive", "M 0 21600 L 5400 0 16200 0 21600 21600 Z N"),
        "hexagon" => (
            "non-primitive",
            "M 5400 0 L 16200 0 21600 10800 16200 21600 5400 21600 0 10800 Z N",
        ),
        "octagon" => (
            "non-primitive",
            "M 6326 0 L 15274 0 21600 6326 21600 15274 15274 21600 6326 21600 0 15274 0 6326 Z N",
        ),
        "pentagon" => (
            "non-primitive",
            "M 10800 0 L 21600 8259 17475 21600 4125 21600 0 8259 Z N",
        ),
        "plus" => (
            "non-primitive",
            "M 5400 0 L 16200 0 16200 5400 21600 5400 21600 16200 16200 16200 16200 21600 5400 21600 5400 16200 0 16200 0 5400 5400 5400 Z N",
        ),
        "star5" => (
            "non-primitive",
            "M 10800 0 L 13349 8259 21600 8259 14925 13341 17475 21600 10800 16495 4125 21600 6675 13341 0 8259 8251 8259 Z N",
        ),
        "rightArrow" => (
            "non-primitive",
            "M 0 5400 L 16200 5400 16200 0 21600 10800 16200 21600 16200 16200 0 16200 Z N",
        ),
        "leftArrow" => (
            "non-primitive",
            "M 21600 5400 L 5400 5400 5400 0 0 10800 5400 21600 5400 16200 21600 16200 Z N",
        ),
        "upArrow" => (
            "non-primitive",
            "M 5400 21600 L 5400 5400 0 5400 10800 0 21600 5400 16200 5400 16200 21600 Z N",
        ),
        "downArrow" => (
            "non-primitive",
            "M 5400 0 L 5400 16200 0 16200 10800 21600 21600 16200 16200 16200 16200 0 Z N",
        ),
        _ => ("rectangle", "M 0 0 L 21600 0 21600 21600 0 21600 Z N"),
    }
}

/// The preset `preset_path` draws with `path`, for the reader that meets a
/// document this module wrote: the outline goes back to the name it had.
pub(crate) fn preset_of_path(path: &str) -> Option<&'static str> {
    const KINDS: [&str; 17] = [
        "rect",
        "ellipse",
        "roundRect",
        "triangle",
        "rtTriangle",
        "diamond",
        "parallelogram",
        "trapezoid",
        "hexagon",
        "octagon",
        "pentagon",
        "plus",
        "star5",
        "rightArrow",
        "leftArrow",
        "upArrow",
        "downArrow",
    ];
    let path = path.trim();
    KINDS.into_iter().find(|kind| preset_path(kind).1 == path)
}

/// An SVG path (`M`, `L`, `C`, `Q`, `Z`, absolute) as an enhanced path: the
/// same commands, whole numbers, and an end marker. `None` for a path with a
/// command the two do not share.
fn enhanced_path(svg: &str) -> Option<String> {
    let mut out = String::new();
    let mut number = String::new();
    let flush = |number: &mut String, out: &mut String| -> Option<()> {
        if number.is_empty() {
            return Some(());
        }
        let value: f64 = number.parse().ok()?;
        out.push_str(&format!("{} ", value.round()));
        number.clear();
        Some(())
    };
    for character in svg.chars() {
        match character {
            'M' | 'L' | 'C' | 'Q' | 'Z' => {
                flush(&mut number, &mut out)?;
                out.push(character);
                out.push(' ');
            }
            '0'..='9' | '.' | 'e' | 'E' => number.push(character),
            '-' => {
                // A minus starts a number unless it follows an exponent.
                if !number.is_empty() && !number.ends_with(['e', 'E']) {
                    flush(&mut number, &mut out)?;
                }
                number.push('-');
            }
            ' ' | ',' | '\n' | '\t' | '\r' => flush(&mut number, &mut out)?,
            _ => return None,
        }
    }
    flush(&mut number, &mut out)?;
    if out.trim().is_empty() {
        return None;
    }
    out.push('N');
    Some(out)
}

fn media_type_of(extension: &str) -> &'static str {
    match extension {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        "webp" => "image/webp",
        "tif" | "tiff" => "image/tiff",
        "emf" => "image/x-emf",
        "wmf" => "image/x-wmf",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_default_column_is_sixty_four_pixels_unless_the_sheet_says_otherwise() {
        // 64 px at 96 dpi is 48 pt.
        let widths = |default: Option<f64>, base: Option<f64>| {
            let base_points = base.unwrap_or(8.0);
            match default {
                Some(width) => width_points(width),
                None => ((base_points * 7.0 + 5.0) / 8.0).ceil() * 8.0 * 0.75,
            }
        };
        assert_eq!(widths(None, None), 48.0);
        assert_eq!(widths(None, Some(10.0)), 60.0);
        assert_eq!(widths(Some(12.0), None), width_points(12.0));
    }

    #[test]
    fn a_real_end_marker_stops_at_its_cell_and_a_made_up_one_does_not() {
        let size = |_: usize| 48.0;
        // Three whole columns plus an end offset larger than the end column.
        let clamped = extent(size, 1, 0, 4, 10_000_000, true);
        assert_eq!(clamped, 4.0 * 48.0 * EMU_PER_POINT);
        let free = extent(size, 1, 100, 1, 1_524_000, false);
        assert_eq!(free, 1_524_000.0 - 100.0);
        assert_eq!(cm(360_000.0), "1.000cm");
        assert_eq!(column_name(27), "AB");
    }

    #[test]
    fn turns_an_svg_outline_into_an_enhanced_path() {
        assert_eq!(
            enhanced_path("M0,0 L10.4,0 C1 2 3 4 5 6 Q7-8 9 10Z").as_deref(),
            Some("M 0 0 L 10 0 C 1 2 3 4 5 6 Q 7 -8 9 10 Z N")
        );
        assert_eq!(enhanced_path("M 0 0 A 5 5 0 0 1 10 10"), None, "arcs do not carry over");
        assert_eq!(enhanced_path("  "), None);
        assert_eq!(preset_path("ellipse").0, "ellipse");
        assert_eq!(preset_path("cloudCallout").0, "rectangle");
        assert_eq!(preset_of_path(preset_path("star5").1), Some("star5"));
        assert_eq!(preset_of_path(preset_path("cloudCallout").1), Some("rect"));
        assert_eq!(preset_of_path("M 0 0 L 1 1 Z N"), None);
        assert_eq!(hex_color("FF4472C4"), "#4472c4");
        assert_eq!(media_type_of("jpeg"), "image/jpeg");
    }

    #[test]
    fn declares_a_dash_and_a_gradient_once_each() {
        use crate::visuals::{FillGradient, FillGradientStop};
        let mut drawings = Drawings::default();
        assert_eq!(drawings.dash("sysDash"), Some("sysDash"));
        assert_eq!(drawings.dash("sysDash"), Some("sysDash"));
        assert_eq!(drawings.dash("solid"), None);
        let stop = |position: f64, color: &str| FillGradientStop {
            position,
            color: color.into(),
        };
        // Top to bottom in DrawingML is a quarter turn clockwise from
        // left-to-right; in ODF it is the unturned gradient.
        let down = FillGradient {
            angle: 90.0,
            stops: vec![stop(1.0, "#0000FF"), stop(0.0, "#FF0000"), stop(0.5, "#FFFFFF")],
        };
        let name = drawings.gradient(&down).unwrap();
        assert_eq!(drawings.gradient(&down).as_deref(), Some(name.as_str()));
        let sideways = FillGradient {
            angle: 0.0,
            stops: vec![stop(0.0, "#FF0000"), stop(1.0, "#0000FF")],
        };
        assert_ne!(drawings.gradient(&sideways).unwrap(), name);
        assert_eq!(
            drawings.gradient(&FillGradient {
                angle: 0.0,
                stops: vec![stop(0.0, "#FF0000")],
            }),
            None
        );
        assert_eq!(
            drawings.named_styles(),
            concat!(
                r#"<draw:stroke-dash draw:name="sysDash" draw:style="rect" draw:dots1="1" draw:dots1-length="300%" draw:distance="100%"/>"#,
                r##"<draw:gradient draw:name="gradient2" draw:style="linear" draw:start-color="#ff0000" draw:end-color="#0000ff" draw:start-intensity="100%" draw:end-intensity="100%" draw:angle="0deg" draw:border="0%">"##,
                r##"<loext:gradient-stop svg:offset="0" loext:color-type="rgb" loext:color-value="#ff0000"/><loext:gradient-stop svg:offset="0.5" loext:color-type="rgb" loext:color-value="#ffffff"/><loext:gradient-stop svg:offset="1" loext:color-type="rgb" loext:color-value="#0000ff"/></draw:gradient>"##,
                r##"<draw:gradient draw:name="gradient3" draw:style="linear" draw:start-color="#ff0000" draw:end-color="#0000ff" draw:start-intensity="100%" draw:end-intensity="100%" draw:angle="90deg" draw:border="0%">"##,
                r##"<loext:gradient-stop svg:offset="0" loext:color-type="rgb" loext:color-value="#ff0000"/><loext:gradient-stop svg:offset="1" loext:color-type="rgb" loext:color-value="#0000ff"/></draw:gradient>"##,
            )
        );
    }
}
