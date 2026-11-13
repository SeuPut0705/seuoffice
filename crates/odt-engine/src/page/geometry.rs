//! `page/geometry.ts`: page geometry, an ODF page layout and the docx page
//! setup the editor shows.

use docx_engine::section::SectionSettings;
use jscompat::{JsNum, JsObject, Radix, math_round, parse_int};
use serde::{Deserialize, Serialize};

use crate::core::styles::{OdtPropertyBag, OdtStyle};
use crate::text::props::AttrOverrides;
use crate::text::units::{length_to_twips, to_fixed, twips_to_cm};

/// `LAYOUT_PROPS`
pub const LAYOUT_PROPS: &str = "style:page-layout-properties";
/// `LAYOUT_COLUMNS`
pub const LAYOUT_COLUMNS: &str = "style:page-layout-properties/style:columns";
/// `HEADER_PROPS`
pub const HEADER_PROPS: &str = "style:header-style/style:header-footer-properties";
/// `FOOTER_PROPS`
pub const FOOTER_PROPS: &str = "style:footer-style/style:header-footer-properties";

/// `twipsToLength`: twips as centimetres; a value the editor shows as a round
/// 0.1 mm is written round.
pub fn twips_to_length(value: f64) -> String {
    let round = math_round(((value * 2.54) / 1440.0) * 100.0) / 100.0;
    if math_round((round * 1440.0) / 2.54) == math_round(value) {
        return format!("{}cm", to_fixed(round, 3));
    }
    twips_to_cm(value)
}

const DEFAULT_WIDTH: f64 = 11906.0;
const DEFAULT_HEIGHT: f64 = 16838.0;
const DEFAULT_MARGIN: f64 = 1440.0;

/// `PageGeometry`: the docx-side page setup of a page layout, in twips.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageGeometry {
    pub width: JsNum,
    pub height: JsNum,
    pub landscape: bool,
    pub top: JsNum,
    pub bottom: JsNum,
    pub left: JsNum,
    pub right: JsNum,
    pub header: JsNum,
    pub footer: JsNum,
    pub columns: JsNum,
    pub column_gap: JsNum,
    pub num_format: Option<String>,
}

/// `Band`
#[derive(Debug, Clone, Copy)]
pub struct Band {
    pub present: bool,
    pub height: f64,
    pub spacing: f64,
    pub height_attr: &'static str,
}

/// `'header' | 'footer'`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BandKind {
    Header,
    Footer,
}

fn prop<'a>(layout: Option<&'a OdtPropertyBag>, path: &str) -> Option<&'a JsObject<String>> {
    layout.and_then(|bag| bag.get(path))
}

fn val<'a>(props: &'a JsObject<String>, key: &str) -> Option<&'a str> {
    props.get(key).map(String::as_str)
}

/// `band`
pub fn band(layout: Option<&OdtPropertyBag>, kind: BandKind) -> Band {
    let props = prop(
        layout,
        if kind == BandKind::Header {
            HEADER_PROPS
        } else {
            FOOTER_PROPS
        },
    );
    let Some(props) = props else {
        return Band {
            present: false,
            height: 0.0,
            spacing: 0.0,
            height_attr: "svg:height",
        };
    };
    let height_attr = val(props, "svg:height").is_none() && val(props, "fo:min-height").is_some();
    Band {
        present: true,
        height: length_to_twips(val(
            props,
            if height_attr {
                "fo:min-height"
            } else {
                "svg:height"
            },
        ))
        .unwrap_or(0.0),
        spacing: length_to_twips(val(
            props,
            if kind == BandKind::Header {
                "fo:margin-bottom"
            } else {
                "fo:margin-top"
            },
        ))
        .unwrap_or(0.0),
        height_attr: if height_attr {
            "fo:min-height"
        } else {
            "svg:height"
        },
    }
}

/// `margin`: a page margin (individual attribute, else the `fo:margin` shorthand).
fn margin(props: Option<&JsObject<String>>, side: &str) -> Option<f64> {
    let get = |key: &str| props.and_then(|p| val(p, key));
    length_to_twips(get(&format!("fo:margin-{side}"))).or_else(|| length_to_twips(get("fo:margin")))
}

