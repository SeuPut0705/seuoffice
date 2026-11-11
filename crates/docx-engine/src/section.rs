//! Section readers (packages/docx-engine/src/section.ts, read side).

use jscompat::{JsRegex, RegexSyntaxError, js_regex};

/// String attribute of a tag; matches either quote style. `name` goes into the
/// pattern unescaped, as in the original.
fn str_attr<'t>(tag: &'t str, name: &str) -> Result<Option<&'t str>, RegexSyntaxError> {
    let pattern = JsRegex::new(&format!(r#"{name}\s*=\s*["']([^"']*)["']"#), "")?;
    Ok(pattern.exec(tag).and_then(|found| found.get(1)))
}

/// On/off flag element (w:titlePg, w:evenAndOddHeaders, ...) present and not
/// switched off: matches self-closing and paired forms, w:val="0|false|off"
/// counts as off. `tag` goes into the pattern unescaped, as in the original.
pub fn xml_flag_on(xml: &str, tag: &str) -> Result<bool, RegexSyntaxError> {
    let pattern = JsRegex::new(&format!(r"<{tag}(?=[\s/>])[^>]*>"), "")?;
    for found in pattern.find_iter(xml) {
        let val = str_attr(found.as_str(), "w:val")?;
        if val.is_none_or(|val| !js_regex!(r"^(?:0|false|off)$").test(val)) {
            return Ok(true);
        }
    }
    Ok(false)
}
mod read;
pub use read::*;
