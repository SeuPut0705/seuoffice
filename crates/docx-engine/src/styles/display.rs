//! What one w:style element contributes on screen (`styleDisplayOf`,
//! `tableStyleDisplayOf`, `tableParaProps` of parse-styles.ts).

use jscompat::{JsNum, Radix, js_regex, math_round, parse_int, truthy};
use ooxml_xml::XNode;

use crate::drawing_geometry::w14_text_outline_of;
use crate::props::{
    auto_space_flags_of, cell_margins_of, char_indents_of, indent_twips_of, merged_border_lines_of,
    para_border_sides_of, row_band_size_of, shd_display_fill, tab_stops_of, themed_r_fonts,
};
use crate::styles::model::{
    Margins, StyleDisplay, TabStops, TableCondFormat, TableParaSpacing, TableStyleDisplay,
    WholeTable,
};
use crate::styles::run_border_of;
use crate::theme::{ThemeColors, ThemeFonts};
use crate::xml_text::{auto_color_of, bool_prop, color_from, line_twips_of, on_off_of, strip_hash};

/// `attrsOf(findChild(node, name) ?? {})[key]`
fn child_attr<'a>(node: &'a XNode, name: &str, key: &str) -> Option<&'a str> {
    node.find_child(name).and_then(|child| child.attr(key))
}

/// `parseInt(x, 10) || undefined`: NaN and 0 leave the key holding `undefined`.
fn int_or_undefined(text: &str) -> Option<JsNum> {
    let n = parse_int(text, Radix::Ten);
    (n != 0.0 && !n.is_nan()).then_some(JsNum(n))
}

/// `parseInt(x, 10) || 0`
fn int_or_zero(text: &str) -> JsNum {
    let n = parse_int(text, Radix::Ten);
    JsNum(if n.is_nan() { 0.0 } else { n })
}

/// `attrs[key] === '1' || attrs[key] === 'true'`
fn one_or_true(value: &str) -> bool {
    value == "1" || value == "true"
}

/// w:pPr spacing and w:jc a table style (or one of its conditions) hands its
/// cell paragraphs: `(paraSpacing, paraJc)`.
fn table_para_props(p_pr: Option<&XNode>) -> (Option<TableParaSpacing>, Option<String>) {
    let mut para_jc = None;
    let mut para_spacing = None;
    let Some(p_pr) = p_pr else {
        return (para_spacing, para_jc);
    };
    let jc = child_attr(p_pr, "w:jc", "w:val");
    if let Some(jc) = truthy(jc) {
        para_jc = Some(jc.to_owned());
    }
    if let Some(spacing) = p_pr.find_child("w:spacing") {
        let mut ps = TableParaSpacing::default();
        let before = parse_int(spacing.attr("w:before").unwrap_or(""), Radix::Ten);
        if before >= 0.0 && spacing.attr("w:before").is_some() {
            ps.before_twips = Some(JsNum(before));
        }
        let after = parse_int(spacing.attr("w:after").unwrap_or(""), Radix::Ten);
        if after >= 0.0 && spacing.attr("w:after").is_some() {
            ps.after_twips = Some(JsNum(after));
        }
        let line = line_twips_of(spacing.attr("w:line"));
        if line > 0.0 {
            ps.line_raw_twips = Some(JsNum(line));
            let rule = spacing.attr("w:lineRule").unwrap_or("auto");
            ps.line_rule = Some(rule.to_owned());
            if rule == "auto" {
                ps.line_spacing = Some(JsNum(math_round(line / 240.0 * 100.0) / 100.0));
            }
        }
        if ps != TableParaSpacing::default() {
            para_spacing = Some(ps);
        }
    }
    (para_spacing, para_jc)
}

/// `w:caps` ('all') / `w:smallCaps` ('small'), 'none' for an explicit off.
fn caps_of(r_pr: &XNode) -> Option<&'static str> {
    let caps_on = on_off_of(r_pr, "w:caps");
    let small_caps_on = on_off_of(r_pr, "w:smallCaps");
    if caps_on == Some(true) {
        Some("all")
    } else if small_caps_on == Some(true) {
        Some("small")
    } else if caps_on == Some(false) || small_caps_on == Some(false) {
        Some("none")
    } else {
        None
    }
}

/// `parseInt(attrsOf(findChild(rPr, 'w:spacing') ?? {})['w:val'] ?? '', 10)`, kept unless NaN.
fn char_spacing_of(r_pr: &XNode) -> Option<JsNum> {
    let spc = parse_int(
        child_attr(r_pr, "w:spacing", "w:val").unwrap_or(""),
        Radix::Ten,
    );
    (!spc.is_nan()).then_some(JsNum(spc))
}

