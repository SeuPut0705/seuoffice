//! Table style resolution (packages/pptx-engine/src/table-style.ts): the
//! `a:tableStyleId` of a table's `a:tblPr` as the fill and text style of each
//! table region, from `<a:tblStyle>` of ppt/tableStyles.xml or from the 74
//! built-in PowerPoint styles, and each cell's part style and borders from the
//! table's flags and the cell's position.

use std::sync::LazyLock;

use crate::xml_utils::xml_parse_object as parse_object;
use jscompat::{
    JsNum, Radix, Slot, js_object, js_regex, math_round, number_to_string, number_truthy,
    pad_start, parse_int, slice_utf16, to_number, to_string_radix16, trim, truthy, value_to_string,
    value_truthy,
};
use ooxml_xml::ObjectOptions;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::color::apply_color_mods;
use crate::theme::{Theme, resolve_scheme_color};
use crate::types::{Fill, Stroke};
use crate::xml_utils::{as_xml_node, xml_array};

/// `{ key: value, ... }` of a `js_object!` type: the keys set in the order
/// the TypeScript literal writes them.
macro_rules! object {
    ($ty:ident { $($key:ident: $value:expr),* $(,)? }) => {{
        let mut out = $ty::default();
        $(out.$key.set($value);)*
        out
    }};
}

js_object! {
    deserialize;
    /// `TablePartStyle`: the style of one table region (whole table, a band,
    /// the first row...). Its keys follow the path taken: each built-in
    /// literal writes them in its own order and `cellPartStyle` merges.
    #[derive(Debug, Clone, PartialEq)]
    pub struct TablePartStyle {
        pub fill: Fill,
        pub bold: bool,
        pub text_color: String,
        /// `'minor' | 'major'`: the theme font scheme of the cell text.
        pub font_ref: String,
        pub font: TableFont,
    }
}

js_object! {
    deserialize;
    /// `font` of a `TablePartStyle`: `{ latin?, ea?, cs? }`, the typefaces
    /// of `<a:tcTxStyle><a:font>`.
    #[derive(Debug, Clone, PartialEq)]
    pub struct TableFont {
        pub latin: String,
        pub ea: String,
        pub cs: String,
    }
}

js_object! {
    deserialize;
    /// `TableStyleDef`
    #[derive(Debug, Clone, PartialEq)]
    pub struct TableStyleDef {
        pub whole_tbl: TablePartStyle,
        pub band1_h: TablePartStyle,
        pub band2_h: TablePartStyle,
        pub band1_v: TablePartStyle,
        pub band2_v: TablePartStyle,
        pub first_row: TablePartStyle,
        pub last_row: TablePartStyle,
        pub first_col: TablePartStyle,
        pub last_col: TablePartStyle,
        /// Inner separator lines between cells.
        pub inside_h: Stroke,
        pub inside_v: Stroke,
        /// Four sides of the whole-table outer border.
        pub outer: TableOuter,
        /// First-row bottom edge and last-row top edge, used when the
        /// `firstRow`/`lastRow` flags are on.
        pub first_row_bottom: Stroke,
        pub last_row_top: Stroke,
        /// `<a:tblBg>` direct fill.
        pub tbl_bg: Fill,
        /// `<a:tblBg><a:fillRef>`: a theme fill style reference.
        pub tbl_bg_ref: TblBgRef,
    }
}

/// `outer` of a `TableStyleDef`. Every literal writes the sides in this order.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct TableOuter {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub l: Option<Stroke>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub r: Option<Stroke>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub t: Option<Stroke>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub b: Option<Stroke>,
}

/// `tblBgRef` of a `TableStyleDef`: `{ idx, phClr? }`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TblBgRef {
    pub idx: JsNum,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ph_clr: Option<String>,
}

/// `TableStyleFlags`: the region toggles of `a:tblPr`. A flag the caller
/// leaves out reads as off, as an `undefined` one does in the TypeScript.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct TableStyleFlags {
    pub first_row: bool,
    pub last_row: bool,
    pub first_col: bool,
    pub last_col: bool,
    pub band_row: bool,
    pub band_col: bool,
}

/// `BuiltinFamily`
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum BuiltinFamily {
    Themed1,
    Themed2,
    Light1,
    Light2,
    Light3,
    Medium1,
    Medium2,
    Medium3,
    Medium4,
    Dark1,
    Dark2,
}

use BuiltinFamily as F;

