//! The model of packages/pptx-engine/src/types.ts, every export.
//!
//! The keys of an object serialize in the order the TypeScript gives them,
//! as `JSON.stringify` writes it. A type one literal of parse.ts builds is a
//! struct with its fields in the order of that literal. A type whose keys
//! come in an order that depends on the path (an object built by assignments
//! under conditions, a literal holding a key a later assignment fills, or
//! one index.ts assigns to after the parse) is a `js_object!`: build it with
//! [`Slot::of`] and [`Slot::maybe`] in the order of the literal, and
//! [`assigned`] for a literal key whose value may be `undefined`. Fields
//! types.ts declares and parse.ts never assigns come last, in the order of
//! types.ts. A key the TypeScript leaves `undefined` is no key.
//!
//! The text, picture, group, passthrough and chart elements, `SlideElement`,
//! `Slide` and `SlideDeck` carry no `Deserialize`: `CustomGeometry`
//! (custgeom.rs) and `ChartModel` (chart) have none yet.

use jscompat::{JsNum, JsObject, Slot, js_object};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::chart::ChartModel;
use crate::placeholder::{Bullet, BulletType};
use crate::table_style::TableStyleFlags;

pub use crate::custgeom::CustomGeometry;

/// `{ key: value }` where `value` may be `undefined`: the object has the key
/// either way, so a later `object.key = v` keeps the place of the literal.
pub fn assigned<T>(value: Option<T>) -> Slot<T> {
    let mut slot = Slot::default();
    slot.assign(value);
    slot
}

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

/// `GlowEffect`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GlowEffect {
    pub color: ResolvedColor,
    pub radius: JsNum,
}

/// `ReflectionEffect`
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReflectionEffect {
    pub blur_rad: JsNum,
    pub start_a: JsNum,
    pub end_pos: JsNum,
    pub dist: JsNum,
}

/// `ShadowEffect`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShadowEffect {
    pub color: ResolvedColor,
    pub blur_rad: JsNum,
    pub dist: JsNum,
    pub dir_deg: JsNum,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inner: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sx: Option<JsNum>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sy: Option<JsNum>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kx_deg: Option<JsNum>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ky_deg: Option<JsNum>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub algn: Option<String>,
}

/// The shadow of a level style (`dflt?.shadow` of parseRun): placeholder.rs
/// writes it with the four keys `parseDefRPrStyle` sets.
impl From<&crate::placeholder::ShadowEffect> for ShadowEffect {
    fn from(shadow: &crate::placeholder::ShadowEffect) -> Self {
        Self {
            color: shadow.color.clone(),
            blur_rad: shadow.blur_rad,
            dist: shadow.dist,
            dir_deg: shadow.dir_deg,
            inner: None,
            sx: None,
            sy: None,
            kx_deg: None,
            ky_deg: None,
            algn: None,
        }
    }
}

// ── Text ───────────────────────────────────────────────────────────────

/// `RunStyleSource`, in the order of the literal of parseRun (types.ts
/// declares `fontFamily` second).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunStyleSource {
    pub font_size: String,
    pub bold: String,
    pub italic: String,
    pub color: String,
    pub font_family: String,
}

/// `fontScriptHint` of a `TextRun`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FontScriptHint {
    Ja,
    Ko,
    Sc,
    Tc,
}

/// `eaLang` of a `TextRun` or level style: the line-breaking language's East
/// Asian script, `none` for a tag that is not East Asian (en-US).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EaLang {
    Ja,
    Ko,
    Sc,
    Tc,
    None,
}

/// `outline` of a `TextRun`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextOutline {
    pub color: ResolvedColor,
    pub width_emu: JsNum,
}

/// `gradient` of a `TextRun`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RunGradient {
    pub stops: Vec<GradientStop>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub angle: Option<JsNum>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scaled: Option<bool>,
}

