//! The write half of section.ts: the edits `saveDocx` makes to a `w:sectPr`.

use jscompat::{
    js_regex, math_max, math_round, number_to_string, parse_float, replace_first_string,
    try_js_regex,
};

use super::js::{dynamic, limit, replace_first};
use crate::model::{SectionSettings, SectionSettingsOrientation, SectionSettingsPageBorderProps};
use crate::xml_text::on_off_tag_in;

/// `stripElement`: every occurrence of an element written self-closing or as a pair.
fn strip_element(xml: &str, tag: &str) -> Result<String, String> {
    let pattern = format!(r"<{tag}[^>]*\/>|<{tag}[^>]*>[\s\S]*?<\/{tag}>");
    dynamic(&pattern, "g")?
        .try_replace_all(xml, |_| String::new())
        .map_err(limit)
}

/// `insertBefore`: `tag` before the first of `followers`, else before `</w:sectPr>`.
fn insert_before(sect_pr_xml: &str, tag: &str, followers: &jscompat::JsRegex) -> String {
    match followers.exec(sect_pr_xml) {
        Some(found) => format!(
            "{}{tag}{}",
            &sect_pr_xml[..found.start()],
            &sect_pr_xml[found.start()..]
        ),
        None => replace_first_string(sect_pr_xml, "</w:sectPr>", &format!("{tag}</w:sectPr>")),
    }
}

/// `applyPageNumType`: rewrite w:pgNumType (fmt, start); the tag is removed when both are unset.
pub fn apply_page_num_type(
    sect_pr_xml: &str,
    fmt: Option<&str>,
    start: Option<f64>,
) -> Result<String, String> {
    let xml = strip_element(sect_pr_xml, "w:pgNumType")?;
    if fmt.is_none() && start.is_none() {
        return Ok(xml);
    }
    let tag = format!(
        "<w:pgNumType{}{}/>",
        fmt.map_or(String::new(), |fmt| format!(" w:fmt=\"{fmt}\"")),
        start.map_or(String::new(), |start| format!(
            " w:start=\"{}\"",
            number_to_string(start)
        )),
    );
    Ok(insert_before(
        &xml,
        &tag,
        js_regex!(
            r"<w:(?:cols|formProt|vAlign|noEndnote|titlePg|textDirection|bidi|rtlGutter|docGrid|printerSettings)[\s/>]"
        ),
    ))
}

/// `injectIntoSectPr`: `tag` as the first child of the first sectPr (a
/// self-closing one is expanded to a pair first).
pub fn inject_into_sect_pr(xml: &str, tag: &str) -> String {
    let Some(found) = js_regex!(r"<w:sectPr(?:\s[^>]*?)?\/>|<w:sectPr(?:\s[^>]*?)?>").exec(xml)
    else {
        return xml.to_owned();
    };
    let whole = found.as_str();
    let (open, close) = match whole.strip_suffix("/>") {
        Some(head) => (format!("{head}>"), "</w:sectPr>"),
        None => (whole.to_owned(), ""),
    };
    format!(
        "{}{open}{tag}{close}{}",
        &xml[..found.start()],
        &xml[found.end()..]
    )
}

/// `roundColsInPlace`: a kept w:cols whose values were loaded fractional,
/// rounded in place.
fn round_cols_in_place(xml: &str, cols: &str) -> String {
    let rounded = js_regex!(r#" w:(num|space|w)="(\d+\.\d+)""#, "g").replace_all(cols, |found| {
        format!(
            " w:{}=\"{}\"",
            found.get(1).unwrap_or_default(),
            number_to_string(math_round(parse_float(found.get(2).unwrap_or_default())))
        )
    });
    if rounded == cols {
        xml.to_owned()
    } else {
        replace_first_string(xml, cols, &rounded)
    }
}