/// `BUILTIN`: the 74 built-in style GUIDs with their family and accent, in
/// the order of the TypeScript literal (GUID table from Microsoft's docs
/// hh273476). themed1 without accent is No Style, No Grid; themed2 without
/// accent is No Style, Table Grid.
static BUILTIN: [(&str, BuiltinFamily, Option<&str>); 74] = [
    ("{2D5ABB26-0587-4C30-8999-92F81FD0307C}", F::Themed1, None),
    (
        "{3C2FFA5D-87B4-456A-9821-1D502468CF0F}",
        F::Themed1,
        Some("accent1"),
    ),
    (
        "{284E427A-3D55-4303-BF80-6455036E1DE7}",
        F::Themed1,
        Some("accent2"),
    ),
    (
        "{69C7853C-536D-4A76-A0AE-DD22124D55A5}",
        F::Themed1,
        Some("accent3"),
    ),
    (
        "{775DCB02-9BB8-47FD-8907-85C794F793BA}",
        F::Themed1,
        Some("accent4"),
    ),
    (
        "{35758FB7-9AC5-4552-8A53-C91805E547FA}",
        F::Themed1,
        Some("accent5"),
    ),
    (
        "{08FB837D-C827-4EFA-A057-4D05807E0F7C}",
        F::Themed1,
        Some("accent6"),
    ),
    ("{5940675A-B579-460E-94D1-54222C63F5DA}", F::Themed2, None),
    (
        "{D113A9D2-9D6B-4929-AA2D-F23B5EE8CBE7}",
        F::Themed2,
        Some("accent1"),
    ),
    (
        "{18603FDC-E32A-4AB5-989C-0864C3EAD2B8}",
        F::Themed2,
        Some("accent2"),
    ),
    (
        "{306799F8-075E-4A3A-A7F6-7FBC6576F1A4}",
        F::Themed2,
        Some("accent3"),
    ),
    (
        "{E269D01E-BC32-4049-B463-5C60D7B0CCD2}",
        F::Themed2,
        Some("accent4"),
    ),
    (
        "{327F97BB-C833-4FB7-BDE5-3F7075034690}",
        F::Themed2,
        Some("accent5"),
    ),
    (
        "{638B1855-1B75-4FBE-930C-398BA8C253C6}",
        F::Themed2,
        Some("accent6"),
    ),
    ("{9D7B26C5-4107-4FEC-AEDC-1716B250A1EF}", F::Light1, None),
    (
        "{3B4B98B0-60AC-42C2-AFA5-B58CD77FA1E5}",
        F::Light1,
        Some("accent1"),
    ),
    (
        "{0E3FDE45-AF77-4B5C-9715-49D594BDF05E}",
        F::Light1,
        Some("accent2"),
    ),
    (
        "{C083E6E3-FA7D-4D7B-A595-EF9225AFEA82}",
        F::Light1,
        Some("accent3"),
    ),
    (
        "{D27102A9-8310-4765-A935-A1911B00CA55}",
        F::Light1,
        Some("accent4"),
    ),
    (
        "{5FD0F851-EC5A-4D38-B0AD-8093EC10F338}",
        F::Light1,
        Some("accent5"),
    ),
    (
        "{68D230F3-CF80-4859-8CE7-A43EE81993B5}",
        F::Light1,
        Some("accent6"),
    ),
    ("{7E9639D4-E3E2-4D34-9284-5A2195B3D0D7}", F::Light2, None),
    (
        "{69012ECD-51FC-41F1-AA8D-1B2483CD663E}",
        F::Light2,
        Some("accent1"),
    ),
    (
        "{72833802-FEF1-4C79-8D5D-14CF1EAF98D9}",
        F::Light2,
        Some("accent2"),
    ),
    (
        "{F2DE63D5-997A-4646-A377-4702673A728D}",
        F::Light2,
        Some("accent3"),
    ),
    (
        "{17292A2E-F333-43FB-9621-5CBBE7FDCDCB}",
        F::Light2,
        Some("accent4"),
    ),
    (
        "{5A111915-BE36-4E01-A7E5-04B1672EAD32}",
        F::Light2,
        Some("accent5"),
    ),
    (
        "{912C8C85-51F0-491E-9774-3900AFEF0FD7}",
        F::Light2,
        Some("accent6"),
    ),
    ("{616DA210-FB5B-4158-B5E0-FEB733F419BA}", F::Light3, None),
    (
        "{BC89EF96-8CEA-46FF-86C4-4CE0E7609802}",
        F::Light3,
        Some("accent1"),
    ),
    (
        "{5DA37D80-6434-44D0-A028-1B22A696006F}",
        F::Light3,
        Some("accent2"),
    ),
    (
        "{8799B23B-EC83-4686-B30A-512413B5E67A}",
        F::Light3,
        Some("accent3"),
    ),
    (
        "{ED083AE6-46FA-4A59-8FB0-9F97EB10719F}",
        F::Light3,
        Some("accent4"),
    ),
    (
        "{BDBED569-4797-4DF1-A0F4-6AAB3CD982D8}",
        F::Light3,
        Some("accent5"),
    ),
    (
        "{E8B1032C-EA38-4F05-BA0D-38AFFFC7BED3}",
        F::Light3,
        Some("accent6"),
    ),
    ("{793D81CF-94F2-401A-BA57-92F5A7B2D0C5}", F::Medium1, None),
    (
        "{B301B821-A1FF-4177-AEE7-76D212191A09}",
        F::Medium1,
        Some("accent1"),
    ),
    (
        "{9DCAF9ED-07DC-4A11-8D7F-57B35C25682E}",
        F::Medium1,
        Some("accent2"),
    ),
    (
        "{1FECB4D8-DB02-4DC6-A0A2-4F2EBAE1DC90}",
        F::Medium1,
        Some("accent3"),
    ),
    (
        "{1E171933-4619-4E11-9A3F-F7608DF75F80}",
        F::Medium1,
        Some("accent4"),
    ),
    (
        "{FABFCF23-3B69-468F-B69F-88F6DE6A72F2}",
        F::Medium1,
        Some("accent5"),
    ),
    (
        "{10A1B5D5-9B99-4C35-A422-299274C87663}",
        F::Medium1,
        Some("accent6"),
    ),
    ("{073A0DAA-6AF3-43AB-8588-CEC1D06C72B9}", F::Medium2, None),
    (
        "{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}",
        F::Medium2,
        Some("accent1"),
    ),
    (
        "{21E4AEA4-8DFA-4A89-87EB-49C32662AFE0}",
        F::Medium2,
        Some("accent2"),
    ),
    (
        "{F5AB1C69-6EDB-4FF4-983F-18BD219EF322}",
        F::Medium2,
        Some("accent3"),
    ),
    (
        "{00A15C55-8517-42AA-B614-E9B94910E393}",
        F::Medium2,
        Some("accent4"),
    ),
    (
        "{7DF18680-E054-41AD-8BC1-D1AEF772440D}",
        F::Medium2,
        Some("accent5"),
    ),
    (
        "{93296810-A885-4BE3-A3E7-6D5BEEA58F35}",
        F::Medium2,
        Some("accent6"),
    ),
    ("{8EC20E35-A176-4012-BC5E-935CFFF8708E}", F::Medium3, None),
    (
        "{6E25E649-3F16-4E02-A733-19D2CDBF48F0}",
        F::Medium3,
        Some("accent1"),
    ),
    (
        "{85BE263C-DBD7-4A20-BB59-AAB30ACAA65A}",
        F::Medium3,
        Some("accent2"),
    ),
    (
        "{EB344D84-9AFB-497E-A393-DC336BA19D2E}",
        F::Medium3,
        Some("accent3"),
    ),
    (
        "{EB9631B5-78F2-41C9-869B-9F39066F8104}",
        F::Medium3,
        Some("accent4"),
    ),
    (
        "{74C1A8A3-306A-4EB7-A6B1-4F7E0EB9C5D6}",
        F::Medium3,
        Some("accent5"),
    ),
    (
        "{2A488322-F2BA-4B5B-9748-0D474271808F}",
        F::Medium3,
        Some("accent6"),
    ),
    ("{D7AC3CCA-C797-4891-BE02-D94E43425B78}", F::Medium4, None),
    (
        "{69CF1AB2-1976-4502-BF36-3FF5EA218861}",
        F::Medium4,
        Some("accent1"),
    ),
    (
        "{8A107856-5554-42FB-B03E-39F5DBC370BA}",
        F::Medium4,
        Some("accent2"),
    ),
    (
        "{0505E3EF-67EA-436B-97B2-0124C06EBD24}",
        F::Medium4,
        Some("accent3"),
    ),
    (
        "{C4B1156A-380E-4F78-BDF5-A606A8083BF9}",
        F::Medium4,
        Some("accent4"),
    ),
    (
        "{22838BEF-8BB2-4498-84A7-C5851F593DF1}",
        F::Medium4,
        Some("accent5"),
    ),
    (
        "{16D9F66E-5EB9-4882-86FB-DCBF35E3C3E4}",
        F::Medium4,
        Some("accent6"),
    ),
    ("{E8034E78-7F5D-4C2E-B375-FC64B27BC917}", F::Dark1, None),
    (
        "{125E5076-3810-47DD-B79F-674D7AD40C01}",
        F::Dark1,
        Some("accent1"),
    ),
    (
        "{37CE84F3-28C3-443E-9E96-99CF82512B78}",
        F::Dark1,
        Some("accent2"),
    ),
    (
        "{D03447BB-5D67-496B-8E87-E561075AD55C}",
        F::Dark1,
        Some("accent3"),
    ),
    (
        "{E929F9F4-4A8F-4326-A1B4-22849713DDAB}",
        F::Dark1,
        Some("accent4"),
    ),
    (
        "{8FD4443E-F989-4FC4-A0C8-D5A2AF1F390B}",
        F::Dark1,
        Some("accent5"),
    ),
    (
        "{AF606853-7671-496A-8E4F-DF71F8EC918B}",
        F::Dark1,
        Some("accent6"),
    ),
    ("{5202B0CA-FC54-4496-8BCA-5EF66A818D29}", F::Dark2, None),
    (
        "{0660B408-B3CF-4A94-85FC-2B1E0A45F4A2}",
        F::Dark2,
        Some("accent1"),
    ),
    (
        "{91EBBBCC-DAD2-459C-BE2E-F6DE35CF9A28}",
        F::Dark2,
        Some("accent3"),
    ),
    (
        "{46F890A9-2807-4EBB-B81D-B2AA78EC7F39}",
        F::Dark2,
        Some("accent5"),
    ),
];

