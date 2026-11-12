//! Run splitting and merging.

use jscompat::js_regex;
use ooxml_xml::XNode;
use serde_json::{Map, Value};

use crate::xml_text::decode_numeric_char_refs;

/// Space-only runs never size a line, so such a paragraph takes the
/// empty-paragraph mark rules.
pub fn space_only_runs(texts: &[&str]) -> bool {
    let space_only = js_regex!(r"^[ \u00a0\u3000]+$");
    !texts.is_empty() && texts.iter().all(|text| space_only.test(text))
}

/// Every run is page or column breaks (`\f`, `\v`) or spaces, with at least one break.
pub fn break_only_runs(texts: &[&str]) -> bool {
    let break_only = js_regex!(r"^[\f\v \u00a0\u3000]*$");
    texts.iter().all(|text| break_only.test(text))
        && texts.iter().any(|text| js_regex!(r"[\f\v]").test(text))
}

const IMAGE_RUN_CHILDREN: [&str; 4] = ["w:drawing", "w:pict", "w:object", "mc:AlternateContent"];

/// A w:r put together from the children of a parsed run: what the original
/// builds as `{ 'w:r': children, ':@': attrs }`.
#[derive(Debug, PartialEq)]
pub struct SyntheticRun<'a> {
    pub attrs: &'a [(String, String)],
    pub children: Vec<&'a XNode>,
}

/// Synthetic single-picture runs (rPr copied into each) in document order.
pub fn split_image_run(r_node: &XNode) -> Vec<SyntheticRun<'_>> {
    let r_pr = r_node.find_child("w:rPr");
    let fresh = || r_pr.into_iter().collect::<Vec<_>>();
    let mut parts = Vec::new();
    let mut current = fresh();
    for child in r_node.children() {
        if child.name() == Some("w:rPr") {
            continue;
        }
        current.push(child);
        if IMAGE_RUN_CHILDREN.contains(&child.name().unwrap_or("")) {
            parts.push(std::mem::replace(&mut current, fresh()));
        }
    }
    if current.len() > usize::from(r_pr.is_some()) {
        parts.push(current);
    }
    let attrs = r_node.attrs().unwrap_or(&[]);
    parts
        .into_iter()
        .map(|children| SyntheticRun { attrs, children })
        .collect()
}

/// A run mixing w:sym with other text keeps each symbol in a run of its own
/// (rPr copied). `None` is the run itself, unsplit.
pub fn split_sym_run(r_node: &XNode) -> Option<Vec<SyntheticRun<'_>>> {
    let kids: Vec<&XNode> = r_node
        .children()
        .iter()
        .filter(|child| child.name() != Some("w:rPr"))
        .collect();
    if kids.len() < 2 || !kids.iter().any(|child| child.name() == Some("w:sym")) {
        return None;
    }
    let r_pr = r_node.find_child("w:rPr");
    let mut parts: Vec<Vec<&XNode>> = Vec::new();
    let mut current = Vec::new();
    for child in kids {
        if child.name() == Some("w:sym") {
            if !current.is_empty() {
                parts.push(std::mem::take(&mut current));
            }
            parts.push(vec![child]);
        } else {
            current.push(child);
        }
    }
    if !current.is_empty() {
        parts.push(current);
    }
    let attrs = r_node.attrs().unwrap_or(&[]);
    Some(
        parts
            .into_iter()
            .map(|children| SyntheticRun {
                attrs,
                children: r_pr.into_iter().chain(children).collect(),
            })
            .collect(),
    )
}

/// Concatenated w:t text of the runs inside a ruby part (w:rubyBase or w:rt).
pub fn ruby_part_text(ruby_node: &XNode, part: &str) -> String {
    let Some(part_node) = ruby_node.find_child(part) else {
        return String::new();
    };
    part_node
        .find_children("w:r")
        .flat_map(|run| run.find_children("w:t"))
        .map(|text| decode_numeric_char_refs(&text.text()).into_owned())
        .collect()
}

/// A model `Run`. Only the fields that decide merging are read; the rest is carried.
pub type Run = Map<String, Value>;

fn is_truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|x| x != 0.0 && !x.is_nan()),
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Array(_) | Value::Object(_)) => true,
    }
}

/// `a === b` for the primitive fields compared here. Two objects are never the same object.
fn strict_equal(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (None, None) | (Some(Value::Null), Some(Value::Null)) => true,
        (Some(Value::Bool(a)), Some(Value::Bool(b))) => a == b,
        (Some(Value::Number(a)), Some(Value::Number(b))) => a.as_f64() == b.as_f64(),
        (Some(Value::String(a)), Some(Value::String(b))) => a == b,
        _ => false,
    }
}