/// `pageBordersXml`: w:pgBorders for pageBorderProps. Without props the
/// legacy single-line box is written; props with no sides yield ''.
pub fn page_borders_xml(props: Option<&SectionSettingsPageBorderProps>) -> String {
    let sides = props.and_then(|props| props.sides.as_ref());
    let any_side = sides.is_some_and(|sides| {
        sides.top.is_some()
            || sides.left.is_some()
            || sides.bottom.is_some()
            || sides.right.is_some()
    });
    if props.is_some() && !any_side {
        return String::new();
    }
    let (Some(props), Some(sides)) = (props, sides) else {
        let side = |name: &str| {
            format!("<w:{name} w:val=\"single\" w:sz=\"4\" w:space=\"24\" w:color=\"auto\"/>")
        };
        return format!(
            "<w:pgBorders w:offsetFrom=\"page\">{}{}{}{}</w:pgBorders>",
            side("top"),
            side("left"),
            side("bottom"),
            side("right")
        );
    };
    let mut out = String::from("<w:pgBorders");
    if props.z_order.as_ref().map(|z| z.as_str()) == Some("back") {
        out.push_str(" w:zOrder=\"back\"");
    }
    if let Some(display) = &props.display {
        out.push_str(&format!(" w:display=\"{}\"", display.as_str()));
    }
    out.push_str(&format!(
        " w:offsetFrom=\"{}\">",
        props
            .offset_from
            .as_ref()
            .map_or("text", |from| from.as_str())
    ));
    for (name, side) in [
        ("top", &sides.top),
        ("left", &sides.left),
        ("bottom", &sides.bottom),
        ("right", &sides.right),
    ] {
        let Some(side) = side else { continue };
        let sz = if side.art.is_some() {
            math_round(side.width_pt.0)
        } else {
            math_round(side.width_pt.0 * 8.0)
        };
        out.push_str(&format!(
            "<w:{name} w:val=\"{}\" w:sz=\"{}\" w:space=\"{}\"",
            side.val,
            number_to_string(sz),
            number_to_string(math_round(side.space_pt.0))
        ));
        out.push_str(&format!(
            " w:color=\"{}\"",
            side.color.as_deref().unwrap_or("auto")
        ));
        if side.shadow.is_some() {
            out.push_str(" w:shadow=\"1\"");
        }
        if side.frame.is_some() {
            out.push_str(" w:frame=\"1\"");
        }
        out.push_str("/>");
    }
    out.push_str("</w:pgBorders>");
    out
}

