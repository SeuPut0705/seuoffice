//! Shading, table look, borders and cell margins.

use jscompat::{
    JsNum, Radix, js_regex, math_round, pad_start, parse_int, to_int32, to_number,
    to_string_radix16, truthy,
};
use ooxml_xml::XNode;
use serde::{Deserialize, Serialize};

use crate::theme::{ThemeColors, resolve_theme_color};
use crate::xml_text::strip_hash;

/// ST_Shd pct values that are not the literal digits in the name.
fn shd_pct_exact(val: &str) -> Option<f64> {
    Some(match val {
        "pct12" => 12.5,
        "pct37" => 37.5,
        "pct62" => 62.5,
        "pct87" => 87.5,
        _ => return None,
    })
}

fn blend_hex(fg: &str, bg: &str, ratio: f64) -> String {
    let channel =
        |hex: &str, at: usize| parse_int(hex.get(at..at + 2).unwrap_or(""), Radix::Sixteen);
    let mix = |at: usize| {
        let mixed = math_round(channel(fg, at) * ratio + channel(bg, at) * (1.0 - ratio));
        pad_start(&to_string_radix16(mixed), 2, '0')
    };
    (mix(0) + &mix(2) + &mix(4)).to_uppercase()
}

/// w:shd as a single display color. Patterns (pctNN, stripes, crosses)
/// approximate as the pattern color blended over the fill at the pattern's
/// ink coverage.
pub fn shd_display_fill(shd: Option<&XNode>, theme: Option<&ThemeColors>) -> Option<String> {
    let shd = shd?;
    let hex = |value: Option<&str>| {
        truthy(value)
            .map(strip_hash)
            .filter(|hex| js_regex!("^[0-9a-fA-F]{6}$").test(hex))
            .map(str::to_owned)
    };
    // Word re-resolves w:themeFill against the theme; the w:fill hex is only a cache
    let themed = |slot, tint, shade| -> Option<String> {
        let reference = truthy(shd.attr(slot))?;
        resolve_theme_color(reference, theme?, shd.attr(tint), shd.attr(shade))
    };
    let literal = |key| hex(shd.attr(key).filter(|value| *value != "auto"));
    let fill =
        themed("w:themeFill", "w:themeFillTint", "w:themeFillShade").or_else(|| literal("w:fill"));
    let val = shd.attr("w:val").unwrap_or("clear");
    if val == "clear" || val == "nil" {
        return fill;
    }
    let ink = themed("w:themeColor", "w:themeTint", "w:themeShade").or_else(|| literal("w:color"));
    if val == "solid" {
        return Some(ink.unwrap_or_else(|| "000000".to_owned()));
    }
    let ratio = if let Some(percent) = val.strip_prefix("pct") {
        let ratio = shd_pct_exact(val).unwrap_or_else(|| to_number(percent)) / 100.0;
        (ratio > 0.0 && ratio <= 1.0).then_some(ratio)
    } else if js_regex!("stripe|cross", "i").test(val) {
        Some(if val.starts_with("thin") { 0.25 } else { 0.5 })
    } else {
        None
    };
    match ratio {
        Some(ratio) => Some(blend_hex(
            ink.as_deref().unwrap_or("000000"),
            fill.as_deref().unwrap_or("FFFFFF"),
            ratio,
        )),
        None => fill,
    }
}