/// Fills and first-row formatting a table style contributes on screen.
pub(crate) fn table_style_display_of(
    style_node: &XNode,
    theme: Option<&ThemeColors>,
    theme_fonts: Option<&ThemeFonts>,
) -> Option<TableStyleDisplay> {
    let mut display = TableStyleDisplay::default();
    let shd_fill = |node: Option<&XNode>| -> Option<String> {
        let fill = node.and_then(|node| child_attr(node, "w:shd", "w:fill"));
        truthy(fill)
            .filter(|fill| *fill != "auto")
            .map(|fill| strip_hash(fill).to_owned())
            .filter(|fill| !fill.is_empty())
    };
    let base_fill = shd_fill(style_node.find_child("w:tcPr"));
    if base_fill.is_some() {
        display.fill = base_fill;
    }
    let sz_half_of = |r_pr: Option<&XNode>| -> Option<JsNum> {
        let val = parse_int(
            r_pr.and_then(|r_pr| child_attr(r_pr, "w:sz", "w:val"))
                .unwrap_or(""),
            Radix::Ten,
        );
        (val > 0.0).then_some(JsNum(val))
    };
    let style_r_pr = style_node.find_child("w:rPr");
    if let Some(style_r_pr) = style_r_pr {
        let mut whole_table = WholeTable::default();
        let color = color_from(Some(style_r_pr), theme).filter(|color| !color.is_empty());
        if color.is_some() {
            whole_table.color = color;
        }
        if bool_prop(style_r_pr, "w:b") {
            whole_table.bold = Some(true);
        }
        if bool_prop(style_r_pr, "w:i") {
            whole_table.italic = Some(true);
        }
        let sz = sz_half_of(Some(style_r_pr));
        if sz.is_some() {
            whole_table.size_half_points = sz;
        }
        let kern = child_attr(style_r_pr, "w:kern", "w:val");
        if let Some(kern) = kern {
            whole_table.kern_half_points = Some(int_or_zero(kern));
        }
        if whole_table != WholeTable::default() {
            display.whole_table = Some(whole_table);
        }
    }
    for cond in style_node.find_children("w:tblStylePr") {
        let kind = cond.attr("w:type");
        let tc_pr = cond.find_child("w:tcPr");
        let fill = shd_fill(tc_pr);
        if let Some(kind @ ("firstRow" | "firstCol" | "lastCol" | "lastRow")) = kind {
            let r_pr = cond.find_child("w:rPr");
            let mut fmt = TableCondFormat::default();
            if fill.is_some() {
                fmt.fill = fill;
            }
            if r_pr.is_some_and(|r_pr| bool_prop(r_pr, "w:b")) {
                fmt.bold = Some(true);
            }
            if r_pr.is_some_and(|r_pr| bool_prop(r_pr, "w:i")) {
                fmt.italic = Some(true);
            }
            let color = color_from(r_pr, theme).filter(|color| !color.is_empty());
            if color.is_some() {
                fmt.color = color;
            }
            let sz = sz_half_of(r_pr);
            if sz.is_some() {
                fmt.size_half_points = sz;
            }
            if let Some(r_pr) = r_pr {
                fmt.caps = caps_of(r_pr);
                let empty = XNode::empty();
                let rf = themed_r_fonts(r_pr.find_child("w:rFonts").unwrap_or(&empty), theme_fonts);
                if let Some(ascii) = truthy(rf.ascii.as_deref()) {
                    fmt.font_ascii = Some(ascii.to_owned());
                }
                let spc = char_spacing_of(r_pr);
                if spc.is_some() {
                    fmt.char_spacing_twips = spc;
                }
            }
            let borders = merged_border_lines_of(tc_pr, "w:tcBorders", false);
            if borders.is_some() {
                fmt.borders = borders;
            }
            let tc_mar = cell_margins_of(tc_pr.and_then(|tc_pr| tc_pr.find_child("w:tcMar")));
            if let Some(tc_mar) = tc_mar {
                fmt.cell_mar_twips = Some(Margins(tc_mar));
            }
            let (para_spacing, para_jc) = table_para_props(cond.find_child("w:pPr"));
            if para_spacing.is_some() {
                fmt.para_spacing = para_spacing;
            }
            if para_jc.is_some() {
                fmt.para_jc = para_jc;
            }
            if fmt != TableCondFormat::default() {
                let slot = match kind {
                    "firstRow" => &mut display.first_row,
                    "firstCol" => &mut display.first_col,
                    "lastCol" => &mut display.last_col,
                    _ => &mut display.last_row,
                };
                *slot = Some(fmt);
            }
        } else if kind == Some("band1Horz") && fill.is_some() {
            display.band1_fill = fill;
        } else if kind == Some("band2Horz") && fill.is_some() {
            display.band2_fill = fill;
        }
    }
    let style_tbl_pr = style_node.find_child("w:tblPr");
    let band_size = row_band_size_of(style_tbl_pr);
    if let Some(band_size) = band_size {
        display.row_band_size = Some(JsNum(band_size));
    }
    let borders = merged_border_lines_of(style_tbl_pr, "w:tblBorders", true);
    if borders.is_some() {
        display.borders = borders;
    }
    let cell_mar =
        cell_margins_of(style_tbl_pr.and_then(|tbl_pr| tbl_pr.find_child("w:tblCellMar")));
    if let Some(cell_mar) = cell_mar {
        display.cell_mar_twips = Some(Margins(cell_mar));
    }
    let (para_spacing, para_jc) = table_para_props(style_node.find_child("w:pPr"));
    if para_spacing.is_some() {
        display.para_spacing = para_spacing;
    }
    if para_jc.is_some() {
        display.para_jc = para_jc;
    }
    (display != TableStyleDisplay::default()).then_some(display)
}