/// `intAttr` of section.ts over the name's own pattern.
fn int_attr(tag: &str, name: &str, fallback: f64) -> Result<f64, String> {
    let pattern = format!(r#"{name}\s*=\s*["'](-?\d+(?:\.\d+)?)["']"#);
    let found = dynamic(&pattern, "")?.try_exec(tag).map_err(limit)?;
    let value = found
        .and_then(|found| found.get(1).map(parse_float))
        .map_or(f64::NAN, math_round);
    Ok(if value.is_finite() { value } else { fallback })
}

/// `replaceMarAttr` of `applySectionSettings`: an attribute as another producer
/// may spell it (either quote, white space around `=`) takes the new value in
/// its own quote; a missing one goes before the tag's `/>`.
fn replace_mar_attr(tag: &str, name: &str, value: f64) -> Result<String, String> {
    let value = number_to_string(value);
    let attr = dynamic(&format!(r#"(\s{name}\s*=\s*)(["'])[^"']*\2"#), "")?;
    if attr.try_exec(tag).map_err(limit)?.is_some() {
        return replace_first(&attr, 2, tag, &format!("$1$2{value}$2"));
    }
    replace_first(
        &dynamic(r"\s*\/>$", "")?,
        0,
        tag,
        &format!(" {name}=\"{value}\"/>"),
    )
}

/// `applySectionSettings`: rewrite pgSz / pgMar / borders / columns / bidi
/// inside a w:sectPr XML slice, preserving everything else.
pub fn apply_section_settings(
    sect_pr_xml: &str,
    settings: &SectionSettings,
) -> Result<String, String> {
    let orient = if settings.orientation == SectionSettingsOrientation::Landscape {
        " w:orient=\"landscape\""
    } else {
        ""
    };
    let pg_sz = format!(
        "<w:pgSz w:w=\"{}\" w:h=\"{}\"{orient}/>",
        number_to_string(settings.page_width.0),
        number_to_string(settings.page_height.0)
    );
    let mut xml = sect_pr_xml.to_owned();
    let pg_sz_re = try_js_regex!(r"<w:pgSz[^>]*\/?>");
    if pg_sz_re.try_test(&xml).map_err(limit)? {
        xml = replace_first(pg_sz_re, 0, &xml, &pg_sz)?;
    } else {
        xml = inject_into_sect_pr(&xml, &pg_sz);
    }
    let gutter_at_top = settings.gutter_at_top.unwrap_or(false);
    let gutter = settings.gutter.map_or(0.0, |g| g.0);
    let mar_re = try_js_regex!(r"<w:pgMar[^>]*\/>");
    if let Some(found) = mar_re.try_exec(&xml).map_err(limit)? {
        let whole = found.as_str().to_owned();
        let mut tag = whole.clone();
        // the gutter was folded into the parsed margin; a margin below it writes 0
        let top = math_max(
            0.0,
            settings.margin_top.0 - if gutter_at_top { gutter } else { 0.0 },
        );
        let top = if settings.margin_top_fixed.unwrap_or(false) {
            -top
        } else {
            top
        };
        tag = replace_mar_attr(&tag, "w:top", top)?;
        tag = replace_mar_attr(&tag, "w:right", settings.margin_right.0)?;
        let bottom = if settings.margin_bottom_fixed.unwrap_or(false) {
            -settings.margin_bottom.0
        } else {
            settings.margin_bottom.0
        };
        tag = replace_mar_attr(&tag, "w:bottom", bottom)?;
        tag = replace_mar_attr(
            &tag,
            "w:left",
            math_max(
                0.0,
                settings.margin_left.0 - if gutter_at_top { 0.0 } else { gutter },
            ),
        )?;
        if let Some(dist) = settings.header_dist {
            tag = replace_mar_attr(&tag, "w:header", dist.0)?;
        }
        if let Some(dist) = settings.footer_dist {
            tag = replace_mar_attr(&tag, "w:footer", dist.0)?;
        }
        if settings.gutter.is_some() {
            tag = replace_mar_attr(&tag, "w:gutter", gutter)?;
        }
        xml = replace_first_string(&xml, &whole, &tag);
    } else {
        let pg_mar = format!(
            "<w:pgMar w:top=\"{}\" w:right=\"{}\" w:bottom=\"{}\" w:left=\"{}\" w:header=\"708\" w:footer=\"708\" w:gutter=\"{}\"/>",
            number_to_string(settings.margin_top.0 - if gutter_at_top { gutter } else { 0.0 }),
            number_to_string(settings.margin_right.0),
            number_to_string(settings.margin_bottom.0),
            number_to_string(settings.margin_left.0 - if gutter_at_top { 0.0 } else { gutter }),
            number_to_string(gutter),
        );
        xml = replace_first_string(&xml, "</w:sectPr>", &format!("{pg_mar}</w:sectPr>"));
    }

    // page border (pgBorders sits between pgMar and cols in CT_SectPr)
    xml = replace_first(
        try_js_regex!(r"<w:pgBorders[^>]*\/>|<w:pgBorders[\s\S]*?<\/w:pgBorders>"),
        0,
        &xml,
        "",
    )?;
    if settings.page_border {
        let pg_borders = page_borders_xml(settings.page_border_props.as_ref());
        if !pg_borders.is_empty() {
            xml = replace_first(
                try_js_regex!(r"(<w:pgMar[^>]*\/>)"),
                1,
                &xml,
                &format!("$1{pg_borders}"),
            )?;
        }
    }

    // columns (w:cols may be self-closing or carry explicit <w:col> children)
    let cols_re = try_js_regex!(r"<w:cols[^>]*\/>|<w:cols[^>]*>[\s\S]*?<\/w:cols>");
    let cols_match = cols_re
        .try_exec(&xml)
        .map_err(limit)?
        .map(|found| found.as_str().to_owned());
    let columns = settings.columns.0;
    let num_attr = if columns > 1.0 {
        format!(" w:num=\"{}\"", number_to_string(columns))
    } else {
        String::new()
    };
    let cols_anchor = |xml: &str, tag: &str| -> Result<String, String> {
        let anchor = try_js_regex!(r"(<w:pgBorders[\s\S]*?<\/w:pgBorders>|<w:pgMar[^>]*\/>)")
            .try_exec(xml)
            .map_err(limit)?;
        Ok(match anchor {
            Some(anchor) => {
                let whole = anchor.as_str();
                replace_first_string(xml, whole, &format!("{whole}{tag}"))
            }
            None => replace_first_string(xml, "</w:sectPr>", &format!("{tag}</w:sectPr>")),
        })
    };
    let col_widths = settings.col_widths.as_ref();
    if let Some(widths) =
        col_widths.filter(|widths| columns > 1.0 && widths.len() as f64 == columns)
    {
        // explicit unequal widths: rebuild the element unless the document already carries them
        let current_widths: Vec<f64> = match &cols_match {
            Some(cols) => {
                let mut found_widths = Vec::new();
                for tag in try_js_regex!(r#"<w:col [^>]*w:w=["'][\d.]+["'][^>]*>"#, "g")
                    .try_find_iter(cols)
                {
                    let tag = tag.map_err(limit)?;
                    found_widths.push(int_attr(tag.as_str(), "w:w", 0.0)?);
                }
                found_widths
            }
            None => Vec::new(),
        };
        let unchanged = match &cols_match {
            Some(cols) => {
                int_attr(cols, "w:num", 1.0)? == columns
                    && current_widths.len() == widths.len()
                    && current_widths
                        .iter()
                        .zip(widths)
                        .all(|(have, want)| *have == want.0)
            }
            None => false,
        };
        if !unchanged {
            let space = number_to_string(settings.col_space.map_or(720.0, |s| s.0));
            let last = widths.len() - 1;
            let children: String = widths
                .iter()
                .enumerate()
                .map(|(i, w)| {
                    let w = number_to_string(w.0);
                    if i < last {
                        format!("<w:col w:w=\"{w}\" w:space=\"{space}\"/>")
                    } else {
                        format!("<w:col w:w=\"{w}\"/>")
                    }
                })
                .collect();
            let tag = format!(
                "<w:cols{num_attr} w:space=\"{space}\" w:equalWidth=\"0\">{children}</w:cols>"
            );
            xml = match &cols_match {
                Some(cols) => replace_first_string(&xml, cols, &tag),
                None => cols_anchor(&xml, &tag)?,
            };
        } else if let Some(cols) = &cols_match {
            xml = round_cols_in_place(&xml, cols);
        }
    } else if let Some(cols) = &cols_match {
        let open_tag = try_js_regex!(r"^<w:cols[^>]*>")
            .try_exec(cols)
            .map_err(limit)?
            .map_or(cols.as_str(), |found| found.as_str())
            .to_owned();
        let self_closing = cols.ends_with("/>");
        let current_num = number_to_string(int_attr(&open_tag, "w:num", 1.0)?);
        if self_closing || current_num != number_to_string(columns) {
            // explicit per-column widths only stay valid while the count is unchanged
            let mut tag = replace_first(try_js_regex!(r#" w:num="[\d.]+""#), 0, &open_tag, "")?;
            tag = replace_first(try_js_regex!(r"\/?>$"), 0, &tag, "/>")?;
            if !num_attr.is_empty() {
                tag = replace_first(
                    try_js_regex!(r"^<w:cols"),
                    0,
                    &tag,
                    &format!("<w:cols{num_attr}"),
                )?;
            }
            // an explicitly different column gap (720 = OOXML default); equal values keep the tag
            if let Some(col_space) = settings.col_space
                && col_space.0 != int_attr(&tag, "w:space", 720.0)?
            {
                let space = number_to_string(col_space.0);
                let space_re = try_js_regex!(r#" w:space="[\d.]+""#);
                tag = if space_re.try_test(&tag).map_err(limit)? {
                    replace_first(space_re, 0, &tag, &format!(" w:space=\"{space}\""))?
                } else {
                    replace_first(
                        try_js_regex!(r"\/>$"),
                        0,
                        &tag,
                        &format!(" w:space=\"{space}\"/>"),
                    )?
                };
            }
            xml = replace_first_string(&xml, cols, &tag);
        } else {
            xml = round_cols_in_place(&xml, cols);
        }
    } else if !num_attr.is_empty() {
        let space = number_to_string(settings.col_space.map_or(425.0, |s| s.0));
        xml = cols_anchor(&xml, &format!("<w:cols{num_attr} w:space=\"{space}\"/>"))?;
    }

    // section direction (w:bidi, after cols in CT_SectPr): undefined keeps the tag
    if let Some(want_bidi) = settings.bidi {
        let bidi_re = try_js_regex!(r"<w:bidi(?=[\s/>])[^>]*(?:\/>|>[\s\S]*?<\/w:bidi>)", "i");
        let has_bidi = bidi_re.try_test(&xml).map_err(limit)?;
        if want_bidi && has_bidi {
            let on = on_off_tag_in(&xml, "w:bidi").map_err(|e| e.to_string())?;
            if on.is_none_or(|on| !on) {
                xml = replace_first(bidi_re, 0, &xml, "<w:bidi/>")?;
            }
        } else if want_bidi {
            if js_regex!(r"<w:docGrid").test(&xml) {
                xml = replace_first(try_js_regex!(r"(<w:docGrid)"), 1, &xml, "<w:bidi/>$1")?;
            } else {
                xml = replace_first_string(&xml, "</w:sectPr>", "<w:bidi/></w:sectPr>");
            }
        } else if has_bidi {
            xml = replace_first(bidi_re, 0, &xml, "")?;
        }
    }
    Ok(xml)
}

/// `applySectionStartType`: rewrite w:type; nextPage is written by removing the tag.
pub fn apply_section_start_type(sect_pr_xml: &str, kind: &str) -> Result<String, String> {
    let mut xml = strip_element(sect_pr_xml, "w:type")?;
    if kind == "nextPage" {
        return Ok(xml);
    }
    let tag = format!("<w:type w:val=\"{kind}\"/>");
    if js_regex!(r"<w:pgSz").test(&xml) {
        xml = replace_first(try_js_regex!(r"(<w:pgSz)"), 1, &xml, &format!("{tag}$1"))?;
    } else {
        xml = inject_into_sect_pr(&xml, &tag);
    }
    Ok(xml)
}

/// `applyTitlePg`: set or remove w:titlePg at its CT_SectPr position.
pub fn apply_title_pg(sect_pr_xml: &str, on: bool) -> Result<String, String> {
    let xml = strip_element(sect_pr_xml, "w:titlePg")?;
    Ok(if on {
        insert_before(
            &xml,
            "<w:titlePg/>",
            js_regex!(r"<w:(?:textDirection|bidi|rtlGutter|docGrid|printerSettings)[\s/>]"),
        )
    } else {
        xml
    })
}