/// w:tblStyleRowBandSize of a tblPr; `None` when absent or not positive.
pub fn row_band_size_of(tbl_pr: Option<&XNode>) -> Option<f64> {
    let val = tbl_pr?
        .find_child("w:tblStyleRowBandSize")
        .and_then(|size| size.attr("w:val"));
    let n = parse_int(val.unwrap_or(""), Radix::Ten);
    (n > 0.0).then_some(n)
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableLook {
    pub first_row: bool,
    pub last_row: bool,
    pub first_column: bool,
    pub last_column: bool,
    pub banded_rows: bool,
    pub banded_columns: bool,
}

pub fn table_look_of(tbl_pr: Option<&XNode>) -> TableLook {
    let look = tbl_pr.and_then(|tbl_pr| tbl_pr.find_child("w:tblLook"));
    let attr = |key| look.and_then(|look| look.attr(key));
    let bits = parse_int(attr("w:val").unwrap_or(""), Radix::Sixteen);
    let flag = |key, bit: i32, default: bool| match attr(key) {
        Some(value) => value != "0" && value != "false",
        None if bits.is_finite() => to_int32(bits) & bit != 0,
        None => default,
    };
    TableLook {
        first_row: flag("w:firstRow", 0x20, true),
        last_row: flag("w:lastRow", 0x40, false),
        first_column: flag("w:firstColumn", 0x80, true),
        last_column: flag("w:lastColumn", 0x100, false),
        banded_rows: !flag("w:noHBand", 0x200, false),
        banded_columns: !flag("w:noVBand", 0x400, true),
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BorderLine {
    pub style: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sz_eighths: Option<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
}

/// Table-level borders (with the inner lines) or cell-level borders (with the diagonals).
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Borders {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub top: Option<BorderLine>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub left: Option<BorderLine>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bottom: Option<BorderLine>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub right: Option<BorderLine>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inside_h: Option<BorderLine>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inside_v: Option<BorderLine>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tl2br: Option<BorderLine>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tr2bl: Option<BorderLine>,
}

fn border_lines_of(node: &XNode, with_inside: bool) -> Option<Borders> {
    let mut borders = Borders::default();
    let line_of = |tag| -> Option<BorderLine> {
        let child = node.find_child(tag)?;
        Some(BorderLine {
            style: truthy(child.attr("w:val"))?.to_owned(),
            // `Number(sz) || undefined`: NaN and 0 are no size
            sz_eighths: truthy(child.attr("w:sz"))
                .map(to_number)
                .filter(|sz| *sz != 0.0 && !sz.is_nan())
                .map(JsNum),
            color: truthy(child.attr("w:color")).map(|color| strip_hash(color).to_owned()),
        })
    };
    // the first tag that yields a line wins its side: w:left before w:start
    let first = |side: &mut Option<BorderLine>, tag| {
        if side.is_none() {
            *side = line_of(tag);
        }
    };
    first(&mut borders.top, "w:top");
    first(&mut borders.left, "w:left");
    first(&mut borders.bottom, "w:bottom");
    first(&mut borders.right, "w:right");
    first(&mut borders.left, "w:start");
    first(&mut borders.right, "w:end");
    // the diagonals are cell-level only (CT_TblBorders has no tl2br or tr2bl child)
    if with_inside {
        first(&mut borders.inside_h, "w:insideH");
        first(&mut borders.inside_v, "w:insideV");
    } else {
        first(&mut borders.tl2br, "w:tl2br");
        first(&mut borders.tr2bl, "w:tr2bl");
    }
    (borders != Borders::default()).then_some(borders)
}

/// Duplicated border containers (two w:tcBorders in one tcPr): Word merges
/// per side, the later container wins.
pub fn merged_border_lines_of(
    parent: Option<&XNode>,
    tag: &str,
    with_inside: bool,
) -> Option<Borders> {
    let mut merged: Option<Borders> = None;
    for node in parent?.find_children(tag) {
        let Some(lines) = border_lines_of(node, with_inside) else {
            continue;
        };
        let base = merged.take().unwrap_or_default();
        merged = Some(Borders {
            top: lines.top.or(base.top),
            left: lines.left.or(base.left),
            bottom: lines.bottom.or(base.bottom),
            right: lines.right.or(base.right),
            inside_h: lines.inside_h.or(base.inside_h),
            inside_v: lines.inside_v.or(base.inside_v),
            tl2br: lines.tl2br.or(base.tl2br),
            tr2bl: lines.tr2bl.or(base.tr2bl),
        });
    }
    merged
}

/// Declared look of one w:pBdr side.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParaBorderLine {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sz_pt: Option<JsNum>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub space_pt: Option<JsNum>,
    /// w:val none or nil with a w:space: no line, but the space still pads the paragraph.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub none: bool,
}

/// One side of w:pBdr: not declared, reset (`null` in the model), or a line.
#[derive(Debug, Clone, Default, PartialEq)]
pub enum Side {
    #[default]
    Undeclared,
    Reset,
    Line(ParaBorderLine),
}

impl Side {
    fn is_undeclared(&self) -> bool {
        *self == Self::Undeclared
    }
}

impl Serialize for Side {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Line(line) => line.serialize(serializer),
            Self::Undeclared | Self::Reset => serializer.serialize_unit(),
        }
    }
}

impl<'de> Deserialize<'de> for Side {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Ok(match Option::<ParaBorderLine>::deserialize(deserializer)? {
            Some(line) => Self::Line(line),
            None => Self::Reset,
        })
    }
}

