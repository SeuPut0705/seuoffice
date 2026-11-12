//! The exported types of chart.ts. A key the TypeScript leaves `undefined` is
//! no key; where the keys of an object are set under conditions the type is
//! a `js_object!`, so they serialize in the order they were set.

use jscompat::{JsNum, js_object};
use serde::Serialize;

use crate::types::Fill;

/// `ChartKind`
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ChartKind {
    Line,
    Bar,
    Pie,
    Area,
    Scatter,
    Radar,
    Funnel,
    Sunburst,
    Unknown,
}

/// One of `ChartSeries.dLblOverrides`, keys in the order of the literal
/// that writes them (`{ idx, hidden }` or `{ idx, val, cat, ser, pct, ... }`).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DLblOverride {
    pub idx: JsNum,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hidden: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub val: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cat: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ser: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pct: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bold: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size_pt: Option<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    /// `null` = explicit `a:noFill`
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fill: Option<Option<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub border: Option<Option<String>>,
}

/// One of `ChartSeries.pointLines`: `{ color, widthPt? }`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PointLine {
    pub color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width_pt: Option<JsNum>,
}

js_object! {
    /// `ChartSeries`. Per-point arrays are sparse in the TypeScript: a hole
    /// is `None`, which JSON writes as `null` as it writes a hole.
    #[derive(Debug, Clone, PartialEq)]
    pub struct ChartSeries {
        pub name: String,
        pub no_fill: bool,
        pub color: String,
        pub values: Vec<Option<JsNum>>,
        pub plot_kind: ChartKind,
        pub x_values: Vec<Option<JsNum>>,
        pub bubble_sizes: Vec<Option<JsNum>>,
        /// Strings; a slot a date sort moved past the end is `None` (`undefined`).
        pub point_labels: Vec<Option<String>>,
        pub smooth: bool,
        pub palette_idx: JsNum,
        pub data_labels: bool,
        pub d_lbl_overrides: Vec<DLblOverride>,
        pub d_lbl_only_points: bool,
        pub data_label_fmt: String,
        pub data_label_fill: String,
        pub data_label_border: String,
        pub dash: String,
        pub line_width_pt: JsNum,
        pub marker: bool,
        pub point_colors: Vec<Option<String>>,
        pub point_fills: Vec<Option<Fill>>,
        pub point_no_fill: Vec<Option<bool>>,
        pub point_lines: Vec<Option<PointLine>>,
        pub explosion_pct: JsNum,
        pub point_explosion_pct: Vec<Option<JsNum>>,
        pub secondary_axis: bool,
        pub val_fmt: String,
        pub from_stock: bool,
    }
}

/// `ChartAxisStyle`: `parseAxis` sets its keys in this order, `isDate`
/// last by a spread.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChartAxisStyle {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hidden: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min: Option<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max: Option<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reversed: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub log_base: Option<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub crosses: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tick_lbl_hidden: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tick_lbl_pos: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label_color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label_size_pt: Option<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label_bold: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label_caps: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label_spc_pt: Option<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tick_lbl_garbage: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label_rot_deg: Option<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub num_fmt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line_color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line_hidden: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub grid_color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub grid_color_auto: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub grid_dash: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub grid_dash_val: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub grid_width_emu: Option<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub minor_grid_color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub minor_grid_width_emu: Option<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub minor_grid_auto: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub major_unit: Option<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub minor_unit: Option<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tick_lbl_skip: Option<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tick_mark_skip: Option<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title_overlay: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title_size_pt: Option<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title_bold: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title_italic: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title_color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_date: Option<bool>,
}

impl ChartAxisStyle {
    /// `Object.keys(out).length === 0`
    pub(crate) fn is_empty(&self) -> bool {
        *self == Self::default()
    }
}

/// `ChartDataTable`
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChartDataTable {
    pub show_keys: bool,
    pub horz_border: bool,
    pub vert_border: bool,
    pub outline: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size_pt: Option<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text_color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line_color: Option<String>,
}

/// `ChartModel.legendLayout`, in the order of the spreads that write it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegendLayout {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub x: Option<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub x_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub y: Option<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub y_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub w: Option<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub h: Option<JsNum>,
}

/// `ChartModel.plotLayout`
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct PlotLayout {
    pub x: JsNum,
    pub y: JsNum,
    pub w: JsNum,
    pub h: JsNum,
}

/// `ChartModel.categoryGroups[]`
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CategoryGroup {
    pub label: String,
    pub start: JsNum,
}

/// `ChartModel.ofPie`
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OfPie {
    pub split_pos: JsNum,
    pub second_pie_size: JsNum,
    pub gap_width: JsNum,
}

/// `ChartModel.plotBorder` and `ChartModel.border`
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChartBorder {
    pub color: String,
    pub width_emu: JsNum,
}

/// `ChartModel.stock`
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChartStock {
    pub hi_low_lines: bool,
    pub up_down_bars: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gap_width_pct: Option<JsNum>,
}

/// `ChartModel.sunburst`. `pointColors` is sparse: see [`SparseColors`].
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sunburst {
    pub levels: Vec<Vec<String>>,
    pub sizes: Vec<Option<JsNum>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub point_colors: Option<SparseColors>,
}

/// A JavaScript array written by index (`a[i] = c`): its length is one past
/// the highest index written, and JSON writes `null` for each hole. Kept
/// as the entries written, so a far index costs nothing until it is written
/// out, as in JavaScript.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SparseColors {
    entries: std::collections::BTreeMap<u32, String>,
}

