//! What every section of packages/pptx-engine/src/parse.ts shares: the
//! parser options of `parser`, `EMU_PER_PT`, `DEFAULT_BODY_INSETS`,
//! `ParseContext`, `SlideParseInput`, `DecorationOptions`, the ids of
//! `uid`, the `Node` alias and generate.ts's `COORD_MAX`.

use std::cell::Cell;

use crate::xml_utils::xml_parse_object as parse_object;
use jscompat::{JsMap, JsNum};
use ooxml_xml::ObjectOptions;
use serde::{Deserialize, Deserializer};
use serde_json::Value;

use crate::placeholder::{
    MasterTextStyles, PlaceholderAnchor, PlaceholderGeom, PlaceholderInsets, PlaceholderMap,
    PresetGeom, TextStyleLevels,
};
use crate::theme::Theme;
use crate::types::{Fill, Insets, Transform};

/// An XML node of the object tree, `node?.[key]` of the TypeScript: the
/// same alias as the chart reader's.
pub type Node<'a> = Option<&'a Value>;

/// `COORD_MAX` of generate.ts (the ST_PositiveCoordinate ceiling the write
/// path clamps every `a:ext` to), which parseGroup reads; generate.ts is
/// ported in unit 6.
pub const COORD_MAX: f64 = 27_273_042_316_900.0;

/// `isArray` of `parser`: runs, paragraphs and the shapes of a tree stay
/// lists even when there is one.
const PARSER_ARRAY_NAMES: [&str; 12] = [
    "a:p",
    "a:r",
    "a:br",
    "a:fld",
    "p:sp",
    "p:pic",
    "p:graphicFrame",
    "p:grpSp",
    "p:cxnSp",
    "a:tr",
    "a:tc",
    "a:gridCol",
];

/// The options of `parser`: no trim and no number conversion, so the text
/// of a run reads as written (`<a:t>2026</a:t>` stays a string).
pub const PARSER_OPTIONS: ObjectOptions<'static> = ObjectOptions {
    trim_values: false,
    parse_tag_value: false,
    array_names: &PARSER_ARRAY_NAMES,
};

/// `parser.parse(xml)`. `Err` where fast-xml-parser throws.
pub fn parse_xml(xml: &str) -> Result<Value, String> {
    parse_object(xml, &PARSER_OPTIONS).map_err(|error| error.to_string())
}

/// `EMU_PER_PT`
pub const EMU_PER_PT: f64 = 12700.0;

/// `DEFAULT_BODY_INSETS`: the `<a:bodyPr>` insets (EMU) where the document
/// gives none, 0.1" left and right, 0.05" top and bottom.
pub const DEFAULT_BODY_INSETS: Insets = Insets {
    l: JsNum(91440.0),
    t: JsNum(45720.0),
    r: JsNum(91440.0),
    b: JsNum(45720.0),
};

/// The ids `uid(prefix)` gives: `${prefix}_${(uidCounter++).toString(36)}`.
///
/// The TypeScript reads a counter of the module, so an id depends on every
/// id given before it in the process. Here the caller owns the counter and
/// says where it starts, and every [`ParseContext`] derived from one (each
/// `{ ...ctx, key }` of parse.ts) shares it through a reference. Call
/// [`ParseContext::uid`] exactly where the TypeScript evaluates `uid(...)`:
/// inside the literal, after what its earlier keys computed (parseGroup
/// takes its id before its children, a chart after its user shapes), and
/// also for an element that is then thrown away (a `gf` passthrough of an
/// `mc:Choice`), since that moves the counter.
///
/// How a spec compares ids: the TypeScript side cannot reset its counter,
/// so the spec measures it and rebases the TypeScript result to a counter
/// that started at 0, and calls the Rust with `Uids::starting_at(0)`. Its
/// `call` first parses a probe slide that gives exactly one id
/// (`<p:sld><p:cSld><p:spTree><p:sp><p:spPr/></p:sp></p:spTree></p:cSld></p:sld>`
/// gives `sp_<n>`), makes the real call, and rewrites every `id` of the
/// result from `<prefix>_<k>` to `<prefix>_<(k - n - 1) in base 36>`. Ids
/// then compare absolutely: an id the port forgets to take for a thrown-away
/// element, or takes in another order (a group after its children), shows.
/// Renumbering both sides by first appearance would hide both, and the
/// first id of a result is not where the counter started when an earlier
/// id was thrown away; the runner gives both sides the same arguments, so a
/// start read from the TypeScript result cannot reach the Rust either.
#[derive(Debug, Default)]
pub struct Uids {
    next: Cell<u64>,
}

