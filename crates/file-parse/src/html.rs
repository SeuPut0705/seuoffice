//! `redactHtmlSource` of packages/file-parse/src/html-redaction.ts: the
//! withheld regions of an HTML page replaced by their `{{label}}` markers.
//!
//! The page is parsed by parse5 with source locations. parse5 is not ported:
//! that one step is the host's (`fileparse.htmlSourceElements` of
//! [`seu_host`]), which answers the elements `sourceElements` lists, each with
//! its tag name, its attributes as parse5 reports them, and the offsets of its
//! start tag and of its content in UTF-16 code units. Everything after it is
//! here. Offsets are bytes of the source from there on: every character the
//! walk compares is ASCII, so a byte and a UTF-16 scan stop at the same places,
//! and spans sort the same way in both.

use serde::Deserialize;
use serde_json::json;

use jscompat::{js_regex, try_js_regex};

use crate::redaction::{redaction_error, sanitize_label};

/// Attribute marking an element's own content.
const MARK_ATTR: &str = "data-gx-redact";
/// Prefix for marking one attribute's value: `data-gx-redact-src="label"`.
const MARK_ATTR_PREFIX: &str = "data-gx-redact-";

struct Span {
    raw_from: usize,
    raw_to: usize,
    label: String,
}

#[derive(Deserialize)]
struct HostAttribute {
    name: String,
    value: String,
}

/// One element of `sourceElements`, as the host answers it.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HostElement {
    tag_name: String,
    attrs: Vec<HostAttribute>,
    start_tag: [u32; 2],
    inner: [u32; 2],
}

struct SourceElement {
    tag_name: String,
    attrs: Vec<HostAttribute>,
    start_tag: [usize; 2],
    /// content between the start tag and the end tag (or the implied end)
    inner: [usize; 2],
}

/// The byte offset of each UTF-16 offset of `source`, and of its end.
fn byte_of_unit(source: &str) -> Vec<usize> {
    let mut bytes = Vec::with_capacity(source.len() + 1);
    for (at, c) in source.char_indices() {
        bytes.extend(std::iter::repeat_n(at, c.len_utf16()));
    }
    bytes.push(source.len());
    bytes
}

/// `sourceElements(source)`, through the host.
fn source_elements(source: &str) -> Result<Vec<SourceElement>, String> {
    let answer = seu_host::call("fileparse.htmlSourceElements", &json!({ "source": source }))
        .map_err(|error| error.message)?;
    let elements: Vec<HostElement> = serde_json::from_value(answer)
        .map_err(|error| format!("fileparse.htmlSourceElements answered {error}"))?;
    let bytes = byte_of_unit(source);
    let byte = |unit: u32| {
        bytes.get(unit as usize).copied().ok_or_else(|| {
            format!("fileparse.htmlSourceElements answered offset {unit} past the source")
        })
    };
    elements
        .into_iter()
        .map(|element| {
            Ok(SourceElement {
                start_tag: [byte(element.start_tag[0])?, byte(element.start_tag[1])?],
                inner: [byte(element.inner[0])?, byte(element.inner[1])?],
                tag_name: element.tag_name,
                attrs: element.attrs,
            })
        })
        .collect()
}

/// An attribute's value range inside a start tag, in source coordinates, or `None`.
fn attr_value_range(start_tag_xml: &str, tag_start: usize, name: &str) -> Option<[usize; 2]> {
    for m in js_regex!(
        r#"([^\s"'>/=]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))"#,
        "dg"
    )
    .find_iter(start_tag_xml)
    {
        if m.get(1) != Some(name) {
            continue;
        }
        // 1 = name, then one group per quoting style: "…" , '…', bare
        let group = if m.get(2).is_some() {
            2
        } else if m.get(3).is_some() {
            3
        } else {
            4
        };
        let Some(at) = m.range(group) else {
            continue;
        };
        return Some([tag_start + at.start, tag_start + at.end]);
    }
    None
}

/// every attribute name in a start tag, in order
fn attr_names(start_tag_xml: &str) -> Vec<&str> {
    let head = match js_regex!(r"^<[\w:-]+").exec(start_tag_xml) {
        Some(found) => &start_tag_xml[found.end()..],
        None => start_tag_xml,
    };
    js_regex!(
        r#"([^\s"'>/=]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+))"#,
        "g"
    )
    .find_iter(head)
    .filter_map(|m| m.get(1))
    .collect()
}

/// the next string literal after `from`, or `None`
fn string_literal_at(src: &str, from: usize) -> Option<[usize; 2]> {
    let src = src.as_bytes();
    for i in from..src.len() {
        let c = src[i];
        if c != b'"' && c != b'\'' && c != b'`' {
            continue;
        }
        let mut j = i + 1;
        while j < src.len() {
            if src[j] == b'\\' {
                j += 2;
                continue;
            }
            if src[j] == c {
                return Some([i + 1, j]);
            }
            if src[j] == b'\n' && c != b'`' {
                break;
            }
            j += 1;
        }
    }
    None
}