js_object! {
    deserialize;
    /// `TextRun`. Declared in the order of the literal of parseRun, then
    /// what parseParagraph assigns after it (`field`, `rawXml`, `paraMark`),
    /// then the keys only an edit sets. `color` and `fontSize` are keys of
    /// the literal even when `undefined` ([`assigned`]): the fontRef color
    /// of parseSpShape fills `color` in its place.
    #[derive(Debug, Clone, PartialEq)]
    pub struct TextRun {
        pub text: String,
        pub style_src: RunStyleSource,
        pub bold: bool,
        pub bold_implicit: bool,
        pub italic: bool,
        pub italic_implicit: bool,
        pub cap: String,
        pub cap_explicit: String,
        pub underline: bool,
        pub underline_style: String,
        pub underline_explicit_none: bool,
        pub underline_implicit: bool,
        pub redact: String,
        pub strike: bool,
        pub strike_style: String,
        pub strike_explicit_none: bool,
        pub latin_font: String,
        pub ea_font: String,
        pub cs_font: String,
        pub font_implicit: bool,
        pub font_size: JsNum,
        pub font_size_implicit: bool,
        pub letter_spacing: JsNum,
        pub kern: JsNum,
        pub baseline: JsNum,
        pub font_family: String,
        pub latin_family: String,
        pub font_script_hint: FontScriptHint,
        pub ea_lang: EaLang,
        pub lang: String,
        pub alt_lang: String,
        pub color: ResolvedColor,
        pub color_follows_theme: bool,
        pub color_node_xml: String,
        pub color_inherited: bool,
        pub highlight: ResolvedColor,
        pub outline: TextOutline,
        pub shadow: ShadowEffect,
        pub gradient: RunGradient,
        pub glow: GlowEffect,
        pub reflection: bool,
        pub hyperlink_r_id: String,
        pub hyperlink: String,
        pub hyperlink_action: String,
        pub hyperlink_tooltip: String,
        pub field: String,
        pub raw_xml: String,
        pub para_mark: bool,
        pub letter_spacing_edited: bool,
        pub highlight_edited: bool,
    }
}

/// `ParagraphDefaultRunProps`, one literal of parseParagraphDefRPr.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParagraphDefaultRunProps {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font_size: Option<JsNum>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bold: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub italic: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cap: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<ResolvedColor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color_node_xml: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latin_font: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ea_font: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cs_font: Option<String>,
}

js_object! {
    deserialize;
    /// `bullet` of a `Paragraph`: built by assignments under conditions in
    /// parseParagraph, or the level style's bullet (see the `From` below).
    #[derive(Debug, Clone, PartialEq)]
    pub struct ParagraphBullet {
        pub r#type: BulletType,
        pub char: String,
        pub media_ref: String,
        pub blip_embed_id: String,
        pub color: ResolvedColor,
        pub color_node_xml: String,
        pub font: String,
        pub size_pct: JsNum,
        pub size_pt: JsNum,
        pub num_type: String,
        pub start_at: JsNum,
    }
}

/// `dflt?.bullet`, the bullet of a level style: the same object, its keys in
/// the order they were set there.
impl From<&Bullet> for ParagraphBullet {
    fn from(bullet: &Bullet) -> Self {
        let mut out = Self::default();
        for key in bullet.keys() {
            match key {
                "type" => out.r#type.assign(*bullet.r#type),
                "char" => out.char.assign((*bullet.char).clone()),
                "mediaRef" => out.media_ref.assign((*bullet.media_ref).clone()),
                "blipEmbedId" => out.blip_embed_id.assign((*bullet.blip_embed_id).clone()),
                "font" => out.font.assign((*bullet.font).clone()),
                "color" => out.color.assign((*bullet.color).clone()),
                "sizePct" => out.size_pct.assign(*bullet.size_pct),
                "sizePt" => out.size_pt.assign(*bullet.size_pt),
                "numType" => out.num_type.assign((*bullet.num_type).clone()),
                "startAt" => out.start_at.assign(*bullet.start_at),
                _ => {}
            }
        }
        out
    }
}

/// One of `tabStops` of a `Paragraph`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TabStop {
    pub pos: JsNum,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub algn: Option<String>,
}

js_object! {
    deserialize;
    /// `pPrExplicit` of a `Paragraph`: parseParagraph spreads its keys in this
    /// order; an edit sets the bit of what it changed, last.
    #[derive(Debug, Clone, PartialEq)]
    pub struct PPrExplicit {
        pub align: bool,
        pub ln_spc: bool,
        pub spc_bef: bool,
        pub spc_aft: bool,
        pub bullet: bool,
        pub mar_l: bool,
        pub mar_r: bool,
        pub indent: bool,
        pub tab_lst: bool,
        pub def_tab_sz: bool,
        pub hanging_punct: bool,
        pub latin_ln_brk: bool,
        pub ea_ln_brk: bool,
    }
}