/// Per-side w:pBdr lines.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ParaBorderSides {
    #[serde(default, skip_serializing_if = "Side::is_undeclared")]
    pub t: Side,
    #[serde(default, skip_serializing_if = "Side::is_undeclared")]
    pub b: Side,
    #[serde(default, skip_serializing_if = "Side::is_undeclared")]
    pub l: Side,
    #[serde(default, skip_serializing_if = "Side::is_undeclared")]
    pub r: Side,
}

impl ParaBorderSides {
    fn sides(&self) -> [(char, &Side); 4] {
        [
            ('t', &self.t),
            ('b', &self.b),
            ('l', &self.l),
            ('r', &self.r),
        ]
    }

    fn side_mut(&mut self, ch: char) -> &mut Side {
        match ch {
            't' => &mut self.t,
            'b' => &mut self.b,
            'l' => &mut self.l,
            _ => &mut self.r,
        }
    }
}

/// w:pBdr sides of a pPr. Duplicated containers merge per side (later wins);
/// none and nil are an explicit reset. Theme colors resolve only when a
/// palette is passed.
pub fn para_border_sides_of(p_pr: &XNode, theme: Option<&ThemeColors>) -> Option<ParaBorderSides> {
    let containers: Vec<&XNode> = p_pr.find_children("w:pBdr").collect();
    if containers.is_empty() {
        return None;
    }
    let side_of = |tag: &str| -> Side {
        let Some(element) = containers
            .iter()
            .rev()
            .find_map(|container| container.find_child(tag))
        else {
            return Side::Undeclared;
        };
        let int_attr = |key| parse_int(element.attr(key).unwrap_or(""), Radix::Ten);
        let positive = |value: f64| (value.is_finite() && value > 0.0).then_some(value);
        let space = positive(int_attr("w:space"));
        if matches!(element.attr("w:val"), Some("none" | "nil")) {
            return match space {
                Some(space) => Side::Line(ParaBorderLine {
                    none: true,
                    space_pt: Some(JsNum(space)),
                    ..ParaBorderLine::default()
                }),
                None => Side::Reset,
            };
        }
        let themed =
            truthy(element.attr("w:themeColor"))
                .zip(theme)
                .and_then(|(reference, theme)| {
                    resolve_theme_color(
                        reference,
                        theme,
                        element.attr("w:themeTint"),
                        element.attr("w:themeShade"),
                    )
                });
        let literal = || {
            truthy(element.attr("w:color"))
                .filter(|color| *color != "auto")
                .map(|color| strip_hash(color).to_owned())
        };
        Side::Line(ParaBorderLine {
            color: themed.filter(|hex| !hex.is_empty()).or_else(literal),
            sz_pt: positive(int_attr("w:sz")).map(|sz| JsNum(sz / 8.0)),
            space_pt: space.map(JsNum),
            none: false,
        })
    };
    let sides = ParaBorderSides {
        t: side_of("w:top"),
        b: side_of("w:bottom"),
        l: side_of("w:left"),
        r: side_of("w:right"),
    };
    (sides != ParaBorderSides::default()).then_some(sides)
}

/// The sides of a paragraph format that carry a value per side.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PerSide<T> {
    #[serde(default = "none", skip_serializing_if = "Option::is_none")]
    pub t: Option<T>,
    #[serde(default = "none", skip_serializing_if = "Option::is_none")]
    pub b: Option<T>,
    #[serde(default = "none", skip_serializing_if = "Option::is_none")]
    pub l: Option<T>,
    #[serde(default = "none", skip_serializing_if = "Option::is_none")]
    pub r: Option<T>,
}

fn none<T>() -> Option<T> {
    None
}

impl<T> Default for PerSide<T> {
    fn default() -> Self {
        Self {
            t: None,
            b: None,
            l: None,
            r: None,
        }
    }
}

impl<T> PerSide<T> {
    fn get(&self, ch: char) -> Option<&T> {
        match ch {
            't' => self.t.as_ref(),
            'b' => self.b.as_ref(),
            'l' => self.l.as_ref(),
            _ => self.r.as_ref(),
        }
    }

    fn set(&mut self, ch: char, value: T) {
        match ch {
            't' => self.t = Some(value),
            'b' => self.b = Some(value),
            'l' => self.l = Some(value),
            _ => self.r = Some(value),
        }
    }

    fn is_empty(&self) -> bool {
        self.t.is_none() && self.b.is_none() && self.l.is_none() && self.r.is_none()
    }
}

