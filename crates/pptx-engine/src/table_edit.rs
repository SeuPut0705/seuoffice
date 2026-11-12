//! Table style editing (packages/pptx-engine/src/table-edit.ts): patches the
//! <a:tblPr> of a table's graphicFrame fragment and the fill and borders of
//! its <a:tcPr> in place, keeping every other byte.

use std::sync::LazyLock;

use jscompat::{
    JsNum, JsRegex, js_regex, number_to_string, replace_first, replace_first_with, sort_by_number,
    truthy,
};
use serde::{Deserialize, Deserializer, Serialize};

use crate::xml_utils::escape_xml_attr;

/// `undefined` as `None`, `null` as `Some(None)`.
fn nullable<'de, D: Deserializer<'de>, T: Deserialize<'de>>(
    deserializer: D,
) -> Result<Option<Option<T>>, D::Error> {
    Option::<T>::deserialize(deserializer).map(Some)
}

/// One entry of `TableStyleEdit.cells`: a row and a tc index.
#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
pub struct CellRef {
    pub row: f64,
    pub col: f64,
}

/// `TableStyleEdit`, the engine side of the IPC EditTableStyleOp. A field
/// read for `!== undefined` that may be `null` is `Option<Option<_>>`.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableStyleEdit {
    pub tbl_pr_xml: Option<String>,
    pub first_row: Option<bool>,
    pub band_row: Option<bool>,
    pub last_row: Option<bool>,
    pub first_col: Option<bool>,
    pub last_col: Option<bool>,
    pub band_col: Option<bool>,
    pub style_id: Option<String>,
    pub rtl: Option<bool>,
    #[serde(default, deserialize_with = "nullable")]
    pub shading_color: Option<Option<String>>,
    pub border_color: Option<String>,
    pub border_width_emu: Option<JsNum>,
    #[serde(default, deserialize_with = "nullable")]
    pub border_preset: Option<Option<String>>,
    pub clear_direct_formatting: Option<bool>,
    pub cells: Option<Vec<CellRef>>,
}

impl TableStyleEdit {
    /// `FLAG_ATTRS` with the value of each.
    fn flags(&self) -> [(&'static str, Option<bool>); 6] {
        [
            ("firstRow", self.first_row),
            ("lastRow", self.last_row),
            ("firstCol", self.first_col),
            ("lastCol", self.last_col),
            ("bandRow", self.band_row),
            ("bandCol", self.band_col),
        ]
    }
}

// ── Preset styles ────────────────────────────────────────────────────

fn in_ln(tag: &str, color: &str) -> String {
    format!(
        r#"<a:{tag}><a:ln w="9525" cap="flat"><a:solidFill><a:srgbClr val="{color}"/></a:solidFill></a:ln></a:{tag}>"#
    )
}

#[derive(Default)]
struct PartStyle<'a> {
    fill: Option<&'a str>,
    text: Option<&'a str>,
    bold: bool,
    inside_h: Option<&'a str>,
    inside_v: Option<&'a str>,
}