js_object! {
    deserialize;
    /// `Paragraph`, in the order of the literal of parseParagraph. `align` and
    /// `level` are keys of the literal even when `undefined` ([`assigned`]).
    #[derive(Debug, Clone, PartialEq)]
    pub struct Paragraph {
        pub runs: Vec<TextRun>,
        pub align: TextAlign,
        pub align_src: String,
        pub rtl: bool,
        pub hanging_punct: bool,
        pub latin_ln_brk: bool,
        pub ea_ln_brk: bool,
        pub level: JsNum,
        pub p_pr_explicit: PPrExplicit,
        pub line_height: JsNum,
        pub line_exact: JsNum,
        pub space_before: JsNum,
        pub space_after: JsNum,
        pub space_before_pct: JsNum,
        pub space_after_pct: JsNum,
        pub bullet: ParagraphBullet,
        pub mar_l: JsNum,
        pub mar_r: JsNum,
        pub indent: JsNum,
        pub tab_stops: Vec<TabStop>,
        pub def_tab_sz: JsNum,
        pub def_r_pr: ParagraphDefaultRunProps,
    }
}

/// `anchor` of a `TextBody`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TextAnchor {
    Top,
    Middle,
    Bottom,
}

/// `autofit` of a `TextBody`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Autofit {
    None,
    Shrink,
    Resize,
}

/// `vert` of a `TextBody`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TextVert {
    EaVert,
    Vert,
    Vert270,
    WordArtVert,
}

js_object! {
    deserialize;
    /// `insets` of a `TextBody`: `{ l, t, r, b }` in parseTextBody,
    /// `{ l, r, t, b }` where parseTableCell replaces it.
    #[derive(Debug, Clone, PartialEq)]
    pub struct TextInsets {
        pub l: JsNum,
        pub t: JsNum,
        pub r: JsNum,
        pub b: JsNum,
    }
}

/// `extrusion3d` of a `TextBody`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Extrusion3d {
    pub color: ResolvedColor,
    pub depth_emu: JsNum,
    pub lat_deg: JsNum,
    pub lon_deg: JsNum,
}

/// `txWarp` of a `TextBody`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TxWarp {
    pub prst: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub adj: Option<JsObject<JsNum>>,
}

js_object! {
    deserialize;
    /// `TextBody`, in the order of the literal of parseTextBody. `anchor` is a
    /// key of the literal even when `undefined` ([`assigned`]); `anchorCtr`
    /// inherited by parseSpShape comes after `txWarp`.
    #[derive(Debug, Clone, PartialEq)]
    pub struct TextBody {
        pub paragraphs: Vec<Paragraph>,
        pub anchor: TextAnchor,
        pub anchor_ctr: bool,
        pub insets: TextInsets,
        pub autofit: Autofit,
        pub font_scale: JsNum,
        pub ln_spc_reduction: JsNum,
        pub wrap: bool,
        pub vert: TextVert,
        pub num_col: JsNum,
        pub spc_col: JsNum,
        pub extrusion3d: Extrusion3d,
        pub tx_warp: TxWarp,
    }
}

// ── Elements ───────────────────────────────────────────────────────────

/// `ElementType`, the `type` of every element.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ElementType {
    Text,
    Shape,
    Picture,
    Group,
    Table,
    Chart,
    Passthrough,
}

/// `ByteAnchor`. `range` holds byte offsets into the slide XML inside the
/// engine; the dispatch converts them to UTF-16 code units.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ByteAnchor {
    pub sp_index: i64,
    /// Shared: the TypeScript hands one string to every element built from
    /// a fragment (a chart's user shapes, each choice of an
    /// mc:AlternateContent), and a copy per element would make memory the
    /// fragment's size times their number.
    pub original_xml: Arc<str>,
    pub range: [u64; 2],
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gap_after: Option<String>,
}

js_object! {
    deserialize;
    /// `PPrDirty`: an edit merges it as `{ ...el.dirtyPPr, ...d }`.
    #[derive(Debug, Clone, PartialEq)]
    pub struct PPrDirty {
        pub bullet: bool,
        pub level: bool,
        pub ln_spc: bool,
        pub spc_bef: bool,
        pub spc_aft: bool,
        pub align: bool,
        pub rtl: bool,
        pub indents: bool,
        pub para_indices: Vec<JsNum>,
    }
}