/// `BUILTIN[styleId]` for the table's own keys only: the TypeScript also
/// answers `constructor`, `toString`, `__proto__`... from the prototype.
fn builtin(style_id: &str) -> Option<&'static (&'static str, BuiltinFamily, Option<&'static str>)> {
    BUILTIN.iter().find(|(id, ..)| *id == style_id)
}

/// `FAMILY_LABEL[family]`
fn family_label(family: BuiltinFamily) -> &'static str {
    match family {
        F::Themed1 => "Themed Style 1",
        F::Themed2 => "Themed Style 2",
        F::Light1 => "Light Style 1",
        F::Light2 => "Light Style 2",
        F::Light3 => "Light Style 3",
        F::Medium1 => "Medium Style 1",
        F::Medium2 => "Medium Style 2",
        F::Medium3 => "Medium Style 3",
        F::Medium4 => "Medium Style 4",
        F::Dark1 => "Dark Style 1",
        F::Dark2 => "Dark Style 2",
    }
}

/// `BuiltinTableStyle`
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct BuiltinTableStyle {
    pub id: &'static str,
    /// Gallery name as PowerPoint shows it ("Medium Style 2 - Accent 1").
    pub name: String,
    pub family: BuiltinFamily,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub accent: Option<&'static str>,
}

/// `'accent'.length`
const ACCENT_PREFIX_UNITS: f64 = 6.0;

/// `builtinName`
fn builtin_name(family: BuiltinFamily, accent: Option<&str>) -> String {
    let Some(accent) = truthy(accent) else {
        if family == F::Themed1 {
            return "No Style, No Grid".to_owned();
        }
        if family == F::Themed2 {
            return "No Style, Table Grid".to_owned();
        }
        return family_label(family).to_owned();
    };
    let n = slice_utf16(accent, ACCENT_PREFIX_UNITS, None);
    // Dark Style 2 pairs two accents per definition (official gallery labels)
    if family == F::Dark2 {
        return format!(
            "{} - Accent {n}/Accent {}",
            family_label(family),
            number_to_string(to_number(&n) + 1.0)
        );
    }
    format!("{} - Accent {n}", family_label(family))
}

/// `BUILTIN_TABLE_STYLES`: the 74 built-in table styles, gallery order.
pub static BUILTIN_TABLE_STYLES: LazyLock<Vec<BuiltinTableStyle>> = LazyLock::new(|| {
    BUILTIN
        .iter()
        .map(|&(id, family, accent)| BuiltinTableStyle {
            id,
            name: builtin_name(family, accent),
            family,
            accent: truthy(accent),
        })
        .collect()
});

