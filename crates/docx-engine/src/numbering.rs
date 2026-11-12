//! word/numbering.xml as per-numId level definitions (`parseNumbering` of
//! packages/docx-engine/src/parse-package.ts).

use jscompat::{
    JsMap, JsNum, JsObject, Radix, Slot, js_object, js_regex, number_to_string, parse_int, trim,
    truthy,
};
use ooxml_pkg::Package;
use ooxml_xml::XNode;
use serde::{Deserialize, Serialize};

use crate::package::{Thrown, parse_part, part_text};
use crate::xml_text::{decode_numeric_char_refs, on_off_of};

js_object! {
    deserialize;
    /// One w:lvl of a numbering definition. The reader of the part and the
    /// list dialogs (`numberingLevelFromCustom`) write its keys in orders of
    /// their own.
    #[derive(Debug, Clone, PartialEq)]
    pub struct NumberingLevel {
        pub num_fmt: String,
        pub lvl_text: String,
        pub start: JsNum,
        pub custom_format: String,
        pub suff: String,
        pub is_lgl: bool,
        pub lvl_jc: String,
        pub p_style: String,
        pub lvl_restart: JsNum,
        pub bidi: bool,
        pub tab_stop: JsNum,
        pub indent_left: JsNum,
        pub indent_right: JsNum,
        pub hanging: JsNum,
        pub first_line: JsNum,
        pub sz_half_points: JsNum,
        pub color: String,
        pub bold: bool,
        pub italic: bool,
        pub font: String,
        pub pic_bullet_id: JsNum,
        pub pic_bullet_src: String,
    }
}

impl NumberingLevel {
    /// `level.numFmt`: every level has it.
    pub fn num_fmt(&self) -> &str {
        self.num_fmt.as_deref().unwrap_or_default()
    }

    /// `level.lvlText`: every level has it.
    pub fn lvl_text(&self) -> &str {
        self.lvl_text.as_deref().unwrap_or_default()
    }

    /// `level.start`: every level has it.
    pub fn start(&self) -> f64 {
        self.start.map_or(0.0, |start| start.0)
    }
}

/// Levels by ilvl. The key is the number as JavaScript writes an object key.
pub type Levels = JsObject<NumberingLevel>;

/// One w:num of word/numbering.xml: the levels of its abstractNum with the
/// overrides applied.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NumberingDef {
    pub num_id: String,
    /// Counters continue across w:num entries that share an abstractNum.
    pub abstract_num_id: String,
    pub levels: Levels,
    /// ilvl to the w:startOverride value.
    pub start_overrides: JsObject<JsNum>,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Numbering {
    /// numId to "bullet" or "ordered".
    pub formats: JsMap<&'static str>,
    pub defs: JsMap<NumberingDef>,
    /// w:numPicBulletId to the image relationship id, in document order.
    pub pic_bullets: Vec<(JsNum, String)>,
}

fn val_of<'a>(parent: &'a XNode, child: &str) -> Option<&'a str> {
    parent.find_child(child)?.attr("w:val")
}

fn int_of(value: Option<&str>) -> f64 {
    parse_int(value.unwrap_or(""), Radix::Ten)
}

/// `customEnumItems` of list-markers.ts: a w14 custom format is a list of at
/// least two items, with an optional trailing ellipsis.
fn is_custom_enum(format: &str) -> bool {
    let mut items: Vec<&str> = format.split(',').map(trim).collect();
    while items
        .last()
        .is_some_and(|last| js_regex!(r"^(\.{3}|\u2026)?$").test(last))
    {
        items.pop();
    }
    items.len() >= 2 && items.iter().all(|item| !item.is_empty())
}

/// w:numFmt of a w:lvl, including a w14 custom format hidden in
/// mc:AlternateContent (mc:Choice has val="custom" and w:format, mc:Fallback
/// the standard substitute).
fn num_fmt_of_level(lvl_node: &XNode) -> (Option<&str>, Option<&str>) {
    if let Some(direct) = lvl_node.find_child("w:numFmt") {
        return (direct.attr("w:val"), None);
    }
    let Some(alt) = lvl_node.children().iter().find(|child| {
        child
            .name()
            .is_some_and(|name| name.ends_with(":AlternateContent"))
    }) else {
        return (None, None);
    };
    let pick = |suffix: &str| {
        alt.children()
            .iter()
            .find(|child| child.name().is_some_and(|name| name.ends_with(suffix)))
            .and_then(|branch| branch.find_child("w:numFmt"))
    };
    let choice = pick(":Choice");
    let choice_val = choice.and_then(|choice| choice.attr("w:val"));
    let format = choice.and_then(|choice| truthy(choice.attr("w:format")));
    if let Some(format) = format
        && choice_val == Some("custom")
        && is_custom_enum(format)
    {
        return (Some("custom"), Some(format));
    }
    if let Some(val) = truthy(choice_val).filter(|val| *val != "custom") {
        return (Some(val), None);
    }
    (
        pick(":Fallback").and_then(|fallback| fallback.attr("w:val")),
        None,
    )
}