impl Uids {
    pub fn starting_at(first: u64) -> Self {
        Self {
            next: Cell::new(first),
        }
    }

    /// The number the next `uid` takes: a host that keeps parse.ts's
    /// process-wide counter across calls starts the next call's `Uids` here.
    pub fn next(&self) -> u64 {
        self.next.get()
    }

    /// `uid(prefix)`
    pub fn uid(&self, prefix: &str) -> String {
        let n = self.next.get();
        self.next.set(n.wrapping_add(1));
        format!("{prefix}_{}", base36(n))
    }
}

/// `n.toString(36)` of a non-negative integer.
fn base36(mut n: u64) -> String {
    const DIGITS: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut reversed = Vec::new();
    loop {
        reversed.push(char::from(DIGITS[(n % 36) as usize]));
        n /= 36;
        if n == 0 {
            break;
        }
    }
    reversed.into_iter().rev().collect()
}

/// One entry of `avRels`: the media zip path or the external URL of an
/// audio or video rId.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct AvRel {
    pub target: String,
    #[serde(default)]
    pub external: Option<bool>,
}

/// `ParseContext`, borrowed: every `{ ...ctx, key: value }` of parse.ts is
/// `ParseContext { key: Some(&value), ..*ctx }`, a copy of references, with
/// the value held by the frame that makes it. parse.ts never writes to a
/// context; the one thing it changes is the id counter, through [`Uids`].
/// A `Set<string>` is a slice (only `has` is read).
#[derive(Debug, Clone, Copy)]
pub struct ParseContext<'a> {
    pub theme: Option<&'a Theme>,
    /// Effective fill of the enclosing group (`<a:grpFill/>` resolves to it)
    pub group_fill: Option<&'a Fill>,
    /// The color `schemeClr val="phClr"` stands for in a style template
    pub ph_clr: Option<&'a str>,
    pub media_rels: Option<&'a JsMap<String>>,
    pub hlink_rels: Option<&'a JsMap<String>>,
    pub chart_xmls: Option<&'a JsMap<String>>,
    pub chart_user_shapes: Option<&'a JsMap<String>>,
    pub av_rels: Option<&'a JsMap<AvRel>>,
    pub model3d_rels: Option<&'a JsMap<String>>,
    pub diagram_datas: Option<&'a JsMap<String>>,
    pub diagram_drawings: Option<&'a JsMap<String>>,
    pub diagram_layouts: Option<&'a JsMap<String>>,
    pub diagram_colors: Option<&'a JsMap<String>>,
    pub layout_placeholders: Option<&'a PlaceholderMap>,
    pub master_placeholders: Option<&'a PlaceholderMap>,
    pub master_text_styles: Option<&'a MasterTextStyles>,
    pub default_text_style: Option<&'a TextStyleLevels>,
    pub layout_bg: Option<&'a str>,
    pub master_bg: Option<&'a str>,
    pub layout_media_rels: Option<&'a JsMap<String>>,
    pub master_media_rels: Option<&'a JsMap<String>>,
    pub theme_media_rels: Option<&'a JsMap<String>>,
    pub chart_media_rels: Option<&'a JsMap<JsMap<String>>>,
    pub chart_style_rels: Option<&'a [String]>,
    pub chart_theme_overrides: Option<&'a JsMap<String>>,
    pub diagram_media_rels: Option<&'a JsMap<JsMap<String>>>,
    pub table_styles: Option<&'a str>,
    pub vml_previews: Option<&'a JsMap<String>>,
    pub uids: &'a Uids,
}

impl ParseContext<'_> {
    /// `uid(prefix)`
    pub fn uid(&self, prefix: &str) -> String {
        self.uids.uid(prefix)
    }
}