/// `builtinTableStyleName`: the gallery name of a built-in style id, `None`
/// for a custom or unknown id. ledger inherited-key-table-style-206: the
/// TypeScript's `BUILTIN[styleId]` reads `constructor` and the like through
/// the prototype, then finds no `family` there, so it answers `undefined`
/// as well.
pub fn builtin_table_style_name(style_id: Option<&str>) -> Option<String> {
    let style_id = truthy(style_id)?;
    let &(_, family, accent) = builtin(style_id)?;
    Some(builtin_name(family, accent))
}

/// `resolveBuiltinTableStyleId`: the GUID of a built-in style given its GUID
/// or gallery name, case-insensitive; "Dark Style 2 - Accent 2" resolves to
/// the Accent 1/Accent 2 definition.
pub fn resolve_builtin_table_style_id(name_or_id: &str) -> Option<&'static str> {
    let key = trim(name_or_id);
    if js_regex!(r"^\{[0-9A-Fa-f-]{36}\}$").test(key) {
        let upper = key.to_uppercase();
        return builtin(&upper).map(|&(id, ..)| id);
    }
    let norm = js_regex!(r"\s+", "g").replace_all(&key.to_lowercase(), |_| " ".to_owned());
    for s in BUILTIN_TABLE_STYLES.iter() {
        if s.name.to_lowercase() == norm {
            return Some(s.id);
        }
        if s.family == F::Dark2
            && let Some(accent) = truthy(s.accent)
        {
            let n = to_number(&slice_utf16(accent, ACCENT_PREFIX_UNITS, None));
            for alt in [n, n + 1.0] {
                if norm == format!("dark style 2 - accent {}", number_to_string(alt)) {
                    return Some(s.id);
                }
            }
        }
    }
    None
}

/// `LEGACY_NO_STYLE`: the made-up "no style" GUID this app used to write
/// (not in the official table).
pub const LEGACY_NO_STYLE: &str = "{2D5ABB26-0587-4C30-8999-92F81FD0307D}";

/// `tint`: keep `pct` of the colour and blend the rest toward white.
fn tint(hex: &str, pct: f64) -> String {
    mix_toward(hex, pct, 255.0)
}

/// `shade`: keep `pct` of the colour and blend the rest toward black.
fn shade(hex: &str, pct: f64) -> String {
    mix_toward(hex, pct, 0.0)
}

/// `c.toString(16).toUpperCase().padStart(2, '0')`
fn hex_pair(c: f64) -> String {
    pad_start(&to_string_radix16(c).to_uppercase(), 2, '0')
}

/// `parseInt(s.slice(i, i + 2), 16)`
fn channel(s: &str, i: f64) -> f64 {
    parse_int(&slice_utf16(s, i, Some(i + 2.0)), Radix::Sixteen)
}

fn mix_toward(hex: &str, pct: f64, target: f64) -> String {
    let h = hex.replacen('#', "", 1);
    let mix = |c: f64| math_round(target * (1.0 - pct) + c * pct);
    format!(
        "#{}{}{}",
        hex_pair(mix(channel(&h, 0.0))),
        hex_pair(mix(channel(&h, 2.0))),
        hex_pair(mix(channel(&h, 4.0)))
    )
}

/// `over`: the solid colour of `fg` composited over `bg` at `alpha` opacity.
fn over(fg: &str, alpha: f64, bg: &str) -> String {
    let f = fg.replacen('#', "", 1);
    let b = bg.replacen('#', "", 1);
    let mix = |i: f64| math_round(channel(&f, i) * alpha + channel(&b, i) * (1.0 - alpha));
    format!(
        "#{}{}{}",
        hex_pair(mix(0.0)),
        hex_pair(mix(2.0)),
        hex_pair(mix(4.0))
    )
}

fn solid(color: &str) -> Fill {
    Fill::Solid {
        color: color.to_owned(),
    }
}

/// `line(color, width)`
fn line_w(color: &str, width: f64) -> Stroke {
    Stroke {
        fill: solid(color),
        width: JsNum(width),
        dash: None,
        cap: None,
        join: None,
        compound: None,
        head_end: None,
        tail_end: None,
    }
}

/// `line(color)`, the default width.
fn line(color: &str) -> Stroke {
    line_w(color, 12700.0)
}

/// `{ l: s, r: s, t: s, b: s }`
fn all_sides(stroke: &Stroke) -> TableOuter {
    TableOuter {
        l: Some(stroke.clone()),
        r: Some(stroke.clone()),
        t: Some(stroke.clone()),
        b: Some(stroke.clone()),
    }
}

/// `{ t: s, b: s }`
fn top_bottom(stroke: &Stroke) -> TableOuter {
    TableOuter {
        t: Some(stroke.clone()),
        b: Some(stroke.clone()),
        ..TableOuter::default()
    }
}

/// `headerPair[accentName]` of the dark2 family, own keys only.
fn header_pair(accent_name: &str) -> Option<&'static str> {
    match accent_name {
        "accent1" => Some("accent2"),
        "accent3" => Some("accent4"),
        "accent5" => Some("accent6"),
        _ => None,
    }
}

