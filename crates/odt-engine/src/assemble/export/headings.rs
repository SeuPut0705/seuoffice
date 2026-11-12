//! `assemble/export/headings.ts`: headings of an exported ODT as Hancom writes
//! its own outline paragraphs: a `text:p` under a paragraph style with
//! `style:default-outline-level`.
//!
//! Hancom numbers every `text:h` with its default outline numbering ("1.",
//! "1.1.") whatever the document's outline style says, so a docx heading would
//! gain a number it never had. LibreOffice takes the outline level from the
//! paragraph style, so the heading stays a heading there.

use jscompat::{
    JsMap, Radix, RegexError, TryJsRegex, js_regex, number_to_string, parse_int, regex_escape,
    replace_first, replace_first_string, try_replace_first_with,
};

/// `HEADING_ATTRS`
const HEADING_ATTRS: &str =
    r#"\s+text:(?:outline-level|is-list-header|restart-numbering|start-value)="[^"]*""#;

/// `AutoStyle`
struct AutoStyle {
    parent: Option<String>,
    /// the element's children
    body: String,
    /// the outline level it takes (`None`: none yet)
    level: Option<f64>,
}

/// `text.slice(from, -1)`: all but the last code unit. A character outside the
/// BMP loses both its units here, since a Rust string cannot hold half of it.
fn all_but_last(text: &str) -> &str {
    match text.char_indices().next_back() {
        Some((at, _)) => &text[..at],
        None => text,
    }
}