/// `{ id, idx }` of `connection`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct ConnectionEnd {
    pub id: JsNum,
    pub idx: JsNum,
}

/// `connection` of an element.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Connection {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start: Option<ConnectionEnd>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end: Option<ConnectionEnd>,
}

/// `{ lat, lon, rev }`: `cameraRot` and `lightRot` of a `Scene3D`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct SceneRotation {
    pub lat: JsNum,
    pub lon: JsNum,
    pub rev: JsNum,
}

/// `bevelTop` of a `Scene3D`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BevelTop {
    pub w_emu: JsNum,
    pub h_emu: JsNum,
    pub preset: String,
}

/// `Scene3D`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Scene3D {
    pub camera_preset: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub camera_rot: Option<SceneRotation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub light_rig: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub light_dir: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub light_rot: Option<SceneRotation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extrusion_emu: Option<JsNum>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub z_emu: Option<JsNum>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extrusion_color: Option<ResolvedColor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub material: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bevel_top: Option<BevelTop>,
}

js_object! {
    /// `TextElement` (`type` is `text` or `shape`): the literal of parseSpShape
    /// with `connection` of parseConnector's between `noGeometry` and `fill`,
    /// then `nvId` (parseGroupChild), then `ElementBase` keys no parse sets.
    /// `placeholder`, `name`, `presetGeometry`, `fill` and `text` are keys of
    /// parseSpShape's literal even when `undefined` ([`assigned`]).
    #[derive(Debug, Clone, PartialEq)]
    pub struct TextElement {
        pub id: String,
        pub r#type: ElementType,
        pub anchor: ByteAnchor,
        pub transform: Transform,
        pub placeholder: String,
        pub tx_box: bool,
        pub name: String,
        pub preset_geometry: String,
        pub adjust: JsObject<JsNum>,
        pub custom_geometry: CustomGeometry,
        pub no_geometry: bool,
        pub connection: Connection,
        pub fill: Fill,
        pub use_bg_fill: bool,
        pub fill_overlay: Fill,
        pub stroke: Stroke,
        pub shadow: ShadowEffect,
        pub glow: GlowEffect,
        pub reflection: ReflectionEffect,
        pub scene3d: Scene3D,
        pub soft_edge: JsNum,
        pub text: TextBody,
        pub nv_id: String,
        pub dirty: bool,
        pub text_moved: bool,
        pub dirty_transform: bool,
        pub dirty_fill: bool,
        pub dirty_stroke: bool,
        pub dirty_src_rect: bool,
        pub dirty_p_pr: PPrDirty,
        pub descr: String,
        pub redact: String,
    }
}

/// `kind` of a picture's `media`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MediaKind {
    Video,
    Audio,
}

/// `media` of a `PictureElement`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PictureMedia {
    pub kind: MediaKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub external: Option<bool>,
}

/// `rot` of a picture's `model3d`: `am3d:rot` in 60,000ths of a degree.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Model3dRotation {
    pub ax: JsNum,
    pub ay: JsNum,
    pub az: JsNum,
}

/// `model3d` of a `PictureElement`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Model3d {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    pub rot: Model3dRotation,
}

js_object! {
    /// `PictureElement`: the literal of parsePicture (the OLE preview picture of
    /// graphicFramePassthrough is its first five keys), then `model3d`
    /// (parseShapeFragment), `nvId` (parseGroupChild), then the keys no parse
    /// sets. `name` is a key of the literal even when `undefined`.
    #[derive(Debug, Clone, PartialEq)]
    pub struct PictureElement {
        pub id: String,
        pub r#type: ElementType,
        pub anchor: ByteAnchor,
        pub transform: Transform,
        pub name: String,
        pub descr: String,
        pub redact: String,
        pub media_ref: String,
        pub src_rect: Insets,
        pub tile: bool,
        pub preset_geometry: String,
        pub adjust: JsObject<JsNum>,
        pub custom_geometry: CustomGeometry,
        pub scene3d: Scene3D,
        pub opacity: JsNum,
        pub soft_edge: JsNum,
        pub media: PictureMedia,
        pub fill: Fill,
        pub duotone: (String, String),
        pub clr_change: ClrChange,
        pub lum: Lum,
        pub bi_level: JsNum,
        pub stroke: Stroke,
        pub shadow: ShadowEffect,
        pub glow: GlowEffect,
        pub reflection: ReflectionEffect,
        pub model3d: Model3d,
        pub nv_id: String,
        pub data_url: String,
        pub dirty: bool,
        pub text_moved: bool,
        pub dirty_transform: bool,
        pub dirty_fill: bool,
        pub dirty_stroke: bool,
        pub dirty_src_rect: bool,
        pub dirty_p_pr: PPrDirty,
        pub placeholder: String,
        pub tx_box: bool,
        pub connection: Connection,
    }
}