/// `builtinStyle`: the region styles of a built-in family, colours resolved
/// through the theme, banded alpha pre-blended against the background.
fn builtin_style(
    family: BuiltinFamily,
    accent_name: Option<&str>,
    theme: Option<&Theme>,
) -> TableStyleDef {
    let lt1 = resolve_scheme_color("lt1", theme, None).unwrap_or("#FFFFFF");
    let dk1 = resolve_scheme_color("dk1", theme, None).unwrap_or("#000000");
    let accent = truthy(accent_name)
        .map(|name| resolve_scheme_color(name, theme, None).unwrap_or("#4472C4"));

    match family {
        F::Themed1 => {
            let Some(accent) = truthy(accent) else {
                // No Style, No Grid
                return object!(TableStyleDef {
                    whole_tbl: object!(TablePartStyle {
                        text_color: dk1.to_owned()
                    }),
                });
            };
            let band = solid(&over(accent, 0.4, lt1));
            object!(TableStyleDef {
                whole_tbl: object!(TablePartStyle {
                    text_color: dk1.to_owned()
                }),
                first_row: object!(TablePartStyle {
                    fill: solid(accent),
                    text_color: lt1.to_owned(),
                }),
                band1_h: object!(TablePartStyle { fill: band.clone() }),
                band1_v: object!(TablePartStyle { fill: band }),
                inside_h: line(accent),
                inside_v: line(accent),
                outer: all_sides(&line(accent)),
                first_row_bottom: line(lt1),
            })
        }
        F::Themed2 => {
            let Some(accent) = truthy(accent) else {
                // No Style, Table Grid: all-dk1 grid
                return object!(TableStyleDef {
                    whole_tbl: object!(TablePartStyle {
                        text_color: dk1.to_owned()
                    }),
                    inside_h: line(dk1),
                    inside_v: line(dk1),
                    outer: all_sides(&line(dk1)),
                });
            };
            let outer = line(&tint(accent, 0.5));
            let band = solid(&over(lt1, 0.2, accent));
            object!(TableStyleDef {
                whole_tbl: object!(TablePartStyle {
                    fill: solid(accent),
                    text_color: lt1.to_owned(),
                }),
                band1_h: object!(TablePartStyle { fill: band.clone() }),
                band1_v: object!(TablePartStyle { fill: band }),
                outer: all_sides(&outer),
                first_row_bottom: line(lt1),
                last_row_top: line(lt1),
            })
        }
        F::Light1 => {
            let a = accent.unwrap_or(dk1);
            let band = solid(&over(a, 0.2, lt1));
            object!(TableStyleDef {
                whole_tbl: object!(TablePartStyle {
                    text_color: dk1.to_owned()
                }),
                first_row: object!(TablePartStyle {
                    bold: true,
                    text_color: dk1.to_owned(),
                }),
                first_col: object!(TablePartStyle { bold: true }),
                last_col: object!(TablePartStyle {
                    bold: true,
                    text_color: dk1.to_owned(),
                }),
                band1_h: object!(TablePartStyle { fill: band.clone() }),
                band1_v: object!(TablePartStyle { fill: band }),
                outer: top_bottom(&line(a)),
                first_row_bottom: line(a),
                last_row_top: line(a),
            })
        }
        F::Light2 => {
            let a = accent.unwrap_or(dk1);
            object!(TableStyleDef {
                whole_tbl: object!(TablePartStyle {
                    text_color: dk1.to_owned()
                }),
                first_row: object!(TablePartStyle {
                    fill: solid(a),
                    text_color: lt1.to_owned(),
                    bold: true,
                }),
                outer: all_sides(&line(a)),
                last_row_top: line(a),
            })
        }
        F::Light3 => {
            let a = accent.unwrap_or(dk1);
            let band = solid(&over(a, 0.2, lt1));
            object!(TableStyleDef {
                whole_tbl: object!(TablePartStyle {
                    text_color: dk1.to_owned()
                }),
                first_row: object!(TablePartStyle {
                    text_color: a.to_owned(),
                    bold: true,
                }),
                band1_h: object!(TablePartStyle { fill: band.clone() }),
                band1_v: object!(TablePartStyle { fill: band }),
                inside_h: line(a),
                inside_v: line(a),
                outer: all_sides(&line(a)),
                first_row_bottom: line(a),
                last_row_top: line(a),
            })
        }
        F::Medium1 => {
            let a = accent.unwrap_or(dk1);
            let band = solid(&tint(a, 0.2));
            object!(TableStyleDef {
                whole_tbl: object!(TablePartStyle {
                    fill: solid(lt1),
                    text_color: dk1.to_owned(),
                }),
                first_row: object!(TablePartStyle {
                    fill: solid(a),
                    text_color: lt1.to_owned(),
                    bold: true,
                }),
                last_row: object!(TablePartStyle {
                    fill: solid(lt1),
                    bold: true,
                }),
                band1_h: object!(TablePartStyle { fill: band.clone() }),
                band1_v: object!(TablePartStyle { fill: band }),
                inside_h: line(a),
                outer: all_sides(&line(a)),
                last_row_top: line(a),
            })
        }
        F::Medium2 => {
            let a = accent.unwrap_or(dk1);
            let header = || {
                object!(TablePartStyle {
                    fill: solid(a),
                    text_color: lt1.to_owned(),
                    bold: true,
                })
            };
            object!(TableStyleDef {
                whole_tbl: object!(TablePartStyle {
                    fill: solid(&tint(a, 0.2)),
                    text_color: dk1.to_owned(),
                }),
                band1_h: object!(TablePartStyle {
                    fill: solid(&tint(a, 0.4))
                }),
                band1_v: object!(TablePartStyle {
                    fill: solid(&tint(a, 0.4))
                }),
                first_row: header(),
                last_row: header(),
                first_col: header(),
                last_col: header(),
                inside_h: line(lt1),
                inside_v: line(lt1),
                outer: all_sides(&line(lt1)),
                first_row_bottom: line(lt1),
                last_row_top: line(lt1),
            })
        }
        F::Medium3 => {
            let a = accent.unwrap_or(dk1);
            let band = solid(&tint(dk1, 0.2));
            object!(TableStyleDef {
                whole_tbl: object!(TablePartStyle {
                    fill: solid(lt1),
                    text_color: dk1.to_owned(),
                }),
                first_row: object!(TablePartStyle {
                    fill: solid(a),
                    text_color: lt1.to_owned(),
                    bold: true,
                }),
                last_row: object!(TablePartStyle {
                    fill: solid(lt1),
                    bold: true,
                }),
                first_col: object!(TablePartStyle {
                    fill: solid(a),
                    text_color: lt1.to_owned(),
                }),
                last_col: object!(TablePartStyle {
                    fill: solid(a),
                    text_color: lt1.to_owned(),
                }),
                band1_h: object!(TablePartStyle { fill: band.clone() }),
                band1_v: object!(TablePartStyle { fill: band }),
                outer: top_bottom(&line(dk1)),
                first_row_bottom: line(dk1),
                last_row_top: line(dk1),
            })
        }
        F::Medium4 => {
            let a = accent.unwrap_or(dk1);
            let band = solid(&tint(a, 0.4));
            object!(TableStyleDef {
                whole_tbl: object!(TablePartStyle {
                    fill: solid(&tint(a, 0.2)),
                    text_color: dk1.to_owned(),
                }),
                first_row: object!(TablePartStyle {
                    fill: solid(&tint(a, 0.2)),
                    text_color: a.to_owned(),
                    bold: true,
                }),
                last_row: object!(TablePartStyle {
                    fill: solid(&tint(dk1, 0.2))
                }),
                band1_h: object!(TablePartStyle { fill: band.clone() }),
                band1_v: object!(TablePartStyle { fill: band }),
                inside_h: line(a),
                inside_v: line(a),
                outer: all_sides(&line(a)),
                last_row_top: line(dk1),
            })
        }
        F::Dark1 => {
            // accent variants shade (dark background, light text); the
            // no-accent variant tints dk1 (light gray background, dark text)
            let a = accent.unwrap_or(dk1);
            let tf: fn(&str, f64) -> String = if truthy(accent).is_some() {
                shade
            } else {
                tint
            };
            let body = if truthy(accent).is_some() { lt1 } else { dk1 };
            object!(TableStyleDef {
                whole_tbl: object!(TablePartStyle {
                    fill: solid(&tf(a, 0.2)),
                    text_color: body.to_owned(),
                }),
                first_row: object!(TablePartStyle {
                    fill: solid(dk1),
                    text_color: lt1.to_owned(),
                    bold: true,
                }),
                last_row: object!(TablePartStyle {
                    fill: solid(&tf(a, 0.2)),
                    text_color: body.to_owned(),
                    bold: true,
                }),
                first_col: object!(TablePartStyle {
                    fill: solid(&tf(a, 0.6))
                }),
                last_col: object!(TablePartStyle {
                    fill: solid(&tf(a, 0.6))
                }),
                band1_h: object!(TablePartStyle {
                    fill: solid(&tf(a, 0.4))
                }),
                band1_v: object!(TablePartStyle {
                    fill: solid(&tf(a, 0.4))
                }),
                first_row_bottom: line(lt1),
                last_row_top: line(lt1),
            })
        }
        F::Dark2 => {
            let a = accent.unwrap_or(dk1);
            // header pairs: base dk1, Accent1 -> accent2, Accent3 -> accent4, Accent5 -> accent6
            let header = match truthy(accent_name) {
                Some(name) => resolve_scheme_color(header_pair(name).unwrap_or(name), theme, None)
                    .unwrap_or(dk1),
                None => dk1,
            };
            let band = solid(&tint(a, 0.4));
            object!(TableStyleDef {
                whole_tbl: object!(TablePartStyle {
                    fill: solid(&tint(a, 0.2)),
                    text_color: dk1.to_owned(),
                }),
                first_row: object!(TablePartStyle {
                    fill: solid(header),
                    text_color: lt1.to_owned(),
                    bold: true,
                }),
                last_row: object!(TablePartStyle {
                    fill: solid(&tint(a, 0.2)),
                    bold: true,
                }),
                band1_h: object!(TablePartStyle { fill: band.clone() }),
                band1_v: object!(TablePartStyle { fill: band }),
                last_row_top: line(dk1),
            })
        }
    }
}