impl SparseColors {
    /// `a[index] = color` for an array index (0 to 2^32 - 2).
    pub(crate) fn set(&mut self, index: u32, color: String) {
        self.entries.insert(index, color);
    }

    /// `a.length`
    pub fn len(&self) -> u64 {
        self.entries
            .last_key_value()
            .map_or(0, |(&i, _)| u64::from(i) + 1)
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

impl Serialize for SparseColors {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::{Error, SerializeSeq};
        // V8's JSON.stringify throws once its text would pass 2^29 - 24 UTF-16
        // units, and every hole costs five (`null,`): past this length the
        // TypeScript's own serialization fails, so both sides refuse.
        const MAX_LEN: u64 = ((1 << 29) - 24) / 5;
        if self.len() > MAX_LEN {
            return Err(S::Error::custom("RangeError: Invalid string length"));
        }
        let mut seq = serializer.serialize_seq(None)?;
        let mut next: u64 = 0;
        for (&index, color) in &self.entries {
            while next < u64::from(index) {
                seq.serialize_element(&Option::<&str>::None)?;
                next += 1;
            }
            seq.serialize_element(color)?;
            next += 1;
        }
        seq.end()
    }
}

/// `ChartModel.userLines[]`
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserLine {
    pub x1: JsNum,
    pub y1: JsNum,
    pub x2: JsNum,
    pub y2: JsNum,
    pub color: String,
    pub width_emu: JsNum,
}

/// `ChartModel.bar3D`
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bar3D {
    pub rot_x: JsNum,
    pub rot_y: JsNum,
    pub depth_pct: JsNum,
    pub r_ang_ax: bool,
    pub gap_depth_pct: JsNum,
    pub ser_ax_labels: bool,
}

/// `ChartModel.area3D`
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Area3D {
    pub rot_x: JsNum,
    pub rot_y: JsNum,
    pub gap_depth_pct: JsNum,
    pub ser_ax_labels: bool,
}

js_object! {
    /// `ChartModel`. `grouping`, `legendPos` and `radarStyle` hold the
    /// document's text as the TypeScript casts it, unchecked.
    #[derive(Debug, Clone, PartialEq)]
    pub struct ChartModel {
        pub kind: ChartKind,
        pub bar_dir: String,
        pub grouping: String,
        pub gap_width_pct: JsNum,
        pub overlap_pct: JsNum,
        pub categories: Vec<String>,
        pub series: Vec<ChartSeries>,
        pub legend_pos: String,
        pub legend_pt: JsNum,
        pub legend_bold: bool,
        pub legend_color: String,
        pub legend_overlay: bool,
        pub legend_order: Vec<JsNum>,
        pub legend_layout: LegendLayout,
        pub legend_rtl: bool,
        pub has_style_part: bool,
        pub plot_layout: PlotLayout,
        pub val_axis: ChartAxisStyle,
        pub data_table: ChartDataTable,
        pub val_axis2: ChartAxisStyle,
        pub cat_axis: ChartAxisStyle,
        pub hole_pct: JsNum,
        pub first_slice_ang_deg: JsNum,
        pub scatter_style: String,
        pub radar_style: String,
        pub category_groups: Vec<CategoryGroup>,
        pub data_labels: bool,
        pub data_labels_pct: bool,
        pub data_labels_val_pct: bool,
        pub of_pie: OfPie,
        pub pct_base: JsNum,
        pub data_label_ser_name: bool,
        pub data_label_cat_name: bool,
        pub data_label_no_value: bool,
        pub data_label_fmt: String,
        pub data_label_pt: JsNum,
        pub data_label_bold: bool,
        pub data_label_rot_deg: JsNum,
        pub data_label_caps: bool,
        pub data_label_spc_pt: JsNum,
        pub title: String,
        pub title_pt: JsNum,
        pub title_overlay: bool,
        pub title_bold: bool,
        pub title_italic: bool,
        pub title_color: String,
        pub title_caps: bool,
        pub title_spc_pt: JsNum,
        pub bg_fill: Fill,
        pub plot_fill: Fill,
        pub plot_border: ChartBorder,
        pub border: ChartBorder,
        pub theme_palette: Vec<String>,
        pub vary_colors: bool,
        pub bubble_scale: JsNum,
        pub bubble_size_is_width: bool,
        pub stock: ChartStock,
        pub sunburst: Sunburst,
        pub user_lines: Vec<UserLine>,
        pub default_text_pt: JsNum,
        pub font_family: String,
        pub default_text_color: String,
        pub pseudo3_d: bool,
        pub rot_x_deg: JsNum,
        pub bar3_d: Bar3D,
        pub area3_d: Area3D,
    }
}

#[cfg(test)]
mod tests {
    use super::SparseColors;

    // Fixes 1 and 2 (fallible point and cx:lvl allocations) cannot be forced
    // to fail in a test; this covers fix 3 only.
    #[test]
    fn sparse_colors_past_v8_string_limit_is_an_error() {
        let mut colors = SparseColors::default();
        colors.set(0, "FF0000".to_owned());
        colors.set(107_374_177, "00FF00".to_owned());
        let err = serde_json::to_string(&colors).unwrap_err();
        assert_eq!(err.to_string(), "RangeError: Invalid string length");

        let mut colors = SparseColors::default();
        colors.set(2, "FF0000".to_owned());
        assert_eq!(
            serde_json::to_string(&colors).unwrap(),
            r#"[null,null,"FF0000"]"#
        );
    }
}