/// every withheld region of the page, in the coordinates of the source
fn collect_withheld(source: &str) -> Result<Vec<Span>, String> {
    let mut out = Vec::new();
    let mut script_inner: Vec<[usize; 2]> = Vec::new();

    for e in source_elements(source)? {
        let start_tag = &source[e.start_tag[0]..e.start_tag[1]];
        if e.tag_name == "script" {
            script_inner.push(e.inner);
        }

        // data-gx-redact="label" → this element's content
        let own = attr_value_range(start_tag, e.start_tag[0], MARK_ATTR);
        if let Some(own) = own {
            out.push(Span {
                raw_from: e.inner[0],
                raw_to: e.inner[1],
                label: source[own[0]..own[1]].to_owned(),
            });
        }

        // data-gx-redact-<attr>="label" → that one attribute's value
        let mut reached: Vec<String> = Vec::new();
        for name in attr_names(start_tag) {
            let Some(target) = name.strip_prefix(MARK_ATTR_PREFIX) else {
                continue;
            };
            if target.is_empty() {
                continue;
            }
            let mark = attr_value_range(start_tag, e.start_tag[0], name);
            let Some(range) = attr_value_range(start_tag, e.start_tag[0], target) else {
                continue;
            };
            reached.push(target.to_lowercase());
            if range[0] == range[1] {
                continue;
            }
            out.push(Span {
                raw_from: range[0],
                raw_to: range[1],
                label: mark.map_or_else(
                    || target.to_owned(),
                    |mark| source[mark[0]..mark[1]].to_owned(),
                ),
            });
        }

        // the parser's own attribute list is the witness: a mark it reports that
        // the scan above did not honour would hand the words over
        for attr in &e.attrs {
            let name = attr.name.to_lowercase();
            if name == MARK_ATTR {
                if own.is_none() && e.inner[1] > e.inner[0] {
                    return Err(redaction_error(&format!(
                        "a {MARK_ATTR} mark on <{}> cannot be read",
                        e.tag_name
                    )));
                }
            } else if let Some(target) = name.strip_prefix(MARK_ATTR_PREFIX) {
                let held = e.attrs.iter().find(|a| a.name.to_lowercase() == target);
                // no such attribute, or an empty one: the mark has nothing to withhold
                if held.is_some_and(|held| !held.value.is_empty())
                    && !reached.iter().any(|r| r == target)
                {
                    return Err(redaction_error(&format!(
                        "a {name} mark on <{}> cannot be read",
                        e.tag_name
                    )));
                }
            }
        }
    }

    // /*gx:redact:label*/ inside a real <script> → the string literal after it
    for m in try_js_regex!(r"\/\*gx:redact:([^]*?)\*\/", "g").try_find_iter(source) {
        let m = m.map_err(|limit| limit.to_string())?;
        let at = m.start();
        let Some(script) = script_inner.iter().find(|[a, b]| at >= *a && at < *b) else {
            continue;
        };
        let lit = string_literal_at(source, at + m.as_str().len());
        // the editor withholds nothing for a mark with no literal after it, and
        // whatever literal comes next when that one is past the script: either way
        // the value the mark was put in front of is not the one being withheld
        let Some(lit) = lit.filter(|lit| lit[1] <= script[1]) else {
            return Err(redaction_error(
                "a script mark has no string literal after it",
            ));
        };
        out.push(Span {
            raw_from: lit[0],
            raw_to: lit[1],
            label: m.get(1).unwrap_or_default().to_owned(),
        });
    }

    Ok(outermost(out))
}

/// Keep the outermost regions only, so the same range is never withheld twice.
fn outermost(mut spans: Vec<Span>) -> Vec<Span> {
    // a stable sort, as Array.prototype.sort is
    spans.sort_by(|a, b| a.raw_from.cmp(&b.raw_from).then(b.raw_to.cmp(&a.raw_to)));
    let mut out: Vec<Span> = Vec::new();
    for s in spans {
        if s.raw_to <= s.raw_from {
            continue;
        }
        if out
            .iter()
            .any(|k| s.raw_from >= k.raw_from && s.raw_to <= k.raw_to)
        {
            continue;
        }
        out.push(s);
    }
    out.sort_by_key(|s| s.raw_from);
    out
}

/// `placeholderSource(label)`: the stricter cleaning of a label that can sit
/// in a script comment, where `*` and `/` would end it.
fn placeholder_source(label: &str) -> String {
    let label = sanitize_label(&label.replace(['*', '/'], ""));
    format!(
        "{{{{{}}}}}",
        if label.is_empty() { "private" } else { &label }
    )
}

/// `redactHtmlSource(source)`: the page's source with every withheld region
/// replaced by its `{{label}}` marker. `Err` is the message of the
/// `RedactionMarkError` the TypeScript throws, or of the host's step.
pub fn redact_html_source(source: &str) -> Result<String, String> {
    if !js_regex!(r"data-gx-redact|gx:redact:", "i").test(source) {
        return Ok(source.to_owned());
    }
    let mut parts = String::with_capacity(source.len());
    let mut cursor = 0;
    for s in collect_withheld(source)? {
        // two regions can overlap without one holding the other; the words between
        // the cursor and this one are already gone, so nothing is sliced backwards
        parts.push_str(&source[cursor..cursor.max(s.raw_from)]);
        parts.push_str(&placeholder_source(&s.label));
        cursor = cursor.max(s.raw_to);
    }
    parts.push_str(&source[cursor..]);
    Ok(parts)
}