/// `resolveTableStyle`: a style id as its definition, from tableStyles.xml
/// first, then the built-in gallery (`ownValue(BUILTIN, styleId)`: such an id
/// as `constructor` is an unknown id).
pub fn resolve_table_style(
    style_id: Option<&str>,
    table_styles_xml: Option<&str>,
    theme: Option<&Theme>,
) -> Option<TableStyleDef> {
    let style_id = truthy(style_id)?;
    if let Some(xml) = truthy(table_styles_xml)
        && xml.contains(style_id)
        && let Some(def) = parse_table_styles_xml(xml, style_id, theme)
    {
        return Some(def);
    }
    // The built-in gallery backs an undefined id even when the part defines
    // other styles.
    if let Some(&(_, family, accent)) = builtin(style_id) {
        let mut def = builtin_style(family, accent, theme);
        let mut whole_tbl = object!(TablePartStyle {
            font_ref: "minor".to_owned()
        });
        if let Some(own) = &*def.whole_tbl {
            whole_tbl.assign(own);
        }
        def.whole_tbl.set(whole_tbl);
        return Some(def);
    }
    if style_id == LEGACY_NO_STYLE {
        return Some(TableStyleDef::default());
    }
    None
}

js_object! {
    /// What `cellStyleBorders` returns: `{ l?, r?, t?, b? }`, each key where
    /// it was first assigned.
    #[derive(Debug, Clone, PartialEq)]
    pub struct CellStyleBorders {
        pub l: Stroke,
        pub r: Stroke,
        pub t: Stroke,
        pub b: Stroke,
    }
}

/// `cellStyleBorders`: the style borders of cell (r, c): inner separator
/// lines, the outer border, and the header separator lines where the
/// `firstRow`/`lastRow` flags are on.
pub fn cell_style_borders(
    def: &TableStyleDef,
    flags: &TableStyleFlags,
    r: f64,
    c: f64,
    n_rows: f64,
    n_cols: f64,
) -> CellStyleBorders {
    let mut out = CellStyleBorders::default();
    if r < n_rows - 1.0
        && let Some(inside_h) = &*def.inside_h
    {
        out.b.set(inside_h.clone());
    }
    if c < n_cols - 1.0
        && let Some(inside_v) = &*def.inside_v
    {
        out.r.set(inside_v.clone());
    }
    if let Some(outer) = &*def.outer {
        if r == 0.0
            && let Some(t) = &outer.t
        {
            out.t.set(t.clone());
        }
        if r == n_rows - 1.0
            && let Some(b) = &outer.b
        {
            out.b.set(b.clone());
        }
        if c == 0.0
            && let Some(l) = &outer.l
        {
            out.l.set(l.clone());
        }
        if c == n_cols - 1.0
            && let Some(right) = &outer.r
        {
            out.r.set(right.clone());
        }
    }
    if flags.first_row
        && r == 0.0
        && n_rows > 1.0
        && let Some(first_row_bottom) = &*def.first_row_bottom
    {
        out.b.set(first_row_bottom.clone());
    }
    if flags.last_row
        && r == n_rows - 1.0
        && n_rows > 1.0
        && let Some(last_row_top) = &*def.last_row_top
    {
        out.t.set(last_row_top.clone());
    }
    out
}