js_object! {
    /// `GroupElement`: the literal of parseGroup (`children` replaced in its
    /// place), then `nvId`, then the keys no parse sets.
    #[derive(Debug, Clone, PartialEq)]
    pub struct GroupElement {
        pub id: String,
        pub r#type: ElementType,
        pub anchor: ByteAnchor,
        pub transform: Transform,
        pub name: String,
        pub children: Vec<SlideElement>,
        pub child_offset: EmuRect,
        pub nv_id: String,
        pub dirty: bool,
        pub text_moved: bool,
        pub dirty_transform: bool,
        pub dirty_fill: bool,
        pub dirty_stroke: bool,
        pub dirty_src_rect: bool,
        pub dirty_p_pr: PPrDirty,
        pub placeholder: String,
        pub tx_box: bool,
        pub descr: String,
        pub redact: String,
        pub connection: Connection,
    }
}

/// `kind` of a `PassthroughElement`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PassthroughKind {
    Chart,
    Smartart,
    Table,
    Ole,
    Connector,
    Media,
    Unknown,
}

js_object! {
    /// `PassthroughElement`: the literal of passthrough and of
    /// graphicFramePassthrough, then `previewShapes` or `previewPicture`,
    /// `noChip`, `nvId`, then the keys no parse sets.
    #[derive(Debug, Clone, PartialEq)]
    pub struct PassthroughElement {
        pub id: String,
        pub r#type: ElementType,
        pub anchor: ByteAnchor,
        pub transform: Transform,
        pub kind: PassthroughKind,
        pub preview_shapes: Vec<SlideElement>,
        pub preview_picture: PictureElement,
        pub no_chip: bool,
        pub nv_id: String,
        pub dirty: bool,
        pub text_moved: bool,
        pub dirty_transform: bool,
        pub dirty_fill: bool,
        pub dirty_stroke: bool,
        pub dirty_src_rect: bool,
        pub dirty_p_pr: PPrDirty,
        pub placeholder: String,
        pub tx_box: bool,
        pub name: String,
        pub descr: String,
        pub redact: String,
        pub connection: Connection,
    }
}

// ── Table ──────────────────────────────────────────────────────────────

js_object! {
    deserialize;
    /// `TableCellBorders`: parseTableCell sets the cell's own lines in the
    /// order l, r, t, b, then the style's inside lines it lacked, in the same
    /// order, so `{ t, l }` happens.
    #[derive(Debug, Clone, PartialEq)]
    pub struct TableCellBorders {
        pub l: Stroke,
        pub r: Stroke,
        pub t: Stroke,
        pub b: Stroke,
    }
}

/// `bevel` of a `TableCell`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CellBevel {
    pub width_emu: JsNum,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preset: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub light_dir: Option<String>,
}

js_object! {
    deserialize;
    /// `TableCell`: `{}` and then assignments, in the order of parseTableCell.
    #[derive(Debug, Clone, PartialEq)]
    pub struct TableCell {
        pub text: TextBody,
        pub fill: Fill,
        pub bevel: CellBevel,
        pub borders: TableCellBorders,
        pub grid_span: JsNum,
        pub row_span: JsNum,
        pub merged: bool,
    }
}