fn is_switched_off(value: Option<&str>) -> bool {
    matches!(value.unwrap_or(""), "0" | "false" | "off")
}

fn parse_numbering_level(lvl_node: &XNode) -> NumberingLevel {
    let finite = |value: f64| value.is_finite().then_some(JsNum(value));
    // ECMA-376: a w:lvl without w:start starts at 0 (Word renders "0.")
    let start = parse_int(val_of(lvl_node, "w:start").unwrap_or("0"), Radix::Ten);
    let (num_fmt, custom_format) = num_fmt_of_level(lvl_node);
    let mut level = NumberingLevel {
        num_fmt: Slot::of(num_fmt.unwrap_or("decimal").to_owned()),
        lvl_text: Slot::of(
            decode_numeric_char_refs(val_of(lvl_node, "w:lvlText").unwrap_or("")).into_owned(),
        ),
        start: Slot::of(JsNum(if start.is_finite() { start } else { 0.0 })),
        ..NumberingLevel::default()
    };
    level
        .custom_format
        .set_some(truthy(custom_format).map(str::to_owned));
    level.suff.set_some(
        val_of(lvl_node, "w:suff")
            .filter(|suff| matches!(*suff, "space" | "nothing" | "tab"))
            .map(str::to_owned),
    );
    if lvl_node
        .find_child("w:isLgl")
        .is_some_and(|is_lgl| !is_switched_off(is_lgl.attr("w:val")))
    {
        level.is_lgl.set(true);
    }
    level.lvl_jc.set_some(match val_of(lvl_node, "w:lvlJc") {
        Some("right" | "end") => Some("right".to_owned()),
        Some("center") => Some("center".to_owned()),
        _ => None,
    });
    level
        .p_style
        .set_some(truthy(val_of(lvl_node, "w:pStyle")).map(str::to_owned));
    level
        .lvl_restart
        .set_some(finite(int_of(val_of(lvl_node, "w:lvlRestart"))));
    let lvl_p_pr = lvl_node.find_child("w:pPr");
    if lvl_p_pr.is_some_and(|p_pr| on_off_of(p_pr, "w:bidi") == Some(true)) {
        level.bidi.set(true);
    }
    let tabs = lvl_p_pr.and_then(|p_pr| p_pr.find_child("w:tabs"));
    level.tab_stop.set_some(tabs.and_then(|tabs| {
        finite(int_of(
            tabs.find_child("w:tab").and_then(|tab| tab.attr("w:pos")),
        ))
    }));
    if let Some(ind) = lvl_p_pr.and_then(|p_pr| p_pr.find_child("w:ind")) {
        // an explicit 0 is a real value, and an absent left is 0 too; left
        // and right are the logical start and end
        let left = int_of(ind.attr("w:left").or(ind.attr("w:start")));
        level
            .indent_left
            .set(JsNum(if left.is_finite() { left } else { 0.0 }));
        level
            .indent_right
            .set_some(finite(int_of(ind.attr("w:right").or(ind.attr("w:end")))));
        let hanging = int_of(ind.attr("w:hanging"));
        if hanging > 0.0 {
            level.hanging.set(JsNum(hanging));
        }
        let first_line = int_of(ind.attr("w:firstLine"));
        if level.hanging.is_none() && first_line >= 0.0 {
            level.first_line.set(JsNum(first_line));
        }
    }
    let lvl_r_pr = lvl_node.find_child("w:rPr");
    let sz = lvl_r_pr.map_or(f64::NAN, |r_pr| int_of(val_of(r_pr, "w:sz")));
    if sz > 0.0 {
        level.sz_half_points.set(JsNum(sz));
    }
    level.color.set_some(
        lvl_r_pr
            .and_then(|r_pr| val_of(r_pr, "w:color"))
            .filter(|color| js_regex!("^[0-9a-f]{6}$", "i").test(color))
            .map(str::to_uppercase),
    );
    let flag = |name: &str| {
        lvl_r_pr
            .and_then(|r_pr| r_pr.find_child(name))
            .is_some_and(|element| !is_switched_off(element.attr("w:val")))
    };
    level.bold.set_some(flag("w:b").then_some(true));
    level.italic.set_some(flag("w:i").then_some(true));
    let fonts = lvl_r_pr.and_then(|r_pr| r_pr.find_child("w:rFonts"));
    let font = fonts.and_then(|fonts| {
        fonts
            .attr("w:ascii")
            .or(fonts.attr("w:hAnsi"))
            .or(fonts.attr("w:eastAsia"))
    });
    level.font.set_some(truthy(font).map(str::to_owned));
    level
        .pic_bullet_id
        .set_some(finite(int_of(val_of(lvl_node, "w:lvlPicBulletId"))));
    level
}