// ── tableStyles.xml parsing ─────────────────────────────────────────

/// `isArray` of `tsParser`.
const TS_ARRAY_NAMES: [&str; 1] = ["a:tblStyle"];

/// `a || fallback` on a number.
fn number_or(x: f64, fallback: f64) -> f64 {
    if number_truthy(x) { x } else { fallback }
}

/// `parseInt(String(value ?? '0'), 10) || 0`
fn index_attribute(value: Option<&Value>) -> f64 {
    let text = match value {
        None | Some(Value::Null) => "0".to_owned(),
        Some(value) => value_to_string(Some(value)),
    };
    number_or(parse_int(&text, Radix::Ten), 0.0)
}

/// `parseInt(String(value), 10) || 12700`: a line width attribute.
fn width_attribute(value: Option<&Value>) -> f64 {
    number_or(parse_int(&value_to_string(value), Radix::Ten), 12700.0)
}

/// `items[index]` of a JavaScript array: an element only at an integer index
/// inside it.
fn element_at(items: &[Value], index: f64) -> Option<&Value> {
    if index >= 0.0 && index.fract() == 0.0 && index < items.len() as f64 {
        items.get(index as usize)
    } else {
        None
    }
}

/// `!node || typeof node !== 'object'` turned around: an element node or a
/// list of them.
fn object_node(node: Option<&Value>) -> Option<&Value> {
    node.filter(|node| matches!(node, Value::Object(_) | Value::Array(_)))
}

/// `readColor`: the colour element of `node` with its transforms (alpha as
/// an `#RRGGBBAA` suffix), through the theme for a scheme colour.
fn read_color(node: Option<&Value>, theme: Option<&Theme>) -> Option<String> {
    let n = object_node(node)?;
    if value_truthy(n.get("a:srgbClr")) {
        let srgb = as_xml_node(n.get("a:srgbClr"));
        let hex = format!("#{}", value_to_string(srgb.get("@_val")).to_uppercase());
        return Some(apply_color_mods(&hex, Some(srgb)));
    }
    if value_truthy(n.get("a:schemeClr")) {
        let scheme = as_xml_node(n.get("a:schemeClr"));
        let name = value_to_string(scheme.get("@_val"));
        let base = truthy(resolve_scheme_color(&name, theme, None))?;
        return Some(apply_color_mods(base, Some(scheme)));
    }
    match as_xml_node(n.get("a:prstClr")).get("@_val") {
        Some(Value::String(prst)) if prst == "black" => Some("#000000".to_owned()),
        Some(Value::String(prst)) if prst == "white" => Some("#FFFFFF".to_owned()),
        _ => None,
    }
}

/// `readPart`: one region of a `<a:tblStyle>`; `None` where it sets nothing.
fn read_part(part: Option<&Value>, theme: Option<&Theme>) -> Option<TablePartStyle> {
    let p = object_node(part)?;
    let mut out = TablePartStyle::default();
    let fill_color = read_color(
        as_xml_node(as_xml_node(p.get("a:tcStyle")).get("a:fill")).get("a:solidFill"),
        theme,
    );
    if let Some(fill_color) = truthy(fill_color.as_deref()) {
        out.fill.set(solid(fill_color));
    }
    if value_truthy(p.get("a:tcTxStyle")) {
        let tx = as_xml_node(p.get("a:tcTxStyle"));
        if tx.get("@_b").and_then(Value::as_str) == Some("on") {
            out.bold.set(true);
        }
        let ref_idx = as_xml_node(tx.get("a:fontRef"))
            .get("@_idx")
            .and_then(Value::as_str);
        if let Some(ref_idx @ ("minor" | "major")) = ref_idx {
            out.font_ref.set(ref_idx.to_owned());
        }
        if value_truthy(tx.get("a:font")) {
            let f = as_xml_node(tx.get("a:font"));
            let face = |tag: &str| {
                as_xml_node(f.get(tag))
                    .get("@_typeface")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            };
            out.font.set(TableFont {
                latin: Slot::maybe(face("a:latin")),
                ea: Slot::maybe(face("a:ea")),
                cs: Slot::maybe(face("a:cs")),
            });
        }
        let c = read_color(Some(tx), theme);
        if let Some(c) = truthy(c.as_deref()) {
            out.text_color.set(c.to_owned());
        }
    }
    (!out.has_no_key()).then_some(out)
}

/// `readInside`: the line of one edge of `<a:tcBdr>`, from `<a:ln>` or from
/// the theme line style an `<a:lnRef>` names.
fn read_inside(part: Option<&Value>, tag: &str, theme: Option<&Theme>) -> Option<Stroke> {
    let bdr = as_xml_node(as_xml_node(as_xml_node(part).get("a:tcStyle")).get("a:tcBdr"));
    let edge = as_xml_node(bdr.get(tag));
    let ln_raw = edge.get("a:ln");
    if value_truthy(ln_raw) {
        let ln = as_xml_node(ln_raw);
        if ln.get("a:noFill").is_some() {
            return None;
        }
        let c = read_color(ln.get("a:solidFill"), theme);
        let c = truthy(c.as_deref())?;
        return Some(line_w(c, width_attribute(ln.get("@_w"))));
    }
    // <a:lnRef idx>: a theme lnStyleLst template; the ref's child colour
    // substitutes phClr
    let ref_raw = edge.get("a:lnRef");
    if value_truthy(ref_raw) {
        let line_ref = as_xml_node(ref_raw);
        let c = read_color(Some(line_ref), theme);
        let c = truthy(c.as_deref())?;
        let idx = index_attribute(line_ref.get("@_idx"));
        let template = theme
            .and_then(|theme| theme.ln_styles.as_deref())
            .and_then(|styles| element_at(styles, idx - 1.0));
        let tpl_ln = as_xml_node(as_xml_node(template).get("a:ln"));
        return Some(line_w(c, width_attribute(tpl_ln.get("@_w"))));
    }
    None
}