/// `value ?? default`
fn or_default<'a>(value: Option<&'a Value>, default: &'a Value) -> &'a Value {
    match value {
        None | Some(Value::Null) => default,
        Some(value) => value,
    }
}

fn nested<'a>(run: &'a Run, object: &str, key: &str) -> Option<&'a Value> {
    run.get(object)?.as_object()?.get(key)
}

fn same_revision(a: Option<&Value>, b: Option<&Value>) -> bool {
    if !is_truthy(a) || !is_truthy(b) {
        return is_truthy(a) == is_truthy(b);
    }
    ["author", "date", "dateUtc", "id"]
        .iter()
        .all(|key| strict_equal(a.and_then(|a| a.get(key)), b.and_then(|b| b.get(key))))
}

/// `(run.commentIds ?? []).join(',')`
fn comment_ids(run: &Run) -> String {
    let ids = run.get("commentIds").and_then(Value::as_array);
    ids.into_iter()
        .flatten()
        .map(|id| match id {
            Value::String(id) => id.clone(),
            Value::Null => String::new(),
            other => other.to_string(),
        })
        .collect::<Vec<_>>()
        .join(",")
}

/// `sameInlineWrapChain(a.wrap, b.wrap)`: two runs sit in the same chain of
/// wrapper elements.
fn same_inline_wrap_chain(a: &Run, b: &Run) -> bool {
    let chain = |run: &'_ Run| match run.get("wrap") {
        Some(Value::Array(chain)) => chain.clone(),
        _ => Vec::new(),
    };
    let (x, y) = (chain(a), chain(b));
    x.len() == y.len()
        && x.iter().zip(&y).all(|(a, b)| match (a, b) {
            (Value::Object(a), Value::Object(b)) => ["seq", "open", "close"]
                .iter()
                .all(|key| strict_equal(a.get(*key), b.get(*key))),
            _ => strict_equal(Some(a), Some(b)),
        })
}

fn same_style(a: &Run, b: &Run) -> bool {
    // reference markers, index entries, cross-references and inline math are atomic
    let either_truthy = |key| is_truthy(a.get(key)) || is_truthy(b.get(key));
    let either_defined = |key| a.contains_key(key) || b.contains_key(key);
    if either_truthy("noteRef") || either_defined("xeTerm") {
        return false;
    }
    if ["refField", "instrField", "sdtCheckboxXml"]
        .into_iter()
        .any(either_defined)
    {
        return false;
    }
    // runs of different wrapper elements stay apart
    if !same_inline_wrap_chain(a, b) {
        return false;
    }
    if ["math", "sym", "ruby", "image"]
        .into_iter()
        .any(either_truthy)
    {
        return false;
    }
    let empty = Value::String(String::new());
    let same_or_empty =
        |a, b| strict_equal(Some(or_default(a, &empty)), Some(or_default(b, &empty)));
    let not_plain = Value::Bool(false);
    let plain = |run| or_default(nested(run, "link", "plain"), &not_plain);
    same_or_empty(a.get("rawRPr"), b.get("rawRPr"))
        && ["cs", "bold", "italic", "underline", "strike"]
            .iter()
            .all(|key| is_truthy(a.get(*key)) == is_truthy(b.get(*key)))
        && [
            "styleId",
            "color",
            "sizeHalfPoints",
            "font",
            "fontAscii",
            "csFont",
            "highlight",
            "vertAlign",
        ]
        .iter()
        .all(|key| strict_equal(a.get(*key), b.get(*key)))
        && same_or_empty(nested(a, "link", "href"), nested(b, "link", "href"))
        && same_or_empty(nested(a, "link", "rId"), nested(b, "link", "rId"))
        && strict_equal(Some(plain(a)), Some(plain(b)))
        && comment_ids(a) == comment_ids(b)
        && same_revision(a.get("ins"), b.get("ins"))
        && same_revision(a.get("del"), b.get("del"))
}

/// Joins neighbouring runs of the same style into one.
pub fn merge_runs(runs: &[Run]) -> Vec<Run> {
    let mut merged: Vec<Run> = Vec::new();
    for run in runs {
        match merged
            .last_mut()
            .filter(|previous| same_style(previous, run))
        {
            Some(previous) => {
                let text = |run: &Run| {
                    run.get("text")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_owned()
                };
                let joined = text(previous) + &text(run);
                previous.insert("text".to_owned(), Value::String(joined));
            }
            None => merged.push(run.clone()),
        }
    }
    merged
}