/// The image relationship id inside a w:numPicBullet (VML v:imagedata or
/// DrawingML a:blip). The first such element decides, even without an id.
fn pic_bullet_r_id(node: &XNode) -> Option<&str> {
    for child in node.children() {
        match child.name() {
            None => continue,
            Some("v:imagedata") => return child.attr("r:id"),
            Some("a:blip") => return child.attr("r:embed"),
            Some(_) => {
                if let Some(nested) = truthy(pic_bullet_r_id(child)) {
                    return Some(nested);
                }
            }
        }
    }
    None
}

/// An ilvl as the key of a JavaScript object.
fn level_key(ilvl: f64) -> String {
    number_to_string(ilvl)
}

pub fn parse_numbering(package: &Package) -> Result<Numbering, Thrown> {
    let mut numbering = Numbering::default();
    let Some(text) = part_text(package, "word/numbering.xml")? else {
        return Ok(numbering);
    };
    let parsed = parse_part(text)?;
    let Some(root) = parsed
        .iter()
        .find(|node| node.name() == Some("w:numbering"))
    else {
        return Ok(numbering);
    };

    for pic in root.find_children("w:numPicBullet") {
        let id = int_of(pic.attr("w:numPicBulletId"));
        if let Some(r_id) = truthy(pic_bullet_r_id(pic))
            && id.is_finite()
        {
            // a Map keyed by number: -0 is 0, and a key set again keeps its place
            let id = JsNum(id + 0.0);
            match numbering
                .pic_bullets
                .iter_mut()
                .find(|(existing, _)| *existing == id)
            {
                Some(entry) => entry.1 = r_id.to_owned(),
                None => numbering.pic_bullets.push((id, r_id.to_owned())),
            }
        }
    }

    let mut abs_levels: JsMap<Levels> = JsMap::new();
    let mut num_style_links: JsMap<String> = JsMap::new();
    let mut style_link_abs: JsMap<String> = JsMap::new();
    for abs in root.find_children("w:abstractNum") {
        let Some(abs_id) = truthy(abs.attr("w:abstractNumId")) else {
            continue;
        };
        let mut levels = Levels::new();
        for lvl in abs.find_children("w:lvl") {
            let ilvl = int_of(lvl.attr("w:ilvl"));
            if ilvl.is_finite() {
                levels.set(level_key(ilvl), parse_numbering_level(lvl));
            }
        }
        abs_levels.set(abs_id, levels);
        if let Some(num_style_link) = truthy(val_of(abs, "w:numStyleLink")) {
            num_style_links.set(abs_id, num_style_link.to_owned());
        }
        if let Some(style_link) = truthy(val_of(abs, "w:styleLink")) {
            style_link_abs.set(style_link, abs_id.to_owned());
        }
    }
    // w:numStyleLink indirection: the abstractNum refers to a numbering
    // style; the real levels live on the abstractNum with the matching
    // w:styleLink
    for abs_id in num_style_links.keys() {
        let mut seen = vec![abs_id];
        let mut target = abs_id;
        loop {
            let next = num_style_links
                .get(target)
                .and_then(|style_id| style_link_abs.get(style_id));
            match next {
                Some(next) if !seen.contains(&&**next) => {
                    seen.push(next);
                    target = next;
                }
                _ => break,
            }
        }
        if target != abs_id {
            // `{ ...abstractLevels.get(target), ...abstractLevels.get(absId) }`
            let mut merged = abs_levels.get(target).cloned().unwrap_or_default();
            if let Some(own) = abs_levels.get(abs_id) {
                merged.assign(own);
            }
            abs_levels.set(abs_id, merged);
        }
    }
    for num in root.find_children("w:num") {
        let (Some(num_id), Some(abs_id)) = (
            truthy(num.attr("w:numId")),
            truthy(val_of(num, "w:abstractNumId")),
        ) else {
            continue;
        };
        let mut levels = abs_levels.get(abs_id).cloned().unwrap_or_default();
        let mut start_overrides = JsObject::new();
        for over in num.find_children("w:lvlOverride") {
            let ilvl = int_of(over.attr("w:ilvl"));
            if !ilvl.is_finite() {
                continue;
            }
            if let Some(start_val) = val_of(over, "w:startOverride") {
                let n = parse_int(start_val, Radix::Ten);
                if n.is_finite() {
                    start_overrides.set(level_key(ilvl), JsNum(n));
                }
            }
            if let Some(lvl) = over.find_child("w:lvl") {
                levels.set(level_key(ilvl), parse_numbering_level(lvl));
            }
        }
        let format = if levels
            .get("0")
            .is_some_and(|level| level.num_fmt.as_deref() == Some("bullet"))
        {
            "bullet"
        } else {
            "ordered"
        };
        numbering.defs.set(
            num_id,
            NumberingDef {
                num_id: num_id.to_owned(),
                abstract_num_id: abs_id.to_owned(),
                levels,
                start_overrides,
            },
        );
        numbering.formats.set(num_id, format);
    }
    Ok(numbering)
}