/// `layoutGeometry` over the property bags of the layout.
pub fn layout_geometry_of(layout: Option<&OdtPropertyBag>) -> PageGeometry {
    let p = prop(layout, LAYOUT_PROPS);
    let cols = prop(layout, LAYOUT_COLUMNS);
    let top = margin(p, "top").unwrap_or(DEFAULT_MARGIN);
    let bottom = margin(p, "bottom").unwrap_or(DEFAULT_MARGIN);
    let h = band(layout, BandKind::Header);
    let f = band(layout, BandKind::Footer);
    let get = |key: &str| p.and_then(|p| val(p, key));
    let columns = columns_of(cols);
    PageGeometry {
        width: JsNum(math_round(
            length_to_twips(get("fo:page-width")).unwrap_or(DEFAULT_WIDTH),
        )),
        height: JsNum(math_round(
            length_to_twips(get("fo:page-height")).unwrap_or(DEFAULT_HEIGHT),
        )),
        landscape: get("style:print-orientation") == Some("landscape"),
        top: JsNum(math_round(top + h.height + h.spacing)),
        bottom: JsNum(math_round(bottom + f.height + f.spacing)),
        left: JsNum(math_round(margin(p, "left").unwrap_or(DEFAULT_MARGIN))),
        right: JsNum(math_round(margin(p, "right").unwrap_or(DEFAULT_MARGIN))),
        header: JsNum(math_round(top)),
        footer: JsNum(math_round(bottom)),
        columns: columns.count,
        column_gap: columns.gap,
        num_format: get("style:num-format").map(str::to_owned),
    }
}

/// `layoutGeometry`
pub fn layout_geometry(layout: Option<&OdtStyle>) -> PageGeometry {
    layout_geometry_of(layout.map(|style| &style.properties))
}

/// The result of `columnsOf`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct Columns {
    pub count: JsNum,
    pub gap: JsNum,
}

/// `columnsOf`: column count and gap (twips) of a `style:columns` attribute bag.
pub fn columns_of(cols: Option<&JsObject<String>>) -> Columns {
    let get = |key: &str| cols.and_then(|c| val(c, key));
    let parsed = parse_int(get("fo:column-count").unwrap_or("1"), Radix::Ten);
    // `parseInt(...) || 1`
    let parsed = if parsed.is_nan() || parsed == 0.0 {
        1.0
    } else {
        parsed
    };
    Columns {
        count: JsNum(jscompat::math_max(1.0, parsed)),
        gap: JsNum(math_round(
            length_to_twips(get("fo:column-gap")).unwrap_or(0.0),
        )),
    }
}

/// `LayoutOverrides`: attribute overrides for one page layout.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct LayoutOverrides {
    pub page: AttrOverrides,
    pub header: AttrOverrides,
    pub footer: AttrOverrides,
}

/// `isEmptyOverrides`
pub fn is_empty_overrides(o: &LayoutOverrides) -> bool {
    o.page.is_empty() && o.header.is_empty() && o.footer.is_empty()
}

/// The fields of `SectionSettings` the geometry reads (twips).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Measures {
    pub page_width: f64,
    pub page_height: f64,
    pub orientation: String,
    pub margin_top: f64,
    pub margin_right: f64,
    pub margin_bottom: f64,
    pub margin_left: f64,
    #[serde(default)]
    pub header_dist: Option<f64>,
    #[serde(default)]
    pub footer_dist: Option<f64>,
}

impl From<&SectionSettings> for Measures {
    fn from(s: &SectionSettings) -> Self {
        Measures {
            page_width: s.page_width.0,
            page_height: s.page_height.0,
            orientation: s.orientation.to_owned(),
            margin_top: s.margin_top.0,
            margin_right: s.margin_right.0,
            margin_bottom: s.margin_bottom.0,
            margin_left: s.margin_left.0,
            header_dist: s.header_dist.map(|n| n.0),
            footer_dist: s.footer_dist.map(|n| n.0),
        }
    }
}

fn set(target: &mut AttrOverrides, key: &str, value: String) {
    target.set(key, Some(value));
}