js_object! {
    deserialize;
    /// `TableElement`: the literal of parseTable, then `nvId`, then the keys
    /// no parse sets. `styleFlags` is `{ ...flags }`: all six flags, in the
    /// order of the literal of parseTable (types.ts declares `bandRow` second).
    #[derive(Debug, Clone, PartialEq)]
    pub struct TableElement {
        pub id: String,
        pub r#type: ElementType,
        pub anchor: ByteAnchor,
        pub transform: Transform,
        pub name: String,
        pub col_widths: Vec<JsNum>,
        pub row_heights: Vec<JsNum>,
        pub rows: Vec<Vec<TableCell>>,
        pub style_id: String,
        pub style_flags: TableStyleFlags,
        pub rtl: bool,
        pub bg_fill: Fill,
        pub nv_id: String,
        pub dirty: bool,
        pub text_moved: bool,
        pub dirty_transform: bool,
        pub dirty_fill: bool,
        pub dirty_stroke: bool,
        pub dirty_src_rect: bool,
        pub dirty_p_pr: PPrDirty,
        pub placeholder: String,
        pub tx_box: bool,
        pub descr: String,
        pub redact: String,
        pub connection: Connection,
    }
}

// ── Chart ──────────────────────────────────────────────────────────────

js_object! {
    /// `ChartElement`: the literals of graphicFramePassthrough (`descr` and
    /// `userShapes` only for a classic chart), then `nvId`, then the keys no
    /// parse sets. `name` is a key of the literal even when `undefined`.
    #[derive(Debug, Clone, PartialEq)]
    pub struct ChartElement {
        pub id: String,
        pub r#type: ElementType,
        pub anchor: ByteAnchor,
        pub transform: Transform,
        pub name: String,
        pub descr: String,
        pub chart: ChartModel,
        pub user_shapes: Vec<TextElement>,
        pub nv_id: String,
        pub dirty: bool,
        pub text_moved: bool,
        pub dirty_transform: bool,
        pub dirty_fill: bool,
        pub dirty_stroke: bool,
        pub dirty_src_rect: bool,
        pub dirty_p_pr: PPrDirty,
        pub placeholder: String,
        pub tx_box: bool,
        pub redact: String,
        pub connection: Connection,
    }
}

/// `SlideElement`. Each element writes its own `type` second, after `id`,
/// so the union is untagged here.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged)]
pub enum SlideElement {
    Text(Box<TextElement>),
    Picture(Box<PictureElement>),
    Group(Box<GroupElement>),
    Table(Box<TableElement>),
    Chart(Box<ChartElement>),
    Passthrough(Box<PassthroughElement>),
}

/// `el.<field>` of any element: every variant has the fields of
/// `SlideElementBase` (`id`, `type`, `anchor`, `transform`, `nvId`, the dirty
/// flags), so `with_element!(el, e => &mut e.dirty)` reads or writes one of
/// them whatever the element is.
#[macro_export]
macro_rules! with_element {
    ($el:expr, $e:ident => $body:expr) => {
        match $el {
            $crate::types::SlideElement::Text($e) => $body,
            $crate::types::SlideElement::Picture($e) => $body,
            $crate::types::SlideElement::Group($e) => $body,
            $crate::types::SlideElement::Table($e) => $body,
            $crate::types::SlideElement::Chart($e) => $body,
            $crate::types::SlideElement::Passthrough($e) => $body,
        }
    };
}

impl SlideElement {
    /// `el.id`; '' where the element has none.
    pub fn id(&self) -> &str {
        with_element!(self, e => (*e.id).as_deref().unwrap_or(""))
    }

    /// `el.type`
    pub fn element_type(&self) -> Option<ElementType> {
        with_element!(self, e => *e.r#type)
    }
}

// ── Slide / presentation ───────────────────────────────────────────────

js_object! {
    /// `Slide`: the literal of parseSlide, then what index.ts assigns after
    /// it (`decorations` when the slide opens, `structureDirty` and the
    /// background keys on edits). `layoutPath` and `masterPath` are keys of
    /// the literal even when `undefined` ([`assigned`]).
    #[derive(Debug, Clone, PartialEq)]
    pub struct Slide {
        pub path: String,
        pub original_xml: String,
        pub body_prefix: String,
        pub body_suffix: String,
        pub elements: Vec<SlideElement>,
        pub layout_path: String,
        pub master_path: String,
        pub background: Fill,
        pub bg_own: bool,
        pub master_sp_hidden: bool,
        pub decorations: Vec<SlideElement>,
        pub structure_dirty: bool,
    }
}

/// `SlideSize`
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct SlideSize {
    pub cx: JsNum,
    pub cy: JsNum,
}

/// `SlideDeck`
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlideDeck {
    pub slides: Vec<Slide>,
    pub size: SlideSize,
    pub original_hash: String,
}
