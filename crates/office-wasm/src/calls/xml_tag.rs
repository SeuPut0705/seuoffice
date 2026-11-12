//! `xmltag.*`: xml-tag.ts. `findStartTag` takes `args.name` (a string, or
//! `{ "regex": "settingsRoot" }` for the one RegExp the engine passes, patch.ts
//! `/^(?:[A-Za-z0-9._-]+:)?settings$/`, or absent for any element) and
//! `args.from` in UTF-16 units, and answers its offsets in UTF-16 units;
//! `removeElements` takes `args.name` and `args.limit` (absent: no limit).

use docx_engine::xml_tag::{TagName, find_start_tag, remove_elements};
use jscompat::js_regex;
use ooxml_xml::Utf16Map;
use serde::Deserialize;
use serde_json::{Value, json};

use super::{Returned, arg, required, value};

#[derive(Deserialize)]
#[serde(untagged)]
enum Name {
    Exact(String),
    Pattern { regex: String },
}

pub fn dispatch(function: &str, text: &str, args: &Value) -> Returned {
    match function {
        "findStartTag" => {
            let map = Utf16Map::new(text);
            let from = byte_at_unit(text, arg::<usize>(args, "from")?.unwrap_or(0));
            let pattern;
            let name = match arg::<Name>(args, "name")? {
                None => TagName::Any,
                Some(Name::Exact(name)) => {
                    pattern = name;
                    TagName::Exact(&pattern)
                }
                Some(Name::Pattern { regex }) if regex == "settingsRoot" => {
                    TagName::Matching(js_regex!(r"^(?:[A-Za-z0-9._-]+:)?settings$"))
                }
                Some(Name::Pattern { regex }) => return Err(format!("no pattern {regex}")),
            };
            value(find_start_tag(text, name, from).map(|tag| tag_json(&map, &tag)))
        }
        "removeElements" => value(remove_elements(
            text,
            &required::<String>(args, "name")?,
            arg::<usize>(args, "limit")?,
        )),
        _ => Err(format!("no function {function}")),
    }
}

fn tag_json(map: &Utf16Map, tag: &docx_engine::xml_tag::StartTag<'_>) -> Value {
    json!({
        "start": map.to_utf16(tag.start),
        "end": map.to_utf16(tag.end),
        "text": tag.text,
        "selfClosing": tag.self_closing,
    })
}

/// The byte where a UTF-16 unit index of the text falls, or the next character after it.
fn byte_at_unit(text: &str, unit: usize) -> usize {
    let mut units = 0;
    for (byte, c) in text.char_indices() {
        if units >= unit {
            return byte;
        }
        units += c.len_utf16();
    }
    text.len()
}
