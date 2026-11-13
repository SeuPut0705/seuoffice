//! Field instructions of a paragraph.

use jscompat::{JsRegex, js_regex, trim};
use ooxml_xml::XNode;
use serde::Serialize;

use crate::xml_text::{decode_entities, decode_numeric_char_refs};

/// Simple instructions foldable into an editable inline-field run.
pub fn simple_inline_field() -> &'static JsRegex {
    js_regex!(r"^\s*(DATE|TIME|CREATEDATE|SAVEDATE|NUMPAGES|FILENAME|AUTHOR|PAGEREF|PAGE)\b")
}

/// Mail-merge fields. The name is captured quoted (group 1) or bare (group 2).
pub fn mergefield_instr() -> &'static JsRegex {
    js_regex!(r#"^\s*MERGEFIELD\s+(?:"([^"]*)"|(\S+))"#)
}

/// Zotero and Mendeley Word fields.
pub fn zotero_inline_field() -> &'static JsRegex {
    js_regex!(
        r"^\s*(?:ADDIN\s+)?(?:ZOTERO_(?:ITEM|BIBL|TEMP)|CSL_(?:ITEM|BIBL|TEMP|CITATION|BIBLIOGRAPHY))\b",
        "i"
    )
}

/// Every fldChar closes inside the paragraph: a stray end or an unclosed begin
/// must stay byte-preserved.
pub fn field_chars_balanced(xml: &str) -> bool {
    let mut depth = 0i64;
    for found in js_regex!(r#"<w:fldChar\b[^>]*\bw:fldCharType=(?:"(begin|end)"|'(begin|end)')"#)
        .find_iter(xml)
    {
        if found.get(1).or(found.get(2)) == Some("begin") {
            depth += 1;
        } else {
            depth -= 1;
            if depth < 0 {
                return false;
            }
        }
    }
    depth == 0
}

#[derive(Debug, PartialEq, Serialize)]
pub struct Hyperlink {
    pub href: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tooltip: Option<String>,
}

/// `HYPERLINK "url"` with an optional `\o "tip"`: the only field form folded
/// into an editable link run.
pub fn convertible_hyperlink(instr: &str) -> Option<Hyperlink> {
    let instr = decode_numeric_char_refs(instr);
    let found =
        js_regex!(r#"^\s*HYPERLINK\s+"([^"\\]+)"\s*(?:\\o\s+"([^"]*)"\s*)?$"#).exec(&instr)?;
    Some(Hyperlink {
        href: found.get(1).unwrap_or("").to_owned(),
        tooltip: found
            .get(2)
            .filter(|tip| !tip.is_empty())
            .map(str::to_owned),
    })
}

/// Every field instruction is EMBED or LINK (the object-field forms of legacy OLE).
pub fn only_ole_fields(xml: &str) -> bool {
    if xml.contains("<w:fldSimple") {
        return false;
    }
    let instrs = field_instructions(xml);
    !instrs.is_empty()
        && instrs
            .iter()
            .all(|text| js_regex!(r"^\s*(EMBED|LINK)\b").test(text))
}

fn fields_nested(xml: &str) -> bool {
    let mut depth = 0i64;
    for found in js_regex!(r#"<w:fldChar\b[^>]*\bw:fldCharType=["'](begin|end)["']"#).find_iter(xml)
    {
        if found.get(1) == Some("begin") {
            depth += 1;
            if depth > 1 {
                return true;
            }
        } else {
            depth -= 1;
        }
    }
    false
}

struct OpenField {
    text: String,
    in_result: bool,
}

/// Complex-field instructions, one string per field: Word splits a long
/// instruction over several w:instrText runs, so the fragments are joined.
/// Nested fields contribute their own entry.
pub fn field_instructions(xml: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut stack: Vec<OpenField> = Vec::new();
    for found in js_regex!(r"<w:fldChar\b[^>]*>|<w:instrText\b[^>]*>([\s\S]*?)<\/w:instrText>")
        .find_iter(xml)
    {
        if found.as_str().starts_with("<w:instrText") {
            let text = decode_entities(found.get(1).unwrap_or(""));
            match stack.last_mut() {
                Some(top) if !top.in_result => top.text.push_str(&text),
                Some(_) => {}
                None => out.push(text),
            }
            continue;
        }
        let kind = js_regex!(r#"\bw:fldCharType\s*=\s*["'](begin|separate|end)["']"#)
            .exec(found.as_str())
            .and_then(|kind| kind.get(1));
        match kind {
            Some("begin") => stack.push(OpenField {
                text: String::new(),
                in_result: false,
            }),
            Some("separate") => {
                if let Some(top) = stack.last_mut() {
                    top.in_result = true;
                }
            }
            Some("end") => out.extend(stack.pop().map(|top| top.text)),
            _ => {}
        }
    }
    out.extend(stack.into_iter().map(|open| open.text));
    out
}

/// Paragraphs whose only fields are XE, REF and the other foldable forms stay editable.
pub fn only_xe_fields(xml: &str) -> bool {
    // a fldSimple without w:instr cannot fold
    let simple: Vec<Option<&str>> = js_regex!(r"<w:fldSimple\b([^>]*)>")
        .find_iter(xml)
        .map(|found| {
            js_regex!(r#"\bw:instr="([^"]*)""#)
                .exec(found.get(1).unwrap_or(""))
                .and_then(|instr| instr.get(1))
        })
        .collect();
    if simple.iter().any(Option::is_none) {
        return false;
    }
    let instrs = field_instructions(xml);
    if instrs.is_empty() && simple.is_empty() {
        return false;
    }
    if !field_chars_balanced(xml) {
        return false;
    }
    // an instruction-less field stays editable unless it nests another field
    if instrs.iter().any(|text| trim(text).is_empty()) && fields_nested(xml) {
        return false;
    }
    let is_xe = |text: &str| js_regex!(r#"^\s*XE[\s"]"#).test(text);
    let is_ref = |text: &str| js_regex!(r"^\s*REF\s").test(text);
    let simple_ok = simple.iter().flatten().all(|raw| {
        let text = decode_entities(raw);
        is_xe(&text)
            || is_ref(&text)
            || simple_inline_field().test(&text)
            || mergefield_instr().test(&text)
    });
    if !simple_ok {
        return false;
    }
    let mut checkbox_instrs = 0usize;
    let ok = instrs.iter().all(|text| {
        if js_regex!(r"^\s*FORMCHECKBOX\s*$").test(text) {
            checkbox_instrs += 1;
            return true;
        }
        trim(text).is_empty()
            || is_xe(text)
            || is_ref(text)
            || zotero_inline_field().test(text)
            || simple_inline_field().test(text)
            || mergefield_instr().test(text)
            || convertible_hyperlink(text).is_some()
    });
    if !ok {
        return false;
    }
    // a FORMCHECKBOX without its w:checkBox definition cannot fold into a glyph run
    let check_box_defs = js_regex!(r"<w:checkBox[\s/>]").find_iter(xml).count();
    checkbox_instrs <= check_box_defs
}

#[derive(Debug, PartialEq, Serialize)]
pub struct CheckboxState {
    pub checked: bool,
}

/// `isOn` of checkbox-control.ts: an absent value means checked.
pub fn is_on(value: Option<&str>) -> bool {
    value.is_none_or(|value| matches!(&*value.to_lowercase(), "1" | "true" | "on"))
}

/// Checked state of a FORMCHECKBOX begin run (w:fldChar/w:ffData/w:checkBox):
/// w:checked wins over w:default; either element without w:val means true.
pub fn checkbox_state_of(begin_run: Option<&XNode>) -> Option<CheckboxState> {
    let check_box = begin_run?
        .find_child("w:fldChar")?
        .find_child("w:ffData")?
        .find_child("w:checkBox")?;
    let state = check_box
        .find_child("w:checked")
        .or_else(|| check_box.find_child("w:default"));
    Some(CheckboxState {
        checked: state.is_some_and(|state| is_on(state.attr("w:val"))),
    })
}