/// The values a [`ParseContext`] borrows, read from JSON as a spec writes a
/// TypeScript `ParseContext`: a `Map` as its `[key, value]` pairs, a `Set`
/// as its values, everything else as `JSON.stringify` writes it.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ParseContextData {
    pub theme: Option<Theme>,
    pub group_fill: Option<Fill>,
    pub ph_clr: Option<String>,
    #[serde(deserialize_with = "map")]
    pub media_rels: Option<JsMap<String>>,
    #[serde(deserialize_with = "map")]
    pub hlink_rels: Option<JsMap<String>>,
    #[serde(deserialize_with = "map")]
    pub chart_xmls: Option<JsMap<String>>,
    #[serde(deserialize_with = "map")]
    pub chart_user_shapes: Option<JsMap<String>>,
    #[serde(deserialize_with = "map")]
    pub av_rels: Option<JsMap<AvRel>>,
    #[serde(deserialize_with = "map")]
    pub model3d_rels: Option<JsMap<String>>,
    #[serde(deserialize_with = "map")]
    pub diagram_datas: Option<JsMap<String>>,
    #[serde(deserialize_with = "map")]
    pub diagram_drawings: Option<JsMap<String>>,
    #[serde(deserialize_with = "map")]
    pub diagram_layouts: Option<JsMap<String>>,
    #[serde(deserialize_with = "map")]
    pub diagram_colors: Option<JsMap<String>>,
    #[serde(deserialize_with = "placeholder_map")]
    pub layout_placeholders: Option<PlaceholderMap>,
    #[serde(deserialize_with = "placeholder_map")]
    pub master_placeholders: Option<PlaceholderMap>,
    #[serde(deserialize_with = "master_text_styles")]
    pub master_text_styles: Option<MasterTextStyles>,
    pub default_text_style: Option<TextStyleLevels>,
    pub layout_bg: Option<String>,
    pub master_bg: Option<String>,
    #[serde(deserialize_with = "map")]
    pub layout_media_rels: Option<JsMap<String>>,
    #[serde(deserialize_with = "map")]
    pub master_media_rels: Option<JsMap<String>>,
    #[serde(deserialize_with = "map")]
    pub theme_media_rels: Option<JsMap<String>>,
    #[serde(deserialize_with = "map_of_maps")]
    pub chart_media_rels: Option<JsMap<JsMap<String>>>,
    pub chart_style_rels: Option<Vec<String>>,
    #[serde(deserialize_with = "map")]
    pub chart_theme_overrides: Option<JsMap<String>>,
    #[serde(deserialize_with = "map_of_maps")]
    pub diagram_media_rels: Option<JsMap<JsMap<String>>>,
    pub table_styles: Option<String>,
    #[serde(deserialize_with = "map")]
    pub vml_previews: Option<JsMap<String>>,
}

impl ParseContextData {
    pub fn context<'a>(&'a self, uids: &'a Uids) -> ParseContext<'a> {
        ParseContext {
            theme: self.theme.as_ref(),
            group_fill: self.group_fill.as_ref(),
            ph_clr: self.ph_clr.as_deref(),
            media_rels: self.media_rels.as_ref(),
            hlink_rels: self.hlink_rels.as_ref(),
            chart_xmls: self.chart_xmls.as_ref(),
            chart_user_shapes: self.chart_user_shapes.as_ref(),
            av_rels: self.av_rels.as_ref(),
            model3d_rels: self.model3d_rels.as_ref(),
            diagram_datas: self.diagram_datas.as_ref(),
            diagram_drawings: self.diagram_drawings.as_ref(),
            diagram_layouts: self.diagram_layouts.as_ref(),
            diagram_colors: self.diagram_colors.as_ref(),
            layout_placeholders: self.layout_placeholders.as_ref(),
            master_placeholders: self.master_placeholders.as_ref(),
            master_text_styles: self.master_text_styles.as_ref(),
            default_text_style: self.default_text_style.as_ref(),
            layout_bg: self.layout_bg.as_deref(),
            master_bg: self.master_bg.as_deref(),
            layout_media_rels: self.layout_media_rels.as_ref(),
            master_media_rels: self.master_media_rels.as_ref(),
            theme_media_rels: self.theme_media_rels.as_ref(),
            chart_media_rels: self.chart_media_rels.as_ref(),
            chart_style_rels: self.chart_style_rels.as_deref(),
            chart_theme_overrides: self.chart_theme_overrides.as_ref(),
            diagram_media_rels: self.diagram_media_rels.as_ref(),
            table_styles: self.table_styles.as_deref(),
            vml_previews: self.vml_previews.as_ref(),
            uids,
        }
    }
}

/// `SlideParseInput`. The dispatch takes `slideXml` from the text of the
/// call and the rest from its arguments.
#[derive(Debug, Clone, Copy)]
pub struct SlideParseInput<'a> {
    pub path: &'a str,
    pub slide_xml: &'a str,
    pub layout_path: Option<&'a str>,
    pub master_path: Option<&'a str>,
    pub ctx: ParseContext<'a>,
}

/// `DecorationOptions`. `hfTypes` is a `Set<string>`: only `has` is read.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DecorationOptions {
    pub hf_types: Option<Vec<String>>,
    pub slide_num: Option<f64>,
    pub hide_shapes: Option<bool>,
}

/// `new Map(pairs)`: a key given twice keeps its first place and its last
/// value.
struct Pairs<V>(JsMap<V>);