/// Display-only formatting the style contributes on screen.
pub(crate) fn style_display_of(
    style_node: &XNode,
    theme: Option<&ThemeColors>,
    theme_fonts: Option<&ThemeFonts>,
) -> Option<StyleDisplay> {
    let mut display = StyleDisplay::default();
    let r_pr = style_node.find_child("w:rPr");
    if let Some(r_pr) = r_pr {
        let sz = child_attr(r_pr, "w:sz", "w:val");
        if let Some(sz) = truthy(sz) {
            display.size_half_points = Some(int_or_undefined(sz));
        }
        // `colorFrom(...) ?? autoColorOf(...)`: an empty colour is not nullish
        let color = color_from(Some(r_pr), theme)
            .or_else(|| auto_color_of(Some(r_pr)).map(str::to_owned))
            .filter(|color| !color.is_empty());
        if color.is_some() {
            display.color = color;
        }
        let bold = on_off_of(r_pr, "w:b");
        if bold.is_some() {
            display.bold = bold;
        }
        let italic = on_off_of(r_pr, "w:i");
        if italic.is_some() {
            display.italic = italic;
        }
        let bold_cs = on_off_of(r_pr, "w:bCs");
        if bold_cs.is_some() {
            display.bold_cs = bold_cs;
        }
        let italic_cs = on_off_of(r_pr, "w:iCs");
        if italic_cs.is_some() {
            display.italic_cs = italic_cs;
        }
        let sz_cs = child_attr(r_pr, "w:szCs", "w:val");
        if let Some(sz_cs) = truthy(sz_cs) {
            display.size_cs_half_points = Some(int_or_undefined(sz_cs));
        }
        let rtl = on_off_of(r_pr, "w:rtl");
        if rtl.is_some() {
            display.rtl = rtl;
        }
        let u = child_attr(r_pr, "w:u", "w:val");
        if let Some(u) = truthy(u) {
            display.underline = Some(u != "none");
        }
        let strike = on_off_of(r_pr, "w:strike");
        if strike.is_some() {
            display.strike = strike;
        }
        let bdr = r_pr.find_child("w:bdr").and_then(run_border_of);
        if bdr.is_some() {
            display.bdr = bdr;
        }
        let empty = XNode::empty();
        let rf = themed_r_fonts(r_pr.find_child("w:rFonts").unwrap_or(&empty), theme_fonts);
        // `??`, not `||`: an empty eastAsia literal is the font and is falsy below
        let font = rf.east_asia.clone().or_else(|| rf.ascii.clone());
        if let Some(ascii) = truthy(rf.ascii.as_deref()) {
            display.font_ascii = Some(ascii.to_owned());
        }
        if let Some(east_asia) = truthy(rf.east_asia.as_deref()).filter(|_| !rf.ea_slot_empty) {
            display.east_asia_font = Some(east_asia.to_owned());
        }
        if let Some(cs) = truthy(rf.cs.as_deref()) {
            display.cs_font = Some(cs.to_owned());
        }
        if let Some(font) = truthy(font.as_deref()) {
            display.font = Some(font.to_owned());
        }
        if rf.ea_slot_empty && truthy(font.as_deref()).is_some() && font == rf.east_asia {
            display.ea_slot_empty = Some(true);
        }
        let spc = char_spacing_of(r_pr);
        if spc.is_some() {
            display.char_spacing_twips = spc;
        }
        let kern = child_attr(r_pr, "w:kern", "w:val");
        if let Some(kern) = kern {
            display.kern_half_points = Some(int_or_zero(kern));
        }
        let ea_lang = child_attr(r_pr, "w:lang", "w:eastAsia");
        if let Some(ea_lang) = truthy(ea_lang) {
            display.east_asia_lang = Some(ea_lang.to_owned());
        }
        display.caps = caps_of(r_pr);
        let shading =
            shd_display_fill(r_pr.find_child("w:shd"), theme).filter(|fill| !fill.is_empty());
        if shading.is_some() {
            display.shading = shading;
        }
        let outline = w14_text_outline_of(r_pr, theme);
        if outline.is_some() {
            display.text_outline = outline;
        }
        // w:specVanish marks a style separator, not hidden text
        let vanish = on_off_of(r_pr, "w:vanish");
        if vanish.is_some() && on_off_of(r_pr, "w:specVanish") != Some(true) {
            display.vanish = vanish;
        }
    }
    let p_pr = style_node.find_child("w:pPr");
    if let Some(p_pr) = p_pr {
        let spacing = p_pr.find_child("w:spacing");
        let spacing_attr = |key| spacing.and_then(|spacing| spacing.attr(key));
        let line = line_twips_of(spacing_attr("w:line"));
        if line > 0.0 {
            let rule = spacing_attr("w:lineRule").unwrap_or("auto");
            display.line_rule = Some(rule.to_owned());
            display.line_raw_twips = Some(JsNum(line));
            if rule == "auto" {
                display.line_spacing = Some(JsNum(line / 240.0));
            }
        }
        if let Some(before) = spacing_attr("w:before") {
            display.space_before_twips = Some(int_or_zero(before));
        }
        if let Some(after) = spacing_attr("w:after") {
            display.space_after_twips = Some(int_or_zero(after));
        }
        if let Some(auto) = spacing_attr("w:beforeAutospacing") {
            display.space_before_auto = Some(one_or_true(auto));
        }
        if let Some(auto) = spacing_attr("w:afterAutospacing") {
            display.space_after_auto = Some(one_or_true(auto));
        }
        if bool_prop(p_pr, "w:keepNext") {
            display.keep_next = Some(true);
        }
        if bool_prop(p_pr, "w:keepLines") {
            display.keep_lines = Some(true);
        }
        display.suppress_line_numbers = on_off_of(p_pr, "w:suppressLineNumbers");
        display.page_break_before = on_off_of(p_pr, "w:pageBreakBefore");
        display.widow_control = on_off_of(p_pr, "w:widowControl");
        display.suppress_auto_hyphens = on_off_of(p_pr, "w:suppressAutoHyphens");
        display.contextual_spacing = on_off_of(p_pr, "w:contextualSpacing");
        let auto_space = auto_space_flags_of(p_pr);
        display.auto_space_de = auto_space.de;
        display.auto_space_dn = auto_space.dn;
        display.word_wrap = on_off_of(p_pr, "w:wordWrap");
        display.overflow_punct = on_off_of(p_pr, "w:overflowPunct");
        let jc = child_attr(p_pr, "w:jc", "w:val");
        if let Some(jc @ ("center" | "right" | "left" | "justify")) = jc {
            display.align = Some(match jc {
                "center" => "center",
                "right" => "right",
                "left" => "left",
                _ => "justify",
            });
        } else if jc == Some("both")
            || js_regex!("kashida$|^thaiDistribute$", "i").test(jc.unwrap_or(""))
        {
            display.align = Some("justify");
        } else if jc == Some("distribute") {
            display.align = Some("distribute");
        }
        display.bidi = on_off_of(p_pr, "w:bidi");
        let shd = p_pr.find_child("w:shd");
        let shd_disp = shd_display_fill(shd, theme).filter(|fill| !fill.is_empty());
        if shd_disp.is_some() {
            display.shading_fill = shd_disp;
        } else if shd.is_some() {
            display.shading_fill = Some("auto".to_owned());
        }
        let border_sides = para_border_sides_of(p_pr, theme);
        if border_sides.is_some() {
            display.border_sides = border_sides;
        }
        let stops = tab_stops_of(p_pr);
        if let Some(stops) = stops {
            display.tab_stops = Some(TabStops(stops));
        }
        if let Some(ind) = p_pr.find_child("w:ind") {
            let indent = indent_twips_of(ind);
            if indent.left.is_some() {
                display.indent_left_twips = indent.left;
            }
            if indent.right.is_some() {
                display.indent_right_twips = indent.right;
            }
            if indent.first_line.is_some() {
                display.indent_first_line_twips = indent.first_line;
            }
            // character-unit indents depend on each paragraph's text; kept raw
            // (explicit zeros included, they cancel an inherited value)
            let chars = char_indents_of(Some(ind));
            if chars.is_some() {
                display.indent_chars = chars;
            }
        }
    }
    (!display.has_no_key()).then_some(display)
}
