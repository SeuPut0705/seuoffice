//! The model types of packages/pptx-engine/src/types.ts that unit 3 needs,
//! field for field and in the order of types.ts. Unit 4 ports the rest of the
//! file here. A key the TypeScript leaves `undefined` is no key.

use jscompat::JsNum;
use serde::{Deserialize, Serialize};

/// `EmuRect`
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct EmuRect {
    pub x: JsNum,
    pub y: JsNum,
    pub cx: JsNum,
    pub cy: JsNum,
}

/// `Transform`
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Transform {
    pub offset: EmuRect,
    pub rot: JsNum,
    pub flip_h: bool,
    pub flip_v: bool,
}

/// `ResolvedColor`: `#RRGGBB`, `#RRGGBBAA` or `none`.
pub type ResolvedColor = String;

/// `Fill`, tagged by `type`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Fill {
    None,
    Solid { color: ResolvedColor },
    Gradient(GradientFill),
    Image(ImageFill),
    Pattern(PatternFill),
}

/// One of `stops` of a gradient `Fill`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GradientStop {
    pub pos: JsNum,
    pub color: ResolvedColor,
}

/// `{ l, t, r, b }`: the insets of `fillTo`, `tileRect` and `fillRect`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Insets {
    pub l: JsNum,
    pub t: JsNum,
    pub r: JsNum,
    pub b: JsNum,
}

/// `path` of a gradient `Fill`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GradientPath {
    Circle,
    Rect,
    Shape,
}

/// `Fill` of `type: 'gradient'`, without its tag.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GradientFill {
    pub stops: Vec<GradientStop>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub angle: Option<JsNum>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scaled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<GradientPath>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fill_to: Option<Insets>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tile_rect: Option<Insets>,
}

/// `mode` of an image `Fill`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ImageMode {
    Stretch,
    Tile,
}

/// `clrChange` of an image `Fill`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ClrChange {
    pub from: String,
    pub to: String,
}

/// `lum` of an image `Fill`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Lum {
    pub bright: JsNum,
    pub contrast: JsNum,
}

/// `tile` of an image `Fill`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ImageTile {
    pub tx: JsNum,
    pub ty: JsNum,
    pub sx: JsNum,
    pub sy: JsNum,
    pub algn: String,
}

/// `Fill` of `type: 'image'`, without its tag.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageFill {
    pub media_ref: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<ImageMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alpha: Option<JsNum>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fill_rect: Option<Insets>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duotone: Option<(String, String)>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clr_change: Option<ClrChange>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lum: Option<Lum>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bi_level: Option<JsNum>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tile: Option<ImageTile>,
}

/// `Fill` of `type: 'pattern'`, without its tag.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PatternFill {
    pub fg: ResolvedColor,
    pub bg: ResolvedColor,
    pub preset: String,
}

/// `ArrowEndSize`
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ArrowEndSize {
    Sm,
    Med,
    Lg,
}

/// `ArrowEnd`. `type` is a string: parse.ts casts the document's `type`
/// attribute to the union without checking it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ArrowEnd {
    pub r#type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub w: Option<ArrowEndSize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub len: Option<ArrowEndSize>,
}

/// `cap` of a `Stroke`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LineCap {
    Flat,
    Round,
    Square,
}

/// `join` of a `Stroke`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LineJoin {
    Round,
    Bevel,
    Miter,
}

/// `compound` of a `Stroke`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LineCompound {
    Sng,
    Dbl,
    ThickThin,
    ThinThick,
    Tri,
}

/// `Stroke`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stroke {
    pub fill: Fill,
    pub width: JsNum,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cap: Option<LineCap>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub join: Option<LineJoin>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compound: Option<LineCompound>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub head_end: Option<ArrowEnd>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tail_end: Option<ArrowEnd>,
}

/// `TextAlign`
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TextAlign {
    Left,
    Center,
    Right,
    Justify,
}