impl<'de, V: Deserialize<'de>> Deserialize<'de> for Pairs<V> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let pairs = Vec::<(String, V)>::deserialize(deserializer)?;
        Ok(Self(pairs.into_iter().collect()))
    }
}

fn map<'de, D, V>(deserializer: D) -> Result<Option<JsMap<V>>, D::Error>
where
    D: Deserializer<'de>,
    V: Deserialize<'de>,
{
    Ok(Option::<Pairs<V>>::deserialize(deserializer)?.map(|pairs| pairs.0))
}

fn map_of_maps<'de, D>(deserializer: D) -> Result<Option<JsMap<JsMap<String>>>, D::Error>
where
    D: Deserializer<'de>,
{
    Ok(
        Option::<Pairs<Pairs<String>>>::deserialize(deserializer)?.map(|pairs| {
            pairs
                .0
                .into_iter()
                .map(|(key, inner)| (key, inner.0))
                .collect()
        }),
    )
}

/// `PlaceholderMap` as JSON; placeholder.rs gives its types no
/// `Deserialize`.
#[derive(Deserialize)]
struct PlaceholderMapJson {
    entries: Vec<PlaceholderGeomJson>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlaceholderGeomJson {
    r#type: String,
    idx: String,
    #[serde(default)]
    transform: Option<Transform>,
    #[serde(default)]
    text_style: Option<TextStyleLevels>,
    #[serde(default)]
    anchor: Option<AnchorJson>,
    #[serde(default)]
    anchor_ctr: Option<bool>,
    #[serde(default)]
    insets: Option<InsetsJson>,
    #[serde(default)]
    fill_sp_pr: Option<Value>,
    #[serde(default)]
    preset_geom: Option<PresetGeomJson>,
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum AnchorJson {
    Top,
    Middle,
    Bottom,
}

/// `{ l?, t?, r?, b? }`, its keys set in the order of the input.
struct InsetsJson(PlaceholderInsets);

impl<'de> Deserialize<'de> for InsetsJson {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let keys = serde_json::Map::<String, Value>::deserialize(deserializer)?;
        let mut insets = PlaceholderInsets::default();
        for (key, value) in keys {
            let n = value.as_f64().map(JsNum);
            match key.as_str() {
                "l" => insets.l.set_some(n),
                "t" => insets.t.set_some(n),
                "r" => insets.r.set_some(n),
                "b" => insets.b.set_some(n),
                _ => {}
            }
        }
        Ok(Self(insets))
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PresetGeomJson {
    prst: String,
    #[serde(default)]
    av_lst_raw: Option<Value>,
}

impl From<PlaceholderGeomJson> for PlaceholderGeom {
    fn from(geom: PlaceholderGeomJson) -> Self {
        Self {
            r#type: geom.r#type,
            idx: geom.idx,
            transform: geom.transform,
            text_style: geom.text_style,
            anchor: geom.anchor.map(|anchor| match anchor {
                AnchorJson::Top => PlaceholderAnchor::Top,
                AnchorJson::Middle => PlaceholderAnchor::Middle,
                AnchorJson::Bottom => PlaceholderAnchor::Bottom,
            }),
            anchor_ctr: geom.anchor_ctr,
            insets: geom.insets.map(|insets| insets.0),
            fill_sp_pr: geom.fill_sp_pr,
            preset_geom: geom.preset_geom.map(|preset| PresetGeom {
                prst: preset.prst,
                av_lst_raw: preset.av_lst_raw,
            }),
        }
    }
}

fn placeholder_map<'de, D>(deserializer: D) -> Result<Option<PlaceholderMap>, D::Error>
where
    D: Deserializer<'de>,
{
    Ok(
        Option::<PlaceholderMapJson>::deserialize(deserializer)?.map(|map| PlaceholderMap {
            entries: map.entries.into_iter().map(PlaceholderGeom::from).collect(),
        }),
    )
}

#[derive(Deserialize)]
struct MasterTextStylesJson {
    #[serde(default)]
    title: Option<TextStyleLevels>,
    #[serde(default)]
    body: Option<TextStyleLevels>,
    #[serde(default)]
    other: Option<TextStyleLevels>,
}

fn master_text_styles<'de, D>(deserializer: D) -> Result<Option<MasterTextStyles>, D::Error>
where
    D: Deserializer<'de>,
{
    Ok(
        Option::<MasterTextStylesJson>::deserialize(deserializer)?.map(|styles| MasterTextStyles {
            title: styles.title,
            body: styles.body,
            other: styles.other,
        }),
    )
}