/// Model form of the sides: the drawn "tblr" subset with its declared look,
/// the reset sides apart.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParaBorderModel {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub borders: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub border_lines: Option<PerSide<ParaBorderLine>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub border_reset: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub border_pad: Option<PerSide<JsNum>>,
}

fn is_nonzero(value: &JsNum) -> bool {
    value.0 != 0.0 && !value.0.is_nan()
}

pub fn para_borders_of(sides: &ParaBorderSides) -> ParaBorderModel {
    let mut borders = String::new();
    let mut reset = String::new();
    let mut lines = PerSide::default();
    let mut pad = PerSide::default();
    for (ch, side) in sides.sides() {
        match side {
            Side::Undeclared => {}
            Side::Reset => reset.push(ch),
            Side::Line(line) if line.none => {
                reset.push(ch);
                if let Some(space) = line.space_pt.filter(is_nonzero) {
                    pad.set(ch, space);
                }
            }
            Side::Line(line) => {
                borders.push(ch);
                if line.color.is_some() || line.sz_pt.is_some() || line.space_pt.is_some() {
                    lines.set(ch, line.clone());
                }
            }
        }
    }
    ParaBorderModel {
        border_lines: (!borders.is_empty() && !lines.is_empty()).then_some(lines),
        borders: (!borders.is_empty()).then_some(borders),
        border_reset: (!reset.is_empty()).then_some(reset),
        border_pad: (!pad.is_empty()).then_some(pad),
    }
}

/// Word merges pBdr per side: every side the direct pPr declares (drawn or
/// reset) wins, the style fills in the rest.
pub fn merge_style_borders(
    sides: &ParaBorderSides,
    direct: Option<&ParaBorderModel>,
) -> ParaBorderModel {
    let direct_text = |field: fn(&ParaBorderModel) -> &Option<String>| {
        direct
            .and_then(|direct| field(direct).as_deref())
            .unwrap_or("")
    };
    let drawn = direct_text(|direct| &direct.borders);
    let reset = direct_text(|direct| &direct.border_reset);
    let mut merged = ParaBorderSides::default();
    for (ch, side) in sides.sides() {
        let direct_line = direct.and_then(|direct| direct.border_lines.as_ref()?.get(ch));
        let direct_pad = direct
            .and_then(|direct| direct.border_pad.as_ref()?.get(ch))
            .filter(|pad| is_nonzero(pad));
        if drawn.contains(ch) {
            *merged.side_mut(ch) = Side::Line(direct_line.cloned().unwrap_or_default());
        } else if let Some(pad) = direct_pad {
            *merged.side_mut(ch) = Side::Line(ParaBorderLine {
                none: true,
                space_pt: Some(*pad),
                ..ParaBorderLine::default()
            });
        } else if matches!(side, Side::Line(_)) && !drawn.contains(ch) && !reset.contains(ch) {
            *merged.side_mut(ch) = side.clone();
        }
    }
    ParaBorderModel {
        border_reset: None,
        ..para_borders_of(&merged)
    }
}

#[derive(Debug, Default, PartialEq, Serialize)]
pub struct CellMargins {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub top: Option<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub left: Option<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bottom: Option<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub right: Option<JsNum>,
}

/// Cell margins in twips. Sides in a unit other than dxa are skipped.
pub fn cell_margins_of(node: Option<&XNode>) -> Option<CellMargins> {
    let node = node?;
    let mut margins = CellMargins::default();
    let width_of = |tag| -> Option<JsNum> {
        let side = node.find_child(tag);
        let attr = |key| side.and_then(|side| side.attr(key));
        if truthy(attr("w:type")).is_some_and(|unit| unit != "dxa") {
            return None;
        }
        // `Number(undefined)` is NaN, `Number("")` is 0
        let width = attr("w:w").map_or(f64::NAN, to_number);
        (width.is_finite() && width >= 0.0).then_some(JsNum(width))
    };
    let first = |side: &mut Option<JsNum>, tag| {
        if side.is_none() {
            *side = width_of(tag);
        }
    };
    first(&mut margins.top, "w:top");
    first(&mut margins.left, "w:left");
    first(&mut margins.bottom, "w:bottom");
    first(&mut margins.right, "w:right");
    first(&mut margins.left, "w:start");
    first(&mut margins.right, "w:end");
    (margins != CellMargins::default()).then_some(margins)
}