/// `automaticParagraphStyles`: the automatic paragraph styles of a part, by
/// name.
fn automatic_paragraph_styles(xml: &str) -> JsMap<AutoStyle> {
    let mut out = JsMap::new();
    let Some(start) = xml.find("<office:automatic-styles>") else {
        return out;
    };
    // `xml.indexOf(..., start)`, whose -1 makes `slice(start, end)` stop one unit short
    let rest = &xml[start..];
    let region = match rest.find("</office:automatic-styles>") {
        Some(end) => &rest[..end],
        None => all_but_last(rest),
    };
    for m in js_regex!(r"<style:style(?=[\s>])([^>]*?)(\/?)>", "g").find_iter(region) {
        let attrs = m.get(1).unwrap_or("");
        if !js_regex!(r#"\sstyle:family="paragraph""#).test(attrs) {
            continue;
        }
        let name = js_regex!(r#"\sstyle:name="([^"]*)""#)
            .exec(attrs)
            .and_then(|found| found.get(1));
        let Some(name) = name.filter(|name| !name.is_empty()) else {
            continue;
        };
        let mut body = String::new();
        if m.get(2).unwrap_or("").is_empty() {
            let after = &region[m.end()..];
            body = match after.find("</style:style>") {
                Some(close) => after[..close].to_owned(),
                None => all_but_last(after).to_owned(),
            };
        }
        let own = js_regex!(r#"\sstyle:default-outline-level="(\d+)""#)
            .exec(attrs)
            .and_then(|found| found.get(1));
        out.set(
            name,
            AutoStyle {
                parent: js_regex!(r#"\sstyle:parent-style-name="([^"]*)""#)
                    .exec(attrs)
                    .and_then(|found| found.get(1))
                    .map(str::to_owned),
                body,
                level: own
                    .filter(|own| !own.is_empty())
                    .map(|own| parse_int(own, Radix::Ten)),
            },
        );
    }
    out
}

/// The state `styleFor` of `headingsAsParagraphs` closes over.
struct Chooser<'a> {
    autos: JsMap<AutoStyle>,
    /// automatic styles plain paragraphs use too cannot take a level themselves
    shared: JsMap<()>,
    /// style name + level to the style the paragraph uses
    chosen: JsMap<String>,
    added: Vec<String>,
    taken: JsMap<()>,
    common_levels: &'a JsMap<f64>,
}

impl Chooser<'_> {
    /// `styleFor`
    fn style_for(&mut self, style: Option<&str>, level: f64) -> String {
        let key = format!("{}\u{0}{}", style.unwrap_or(""), number_to_string(level));
        if let Some(known) = self.chosen.get(&key).filter(|known| !known.is_empty()) {
            return known.clone();
        }
        let name: String;
        let auto_here = style.is_some_and(|style| self.autos.has(style));
        let reuse_auto = auto_here
            && style.is_some_and(|style| !self.shared.has(style))
            && style
                .and_then(|style| self.autos.get(style))
                .is_some_and(|auto| auto.level.is_none() || auto.level == Some(level));
        if reuse_auto {
            // the automatic style takes the level (once; another level gets a copy)
            if let Some(auto) = style.and_then(|style| self.autos.get_mut(style)) {
                auto.level = Some(level);
            }
            name = style.unwrap_or("").to_owned();
        } else if !auto_here
            && style.is_some_and(|style| self.common_levels.get(style) == Some(&level))
        {
            name = style.unwrap_or("").to_owned();
        } else {
            let mut n = 1;
            let mut candidate;
            loop {
                candidate = format!(
                    "{}_L{}{}",
                    style.unwrap_or("Heading"),
                    number_to_string(level),
                    if n > 1 {
                        format!("_{n}")
                    } else {
                        String::new()
                    }
                );
                if self.taken.has(&candidate) {
                    n += 1;
                } else {
                    break;
                }
            }
            name = candidate;
            self.taken.set(name.as_str(), ());
            let auto = style.and_then(|style| self.autos.get(style));
            let body = auto.map_or("", |auto| auto.body.as_str());
            let parent: Option<&str> = match auto {
                Some(auto) => auto.parent.as_deref(),
                None => style,
            };
            self.added.push(format!(
                "<style:style style:name=\"{name}\" style:family=\"paragraph\"{} style:default-outline-level=\"{}\">{body}</style:style>",
                parent.map_or(String::new(), |parent| format!(
                    " style:parent-style-name=\"{parent}\""
                )),
                number_to_string(level),
            ));
        }
        self.chosen.set(key, name.clone());
        name
    }
}

/// `headingsAsParagraphs`: one part's XML with its `text:h` turned into
/// `text:p` (style names stay as they are written, attribute-escaped).
/// `common_levels` holds the outline level of each common paragraph style that
/// has one; a heading whose style does not carry its level gets an automatic
/// style that does. The error is what `new RegExp` of an automatic style's name
/// would throw.
pub fn headings_as_paragraphs(xml: &str, common_levels: &JsMap<f64>) -> Result<String, RegexError> {
    if !js_regex!(r"<text:h[\s/>]").test(xml) {
        return Ok(xml.to_owned());
    }
    let autos = automatic_paragraph_styles(xml);
    let mut shared = JsMap::new();
    for m in js_regex!(r#"<text:p(?=[\s/>])[^>]*?\stext:style-name="([^"]*)""#, "g").find_iter(xml)
    {
        shared.set(m.get(1).unwrap_or(""), ());
    }
    let mut taken = JsMap::new();
    for key in autos.keys() {
        taken.set(key, ());
    }
    let mut chooser = Chooser {
        autos,
        shared,
        chosen: JsMap::new(),
        added: Vec::new(),
        taken,
        common_levels,
    };

    let heading_attrs = js_regex!(HEADING_ATTRS, "g");
    let mut out = js_regex!(r"<text:h(?=[\s/>])([^>]*?)(\/?)>", "g").replace_all(xml, |m| {
        let attrs = m.get(1).unwrap_or("");
        let empty = m.get(2).unwrap_or("");
        let style = js_regex!(r#"\stext:style-name="([^"]*)""#)
            .exec(attrs)
            .and_then(|found| found.get(1));
        let parsed = match js_regex!(r#"\stext:outline-level="(\d+)""#)
            .exec(attrs)
            .and_then(|found| found.get(1))
        {
            Some(level) if !level.is_empty() => parse_int(level, Radix::Ten),
            _ => 1.0,
        };
        // `parseInt(...) || 1`
        let parsed = if parsed.is_nan() || parsed == 0.0 {
            1.0
        } else {
            parsed
        };
        let level = parsed.min(10.0).max(1.0);
        let name = chooser.style_for(style, level);
        let without = heading_attrs.replace_all(attrs, |_| String::new());
        let rest = replace_first(js_regex!(r#"\stext:style-name="[^"]*""#), 0, &without, "");
        format!("<text:p text:style-name=\"{name}\"{rest}{empty}>")
    });
    out = js_regex!(r"<\/text:h>", "g").replace_all(&out, |_| "</text:p>".to_owned());

    // the automatic styles that took a level carry it
    for (name, auto) in chooser.autos.iter() {
        let Some(level) = auto.level else {
            continue;
        };
        let pattern = format!(
            "<style:style(?=[^>]*\\sstyle:name=\"{}\")([^>]*?)(/?)>",
            regex_escape(name)
        );
        let open = TryJsRegex::new(&pattern, "")?;
        out = try_replace_first_with(&open, &out, |m| {
            let attrs = m.get(1).unwrap_or("");
            let empty = m.get(2).unwrap_or("");
            if js_regex!(r"\sstyle:default-outline-level=").test(attrs) {
                m.as_str().to_owned()
            } else {
                format!(
                    "<style:style{attrs} style:default-outline-level=\"{}\"{empty}>",
                    number_to_string(level)
                )
            }
        })?;
    }
    if !chooser.added.is_empty() {
        let added = chooser.added.join("");
        out = if js_regex!(r"<office:automatic-styles\/>").test(&out) {
            replace_first_string(
                &out,
                "<office:automatic-styles/>",
                &format!("<office:automatic-styles>{added}</office:automatic-styles>"),
            )
        } else {
            replace_first_string(
                &out,
                "</office:automatic-styles>",
                &format!("{added}</office:automatic-styles>"),
            )
        };
    }
    Ok(out)
}