/// `parseTableStylesXml`: the `<a:tblStyle>` of `styleId` in tableStyles.xml;
/// `None` where the part does not parse, lacks it, or it defines nothing.
fn parse_table_styles_xml(
    xml: &str,
    style_id: &str,
    theme: Option<&Theme>,
) -> Option<TableStyleDef> {
    let options = ObjectOptions {
        array_names: &TS_ARRAY_NAMES,
        ..ObjectOptions::default()
    };
    let doc = parse_object(xml, &options).ok()?;
    let doc = as_xml_node(Some(&doc));
    let list = as_xml_node(doc.get("a:tblStyleLst")).get("a:tblStyle");
    let style =
        xml_array(list).find(|s| s.get("@_styleId").and_then(Value::as_str) == Some(style_id))?;
    let mut def = TableStyleDef::default();
    let tbl_bg_raw = style.get("a:tblBg");
    if value_truthy(tbl_bg_raw) {
        let bg = as_xml_node(tbl_bg_raw);
        let direct = read_color(as_xml_node(bg.get("a:fill")).get("a:solidFill"), theme);
        if let Some(direct) = truthy(direct.as_deref()) {
            def.tbl_bg.set(solid(direct));
        }
        let ref_raw = bg.get("a:fillRef");
        if value_truthy(ref_raw) {
            let fill_ref = as_xml_node(ref_raw);
            let idx = index_attribute(fill_ref.get("@_idx"));
            if idx > 0.0 {
                def.tbl_bg_ref.set(TblBgRef {
                    idx: JsNum(idx),
                    ph_clr: read_color(Some(fill_ref), theme),
                });
            }
        }
    }
    for (key, slot) in [
        ("a:wholeTbl", &mut def.whole_tbl),
        ("a:band1H", &mut def.band1_h),
        ("a:band2H", &mut def.band2_h),
        ("a:band1V", &mut def.band1_v),
        ("a:band2V", &mut def.band2_v),
        ("a:firstRow", &mut def.first_row),
        ("a:lastRow", &mut def.last_row),
        ("a:firstCol", &mut def.first_col),
        ("a:lastCol", &mut def.last_col),
    ] {
        if let Some(p) = read_part(style.get(key), theme) {
            slot.set(p);
        }
    }
    let whole_tbl = style.get("a:wholeTbl");
    // assigned, then deleted where undefined: a key only where there is a line
    if let Some(inside_h) = read_inside(whole_tbl, "a:insideH", theme) {
        def.inside_h.set(inside_h);
    }
    if let Some(inside_v) = read_inside(whole_tbl, "a:insideV", theme) {
        def.inside_v.set(inside_v);
    }
    let outer = TableOuter {
        l: read_inside(whole_tbl, "a:left", theme),
        r: read_inside(whole_tbl, "a:right", theme),
        t: read_inside(whole_tbl, "a:top", theme),
        b: read_inside(whole_tbl, "a:bottom", theme),
    };
    if outer.l.is_some() || outer.r.is_some() || outer.t.is_some() || outer.b.is_some() {
        def.outer.set(outer);
    }
    (!def.has_no_key()).then_some(def)
}

/// `merge` of `cellPartStyle`: `base` with the keys of `over` that are not
/// `undefined` spread over it. No key of a `TablePartStyle` here holds
/// `undefined` (literals set values, input sets only what it has), so that
/// is `Object.assign`.
fn merge(base: TablePartStyle, over: Option<&TablePartStyle>) -> TablePartStyle {
    match over {
        Some(over) => {
            let mut out = base;
            out.assign(over);
            out
        }
        None => base,
    }
}

/// `cellPartStyle`: the region style of cell (r, c), by OOXML precedence
/// wholeTbl < banding < lastRow/firstCol/lastCol < firstRow.
pub fn cell_part_style(
    def: &TableStyleDef,
    flags: &TableStyleFlags,
    r: f64,
    c: f64,
    n_rows: f64,
    n_cols: f64,
) -> TablePartStyle {
    let mut out = def.whole_tbl.as_ref().cloned().unwrap_or_default();
    let is_first_row = flags.first_row && r == 0.0;
    let is_last_row = flags.last_row && r == n_rows - 1.0;
    let is_first_col = flags.first_col && c == 0.0;
    let is_last_col = flags.last_col && c == n_cols - 1.0;

    if flags.band_row && !is_first_row && !is_last_row {
        let data_r = r - if flags.first_row { 1.0 } else { 0.0 };
        let band = if data_r % 2.0 == 0.0 {
            &def.band1_h
        } else {
            &def.band2_h
        };
        out = merge(out, band.as_ref());
    }
    if flags.band_col && !is_first_col && !is_last_col {
        let data_c = c - if flags.first_col { 1.0 } else { 0.0 };
        let band = if data_c % 2.0 == 0.0 {
            &def.band1_v
        } else {
            &def.band2_v
        };
        out = merge(out, band.as_ref());
    }
    if is_last_col {
        out = merge(out, def.last_col.as_ref());
    }
    if is_first_col {
        out = merge(out, def.first_col.as_ref());
    }
    if is_last_row {
        out = merge(out, def.last_row.as_ref());
    }
    if is_first_row {
        out = merge(out, def.first_row.as_ref());
    }
    out
}