/// `layoutOverrides`: the ODF attributes to change so the layout shows `after`
/// where the bridge showed `before`.
pub fn layout_overrides_of(
    layout: Option<&OdtPropertyBag>,
    before: &Measures,
    after: &Measures,
) -> LayoutOverrides {
    let mut out = LayoutOverrides::default();
    let p = prop(layout, LAYOUT_PROPS);
    if after.page_width != before.page_width {
        set(
            &mut out.page,
            "fo:page-width",
            twips_to_length(after.page_width),
        );
    }
    if after.page_height != before.page_height {
        set(
            &mut out.page,
            "fo:page-height",
            twips_to_length(after.page_height),
        );
    }
    if after.orientation != before.orientation {
        set(
            &mut out.page,
            "style:print-orientation",
            after.orientation.clone(),
        );
    }
    if after.margin_left != before.margin_left {
        set(
            &mut out.page,
            "fo:margin-left",
            twips_to_length(after.margin_left),
        );
    }
    if after.margin_right != before.margin_right {
        set(
            &mut out.page,
            "fo:margin-right",
            twips_to_length(after.margin_right),
        );
    }
    for kind in [BandKind::Header, BandKind::Footer] {
        let header = kind == BandKind::Header;
        let side = if header { "top" } else { "bottom" };
        let (a_edge, b_edge) = if header {
            (after.margin_top, before.margin_top)
        } else {
            (after.margin_bottom, before.margin_bottom)
        };
        let (a_dist, b_dist) = if header {
            (after.header_dist, before.header_dist)
        } else {
            (after.footer_dist, before.footer_dist)
        };
        if a_edge == b_edge && a_dist == b_dist {
            continue;
        }
        let b = band(layout, kind);
        let old_margin = margin(p, side).unwrap_or(DEFAULT_MARGIN);
        let body = a_edge;
        let new_margin;
        let mut new_height = 0.0;
        if b.present {
            let distance = a_dist.or(b_dist).unwrap_or(old_margin);
            new_margin = jscompat::math_max(0.0, jscompat::math_min(distance, body - b.spacing));
            new_height = jscompat::math_max(0.0, body - b.spacing - new_margin);
        } else {
            new_margin = jscompat::math_max(0.0, body);
        }
        if (new_margin - old_margin).abs() >= 0.5 {
            set(
                &mut out.page,
                &format!("fo:margin-{side}"),
                twips_to_length(new_margin),
            );
        }
        if b.present && (new_height - b.height).abs() >= 0.5 {
            let target = if header {
                &mut out.header
            } else {
                &mut out.footer
            };
            set(target, b.height_attr, twips_to_length(new_height));
        }
    }
    out
}

/// `layoutOverrides`
pub fn layout_overrides(
    layout: Option<&OdtStyle>,
    before: &SectionSettings,
    after: &SectionSettings,
) -> LayoutOverrides {
    layout_overrides_of(
        layout.map(|s| &s.properties),
        &Measures::from(before),
        &Measures::from(after),
    )
}

/// The result of `odfLengths`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OdfLengths {
    pub top: JsNum,
    pub bottom: JsNum,
    pub header_height: JsNum,
    pub footer_height: JsNum,
}

/// `odfLengths` over the property bags of the layout.
pub fn odf_lengths_of(layout: Option<&OdtPropertyBag>, settings: &Measures) -> OdfLengths {
    let split = |kind: BandKind| {
        let b = band(layout, kind);
        let header = kind == BandKind::Header;
        let body = if header {
            settings.margin_top
        } else {
            settings.margin_bottom
        };
        let dist = (if header {
            settings.header_dist
        } else {
            settings.footer_dist
        })
        .unwrap_or(body);
        if !b.present {
            return (body, 0.0);
        }
        let m = jscompat::math_max(0.0, jscompat::math_min(dist, body - b.spacing));
        (m, jscompat::math_max(0.0, body - b.spacing - m))
    };
    let h = split(BandKind::Header);
    let f = split(BandKind::Footer);
    OdfLengths {
        top: JsNum(h.0),
        bottom: JsNum(f.0),
        header_height: JsNum(h.1),
        footer_height: JsNum(f.1),
    }
}

/// `odfLengths`
pub fn odf_lengths(layout: Option<&OdtStyle>, settings: &SectionSettings) -> OdfLengths {
    odf_lengths_of(layout.map(|s| &s.properties), &Measures::from(settings))
}