/// Style XML for one table region (wholeTbl/band1H/firstRow...).
fn part_xml(tag: &str, o: &PartStyle<'_>) -> String {
    let tx = if truthy(o.text).is_some() || o.bold {
        format!(
            "<a:tcTxStyle{}>{}</a:tcTxStyle>",
            if o.bold { r#" b="on""# } else { "" },
            truthy(o.text).map_or_else(String::new, |text| format!(r#"<a:srgbClr val="{text}"/>"#)),
        )
    } else {
        String::new()
    };
    let bdr = if truthy(o.inside_h).is_some() || truthy(o.inside_v).is_some() {
        format!(
            "<a:tcBdr>{}{}</a:tcBdr>",
            truthy(o.inside_h).map_or_else(String::new, |color| in_ln("insideH", color)),
            truthy(o.inside_v).map_or_else(String::new, |color| in_ln("insideV", color)),
        )
    } else {
        String::new()
    };
    let fill = truthy(o.fill).map_or_else(String::new, |fill| {
        format!(r#"<a:fill><a:solidFill><a:srgbClr val="{fill}"/></a:solidFill></a:fill>"#)
    });
    let tc = if !bdr.is_empty() || !fill.is_empty() {
        format!("<a:tcStyle>{bdr}{fill}</a:tcStyle>")
    } else {
        String::new()
    };
    format!("<a:{tag}>{tx}{tc}</a:{tag}>")
}

#[derive(Default)]
struct CustomStyle<'a> {
    band: Option<&'a str>,
    /// fill, text
    header: Option<(&'a str, &'a str)>,
    inside_h: Option<&'a str>,
    whole: Option<&'a str>,
}

/// Fixed-color banded/header style (band = alternate-row shading; header = header fill).
fn custom_style(style_id: &str, name: &str, o: &CustomStyle<'_>) -> String {
    // CT_TableStyle child order: wholeTbl, band1H, ..., firstRow
    let mut out = format!(r#"<a:tblStyle styleId="{style_id}" styleName="{name}">"#);
    out.push_str(&part_xml(
        "wholeTbl",
        &PartStyle {
            text: Some("000000"),
            fill: o.whole,
            inside_h: o.inside_h,
            ..PartStyle::default()
        },
    ));
    if let Some(band) = truthy(o.band) {
        out.push_str(&part_xml(
            "band1H",
            &PartStyle {
                fill: Some(band),
                ..PartStyle::default()
            },
        ));
    }
    let (fill, text) = o
        .header
        .map_or((None, None), |(fill, text)| (Some(fill), Some(text)));
    out.push_str(&part_xml(
        "firstRow",
        &PartStyle {
            bold: true,
            fill,
            text,
            ..PartStyle::default()
        },
    ));
    out.push_str("</a:tblStyle>");
    out
}

const ID_ZEBRA_BLUE: &str = "{A10FF1CE-0000-4000-9000-000000000001}";
const ID_ZEBRA_GRAY: &str = "{A10FF1CE-0000-4000-9000-000000000002}";
const ID_HEADER_DARKBLUE: &str = "{A10FF1CE-0000-4000-9000-000000000003}";
const ID_HEADER_ORANGE: &str = "{A10FF1CE-0000-4000-9000-000000000004}";
const ID_NO_BORDER: &str = "{A10FF1CE-0000-4000-9000-000000000005}";

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PresetBorder {
    pub color: &'static str,
    pub width_emu: JsNum,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableStylePreset {
    pub tbl_pr_xml: String,
    pub description: &'static str,
    /// Custom style: must first be ensured into ppt/tableStyles.xml
    #[serde(skip_serializing_if = "Option::is_none")]
    pub style_id: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub style_def_xml: Option<String>,
    /// Grid presets: border lines added to every cell directly
    #[serde(skip_serializing_if = "Option::is_none")]
    pub border: Option<PresetBorder>,
}

fn tbl_pr(style_id: &str, flags: &str) -> String {
    format!("<a:tblPr{flags}><a:tableStyleId>{style_id}</a:tableStyleId></a:tblPr>")
}

const NO_STYLE: &str = "{2D5ABB26-0587-4C30-8999-92F81FD0307C}";

fn plain(description: &'static str, border: Option<PresetBorder>) -> TableStylePreset {
    TableStylePreset {
        tbl_pr_xml: tbl_pr(NO_STYLE, ""),
        description,
        style_id: None,
        style_def_xml: None,
        border,
    }
}

fn custom(
    style_id: &'static str,
    flags: &str,
    description: &'static str,
    style: &CustomStyle<'_>,
) -> TableStylePreset {
    TableStylePreset {
        tbl_pr_xml: tbl_pr(style_id, flags),
        description,
        style_id: Some(style_id),
        style_def_xml: Some(custom_style(style_id, description, style)),
        border: None,
    }
}

/// `TABLE_STYLE_PRESETS`: the 8 preset styles in the order of the literal
/// (keys map to the ribbon style gallery).
pub static TABLE_STYLE_PRESETS: LazyLock<[(&str, TableStylePreset); 8]> = LazyLock::new(|| {
    [
        ("none", plain("No style", None)),
        (
            "lightGrid",
            plain(
                "Light grid",
                Some(PresetBorder {
                    color: "#BFBFBF",
                    width_emu: JsNum(12700.0),
                }),
            ),
        ),
        (
            "zebraBlue",
            custom(
                ID_ZEBRA_BLUE,
                r#" firstRow="1" bandRow="1""#,
                "Banded blue",
                &CustomStyle {
                    whole: Some("FFFFFF"),
                    band: Some("D6E4F0"),
                    header: Some(("4472C4", "FFFFFF")),
                    ..CustomStyle::default()
                },
            ),
        ),
        (
            "zebraGray",
            custom(
                ID_ZEBRA_GRAY,
                r#" firstRow="1" bandRow="1""#,
                "Banded gray",
                &CustomStyle {
                    whole: Some("FFFFFF"),
                    band: Some("EDEDED"),
                    header: Some(("595959", "FFFFFF")),
                    ..CustomStyle::default()
                },
            ),
        ),
        (
            "headerDarkBlue",
            custom(
                ID_HEADER_DARKBLUE,
                r#" firstRow="1""#,
                "Dark blue header",
                &CustomStyle {
                    whole: Some("FFFFFF"),
                    inside_h: Some("D9D9D9"),
                    band: Some("E9EDF5"),
                    header: Some(("1F3864", "FFFFFF")),
                },
            ),
        ),
        (
            "headerOrange",
            custom(
                ID_HEADER_ORANGE,
                r#" firstRow="1""#,
                "Orange header",
                &CustomStyle {
                    whole: Some("FFFFFF"),
                    inside_h: Some("D9D9D9"),
                    band: Some("FBE5D6"),
                    header: Some(("ED7D31", "FFFFFF")),
                },
            ),
        ),
        (
            "noBorder",
            custom(
                ID_NO_BORDER,
                r#" firstRow="1" bandRow="1""#,
                "Minimal (no borders)",
                &CustomStyle {
                    band: Some("F2F2F2"),
                    ..CustomStyle::default()
                },
            ),
        ),
        (
            "fullBorder",
            plain(
                "All borders",
                Some(PresetBorder {
                    color: "#000000",
                    width_emu: JsNum(12700.0),
                }),
            ),
        ),
    ]
});

/// `TABLE_STYLE_PRESETS[name]` for an own key only.
pub fn table_style_preset(name: &str) -> Option<&'static TableStylePreset> {
    TABLE_STYLE_PRESETS
        .iter()
        .find(|(key, _)| *key == name)
        .map(|(_, preset)| preset)
}

const EMPTY_TABLE_STYLES_XML: &str = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<a:tblStyleLst xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\" def=\"{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}\"/>";

/// Ensure the given style definition exists in tableStyles.xml; returned as-is
/// if already present. `None` is `null` or `undefined`.
pub fn ensure_table_style_xml(
    table_styles_xml: Option<&str>,
    style_id: &str,
    style_def_xml: &str,
) -> String {
    let xml = match table_styles_xml {
        Some(xml) if xml.contains("<a:tblStyleLst") => xml,
        _ => EMPTY_TABLE_STYLES_XML,
    };
    if xml.contains(style_id) {
        return xml.to_owned();
    }
    if let Some(sc) = js_regex!(r"<a:tblStyleLst([^>]*)\/>").exec(xml) {
        // ledger tblstylelst-dollar: the TypeScript passes this as a replacement
        // string, so a `$&`, `$'` or `` $` `` in the attributes or the definition
        // expands into markup; spliced here as written.
        return format!(
            "{}<a:tblStyleLst{}>{style_def_xml}</a:tblStyleLst>{}",
            &xml[..sc.start()],
            sc.get(1).unwrap_or(""),
            &xml[sc.end()..],
        );
    }
    xml.replacen(
        "</a:tblStyleLst>",
        &format!("{style_def_xml}</a:tblStyleLst>"),
        1,
    )
}

/// Surgically patch a table element's originalXml (graphicFrame fragment),
/// applying the style edit.
pub fn patch_table_style_xml(original_xml: &str, edit: &TableStyleEdit) -> String {
    let mut xml = original_xml.to_owned();

    // 1. Replace <a:tblPr>
    if let Some(tbl_pr_xml) = &edit.tbl_pr_xml {
        // Presets carry their own firstRow/bandRow but never rtl: table direction
        // survives a style change (PowerPoint behavior)
        let mut next = tbl_pr_xml.clone();
        let rtl = js_regex!(r#"<a:tblPr[^>]*\srtl="([^"]*)""#)
            .exec(&xml)
            .and_then(|found| found.get(1));
        if matches!(rtl, Some("1" | "true")) && !js_regex!(r#"\srtl=""#).test(&next) {
            next = replace_first(js_regex!(r"^<a:tblPr"), 0, &next, r#"<a:tblPr rtl="1""#);
        }
        xml = replace_tbl_pr(&xml, &next);
    } else if edit.flags().iter().any(|(_, flag)| flag.is_some())
        || edit.rtl.is_some()
        || edit.style_id.is_some()
    {
        // Change only the flags, keeping the rest (styleId etc.)
        if !js_regex!(r"<a:tblPr[\s>/]").test(&xml) {
            xml = replace_tbl_pr(&xml, "<a:tblPr/>");
        }
        if let Some(found) = js_regex!(r"<a:tblPr(\s[^>]*)?(\/?>)", "s").exec(&xml) {
            // With attributes present the greedy [^>]* swallows a trailing "/" into
            // group 1, so self-closing is read on the whole tag and the slash stripped
            let self_closing = found.as_str().ends_with("/>");
            let mut attrs = replace_first(js_regex!(r"\/\s*$"), 0, found.get(1).unwrap_or(""), "");
            for (key, flag) in edit.flags() {
                if let Some(on) = flag {
                    attrs = set_attr(&attrs, key, on.then_some("1"));
                }
            }
            if let Some(rtl) = edit.rtl {
                attrs = set_attr(&attrs, "rtl", rtl.then_some("1"));
            }
            xml = format!(
                "{}<a:tblPr{attrs}>{}{}",
                &xml[..found.start()],
                if self_closing { "</a:tblPr>" } else { "" },
                &xml[found.end()..],
            );
        }
        if let Some(style_id) = &edit.style_id {
            xml = set_table_style_id(&xml, style_id);
        }
    }

    // 2. Shading / borders: patch the targeted <a:tcPr> nodes
    if edit.shading_color.is_some()
        || edit.border_preset.is_some()
        || edit.clear_direct_formatting == Some(true)
    {
        xml = match &edit.cells {
            Some(cells) => patch_cells_tc_pr(&xml, cells, edit),
            None => patch_all_tc_pr(&xml, edit),
        };
    }

    xml
}

/// Set a:tableStyleId inside an open/close tblPr (CT_TableProperties: the
/// style id is the last child before extLst).
fn set_table_style_id(xml: &str, style_id: &str) -> String {
    let Some(found) = js_regex!(r"<a:tblPr(\s[^>]*)?>([\s\S]*?)<\/a:tblPr>").exec(xml) else {
        return xml.to_owned();
    };
    let tag = format!(
        "<a:tableStyleId>{}</a:tableStyleId>",
        escape_xml_attr(style_id)
    );
    let inner = replace_first(
        js_regex!(r"<a:tableStyleId>[^<]*<\/a:tableStyleId>"),
        0,
        found.get(2).unwrap_or(""),
        "",
    );
    let inner = match inner.find("<a:extLst") {
        Some(ext) => format!("{}{tag}{}", &inner[..ext], &inner[ext..]),
        None => inner + &tag,
    };
    format!(
        "{}<a:tblPr{}>{inner}</a:tblPr>{}",
        &xml[..found.start()],
        found.get(1).unwrap_or(""),
        &xml[found.end()..],
    )
}

/// Replace <a:tblPr>...</a:tblPr> (or its self-closing form) with a new value.
fn replace_tbl_pr(xml: &str, new_tbl_pr: &str) -> String {
    if let Some(sc) = js_regex!(r"<a:tblPr[^>]*\/>").exec(xml) {
        return format!("{}{new_tbl_pr}{}", &xml[..sc.start()], &xml[sc.end()..]);
    }
    let Some(open) = xml.find("<a:tblPr") else {
        // No tblPr: insert right after <a:tbl>
        return match xml.find("<a:tbl>") {
            Some(tbl) => {
                let at = tbl + "<a:tbl>".len();
                format!("{}{new_tbl_pr}{}", &xml[..at], &xml[at..])
            }
            None => xml.to_owned(),
        };
    };
    let Some(close) = xml[open..].find("</a:tblPr>").map(|at| open + at) else {
        return xml.to_owned();
    };
    format!(
        "{}{new_tbl_pr}{}",
        &xml[..open],
        &xml[close + "</a:tblPr>".len()..]
    )
}

/// The attribute `key` of a start tag's attribute text, in either quote style
/// and with white space around `=`.
fn attr_pattern(key: &str) -> &'static JsRegex {
    match key {
        "firstRow" => js_regex!(r#"\sfirstRow\s*=\s*(?:"[^"]*"|'[^']*')"#),
        "lastRow" => js_regex!(r#"\slastRow\s*=\s*(?:"[^"]*"|'[^']*')"#),
        "firstCol" => js_regex!(r#"\sfirstCol\s*=\s*(?:"[^"]*"|'[^']*')"#),
        "lastCol" => js_regex!(r#"\slastCol\s*=\s*(?:"[^"]*"|'[^']*')"#),
        "bandRow" => js_regex!(r#"\sbandRow\s*=\s*(?:"[^"]*"|'[^']*')"#),
        "bandCol" => js_regex!(r#"\sbandCol\s*=\s*(?:"[^"]*"|'[^']*')"#),
        _ => js_regex!(r#"\srtl\s*=\s*(?:"[^"]*"|'[^']*')"#),
    }
}

/// Set or remove key="value" in an XML attribute string (remove: `None`).
fn set_attr(attrs: &str, key: &str, value: Option<&str>) -> String {
    // ledger tblpr-attr-quote: the TypeScript matches only key="..." and so
    // writes a second firstRow beside firstRow='1' (or firstRow = "1"), which
    // is not well-formed XML, and cannot remove it.
    let cleaned = replace_first(attr_pattern(key), 0, attrs, "");
    match value {
        None => cleaned,
        Some(value) => format!(r#"{cleaned} {key}="{}""#, escape_xml_attr(value)),
    }
}

/// One ln* element in either form, self-closing or paired (they cannot nest).
fn ln_element_re() -> &'static JsRegex {
    js_regex!(
        r"<a:(lnL|lnR|lnT|lnB|lnTlToBr|lnBlToTr)(?:\s[^>]*)?\/>|<a:(lnL|lnR|lnT|lnB|lnTlToBr|lnBlToTr)(?:\s[^>]*)?>.*?<\/a:\2>",
        "s"
    )
}

/// Transform only the segments outside ln* elements: a:ln* carry their own
/// solidFill children, so cell-fill edits must not reach inside them.
fn outside_lns(src: &str, f: impl Fn(&str) -> String) -> String {
    let mut out = String::with_capacity(src.len());
    let mut cursor = 0;
    for found in ln_element_re().find_iter(src) {
        out.push_str(&f(&src[cursor..found.start()]));
        out.push_str(found.as_str());
        cursor = found.end();
    }
    out.push_str(&f(&src[cursor..]));
    out
}

fn remove_all(regex: &JsRegex, text: &str) -> String {
    regex.replace_all(text, |_| String::new())
}

/// `inner` with `insert` before the first match of `anchor`, else at the end.
fn insert_before(inner: &str, anchor: &JsRegex, insert: &str) -> String {
    match anchor.exec(inner) {
        Some(found) => format!(
            "{}{insert}{}",
            &inner[..found.start()],
            &inner[found.start()..]
        ),
        None => format!("{inner}{insert}"),
    }
}

fn apply_tc_pr_edit(inner: &str, edit: &TableStyleEdit) -> String {
    let mut inner = inner.to_owned();
    if edit.clear_direct_formatting == Some(true) {
        inner = remove_all(
            js_regex!(
                r"<a:(solidFill|gradFill|pattFill|blipFill)(?:\s[^>]*)?>.*?<\/a:\1>",
                "s"
            ),
            &inner,
        );
        inner = remove_all(js_regex!(r"<a:(noFill|grpFill)\/>"), &inner);
        inner = remove_all(
            js_regex!(r"<a:(lnL|lnR|lnT|lnB|lnTlToBr|lnBlToTr)(\s[^>]*)?\/>"),
            &inner,
        );
        inner = remove_all(
            js_regex!(
                r"<a:(lnL|lnR|lnT|lnB|lnTlToBr|lnBlToTr)(\s[^>]*)?>.*?<\/a:\1>",
                "s"
            ),
            &inner,
        );
    }
    // CT_TableCellProperties is a sequence: ln*, cell3D, fill, headers/extLst.
    // Misplaced children make the part schema-invalid and PowerPoint offers repair.
    let fill_anchor = js_regex!(r"<a:(headers|extLst)[\s>/]");
    let lns_anchor = js_regex!(
        r"<a:(lnTlToBr|lnBlToTr|cell3D|solidFill|gradFill|pattFill|blipFill|noFill|grpFill|headers|extLst)[\s>/]"
    );
    // Replace existing cell-level fill nodes (border fills stay untouched)
    if let Some(shading) = &edit.shading_color {
        inner = outside_lns(&inner, |seg| {
            let seg = remove_all(
                js_regex!(
                    r"<a:(solidFill|gradFill|pattFill|blipFill)(?:\s[^>]*)?>.*?<\/a:\1>",
                    "s"
                ),
                seg,
            );
            let seg = remove_all(js_regex!(r"<a:(noFill|grpFill)\/>"), &seg);
            remove_all(js_regex!(r"<a:(noFill|grpFill)><\/a:\1>"), &seg)
        });
        match shading.as_deref() {
            Some("none") => inner = insert_before(&inner, fill_anchor, "<a:noFill/>"),
            Some(color) if !color.is_empty() => {
                let c = color.replacen('#', "", 1).to_uppercase();
                inner = insert_before(
                    &inner,
                    fill_anchor,
                    &format!(r#"<a:solidFill><a:srgbClr val="{c}"/></a:solidFill>"#),
                );
            }
            _ => {}
        }
    }
    // Border handling
    if let Some(preset) = &edit.border_preset {
        inner = remove_all(js_regex!(r"<a:(lnL|lnR|lnT|lnB)(?:\s[^>]*)?\/>"), &inner);
        inner = remove_all(
            js_regex!(r"<a:(lnL|lnR|lnT|lnB)(?:\s[^>]*)?>.*?<\/a:\1>", "s"),
            &inner,
        );
        match (preset.as_deref(), truthy(edit.border_color.as_deref())) {
            (Some("all"), Some(color)) => {
                let c = color.replacen('#', "", 1).to_uppercase();
                let w = number_to_string(edit.border_width_emu.map_or(12700.0, |w| w.0));
                let ln_xml = |tag: &str| {
                    format!(
                        r#"<{tag} w="{w}"><a:solidFill><a:srgbClr val="{c}"/></a:solidFill></{tag}>"#
                    )
                };
                let lns = ln_xml("a:lnL") + &ln_xml("a:lnR") + &ln_xml("a:lnT") + &ln_xml("a:lnB");
                inner = insert_before(&inner, lns_anchor, &lns);
            }
            (Some("none"), _) => {
                inner = insert_before(
                    &inner,
                    lns_anchor,
                    r#"<a:lnL w="0"><a:noFill/></a:lnL><a:lnR w="0"><a:noFill/></a:lnR><a:lnT w="0"><a:noFill/></a:lnT><a:lnB w="0"><a:noFill/></a:lnB>"#,
                );
            }
            _ => {}
        }
    }
    inner
}

/// Self-closing first: [^>]* in the paired form would also accept the '/' of
/// <a:tcPr/> and run on to some later cell's </a:tcPr>.
fn tc_pr_re() -> &'static JsRegex {
    js_regex!(r"<a:tcPr([^>]*)\/>|<a:tcPr([^>]*)>(.*?)<\/a:tcPr>", "s")
}

/// Patch the fill/borders of every <a:tcPr> in the XML.
fn patch_all_tc_pr(xml: &str, edit: &TableStyleEdit) -> String {
    let mut out = String::with_capacity(xml.len());
    let mut cursor = 0;
    for found in tc_pr_re().find_iter(xml) {
        out.push_str(&xml[cursor..found.start()]);
        let inner = apply_tc_pr_edit(found.get(3).unwrap_or(""), edit);
        let attrs = found.get(1).or(found.get(2)).unwrap_or("");
        out.push_str(&format!("<a:tcPr{attrs}>{inner}</a:tcPr>"));
        cursor = found.end();
    }
    out.push_str(&xml[cursor..]);
    out
}

/// The element `nth_span` looks for.
#[derive(Clone, Copy)]
enum TableTag {
    /// `/<a:tr[\s>]/g`
    Row,
    /// `/<a:tc[\s>]/g`
    Cell,
}

/// Span of the nth element `open` finds in [from,to), up to the first `close`
/// after it; only for tags that cannot nest (a:tr / a:tc).
fn nth_span(
    xml: &str,
    open: TableTag,
    close: &str,
    n: f64,
    from: usize,
    to: usize,
) -> Option<(usize, usize)> {
    let mut i = 0.0;
    let found_from = match open {
        TableTag::Row => js_regex!(r"<a:tr[\s>]").find_from(xml, from),
        TableTag::Cell => js_regex!(r"<a:tc[\s>]").find_from(xml, from),
    };
    for found in found_from {
        if found.start() >= to {
            break;
        }
        if i == n {
            let end = xml[found.start()..].find(close)? + found.start() + close.len();
            if end > to {
                return None;
            }
            return Some((found.start(), end));
        }
        i += 1.0;
    }
    None
}

/// Patch the fill/borders of the <a:tcPr> of just the cells given (creating a
/// tcPr when a cell has none).
fn patch_cells_tc_pr(xml: &str, cells: &[CellRef], edit: &TableStyleEdit) -> String {
    // Back to front so earlier spans stay valid while splicing
    let mut cells = cells.to_vec();
    sort_by_number(&mut cells, |a, b| {
        let rows = b.row - a.row;
        if rows != 0.0 && !rows.is_nan() {
            rows
        } else {
            b.col - a.col
        }
    });
    let mut xml = xml.to_owned();
    for CellRef { row, col } in cells {
        if row < 0.0 || col < 0.0 {
            continue;
        }
        let Some((tr_start, tr_end)) = nth_span(&xml, TableTag::Row, "</a:tr>", row, 0, xml.len())
        else {
            continue;
        };
        let Some((tc_start, tc_end)) =
            nth_span(&xml, TableTag::Cell, "</a:tc>", col, tr_start, tr_end)
        else {
            continue;
        };
        let tc_xml = &xml[tc_start..tc_end];
        // Self-closing form first, as in patch_all_tc_pr: the paired form's lazy
        // body would otherwise run on to a nested table cell's </a:tcPr>
        let patched = match tc_pr_re().exec(tc_xml) {
            Some(found) => {
                let inner = apply_tc_pr_edit(found.get(3).unwrap_or(""), edit);
                let attrs = found.get(1).or(found.get(2)).unwrap_or("");
                format!(
                    "{}<a:tcPr{attrs}>{inner}</a:tcPr>{}",
                    &tc_xml[..found.start()],
                    &tc_xml[found.end()..],
                )
            }
            // tcPr follows txBody in CT_TableCell.
            // ledger tcpr-color-dollar: the TypeScript passes the new tcPr as a
            // replacement string, so a `$&`, `$$`, `$'` or `` $` `` in a shading or
            // border color that is not a color expands into markup; written as
            // given here.
            None => replace_first_with(js_regex!(r"<\/a:tc>$"), tc_xml, |_| {
                format!("<a:tcPr>{}</a:tcPr></a:tc>", apply_tc_pr_edit("", edit))
            }),
        };
        xml = format!("{}{patched}{}", &xml[..tc_start], &xml[tc_end..]);
    }
    xml
}

/// What `findTableElementInSlide` reads of a slide; the model port replaces it.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Slide {
    pub elements: Vec<SlideElement>,
}

/// What `findTableElementInSlide` reads of an element; the model port replaces it.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct SlideElement {
    pub id: String,
    #[serde(rename = "type")]
    pub r#type: String,
}

/// The table element with the given sourceId in the slide, the first one.
pub fn find_table_element_in_slide<'a>(
    slide: &'a Slide,
    source_id: &str,
) -> Option<&'a SlideElement> {
    slide
        .elements
        .iter()
        .find(|el| el.id == source_id && el.r#type == "table")
}
